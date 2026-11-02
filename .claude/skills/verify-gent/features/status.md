# Status

The status row under the composer names the model and its effort on the left (`Claude Sonnet 5 (Anthropic) · high`) and the context gauge on the right once a turn ran (`ctx 12k/160k`: what the model holds over what it can take; warning color at 70%, error at 90%; `ctx 8%` when the row is narrow). Nothing else shows at rest: no phase word, no account, no cost, no cwd, no cache clock. A label that needs action joins the row (a notice, a reconnect, a missing model, `cache cold · next turn compacts`, a near-limit `⧗` budget), and rows below it show only live work or what needs the owner (a running child with `← sessions`, an ask, a machine run, a lane with no free lane). `/status` opens a docked pane with the rest: the account, the context detail (held, window, what the cap leaves out, the costliest item), calls, cost, cwd, the cache clock and hit rate, the git branch, every lanes row and the peer. The turn footer (`✻ Worked for …`) does not change.

## Sub-features

- `row-at-rest`: the status row reads `Claude Sonnet 5 (Anthropic) · high` and nothing else; no row under it.
- `row-gauge`: after a turn the row ends with `ctx <held>/963k`; at 44 columns it reads `ctx 0%`.
- `child-running`: `debug delegate` puts ` ◆ Check the greeting files` with `← sessions` under the status row while the child runs; the row goes when it is done.
- `status-pane`: `/status` opens `Status` with `account anthropic · default`, `ctx <held> held of 963k · <n>%`, `window 1.0M · 37k kept for system, tools and output`, `costliest cell <n>`, `cost $0.0<n>`, `cwd work`, then `cache 60m`, `cache hit <n>%` and `≡ lanes unknown`.
- `status-wrap`: the pane shows six lines; `up` from the first line wraps to the last (`≡ lanes unknown`).
- `status-close`: `esc` closes the pane; the row is again the model and the gauge.
- `ctl-unchanged`: `gent ctl lanes --line` prints `lanes unknown` as before.

## How to get to it (user POV)

- The status row shows by itself under the composer.
- `/status` and Enter, or `Status` in the `ctrl+p` palette (category Session).

## Driving it with verify:drive

- **Preconditions:** the baseline run.
- **States:** default (row at rest), loading (a running child), open (`/status`), focus (the pane's selected line). Empty and error are `n/a`: the row is never empty, and an error notice belongs to [a turn](turn.md).
- **Regression:** `apps/tui/tests/app.test.tsx` (`the status row keeps the model, effort and gauge, and /status shows the rest`), `apps/tui/tests/session.test.ts` (`buildContextLabels`, `buildBudgetLabels`), `apps/tui/tests/extensions/cache.client.test.tsx` (`cache clock in the /status pane`), `apps/tui/tests/extensions/machines.client.test.tsx` (`the lanes in the /status pane`), `packages/e2e/tests/verify.test.ts`.

Script `drives/status.json` (the baseline run, 120x40, then 60x20 and a resize from 120x40 to 60x20):

1. **At rest.** `waitFor Sonnet 5`, `expect` the row is `Claude Sonnet 5 (Anthropic) · high` alone, `cap 91-row-at-rest`.
2. **A child.** `send debug delegate`, `keys enter`, `waitFor  ◆ Check the greeting`, `expect` the row ends with `ctx <held>/963k` and the child row is the next line, `cap 92-child-running`.
3. **Done.** `waitFor round 1 completed`, then a screen with no `◆` row, `cap 93-child-done`. The row keeps the gauge.
4. **The pane.** `send /status`, `keys enter`, `waitFor account anthropic · default`, `expect` the held, window and cost lines, `fits`, `cap 94-status-pane`.
5. **Wrap.** `keys up`, `waitFor ≡ lanes unknown`, `cap 95-status-scrolled`.
6. **Close.** `keys esc`, `waitFor` a screen with no `esc close`, `expectNot ≡|⇄|account anthropic`, `cap 96-status-closed`.
7. **Second view.** `sh gent ctl lanes --line`: `lanes unknown`.

## Gotchas

- The pane caps at six lines, with no cue for more: the lanes and the peer are last, so use `up` from the first line, not a run of `down`.
- The lanes answer after the pane opens: wait for `≡ lanes` before moving, or the selection lands on a shorter list.
- A narrow pane cuts a long line with `…`.
- The account names the slot (`anthropic · default`) once a turn on the model sent its credential receipt; before a turn it reads `account anthropic`.
- Do not wait for `ready` or `idle`: the row has no phase word now. Wait for `Sonnet 5`.
