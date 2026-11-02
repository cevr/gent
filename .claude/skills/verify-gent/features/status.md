# Status

The status row under the composer names the model and its effort on the left (`Claude Sonnet 5 (Anthropic) · high`) and the context gauge on the right (`ctx 12k/160k`: what the model holds over the point where gent hands off; warning color at 70%, error at 90%; `ctx 8%` when the row is narrow). The handoff point is the smaller of the hard cap (the window less what the model must keep for the system, the tools and the output) and the role window the compaction extension tuned for the session's role. A fresh session reads `ctx 0/<cap>` from the catalog's window less the output reserve (`ctx 0/968k`), until its first turn names the real cap (`963k`). Nothing else shows at rest: no phase word, no account, no cost, no cwd, no cache clock. A label that needs action joins the row (a notice, a reconnect, a missing model, `cache cold · next turn compacts`, `cold · compacts` when the row is narrow, a near-limit `⧗` budget), and rows below it show only live work or what needs the owner (a running child with `← sessions`, an ask, a machine run, a lane of the session's provider that is refused or waits, the peer while it changes what this server does). `/status` opens a docked, read-only pane with the rest: the account, the context detail (held, the handoff point with both caps and the window, what the cap keeps out, the cold-cache floor, the costliest item), calls, cost, cwd, the cache clock and hit rate, the git branch, every lanes row and the peer. The turn footer (`✻ Worked for …`) does not change.

## Sub-features

- `row-at-rest`: the status row reads `Claude Sonnet 5 (Anthropic) · high` and `ctx 0/968k` on its right; no row under it.
- `row-gauge`: after a turn the row ends with `ctx <held>/963k`; at 44 columns it reads `ctx 0%`.
- `child-running`: `debug delegate` puts ` ◆ Check the greeting files` with `← sessions` under the status row while the child runs; the row goes when it is done.
- `status-pane`: `/status` opens `Status` with `account anthropic · default`, `ctx <held> held of 963k · <n>%`, `hands off at 963k (hard cap) · window 1.0M`, `kept for system and tools <n>k, output 32k`, `a cold cache hands off past 150k`, then `<n> more ↓` on the last row and `↑↓ scroll · esc close` under the frame. Past the cue: `costliest cell <n>`, `cost $0.0<n>`, `cwd work`, `cache 60m`, `cache hit <n>%` and `≡ lanes unknown`.
- `status-role-window`: with a role window below the hard cap, the line reads `hands off at <role>k (role window <role>k) · hard cap <cap>k · window <w>` and the gauge's denominator is the role window. The baseline run has none: a role gets a window only after 20 sampled agents (`MIN_AGENTS` in `packages/extensions/src/compaction.ts`), so `apps/tui/tests/session.test.ts` (`a role window below the hard cap is the denominator`) covers it.
- `status-scroll`: `down` moves one line, `up` at the first line stays there (no wrap), and the cue goes at the end of the list.
- `status-close`: `enter` or `esc` closes the pane; the row is again the model and the gauge.
- `ctl-unchanged`: `gent ctl lanes --line` prints `lanes unknown` as before.

## How to get to it (user POV)

- The status row shows by itself under the composer.
- `/status` and Enter, or `Status` in the `ctrl+p` palette (category Session).

## Driving it with verify:drive

- **Preconditions:** the baseline run.
- **States:** default (row at rest), loading (a running child; the cwd line reads `cwd …` until the root walk ends), open (`/status`, scrolled). Empty, focus and error are `n/a`: the row is never empty, the pane has no selection, and an error notice belongs to [a turn](turn.md).
- **Regression:** `apps/tui/tests/app.test.tsx` (`the status row keeps the model, effort and gauge, and /status shows the rest`, `the /status cwd line shows as pending until the root walk ends`), `apps/tui/tests/session.test.ts` (`buildContextLabels`, `buildContextDetail`, `buildBudgetLabels`), `apps/tui/tests/extensions/cache.client.test.tsx` (`cache clock in the /status pane`, `a lapsed cache the next turn compacts, on the row`), `apps/tui/tests/extensions/machines.client.test.tsx` (`the lanes in the /status pane`), `packages/core/tests/runtime/turn.test.ts` (`role context window`), `packages/e2e/tests/verify.test.ts`.

Script `drives/status.json` (the baseline run, 120x40, then 60x20 and a resize from 120x40 to 60x20):

1. **At rest.** `waitFor Sonnet 5`, `expect` the row is `Claude Sonnet 5 (Anthropic) · high` with `ctx 0/968k`, `cap 91-row-at-rest`.
2. **A child.** `send debug delegate`, `keys enter`, `waitFor  ◆ Check the greeting`, `expect` the row ends with `ctx <held>/963k` and the child row is the next line, `cap 92-child-running`.
3. **Done.** `waitFor round 1 completed`, then a screen with no `◆` row, `cap 93-child-done`. The row keeps the gauge.
4. **The pane.** `send /status`, `keys enter`, `waitFor account anthropic · default`, `expect` the held line, `<n> more ↓` and `↑↓ scroll · esc close`, `fits`, `cap 94-status-pane`.
5. **No wrap.** `keys up`: the first line stays. Twelve `down`, `waitFor ≡ lanes unknown`, `expectNot more ↓|account anthropic`, `expect` the cache hit, cost and cwd lines, `fits`, `cap 95-status-scrolled`.
6. **Back up.** Twelve `up`, `waitFor hands off at 963k (hard cap) · window 1.0M`, `expect` the kept and cold-cache lines, `cap 95b-status-context`.
7. **Close.** `keys enter`, `waitFor` a screen with no `esc close`, `expectNot ≡|⇄|account anthropic`, `cap 96-status-closed`.
8. **Second view.** `sh gent ctl lanes --line`: `lanes unknown`.

## Gotchas

- The pane shows six rows at 120x40 and at 60x20; past them the last row is the `<n> more ↓` cue. The lanes and the peer are last: press `down` past the count (extra presses stop at the end).
- The lanes answer after the pane opens: `settle` before the `down` run, or the count grows under the view and the last rows stay under the cue.
- A narrow pane picks a row's shorter form where it has one (`≡ lanes 1/1 free`, `↺ resets default 3`) and cuts any other long line with `…`.
- The account names the slot (`anthropic · default`) once a turn on the model sent its credential receipt; before a turn it reads `account anthropic`.
- Do not wait for `ready` or `idle`: the row has no phase word now. Wait for `Sonnet 5`.
