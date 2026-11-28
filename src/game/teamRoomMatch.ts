// 团队赛的座位配置（本地对局、联机房主、联机其他人共用）和联机开局配置。
import { PVP_FIXED_RULES } from '../net/pvpTypes';
import type { RoomMatchStart } from '../net/teamRoomProtocol';
import { makeHoodieAvatarDataUrl } from '../ui/hoodieAvatar';
import { SIDE_COLOR, slotNames, teamBot, teamMap, type TeamMapId, type TeamMatchSetup } from './teamMatch';
import type { MatchConfig, SlotConfig } from './types';

const SELF_AVATAR = makeHoodieAvatarDataUrl('#3B78F0', '#262A33');
const MATE_AVATAR = [makeHoodieAvatarDataUrl('#4A8BD6', '#3A2E28'), makeHoodieAvatarDataUrl('#D9574A', '#3A2E28')];

/**
 * 10 个座位的 SlotConfig。humanNames[k]：联机时第 k 席成员的昵称（本地对局不传，玩家席显示「玩家 (YOU)」）；
 * mySeat：自己的座位（-1 = 观战），别的真人席标成 remote。
 */
export function buildTeamSlotConfigs(setup: TeamMatchSetup, mySeat: number, humanNames?: (string | null)[]): SlotConfig[] {
  const slots: SlotConfig[] = [];
  setup.sides.forEach((side, s) => {
    const names = slotNames(side.slots);
    side.slots.forEach((sl, i) => {
      const seat = s * 5 + i;
      if (sl.kind === 'human') {
        const me = seat === mySeat;
        const nick = humanNames?.[seat];
        slots.push({
          kind: 'human',
          charKey: s === 0 ? 'demo_blue' : 'demo_red',
          baseName: nick ?? '玩家',
          displayName: nick ? (me ? `${nick} (YOU)` : nick) : '玩家 (YOU)',
          color: s === 0 ? '#3D7EFF' : '#E8483D',
          ringAccent: SIDE_COLOR[s],
          avatar: me || !nick ? SELF_AVATAR : MATE_AVATAR[s],
          side: s as 0 | 1,
          remote: nick ? !me : undefined,
        });
        return;
      }
      const b = teamBot(sl.botId)!;
      slots.push({
        kind: 'bot',
        botId: b.id,
        charKey: b.charKey,
        baseName: b.fullName,
        displayName: names[i].display,
        color: b.color,
        ringAccent: SIDE_COLOR[s],
        avatar: b.avatar,
        side: s as 0 | 1,
        origTeam: b.team,
      });
    });
  });
  return slots;
}

/** 联机对局的规则固定（每台机器的引擎设置必须一样，才能按同样的动作重放出同样的对局） */
export const ROOM_RULES = {
  cliffGuard: PVP_FIXED_RULES.cliffGuard,
  dashGuard: PVP_FIXED_RULES.dashGuard,
  meleeAssist: PVP_FIXED_RULES.meleeAssist,
  humanSlashTicks: PVP_FIXED_RULES.humanSlashTicks,
};

/** 按开局信息拼出自己这台机器的 MatchConfig（房主和其他人都用它，保证两边完全一致） */
export function roomMatchConfig(start: RoomMatchStart, me: number, role: 'host' | 'guest'): MatchConfig {
  const setup = start.setup as TeamMatchSetup;
  const mySeat = start.seats.findIndex((id) => id === me);
  const map = teamMap(setup.mapId as TeamMapId);
  return {
    matchMode: 'team',
    mapId: setup.mapId,
    mapMeta: {
      id: map.id,
      title: map.title,
      theme: map.theme,
      category: 'standard',
      nx: map.widthM * 2,
      ny: map.heightM * 2,
      desc: map.desc,
      previewGrid: [],
    },
    slots: buildTeamSlotConfigs(setup, mySeat, start.names),
    seed: start.seed,
    spawnSeed: start.spawnSeed,
    bgmSeed: start.bgmSeed,
    speed: start.speed,
    ...ROOM_RULES,
    team: setup,
    teamRoom: { matchId: start.matchId, role, mySeat, seats: start.seats },
  };
}
