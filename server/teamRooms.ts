// 团队赛联机房间：/team WebSocket 端点。只管房间成员、昵称、房主，并在成员之间转发消息
// （大厅状态、开局信息、每步动作、操作、顶替请求）；不跑引擎。协议见 src/net/teamRoomProtocol.ts。
import { randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import {
  TEAM_ROOM_CODE_RE, TEAM_ROOM_MAX_FRAMES, TEAM_ROOM_MAX_FRAME_BYTES, TEAM_ROOM_MAX_MEMBERS, TEAM_ROOM_MAX_MESSAGE_BYTES,
  TEAM_ROOM_NAMES, TEAM_ROOM_PROTOCOL, TEAM_ROOM_REMATCH_COUNTDOWN_MS, isRoomAction,
  type RoomClientMessage, type RoomErrorReason, type RoomInfo, type RoomServerMessage,
} from '../src/net/teamRoomProtocol.ts';

const MAX_ROOMS = 200;
const MAX_CONNECTIONS = 1024;
const MAX_PER_IP = 40;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 4000;
/** 每个连接每秒最多多少条消息（房主 2 倍速时每秒 40 步 + 大厅更新，其他人每秒约 20 条操作） */
const MESSAGES_PER_SECOND = 120;

interface Member {
  id: number;
  name: string;
  ws: WebSocket;
  ip: string;
  room: Room | null;
  buildId: string | null;
  hello: boolean;
  pingAt: number | null;
  lastPong: number;
  /** 客户端自己报的到中转的往返延迟（毫秒） */
  rtt: number | null;
  window: { until: number; count: number };
}

interface RoomMatch {
  id: string;
  start: string; // 原样的 JSON 文本
  frames: string[];
  players: number[]; // 这局上场的真人（成员 id）
}

interface Postgame {
  matchId: string;
  players: number[];
  want: Set<number>;
  left: Set<number>;
  countdownUntil: number | null;
}

interface Room {
  code: string;
  hostId: number;
  nextId: number;
  buildId: string;
  members: Map<number, Member>;
  lobby: string | null;
  match: RoomMatch | null;
  postgame: Postgame | null;
}

const now = () => Math.round(performance.timeOrigin + performance.now());

export interface TeamRooms {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ip: string): void;
  stats(): { rooms: number; members: number; matches: number };
}

export function createTeamRooms(log: (event: string, details?: object) => void): TeamRooms {
  const wss = new WebSocketServer({ noServer: true, maxPayload: TEAM_ROOM_MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const rooms = new Map<string, Room>();
  const conns = new Set<Member>();
  const perIp = new Map<string, number>();

  const send = (m: Member | undefined, msg: RoomServerMessage) => {
    if (!m || m.ws.readyState !== WebSocket.OPEN) return;
    if (m.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      m.ws.terminate();
      return;
    }
    m.ws.send(JSON.stringify(msg));
  };
  const sendRaw = (m: Member | undefined, text: string) => {
    if (!m || m.ws.readyState !== WebSocket.OPEN) return;
    if (m.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      m.ws.terminate();
      return;
    }
    m.ws.send(text);
  };
  const fail = (m: Member, reason: RoomErrorReason) => send(m, { type: 'error', reason });

  const info = (room: Room): RoomInfo => ({
    code: room.code,
    hostId: room.hostId,
    members: [...room.members.values()].sort((a, b) => a.id - b.id).map((m) => ({ id: m.id, name: m.name })),
  });
  const broadcastRoom = (room: Room) => {
    const ri = info(room);
    for (const m of room.members.values()) send(m, { type: 'room', room: ri, me: m.id });
  };
  const others = (room: Room, except: Member) => [...room.members.values()].filter((m) => m !== except);
  const host = (room: Room) => room.members.get(room.hostId);

  const newCode = () => {
    for (let i = 0; i < 50; i++) {
      const c = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (!rooms.has(c)) return c;
    }
    return null;
  };

  const addMember = (room: Room, m: Member) => {
    const used = new Set([...room.members.values()].map((x) => x.name));
    m.id = room.nextId++;
    m.name = TEAM_ROOM_NAMES.find((n) => !used.has(n)) ?? `P${m.id}`;
    m.room = room;
    room.members.set(m.id, m);
  };

  /** 把正在进行的对局（开局信息 + 已有的每一步）补发给一个人：中途进房或回到大厅想观战的人用 */
  const sendMatch = (room: Room, m: Member) => {
    if (!room.match) return;
    sendRaw(m, `{"type":"start","start":${room.match.start}}`);
    if (room.match.frames.length) {
      send(m, { type: 'frames', matchId: room.match.id, from: 0, acts: room.match.frames });
    }
  };

  const endMatch = (room: Room, aborted: boolean, reason?: 'host_left' | 'host_quit') => {
    const match = room.match;
    if (!match) return;
    room.match = null;
    for (const m of room.members.values()) send(m, { type: 'end', matchId: match.id, aborted, reason });
    if (!aborted) {
      room.postgame = { matchId: match.id, players: match.players, want: new Set(), left: new Set(), countdownUntil: null };
      broadcastRematch(room);
    }
  };

  const broadcastRematch = (room: Room) => {
    const pg = room.postgame;
    if (!pg) return;
    const msg: RoomServerMessage = {
      type: 'rematch',
      serverTime: now(),
      matchId: pg.matchId,
      want: [...pg.want],
      players: pg.players,
      left: [...pg.left],
      countdownUntil: pg.countdownUntil,
    };
    for (const m of room.members.values()) send(m, msg);
  };

  const leaveRoom = (m: Member) => {
    const room = m.room;
    if (!room) return;
    room.members.delete(m.id);
    m.room = null;
    if (room.postgame?.players.includes(m.id)) {
      // 这局的选手退出房间：不能再来一局（倒计时也取消）
      room.postgame.left.add(m.id);
      room.postgame.want.delete(m.id);
      room.postgame.countdownUntil = null;
    }
    if (room.members.size === 0) {
      rooms.delete(room.code);
      log('team-room-closed', { code: room.code });
      return;
    }
    if (room.hostId === m.id) {
      // 房主走了：对局（在他的浏览器里跑）随之结束，房主交给最早进房的人；他手里已有最新的大厅状态
      endMatch(room, true, 'host_left');
      room.hostId = Math.min(...room.members.keys());
      room.postgame = null;
    }
    broadcastRoom(room);
    broadcastRematch(room);
  };

  const onMessage = (m: Member, raw: string) => {
    const t = now();
    if (t >= m.window.until) m.window = { until: t + 1000, count: 0 };
    if (++m.window.count > MESSAGES_PER_SECOND) {
      m.ws.close(1008, 'Message rate exceeded');
      return;
    }
    let msg: RoomClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      if (msg.protocol !== TEAM_ROOM_PROTOCOL || typeof msg.buildId !== 'string' || msg.buildId.length > 64) {
        fail(m, 'version');
        m.ws.close(4003, 'Protocol mismatch');
        return;
      }
      m.hello = true;
      m.buildId = msg.buildId;
      send(m, { type: 'welcome', protocol: TEAM_ROOM_PROTOCOL });
      return;
    }
    if (!m.hello) return;
    if (msg.type === 'ping') {
      if (Number.isInteger(msg.rttMs) && (msg.rttMs as number) >= 0 && (msg.rttMs as number) <= 5000) m.rtt = msg.rttMs as number;
      if (Number.isSafeInteger(msg.t)) send(m, { type: 'pong', t: msg.t });
      return;
    }
    if (msg.type === 'create') {
      if (m.room) return;
      if (rooms.size >= MAX_ROOMS) return fail(m, 'busy');
      const code = newCode();
      if (!code) return fail(m, 'busy');
      const room: Room = {
        code, hostId: 0, nextId: 1, buildId: m.buildId!, members: new Map(), lobby: null, match: null, postgame: null,
      };
      rooms.set(code, room);
      addMember(room, m);
      room.hostId = m.id;
      log('team-room-created', { code });
      broadcastRoom(room);
      return;
    }
    if (msg.type === 'join') {
      if (m.room) return;
      if (typeof msg.code !== 'string' || !TEAM_ROOM_CODE_RE.test(msg.code)) return fail(m, 'bad');
      const room = rooms.get(msg.code);
      if (!room) return fail(m, 'not_found');
      if (room.buildId !== m.buildId) return fail(m, 'version');
      if (room.members.size >= TEAM_ROOM_MAX_MEMBERS) return fail(m, 'full');
      addMember(room, m);
      broadcastRoom(room);
      if (room.lobby) sendRaw(m, `{"type":"lobby","lobby":${room.lobby}}`);
      sendMatch(room, m);
      if (room.postgame) broadcastRematch(room);
      return;
    }
    const room = m.room;
    if (!room) return;
    const isHost = room.hostId === m.id;
    switch (msg.type) {
      case 'leave':
        leaveRoom(m);
        send(m, { type: 'left' });
        return;
      case 'lobby': {
        if (!isHost || msg.lobby === null || typeof msg.lobby !== 'object') return;
        room.lobby = JSON.stringify(msg.lobby);
        const text = `{"type":"lobby","lobby":${room.lobby}}`;
        for (const o of others(room, m)) sendRaw(o, text);
        return;
      }
      case 'claim':
        if (isHost || !Number.isInteger(msg.side) || !Number.isInteger(msg.slot)) return;
        if (msg.side < 0 || msg.side > 1 || msg.slot < 0 || msg.slot > 4) return;
        send(host(room), { type: 'claim', from: m.id, side: msg.side, slot: msg.slot });
        return;
      case 'unclaim':
        if (isHost) return;
        send(host(room), { type: 'unclaim', from: m.id });
        return;
      case 'sync':
        sendMatch(room, m);
        return;
      case 'start': {
        if (!isHost || !msg.start || typeof msg.start !== 'object' || typeof msg.start.matchId !== 'string') return;
        if (msg.start.matchId.length > 40) return;
        if (room.match) endMatch(room, true, 'host_quit');
        const seats = Array.isArray(msg.start.seats) ? msg.start.seats : [];
        const players = [...new Set(seats.filter((v): v is number => Number.isInteger(v) && room.members.has(v as number)))];
        const start = JSON.stringify(msg.start);
        room.postgame = null;
        room.match = { id: msg.start.matchId, start, frames: [], players };
        const text = `{"type":"start","start":${start}}`;
        for (const o of others(room, m)) sendRaw(o, text);
        return;
      }
      case 'frame': {
        const match = room.match;
        if (!isHost || !match || msg.matchId !== match.id) return;
        if (msg.t !== match.frames.length || match.frames.length >= TEAM_ROOM_MAX_FRAMES) return;
        if (typeof msg.acts !== 'string' || msg.acts.length > TEAM_ROOM_MAX_FRAME_BYTES) return;
        match.frames.push(msg.acts);
        const text = JSON.stringify({ type: 'frames', matchId: match.id, from: msg.t, acts: [msg.acts] });
        for (const o of others(room, m)) sendRaw(o, text);
        return;
      }
      case 'input': {
        if (isHost || !room.match || msg.matchId !== room.match.id || !isRoomAction(msg.action)) return;
        send(host(room), { type: 'input', from: m.id, action: msg.action });
        return;
      }
      case 'end': {
        if (!isHost || !room.match || msg.matchId !== room.match.id) return;
        endMatch(room, msg.aborted === true, msg.aborted === true ? 'host_quit' : undefined);
        return;
      }
      case 'rematch': {
        const pg = room.postgame;
        if (!pg || msg.matchId !== pg.matchId) return;
        if (msg.choice === 'want') {
          if (!pg.players.includes(m.id) || pg.want.has(m.id)) return;
          pg.want.add(m.id);
        } else if (msg.choice === 'go') {
          if (!isHost || pg.left.size > 0 || pg.countdownUntil !== null) return;
          if (pg.players.includes(m.id)) pg.want.add(m.id);
          pg.countdownUntil = now() + TEAM_ROOM_REMATCH_COUNTDOWN_MS;
        } else if (msg.choice === 'cancel') {
          if (!isHost || pg.countdownUntil === null) return;
          pg.countdownUntil = null;
        } else return;
        broadcastRematch(room);
        return;
      }
    }
  };

  // 每 2 秒把房间里每个人的延迟发给所有人（联机对局里显示在真人角色名牌右侧）
  setInterval(() => {
    for (const room of rooms.values()) {
      const rtts: [number, number][] = [];
      for (const m of room.members.values()) if (m.rtt !== null) rtts.push([m.id, m.rtt]);
      if (!rtts.length) continue;
      const text = JSON.stringify({ type: 'rtts', rtts });
      for (const m of room.members.values()) sendRaw(m, text);
    }
  }, 2000).unref();

  setInterval(() => {
    const t = now();
    for (const m of conns) {
      if (m.pingAt !== null && t - m.pingAt >= HEARTBEAT_MS * 2) {
        m.ws.terminate();
        continue;
      }
      if (m.pingAt === null && m.ws.readyState === WebSocket.OPEN) {
        m.pingAt = t;
        m.ws.ping();
      }
    }
  }, HEARTBEAT_MS).unref();

  return {
    handleUpgrade(req, socket, head, ip) {
      if (conns.size >= MAX_CONNECTIONS || (perIp.get(ip) ?? 0) >= MAX_PER_IP) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        req.socket.setNoDelay(true);
        const m: Member = {
          id: 0, name: '', ws, ip, room: null, buildId: null, hello: false, pingAt: null, lastPong: now(), rtt: null,
          window: { until: 0, count: 0 },
        };
        conns.add(m);
        perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
        ws.on('error', () => ws.terminate());
        ws.on('message', (raw, binary) => {
          if (!binary) onMessage(m, raw.toString());
        });
        ws.on('pong', () => {
          m.pingAt = null;
          m.lastPong = now();
        });
        ws.on('close', () => {
          conns.delete(m);
          const left = (perIp.get(ip) ?? 1) - 1;
          if (left > 0) perIp.set(ip, left);
          else perIp.delete(ip);
          leaveRoom(m);
        });
      });
    },
    stats() {
      let members = 0, matches = 0;
      for (const r of rooms.values()) {
        members += r.members.size;
        if (r.match) matches++;
      }
      return { rooms: rooms.size, members, matches };
    },
  };
}
