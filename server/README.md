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

Copy `server/dist/relay.mjs`, `server/dist/stats-report.mjs`, `server/package.json`, and `server/package-lock.json` into
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

## Latency stats

Every finished match appends one JSON line to a daily file, `<stats dir>/YYYY-MM-DD.jsonl` (kept 90 days). The stats
dir is `PVP_STATS_DIR`, or `$STATE_DIRECTORY/stats` under systemd (`StateDirectory=boomerang-pvp` →
`/var/lib/boomerang-pvp/stats`). With neither set, nothing is recorded and the IP database is not loaded.

A line holds the match (map, start/end, end reason, frames played, chosen input delay, rematch) and, per seat:
RTT median / p95 / max / jitter over the match (the value the delay choice uses), relay neutral fills while
connected, inputs dropped as late, the latest accepted input vs its deadline, reconnects, a coarse client class
(desktop / android / ios / wechat / qq / harmony / other) and the region (country; province and ISP in mainland
China). **IP addresses and User-Agents are never written or logged** — only these derived values.

Read it on the box with `node /opt/boomerang-pvp/dist/stats-report.mjs [--days N] [--json]`, from a dev machine with
`scripts/pvp_stats.sh [days]`, or as JSON from loopback `GET /stats?days=N` (404 for any non-loopback client, also
through the CDN).

IP → region uses the bundled data of the [ip2region](https://www.npmjs.com/package/ip2region) npm package (IPv4 + IPv6,
data from lionsoul2014/ip2region, Apache-2.0 OR MIT). It loads asynchronously at start (~110 MB resident); update it
by bumping the package version.

## Site analytics

Game pages (`src/net/analytics.ts`) send `POST /beat` every minute while visible (and `{leave:true}` when hidden or
closed) and `POST /event` `{kind: start|end, mode}` when a match, replay or cricket batch starts / finishes. Both
are CORS "simple" text/plain JSON requests through the CDN (origin key required), limited to 120 per IP per
minute. The only identity is a random id the browser generated (`localStorage['boomerang-visitor-id']`); IPs are
not stored. Pages built with PvP off (the mirror) send nothing.

The relay keeps: online visitors (heartbeat within 2.5 min), per day (UTC+8) the UV, the per-minute online count
and its peak, and per mode (ranked-solo / ranked-ffa / cricket / cricket-batch / custom / training / pvp / replay)
the unique visitors plus matches started / finished. A quick restart (R / 再来一局) counts the match being left as
finished. PvP matches are counted once by the relay (at GO and at the end), not by the two clients.

Ranked matches played to the end also carry each bot's result (`bots: [{b: botId, r: w|d|l, kills?, death?}]`,
`src/game/botResults.ts`): per mode and bot the relay keeps wins / draws / losses, kills by cause (melee, dart, kicked
into a pit) and deaths by cause (those three, plus fell off on its own — walk or dash — and ground collapsed); the
report sums them into total kills and deaths. Malformed results are dropped (the finish still counts); at most 64 bot
ids per mode and day.

`GET /public-stats` (through the CDN like the other page requests, CORS, `Cache-Control: max-age=15`, same per-IP
limit) feeds the lobby's 全球统计 panel (`src/ui/globalStatsUI.ts`) with aggregates only: online now, matches started
per public mode (ranked-solo / ranked-ffa / cricket / custom / pvp) since the first day on disk and over the current
hour so far plus the 23 whole hours before it (UTC+8, from per-hour counts), and the ranked bot tallies summed over
all days. Today's state is written to `<analytics dir>/YYYY-MM-DD.json` every minute and on
shutdown and reloaded on start. After 90 days a day file is compacted (visitor ids, per-minute online and per-hour
counts dropped) but kept, so all-time totals never go down. The analytics dir is `PVP_ANALYTICS_DIR`, else
`$STATE_DIRECTORY/analytics`, else `$PVP_STATS_DIR/analytics`. `stats-report` prints it above the latency report;
`GET /stats` (loopback) adds `onlineNow` and `visitorsToday`.

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
