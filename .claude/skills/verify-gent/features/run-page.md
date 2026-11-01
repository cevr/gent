# Run page

The open Sessions pane lists this thread's machine runs under `Runs (n)` above the sessions: each active run, then the three newest ended ones (`◈ soak · settle #1   30s`). Enter on a run opens its page in the pane's place. The title is `Run soak · 5 visits · 2 rounds · $0.04 · 30s` (`stopped`, `final` or `failed` after the name once it ends). Each state visit has one row: `✓ review #1 · Claude Sonnet 5 (Anthropic) · → lint   $0.02  29s`, with a glyph, the state and its visit number, the round's model, the outcome and the next state, then the cost and the age. Enter on a visit with a round opens the round's thread. A double Ctrl+X stops an active run, and Esc goes back to the list.

## Sub-features

- `runs-list`: `Runs (1)` above the session groups. The run row's detail column reads `soak run`, its state and `started <age> ago`. The filter matches a run by machine and state.
- `page-rows`: one row per visit, oldest first. `✓` is an ended visit and `✕` a failed command. The open visit has `›` and a spinner glyph. A stop ends the open visit: it has `■` and the outcome `stopped`, and no row has `›`.
- `page-narrow`: at 60 columns, a row drops its model before it cuts the outcome (`✓ draft #1 · → check   $0.02  30s`). When the outcome alone is too long, the row shows the outcome's head, never the model. Each age stays on its own row.
- `page-detail`: the line under the rows describes the cursor's visit: `review #1  ·  1 round  ·  $0.02  ·  took 1s  ·  enter opens its thread`. A visit of a command has no thread, so it shows `settle #1  ·  for 28s`, and the footer has no `enter thread`.
- `page-thread`: Enter or `right` on a visit with a round opens that round's thread. The status row then shows `← sessions`.
- `page-stop`: the first Ctrl+X shows `ctrl+x again to stop this run`. Any other key disarms it, and the second Ctrl+X stops the run. The title then says `stopped`, and the footer has no `ctrl+x stop`.
- `page-back`: Esc (when not armed) or `left` goes back to the list.

## How to get to it (user POV)

- Open the Sessions pane (`left` on an empty composer, `/sessions` or the palette), move to the run's row, then press Enter.
- Type the machine's name in the pane's filter to put the cursor on its run.

## Driving it with verify:drive

- **Preconditions:** a run with thread states. `debug machine` defines `soak` (one 45 s command) before it starts it. The drive writes a richer `soak` to `$RUN/work/.gent/machines/soak.json` and makes that directory read-only, so `machine.define` fails and `machine.start` starts the richer file. Its states are draft (writer thread), check (`true`), review (reviewer thread), lint (`false`), settle (`sleep 120`) and done. The drive makes the directory writable again before the end.
- **States:** default (list, page), open (page), loading (the settle visit runs), focus (cursor on a visit), error (none expected). Empty is `n/a`: the list has no `Runs` header when the thread has no runs.
- **Regression:** `apps/tui/tests/extensions/agents.client.test.tsx` (`agents pane machine runs`, `Agents controller machine runs`), `packages/extensions/tests/machines.test.ts` (`the run page reads every state visit`, `a long run's page reads its whole trail once`).

Script `drives/run-page.json` (the baseline run, 100x30):

1. **Start.** `sh` writes the machine file, `send debug machine`, `keys enter`, `waitFor soak settle r1`. The band shows `▸ soak settle r1`, and the turn shows `machine.define · failed · PermissionDenied`.
2. **The list.** `keys left`, `waitFor Runs \(1\)`, `send soak`, `cap 81-runs-list`. The `◆ soak · settle #1` row and its details column are visible.
3. **The page.** `keys enter`, `waitFor Run soak · 5 visits`, `fits`, `cap 82-run-page`. The rows are draft, check (`pass → review`), review, lint (`✕ … fail → settle`) and `› settle #1`.
4. **Narrow and back.** `resize 60 20`, `waitFor draft #1 · → check`, `cap 83-run-page-narrow`. Then `resize 100 30`, `cap 84-run-page-wide-again`.
5. **Arm, disarm.** `keys ctrl+x`, `cap 85-stop-armed` (`ctrl+x again to stop this run`). Then `keys up`, `cap 86-stop-disarmed` (the lint detail, no prompt).
6. **Stop.** `keys ctrl+x` twice, `waitFor Run soak · stopped`, `waitFor ■ settle #1 · stopped`, `expectNot › .*#\d`, `cap 87-stopped`. `sh gent ctl request --extension @gent/machines --id run-list` holds `"status":"stopped"`.
7. **Thread.** `keys up` to `review #1`, `cap 88-review-visit` (`enter opens its thread`). Then `keys enter`, `waitFor Review the line about the cache`, `cap 89-review-thread`.

## Gotchas

- The cursor opens on the shell's own session row, and up and down wrap. An even number of `up` presses can land back on that row, so type the machine's name in the filter instead.
- `›` on the page marks the visit the run is on, not the cursor. The detail line shows the cursor's visit.
- The `settle` command holds the run open for 120 s. Stop it on the page, or `verify:stop` it before the next drive.
- The pane reads the runs on its 2 s clock, so a new state can show up to 2 s late. The page reads through `MachinesRpc.Page` (`run-page`) from the last read's `next`, not `run-status`.
