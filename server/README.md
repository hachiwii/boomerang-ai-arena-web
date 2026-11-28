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
node scripts/test_replay_share.mjs
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
and its peak, and per mode (ranked-solo / ranked-ffa / team / cricket / cricket-batch / custom / training / pvp / replay)
the unique visitors plus matches started / finished. A quick restart (R / 再来一局) counts the match being left as
finished. A 排位四人 match left (R or 返回主界面) after the player is out is played out by the bots in the background
on the page, then reported as finished with every bot's result (an R restart also saves the whole match to 对局历史). PvP matches are counted once by the relay (at GO and at the end), not by the two clients.

Ranked matches played to the end also carry each bot's result, and the human player's under the id `human`
(`bots: [{b, r: w|d|l, rank, kills?, death?}]`, `src/game/botResults.ts`): per mode and id the relay keeps wins /
draws / losses, the sum and count of final places (average place), kills by cause (melee, dart, kicked into a pit)
and deaths by cause (those three, plus fell off on its own — walk or dash — and ground collapsed); the report sums
them into total kills and deaths. Malformed results are dropped (the finish still counts), and so are a match's
results when one id is not an official bot from `public/assets/chars/roster.json` (the only bots ranked picks; read when
the relay is built) or `human`, or an id repeats: a modified client can't add rows to the 全球统计 bot table. Ids
stored before this check are dropped when the relay loads today's file and skipped in past days.

`GET /public-stats` (through the CDN like the other page requests, CORS, `Cache-Control: max-age=15`, same per-IP
limit) feeds the lobby's 全球统计 panel (`src/ui/globalStatsUI.ts`) with aggregates only: online now, all-time players
(browsers that started at least one match in any mode, replays aside; their ids are kept in `<analytics
dir>/players.json`, rebuilt from the day files the first time), matches started
per public mode (ranked-solo / ranked-ffa / cricket / custom / pvp) since the first day on disk and over the current
hour so far plus the 23 whole hours before it (UTC+8, from per-hour counts), and the ranked bot tallies summed over
all days. Today's state is written to `<analytics dir>/YYYY-MM-DD.json` every minute and on
shutdown and reloaded on start. After 90 days a day file is compacted (visitor ids, per-minute online and per-hour
counts dropped) but kept, so all-time totals never go down. The analytics dir is `PVP_ANALYTICS_DIR`, else
`$STATE_DIRECTORY/analytics`, else `$PVP_STATS_DIR/analytics`. `stats-report` prints it above the latency report;
`GET /stats` (loopback) adds `onlineNow` and `visitorsToday`.

## Shared replays

The 分享 button on result screens and in replays (`src/net/replayShareClient.ts`) uploads one match with
`POST /share`: the body is text, base64url of a gzip'd JSON document (`src/game/replayShare.ts`: the match summary,
the map and every recorded tick in a delta-coded column layout, typically 3–15 KB), sent as a CORS "simple" text/plain
request through the CDN (origin key required). The relay checks it is such a document (≤ 1 MiB of text, ≤ 4 MiB
unzipped, v1 shape), stores it as `<shares dir>/<id>.txt` and answers `{"id": "<10 chars [0-9a-z]>"}`; the id is
derived from the content, so sharing the same match again gives the same link. The page shows `<page URL>?r=<id>`;
opening it fetches `GET /share/<id>` (`Cache-Control: public, max-age=86400`, the same 120-per-IP-per-minute page
limit) and plays the replay. The page re-validates and cleans everything it loads (names, colours, avatars, sizes),
since anyone can upload. Errors: 400 `{error}` for a malformed upload, 413 too large, 429 over 6 uploads per IP per
minute or 30 per hour, 503 when sharing is off or two uploads are already being checked; 404 for an unknown id.

The shares dir is `PVP_SHARES_DIR`, else `$STATE_DIRECTORY/shares`, else `$PVP_STATS_DIR/shares`; with none of them
uploads answer 503. A share is deleted when it has been neither uploaded nor viewed for `PVP_SHARES_TTL_DAYS`
(default 180; a view refreshes it at most once a day), and past `PVP_SHARES_MAX_MB` (default 512, counted in 4 KiB
disk blocks: a 1v1 share is ~3 KB = 1 block, a 4-player one 5–15 KB = 2–4, so roughly 30 000–130 000 shares) the least recently used shares are evicted
down to 90%. Checked at start, every 6 hours and when an upload would go over the cap. Nothing
about the uploader is stored or logged (the log line is `share` with the id and size). Pages built with PvP off (the
mirror) show no 分享 button and can't open share links.

## 5v5 rooms

The 团队赛 tab's online rooms use a separate WebSocket endpoint, `/team` (`server/teamRooms.ts`, messages in
`src/net/teamRoomProtocol.ts`; same origin-key check as `/ws`). The relay only keeps rooms and forwards messages —
it runs no engine. A room has a 6-digit code, up to 20 members named Alice, Bob, Carol… in join order, and one host
(the creator; when the host leaves, the earliest remaining member). The host's browser is the referee: it runs the
engine and all bots, and sends every step's 10 action lines (`frame`, ~250 bytes); the relay fans them out and the
other members replay them on their own engine (the engine is deterministic for identical actions). Members in a
seat send their inputs, which the relay passes to the host only. The host also sends the whole lobby state (lineup,
tactics, spawns, map, speed; ≤ 64 KiB), stored and given to anyone who joins; seat claims / releases go to the host.
A match in progress (its start message and every frame so far) is replayed to late joiners. After a finished match
the relay tracks the rematch: which seated players want one, and who has left the room (any leaver blocks it); the
host's `go` starts a 3-second countdown, cancelled if a player leaves. Rooms are dropped when empty; the host leaving
ends a running match for everyone. Limits: 200 rooms, 1024 connections (40 per IP), 120 messages/s per connection,
clients must report the same build id as the room's creator. The log has `team-room-created` / `team-room-closed`
with the code only.

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
