# Context, compaction, and progressive disclosure

Status: proposal. Research: `docs/research/2026-09-08-context-compaction-and-disclosure-prior-art.md`.

## Position

gent already has the two hard parts: a real projection with typed overflow, and
durable summary compaction that keeps history intact. What it lacks is
awareness in three places: the summarizer does not know the cell namespace
survives, the model cannot see or act on context pressure, and the TUI cannot
show what the projection did. Prime Agent supplies the first two patterns.
Codex supplies a third: a lossless recovery path for bounded tool results, and
a summary-free "new window" fallback. Progressive disclosure in the FX
transcript is a rendering change, not a data change.

## Spines

### S1. Cell-aware compaction

- Append the kernel-persistence note to the summary prompt: retained binding
  names come from the last `CellEvaluation.bindings`; the summarizer records
  names worth reusing. (Prime `compaction.ts:461`.)
- Carry read and modified paths from cell operation receipts as structured
  summary details, accumulated across revisions.
- Degrade, do not fail: when `SummaryGenerationFailed`, `SummaryOversize`, or
  `SummaryDidNotFit` occurs, fall back to the plain truncated projection with a
  visible notice instead of failing the turn.

### S2. Context as a cell API (the RLM tool)

Inside the cell, a `context` namespace served by host requests, never mid-cell
for the mutating call:

- `context.status()` returns `{ tokens, limit, percent, omittedMessages,
compactedRevision }` from the last `ModelContextProjection`.
- `context.compact(instructions?)` schedules compaction for the end of the
  current turn with optional user-style instructions, the Prime `compact.run`
  contract. The model rewrites its own context through the instructions, which
  is the useful half of Codex's experiment without discarding history.
- `context.read(toolCallId | messageId, { offset, limit })` returns the stored
  full result or message text. gent already keeps full results durable, so
  bounded results become lossless. Every bounded result gains a trailing
  `[id: <toolCallId>]` marker (Codex `history.read_item`).
- `context.newWindow()` is the Codex summary-free strategy: drop the projection
  to system prompt, the latest user unit, and a one-line pointer to
  `context.read`. Use it as the fallback in S1 and as an explicit model choice.

### S3. Handoff without a blocking prompt

Replace the 85 percent approval question with automatic compaction and a
non-blocking transcript notice. Keep `/handoff` as an explicit user action.

### S4. FX progressive disclosure

- Collapsed row content is invariant under expansion (Prime `ipython-cell.ts:369`).
  Expansion attaches code and output below the row; it never swaps renderers.
- Cell row gains counts and duration: `↑12 ↓40 · 1.2s`. Bash rows gain `↓N`.
- Three levels per group: collapsed (header plus errored rows), preview (all
  rows plus a 20-line head of the last output with `… +N lines (ctrl+o)`), and
  full. `ctrl+o` cycles; `esc` returns to collapsed. `ctrl+shift+o` stays.
- Compaction card: `Compacted N messages into M tokens` collapsed, full
  summary expanded, driven by the `model-compaction` custom message.
- Status line reads the projection: `ctx 42% · 3 omitted · compacted r2`.
  Requires exposing `ModelContextProjection` metrics on the session snapshot.

### S5. `/btw` and `/goal` (shipped 2026-09-08)

- `/btw <question>`: side agent on a clone of the current projection, tools
  off, thinking off, streamed into a side pane; follow-ups replay earlier side
  turns; `esc` closes; nothing persists. Alias `/side`.
- `/goal <objective> [--budget N]`, `/goal status|pause|resume|clear`: durable
  per-branch state; after each ordinary assistant turn while active, enqueue a
  `<goal_context>` continuation; the cell exposes `goal.get()`,
  `goal.create()`, `goal.complete()`; budget exhaustion flips to
  `budget_limited` with a report.

## Order

S5 first (requested). Then S4 status line and invariant rows, S2 `status` and
`read`, S1, S2 `compact` and `newWindow`, S3. Each spine ships with tests and a
counsel review.

## Status

- S5 shipped 2026-09-08 (`e701b067`, `ce06e85b`, `45a88249`).
- S4 shipped 2026-09-08. `ModelContextProjected` event and `ModelContextMetrics`
  on the session snapshot feed the status line
  (`apps/tui/src/utils/session-labels.ts`). Disclosure levels live in
  `apps/tui/src/routes/session-ui-state.ts`: `ctrl+o` cycles
  collapsed → preview → full, `esc` collapses, `ctrl+shift+o` opens the
  transcript view. Cell rows show `↑code ↓display`, bash rows `↓N`; the
  compaction card folds `model-compaction` messages. Deviation: rows carry no
  duration because `ToolCall` in the feed has no timing field; add it when the
  tool-result event carries `durationMs`.
- S1, S2, S3 open.
