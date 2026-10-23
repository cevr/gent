# Sessions

A user browses and switches sessions. `/sessions` docks the `Sessions` pane under the composer: a filter row, sections (`Idle (n)`, `Inactive (n)`, `Running`, `Needs you`), a spawn tree whole under its most urgent member's section with each row's own glyph, one row per session with its age, and a detail column for the selected row (model, turns, cost, cwd, the last answer). Typing filters it; enter switches the TUI to the selected session.

## Sub-features

- `sessions-open`: `/sessions` shows `Loading…`, then `Sessions · <n> idle …` and the rows (5.3 s and 6.8 s with 9 sessions, measured).
- `sessions-filter`: typed text filters by name (`debug think`).
- `sessions-switch`: enter opens the selected session with its transcript.
- `sessions-narrow`: at 60x20 the detail column moves under the list as one line.
- `sessions-left-key`: `left` on an empty composer with nothing open docks the same pane.
- `sessions-palette`: the palette row `Sessions … [left]` docks it too.

## How to get to it (user POV)

- `/sessions`.
- The palette (`ctrl+p`), the `Sessions` row.
- The `left` key, which the palette row names (`[left]`).

## Driving it with verify:drive

- **Preconditions:** the baseline; a new session (`["gent"]`). The script makes the session it switches to with `gent ctl send --new`.
- **States:** default, open, loading (`Loading…` before the first listing), narrow. Empty and error are `n/a`.
- **Regression:** `apps/tui/tests/extensions/agents.client.test.tsx`; `apps/tui/tests/ctl.test.ts` (the `list-agents` reply crosses the wire); `packages/core/tests/runtime/extension-host.test.ts` (a reply with an unset optional key stays a JSON value).

Script `drives/sessions.json`:

1. **Empty session.** `waitFor ready · work`, `cap 71-empty-session`.
2. **Another session.** `sh gent ctl send --new --wait "debug think"`. It prints `TurnEnded`.
3. **Pane.** `send /sessions`, `settle 300`, `keys enter`, `waitFor Sessions · \d+`, `waitFor ○ debug think`, `wait 300`, `cap 72-sessions-pane`.
4. **Filter.** `send debug think`, `waitFor › debug think│`, `cap 73-sessions-filtered`. The detail column ends `Both chrome paths draw once.`
5. **Switch.** `keys enter`, `waitFor Both chrome paths draw once`, `cap 74-switched`. The transcript is the ctl session's.
6. **Second view.** `sh gent ctl request --extension @gent/agents-view --id list-agents --input '{"query":"debug think"}'`. The reply's `rows` hold the session.
7. **Narrow.** `resize 60 20`, the pane again, `cap 75-sessions-narrow`.

Script `drives/sessions-routes.json`, the other entry points:

1. **`left` key.** `waitFor ready · work`, `keys left`, `waitFor Sessions · \d+`, `wait 300`, `cap 76-left-key`; `keys esc`, `cap 77-left-closed`.
2. **Palette row.** `keys ctrl+p`, `send sessions`, `waitFor Sessions .*\[left\]`, `cap 78-palette-row`.
3. **Palette open.** `keys enter`, `waitFor Sessions · \d+`, `wait 300`, `cap 79-palette-sessions`; `keys esc`.
4. **Narrow.** `resize 60 20`, `keys left`, `waitFor Sessions · \d+`, `wait 300`, `cap 80-left-narrow`.
5. **Second view.** `sh gent ctl request --extension @gent/agents-view --id list-agents --input '{"query":""}'`. The reply's rows are the pane's sessions.

## Gotchas

- Each row's age ticks every second, each on its own phase, so with several rows the pane is never quiet: `settle` fails while it is open. Use `waitFor`, then `wait 300`, before a `cap`.
- `Loading…` that never ends means the `list-agents` reply failed: run step 6 by hand to see the error.
- The detail column spells the provider `(anthropic)`, the status row `(Anthropic)`. Match on the model name alone.
- Each `gent` start makes a `New Chat` session, so the pane grows with every drive on the same run.
- `left` opens the pane only while the composer is empty and nothing else is open; in a draft it moves the caret.
