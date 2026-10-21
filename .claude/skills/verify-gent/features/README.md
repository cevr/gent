# gent verification map

The maintained source for verifying what a gent TUI user can do. Read this index before a drive, then use the matching feature file as the recipe and its script under `drives/` as the drive.

## Baseline

- `bun run --silent verify:launch --dir "$RUN"` makes the run: a scratch home whose config names `anthropic/claude-sonnet-5` (status row `Claude Sonnet 5 (Anthropic) · high`), the scripted model, an empty workspace `$RUN/work`.
- `bun run --silent verify:doctor --dir "$RUN"` prints `Healthy` before the first drive.
- A drive is `bun run --silent verify:drive --dir "$RUN" --script .claude/skills/verify-gent/drives/<script>.json --out "$EVIDENCE/<feature>"`. The scripts run in any order on one run; each opens its own TUI.
- The TUI at rest: row 1 `gent · ctrl+p commands`, the composer `┃`, then the status row (`ready · work · …` in a new session, `idle · work · …` after a turn).

## Proof and skip reporting

- Each step that changes the screen has a `cap` after it, in `$EVIDENCE/<feature>/<nn>-<name>.txt`. The whole drive is `$EVIDENCE/<feature>/drive.cast`.
- Each entry point a feature file lists has a journey of its own: a script under `drives/` that enters by that route.
- A write is proved by a second view: a `gent ctl` read in an `sh` step, `gent resume`, or a file in `$RUN/work`.
- Each journey runs at 100x30 and once at 60x20, and a resize between them where the feature draws a pane.
- A `DriveFailed` is a finding: name its `problems`, the capture before the first one and the doctor's load line. Rerun it on a fresh run of the base commit before calling it new.
- An unreachable entry point is reported with the command tried and the unmet precondition. It never counts as verified through another path.

## Entry contract

Each feature file has an H1, one paragraph of user-visible behavior, then exactly these H2s in order:

1. `Sub-features`: short ids, one line each.
2. `How to get to it (user POV)`: every entry point a user has.
3. `Driving it with verify:drive`: starts with three lines, then labeled steps that pair a user action, the script step and the observable result.
   - **Preconditions:** the state the steps need beyond the baseline.
   - **States:** which of default, focus, open, loading, empty and error the steps exercise; mark the rest `n/a`.
   - **Regression:** the automated tests that cover the feature.
4. `Gotchas`: traps that waste or invalidate a run.

Name user paths, screen text, keys, commands and observable results. Keep source seams out.

## Features

- [A turn](turn.md): send, watch it run, interrupt, a second client, resize, every way to start or resume.
- [Commands](commands.md): the `/` popup and the `ctrl+p` palette, filters, categories, `/new`.
- [Model and effort](model-and-effort.md): `/model`, `/effort` and `/think`, as pickers and with arguments, and the palette's `Set Model` and `Set Effort`.
- [Shell mode](shell-mode.md): `!` commands, their output and exit, sent to the model.
- [Asks](asks.md): a background question, its footer row and the `/answer` form.
- [Sessions](sessions.md): the Sessions pane by `/sessions`, the palette and the `left` key, its filter, switching sessions.
- [Lanes band](lanes.md): free lanes and active machine runs under the status row, at rest, with a run, narrow, and `gent ctl lanes`.
