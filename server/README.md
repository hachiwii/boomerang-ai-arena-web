# Boomerang PvP relay

From the repository root, use Node.js 22 or newer.

```sh
npm ci --prefix server
npm run build --prefix server
npm start --prefix server
```

The bind settings are `HOST` (default `0.0.0.0`) and `PORT` (default `8787`).
The health probe is `GET /healthz` and the WebSocket path is `/ws`.
The development frontend on localhost uses `ws://<host>:8787/ws`. Set the frontend build variable
`VITE_PVP_URL` when the relay is elsewhere. Without it the frontend connects to ws(s)://<page host>:8787/ws; PvP is on
unless the build sets `VITE_PVP_ENABLED=0` (see `.env.example`).
Play with two browser profiles to obtain two independent lobby tokens.

Run the network and engine tests from the repository root after building the
relay bundle.

```sh
node scripts/test_pvp_engine.mjs
node scripts/test_pvp_relay.mjs
```

Rebuild only the checked-in game engine with `python3 scripts/build_wasm.py --engine-only`
and `em++` on `PATH`.

## Origin artifacts

Copy `server/dist/relay.mjs`, `server/package.json`, and `server/package-lock.json` into
`/opt/boomerang-pvp`, preserving the `dist/` directory. Run `npm ci --omit=dev` in
that directory. The bundle includes the standard map list and protocol constants.
The runtime dependency is `ws`.

Install `deploy/boomerang-pvp.service` under `/etc/systemd/system/` and create a
local unprivileged system user and group named `boomerang-pvp`. The unit uses
`/usr/bin/node`, loads `/etc/boomerang-pvp.env` if present, and logs JSON to stdout.
Set `PVP_ORIGIN_KEY` in that file to the value the CDN sends in `x-pvp-origin-key`.
When configured, the key is required for every request except loopback `GET /healthz`.
The relay uses `ali-cdn-real-ip`, the first `x-forwarded-for` entry, or the
socket address for IP rate limits. The origin should accept traffic only from
the CDN or a trusted reverse proxy that controls those headers.

Lobby reservations and running matches live in one relay process. A process
restart clears them. Put both players on the same origin instance.

## Protocol

WebSocket messages are small JSON objects. Clients claim their reservation in
`hello`, report visible lobby presence, and use `ping` / `pong` for RTT and clock
offset. A successful challenge pairs clients with the same build ID on a
standard map. Both clients send `ready`; the relay then sends `go` with a server
epoch time and a shared input delay.

The first valid input for each seat and frame becomes canonical. The relay
broadcasts accepted input to both seats. After the 125 ms grace window it fills
missing inputs with zero movement and no action. The match engine applies
walking cliff protection to each input as it simulates that frame. Reconnects
replay the bounded match input log. After 10 seconds gone or a quit, the relay
closes the match with a forfeit, a cause, and a canonical cutoff frame. It
compares periodic confirmed hashes and both confirmed end reports.

Clients send their `mapPool` and challenge by code. The relay selects the
map from the challenged player's valid pool and draws the seeds. An empty
pool includes every standard and large map. At the result screen, both players
can request another round in the same seats or leave. A disconnect counts as
leaving. The relay marks undecided players as left after three minutes.
`PVP_REMATCH_TIMEOUT_MS` can shorten that window for local testing.
