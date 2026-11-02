# Lanes peer

With a peer link (`pool.peer`: a server on another machine that spends from the same accounts), the last lanes row in `/status` is the peer. The band under the status row shows it only while the peer changes what this server does: the peer fell silent while its last runs still count (`· <n> runs held`: the server keeps to half the pace), or a link went down while the peer was heard inside the 30-minute hold. A live peer's runs, an idle peer, a link that never brought a line and a peer silent past the hold are `/status` only. The rows: `⇄ peer <host> <n> runs · <age>` while its lines come (its runs on this server's accounts, the age of its last line), `⇄ peer <host> unread <age>` after 90 s with no line (`· <n> runs held` while its last runs still count), and `⇄ peer unread` before its first line. A link that brought no line for 90 s marks the row `peer!` and names it: `· own link down` (this server's `pool.peer` command), `· peer link down` (the peer's, once it was heard), `· links down`. A narrow row keeps the facts in rank: the held runs, the link down, the age, then the host. The row goes 30 minutes after the peer turned silent when this server runs no `pool.peer` command of its own. `gent ctl lanes` holds `peer`, and `--line` prints the row last.

## Sub-features

- `peer-at-rest`: no band; in `/status`, `⇄ peer <host> 0 runs · 29s` under the provider's row; the age climbs to about 60 s between two band reads.
- `peer-run`: no band; `/status` shows `⇄ peer <host> 1 run · 0s` while the peer runs one on a shared account, under the provider's row `0/1 free · 1 running` (a full lane is not a refusal or a wait, so it is `/status` only too).
- `peer-link-down`: about 2 minutes after the peer stops, the band shows `⇄ peer! <host> unread 2m · peer link down`, until 30 minutes after the peer turned silent.
- `peer-held`: a peer stopped during a run reads `⇄ peer! <host> unread 1m · 1 run held · peer link down` on the band, and A's provider row in `/status` keeps `1 running`.
- `peer-forgotten`: 30 minutes after the peer turned silent (31.5 minutes after its last line), the row leaves the band. It goes from A, which runs no `pool.peer` command, and `gent ctl lanes` has no `peer`; a server with its own command keeps `⇄ peer! <host> unread <age> · …` in `/status` only.
- `own-link-down`: a `pool.peer` command that prints nothing reads `⇄ peer unread`, then `⇄ peer! unread · own link down` at 90 s, in `/status` only (the peer was never heard, so it changes nothing).
- `peer-narrow`: with a 21-letter host, `/status` at 26 columns shows the row with runs as `⇄ peer 1 run · 6s` (the host goes, the age stays). The held row on the band is `⇄ peer! unread 1m · 1 run held · peer link down` at 60 and 50, `⇄ peer! unread 1m · 1 run held` at 44 and 34, and `⇄ peer! unread 1m` at 26.
- `ctl-peer`: `gent ctl lanes` holds `peer` (`heard` with `host` and `at`, `runs`, `silent`, `down`, `counted`: the peer's facts still count inside the hold); `--line` prints the row text last.

## How to get to it (user POV)

- Set `pool.peer` in `~/.gent/config.json` on one machine (`apps/tui/docs/cli.md`, `pool --follow`), and restart its server. The row shows in `/status` on both machines (`down` to the end of the list), and on the band by itself while it changes what the server does.

## Driving it

- **Preconditions:** two servers, and the peer goes in a config before its server starts: `verify:launch` writes the config and starts at once, and a `pool.peer` added while a server runs takes a restart.
- **States:** default (heard), loading (`peer unread` before the first line), error (`peer!`, a link down). Empty is no peer: no row. Focus and open are `n/a`.
- **Regression:** `apps/tui/tests/extensions/machines.client.test.tsx` (the peer row), `packages/core/tests/runtime/provider.test.ts` (`the peer`), `packages/core/tests/server/rpc.test.ts` (`notePeer`), `apps/tui/tests/ctl.test.ts` (`pool`).

Recipe (one Mac, three servers; 2026-11-01):

1. Launch run A with the ledger ([lanes.md](lanes.md), `band-measured`).
2. Make `<b>` as for `band-login-lost` in [lanes.md](lanes.md): `<b>/bin/gent` is `$RUN/bin/gent` with every `$RUN` path changed to `<b>`, a copy of `$RUN/auth`, a fresh ledger in `<b>/data`, and `<b>/home/.gent/config.json` with `"pool": {"peer": ["$RUN/bin/gent", "ctl", "pool", "--follow"]}`. A's wrapper sets A's env, so the link reaches A with no ssh.
3. Start `<b>/bin/gent server start --mock --port 0` in `<b>/work` and record its PID. Write `<b>/run.json` with `dir`, `work`, `gent`, `url`, `serverPid`, `supervisorPid` and `env` changed: `verify:drive --dir <b>` then drives B. Its doctor fails on the supervisor check. Both servers read the same hostname.
4. Drive A: `send /status`, `keys enter`, `waitFor more ↓`, `settle`, twelve `down`, `waitFor peer <host> 0 runs`, `cap`. For a run on B, loop `<b>/bin/gent -H "debug threads"` from `<b>/work` outside the drive (an `sh` step stops what it leaves in the background), and keep the pane open: a live peer's runs are not on the band. The lanes read every 30 s, so a `waitFor` of `peer <host> [1-9]\d* runs?` needs up to 95 s. Resize to 60, 44 and 26 columns, then back, and `keys esc`.
5. Stop B with `kill -TERM <pid>` and `waitFor peer! <host> unread` for up to 160 s (90 s of silence, then the next read).
6. For `peer-held`, stop the run loop and B in one `sh` step just after `waitFor peer <host> [1-9]\d* runs?` matches, and `waitFor` `peer! <host> unread \S+ · [1-9]\d* runs? held · peer link down`. For `peer-forgotten`, then `waitFor` `^(?![\s\S]*⇄)[\s\S]*Claude Sonnet 5` for up to 2,200,000 ms, and open `/status` to see the row gone there too.
7. For `own-link-down`, a third server `<c>` the same way with `"peer": ["sh", "-c", "exec cat > /dev/null"]`, driven with `--dir <c>`: open `/status` and `down` to the end, as the row never reaches the band.
8. Stop each server by its PID, then `verify:stop --remove` A.

## Gotchas

- A peer run of a few seconds can fall between two band reads (every 30 s, at a turn's end, at a reconnect). One `gent -H "debug threads"` on B ended before a band read showed a run (2026-11-01): use the loop. `debug threads` on B with capacity 1 queues its threads, so B holds one run for minutes after a loop.
- Stop the run loop before B: a headless `gent` on B that finds no server can start one, and that server links to A again. Count the `ready on` lines in B's `server.log` after the stop.
- A silent peer's last runs still count for 30 minutes, so A's provider row keeps `1 running` after B stops.
- `PoolFacts.host` is required: a peer on an older build fails its link at decode.
- The idle and the live peer rows are on `/status` only: a `waitFor peer <host> \d+ runs?` on the bare screen never matches.
- The recipe last ran on 2026-11-01, before the band kept the peer row only while it acts on the server. The band rule is pinned by `apps/tui/tests/extensions/machines.client.test.tsx` (`the peer row shows on the band only while`) and `packages/core/tests/runtime/provider.test.ts` (`the peer`, its `counted` field).
