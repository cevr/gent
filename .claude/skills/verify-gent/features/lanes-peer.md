# Lanes peer

With a peer link (`pool.peer`: a server on another machine that spends from the same accounts), the lanes band's last row is the peer: `⇄ peer <host> <n> runs · <age>` while its lines come (its runs on this server's accounts, the age of its last line), `⇄ peer <host> unread <age>` after 90 s with no line, and `⇄ peer unread` before its first line. A link that brought no line for 90 s marks the row `peer!` and names it: `· own link down` (this server's `pool.peer` command), `· peer link down` (the peer's, once it was heard), `· links down`. `gent ctl lanes` holds `peer`, and `--line` prints the row last.

## Sub-features

- `peer-at-rest`: `⇄ peer <host> 0 runs · 29s` under the provider's row; the age climbs to about 60 s between two band reads.
- `peer-run`: `⇄ peer <host> 1 run · 0s` while the peer runs one on a shared account; the provider's row reads `0/1 free · 1 running`.
- `peer-link-down`: about 2 minutes after the peer stops, `⇄ peer! <host> unread 2m · peer link down`.
- `own-link-down`: a `pool.peer` command that prints nothing reads `⇄ peer unread`, then `⇄ peer! unread · own link down` at 90 s.
- `peer-narrow`: at 44 columns the reason goes (`⇄ peer! <host> unread 2m`), at 26 the age and the host (`⇄ peer 1 run`, `⇄ peer! unread`).
- `ctl-peer`: `gent ctl lanes` holds `peer` (`heard` with `host` and `at`, `runs`, `silent`, `down`); `--line` prints the row text last.

## How to get to it (user POV)

- Set `pool.peer` in `~/.gent/config.json` on one machine (`apps/tui/docs/cli.md`, `pool --follow`), and restart its server. The row shows by itself on both machines.

## Driving it

- **Preconditions:** two servers, and the peer goes in a config before its server starts: `verify:launch` writes the config and starts at once, and a `pool.peer` added while a server runs takes a restart.
- **States:** default (heard), loading (`peer unread` before the first line), error (`peer!`, a link down). Empty is no peer: no row. Focus and open are `n/a`.
- **Regression:** `apps/tui/tests/extensions/machines.client.test.tsx` (the peer row), `packages/core/tests/runtime/provider.test.ts` (`the peer`), `packages/core/tests/server/rpc.test.ts` (`notePeer`), `apps/tui/tests/ctl.test.ts` (`pool`).

Recipe (one Mac, three servers; 2026-11-01):

1. Launch run A with the ledger ([lanes.md](lanes.md), `band-measured`).
2. Make `<b>` as for `band-login-lost` in [lanes.md](lanes.md): `<b>/bin/gent` is `$RUN/bin/gent` with every `$RUN` path changed to `<b>`, a copy of `$RUN/auth`, a fresh ledger in `<b>/data`, and `<b>/home/.gent/config.json` with `"pool": {"peer": ["$RUN/bin/gent", "ctl", "pool", "--follow"]}`. A's wrapper sets A's env, so the link reaches A with no ssh.
3. Start `<b>/bin/gent server start --mock --port 0` in `<b>/work` and record its PID. Write `<b>/run.json` with `dir`, `work`, `gent`, `url`, `serverPid`, `supervisorPid` and `env` changed: `verify:drive --dir <b>` then drives B. Its doctor fails on the supervisor check. Both servers read the same hostname.
4. Drive A: `waitFor peer <host> 0 runs`, `cap`. For a run on B, loop `<b>/bin/gent -H "debug threads"` from `<b>/work` outside the drive (an `sh` step stops what it leaves in the background). The band reads every 30 s, so a `waitFor` of `peer <host> [1-9]\d* runs?` needs up to 95 s. Resize to 60, 44 and 26 columns, then back.
5. Stop B with `kill -TERM <pid>` and `waitFor peer! <host> unread` for up to 160 s (90 s of silence, then the next read).
6. For `own-link-down`, a third server `<c>` the same way with `"peer": ["sh", "-c", "exec cat > /dev/null"]`, driven with `--dir <c>`.
7. Stop each server by its PID, then `verify:stop --remove` A.

## Gotchas

- A peer run of a few seconds can fall between two band reads (every 30 s, at a turn's end, at a reconnect). `debug threads` on B with capacity 1 queues its threads, so B holds one run for minutes after a loop.
- A silent peer's last runs still count for 30 minutes, so A's provider row keeps `1 running` after B stops.
- `PoolFacts.host` is required: a peer on an older build fails its link at decode.
