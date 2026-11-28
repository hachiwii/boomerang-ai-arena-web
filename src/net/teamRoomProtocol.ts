// 团队赛联机房间（中转服务器 /team 端点）的消息格式，浏览器和 server/teamRooms.ts 共用。
//
// 房主的浏览器是裁判：它跑引擎和全部 bot，收别人发来的操作，每一步把 10 个人的动作（文本，每人一行）发给中转，
// 中转原样转给房间里其他人；其他人用自己的引擎按同样的动作重放（引擎对同样的动作是确定的，bot 不用在他们那里跑）。
// 大厅状态（阵容、战术、地图、速度）也由房主整份发出，其他人只读；顶替 bot / 交还席位的请求转给房主处理。

export const TEAM_ROOM_PROTOCOL = 1;
export const TEAM_ROOM_MAX_MEMBERS = 20;
/** 按进房顺序分配的昵称（同一房间不重复；有人离开后空出的名字给下一个进来的人）。 */
export const TEAM_ROOM_NAMES = [
  'Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy',
  'Mallory', 'Niaj', 'Olivia', 'Peggy', 'Rupert', 'Sybil', 'Trent', 'Victor', 'Walter', 'Zoe',
] as const;
export const TEAM_ROOM_CODE_RE = /^\d{6}$/;
/** 单条消息上限：大厅状态（三张图的战术和站位）最大；超出的消息中转直接丢弃。 */
export const TEAM_ROOM_MAX_MESSAGE_BYTES = 64 * 1024;
/** 一步 10 个人的动作文本上限 */
export const TEAM_ROOM_MAX_FRAME_BYTES = 2048;
/** 一局最多多少步（占点 1200 步，留余量） */
export const TEAM_ROOM_MAX_FRAMES = 2400;

export interface RoomMember {
  id: number;
  name: string;
}

export interface RoomInfo {
  code: string;
  hostId: number;
  members: RoomMember[];
}

/** 一个人的一步操作：MX MY ACT AX AY MSG */
export type RoomAction = [number, number, number, number, number, number];

export function isRoomAction(v: unknown): v is RoomAction {
  return (
    Array.isArray(v) &&
    v.length === 6 &&
    v.every((x) => Number.isSafeInteger(x) && Math.abs(x as number) <= 1_000_000) &&
    (v[2] as number) >= 0 &&
    (v[2] as number) <= 4 &&
    (v[5] as number) >= 0 &&
    (v[5] as number) <= 65535
  );
}

/**
 * 开局信息（房主发出，中转只校验大小后原样转发）：其他人据此初始化自己的引擎。
 * `setup` 是 TeamMatchSetup；`seats[k]` 是第 k 席的成员 id（bot 席为 null）。
 */
export interface RoomMatchStart {
  matchId: string;
  mapId: string;
  seed: number;
  spawnSeed: number;
  bgmSeed: number;
  speed: number;
  setup: unknown;
  seats: (number | null)[];
  names: (string | null)[];
}

export type RoomClientMessage =
  | { type: 'hello'; protocol: number; buildId: string }
  | { type: 'create' }
  | { type: 'join'; code: string }
  | { type: 'leave' }
  | { type: 'ping'; t: number }
  | { type: 'lobby'; lobby: unknown }
  | { type: 'claim'; side: number; slot: number }
  | { type: 'unclaim' }
  | { type: 'sync' }
  | { type: 'start'; start: RoomMatchStart }
  | { type: 'frame'; matchId: string; t: number; acts: string }
  | { type: 'input'; matchId: string; action: RoomAction }
  | { type: 'end'; matchId: string; aborted: boolean }
  /** 赛后：want = 我想再来一局（只是告诉房主）；go = 房主发起 3 秒倒计时；cancel = 房主取消倒计时 */
  | { type: 'rematch'; matchId: string; choice: 'want' | 'go' | 'cancel' };

/** 赛后状态：这局的真人选手里多少人想再来、多少人已经退出房间；有人退出就不能再来一局 */
export interface RoomRematchState {
  matchId: string;
  want: number[];
  players: number[];
  left: number[];
  /** 房主发起的倒计时结束时刻（服务器时间，毫秒）；没有倒计时为 null */
  countdownUntil: number | null;
}

export const TEAM_ROOM_REMATCH_COUNTDOWN_MS = 3000;

export type RoomErrorReason = 'version' | 'not_found' | 'full' | 'busy' | 'bad' | 'rate_limited';

export type RoomServerMessage =
  | { type: 'welcome'; protocol: number }
  | { type: 'room'; room: RoomInfo; me: number }
  | { type: 'left' }
  | { type: 'error'; reason: RoomErrorReason }
  | { type: 'pong'; t: number }
  | { type: 'lobby'; lobby: unknown }
  | { type: 'claim'; from: number; side: number; slot: number }
  | { type: 'unclaim'; from: number }
  | { type: 'start'; start: RoomMatchStart }
  | { type: 'frames'; matchId: string; from: number; acts: string[] }
  | { type: 'input'; from: number; action: RoomAction }
  | { type: 'end'; matchId: string; aborted: boolean; reason?: 'host_left' | 'host_quit' }
  | ({ type: 'rematch'; serverTime: number } & RoomRematchState);
