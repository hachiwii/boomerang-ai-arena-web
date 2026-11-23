import { MapMeta, RosterEntry } from './types';

export type CricketFormat = '1v1' | 'ffa4';
export type CricketTier = 'invited' | 'lottery' | 'excluded';

export interface CricketBotStats {
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
}

export interface CricketState {
  format: CricketFormat;
  mapPool: string[];
  tiers: Record<CricketTier, string[]>;
  stats: Record<string, CricketBotStats>;
}

const CRICKET_STORAGE_KEY = 'boomerang_arena_cricket_v1';

export class CricketStore {
  private readonly maps: MapMeta[];
  private readonly roster: RosterEntry[];
  private state: CricketState;

  constructor(maps: MapMeta[], roster: RosterEntry[]) {
    this.maps = maps;
    this.roster = roster;
    this.state = this.load();
  }

  private defaultState(): CricketState {
    const official = this.roster
      .filter((r) => r.category === 'official')
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .map((r) => r.id);
    const sparring = this.roster.filter((r) => r.category !== 'official').map((r) => r.id);
    return {
      format: 'ffa4',
      mapPool: this.maps.map((m) => m.id),
      tiers: {
        invited: [],
        lottery: official,
        excluded: sparring,
      },
      stats: {},
    };
  }

  private load(): CricketState {
    const fallback = this.defaultState();
    const validMaps = new Set(this.maps.map((m) => m.id));
    const validBots = new Set(this.roster.map((r) => r.id));

    try {
      const raw = localStorage.getItem(CRICKET_STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<CricketState>;

      const format: CricketFormat = parsed.format === '1v1' ? '1v1' : 'ffa4';
      const maxPlayers = format === '1v1' ? 2 : 4;

      const rawMapPool = Array.isArray(parsed.mapPool)
        ? parsed.mapPool.filter((id): id is string => typeof id === 'string' && validMaps.has(id))
        : [];
      const mapPool = rawMapPool.length > 0 ? Array.from(new Set(rawMapPool)) : fallback.mapPool;

      const seen = new Set<string>();
      const pickUnique = (arr?: unknown): string[] => {
        if (!Array.isArray(arr)) return [];
        const out: string[] = [];
        for (const item of arr) {
          if (typeof item === 'string' && validBots.has(item) && !seen.has(item)) {
            seen.add(item);
            out.push(item);
          }
        }
        return out;
      };

      let invited = pickUnique(parsed.tiers?.invited);
      const lottery = pickUnique(parsed.tiers?.lottery);
      const excluded = pickUnique(parsed.tiers?.excluded);

      // Enforce invariant: invited count never exceeds total players for format
      if (invited.length > maxPlayers) {
        const overflow = invited.slice(maxPlayers);
        invited = invited.slice(0, maxPlayers);
        lottery.unshift(...overflow);
      }

      // Any newly added roster bots not yet placed default to lottery (official) or excluded (sparring)
      for (const r of this.roster) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          if (r.category === 'official') lottery.push(r.id);
          else excluded.push(r.id);
        }
      }

      const stats: Record<string, CricketBotStats> = {};
      if (parsed.stats && typeof parsed.stats === 'object') {
        for (const [id, st] of Object.entries(parsed.stats)) {
          if (!validBots.has(id) || !st || typeof st !== 'object') continue;
          const m = Number((st as CricketBotStats).matches) || 0;
          const w = Number((st as CricketBotStats).wins) || 0;
          const k = Number((st as CricketBotStats).kills) || 0;
          const d = Number((st as CricketBotStats).deaths) || 0;
          if (m > 0 || w > 0 || k > 0 || d > 0) {
            stats[id] = {
              matches: Math.max(0, Math.round(m)),
              wins: Math.max(0, Math.round(w)),
              kills: Math.max(0, Math.round(k)),
              deaths: Math.max(0, Math.round(d)),
            };
          }
        }
      }

      return {
        format,
        mapPool,
        tiers: { invited, lottery, excluded },
        stats,
      };
    } catch {
      return fallback;
    }
  }

  private save() {
    try {
      localStorage.setItem(CRICKET_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore storage quota errors
    }
  }

  public getFormat(): CricketFormat {
    return this.state.format;
  }

  public getMaxPlayers(): number {
    return this.state.format === '1v1' ? 2 : 4;
  }

  /** Switches between 1v1 and 4-player FFA; returns the number of excess invited bots moved to lottery. */
  public setFormat(format: CricketFormat): number {
    if (this.state.format === format) return 0;
    this.state.format = format;
    const maxP = this.getMaxPlayers();
    let demoted = 0;
    if (this.state.tiers.invited.length > maxP) {
      const overflow = this.state.tiers.invited.slice(maxP);
      this.state.tiers.invited = this.state.tiers.invited.slice(0, maxP);
      this.state.tiers.lottery.unshift(...overflow);
      demoted = overflow.length;
    }
    this.save();
    return demoted;
  }

  public getMapPoolSet(): Set<string> {
    return new Set(this.state.mapPool);
  }

  public getMapPoolMetas(): MapMeta[] {
    const set = this.getMapPoolSet();
    const list = this.maps.filter((m) => set.has(m.id));
    return list.length > 0 ? list : this.maps;
  }

  public setMapPool(ids: string[]) {
    const valid = new Set(this.maps.map((m) => m.id));
    const filtered = Array.from(new Set(ids.filter((id) => valid.has(id))));
    if (filtered.length === 0) return;
    this.state.mapPool = filtered;
    this.save();
  }

  public toggleMap(mapId: string): boolean {
    const set = this.getMapPoolSet();
    if (set.has(mapId)) {
      if (set.size <= 1) return false;
      set.delete(mapId);
    } else {
      set.add(mapId);
    }
    this.state.mapPool = Array.from(set);
    this.save();
    return true;
  }

  public getTierIds(tier: CricketTier): string[] {
    return this.state.tiers[tier];
  }

  public getBotTier(botId: string): CricketTier {
    if (this.state.tiers.invited.includes(botId)) return 'invited';
    if (this.state.tiers.lottery.includes(botId)) return 'lottery';
    return 'excluded';
  }

  /**
   * Moves `botId` into `targetTier` (optionally before `beforeBotId`).
   * Rejects moving into `invited` if already at capacity (`maxPlayers`).
   */
  public moveBot(
    botId: string,
    targetTier: CricketTier,
    beforeBotId?: string | null,
  ): { ok: boolean; reason?: 'invited_full' } {
    const currentTier = this.getBotTier(botId);
    const maxP = this.getMaxPlayers();
    if (targetTier === 'invited' && currentTier !== 'invited' && this.state.tiers.invited.length >= maxP) {
      return { ok: false, reason: 'invited_full' };
    }

    // Remove from current tier
    const src = this.state.tiers[currentTier];
    const oldIdx = src.indexOf(botId);
    if (oldIdx >= 0) src.splice(oldIdx, 1);

    // Insert into target tier
    const dst = this.state.tiers[targetTier];
    if (beforeBotId && beforeBotId !== botId) {
      const targetIdx = dst.indexOf(beforeBotId);
      if (targetIdx >= 0) {
        dst.splice(targetIdx, 0, botId);
      } else {
        dst.push(botId);
      }
    } else {
      dst.push(botId);
    }

    this.save();
    return { ok: true };
  }

  public getEligibleCount(): number {
    return this.state.tiers.invited.length + this.state.tiers.lottery.length;
  }

  public canStartMatch(): { ok: boolean; reason?: string } {
    const maxP = this.getMaxPlayers();
    if (this.state.mapPool.length === 0) {
      return { ok: false, reason: '图池至少选择 1 张地图' };
    }
    const eligible = this.getEligibleCount();
    if (eligible < maxP) {
      return {
        ok: false,
        reason: `直邀 + 抽签至少需要 ${maxP} 名选手（当前 ${eligible} 名）`,
      };
    }
    return { ok: true };
  }

  /**
   * Draws bots for one match: ALL invited bots + random sample from lottery to fill remaining seats,
   * then Fisher-Yates shuffles the lineup for random spawn seats.
   */
  public drawMatchBotIds(): string[] {
    const maxP = this.getMaxPlayers();
    const invited = this.state.tiers.invited.slice(0, maxP);
    const needed = Math.max(0, maxP - invited.length);
    const pool = this.state.tiers.lottery.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = [...invited, ...pool.slice(0, needed)];
    // Randomize spawn seats
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    return picked;
  }

  public getBotStats(botId: string): CricketBotStats {
    return this.state.stats[botId] || { matches: 0, wins: 0, kills: 0, deaths: 0 };
  }

  public getFixedElo(entry: RosterEntry): number | null {
    if (entry.category !== 'official') return null;
    if (this.state.format === '1v1') return entry.duelRating ?? entry.rating;
    return entry.ffaRating ?? entry.rating;
  }

  /** Records the outcome of a completed Cricket match into per-bot stats (never modifies ELO). */
  public recordMatchResult(
    participants: { botId?: string; kills: number; alive: boolean; won: boolean }[],
  ) {
    let changed = false;
    for (const p of participants) {
      if (!p.botId) continue;
      const prev = this.state.stats[p.botId] || { matches: 0, wins: 0, kills: 0, deaths: 0 };
      this.state.stats[p.botId] = {
        matches: prev.matches + 1,
        wins: prev.wins + (p.won ? 1 : 0),
        kills: prev.kills + Math.max(0, p.kills),
        deaths: prev.deaths + (p.alive ? 0 : 1),
      };
      changed = true;
    }
    if (changed) this.save();
  }

  /** Resets win rate and KD stats for all bots while preserving fixed ELO scores and pool tiers. */
  public resetStats() {
    this.state.stats = {};
    this.save();
  }
}
