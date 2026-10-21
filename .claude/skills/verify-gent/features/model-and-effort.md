# Model and effort

A user picks the session's model and reasoning effort. The status row shows both (`Claude Sonnet 5 (Anthropic) · high`). `/model` opens the `Model · <n>` picker, `●` marks the current model, and typing filters it; `/model <id or name>` and `/model default` set it directly. `/effort` opens the `Effort · 8` picker; `/effort <level>` sets it. An unknown model shows an error in the status row.

## Sub-features

- `model-picker`: `/model` opens `Model · 51`, filtered as the user types (`opus` leaves `Model · 10`).
- `model-set`: `/model anthropic/claude-opus-5` sets `Claude Opus 5 (Anthropic)` in the status row.
- `model-default`: `/model default` goes back to the configured model.
- `model-unknown`: `/model no-such-model-xyz` shows `No model matches "no-such-model-xyz"` in the status row.
- `effort-set`: `/effort low` makes the status row end `· low`.
- `effort-picker`: `/effort` opens `Effort · 8`: `default`, `auto`, `none`, `low`, `medium`, `high` …, `●` on the current level.
- `think-alias`: `/think` opens the same `Effort · 8` picker; `/think medium` sets the level.
- `palette-model`: the palette's `Set Model` opens `Model · 51`.
- `palette-effort`: the palette's `Set Effort` opens `Effort · 8`; typed `low` and enter set it.

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

Script `drives/model-and-effort-routes.json`, the other entry points:

1. **`/think` picker.** `send /think`, `keys enter`, `waitFor Effort · \d+`, `cap 4a-think-picker`; `keys esc`, `cap 4b-think-closed`.
2. **`/think` with a level.** `send /think medium`, `keys enter`, `waitFor Sonnet 5 \(Anthropic\) · medium`, `cap 4c-think-medium`.
3. **Palette, Set Model.** `keys ctrl+p`, `send set model`, `waitFor › set model`, `cap 4d-palette-set-model`; `keys enter`, `waitFor Model · \d+`, `cap 4e-palette-model-picker`; `keys esc`.
4. **Palette, Set Effort.** `keys ctrl+p`, `send set effort`, `keys enter`, `waitFor Effort · \d+`, `send low`, `waitFor › low`, `cap 4f-palette-effort-filtered`; `keys enter`, `waitFor Sonnet 5 \(Anthropic\) · low`, `cap 4g-palette-effort-low`.
5. **Second view.** `keys left`: the Sessions pane's detail column reads the session from the server: `waitFor \(anthropic\) · low`, `cap 4h-sessions-pane-low`.
6. **Narrow.** `resize 60 20`, the palette's `Set Effort` again, `cap 4i-effort-picker-narrow`. `●` is on `low`.

## Gotchas

- `Claude Opus 5` is listed twice (`anthropic/…` and `opencode/…`): set it by its full id, a name can be ambiguous.
- The error stays in the status row after the next command: step 9's capture still shows `No model matches …`. Wait for the model text, not for the error to leave.
- The effort is per session and survives a model change: after `/model default` the row ends `· low`.
- `gent ctl snapshot` names the model but not the effort: prove an effort through the Sessions pane's detail column, which the server fills.
