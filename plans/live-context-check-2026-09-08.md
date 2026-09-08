# Live context and disclosure check

Date: 2026-09-08.
Initial result at `78f19d5c`: Context calls passed. Two disclosure defects remained.

Update: Commit `b150215a` fixed both defects and shortened the revision label.
The live checks passed again. See `plans/disclosure-fixes-receipt-2026-09-08.md`.
The findings below record the initial check.

## Setup

- Source: `/Users/cvr/Developer/personal/gent`, commit `78f19d5c`.
- Command: `/Users/cvr/Developer/personal/gent/apps/tui/bin/gent --isolate`.
- Control: Herdr CLI, test pane `wZ:pH`.
- Model: `openai/gpt-5.6-luna`, confirmed by the UI and server log.
- The shipped main agent sets max reasoning. The live log does not expose the
  provider's reasoning setting separately.
- Session: `01a081bf-9bc2-76c5-86c4-12ab58e264a2`.
- Branch: `01a081bf-9bc2-76c6-adc0-e0d4da9e0512`.
- Terminal sizes: 122 by 25 and 61 by 25.
- The test uses an in-process server and in-memory storage. The test process has stopped. Captures preserve evidence
  after exit. This check does not prove persistence across a process restart.

## Passed checks

1. Luna printed 60 numbered lines in a real cell, followed by `CELL-DONE`.
2. Three `ctrl+o` presses selected preview, full, then collapsed.
3. Preview showed lines 1 through 20 and `… +41 lines (ctrl+o)`. The final
   `CELL-DONE` value accounts for the extra line.
4. Full output showed all 60 lines and the final value. The group header
   remained `● 1 cell` across the cycle.
5. `Esc` returned preview to collapsed. `ctrl+shift+o` opened the transcript view.
6. In the transcript view, Page Up moved to older content. That position stayed
   fixed while Luna generated an 80-line reply. The first visible line stayed
   the same before, during, and after generation. The activity footer changed
   height. This check covers the app transcript view, not the terminal's native
   mouse-wheel scrollback.
7. `context.compact()` returned its scheduled reply. A card showed
   `Compacted 4 messages into ~85 tokens`. The full transcript showed the summary.
8. A later cell called `context.status()`. Its revision matched the status line.
9. A cell called `context.status()` and then `context.newWindow()`. The latter
   returned `{ "scheduled": "newWindow" }`. The marker `⇣ new context window`
   appeared. A second cell called `context.status()` after the next model step.
10. The token estimate changed from 489 to 275. The revision changed from a
    64-character SHA-256 value to an empty string. The status line cleared its
    revision label. Both percentages rounded to zero. The limit remained
    1,050,000 tokens and `available` remained 1,036,883.
11. Full transcript output still contained `LIVE-LINE-060` after the new window.
    The old summary also remained visible.

## Defects

### Cell row text changes in full mode

Preview shows `└ cell → LIVE-LINE-001 · ↑2 ↓61`. Full mode replaces that row
with a source-code header and tool-call ID. The stable group header does not
satisfy the plan's requirement for a stable cell row.

The source selects `SingleToolCall` instead of retaining the compact row when
`rowsOpen()` becomes true. Keep the compact row and attach details below it.

Evidence:

- `/tmp/gent-live-check-20260908/03-preview-history.txt`
- `/tmp/gent-live-check-20260908/04-full-history.txt`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx:542`

### Full transcript repeats preview output

Set disclosure to preview. Open the transcript view with `ctrl+shift+o`.
The view renders the full output and adds the preview below it. The captures
show the compaction reply and context status JSON twice.

`rowsOpen()` checks `fullDetail`. The preview calculation does not. Suppress
preview output when the full transcript owns the display.

Evidence:

- `/tmp/gent-live-check-20260908/14-scrolled-during-window.txt`
- `/tmp/gent-live-check-20260908/15-scrolled-after-window.txt`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx:469`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx:475`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx:562`

## Revision label observation

The live revision is 64 characters, not eight. Production supplies a SHA-256
hash. The earlier source review saw only the fallback hash. At 61 columns,
the footer clips the revision with an ellipsis. Other status text remains
visible. A short revision prefix would give a more compact label. Keep the
complete value in the API and snapshot.

Evidence:

- `/tmp/gent-live-check-20260908/11-compacted-status.txt`
- `/tmp/gent-live-check-20260908/12-narrow-revision.txt`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:399`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform-bun.ts:178`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/session-labels.ts`

## Other receipts

- `/tmp/gent-live-check-20260908/results.json` — structured results and status values.
- `/tmp/gent-live-check-20260908/session-fields.json` — session and model fields from logs.
- `/tmp/gent-live-check-20260908/02-collapsed.txt`
- `/tmp/gent-live-check-20260908/05-collapsed-return.txt`
- `/tmp/gent-live-check-20260908/06-escape-collapsed.txt`
- `/tmp/gent-live-check-20260908/07-transcript-view.txt`
- `/tmp/gent-live-check-20260908/16-window-result.txt`
- `/tmp/gent-live-check-20260908/16-window-history.txt`
- `/tmp/gent-live-check-20260908/17-scroll-before-stream.txt`
- `/tmp/gent-live-check-20260908/18-scroll-during-stream.txt`
- `/tmp/gent-live-check-20260908/19-scroll-late-stream.txt`
- `/tmp/gent-live-check-20260908/20-scroll-complete.txt`
- `/tmp/gent-live-check-20260908/21-full-transcript-after-window.txt`
- `/tmp/gent/logs/1b7ecc79-20260908160012-server.log`
- `/tmp/gent/logs/1b7ecc79-20260908160012-client.log`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/native-transcript.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/AGENTS.md`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/log-paths.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/agents.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/agent.ts`
- `/Users/cvr/Developer/personal/gent/plans/context-and-disclosure.md`
- `/Users/cvr/Developer/personal/gent/plans/context-deferred-receipt-2026-09-08.md`

No source code changed. No commit or push was made. The earlier full gate
covered this same source commit. This pass added live checks only.

## Multiline input check

A later live check used the compiled app and Herdr. Typed newlines, wrapped
input, sent multiline messages, blank lines, and pane resizing kept the left
border on every visible line. No border defect was reproduced. No code changed.
Pasted text still collapses at three lines or 150 characters.

Evidence:

- `/tmp/gent-user-rail-20260908/wrapped-editor.txt`
- `/tmp/gent-user-rail-20260908/before-narrow.txt`
- `/tmp/gent-user-rail-20260908/before-wide.txt`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/composer.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/use-composer-controller.ts`
