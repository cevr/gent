# Context, compaction, and progressive disclosure: prior art

Date: 2026-09-08. Sources: Prime Agent at `9c8230d`, Codex at `c7f81af`, gent at `66af461d`.

## Prime Agent

### Context tracking and compaction

- Context is measured from provider usage, not estimates. `calculateContextTokens`
  sums input, output, cache read, and cache write
  (`packages/coding-agent/src/core/compaction/compaction.ts:131`). Trailing
  messages after the last usage anchor are estimated (`:182`).
- Trigger: `contextTokens > contextWindow - reserveTokens` with defaults
  `reserveTokens: 16384`, `keepRecentTokens: 20000` (`compaction.ts:119-123`, `:215`).
  Three reasons: `overflow` (post-hoc, drops the failed assistant message),
  `requested` (model or user), `threshold` (`src/core/agent-session.ts:8724-8748`).
- Cut point walks backward until `keepRecentTokens`; never cuts at a tool result;
  a cut inside a non-user turn marks `isSplitTurn` (`compaction.ts:390-427`).
- Summary prompt has fixed sections: Goal, Constraints and Preferences,
  Progress (Done, In Progress, Blocked), Key Decisions, Next Steps, Critical
  Context (`compaction.ts:428-459`). An update prompt preserves the previous
  summary and moves items between sections (`:464-501`).
- The RLM note is appended to every summarization prompt (`compaction.ts:461-462`):
  the kernel keeps running, so record variable names worth reusing.
- Read and modified files accumulate across compactions in
  `CompactionEntry.details` and render as `<read-files>` / `<modified-files>`
  (`compaction.ts:44-68`, `compaction/utils.ts:61-71`).
- The model sees the summary as a user message with a fixed prefix
  (`src/core/messages.ts:14`, `:554-561`).
- Model-callable compaction: `compact.status()` returns tokens, window, percent,
  scheduled; `compact.run(instructions)` schedules it. It never runs mid-cell
  (`skills/compact/SKILL.md:32-41`).
- Snapshot skips variables over 16 MiB and reports them
  (`src/core/kernel/state-snapshot.ts:14`).

### Tool printing and disclosure

- Cell component: a single fixed top line whose content is identical collapsed
  or expanded; expansion attaches code and output below
  (`src/modes/interactive/components/ipython-cell.ts:369-372`, `:391-423`).
  Counts render as `↑ 12 ↓ 40 lines` (`:443-467`). Expanded output separates
  stdout, stderr, result, error (`:535-547`).
- Bash preview is 20 head lines then `... N more lines` (`components/bash-execution.ts:14`, `:170`).
  The bash tool keeps the tail and writes overflow to a temp file, telling the
  model where (`src/core/tools/bash.ts:282`, `:371`).
- `ctrl+o` toggles tool output globally (`src/core/keybindings.ts:92`,
  `interactive-mode.ts:7333-7373`), preserving the viewport. Siblings: `ctrl+p`
  agent messages, `ctrl+j` diffs, `ctrl+t` thinking (`docs/keybindings.md:128-139`).
- Compaction card: collapsed `Compacted from N tokens`, expanded full summary
  (`components/compaction-summary-message.ts:26-40`).

### Side questions and goals

- `/btw` clones the live conversation into a tool-less side agent with
  thinking off; earlier side turns replay after the clone; nothing persists
  (`src/core/side-question.ts:48-110`). Instruction text at `:29`.
- Goals: durable state `{status, objective, tokenBudget, tokensUsed,
timeUsedSeconds, continuationsUsed}` (`src/core/goals.ts:14-26`). After an
  ordinary assistant turn an active goal enqueues a `<goal_context>` user
  message (`agent-session.ts:1384`, `:2184-2211`); the prompt text is at
  `goals.ts:207-230`. Only `goal.complete()` from the kernel ends it
  (`skills/goal/SKILL.md`). Budget exhaustion flips to `budget_limited`.

## Codex

- Four strategies dispatched in `codex-rs/core/src/session/turn.rs:1256-1330`.
- Experimental token-budget strategy: no summary. History is discarded and a
  fresh initial context installed (`core/src/session/mod.rs:4224-4275`,
  `core/src/compact_token_budget.rs:22-25`). The model may trigger it with the
  `new_context` tool (`core/src/tools/handlers/new_context_window_spec.rs:6-16`).
  A `<context_window>` fragment carries window ids (`core/src/context/token_budget_context.rs:60-73`).
- Recovery tools: `history.{list_windows,list_items,read_item,search_contents}`
  and `notes.{list_files_by_prefix,read_file,search_contents,append_to_file,write_file}`
  (`ext/history-notes/src/tools.rs:22-97`). Notes persist across windows.
  Every truncated item ends with `[id: ...]` so the model can re-read it.
- Classic summary compaction keeps recent user messages up to 20k tokens plus
  one synthetic user summary (`core/src/compact.rs:63`, `:354-370`).
- Middle truncation of tool output at 10k tokens, overridable per call
  (`core/src/unified_exec/mod.rs:79`, `utils/string/src/truncate.rs:133-135`).
- TUI: 5 collapsed lines, `… +N lines (ctrl + t to view transcript)`
  (`tui/src/exec_cell/render.rs:33`, `:248`). Transcript overlay on `ctrl+t`.
- Gate: `features.context_management.experimental_mode`, entitlement-checked
  (`core/src/session/token_budget.rs:13-56`).

## gent today

- Projection: `projectModelContext` selects a fitting suffix anchored on the
  latest user unit (`packages/core/src/runtime/model-context.ts:541`, `:455`).
  Overflow is a typed error that fails the turn (`:76`).
- Compaction: `compactModelContext` runs every turn, fires only when truncated,
  summarizes a bounded omitted range with a separate model call, and stores a
  durable assistant message `model-compaction:<branch>:<revision>`
  (`packages/core/src/runtime/model-compaction.ts:602-626`, `:457`). Summary
  failures fail the turn (`:50-68`). The prompt has no cell awareness (`:33`).
- Handoff asks the user at 85 percent context (`packages/extensions/src/handoff.ts:110-128`).
- Tool results are bounded to 64k chars for the model with head and tail
  (`packages/core/src/providers/ai-transcript.ts:76-105`); stored results stay
  full. Nothing lets the model re-read a bounded result.
- Cell results carry display plus binding names only (`cell-protocol.ts:45`);
  the namespace snapshot is never shown to the model.
- TUI: `ctrl+o` toggles full transcript detail and `ctrl+shift+o` toggles
  tools, both global (`apps/tui/src/routes/session-controller.ts:581-582`).
  Collapsed groups show only errored calls unless expanded
  (`apps/tui/src/components/message-list.tsx:395`). Cell rows are one line
  (`message-list-utils.ts:148`). The status line shows last input tokens, not
  the projection (`apps/tui/src/utils/session-labels.ts:13`).
