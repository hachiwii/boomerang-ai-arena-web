# Online 1v1 (PvP) — design and work split

Status: in development on branch `feat/pvp` (UI) and `feat/pvp-net` (network, server, engine). This file is the
contract between the two sides; change it only through the integrator.

## What the player sees

- Lobby mode tabs: 排位 · 斗蛐蛐 · 自定义 · **PvP** (rightmost).
- Entering the PvP tab asks the server for a **6-digit code** and shows it. Below it: an input for someone else's
  code and a **对战** button.
- 对战 forwards the request to the code's owner. If the owner is **on the PvP tab right now** (page open, tab visible,
  not in a match) both clients go straight into the match — no confirmation. Otherwise the request is rejected
  with a reason (`PvpChallengeFailReason`).
- A code is reserved for **30 minutes** after its owner was last on the PvP tab; while the owner stays there it keeps
  renewing. It can be reset by hand (new code, the old one stops working). Coming back within 30 minutes gives the
  same code (the client keeps a secret token in localStorage).
- The PvP tab and the in-game perf line show the **live round trip to the server**.
- In the match the names are fixed: **P1** (seat 0, the challenger) and **P2**; the local player's name gets
  **（YOU）**. P1 is the blue hoodie (`demo_blue`), P2 the red one (`demo_red`).
- Match history has its own **PvP** category.

## Fixed rules (both players, not configurable in PvP)

`PVP_FIXED_RULES` in `src/net/pvpTypes.ts`: strict slash judgment (`humanSlashTicks` 2), cliff guard on, dash guard
on, melee assist on, speed 1.0, **no bullet time** (mobile aim slow-mo and its 50 % move scaling are off), no pause,
no restart. Input pre-buffering (预输入) follows each player's local settings — it only shapes the input the player
sends.

## Topology

```
browser ──wss://<relay domain>/ws──► Aliyun CDN (WebSocket on, secret x-pvp-origin-key header) ──► origin :8787 (Node, ws, systemd boomerang-pvp)
```

- Build config (`src/net/pvpConfig.ts`, `.env.example`): `VITE_PVP_ENABLED` switches PvP on (default on in `vite dev`,
  off in production builds — the Cloudflare mirror builds with it off) and `VITE_PVP_URL` is the relay URL (on
  `localhost`/`127.0.0.1` pages it defaults to `ws://<host>:8787/ws`). Off, or no URL → no PvP tab, no connection.
  The client never contains the origin IP.
- Transport is WebSocket (TCP): the account has no UDP-capable CDN product enabled (DCDN/IPA), and the user
  accepted TCP. Keep the message layer independent of the socket so a datagram transport could be added later, but
  do not build one now.
- The server sees the client's real IP in `ali-cdn-real-ip` (fallback: first `x-forwarded-for`, then the socket).

## Lobby protocol (sketch — the network side owns the exact format)

- `hello {buildId, token}` → `welcome {code, expiresAt, serverTime}`; `presence {present}` (present = on the PvP
  tab and `document.visibilityState === 'visible'`); `resetCode`; `ping {t}` → `pong {t, serverTime}` every 1 s in
  the lobby (also renews the code), every 0.5 s in a match.
- `mapPool {ids}`: each client reports its PvP map pool (lobby 地图选择, empty = all maps in
  `public/assets/maps/manifest.json`, standard and large). `challenge {code}` → `challengeResult`. **The relay** draws
  the map at random from the **challenged** player's pool (ids validated against the manifest) and the seeds
  (crypto random); clients no longer choose them.
- Codes: uniformly random 6 digits, unique among reserved codes. Challenges are rate-limited per IP and per
  connection (codes are guessable). Different `buildId` → `version`.

## Match flow

1. Challenge accepted → server creates the match (challenger = seat 0 = P1), sends `matchStart` to both
   (`PvpMatchInfo`). `main.ts` builds the config with `buildPvpMatchConfig` and starts the match.
2. Both load (map, engine worker, renderer) and send `ready`. When both are ready the server sends
   `go {startAt}` (server time, ~3 s ahead) so the 3-2-1-GO countdown ends on the same instant on both screens.
   Not ready within 20 s → match cancelled, both get a notice.
3. Frame `f` (20 Hz) is due at `startAt + f × 50 ms` in server time; clients estimate server time from ping
   (minimum-RTT filter).
4. **Result screen (PvP):** buttons 再来一局 / 退出, no auto-return countdown. The relay keeps the finished match in a
   post-game state and broadcasts both choices (`PvpRematchState`: undecided / rematch / left; a disconnect or
   leaving the page counts as left; undecided for 3 minutes counts as left). Both rematch → a new match with the same
   seats, a new map drawn from the challenged player's pool and new seeds; `matchStart` (with `rematchOf`) fires on
   both sides and main.ts starts it straight from the result screen. One side leaves → the other's 再来一局 is
   disabled (退出 still works). 退出 returns to the PvP tab.

## Netcode: input delay + rollback, server-canonical inputs

- **Input delay** `D` frames: input sampled at frame `f` is for frame `f + D`. The server picks `D` at `go` from both
  players' RTT (at least 2, at most 4) and keeps it for the match.
- Each client sends its input for frame `f + D` as soon as it is sampled. The server **accepts** an input if it arrives
  before that frame's deadline (`due + grace`, grace ≈ 100–150 ms), and forwards it to the opponent at once (and
  acknowledges it to the sender).
- At the deadline, a missing input is **filled** by the server with a **neutral** input: no movement, no action (a
  lagging player stands still instead of running on — repeating the last move used to walk players off cliffs). The
  fill goes to both clients — including the late one, who must roll back its own input. Inputs that arrive after the
  fill are dropped. Every (seat, frame) therefore has exactly one canonical value, the same on both clients, so the
  simulation is identical.
- The walking cliff guard for PvP human seats runs **inside the engine step** (deterministic, applied to every
  canonical input including fills), not on the client at sampling time: with input delay the client only knows a
  stale position. Single-player keeps its client-side guard.
- Remote input prediction: the last canonical remote input with `act = 0`.
- When a canonical input differs from the one used, restore the engine snapshot at that frame and re-simulate to the
  present. Keep snapshots for at least the deadline window (≈ 16 frames).
- The live clock follows server time, not accumulated local ticks: when a tab was throttled or hidden, catch up by
  simulating several frames at once.
- Rendering: show the newest predicted state. Events (sounds, FX) from re-simulated frames are de-duplicated; an event
  that disappears after a correction is simply not played again. **Match end, result screen and history are taken
  only from confirmed frames**; the recorded tick list must be the canonical sequence (replace mispredicted ticks).
- Desync check: clients report the engine state hash of confirmed frames (e.g. every 20 frames); the server compares
  and logs mismatches.
- Disconnects: the client reconnects with its token and match id; the server replays canonical inputs it missed. Gone
  for more than 10 s, or the player quits the match → **forfeit**: the opponent wins, both get a notice, the match
  ends on both screens and is saved to history.
- Over: the client reports `end {frame, hash, winner}`; the server cross-checks both reports and closes the match.
  A hard server-side timeout ends abandoned matches.

## Engine work (WASM)

- Several human seats: the per-seat human rules (slash/melee windows, swept block, cliff guard, melee assist) must
  apply to every human seat, not the single `human_slash_seat`. Single-player behaviour must not change.
- Snapshot save/restore (a full deep copy of `dart::Game`, including `hist`, `events`, RNG and collapse state),
  a state hash, and a batch step that returns only the final state — re-simulating several frames must not cost one
  worker round trip and one JSON state per frame.
- Determinism holds because both clients run the same wasm binary on the same inputs (`buildId` must match).

## Ownership (do not edit the other side's files; ask the integrator)

| Area | Files | Owner |
|---|---|---|
| Lobby PvP tab, code display, input, latency, reject messages, PvP map pool (`setMapPool`) | `src/ui/lobbyUI.ts`, `src/style.css`, `src/game/settings.ts` | UI |
| PvP result screen: 再来一局 / 退出 (`showMatchResult(..., { pvpRematch: true })`, `setPvpRematchState`, callbacks `onPvpRematch` / `onPvpExit`) | `src/ui/hudUI.ts` | UI |
| Match config for PvP (names, colours, models) | `src/game/pvpConfig.ts` | UI |
| HUD: P1/P2 + （YOU）, latency in the perf line (`setNetStats`), hide pause/restart/speed in PvP | `src/ui/hudUI.ts` | UI |
| Mobile: `setBulletTimeAllowed(false)` | `src/ui/mobileControls.ts` | UI |
| History: PvP bucket/tab, two human slots | `src/game/matchHistory.ts`, `src/ui/historyUI.ts` | UI |
| Offline mock client | `src/net/pvpLobbyMock.ts` | UI |
| Real client, protocol, session/rollback | `src/net/*` except the mock and `pvpTypes.ts` | Network |
| PvP match controller, `main.ts` glue (matchStart → match, setNetStats, bullet time off, forfeit, return to the PvP tab) | `src/game/pvpMatchController.ts` (new), `src/main.ts` | Network |
| Engine | `wasm/**`, `src/workers/engineWorker.ts`, `public/wasm/engine.*` | Network |
| Server | `server/**` | Network |
| Shared contract | `src/net/pvpTypes.ts`, `src/game/types.ts`, this file | Integrator |
| CDN, DNS, TLS, server deployment | Aliyun account, `aliyun_e0` | Integrator |

## Operations

- Deploy the relay: `scripts/deploy_pvp_server.sh` (builds `server/`, installs `/opt/boomerang-pvp` and the
  `boomerang-pvp` unit). A restart drops lobby codes and running matches.
- `/etc/boomerang-pvp.env` on the origin holds `PVP_ORIGIN_KEY`; the CDN sends the same value in
  `x-pvp-origin-key`, so direct connections to the origin IP get 403.
- TLS for the relay domain is a Let's Encrypt cert uploaded to the CDN; renew with `scripts/renew_pvp_cert.sh`
  (expires 2027-02-23).
