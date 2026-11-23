import { CauseType, MatchConfig, RosterEntry, TickSnapshot } from './types';

export interface ModeRecord {
  games: number;
  wins: number;
  draws: number;
}

export interface ContestantStats {
  mode2: ModeRecord;
  mode3: ModeRecord;
  mode4: ModeRecord;
  kills: number;
  deaths: number;
  dartKills: number;    // 飞镖击杀
  meleeKills: number;   // 近战击杀
  terrainKills: number; // 地形击杀
  cliffFalls: number;   // 坠崖次数
}

export interface EloUpdateResult {
  oldRating: number;
  newRating: number;
  delta: number;
}

export interface LeaderboardRow {
  id: string;
  isHuman: boolean;
  name: string;
  shortName: string;
  category: 'human' | 'official' | 'sparring';
  avatar: string | null;
  color: string;
  rating: number;
  duelRating: number | null;
  ffaRating: number | null;
  stats: ContestantStats;
  kd: number | null; // null if no games played
}

interface StoredLeaderboardV1 {
  version: 1;
  humanRating: number;
  stats: Record<string, ContestantStats>;
}

const STORAGE_KEY = 'boomerang_arena_leaderboard_v1';
const ELO_K = 32;

function emptyStats(): ContestantStats {
  return {
    mode2: { games: 0, wins: 0, draws: 0 },
    mode3: { games: 0, wins: 0, draws: 0 },
    mode4: { games: 0, wins: 0, draws: 0 },
    kills: 0,
    deaths: 0,
    dartKills: 0,
    meleeKills: 0,
    terrainKills: 0,
    cliffFalls: 0,
  };
}

function normalizeStats(raw?: Partial<ContestantStats>): ContestantStats {
  const base = emptyStats();
  if (!raw) return base;
  return {
    mode2: {
      games: Number(raw.mode2?.games) || 0,
      wins: Number(raw.mode2?.wins) || 0,
      draws: Number(raw.mode2?.draws) || 0,
    },
    mode3: {
      games: Number(raw.mode3?.games) || 0,
      wins: Number(raw.mode3?.wins) || 0,
      draws: Number(raw.mode3?.draws) || 0,
    },
    mode4: {
      games: Number(raw.mode4?.games) || 0,
      wins: Number(raw.mode4?.wins) || 0,
      draws: Number(raw.mode4?.draws) || 0,
    },
    kills: Number(raw.kills) || 0,
    deaths: Number(raw.deaths) || 0,
    dartKills: Number(raw.dartKills) || 0,
    meleeKills: Number(raw.meleeKills) || 0,
    terrainKills: Number(raw.terrainKills) || 0,
    cliffFalls: Number(raw.cliffFalls) || 0,
  };
}

export class LeaderboardStore {
  private readonly roster: RosterEntry[];
  private readonly rosterById: Map<string, RosterEntry>;
  private humanRating = 0;
  private stats: Record<string, ContestantStats> = {};
  private readonly humanAvatar: string;

  constructor(roster: RosterEntry[], humanAvatar: string) {
    this.roster = roster;
    this.rosterById = new Map(roster.map((r) => [r.id, r]));
    this.humanAvatar = humanAvatar;
    this.load();
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<StoredLeaderboardV1>;
      if (typeof parsed.humanRating === 'number' && Number.isFinite(parsed.humanRating)) {
        this.humanRating = parsed.humanRating;
      }
      if (parsed.stats && typeof parsed.stats === 'object') {
        for (const [k, v] of Object.entries(parsed.stats)) {
          this.stats[k] = normalizeStats(v);
        }
      }
    } catch {
      this.humanRating = 0;
      this.stats = {};
    }
  }

  private save() {
    const payload: StoredLeaderboardV1 = {
      version: 1,
      humanRating: this.humanRating,
      stats: this.stats,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota errors in private browsing
    }
  }

  public getHumanRating(): number {
    return this.humanRating;
  }

  public getBotFixedRating(botId: string): number {
    return this.rosterById.get(botId)?.rating ?? 0;
  }

  private ensureStats(id: string): ContestantStats {
    if (!this.stats[id]) this.stats[id] = emptyStats();
    return this.stats[id];
  }

  private applyHumanEloUpdate(config: MatchConfig, state: TickSnapshot): EloUpdateResult | null {
    const n = config.slots.length;
    const humanSeat = config.slots.findIndex((s) => s.kind === 'human');
    if (humanSeat < 0 || humanSeat >= state.players.length) return null;

    const oldRating = this.humanRating;
    const humanP = state.players[humanSeat];
    let oppCount = 0;
    let sumDiff = 0;

    for (let j = 0; j < n && j < state.players.length; j++) {
      if (j === humanSeat) continue;
      const oppSlot = config.slots[j];
      const oppP = state.players[j];
      const oppRating = oppSlot.kind === 'bot' && oppSlot.botId ? this.getBotFixedRating(oppSlot.botId) : 0;

      // Expected score (standard 400-scale Elo matching meow-ai-arena Bradley-Terry scale)
      const expected = 1 / (1 + Math.pow(10, (oppRating - oldRating) / 400));

      // Actual score vs this opponent: rank first, then kills on tie, else 0.5 draw
      let actual = 0.5;
      if (humanP.rank < oppP.rank) actual = 1.0;
      else if (humanP.rank > oppP.rank) actual = 0.0;
      else if (humanP.kills > oppP.kills) actual = 1.0;
      else if (humanP.kills < oppP.kills) actual = 0.0;

      sumDiff += actual - expected;
      oppCount++;
    }

    const rawDelta = oppCount > 0 ? (ELO_K / oppCount) * sumDiff : 0;
    const newRating = Math.round((oldRating + rawDelta) * 10) / 10;
    const delta = Math.round((newRating - oldRating) * 10) / 10;
    this.humanRating = newRating;
    return { oldRating, newRating, delta };
  }

  /**
   * Record a finished match for all participants (2p/3p/4p win rates, kills, deaths,
   * dart/melee/terrain kills, cliff falls). If a human participated, update ONLY the
   * human's Elo rating (all bot Elo ratings remain permanently fixed).
   */
  public recordMatch(config: MatchConfig, finalState: TickSnapshot): EloUpdateResult | null {
    const n = config.slots.length;
    const modeKey: 'mode2' | 'mode3' | 'mode4' = n === 2 ? 'mode2' : n === 3 ? 'mode3' : 'mode4';

    // 1. Update battle stats for every participant seat
    for (let k = 0; k < n && k < finalState.players.length; k++) {
      const slot = config.slots[k];
      const p = finalState.players[k];
      const entityId = slot.kind === 'human' ? 'human' : slot.botId!;
      const st = this.ensureStats(entityId);
      const mr = st[modeKey];

      mr.games += 1;
      if (finalState.winner === k) {
        mr.wins += 1;
      } else if (finalState.winner === -1 && p.rank === 1) {
        mr.draws += 1;
      }

      st.kills += p.kills;
      if (!p.alive) {
        st.deaths += 1;
      }
      st.dartKills += p.kDart || 0;
      st.meleeKills += p.kSlash || 0;
      st.terrainKills += p.kFall || 0;
      if (!p.alive && p.cause === CauseType.FALL) {
        st.cliffFalls += 1;
      }
    }

    // 2. If human participated, update human Elo using pairwise Elo (scale 400, K=32)
    // Bot scores are ALWAYS fixed.
    const eloResult = this.applyHumanEloUpdate(config, finalState);

    this.save();
    return eloResult;
  }

  /**
   * Called when an eliminated human presses R to restart before the remaining bots finish.
   * Since the human is already dead, their relative rank vs every opponent is already final:
   * update human's Elo and personal stats without corrupting unfinished bots' win rates.
   */
  public recordHumanEarlyExit(config: MatchConfig, state: TickSnapshot): EloUpdateResult | null {
    const n = config.slots.length;
    const humanSeat = config.slots.findIndex((s) => s.kind === 'human');
    if (humanSeat < 0 || humanSeat >= state.players.length) return null;
    const humanP = state.players[humanSeat];
    if (humanP.alive) return null;

    const modeKey: 'mode2' | 'mode3' | 'mode4' = n === 2 ? 'mode2' : n === 3 ? 'mode3' : 'mode4';
    const st = this.ensureStats('human');
    st[modeKey].games += 1;
    st.kills += humanP.kills;
    st.deaths += 1;
    st.dartKills += humanP.kDart || 0;
    st.meleeKills += humanP.kSlash || 0;
    st.terrainKills += humanP.kFall || 0;
    if (humanP.cause === CauseType.FALL) {
      st.cliffFalls += 1;
    }

    const eloResult = this.applyHumanEloUpdate(config, state);
    this.save();
    return eloResult;
  }

  /**
   * Reset ALL local stats & human Elo (back to 0). Bot fixed Elo ratings remain untouched!
   */
  public resetAllStats() {
    this.humanRating = 0;
    this.stats = {};
    this.save();
  }

  public getRows(
    sortBy: 'rating' | 'wr2' | 'wr3' | 'wr4' | 'kills' | 'deaths' | 'kd' = 'rating',
    includeSparring = true,
  ): LeaderboardRow[] {
    const rows: LeaderboardRow[] = [];

    const makeRow = (
      id: string,
      isHuman: boolean,
      name: string,
      shortName: string,
      category: 'human' | 'official' | 'sparring',
      avatar: string | null,
      color: string,
      rating: number,
      duelRating: number | null,
      ffaRating: number | null,
    ): LeaderboardRow => {
      const st = normalizeStats(this.stats[id]);
      const totalGames = st.mode2.games + st.mode3.games + st.mode4.games;
      const kd = totalGames === 0 && st.kills === 0 && st.deaths === 0
        ? null
        : st.deaths > 0
          ? st.kills / st.deaths
          : st.kills;
      return {
        id,
        isHuman,
        name,
        shortName,
        category,
        avatar,
        color,
        rating,
        duelRating,
        ffaRating,
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
        'human',
        this.humanAvatar,
        '#3D7EFF',
        this.humanRating,
        null,
        null,
      ),
    );

    for (const b of this.roster) {
      if (!includeSparring && b.category === 'sparring') continue;
      rows.push(
        makeRow(
          b.id,
          false,
          b.name,
          b.shortName,
          b.category,
          b.avatar,
          b.color,
          b.rating,
          b.duelRating ?? null,
          b.ffaRating ?? null,
        ),
      );
    }

    const wr = (m: ModeRecord) => (m.games > 0 ? (m.wins + 0.5 * m.draws) / m.games : -1);

    rows.sort((a, b) => {
      let diff = 0;
      if (sortBy === 'rating') diff = b.rating - a.rating;
      else if (sortBy === 'wr2') diff = wr(b.stats.mode2) - wr(a.stats.mode2);
      else if (sortBy === 'wr3') diff = wr(b.stats.mode3) - wr(a.stats.mode3);
      else if (sortBy === 'wr4') diff = wr(b.stats.mode4) - wr(a.stats.mode4);
      else if (sortBy === 'kills') diff = b.stats.kills - a.stats.kills;
      else if (sortBy === 'deaths') diff = b.stats.deaths - a.stats.deaths;
      else if (sortBy === 'kd') diff = (b.kd ?? -1) - (a.kd ?? -1);
      if (Math.abs(diff) > 1e-9) return diff;
      return b.rating - a.rating;
    });

    return rows;
  }

  public getHumanRank(): { rank: number; total: number } {
    const rows = this.getRows('rating', false); // Rank among official 13 bots + human
    const idx = rows.findIndex((r) => r.isHuman);
    return { rank: idx >= 0 ? idx + 1 : rows.length, total: rows.length };
  }
}
