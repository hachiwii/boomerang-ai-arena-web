import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import maps from '../public/assets/maps/manifest.json' with { type: 'json' };
import {
  PVP_CODE_TTL_MS, type PvpChallengeFailReason, type PvpMatchInfo, type PvpRematchChoice,
} from '../src/net/pvpTypes.ts';
import {
  PVP_COUNTDOWN_MS, PVP_INPUT_GRACE_MS, PVP_MAX_FRAMES, PVP_PROTOCOL, PVP_TICK_MS, NEUTRAL, isAction, pvpInputDelayFrames,
  type Action, type ClientMessage, type Go, type InputRow, type MatchEnd, type MatchTerminal,
  type Seat, type ServerMessage,
} from '../src/net/pvpProtocol.ts';

const READY_MS = 20_000;
const RECONNECT_MS = 10_000;
const REMATCH_MS = Number(process.env.PVP_REMATCH_TIMEOUT_MS ?? 180_000);
if (!Number.isSafeInteger(REMATCH_MS) || REMATCH_MS < 1000 || REMATCH_MS > 180_000) {
  throw new Error('Invalid PVP_REMATCH_TIMEOUT_MS');
}
const TERMINAL_TTL_MS = PVP_CODE_TTL_MS;
const PRESENCE_MS = 8_000;
const MAX_CONNECTIONS = 512;
const MAX_PER_IP = 24;
const MAX_MATCHES = 128;
const MAX_RESERVATIONS = 20_000;
const MAX_RETAINED_MATCHES = 256;
const MAX_BUFFERED_BYTES = 256 * 1024;
const mapIds = maps.map((map) => map.id);
const validMaps = new Set(mapIds);
const now = () => Math.round(performance.timeOrigin + performance.now());
const other = (seat: Seat): Seat => seat === 0 ? 1 : 0;
const digest = (text: string) => createHash('sha256').update(text).digest();
const configuredOriginKey = process.env.PVP_ORIGIN_KEY;
const originKey = configuredOriginKey === undefined ? null : digest(configuredOriginKey);

function authorized(req: IncomingMessage): boolean {
  if (!originKey) return true;
  const key = req.headers['x-pvp-origin-key'];
  return typeof key === 'string' && timingSafeEqual(originKey, digest(key));
}

type WindowCount = { until: number; count: number };

interface Connection {
  ws: WebSocket;
  ip: string;
  openedAt: number;
  reservation?: Reservation;
  messages: WindowCount;
  challenges: WindowCount;
  pingAt: number | null;
  wsRtt: number;
  appRtt: number;
}

interface Reservation {
  token: string;
  code: string;
  buildId: string;
  expiresAt: number;
  presentUntil: number;
  mapPool: string[];
  conn?: Connection;
  match?: Match;
  lastMatch?: Match;
  postgame?: Match;
}

interface Postgame {
  choices: [PvpRematchChoice, PvpRematchChoice];
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Match {
  info: Omit<PvpMatchInfo, 'mySeat' | 'challenger'>;
  players: [Reservation, Reservation];
  ready: [boolean, boolean];
  disconnectedAt: [number | null, number | null];
  hashes: Map<number, [string?, string?]>;
  ends: [MatchEnd?, MatchEnd?];
  inputs: [Action?, Action?][];
  nextDeadline: number;
  readyBy: number;
  go?: Go;
  terminal?: MatchTerminal;
  postgame?: Postgame;
  removeAt?: number;
}

function ipOf(req: IncomingMessage): string {
  const first = (header: string | string[] | undefined) =>
    typeof header === 'string' ? header.split(',', 1)[0].trim().slice(0, 64) : '';
  return first(req.headers['ali-cdn-real-ip']) || first(req.headers['x-forwarded-for']) ||
    req.socket.remoteAddress || '?';
}

function count(window: WindowCount, time: number, duration: number, cap: number): boolean {
  if (time >= window.until) {
    window.until = time + duration;
    window.count = 0;
  }
  return ++window.count <= cap;
}

const newWindow = (): WindowCount => ({ until: 0, count: 0 });
const int = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

const codes = new Map<string, Reservation>();
const tokens = new Map<string, Reservation>();
const connections = new Set<Connection>();
const connectionsByIp = new Map<string, number>();
const challengesByIp = new Map<string, WindowCount>();
const active = new Map<string, Match>();
const retained = new Map<string, Match>();
// A result that can still launch a rematch holds one slot in the match cap.
const rematchSlots = new Set<Match>();

function log(event: string, details: object = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

function send(conn: Connection | undefined, message: ServerMessage) {
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;
  if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    conn.ws.terminate();
    return;
  }
  conn.ws.send(JSON.stringify(message));
}

function broadcast(match: Match, message: ServerMessage) {
  for (const player of match.players) send(player.conn, message);
}

function matchInfo(match: Match, seat: Seat): PvpMatchInfo {
  return { ...match.info, mySeat: seat, challenger: seat === 0 };
}

function sendRematch(conn: Connection | undefined, match: Match, seat: Seat) {
  const choices = match.postgame?.choices;
  if (choices) {
    send(conn, { type: 'rematch', matchId: match.info.matchId, me: choices[seat], opponent: choices[other(seat)] });
  }
}

function publishRematch(match: Match) {
  const postgame = match.postgame!;
  for (const seat of [0, 1] as const) {
    const player = match.players[seat];
    if (player.postgame === match && postgame.choices[seat] === 'left') player.postgame = undefined;
    if (player.lastMatch === match) sendRematch(player.conn, match, seat);
  }
  if (postgame.choices.includes('left')) rematchSlots.delete(match);
}

function expireRematch(match: Match) {
  const postgame = match.postgame;
  if (!postgame || !postgame.choices.includes('undecided')) return;
  for (const seat of [0, 1] as const) {
    if (postgame.choices[seat] === 'undecided') postgame.choices[seat] = 'left';
  }
  publishRematch(match);
}

function chooseRematch(match: Match, seat: Seat, choice: 'rematch' | 'left', time: number) {
  const postgame = match.postgame;
  if (!postgame) return;
  if (time >= postgame.expiresAt) expireRematch(match);
  const choices = postgame.choices;
  if (choices[seat] === 'left' || choices[seat] === choice) return;
  if (choice === 'rematch' && choices[other(seat)] === 'left') return;
  choices[seat] = choice;
  publishRematch(match);
  if (choices[0] === 'rematch' && choices[1] === 'rematch') {
    rematchSlots.delete(match);
    clearTimeout(postgame.timer);
    for (const player of match.players) if (player.postgame === match) player.postgame = undefined;
    makeMatch(...match.players, time, match.info.matchId);
  }
}

function newCode(): string {
  for (;;) {
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    if (!codes.has(code)) return code;
  }
}

function renew(reservation: Reservation, time: number) {
  reservation.expiresAt = time + PVP_CODE_TTL_MS;
}

function rejoin(conn: Connection, match: Match, seat: Seat) {
  const matchId = match.info.matchId;
  send(conn, { type: 'matchStart', info: matchInfo(match, seat) });
  if (match.go) send(conn, { type: 'go', matchId, ...match.go });
  let rows: InputRow[] = [];
  const limit = match.terminal ? match.terminal.through + 1 : match.inputs.length;
  for (let frame = 0; frame < limit; frame++) {
    for (const s of [0, 1] as const) {
      const action = match.inputs[frame]?.[s];
      if (action) rows.push([frame, s, action]);
    }
    if (rows.length >= 64) {
      send(conn, { type: 'inputs', matchId, rows });
      rows = [];
    }
  }
  if (rows.length) send(conn, { type: 'inputs', matchId, rows });
  if (match.terminal) {
    send(conn, { type: 'terminal', matchId, ...match.terminal });
    sendRematch(conn, match, seat);
  } else {
    match.disconnectedAt[seat] = null;
    const peer = match.players[other(seat)].conn;
    send(conn, { type: 'peer', matchId, connected: Boolean(peer) });
    send(peer, { type: 'peer', matchId, connected: true });
  }
}

function evictRetained(matchId: string, match: Match) {
  retained.delete(matchId);
  if (match.postgame) {
    clearTimeout(match.postgame.timer);
    if (match.players.some((player) => player.postgame === match)) {
      match.postgame.choices = ['left', 'left'];
      publishRematch(match);
    }
  }
  for (const p of match.players) if (p.lastMatch === match) p.lastMatch = undefined;
}

function finish(match: Match, terminal: MatchTerminal, time: number) {
  const { matchId } = match.info;
  match.terminal = terminal;
  match.removeAt = time + TERMINAL_TTL_MS;
  active.delete(matchId);
  retained.set(matchId, match);
  if (retained.size > MAX_RETAINED_MATCHES) {
    const oldest = retained.entries().next().value;
    if (oldest) evictRetained(...oldest);
  }
  for (const p of match.players) {
    p.match = undefined;
    p.lastMatch = match;
  }
  broadcast(match, { type: 'terminal', matchId, ...terminal });
  if (terminal.reason !== 'cancelled') {
    const choices = match.players.map((p): PvpRematchChoice =>
      p.conn?.ws.readyState === WebSocket.OPEN ? 'undecided' : 'left',
    ) as [PvpRematchChoice, PvpRematchChoice];
    match.postgame = {
      choices, expiresAt: time + REMATCH_MS,
      timer: setTimeout(() => expireRematch(match), REMATCH_MS).unref(),
    };
    for (const seat of [0, 1] as const) {
      if (choices[seat] !== 'left') match.players[seat].postgame = match;
    }
    if (!choices.includes('left')) rematchSlots.add(match);
    publishRematch(match);
  }
  log('match-ended', { matchId, ...terminal });
}

// Finalize each frame once. A missed input stops movement and starts no action.
function finalizeThrough(match: Match, through: number) {
  const rows: InputRow[] = [];
  through = Math.min(through, PVP_MAX_FRAMES - 1);
  while (match.nextDeadline <= through) {
    const frame = match.nextDeadline++;
    const pair = match.inputs[frame] ?? (match.inputs[frame] = []);
    for (const seat of [0, 1] as const) {
      if (!pair[seat]) {
        pair[seat] = NEUTRAL;
        rows.push([frame, seat, NEUTRAL]);
      }
    }
    if (rows.length >= 64) broadcast(match, { type: 'inputs', matchId: match.info.matchId, rows: rows.splice(0) });
  }
  if (rows.length) broadcast(match, { type: 'inputs', matchId: match.info.matchId, rows });
}

function due(match: Match, time: number) {
  return match.go ? Math.min(PVP_MAX_FRAMES - 1, Math.floor((time - match.go.startAt) / PVP_TICK_MS)) : -1;
}

function maintainMatch(match: Match, time: number): boolean {
  if (match.go) finalizeThrough(match, due(match, time - PVP_INPUT_GRACE_MS));
  for (const seat of [0, 1] as const) {
    const disconnected = match.disconnectedAt[seat];
    if (disconnected !== null && time - disconnected >= RECONNECT_MS) {
      const through = Math.max(-1, due(match, disconnected + RECONNECT_MS));
      finalizeThrough(match, through);
      finish(match, { reason: 'forfeit', cause: 'disconnect', winner: other(seat), through }, time);
      return false;
    }
  }
  if (!match.go && time >= match.readyBy) {
    finish(match, { reason: 'cancelled', through: -1 }, time);
    return false;
  }
  if (match.go && time >= match.go.startAt + PVP_MAX_FRAMES * PVP_TICK_MS + 15_000) {
    finish(match, { reason: 'timeout', through: PVP_MAX_FRAMES - 1 }, time);
    return false;
  }
  return true;
}

function makeMatch(challenger: Reservation, target: Reservation, time: number, rematchOf?: string) {
  const pool = target.mapPool.length ? target.mapPool : mapIds;
  const mapId = pool[randomInt(pool.length)];
  const seeds = randomBytes(12);
  const seed = seeds.readUInt32LE(0);
  const spawnSeed = seeds.readUInt32LE(4) || 1;
  const bgmSeed = seeds.readUInt32LE(8);
  const match: Match = {
    info: { matchId: randomBytes(12).toString('hex'), mapId, seed, spawnSeed, bgmSeed, rematchOf },
    players: [challenger, target],
    ready: [false, false],
    disconnectedAt: [null, null],
    hashes: new Map(),
    ends: [],
    inputs: [],
    nextDeadline: 0,
    readyBy: time + READY_MS,
  };
  for (const p of match.players) {
    p.match = match;
    p.presentUntil = 0;
    renew(p, time);
  }
  active.set(match.info.matchId, match);
  log('match-started', { matchId: match.info.matchId, mapId });
  for (const seat of [0, 1] as const) {
    send(match.players[seat].conn, { type: 'matchStart', info: matchInfo(match, seat) });
  }
}

function onHello(conn: Connection, msg: Extract<ClientMessage, {type: 'hello'}>, time: number) {
  if (msg.protocol !== PVP_PROTOCOL) {
    conn.ws.close(4003, 'Protocol mismatch');
    return;
  }
  if (conn.reservation || typeof msg.buildId !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(msg.buildId)) return;
  let p = typeof msg.token === 'string' && msg.token.length === 48 ? tokens.get(msg.token) : undefined;
  if (p && p.expiresAt <= time && !p.match) p = undefined;
  if (!p) {
    if (tokens.size >= MAX_RESERVATIONS) {
      conn.ws.close(1013, 'Lobby full');
      return;
    }
    p = {
      code: newCode(), token: randomBytes(24).toString('hex'), buildId: msg.buildId,
      expiresAt: time + PVP_CODE_TTL_MS, presentUntil: 0, mapPool: [],
    };
    tokens.set(p.token, p);
    codes.set(p.code, p);
  } else if (p.match) {
    maintainMatch(p.match, time);
  }
  if (p.match && p.buildId !== msg.buildId) {
    conn.ws.close(4002, 'Build changed during match');
    return;
  }
  const previous = p.conn;
  if (previous && p.postgame) {
    const match = p.postgame;
    chooseRematch(match, p === match.players[0] ? 0 : 1, 'left', time);
  }
  p.conn = conn;
  p.buildId = msg.buildId;
  p.presentUntil = 0;
  conn.reservation = p;
  previous?.ws.close(4001, 'Session replaced');
  const match = p.match ?? (p.lastMatch?.info.matchId === msg.matchId ? p.lastMatch : undefined);
  send(conn, { type: 'welcome', token: p.token, code: p.code, expiresAt: p.expiresAt, matchId: match?.info.matchId });
  if (match) rejoin(conn, match, p === match.players[0] ? 0 : 1);
}

function challenge(conn: Connection, p: Reservation, msg: Extract<ClientMessage, {type: 'challenge'}>, time: number) {
  if (!int(msg.request, 0, Number.MAX_SAFE_INTEGER)) return;
  const fail = (reason: PvpChallengeFailReason) =>
    send(conn, { type: 'challengeResult', request: msg.request, result: { ok: false, reason } });
  let ipWindow = challengesByIp.get(conn.ip);
  if (!ipWindow) {
    if (challengesByIp.size >= 8192) return fail('rate_limited');
    ipWindow = newWindow();
    challengesByIp.set(conn.ip, ipWindow);
  }
  const ipAllowed = count(ipWindow, time, 60_000, 24);
  if (!count(conn.challenges, time, 10_000, 6) || !ipAllowed) return fail('rate_limited');
  if (typeof msg.code !== 'string' || !/^\d{6}$/.test(msg.code)) return fail('invalid');
  if (msg.code === p.code) return fail('self');
  const target = codes.get(msg.code);
  if (!target || target.expiresAt <= time) return fail('not_found');
  if (p.match || target.match || p.postgame || target.postgame ||
      active.size + rematchSlots.size >= MAX_MATCHES) return fail('busy');
  if (p.presentUntil <= time || target.presentUntil <= time || target.conn?.ws.readyState !== WebSocket.OPEN) return fail('offline');
  if (p.buildId !== target.buildId) return fail('version');
  send(conn, { type: 'challengeResult', request: msg.request, result: { ok: true } });
  makeMatch(p, target, time);
}

function onMessage(conn: Connection, raw: string) {
  const time = now();
  if (!count(conn.messages, time, 1000, 100)) {
    conn.ws.close(1008, 'Message rate exceeded');
    return;
  }
  let msg: ClientMessage;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'hello') {
    onHello(conn, msg, time);
    return;
  }
  const p = conn.reservation;
  if (!p || p.conn !== conn) return;
  switch (msg.type) {
    case 'presence':
      if (typeof msg.present !== 'boolean') return;
      p.presentUntil = msg.present && !p.match && !p.postgame ? time + PRESENCE_MS : 0;
      if (p.presentUntil) {
        renew(p, time);
        send(conn, { type: 'code', code: p.code, expiresAt: p.expiresAt });
      }
      return;
    case 'ping':
      if (!int(msg.t, 0, Number.MAX_SAFE_INTEGER)) return;
      if (int(msg.rttMs, 0, 5000)) conn.appRtt = msg.rttMs;
      if (!p.match && p.presentUntil !== 0) {
        p.presentUntil = time + PRESENCE_MS;
        renew(p, time);
      }
      send(conn, { type: 'pong', t: msg.t, serverTime: time, expiresAt: p.expiresAt });
      return;
    case 'resetCode':
      if (p.match || !int(msg.request, 0, Number.MAX_SAFE_INTEGER)) return;
      const next = newCode();
      codes.delete(p.code);
      p.code = next;
      codes.set(next, p);
      renew(p, time);
      send(conn, { type: 'code', request: msg.request, code: next, expiresAt: p.expiresAt });
      return;
    case 'challenge':
      challenge(conn, p, msg, time);
      return;
    case 'mapPool':
      if (Array.isArray(msg.ids)) {
        p.mapPool = [...new Set(msg.ids.filter((id) => typeof id === 'string' && validMaps.has(id)))];
      }
      return;
    case 'rematch': {
      const match = p.postgame;
      if (match?.info.matchId === msg.matchId && (msg.choice === 'rematch' || msg.choice === 'left')) {
        chooseRematch(match, p === match.players[0] ? 0 : 1, msg.choice, time);
      }
      return;
    }
  }
  const match = p.match;
  if (!match || !('matchId' in msg) || msg.matchId !== match.info.matchId || !maintainMatch(match, time)) return;
  const seat: Seat = p === match.players[0] ? 0 : 1;
  const { matchId } = match.info;
  if (msg.type === 'quit') {
    const through = Math.max(-1, due(match, time));
    finalizeThrough(match, through);
    finish(match, { reason: 'forfeit', cause: 'quit', winner: other(seat), through }, time);
    return;
  }
  if (msg.type === 'ready') {
    match.ready[seat] = true;
    if (!match.go && match.ready.every(Boolean)) {
      const rtt = Math.max(...match.players.map(({ conn }) => Math.max(conn?.wsRtt ?? 0, conn?.appRtt ?? 0)));
      const delay = pvpInputDelayFrames(rtt);
      match.go = { startAt: time + PVP_COUNTDOWN_MS, delay };
      broadcast(match, { type: 'go', matchId, ...match.go });
      // Frames before the first possible sample are canonical during countdown.
      finalizeThrough(match, delay - 1);
    }
    return;
  }
  if (!match.go) return;
  if (msg.type === 'input') {
    const { frame, action } = msg;
    const maxFuture = Math.floor((time - match.go.startAt) / PVP_TICK_MS) + match.go.delay + 2;
    if (!int(frame, Math.max(match.nextDeadline, match.go.delay), Math.min(PVP_MAX_FRAMES - 1, maxFuture)) || !isAction(action)) return;
    const pair = match.inputs[frame] ?? (match.inputs[frame] = []);
    if (pair[seat]) return;
    pair[seat] = action;
    broadcast(match, { type: 'inputs', matchId, rows: [[frame, seat, action]] });
    return;
  }
  if (msg.type === 'hash' || msg.type === 'end') {
    const { frame, hash } = msg;
    // A client's filtered clock may lead the relay slightly. A report is
    // eligible as soon as its entire prefix is canonical and its tick is due
    // within one clock-error window.
    if (!int(frame, 0, Math.min(PVP_MAX_FRAMES - 1, due(match, time) + 2)) ||
        typeof hash !== 'string' || !/^[a-f0-9]{16}$/.test(hash)) return;
    for (let f = Math.min(frame, match.nextDeadline); f <= frame; f++) {
      if (!match.inputs[f]?.[0] || !match.inputs[f]?.[1]) return;
    }
    if (msg.type === 'hash') {
      if ((frame + 1) % 20 !== 0) return;
      const reports = match.hashes.get(frame) ?? [];
      if (reports[seat]) return;
      reports[seat] = hash;
      match.hashes.set(frame, reports);
      if (reports[0] && reports[1] && reports[0] !== reports[1]) log('desync', { matchId, frame, hashes: reports });
      return;
    }
    if (!int(msg.winner, -1, 1) || match.ends[seat]) return;
    match.ends[seat] = { frame, hash, winner: msg.winner };
    const [a, b] = match.ends;
    if (a && b) {
      if (a.frame !== b.frame || a.hash !== b.hash || a.winner !== b.winner) {
        log('end-desync', { matchId, reports: match.ends });
      }
      finish(match, { reason: 'complete', through: Math.max(a.frame, b.frame) }, time);
    }
  }
}

const server = createServer((req, res) => {
  const remote = req.socket.remoteAddress;
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const health = req.method === 'GET' && req.url === '/healthz';
  if (!(local && health) && !authorized(req)) {
    res.writeHead(403).end();
    return;
  }
  if (health) {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok\n');
    return;
  }
  res.writeHead(404).end();
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  if (!authorized(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  if (req.url !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const ip = ipOf(req);
  if (connections.size >= MAX_CONNECTIONS || (connectionsByIp.get(ip) ?? 0) >= MAX_PER_IP) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    req.socket.setNoDelay(true);
    const conn: Connection = {
      ip, ws, openedAt: now(), pingAt: null, wsRtt: 0, appRtt: 0,
      messages: newWindow(), challenges: newWindow(),
    };
    connections.add(conn);
    connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
    ws.on('error', () => ws.terminate());
    ws.on('message', (raw, binary) => { if (!binary) onMessage(conn, raw.toString()); });
    ws.on('pong', () => {
      if (conn.pingAt !== null) conn.wsRtt = now() - conn.pingAt;
      conn.pingAt = null;
    });
    ws.on('close', () => {
      connections.delete(conn);
      const remaining = (connectionsByIp.get(ip) ?? 1) - 1;
      if (remaining) connectionsByIp.set(ip, remaining);
      else connectionsByIp.delete(ip);
      const p = conn.reservation;
      if (!p || p.conn !== conn) return;
      p.conn = undefined;
      p.presentUntil = 0;
      if (p.match) {
        const seat = p.match.players[0] === p ? 0 : 1;
        p.match.disconnectedAt[seat] = now();
        send(p.match.players[other(seat)].conn, { type: 'peer', matchId: p.match.info.matchId, connected: false });
      }
      if (p.postgame) {
        const match = p.postgame;
        chooseRematch(match, p === match.players[0] ? 0 : 1, 'left', now());
      }
    });
    conn.pingAt = now();
    ws.ping();
  });
});

setInterval(() => {
  const time = now();
  for (const match of active.values()) maintainMatch(match, time);
}, 20).unref();
setInterval(() => {
  const time = now();
  for (const conn of connections) {
    if (conn.pingAt !== null || (!conn.reservation && time - conn.openedAt >= 4000)) {
      // A connection opened just before this interval gets a full heartbeat period.
      if (time - (conn.pingAt ?? conn.openedAt) >= 4000) conn.ws.terminate();
    } else if (conn.ws.readyState === WebSocket.OPEN) {
      conn.pingAt = time;
      conn.ws.ping();
    }
  }
  for (const [ip, window] of challengesByIp) if (time >= window.until) challengesByIp.delete(ip);
  for (const [matchId, match] of retained) if (time >= match.removeAt!) evictRetained(matchId, match);
  for (const [token, p] of tokens) {
    if (!p.match && time >= p.expiresAt) {
      p.conn?.ws.close(1000, 'Code expired');
      tokens.delete(token);
      codes.delete(p.code);
    }
  }
}, 4000).unref();

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
if (!int(port, 0, 65535)) throw new Error('Invalid PORT');
server.listen(port, host, () => log('listening', { host, port: (server.address() as AddressInfo).port }));
