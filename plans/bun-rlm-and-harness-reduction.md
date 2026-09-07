# Bun RLM and harness reduction

Status: implementation in progress. See `plans/bun-rlm-progress.md` for receipts.

## End state

Keep Gent's code-mode model: model-written code composes host tools. The Bun RLM
kernel extends that model with retained working data and recursive child calls.
Replace the old execution machinery, not the code-mode capability.

Gent has one default model-facing Bun code cell. The cell keeps working data
between turns and calls the existing Gent host for effects and recursive work.
Gent keeps one session engine, one durable control system, and the FX UI.
The old executor path and superseded workflow machinery are deleted.
The combined maintained implementation is smaller and has fewer public concepts.

Research: `docs/research/2026-09-06-bun-rlm-and-loom.md`,
`docs/research/2026-09-06-gent-trim-candidates.md`, and
`docs/research/2026-09-07-opencode-v2-prior-art.md`.

## Prior-art position

The cell follows Prime Agent's RLM model: one persistent tool, a namespace that
survives turns, compaction, and kernel restart through host-owned snapshot and
restore, host tools as async callables, and children admitted through a host
request that returns a handle at once and reports back through later messages
or files. Unawaited work may outlive a turn; the host delivers completion
messages the model reads on later turns. Host requests are served while a cell
runs.

From OpenCode v2 take only the contracts that fit that model:

- Catalog delivered as instructions with diff updates and a `search()` callable
  for exact paths and signatures, in place of a catalog tool.
- Tool responses split into validated `output` (what the cell sees), `content`
  (what the model and transcript keep), and optional `metadata`.
- Per-execution limits (timeout, tool-call count, output bytes); unfinished
  promises interrupted and reported as warnings; diagnostics returned as data
  with stable kinds, not as tool failures.
- Head-plus-tail bounding of model content with full text retained.
- Durable inbox admission before execution, idempotent item ids, and an
  explicit wake flag separate from admission. Steer and queue delivery at safe
  step boundaries. This also closes the warm-branch follow-up hang recorded in
  `plans/bun-rlm-progress.md`.
- Write-ahead execution claims with bounded startup recovery, and orphan
  reconciliation that fails stale running tool projections before new model
  work. No replay of ambiguous side effects.
- Narrow, observable retry: bounded jittered retries for rate limits, provider
  failures, unknown delivery, and incomplete streams; a durable continuation
  instruction after partial output.
- `assistantMessageID` on tool events; a synchronization marker when a client
  moves from replay to live.

Do not copy OpenCode v2's stateless per-call interpreter, its native/hidden
split where core tools stay native and only plugin and MCP tools enter code
mode, its per-connection dropping queues, or OpenClaw-style exec/wait snapshots.

## Boundaries

- Work in isolated Rifts. Preserve pending FX and architecture changes.
- Research does not authorize wholesale deletion of user-facing integrations.
  Replace redundant implementations only after equivalent required behavior works.
- Keep durable approvals, event identity/order, resource generations, cleanup,
  steering/follow-up separation, and model-context/display separation.
- No second Loom daemon, workflow engine, provider layer, event store, or scheduler.
- No automatic replay of arbitrary effectful cells. No VM-as-sandbox claim.
- No new framework for prompt-defined specialist workflows.
- Do not commit, push, merge, or publish without applicable user authority.
  Required owned-library releases use Changeset, commit, push, version-PR merge,
  published package verification, and downstream revalidation. Never ship links.

## Stage 1 — Baseline and proven deletions

Record the current source/dependency/interface baseline. Separate inherited work
from this goal's edits. Verify the candidate report against callers again.
Remove unused spinner/decor code and unselected runtime branches where production
caller evidence proves they are unused. Remove corresponding dead tests/exports.
Do not remove a behavior only because its file is large.

Exit: no dangling callers; baseline and deletion receipts; full Gent gate.

## Stage 2 — Bun kernel proof and shared ownership

Use Loom's evaluation/process design. Prove cells, retained bindings, reset,
top-level await, large output, cancellation, worker crash, and branch isolation.
Prove host callbacks can return during an active cell. Compare an injected shared
kernel seam with importing Loom's complete runtime; reject the latter.
Choose and document the supported security boundary. Test direct filesystem,
process, network, dynamic-import, and credential access. Do not silently weaken
the current executor's authority. If safe replacement needs a new user trust
decision, stop that cutover and request it; continue independent reductions.

Exit: executable evidence; small evaluate/reset/close interface; no Loom daemon
dependency; no second lifecycle owner; Pi consumer still works if shared code moves.

Decision (2026-09-07): the evaluator is inlined in Gent and stays there. No
shared `@cvr/bun-cell` package; the Loom extraction was dropped unreleased.

## Stage 3 — Gent host bridge and recursive work

Bind a lazy kernel to the existing branch/session execution owner. Use typed
request/reply frames, separate evaluation and reply dispatch, bounded frames and
diagnostics, and scoped teardown. Keep the effectful host catalog authoritative.
Route file/process/tool operations through current permissions and generations.
Record cell source/outcome and operation receipts in existing durable storage.
Return stable handles for long processes and child admission. Reuse existing
AgentRunner, queue, interaction, and usage paths. Do not duplicate them in Bun.
Expose explicit inspect/wait/cancel and bounded child depth/concurrency controls.
Keep pending approval durable without claiming the worker stack is durable.
Use an explicit host tool-call boundary with bound tool identity. Do not resolve
old calls against a new tool implementation after reload. The current extension
resource scope is process-wide; define branch ownership without assuming a
session-scoped resource descriptor already exists.

Exit: real host operations; recursive child completion after kernel reset;
approval denial/restart; stale binding rejection; timeout/process-tree cleanup;
unknown-outcome handling without duplicate effects; full gate and RPC checks.

## Stage 4 — Default cutover and feature consolidation

Make `cell` the default model execution surface after Stage 3 passes. Preserve
human slash commands and extension RPC. Generate host callable descriptions from
existing declarations and deliver them as instruction deltas with `search()`;
retire the catalog tool. Give the cell validated tool `output` and keep model
`content` bounded head-plus-tail with full retention. Return cell diagnostics
as data with stable kinds and per-execution limits. Render structured operations and file changes in the FX
transcript, with full details and visible failures. Verify the packaged worker.
Delete the replaced executor binary discovery, port scan, MCP bridge, controller,
execute/resume tool wrappers, unused dependencies, and superseded tests/docs.
Replace overlapping specialist orchestration with skills/presets over existing
host calls. Preserve useful structured validation and artifacts where callers
depend on them. Avoid a permanent parallel legacy/default path.

Do not unilaterally delete ACP integrations, todos, explicit memory, Mermaid, or
auto goals. Their removal is a separate product choice unless the plan supplies
the same useful behavior through a smaller shared path. Remove duplicate state
or persistence only after inspecting consumers, including delegation and resume.

Exit: actual net runtime reduction with no relocation accounting trick; one
default cell tool; old executor removed; examples and author docs use the new path.

## Stage 5 — Bounded delivery, trust, and completion audit

Add a project-code trust decision before project module import. Admit follow-ups
and steers through a durable inbox with an explicit wake flag, delivered at safe
step boundaries. Start each busy period with a write-ahead claim; on host start,
reconcile orphaned running tool projections before new model work. Set a slow-client
policy for the existing event stream. Prefer bounded notification plus durable
cursor replay over a second event bus or silent loss. Verify no race between
history replay and live events, and no slow-client deadlock of tool execution.
Expose existing resource health/repair through a small command or view, not a
dashboard or new control API when the current one suffices.

Run realistic Herdr workflows: inspect data across cells; edit files; start and
cancel a long command; delegate a focused child; approve/deny; switch branches;
compact model context; reset/crash the worker; resume after host restart.
Run full Gent gate, relevant E2E, and changed Loom/library consumer gates. Use
mock providers for correctness. Do not add appearance-only tests or run paid
model benchmarks without explicit authority.

## Completion requirements

Evidence as of `dee60987` (2026-09-07), recorded in `plans/bun-rlm-progress.md`:

- [x] Stage exits have command/capture receipts tied to final source.
- [x] One default cell surface; state survives normal turns and compaction
      (`4d31eddf` namespace snapshot and restore; `cell-lifetime.test.ts`).
- [x] Host retains authority; security contract is tested and explicit
      (project trust gate; selected bindings only; `cell-tool-host.test.ts`).
- [x] No duplicate runtime, daemon, persistence owner, or host schema catalog
      (`f1a46c39` reads the catalog from the selected bindings).
- [x] Recursive children use Gent sessions and durable handles, with usage limits;
      admission returns at once and results arrive on later turns (`c30f2314`).
- [x] Cell catalog is an instruction delta; tool output/content/metadata split
      and bounded content are in place; follow-ups admit through the durable
      inbox with explicit wake (`f1a46c39`, `2c531638`, `06b2dca2`).
- [x] Lost bindings and ambiguous effects are reported; no blind cell replay
      (`f7e45168` reconciliation; `cell-recovery.test.ts`).
- [x] Old executor and superseded workflow code are actually removed
      (`267eab59`, `85d3cb14`).
- [x] Gent runtime LOC decreases; combined Gent/Loom/library runtime LOC also
      decreases for the replaced scope. Report tests/data separately. If new
      safety behavior exceeds savings, record the tradeoff and obtain a revised
      scope decision rather than claim completion. **Met at `d3128b47`**:
      runtime is 79,961 lines at 418 files against the 86,965 baseline
      (-7,004). Tests are 69,689 (-1,813). The user's scope decision removed
      the todo, auto loop, memory, and ACP agents extensions (`d26c5bba`,
      `bcce24f4`, `9791ca64`, `d77f1894`); nothing counted is moved code. Loom
      is unchanged.
- [x] Owned library changes are released properly where required; no local
      links (no owned-library edits were needed).
- [x] FX UI, durable approvals, replay, cancellation, and live replacement pass
      (mock-provider gate and E2E, and the Herdr live-model checks with Claude
      Opus 4.6 recorded in `plans/bun-rlm-progress.md`: cancellation,
      delegation, approval, branch switch, handoff, worker crash, host restart).
- [x] Final gate/E2E pass; documents and examples match shipped behavior.

Deliver 3–5 reviewable change groups. Validate each before proceeding. Keep code
changes local until commit/release authority applies. Completion means the whole
plan is verified, not merely that the kernel prototype runs.
