import { CauseType, MatchConfig, RankedMode, RosterEntry, TickSnapshot } from './types';

export interface ModeStats {
  games: number;
  wins: number;
  draws: number;
  kills: number;
  deaths: number;
  dartKills: number;    // 飞镖击杀
  meleeKills: number;   // 近战击杀
  terrainKills: number; // 地形击杀
  cliffFalls: number;   // 坠崖次数
}

export interface LadderEntrySnap {
  id: string;
  isHuman: boolean;
  name: string;
  shortName: string;
  avatar: string | null;
  color: string;
  rating: number;
  rank: number;
}

export interface EloUpdateResult {
  mode: RankedMode;
  oldRating: number;
  newRating: number;
  delta: number;
  oldRank: number;
  newRank: number;
  totalRanked: number;
  overtook: LadderEntrySnap[];
  overtakenBy: LadderEntrySnap[];
  beforeLadder: LadderEntrySnap[];
  afterLadder: LadderEntrySnap[];
}

export interface LeaderboardRow {
  id: string;
  isHuman: boolean;
  name: string;
  shortName: string;
  avatar: string | null;
  color: string;
  rating: number; // Integer Elo (fixed for official bots, dynamic >= 0 for human)
  eloRank: number; // 1..14 rank strictly by Elo
  stats: ModeStats;
  kd: number | null;
}

interface StoredLeaderboardV2 {
  version: 2;
  humanSoloRating: number;
  humanFfaRating: number;
  soloStats: Record<string, ModeStats>;
  ffaStats: Record<string, ModeStats>;
}

const STORAGE_KEY = 'boomerang_arena_leaderboard_v2';
const INITIAL_HUMAN_ELO = 500;
const MIN_HUMAN_ELO = 0;
const ELO_K = 32;
const ELO_GAIN_MAX_MULTIPLIER = 2.0;
const ELO_GAIN_MIN_MULTIPLIER = 1.0;
const ELO_GAIN_DECAY_START = 900;
const ELO_GAIN_DECAY_END = 1300;

/**
 * Positive Elo gain multiplier:
 * - <= 900: 200% (2.0x)
 * - 900..1300: linearly decays from 200% down to 100%
 * - >= 1300: 100% (1.0x)
 */
export function getEloGainMultiplier(rating: number): number {
  if (rating <= ELO_GAIN_DECAY_START) return ELO_GAIN_MAX_MULTIPLIER;
  if (rating >= ELO_GAIN_DECAY_END) return ELO_GAIN_MIN_MULTIPLIER;
  const t = (rating - ELO_GAIN_DECAY_START) / (ELO_GAIN_DECAY_END - ELO_GAIN_DECAY_START);
  return ELO_GAIN_MAX_MULTIPLIER - t * (ELO_GAIN_MAX_MULTIPLIER - ELO_GAIN_MIN_MULTIPLIER);
}

function emptyStats(): ModeStats {
  return {
    games: 0,
    wins: 0,
    draws: 0,
    kills: 0,
    deaths: 0,
    dartKills: 0,
    meleeKills: 0,
    terrainKills: 0,
    cliffFalls: 0,
  };
}

function normalizeStats(raw?: Partial<ModeStats>): ModeStats {
  if (!raw) return emptyStats();
  return {
    games: Number(raw.games) || 0,
    wins: Number(raw.wins) || 0,
    draws: Number(raw.draws) || 0,
    kills: Number(raw.kills) || 0,
    deaths: Number(raw.deaths) || 0,
    dartKills: Number(raw.dartKills) || 0,
    meleeKills: Number(raw.meleeKills) || 0,
    terrainKills: Number(raw.terrainKills) || 0,
    cliffFalls: Number(raw.cliffFalls) || 0,
  };
}

function clampHumanElo(v: number): number {
  if (!Number.isFinite(v)) return INITIAL_HUMAN_ELO;
  return Math.max(MIN_HUMAN_ELO, Math.round(v));
}

function rankedModeOf(config: MatchConfig): RankedMode | null {
  if (config.matchMode === 'ranked-solo') return 'solo';
  if (config.matchMode === 'ranked-ffa') return 'ffa';
  return null;
}

export class LeaderboardStore {
  private readonly officialBots: RosterEntry[];
  private readonly rosterById: Map<string, RosterEntry>;
  private readonly humanAvatar: string;

  private humanRatings: Record<RankedMode, number> = {
    solo: INITIAL_HUMAN_ELO,
    ffa: INITIAL_HUMAN_ELO,
  };
  private statsByMode: Record<RankedMode, Record<string, ModeStats>> = {
    solo: {},
    ffa: {},
  };

  constructor(roster: RosterEntry[], humanAvatar: string) {
    this.officialBots = roster.filter((r) => r.category === 'official');
    this.rosterById = new Map(roster.map((r) => [r.id, r]));
    this.humanAvatar = humanAvatar;
    this.load();
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<StoredLeaderboardV2>;
      if (typeof parsed.humanSoloRating === 'number') {
        this.humanRatings.solo = clampHumanElo(parsed.humanSoloRating);
      }
      if (typeof parsed.humanFfaRating === 'number') {
        this.humanRatings.ffa = clampHumanElo(parsed.humanFfaRating);
      }
      if (parsed.soloStats && typeof parsed.soloStats === 'object') {
        for (const [k, v] of Object.entries(parsed.soloStats)) {
          this.statsByMode.solo[k] = normalizeStats(v);
        }
      }
      if (parsed.ffaStats && typeof parsed.ffaStats === 'object') {
        for (const [k, v] of Object.entries(parsed.ffaStats)) {
          this.statsByMode.ffa[k] = normalizeStats(v);
        }
      }
    } catch {
      this.humanRatings = { solo: INITIAL_HUMAN_ELO, ffa: INITIAL_HUMAN_ELO };
      this.statsByMode = { solo: {}, ffa: {} };
    }
  }

  private save() {
    const payload: StoredLeaderboardV2 = {
      version: 2,
      humanSoloRating: this.humanRatings.solo,
      humanFfaRating: this.humanRatings.ffa,
      soloStats: this.statsByMode.solo,
      ffaStats: this.statsByMode.ffa,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota errors in private browsing
    }
  }

  public getHumanRating(mode: RankedMode): number {
    return this.humanRatings[mode];
  }

  public getBotFixedRating(botId: string, mode: RankedMode): number | null {
    const entry = this.rosterById.get(botId);
    if (!entry || entry.category !== 'official') return null;
    const raw = mode === 'solo' ? entry.duelRating : entry.ffaRating;
    return typeof raw === 'number' ? raw : entry.rating;
  }

  private ensureStats(mode: RankedMode, entityId: string): ModeStats {
    const bucket = this.statsByMode[mode];
    if (!bucket[entityId]) bucket[entityId] = emptyStats();
    return bucket[entityId];
  }

  private snapshotLadder(mode: RankedMode): LadderEntrySnap[] {
    return this.getRows(mode, 'rating').map((r) => ({
      id: r.id,
      isHuman: r.isHuman,
      name: r.name,
      shortName: r.shortName,
      avatar: r.avatar,
      color: r.color,
      rating: r.rating,
      rank: r.eloRank,
    }));
  }

  private applyHumanEloUpdate(
    mode: RankedMode,
    config: MatchConfig,
    state: TickSnapshot,
  ): EloUpdateResult | null {
    const n = config.slots.length;
    const humanSeat = config.slots.findIndex((s) => s.kind === 'human');
    if (humanSeat < 0 || humanSeat >= state.players.length) return null;

    const beforeLadder = this.snapshotLadder(mode);
    const oldHumanIdx = beforeLadder.findIndex((r) => r.isHuman);
    const oldRank = oldHumanIdx >= 0 ? beforeLadder[oldHumanIdx].rank : beforeLadder.length;

    const oldRating = this.humanRatings[mode];
    const humanP = state.players[humanSeat];
    let oppCount = 0;
    let sumDiff = 0;

    for (let j = 0; j < n && j < state.players.length; j++) {
      if (j === humanSeat) continue;
      const oppSlot = config.slots[j];
      const oppP = state.players[j];
      const oppRating = oppSlot.kind === 'bot' && oppSlot.botId ? this.getBotFixedRating(oppSlot.botId, mode) : null;
      if (oppRating === null) continue;

      const expected = 1 / (1 + Math.pow(10, (oppRating - oldRating) / 400));

      let actual = 0.5;
      if (humanP.rank < oppP.rank) actual = 1.0;
      else if (humanP.rank > oppP.rank) actual = 0.0;
      else if (humanP.kills > oppP.kills) actual = 1.0;
      else if (humanP.kills < oppP.kills) actual = 0.0;

      sumDiff += actual - expected;
      oppCount++;
    }

    const rawDelta = oppCount > 0 ? (ELO_K / oppCount) * sumDiff : 0;
    const gainMult = getEloGainMultiplier(oldRating);
    const adjustedDelta = rawDelta > 0 ? rawDelta * gainMult : rawDelta;
    const newRating = clampHumanElo(oldRating + adjustedDelta);
    const delta = newRating - oldRating;
    this.humanRatings[mode] = newRating;

    const afterLadder = this.snapshotLadder(mode);
    const newHumanIdx = afterLadder.findIndex((r) => r.isHuman);
    const newRank = newHumanIdx >= 0 ? afterLadder[newHumanIdx].rank : afterLadder.length;

    // Identify bots human overtook (were above human before, now below human)
    const beforePosById = new Map(beforeLadder.map((e, idx) => [e.id, idx]));
    const afterPosById = new Map(afterLadder.map((e, idx) => [e.id, idx]));

    const overtook: LadderEntrySnap[] = [];
    const overtakenBy: LadderEntrySnap[] = [];

    if (oldHumanIdx >= 0 && newHumanIdx >= 0) {
      for (const e of afterLadder) {
        if (e.isHuman) continue;
        const bPos = beforePosById.get(e.id);
        const aPos = afterPosById.get(e.id);
        if (bPos === undefined || aPos === undefined) continue;
        if (bPos < oldHumanIdx && aPos > newHumanIdx) {
          overtook.push(e);
        } else if (bPos > oldHumanIdx && aPos < newHumanIdx) {
          overtakenBy.push(e);
        }
      }
      // Order overtook from closest passed -> highest passed (ascending Elo); overtakenBy highest -> lowest
      overtook.sort((a, b) => a.rating - b.rating);
      overtakenBy.sort((a, b) => b.rating - a.rating);
    }

    return {
      mode,
      oldRating,
      newRating,
      delta,
      oldRank,
      newRank,
      totalRanked: afterLadder.length,
      overtook,
      overtakenBy,
      beforeLadder,
      afterLadder,
    };
  }

  /**
   * Record a finished ranked match (SOLO or FFA). Custom matches do not affect ranked Elo or leaderboards.
   */
  public recordMatch(config: MatchConfig, finalState: TickSnapshot): EloUpdateResult | null {
    const mode = rankedModeOf(config);
    if (!mode) return null;

    const n = config.slots.length;
    for (let k = 0; k < n && k < finalState.players.length; k++) {
      const slot = config.slots[k];
      const p = finalState.players[k];
      const entityId = slot.kind === 'human' ? 'human' : slot.botId!;
      if (slot.kind === 'bot' && this.getBotFixedRating(entityId, mode) === null) continue;

      const st = this.ensureStats(mode, entityId);
      st.games += 1;
      if (finalState.winner === k) {
        st.wins += 1;
      } else if (finalState.winner === -1 && p.rank === 1) {
        st.draws += 1;
      }

      st.kills += p.kills;
      if (!p.alive) st.deaths += 1;
      st.dartKills += p.kDart || 0;
      st.meleeKills += p.kSlash || 0;
      st.terrainKills += p.kFall || 0;
      if (!p.alive && p.cause === CauseType.FALL) {
        st.cliffFalls += 1;
      }
    }

    const eloResult = this.applyHumanEloUpdate(mode, config, finalState);
    this.save();
    return eloResult;
  }

  /**
   * Called when an eliminated human presses R in Ranked mode before remaining bots finish.
   * Updates human's Elo and personal stats by current rank without corrupting unfinished bots.
   */
  public recordHumanEarlyExit(config: MatchConfig, state: TickSnapshot): EloUpdateResult | null {
    const mode = rankedModeOf(config);
    if (!mode) return null;

    const humanSeat = config.slots.findIndex((s) => s.kind === 'human');
    if (humanSeat < 0 || humanSeat >= state.players.length) return null;
    const humanP = state.players[humanSeat];
    if (humanP.alive) return null;

    const st = this.ensureStats(mode, 'human');
    st.games += 1;
    st.kills += humanP.kills;
    st.deaths += 1;
    st.dartKills += humanP.kDart || 0;
    st.meleeKills += humanP.kSlash || 0;
    st.terrainKills += humanP.kFall || 0;
    if (humanP.cause === CauseType.FALL) {
      st.cliffFalls += 1;
    }

    const eloResult = this.applyHumanEloUpdate(mode, config, state);
    this.save();
    return eloResult;
  }

  /**
   * Reset ALL local stats & both SOLO/FFA human Elo ratings (back to 500). Bot scores remain fixed.
   */
  public resetAllStats() {
    this.humanRatings = { solo: INITIAL_HUMAN_ELO, ffa: INITIAL_HUMAN_ELO };
    this.statsByMode = { solo: {}, ffa: {} };
    this.save();
  }

  /**
   * Returns ONLY Human + the 13 Official Bots (no sparring bots) for the specified ranked mode.
   */
  public getRows(
    mode: RankedMode,
    sortBy: 'rating' | 'wr' | 'kills' | 'deaths' | 'kd' = 'rating',
  ): LeaderboardRow[] {
    const bucket = this.statsByMode[mode];
    const rows: LeaderboardRow[] = [];

    const makeRow = (
      id: string,
      isHuman: boolean,
      name: string,
      shortName: string,
      avatar: string | null,
      color: string,
      rating: number,
    ): LeaderboardRow => {
      const st = normalizeStats(bucket[id]);
      const kd =
        st.games === 0 && st.kills === 0 && st.deaths === 0
          ? null
          : st.deaths > 0
            ? st.kills / st.deaths
            : st.kills;
      return {
        id,
        isHuman,
        name,
        shortName,
        avatar,
        color,
        rating,
        eloRank: 1,
        stats: st,
        kd,
      };
    };

    rows.push(
      makeRow(
        'human',
        true,
        '玩家 (YOU)',
        '玩家',
        this.humanAvatar,
        '#3D7EFF',
        this.humanRatings[mode],
      ),
    );

    for (const b of this.officialBots) {
      const rating = (mode === 'solo' ? b.duelRating : b.ffaRating) ?? b.rating ?? 1000;
      rows.push(makeRow(b.id, false, b.name, b.shortName, b.avatar, b.color, rating));
    }

    // Assign authoritative Elo rank (1..14)
    rows.sort((a, b) => b.rating - a.rating || (a.isHuman ? -1 : b.isHuman ? 1 : a.name.localeCompare(b.name)));
    rows.forEach((r, idx) => {
      r.eloRank = idx + 1;
    });

    if (sortBy !== 'rating') {
      const wr = (s: ModeStats) => (s.games > 0 ? (s.wins + 0.5 * s.draws) / s.games : -1);
      rows.sort((a, b) => {
        let diff = 0;
        if (sortBy === 'wr') diff = wr(b.stats) - wr(a.stats);
        else if (sortBy === 'kills') diff = b.stats.kills - a.stats.kills;
        else if (sortBy === 'deaths') diff = b.stats.deaths - a.stats.deaths;
        else if (sortBy === 'kd') diff = (b.kd ?? -1) - (a.kd ?? -1);
        if (Math.abs(diff) > 1e-9) return diff;
        return b.rating - a.rating;
      });
    }

    return rows;
  }

  public getHumanRank(mode: RankedMode): { rank: number; total: number } {
    const rows = this.getRows(mode, 'rating');
    const humanRow = rows.find((r) => r.isHuman);
    return { rank: humanRow ? humanRow.eloRank : rows.length, total: rows.length };
  }

  /**
   * Ranked matchmaking: randomly pick 1 (SOLO) or 3 (FFA) DISTINCT official bots from the
   * nearest 4 (SOLO) / 6 (FFA) ranked opponents to the human's current rank position.
   * When `avoidSameAs` is provided (e.g. pressing R after death), guarantees opponent(s) change.
   */
  public pickRankedOpponents(mode: RankedMode, avoidSameAs?: string[]): RosterEntry[] {
    const rows = this.getRows(mode, 'rating');
    const humanIdx = rows.findIndex((r) => r.isHuman);
    const humanRating = this.humanRatings[mode];

    const rankedBots = rows
      .map((row, idx) => ({ row, idx }))
      .filter((x) => !x.row.isHuman)
      .sort((a, b) => {
        const dRank = Math.abs(a.idx - humanIdx) - Math.abs(b.idx - humanIdx);
        if (dRank !== 0) return dRank;
        return Math.abs(a.row.rating - humanRating) - Math.abs(b.row.rating - humanRating);
      });

    const poolSize = mode === 'solo' ? 4 : 6;
    const need = mode === 'solo' ? 1 : 3;
    const candidateEntries = rankedBots
      .slice(0, Math.min(poolSize, rankedBots.length))
      .map((x) => this.rosterById.get(x.row.id)!)
      .filter(Boolean);

    const prevSet = avoidSameAs && avoidSameAs.length > 0 ? new Set(avoidSameAs) : null;

    if (need === 1) {
      let pool = candidateEntries;
      if (prevSet && pool.length > 1) {
        const filtered = pool.filter((b) => !prevSet.has(b.id));
        if (filtered.length > 0) pool = filtered;
      }
      return [pool[Math.floor(Math.random() * pool.length)]];
    }

    const shufflePick = (arr: RosterEntry[]): RosterEntry[] => {
      const copy = [...arr];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy.slice(0, need);
    };

    let chosen = shufflePick(candidateEntries);
    if (prevSet && candidateEntries.length > need) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const sameAll = chosen.length === prevSet.size && chosen.every((b) => prevSet.has(b.id));
        if (!sameAll) break;
        chosen = shufflePick(candidateEntries);
      }
    }
    return chosen;
  }
}
