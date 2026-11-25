/**
 * Online PvP build configuration (Vite env vars, see .env.example):
 *   VITE_PVP_ENABLED  1/true/on to show PvP, 0/false/off to hide it. Unset: on in `vite dev`, off in production builds.
 *   VITE_PVP_URL      the relay WebSocket URL (wss://…/ws). Unset: ws://<page host>:8787/ws on localhost pages, otherwise
 *                     PvP stays unavailable even when enabled.
 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function parseFlag(raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return null;
}

export const PVP_ENABLED: boolean = parseFlag(import.meta.env.VITE_PVP_ENABLED) ?? import.meta.env.DEV;

export function pvpServerUrl(): string | null {
  const configured = import.meta.env.VITE_PVP_URL?.trim();
  if (configured) return configured;
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  return LOCAL_HOSTS.includes(host) ? `ws://${host}:8787/ws` : null;
}

/** PvP is shown and may connect only when it is enabled and has a relay to talk to. */
export function isPvpAvailable(): boolean {
  return PVP_ENABLED && pvpServerUrl() !== null;
}
