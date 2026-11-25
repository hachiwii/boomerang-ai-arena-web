import type { MapMeta, MatchConfig, SlotConfig } from './types';
import type { PvpMatchInfo } from '../net/pvpTypes';
import { PVP_FIXED_RULES } from '../net/pvpTypes';
import { makeHoodieAvatarDataUrl } from '../ui/hoodieAvatar';

// Owned by the UI side (names / colours / models may be refined there). Seat 0 = P1, seat 1 = P2.
const SEAT_STYLE = [
  { charKey: 'demo_blue', color: '#3D7EFF', hoodie: '#3B78F0', hair: '#262A33' },
  { charKey: 'demo_red', color: '#E8483D', hoodie: '#E8483D', hair: '#4A3328' },
] as const;

export function buildPvpMatchConfig(info: PvpMatchInfo, mapMeta: MapMeta): MatchConfig {
  const slots: SlotConfig[] = [0, 1].map((seat) => {
    const st = SEAT_STYLE[seat];
    const base = `P${seat + 1}`;
    return {
      kind: 'human',
      charKey: st.charKey,
      baseName: base,
      displayName: seat === info.mySeat ? `${base}（YOU）` : base,
      color: st.color,
      ringAccent: st.color,
      avatar: makeHoodieAvatarDataUrl(st.hoodie, st.hair),
    };
  });
  return {
    matchMode: 'pvp',
    mapId: info.mapId,
    mapMeta,
    slots,
    seed: info.seed,
    spawnSeed: info.spawnSeed,
    bgmSeed: info.bgmSeed,
    speed: PVP_FIXED_RULES.speed,
    cliffGuard: PVP_FIXED_RULES.cliffGuard,
    dashGuard: PVP_FIXED_RULES.dashGuard,
    meleeAssist: PVP_FIXED_RULES.meleeAssist,
    humanSlashTicks: PVP_FIXED_RULES.humanSlashTicks,
    pvp: { matchId: info.matchId, mySeat: info.mySeat },
  };
}
