# Model and effort

A user picks the session's model and reasoning effort. The status row shows both (`Claude Sonnet 5 (Anthropic) · high`). `/model` opens the `Model · <n>` picker, `●` marks the current model, and typing filters it; `/model <id or name>` and `/model default` set it directly. `/effort` opens the `Effort · 8` picker; `/effort <level>` sets it. An unknown model shows an error in the status row.

## Sub-features

- `model-picker`: `/model` opens `Model · 51`, filtered as the user types (`opus` leaves `Model · 10`).
- `model-set`: `/model anthropic/claude-opus-5` sets `Claude Opus 5 (Anthropic)` in the status row.
- `model-default`: `/model default` goes back to the configured model.
- `model-unknown`: `/model no-such-model-xyz` shows `No model matches "no-such-model-xyz"` in the status row.
- `effort-set`: `/effort low` makes the status row end `· low`.
- `effort-picker`: `/effort` opens `Effort · 8`: `default`, `auto`, `none`, `low`, `medium`, `high` …, `●` on the current level.

## How to get to it (user POV)

- `/model` and `/effort` (alias `/think`), as pickers or with an argument.
- The palette (`ctrl+p`, then `Set Model` or `Set Effort` under `Session`).

## Driving it with verify:drive

- **Preconditions:** the baseline; a new session (`["gent"]`).
- **States:** default, open, error. Loading is `n/a` once the catalog has loaded; empty is `n/a`.
- **Regression:** `apps/tui/tests/pickers.test.tsx`, `apps/tui/tests/session.test.ts`.

Script `drives/model-and-effort.json`:

1. **Status.** `waitFor ready · work`, `cap 41-status-before`. `Claude Sonnet 5 (Anthropic) · high`.
2. **Picker.** `send /model`, `keys enter`, `waitFor Model · \d+`, `cap 42-model-picker`.
3. **Filter.** `send opus`, `waitFor › opus`, `cap 43-model-filtered`.
4. **Close.** `keys esc` twice (clear, then close), `cap 44-picker-closed`.
5. **Set.** `send /model anthropic/claude-opus-5`, `keys enter`, `waitFor Claude Opus 5 \(Anthropic\)`, `cap 45-model-set`.
6. **Effort.** `send /effort low`, `keys enter`, `waitFor Opus 5 \(Anthropic\) · low`, `cap 46-effort-low`.
7. **Effort picker.** `send /effort`, `keys enter`, `cap 47-effort-picker`. `●` is on `low`.
8. **Unknown model.** `send /model no-such-model-xyz`, `keys enter`, `waitFor No model matches`, `cap 48-model-unknown`.
9. **Default.** `send /model default`, `keys enter`, `waitFor Claude Sonnet 5 \(Anthropic\)`, `cap 49-model-default`; `sh gent ctl snapshot --limit 1`. The snapshot's `model` is `anthropic/claude-sonnet-5`.

## Gotchas

- `Claude Opus 5` is listed twice (`anthropic/…` and `opencode/…`): set it by its full id, a name can be ambiguous.
- The error stays in the status row after the next command: step 9's capture still shows `No model matches …`. Wait for the model text, not for the error to leave.
- The effort is per session and survives a model change: after `/model default` the row ends `· low`.
