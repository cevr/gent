# Disclosure defect fixes — 2026-09-08

The cell row now stays visible when full details open. The registered renderer
supplies the body below that row. Error rows keep their existing failure display.
The full transcript does not add a preview block after full output.
The status line shows eight revision characters. The snapshot keeps the full value.

## Checks

- Focused render and label tests: 25 passed, 0 failed.
- Full `bun run gate`: passed. This includes typecheck, lint, format, build, and tests.
- Live app: compiled binary from the isolated Rift, with `--isolate`.
- Herdr pane: `wZ:pH`. Model: `openai/gpt-5.6-luna`.
- Luna printed 60 numbered lines and one final cell value.
- Three Ctrl+O presses changed collapsed → preview → full → collapsed.
- Preview showed 20 lines and `… +41 lines (ctrl+o)`.
- Preview and full kept the same row text, counts, and call identity.
- Ctrl+Shift+O from preview opened full output. Page Up reached the code and row.
  The output ended at line 60 and `CELL-DONE`. No second preview block appeared.
- `context.compact()` created revision
  `ddd577965b9d082c64bd615aca0a83d547ecc1c4a6b55aa357aff448a1670ffe`.
  The 61-column pane showed `compacted rddd57796` in full.
- Real cells called `context.status()` and `context.newWindow()`.
  The marker appeared. Projected tokens changed from 464 to 217.
  The status result cleared the revision. The status line also cleared it.
- The test process stopped after capture. User focus returned to `wZ:pG`.

## Source files

- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/tool-frame.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/session-labels.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/message-list-render.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-labels.test.ts`
- `/Users/cvr/Developer/personal/gent/plans/context-and-disclosure.md`

## Test records

- `/tmp/gent-disclosure-tests.log`
- `/tmp/gent-disclosure-gate.log`
- `/tmp/gent/logs/1b7ecc79-20260908162344-server.log`
- `/tmp/gent-disclosure-fix-live-20260908/01-collapsed.txt`
- `/tmp/gent-disclosure-fix-live-20260908/02-preview.txt`
- `/tmp/gent-disclosure-fix-live-20260908/03-full.txt`
- `/tmp/gent-disclosure-fix-live-20260908/03-full-history.txt`
- `/tmp/gent-disclosure-fix-live-20260908/04-collapsed-after-cycle.txt`
- `/tmp/gent-disclosure-fix-live-20260908/05-preview-history.txt`
- `/tmp/gent-disclosure-fix-live-20260908/06-transcript-from-preview.txt`
- `/tmp/gent-disclosure-fix-live-20260908/07-transcript-page-1.txt`
- `/tmp/gent-disclosure-fix-live-20260908/07-transcript-page-2.txt`
- `/tmp/gent-disclosure-fix-live-20260908/07-transcript-page-3.txt`
- `/tmp/gent-disclosure-fix-live-20260908/09-revision-narrow.txt`
- `/tmp/gent-disclosure-fix-live-20260908/11-window-wide.txt`

Each visible capture also has an ANSI file in the same directory.
These temporary records can expire. The tests preserve the defect checks.
