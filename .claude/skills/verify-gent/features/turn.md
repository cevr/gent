# A turn

A user types a message and presses enter. gent shows a running line with a timer and `esc cancel`, draws each tool call as it runs, then the answer and a `✻ Worked for <n>s` line with tokens and cost. Esc stops a running turn. A second client (`gent ctl send`) adds a message the open TUI draws live.

## Sub-features

- `turn-send`: enter sends the composer; the user row, the running line and the answer draw in order.
- `turn-tools`: tool calls fold into one summary row (`● Read 3 files · ran 2 commands · …`) with the failed call's detail under it.
- `turn-interrupt`: esc during a turn stops it with `■ Interrupted · what should gent do instead?`.
- `turn-external`: a message sent by `gent ctl send` draws in the open TUI.
- `turn-resize`: the transcript reflows at 60x20 and back at 100x30.
- `turn-prompt-flag`: `gent -p "<prompt>"` opens a session and sends its first prompt.
- `turn-resume`: `gent resume` reopens the last session with its transcript, and a new prompt continues it.

## How to get to it (user POV)

- Type in the composer and press enter, in a new session (`gent`).
- `gent -p "<prompt>"` from a shell.
- `gent resume`, then a prompt.
- `gent ctl send [--new] [--wait] "<prompt>"` from another shell.

## Driving it with verify:drive

- **Preconditions:** the baseline. `turn-resume.json` runs after `turn-prompt-flag.json`, so the last session holds the `debug tools` turn.
- **States:** default, loading (the running line), error (the failed tool call), interrupted. Empty is `n/a`.
- **Regression:** `packages/e2e/tests/e2e.test.ts` (typing, submit, ctrl+c and ctrl+d exits), `apps/tui/tests/ctl.test.ts` (a ctl turn read back).

Script `drives/turn.json`:

1. **Home.** `waitFor` `ready · work`, `cap 01-home`. Row 1 reads `gent · ctrl+p commands`.
2. **Send.** `send debug tools`, `keys enter`, `waitFor esc cancel`, `cap 02-running`. The running line `✻ … · esc cancel` shows a timer.
3. **Answer.** `waitFor ✻ Worked for`, `capAll 03-answered`. The summary row names one failed call, `└ Ran sleep 2; ls gent-debug-tools/d.ts || exit 2 · exit 2 …`, and the answer ends `it does not exist yet.`
4. **Second view.** `sh gent ctl wait --until idle`, `sh gent ctl events --tags ToolCallStarted,ToolCallFailed,TurnCompleted`, `sh cat gent-debug-tools/a.ts`. The events hold the `ToolCallStarted` rows and one `TurnCompleted`; the `ls` that exits 2 is a call that ran, not a `ToolCallFailed`. `a.ts` holds the edited greeting, `hello, world`.
5. **Interrupt.** `send debug tools`, `keys enter`, `waitFor esc cancel`, `keys esc`, `waitFor Interrupted`, `cap 04-interrupted`. The row reads `■ Interrupted · what should gent do instead?`.
6. **External client.** `sh gent ctl send --wait "debug think"`, `waitFor Both chrome paths draw once`, `cap 05-external`. The TUI draws the ctl message and its answer with no key pressed.
7. **Resize.** `resize 60 20`, `cap 06-narrow`; `resize 100 30`, `cap 07-wide-again`. No row is cut mid-word; the status row shortens to fit.
8. **Proof.** `sh gent ctl snapshot --limit 6`. The snapshot is the session `debug tools` with `turns` 3, and its last message is `Both chrome paths draw once.`

Script `drives/turn-prompt-flag.json`: `gent -p "debug tools"`, `waitFor ✻ Worked for`, `cap 11-prompt-flag`, then `gent ctl events --tags MessageReceived,TurnCompleted --limit 3`. The first prompt ran with no key pressed.

Script `drives/turn-resume.json`: `gent resume`, `waitFor idle · work`, `cap 21-resumed` (the `debug tools` transcript is back), `send debug think`, `keys enter`, `waitFor Both chrome paths draw once`, `cap 22-second-prompt`, `gent ctl snapshot --limit 2`.

## Gotchas

- `settle` of 1000 ms or more fails while a turn runs: the running line's timer ticks every second. Use `waitFor` on the end text, then `settle`.
- `waitFor` matches the whole screen, old rows too. After a first `debug tools`, `Worked for` already shows: wait for text only the new state draws (`Interrupted`, the second answer).
- After a turn the status row starts with `idle`, not `ready`. A script that waits for `ready · work` after `gent resume` waits its full timeout.
- `gent resume` on a session with two branches (after `/branch`) opens a `Resume: <name>` branch picker before the transcript.
- `ctrl+c` once shows `ctrl+c again to exit`; the drive's own cleanup sends it, so a script needs no exit step.
