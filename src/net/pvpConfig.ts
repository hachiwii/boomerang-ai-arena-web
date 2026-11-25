/**
 * Online PvP build configuration (Vite env vars, see .env.example):
 *   VITE_PVP_ENABLED  PvP is ON unless this is 0/false/off/no (the Cloudflare mirror build sets it to 0).
 *   VITE_PVP_URL      the relay WebSocket URL (e.g. wss://pvp.example.com/ws). Unset: the relay is assumed on the same
 *                     host as the page, port 8787 — ws:// on http pages, wss:// on https pages — which is what a
 *                     self-hosted deployment running server/ next to the static files gets out of the box.
 */
function parseFlag(raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return null;
}

export const PVP_ENABLED: boolean = parseFlag(import.meta.env.VITE_PVP_ENABLED) ?? true;

export function pvpServerUrl(): string | null {
  const configured = import.meta.env.VITE_PVP_URL?.trim();
  if (configured) return configured;
  if (typeof window === 'undefined') return null;
  const { protocol, hostname } = window.location;
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname; // bare IPv6
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}:8787/ws`;
}

/** PvP is shown and may connect only when it is enabled and has a relay to talk to. */
export function isPvpAvailable(): boolean {
  return PVP_ENABLED && pvpServerUrl() !== null;
}
