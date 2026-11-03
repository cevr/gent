# Lanes peer

With a peer link (`link.machines`: a server on another machine that spends from the same accounts), the last lanes row in `/status` is the peer. The band under the status row shows it only while the peer changes what this server does: the peer fell silent while its last runs still count (`· <n> runs held`: the server keeps to half the pace), or a link went down while the peer was heard inside the 30-minute hold. A live peer's runs, an idle peer, a link that never brought a line and a peer silent past the hold are `/status` only. The rows: `⇄ peer <host> <n> runs · <age>` while its lines come (its runs on this server's accounts, the age of its last line), `⇄ peer <host> unread <age>` after 90 s with no line (`· <n> runs held` while its last runs still count), and `⇄ peer unread` before its first line. A link that brought no line for 90 s marks the row `peer!` and names it: `· own link down` (this server's link), `· peer link down` (the peer's, once it was heard), `· links down`. While this server links to the peer, the host is the link's machine name and its state replaces the link down: `· silent` (no frame for 90 s), `· incompatible` (another build's RPC contract). A narrow row keeps the facts in rank: the held runs, the link down, the age, then the host. The row goes 30 minutes after the peer turned silent when this server runs no link of its own. `gent ctl lanes` holds `peer`, and `--line` prints the row last.

## Sub-features

- `peer-at-rest`: no band; in `/status`, `⇄ peer <host> 0 runs · 29s` under the provider's row; the age climbs to about 60 s between two band reads.
- `peer-run`: no band; `/status` shows `⇄ peer <host> 1 run · 0s` while the peer runs one on a shared account, under the provider's row `0/1 free · 1 running` (a full lane is not a refusal or a wait, so it is `/status` only too).
- `peer-link-down`: about 2 minutes after the peer stops, the band shows `⇄ peer! <host> unread 2m · peer link down`, until 30 minutes after the peer turned silent.
- `peer-held`: a peer stopped during a run reads `⇄ peer! <host> unread 1m · 1 run held · peer link down` on the band, and A's provider row in `/status` keeps `1 running`.
- `peer-forgotten`: 30 minutes after the peer turned silent (31.5 minutes after its last line), the row leaves the band. It goes from a server that runs no link, and `gent ctl lanes` has no `peer`; a server with its own command keeps `⇄ peer! <host> unread <age> · …` in `/status` only.
- `link-silent`: a link whose command prints nothing reads `⇄ peer <machine> unread`, then `⇄ peer! <machine> unread · silent` at 90 s, in `/status` only (the peer was never heard, so it changes nothing).
- `link-incompatible`: a peer on another build reads `⇄ peer! <machine> unread · incompatible`; `gent ctl link` relays, and only `link.hello` runs.
- `peer-narrow`: with a 21-letter host, `/status` at 26 columns shows the row with runs as `⇄ peer 1 run · 6s` (the host goes, the age stays). The held row on the band is `⇄ peer! unread 1m · 1 run held · peer link down` at 60 and 50, `⇄ peer! unread 1m · 1 run held` at 44 and 34, and `⇄ peer! unread 1m` at 26.
- `ctl-peer`: `gent ctl lanes` holds `peer` (`heard` with `host` and `at`, `runs`, `silent`, `down`, `counted`: the peer's facts still count inside the hold, `link` with `machine` and `state`); `--line` prints the row text last.

## How to get to it (user POV)

- Set `link.machines` in `~/.gent/config.json` (`apps/tui/docs/cli.md`, `link`), the same file on both machines, and restart each server. The row shows in `/status` on both machines (`down` to the end of the list), and on the band by itself while it changes what the server does.

## Driving it

- **Preconditions:** two runs launched with `--link` naming each other: `verify:launch` writes `link.machines` before the server starts, and a machine added while a server runs takes a restart.
- **States:** default (heard), loading (`peer unread` before the first line), error (`peer!`, a link down). Empty is no peer: no row. Focus and open are `n/a`.
- **Regression:** `apps/tui/tests/extensions/machines.client.test.tsx` (the peer row), `packages/core/tests/runtime/provider.test.ts` (`the peer`), `packages/core/tests/server/rpc.test.ts` (`notePeer`), `packages/core/tests/server/link.test.ts` (the link states; `generated sequences`: 150 seeded sequences against a reference model of the states, the waits and the hello, with the far end's bytes cut anywhere and parts of frames that only a whole frame ends), `apps/tui/tests/ctl.test.ts` (`pool`, `link`), `apps/tui/integration/link.test.ts` (two servers).

Recipe (one Mac, two runs; 2026-11-02):

1. `bun run --silent verify:launch --dir <scratch>/A --link <scratch>/B [--data <ledger>]`, then `bun run --silent verify:launch --dir <scratch>/B --link <scratch>/A`. Each config names `A` and `B` with their wrappers' `gent ctl link`, and each server links to the other with no ssh. A starts first, so its link to B fails and waits until B answers (1 s, then 2 s, 4 s).
2. A's view: `<scratch>/A/bin/gent ctl lanes --line` prints `peer B <n> runs · <age>` last, once the link connects.
3. For a run on B, loop `<scratch>/B/bin/gent -H "debug threads"` from `<scratch>/B/work`. Drive A: `send /status`, `keys enter`, `waitFor more ↓`, `settle`, twelve `down`, `waitFor peer B 0 runs`, `cap`. The lanes read every 30 s, so a `waitFor` of `peer B [1-9]\d* runs?` needs up to 95 s. Resize to 60, 44 and 26 columns, then back, and `keys esc`.
4. Stop B with `verify:stop --dir <scratch>/B` and `waitFor peer! B unread` for up to 160 s: the link reads `· silent` at 90 s with no frame, and runs again with a doubling wait.
5. For `peer-held` and `peer-forgotten`, as before: stop the run loop and B in one `sh` step just after `waitFor peer B [1-9]\d* runs?` matches. A still runs its link, so its row stays in `/status`.
6. `verify:stop --remove` each run.

## Gotchas

- A peer run of a few seconds can fall between two band reads (every 30 s, at a turn's end, at a reconnect). One `gent -H "debug threads"` on B ended before a band read showed a run (2026-11-01): use the loop. `debug threads` on B with capacity 1 queues its threads, so B holds one run for minutes after a loop.
- Stop the run loop before B: a headless `gent` on B that finds no server can start one, and that server links to A again. Count the `ready on` lines in B's `server.log` after the stop.
- A's own entry in `link.machines` never runs: the run's `GENT_MACHINE` is its directory's last part.
- A silent peer's last runs still count for 30 minutes, so A's provider row keeps `1 running` after B stops.
- A peer on another build reads `incompatible`: its `link.hello` names another contract, or it has none. The contract names the release (commit, tree, `bun.lock`, Bun): two source runs of one checkout match, a clean or a dirty one, and a run outside a git repository matches no other process.
- The idle and the live peer rows are on `/status` only: a `waitFor peer <host> \d+ runs?` on the bare screen never matches.
- Steps 1, 2 and 4 and the run loop of step 3 ran on 2026-11-02, read with `gent ctl lanes --line` on A: `peer B 5 runs · 0s` during the loop, `peer! B unread 1m · links down` 73 s after B stopped (the link `connecting`), `peer! B unread 1m · silent` at 93 s. The band steps last ran on 2026-11-01, with `pool.peer`, before the band kept the peer row only while it acts on the server. The band rule is pinned by `apps/tui/tests/extensions/machines.client.test.tsx` (`the peer row shows on the band only while`) and `packages/core/tests/runtime/provider.test.ts` (`the peer`, its `counted` field).
