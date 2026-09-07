# OpenCode v2 prior art

Date: 2026-09-07. Source: `anomalyco/opencode` branch `v2` at
`fcddc84225b73a6b55769b3ab0f6b78a9bdb9931` (committed 2026-09-07T17:52:48Z).
Read from a shallow clone. Files cited are relative to that checkout. This is a
moving branch; pin the SHA when reproducing.

## Finding

OpenCode v2 ships a code mode named `execute`, but it is not the model's only
surface. Every core tool stays native (`read`, `edit`, `write`, `patch`, `glob`,
`grep`, `shell`, `subagent`, `question`, `skill`, `websearch`, `webfetch` all
register `codemode: false`). Only plugin and MCP tools, plus a pinned `opencode`
namespace, enter the code-mode catalog. The interpreter is their own confined
JavaScript-subset evaluator with no state between calls. Prime Agent's single
persistent kernel remains the closer model for Gent's cell. OpenCode v2 is the
better reference for tool contracts, admission, instructions, retry, and
recovery boundaries.

## Code mode (`packages/codemode`, `packages/core/src/codemode`)

- One tool, `execute`, input `{ code }`, output `{ output, toolCalls, files, error? }`
  (`packages/core/src/codemode/tool.ts`). The name `execute` is reserved at
  registration (`packages/core/src/tool.ts:297`).
- `@opencode-ai/codemode` is a pure tree-walking interpreter for a JavaScript
  subset (`packages/codemode/src/interpreter/runtime.ts`, 2,825 lines). No
  `fetch`, timers, imports, process, or filesystem. TypeScript is transpiled
  first (`interpreter/transpile.node.ts`). Confinement comes from implementing
  only supported features, not from a sandboxed engine (`packages/codemode/README.md`).
- Programs reach tools only as `tools.<namespace>.<name>(input)` or through
  `search(...)`, which returns exact paths and signatures.
- No state between `execute` calls. When a program ends, pending promises are
  interrupted and reported as `warnings`; unhandled rejections become warnings
  (`interpreter/execute.ts`).
- Limits per execution: `timeoutMs`, `maxToolCalls`, `maxOutputBytes`
  (`packages/codemode/src/codemode.ts`). A timeout after the program returned
  still reports success with a `TimeoutExceeded` warning.
- Program failures are data: `Result = Success | Failure` with typed
  `DiagnosticKind` (`ParseError`, `UnsupportedSyntax`, `UnknownTool`,
  `InvalidToolInput`, `InvalidToolOutput`, `ToolCallLimitExceeded`,
  `TimeoutExceeded`, `ToolFailure`, `Truncated`).
- The catalog is delivered as instructions, not as a tool. `CodeModeInstructions`
  renders the catalog once and then emits diffs (added, changed, removed
  entries; namespace count changes when the catalog is partial), choosing the
  shorter of delta and full replacement (`packages/core/src/codemode/instructions.ts`).
- Inner tool calls report progress through `context.progress({ toolCalls })`
  with `running | completed | error` per call, and file parts from inner tools
  are lifted into the outer result (`tool.ts`).

## Tool contract (`specs/v2/tools.md`)

- One response carries three values: `output` (schema-validated machine value
  that code mode receives), `content` (model-facing, stored durably), and
  optional `metadata` (compact JSON for UI). A tool without `output` returns
  only content.
- Every call has durable identity: `sessionID`, `agent`, `messageID`, `callID`.
  Tool events also carry `assistantMessageID` because call ids are unique only
  within a step.
- Registrations are scoped. Latest active registration for a name wins; closing
  one reveals the previous. Each model request captures the effective tools it
  advertised and executes those, so later reloads affect later requests.
- Producers and the registry own different limits. The registry bounds model
  content with a head-plus-tail split and an omission marker; oversized text is
  retained in managed storage and replaced with a bounded preview. If retention
  fails, execution fails rather than publishing lossy success.
- Interruption is never a tool result. Unknown, hook-removed, and final-step
  calls fail individually.

## Session contract (`specs/v2/session.md`)

- Prompt admission precedes execution. `Session.prompt` publishes a durable
  `session.inbox.enqueued` fact before any execution. Inbox item ids are
  idempotent per session and type. `resume: false` records input without
  scheduling a wake. Delivery mode is `steer` (next safe step boundary, in
  order) or `queue` (one item at an idle boundary, steers first). Compaction
  and move are control items in the same inbox and form delivery boundaries.
- Execution is process-local and keyed by session id. Explicit resumes join the
  active execution; repeated wakes coalesce; interruption keeps pending input.
- A write-ahead execution claim starts each busy period. Success, failure, and
  user interruption release it; unclean death preserves it. Startup resumes
  claimed sessions with bounded attempt counts and appends a durable
  continuation instruction. Orphan reconciliation fails tool calls still
  projected as running before further model work and never replays ambiguous
  side effects.
- Each complete local tool call is durable before side effects begin. Calls
  start eagerly and may run concurrently; terminal publication is serialized.
- Retry is narrow: at most four retries with jittered backoff for rate limits,
  provider-internal failures, unsent or unknown-delivery transport failures,
  and incomplete streams. Before durable output a retry keeps the step number
  and assistant message id. After durable output the partial assistant stays
  visible and a synthetic continuation instruction is added.
- Instructions are value deltas. Each source key maps to a content hash; blobs
  live once; `session.instructions.updated { delta, text? }` is durable and
  clients display changed keys. Epochs span compactions.
- Compaction rebuilds active history. One overflow-triggered compaction may
  rebuild the same step; a second overflow is terminal.
- `sessions.log({ after?, follow? })` subscribes before replay and emits one
  synchronization marker at the captured watermark. Live-only deltas are absent
  from replay by design.

## Event stream (`specs/v2/event-stream-architecture.md`)

One server-scoped encoded feed; each connection gets an independent
`Queue.dropping` of 4,096 accepted public frames. Overflow fails only that
connection with `SubscriberOverflowError`; publication never suspends.
Internal events and heartbeats do not consume capacity. They evaluated a shared
bounded PubSub and rejected it because Effect's strategies do not express
independent subscriber failure without a custom multicast protocol.

Gent's delivery (commit `6f89af4e`) is a sliding PubSub of event ids plus
durable cursor replay: a slow client catches up instead of being dropped.
Both satisfy "publisher never waits." Gent's choice is retained because the
durable log already exists and the transcript needs completeness, not liveness.

## Catalog transforms (`specs/v2/catalog-config-plugin-lifecycle.md`)

Plugins register replayable catalog transforms applied in registration order;
the catalog rematerializes from active transforms and publishes a diff event.
Slow plugin installs run in the background after a baseline catalog is ready.
This matches Gent's resource graph and live composition; nothing new to take.

## Take for Gent

| Item                                                   | Where it lands                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| Catalog as instructions with diffs; `search()`         | Replace `tool-catalog` tool with a cell-catalog instruction     |
| `output` vs `content` vs `metadata` per tool response  | Cell sees validated output; transcript stores content           |
| Head-plus-tail bounding with retained full text        | Cell result and inner tool content bounding                     |
| Per-execution limits; interrupted promises as warnings | Cell execution limits and result warnings                       |
| Diagnostics as data with stable kinds                  | Cell failure results                                            |
| Durable inbox admission with explicit wake (`resume`)  | Follow-up and steer admission; fixes the warm-branch queue hang |
| Write-ahead execution claim; orphan reconciliation     | Cell and tool recovery at host restart                          |
| Narrow, observable retry with continuation instruction | Agent loop retry policy                                         |
| Instruction value deltas with changed-key display      | Cell catalog and skill instruction sync                         |
| `assistantMessageID` on tool events                    | Event identity when call ids repeat across steps                |
| Synchronization marker in `events({ after, follow })`  | Client replay-to-live handoff                                   |

## Do not copy

- The stateless per-call interpreter. Gent's cell keeps a namespace.
- The native/hidden split where core tools stay native and only plugin/MCP
  tools enter code mode. Gent advertises one cell.
- The per-connection dropping queue. Gent replays from a durable cursor.
- A second interpreter beside Bun.
