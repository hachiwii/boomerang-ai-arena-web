// Site analytics for the relay (server/analytics.ts): a heartbeat every minute while the page is visible, plus an
// event when a match / replay / cricket batch starts and when it finishes. The only identity sent is a random id this
// browser generated (localStorage); nothing is sent when PvP is off (mirror builds) because there is no relay then.
import { relayHttpUrl } from './pvpConfig';
import type { BotResult } from '../game/botResults';
import type { MatchMode } from '../game/types';

export type AnalyticsMode = MatchMode | 'cricket-batch' | 'replay';

const ID_KEY = 'boomerang-visitor-id';
const BEAT_MS = 60_000;

let visitor: string | null = null;
let started = false;
// The match on screen that has started but not been counted as finished yet (local matches only: the relay counts
// PvP itself, replays have no end, and a cricket batch always reports its own end).
let unfinished: AnalyticsMode | null = null;

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function visitorId(): string {
  if (visitor) return visitor;
  try {
    const stored = localStorage.getItem(ID_KEY);
    if (stored && /^[a-f0-9]{32}$/.test(stored)) return (visitor = stored);
    visitor = randomId();
    localStorage.setItem(ID_KEY, visitor);
  } catch {
    visitor ??= randomId(); // storage blocked: count this page view on its own
  }
  return visitor;
}

function endpoint(path: '/beat' | '/event'): string | null {
  return relayHttpUrl(path);
}

function post(path: '/beat' | '/event', body: Record<string, unknown>, beacon = false) {
  const url = endpoint(path);
  if (!url) return;
  const payload = JSON.stringify({ id: visitorId(), ...body });
  try {
    // text/plain keeps it a CORS "simple" request (no preflight); failures are ignored
    if (beacon && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' }));
      return;
    }
    void fetch(url, {
      method: 'POST', body: payload, keepalive: true, credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    }).catch(() => undefined);
  } catch {
    // Never let analytics affect the game.
  }
}

/** Start heartbeats (online count / daily UV). Online = this page is open and visible. */
export function startAnalytics() {
  if (started || !endpoint('/beat')) return;
  started = true;
  const beat = () => {
    if (document.visibilityState === 'visible') post('/beat', {});
  };
  beat();
  window.setInterval(beat, BEAT_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') beat();
    else post('/beat', { leave: true }, true);
  });
  window.addEventListener('pagehide', () => post('/beat', { leave: true }, true));
}

export function trackMatchStart(mode: AnalyticsMode) {
  if (mode !== 'pvp' && mode !== 'replay' && mode !== 'cricket-batch') unfinished = mode;
  post('/event', { kind: 'start', mode });
}

/** `bots`: ranked matches played to the end report each bot's result (src/game/botResults.ts). */
export function trackMatchEnd(mode: AnalyticsMode, bots?: BotResult[]) {
  if (unfinished === mode) unfinished = null;
  if (mode === 'pvp') return; // the relay counts PvP matches itself
  post('/event', bots?.length ? { kind: 'end', mode, bots } : { kind: 'end', mode });
}

/** Quick restart (R / 再来一局): the match being left counts as finished, unless its end was already counted. */
export function trackMatchRestart() {
  if (unfinished) trackMatchEnd(unfinished);
}
