# lanes r2: one Effect proxy with lanes (2026-10-20)

Moved here from the workbox's `/tmp/lanes/design-r2.md` (2026-10-21), written by the vperf2 Root's planner. The owner accepted every recommendation in §8 ("accept all", 2026-10-20 21:04Z). r1 (`/tmp/lanes/design.md`, lanes as an admission service beside teamclaude) is superseded. lanes exists because Claude Code cannot be changed; gent takes its ideas natively ([kernel-orchestration.md](kernel-orchestration.md) P5b).

Labels: **measured**, **inferred**, **guess**. A1..A7 follow teamclaude list order. No email, token or key here.

## 1. Goal

**Done line (owner, word for word):** "a way to signal how many lanes are available, maybe some MCP tools that we can use"; "make it an effect instead of go using our effect skill, our project, scaffolding skill"; "I'd like to have one proxy server. I think Team Claude has lots of code that deals with things that we may not necessarily need"; "How do we keep these logins fresh so I don't have to re-log in all the time"; "I don't really mind when things kind of immediately stop when the usage is up".

One process, `lanes serve`, replaces teamclaude for both hosts. It pools A1..A7, forwards Claude Code traffic, keeps idle logins alive, and serves lanes over HTTP, MCP and CLI from one contract. Repo `~/Developer/personal/lanes`; build after Fri 2026-10-23.

Non-goals: Codex, API keys, backends, extra usage, holding requests, TUI, dashboard, auto-update.

**Acceptance check.** Red now (measured 20:53 UTC): `command -v lanes` exits 1; `curl -sf 127.0.0.1:3457/lanes/v1/status` exits 7. Green: (a) teamclaude is stopped on both hosts and `lanes status --json | jq '.hosts|map(.name)'` lists both with traffic; (b) after 72 h, an account with no requests shows `login: ok` and at least 9 `TokenRefreshed` events; (c) with every account spent, a request gets 429 with `retry-after` in under 1 s; (d) a session lists the `lanes_*` tools on `/lanes/mcp`; (e) at free 0 an Agent call is denied with a retry time; (f) the P1 and P3 property suites pass.

## 2. Feature cut

teamclaude `src/` is 38,643 lines, `test/` 57,531 (measured, a6e9e4f). Workbox config (measured): 7 OAuth accounts, `base-url`, threshold 0.98, `adaptive`, `expiryRouting` on, probe 120 s, `holdSeconds 1800`; the only route is the auto `fable` route.

| Feature                                                                                                                         | teamclaude file                                                                                                                     | Cut      | Reason                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Base-URL forward, SSE                                                                                                           | `server.js`                                                                                                                         | keep     | core job                                                                                                                         |
| MITM proxy, CA                                                                                                                  | `mitm.js`, `x509.js`, `forward-target.js`                                                                                           | drop     | workbox is base-url; MITM adds only hardcoded hosts (Design MCP); our MCPs are `executor,sideshow` (measured). P0 checks the Mac |
| OAuth login, paste code                                                                                                         | `oauth.js`, `login-flow.js`                                                                                                         | keep     | paste flow works over SSH                                                                                                        |
| Import Claude Code creds                                                                                                        | `index.js`                                                                                                                          | drop     | shared refresh family (#554)                                                                                                     |
| Refresh, write-back                                                                                                             | `account-manager.js:4996-5121`, `index.js:464`                                                                                      | redesign | §3.2                                                                                                                             |
| callback.net sync                                                                                                               | `credential-sync.js`                                                                                                                | drop     | one holder (§5)                                                                                                                  |
| Threshold, Fable gate `max(f7,7d)`                                                                                              | `account-manager.js`, `model.js:258`                                                                                                | keep     | in use; #175                                                                                                                     |
| Routes, conversation pins, `TC_ACCT`                                                                                            | `model.js`, `conversation.js`, `session-pins.js`                                                                                    | keep     | auto fable route; prompt cache; pin as `/acct/<label>`                                                                           |
| Adaptive, expiry pressure, preempt                                                                                              | `adaptive-distribution.js`, `band-decision.js`, `rollover.js`                                                                       | merge    | one policy (§3.3); AIMD later                                                                                                    |
| Even/load modes, `switch`                                                                                                       | `account-manager.js`                                                                                                                | drop     | policy decides                                                                                                                   |
| Quota headers, probe                                                                                                            | `account-manager.js`, `prober.js`                                                                                                   | keep     | idle quota, Fable, liveness                                                                                                      |
| Two kinds of 429, one hop                                                                                                       | `server.js`                                                                                                                         | simplify | §3.4                                                                                                                             |
| `holdSeconds`                                                                                                                   | `server.js`                                                                                                                         | drop     | owner: stop at once                                                                                                              |
| account_uuid rewrite                                                                                                            | `account-uuid-rewrite.js`                                                                                                           | keep     | body must match token                                                                                                            |
| Storm ramp, tool-pair sanitizer, outside spend                                                                                  | `admission-gate.js`, `tool-pair-sanitize.js`, `outside-spend.js`                                                                    | later    | lanes caps load; count 400s first; only claude.ai spend stays outside                                                            |
| Caps, extra usage, banked resets, keep-warm, Codex, API keys, backends, egress proxies, sx.org, TUI, dashboard, titles, updater | `claude-resets.js`, `warmer.js`, `codex-*.js`, `backend-quota.js`, `sx.js`, `egress-guard.js`, `tui.js`, `dashboard.js` and 10 more | drop     | unused or bills money                                                                                                            |
| MCP account control, forecast                                                                                                   | `mcp-tools.js`, `forecast.js`                                                                                                       | replace  | lanes tools, same server                                                                                                         |
| Status, client keys, `run`                                                                                                      | `server.js:608`, `client-usage.js`, `claude-env.js`                                                                                 | keep     | one contract; key names host                                                                                                     |

**Size (guess):** 4,500 source and 3,500 test lines, 12% of teamclaude's source.

## 3. Proxy core

Pins (measured, npm): `effect` and `@effect/{platform-bun,sql-sqlite-bun,vitest}` 4.0.5, exact. Modules are top level (`effect/http`, `effect/ai`, `effect/cli`).

### 3.1 Forwarding

- Base-URL mode only. One `HttpRouter`: `/lanes/v1/*` control, `/lanes/mcp`, `/acct/<label>/*` pinned, all else forwarded to `https://api.anthropic.com`.
- The body is buffered. A Schema decodes only `model` and `metadata.user_id`. The 36-byte `account_uuid` in `user_id` is patched in place. Property: all other bytes go out unchanged.
- Headers: drop client auth, hop-by-hop and the host key; set `Bearer <account token>`; pass `anthropic-beta` and `x-claude-code-*`.
- `HttpClientResponse.stream` into `HttpServerResponse.stream`, unbuffered; client disconnect interrupts the upstream fiber.
- Capture `anthropic-ratelimit-unified-{5h,7d,7d_oi}-{utilization,reset,status}`. The Fable bucket comes from the probe (`oauth.js:637`).

### 3.2 Logins that stay fresh

**Cause (measured).** teamclaude #564 (closed 2026-10-20, affects 1.1.25): an account added by `teamclaude login` while the server runs gets two ids, `findConfigAccount` finds no row, and each refreshed token is dropped silently. A refresh rotates the refresh token (`oauth.js:263`), so the file keeps a dead token and the restart gets `invalid_grant` (journal 20:46:30, 20:49:52, A3–A6). A3–A7 are `source: login`; A1, A2 (`import`) saved normally; the file holds A3, A4 tokens that expired 10-13. The Mac matches (inferred). An idle-lifetime limit is unknown (guess: weeks). Second risk: two holders of one refresh family rotate it twice (#554).

Design:

- **One writer.** Only `lanes serve` writes tokens (SQLite `$XDG_STATE_HOME/lanes/lanes.db`, 0600, one row per label). The CLI logs in through the server API.
- **Persist before use.** The new pair is written in one compare-and-set transaction before any request uses it. A failed write exits; systemd restarts.
- **Scheduled refresh.** A fiber per account refreshes at `expiresAt − 60 min` with jitter, traffic or not. Tokens last 8 h (inferred from expiry gaps): about 3 refreshes a day.
- **Single flight.** One `Effect.cached` refresh per account. A 401 within 2 min of a refresh retries on the current token (`account-manager.js:5017`).
- **Detect at once.** A 400/401/403 from the token endpoint, or two probe 401s after a refresh, sets `NeedsLogin{since, reason}`, drops the account from selection, emits `LoginLost`, runs the alert (Q2) and shows `login! A3` in `--line`.
- **One command.** `lanes login A3` prints a PKCE URL and reads the pasted code, over SSH or from the Mac. The server refuses a profile that is not A3's UUID. `lanes login --new` adds one.
- **Client login.** Base-URL Claude Code needs its own valid login (#395). Use `claude setup-token` into `CLAUDE_CODE_OAUTH_TOKEN` per host (both in the 2.1.300 binary, measured).

### 3.3 Account selection

Pure `select(snapshot, request) → Decision` in `core`. Eligible: `login ok`, enabled, `u5h < T`, `max(u7d, u7d[family]) < T`, not cooling, allowed by the first matching route; `T = 0.98`.

1. An explicit pin uses that account or fails; it never fails over.
2. A conversation (session id plus opening digest, as `conversation.js`) keeps its pin per weekly bucket while eligible. A weekly rollover moves it (`preempt`).
3. A new conversation goes to the top pressure band (`headroom / time to reset`, within 1.5× of the best); in it, least headroom wins. An account with under 30 min of burn left takes no new conversations. Ties: fewest active.

Properties: never an ineligible account; a pin holds while eligible; more headroom never lowers rank at equal reset.

### 3.4 Failures, no hold

- 429 with a window `rejected`: mark the bucket, retry once elsewhere before any client byte.
- 429 rate limit: cool the account, one hop to an idle sibling, else relay. Headerless 429: relay. 5xx/529: one hop, else relay.
- 401 on our token: single-flight refresh, retry once.
- No eligible account: 429 `rate_limit_error` at once, `retry-after` = soonest reset.

## 4. Lanes in the same process

r1 §3 stays: `capacity(a,m) = min(l5, l7)` with `max(τ, D)`, `free = floor(capacity − load)`, host shares, leases keyed `host/sessionId/toolUseId`, TTL 20 min, reaper 30 s. Changes:

- **Quota is the in-process pool snapshot.** No teamclaude adapter, no drift. Before the first probe, capacity is `fallbackCap` (8).
- **Load is observed:** `max(leased weight, agents seen in 2 min)` by `x-claude-code-agent-id` (in the 2.1.300 binary, measured; P0 checks it reaches `/v1/messages`). Hookless hosts count.
- **Heartbeat from traffic.** Hooks left: `PreToolUse Agent` (acquire or deny), `PostToolUse Agent` (bind id), `SubagentStop`, `SessionEnd`; HTTP hooks to `/lanes/v1/hooks/claude`, fail open.
- **Host from the key.** Loopback is the workbox; a remote key names its host.
- **No hold.** At free 0, acquire gives `LaneUnavailable{retryAt, free, reason}`: HTTP 429 + `Retry-After`, MCP tool error, CLI exit 3.

| Capability            | MCP tool           | HTTP (`/lanes/v1`)    | CLI                             |
| --------------------- | ------------------ | --------------------- | ------------------------------- |
| status (pool + lanes) | `lanes_status`     | `GET /status`         | `lanes status [--json\|--line]` |
| forecast              | `lanes_forecast`   | `GET /forecast`       | `lanes forecast`                |
| leases                | `lanes_leases`     | `GET /leases`         | `lanes leases`                  |
| acquire               | `lanes_acquire`    | `POST /leases`        | `lanes acquire`                 |
| release               | `lanes_release`    | `DELETE /leases/{id}` | `lanes release`                 |
| policy                | `lanes_set_policy` | `PUT /policy`         | `lanes policy set`              |

Status: `{free, capacity, load, hosts[], accounts[{label, tier, login, u5h, u7d, u7dFable, resets, lanes}], policy}`, labels only. `GET /lanes/v1/events` is SSE (lease, lane, pool, `TokenRefreshed`, `LoginLost` events) for `lanes watch` and `lanes wait`. Login is HTTP and CLI only.

**MCP on the proxy's router.** `McpServer.layerHttp({ name, version, path: "/lanes/mcp", protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18] })` (`effect/src/ai/McpServer.ts:1649`, 4.0.5) requires `HttpRouter.HttpRouter`, so it mounts beside the forwarder: one port, one process. Tools: `Tool.make`, `Toolkit`, `McpServer.toolkit` (`:2212`). Only `to-*.ts` import projection APIs (lint rule).

Layout: `packages/{core,server,cli}`; `core` imports only `effect`. `bun build --compile` makes one `lanes` binary.

## 5. One proxy for both hosts

**Decision: one server on the workbox; the Mac reaches it over Tailscale.**

- One holder per grant ends dual refresh (#554) and the outside-spend blind spot (37% on A1, r1). Two servers need replicated tokens, quota and leases.
- Workbox uptime 46 days; Mac to workbox is a direct tailnet path at 130 ms (measured, 1 ping; P6 takes 20). Turns take seconds (inferred: small cost).
- Bind `127.0.0.1:3457` and the tailnet address only. Loopback needs no key; the Mac sends `x-lanes-key` by `ANTHROPIC_CUSTOM_HEADERS` (in the binary, measured), so subscription mode stays.

**Unreachable:** Mac sessions stop at once (owner accepts). `lanes run` checks `/lanes/v1/health` (1 s) and prints `pool unreachable; lanes run --direct uses this Mac's login`. Hooks fail open. The workbox is not affected.

## 6. Migration

1. **Import.** `lanes import teamclaude` copies labels in order, UUIDs, tier, threshold, routes, probe interval. Never tokens (#554).
2. **Side by side.** On the workbox, `lanes serve` on 3457 beside teamclaude on 3456; `lanes login A1`…`A7` makes new grants. One session uses 3457 for 3 days; compare 429s and sanitizer-class 400s.
3. **Cutover per host.** Workbox: `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` to 3457, shim `dotfiles/claude/bin/claude` to `lanes run`, `systemctl --user disable --now teamclaude`. Mac: tailnet URL plus key header, same shim, unload the launchd agent. Keep teamclaude configs and units.
4. **Rollback per host.** Revert the settings line and shim; start teamclaude. Its idle grants can go stale (guess) and need `teamclaude login`. Remove teamclaude 14 days after cutover.

## 7. Build plan

| Unit         | Scope                                                                                                                                                         | Depends on | Acceptance check                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 pilot** | scaffold; token store; `lanes login`; scheduled refresh, single flight, write-back; forward (token swap, uuid patch, stream); header capture; header-name log | none       | `bun run gate` exit 0. TestClock: idle refresh at `expiresAt − 60 min`; 50 concurrent 401s, 1 token call; restart after refresh uses the new token; `invalid_grant` gives `LoginLost` in 1 s. SSE fixture: bytes out = bytes in. Live: a tool turn on A7 via 3457; log shows `x-claude-code-agent-id` and the setup-token result |
| P1           | `select()`, pins, routes, Fable gate, band, taper, §3.4                                                                                                       | P0         | §3.3 properties over generated snapshots; a spent-window 429 replay retries elsewhere with no client byte                                                                                                                                                                                                                        |
| P2           | probe, status contract, HttpApi, SSE, `--line`, alert, systemd unit                                                                                           | P1         | live status shows A1..A7 equal to the probe; a fake `invalid_grant` runs the alert once                                                                                                                                                                                                                                          |
| P3           | leases, capacity, reaper, traffic heartbeat                                                                                                                   | P2         | r1 L1, L2 properties; N acquires at capacity k grant min(N,k); traffic renews a lease                                                                                                                                                                                                                                            |
| P4           | hook ingress, `install-hooks`                                                                                                                                 | P3         | recorded payloads replay; live deny at free 0, release at SubagentStop                                                                                                                                                                                                                                                           |
| P5           | MCP `/lanes/mcp`                                                                                                                                              | P3         | a session lists six tools; `lanes_status` answers                                                                                                                                                                                                                                                                                |
| P6           | tailnet bind, host keys, `lanes run`, remote login                                                                                                            | P2         | Mac status equals workbox; 20 pings (median, range); `lanes login A3` from the Mac                                                                                                                                                                                                                                               |
| P7           | import, cutover and rollback scripts                                                                                                                          | P1, P6     | import output has no token field; cutover and rollback run twice on the workbox                                                                                                                                                                                                                                                  |
| P8           | forecast, orchestrate skill (r1 L7, L8)                                                                                                                       | P3, P4     | r1 L7, L8 checks                                                                                                                                                                                                                                                                                                                 |

**Pilot P0** proves the riskiest parts first: byte-exact streaming, logins that survive a restart.

## 8. Risks and owner questions

Risks (reviewer: attack 1–3 hardest):

1. OAuth endpoints and client id are undocumented (`oauth.js:133-146`). One module, contract test on recorded payloads.
2. The uuid patch and headers must not change cache keys. P0 diffs bytes.
3. Hook and header semantics come from binary strings. P0, P4 record first.
4. Side by side adds a third grant per account; a limit is unknown (two works, measured). P0 uses A7 only.
5. Loopback trust assumes a single-user workbox (inferred). The workbox is the Mac's single point of failure; `--direct` is the escape.

Owner questions (recommendation first):

- **Q1, now:** stop teamclaude on the workbox, `teamclaude login` A3–A6, start it (the #564 workaround). Yes, workbox only.
- **Q2:** `LoginLost` alert channel. The status line plus `alerts.command` to a private ntfy topic.
- **Q3:** name. Private `cevr/lanes`, binary `lanes`.
- **Q4:** remove teamclaude 14 days after cutover. Yes.

Follow-up F1: fix the 4.0.5 module paths in the `effect` and `project-scaffolding` skills.

## Amendment r3: the fuel gauge (owner, 2026-10-20)

Owner ask, word for word: "I want to have like a token per usage percent, kind of like a fuel engine ... I want to know exactly what the usage percentage is per token at the at currently to kind of strive how many lanes and agents available we have". The rate drifts ("usage has gone down since a couple weeks ago"), so the gauge keeps a running tally.

**Unit: fuel.** One token class does not cost what another does: in one A7 sample, cache reads were 43.5 M and output 0.24 M (measured). So the gauge counts **fuel**: tokens weighted by class and model. The start weights are the relative API list prices (input 1, cache write 1.25, cache read 0.1, output 5, times the model's price ratio; inferred from public pricing). The weights are then learned (below). Each quota window gets its own rate: `5h`, `7d`, `7dSonnet`, `7dFable`.

**Measure.** The proxy sees each response's `usage` (exact, per request and model) and the utilization headers. The headers move in 1% steps (measured: 0.42, 0.67). A **segment** is the fuel between two readings of one window on one account in one reset epoch. A drop (reset) or a gap over 15 min closes a segment and opens a new one.

- Rate per account and window: `fuelPerPct = Σ fuel / Σ Δu` over the segments in a rolling window, with an EWMA half-life of 24 active hours. Report it with a band from the 1% quantization (`±0.5 / Σ Δu`).
- Learned weights: non-negative least squares of `Δu` on the per-class fuel of each segment, pulled toward the price prior (ridge). Refit hourly once 50 segments exist. Before that, use the prior weights.
- **Outside spend.** Usage that does not pass the proxy (the claude.ai app, a host not on the proxy) moves `u` with no fuel. The fit flags a segment whose residual is above 3 band widths as `outside`, and drops it from the rate. Status shows the account's outside share.

**Running tally.** SQLite, append-only: `fuel_requests(ts, account, window, model, input, output, cacheRead, cacheWrite)`, `fuel_readings(ts, account, window, u, resetAt)`, and a daily rollup `fuel_daily(day, account, window, fuelPerPct, band, segments, outsideShare)`. The rollup answers "has usage gone down": `lanes fuel --history 30d` prints one row a day per window.

**Lanes from fuel.** For each agent role (planner, implementor, reviewer, verifier; from the lease, else `x-claude-code-agent-id`), the proxy measures fuel per active hour (EWMA). Per window `w` and the active accounts:

- `remainingFuel_w = Σ (1 − u_w) × 100 × fuelPerPct_w`
- `sustainable_w(role) = remainingFuel_w / (fuelPerHour(role) × hoursUntilReset_w)`
- `lanes = floor(min over w of sustainable_w)` for the planned role mix. This replaces the guessed burn `D` in §4's `capacity`; §4's `l5` and `l7` become `sustainable_5h` and `sustainable_7d`.

**Surfaces.** MCP tool `lanes_fuel` and `GET /lanes/v1/fuel`: `{windows[{name, fuelPerPct, band, trend7d, remainingFuel, hoursUntilReset}], roles[{role, fuelPerHour}], lanes, outsideShare}`. CLI `lanes fuel [--json] [--history 30d]`. `lanes status --line` adds the 7d rate and the lane count.

**Build.** A new unit P9 after P3: the fuel tables, the segment builder, the rate, the weight fit, the role burn and the surfaces. Acceptance: (1) a property over generated reading and request streams (resets, gaps, flat stretches, 1% quantization, mixed models) shows that the rate recovers the generator's true weights within the band; (2) a replay of the bridge log below gives the same `fuelPerPct` as the bridge script; (3) a live run on A7 for 2 h gives a 7d band no wider than ±10%.

**Bridge until lanes ships (running now).** A systemd user timer `lanes-fuel-sample.timer` runs `~/.local/share/lanes-fuel/sample.sh` each minute on the workbox. It appends to `~/.local/share/lanes-fuel/samples.jsonl` each account's windows and teamclaude's cumulative token counters, keyed by config position (no emails). Limits: teamclaude counts input and output per account, not per model, and its counters restart at 0 with the server. The timer is transient: a reboot stops it. Stop: `systemctl --user stop lanes-fuel-sample.timer`.

### First bridge reading (2026-10-20 22:34–23:00Z, A7, about 5 agents plus Root; measured)

| Window                                                                                                                                                                                                                                                                                                                                                                            | Moved | Fuel per 1% | Band | Per 1%: output / cache read / cache write / input |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- | ---- | ------------------------------------------------- |
| 5h                                                                                                                                                                                                                                                                                                                                                                                | 20%   | 0.38 M      | ±5%  | 0.02 M / 1.95 M / 0.08 M / 0.01 M                 |
| 7d                                                                                                                                                                                                                                                                                                                                                                                | 6%    | 1.23 M      | ±17% | 0.05 M / 6.35 M / 0.25 M / 0.02 M                 |
| Derived (inferred): a full 5h window is 38 M fuel, 31% of the 123 M weekly. The fleet burned about 17 M fuel/h, about 3.4 M per agent-hour. Seven accounts give about 860 M fuel a week, about 250 agent-hours: 1.5 agents around the clock, or 6 agents for about 42 h. Cache reads are half the fuel at the prior weight 0.1, so the learned weight decides most of the answer. |
