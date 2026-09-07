# Bun RLM progress

## Stage 4: default cell surface and Executor removal

Core now declares the `@gent/cell` builtin in `runtime/code-cell/cell-extension.ts`
with the `cell` and `tool-catalog` tools. Core owns it because the turn resolver
owns the `cell` surface rule, and the extensions package lint forbids runtime
imports. The server root composes `[CellExtension, ...BuiltinExtensions]`.
`ChildAgentExtension` joined the extension builtins. The old Executor extension,
its nine source files, its three test files, and its two approved suppression
entries are deleted. The MCP dependency stays for ACP.

Source runs had no bound identity for builtin tools, so cells could not call them
outside a compiled host. A new `ProcessLocal` binding source names the live
resource generation. The cell host records it when a captured tool has no
durable artifact identity. Resume validates it against the current publication
generation and rejects a retired generation or a missing publication with
`SourceMismatch`. Compiled hosts keep durable artifact identities. Native tool
replay is unchanged.

`agent-child` and `tool-catalog` now take flat object inputs with an `action`
field. The Anthropic structured-output check rejects top-level unions, and the
builtin schema test now covers the shipped composition.

Test presets split: `shippedPreset` is the shipped composition; `e2ePreset` keeps
the native tool surface for tool-behavior tests, which exercise the same bound
execution path that serves cell calls.

Evidence: the shipped-surface RPC test proves both model calls advertise only
`cell`, a cell reads a file through the builtin `read` tool from a source host,
and the bound value survives into the next turn. The replay test proves a
process-local binding resumes inside its generation and fails outside it.
Focused runs: 26 cell and replay tests, the builtin schema test, 85 tooling
tests, and the extension suite passed. The full gate runs in the commit hook.

Measurement: runtime lines 88,534 across 459 files (previous receipt 90,223;
baseline 86,965). This unit removed 1,945 runtime lines and added 137. Test
lines: 1,173 removed, 97 added. Net runtime remains 1,569 above the baseline;
the fixed workflow tools and delegate composition paths are still present.

Sources:

- `packages/core/src/runtime/code-cell/cell-extension.ts`
- `packages/core/src/runtime/code-cell/cell-tool-host.ts`
- `packages/core/src/runtime/code-cell/tool-catalog.ts`
- `packages/core/src/runtime/agent/tool-binding-resolution.ts`
- `packages/core/src/runtime/agent/tool-binding-replay.ts`
- `packages/core/src/domain/tool-binding.ts`
- `packages/extensions/src/delegate/child-agent-tools.ts`
- `packages/extensions/src/index.ts`
- `packages/extensions/tests/helpers/test-preset.ts`
- `packages/extensions/tests/tool-schema.test.ts`
- `apps/server/src/main.ts`
- `packages/core/tests/extensions/cell-default-surface.test.ts`
- `packages/core/tests/runtime/agent-loop/tool-binding-replay.test.ts`
- `packages/tooling/src/suppression-inventory.ts`
- `ARCHITECTURE.md`

## Worker launch supports source and compiled hosts

CellExecution.Branch now reads the installed worker path from GentPlatform.
Source runs select core/dist/gent-cell relative to the platform module. Compiled
hosts select the sibling gent-cell using an explicit build marker. Neither path
searches cwd, PATH, or an extension directory. The worker still launches lazily
under the existing sandbox. Source runs require the core build first.

The real source adapter launched the core worker and retained a variable across
two cells, returning 21 and 42. A separately compiled host launched its sibling
worker and returned the same values. This used the actual adapter and sandbox,
not a path-only assertion. Logs are `/tmp/gent-source-worker-proof.log` and
`/tmp/gent-compiled-worker-proof.log`. The compiled proof is at
`/tmp/gent-worker-layout.YUIssq`. It is not a full TUI acceptance check.

Cell lifetime and approval fixtures now select their own compiled worker through
the explicit platform field. The full gate exited 0 at
`/tmp/gent-source-worker-verified-gate.log`. Initial checks found an unsupported
path import, one complete platform fixture that needed the new field, and lint
errors. Those were fixed. No dependency or lock file changed in this unit.

Source-mode durable builtin identity is still unsupported. This launch repair
does not grant replacement tool authority or enable cell replay. Default cutover,
executor deletion, and net runtime reduction remain incomplete. No commit, push,
or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/gent-platform.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/gent-platform-bun.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/scripts/build.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/server/build-fingerprint.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-approval.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/artifact-identity.ts`

## Running child stops at the model-attempt limit

A new runner check starts an admitted child with an unused model budget. The
model requests a tool on each of 32 steps. A final text response remains unused.
The child stops with streamFailed and the stored budget-exhausted error. The
provider records exactly 32 calls. The child has one initial user message.

The check uses the existing live runner and real storage fixture. That fixture
uses ToolRunner.Test, so this check does not prove real shell effects. It proves
normal turn-loop enforcement, not provider retries, summaries, or process restart.
The separate concurrent storage check remains in place.

All 32 runner tests passed with 143 assertions at
`/tmp/gent-running-child-limit.log`. The first run found an incorrect message-read
argument in the new test. The first gate found a context-provision style error.
Both were fixed. The final full gate exited 0 at
`/tmp/gent-running-child-limit-final-gate.log`. No production code changed.
Sideshow was unavailable at localhost:8228. No commit, push, or release occurred.
The full goal remains incomplete.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-source.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/session-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/message-storage.ts`

## Unknown child-start recovery uses the existing handle

The recovery report already includes toolCallId for Unknown operations. Child
start derives its requestId from that exact inner tool-call ID. Tool guidance now
explains how to inspect or cancel such a start without repeating agent-start.
No recovery API, lookup store, or replay mechanism was added.

The RPC recovery check now seeds an inner Started operation and an admitted child
before message submission. The parent recovers its cell report. It uses only the
returned toolCallId to inspect the existing child, then cancels and waits for an
interrupted receipt. There is one model call for the parent and none for the child.
The cell source does not run again. Existing sibling-result and approval checks
remain in the same suite. This is a real-storage crash-gap simulation, not a
process-kill/restart test.

The focused suite passed with 45 assertions at
`/tmp/gent-unknown-child-recovery.log`. The first gate caught a tagged-schema
form and test complexity. Both were fixed without changing rules. A subsequent
gate passed this recovery test but hit an unrelated missing temporary directory
in GitReader. The ten GitReader tests passed on a focused rerun at
`/tmp/gent-git-reader-recheck.log`; its cause was not established. The final full
gate exited 0 at `/tmp/gent-unknown-child-recovery-final-gate.log`.
`git diff --check` passed. No commit, push, or release occurred. The full goal
remains incomplete.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/delegate/child-agent-tools.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-recovery.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-tool-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-recovery.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/tests/librarian/git-reader.test.ts`

## Cancellation completes admitted but unsubmitted children

Child cancellation now commits the existing turn.cancel intent before sending
the actor command. SessionRuntime.steer acknowledges submission, not handler
completion. The runner therefore cannot rely on that acknowledgement to establish
the cancellation marker before queueing a missing first message.

Start and cancel now share submission from the saved agent-start receipt. They
use the original prompt, agent, run spec, and stable command ID. After recording
cancellation, the runner submits that original message. Turn entry sees the
cancel marker and writes the interrupted completion without model work. No cell
source or arbitrary host effect is replayed. Existing message-command identity
prevents duplicate submission from creating another turn.

The capacity check now admits children without queueing their messages. A fresh
runner cancels one, waits for its interrupted receipt, then retries start and
cancel. The child has one message and zero model calls. Its completed receipt
releases a capacity slot. Existing checks still cover cancellation during model
work, rejection of foreign parent addresses, and preservation of later child work.

Thirty-one runner tests passed with 139 assertions at
`/tmp/gent-unsubmitted-child-cancel.log`. The full gate exited 0 at
`/tmp/gent-unsubmitted-child-cancel-gate.log`. `git diff --check` passed.
This simulates the admission/submission gap with real storage and runtime. It is
not a process-kill/restart test. No commit, push, or release occurred. The full
goal remains incomplete.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/session-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`

## Direct dispatch cannot use the cell host map

The real executeToolCalls path now has a regression check with a registered
replacement tool present in hostToolBindings but absent from toolBindings.
Direct dispatch returns a failed result: Unknown tool: replaceable. It does not
recover authority from the host map or from the current registry. The same check
also retains the existing captured-A/current-B replacement assertions.

An attempted model-sequence check was removed. Its unknown tool part failed in
the test model's strict encoder before dispatch. That failure did not test the
intended authority boundary. Temporary event diagnostics were also removed.
The retained check enters the real dispatcher and real ToolRunner directly.

Sixteen tool-runner and compiled-cell tests passed with 71 assertions at
`/tmp/gent-cell-dispatch-authority.log`. The full gate exited 0 at
`/tmp/gent-cell-dispatch-authority-gate.log`. `git diff --check` passed.
No runtime code, default registration, or release state changed in this check.
The full goal remains incomplete.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/tool-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-runner.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/test-utils/language-model.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`

## One advertised tool for selected cell turns

Native turns that select cell now advertise only cell. The runtime keeps a
separate hostToolBindings map from the same compiled policy result. Cell host
calls use that full map. Outer model calls use only advertised bindings.
Cell recovery also resolves the current host map; stored bindings cannot restore
removed cell authority. No second tool registry was added.

Tool-catalog descriptions now include the selected tool's usage guidelines.
This preserves on-demand instructions after host tools leave the direct model
surface. External drivers and turns without selected cell keep their current
behavior. Default builtin registration is unchanged. The old Executor is still
present. Full default cutover remains open.

The real compiled-cell check asserts cell-only parent model calls while child
start, control, and session reading still work through host callbacks. Another
cell check verifies catalog guidelines, retained state, and rejected hidden host
tools. Approval and cold host recovery checks passed with the split maps.
Five focused tests and 87 assertions passed at `/tmp/gent-cell-only-surface.log`.

The first gate found an untyped test callback and a function-complexity limit.
The test now uses SequenceStep context. A small pure selector owns surface
selection. No lint rule was weakened. The final full gate exited 0 at
`/tmp/gent-cell-only-surface-final-gate.log`. `git diff --check` passed.
No commit, push, or release occurred. The full goal remains incomplete.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-resolve.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/tool-catalog.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-approval.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-recovery.test.ts`

## Child controls needed by editable workflows

agent-start now accepts the existing RunSpec overrides. Cells can select a model,
reasoning level, tool list, and added instructions for a child. The tool reuses
RunSpecSchema.fields.overrides and makeRunSpec. It does not add another schema
catalog. The existing host still supplies the parent and tool identity and forces
durable admission. This supplies controls used by the fixed workflow tools; it
does not yet replace those workflows or their prompts and artifacts.

The compiled-cell check proves that the child model boundary receives
custom/model, high reasoning, only read_session, and the added instructions.
It then completes and the parent reads its output. Three tests and 29 assertions
passed at `/tmp/gent-cell-child-overrides.log`. The full gate exited 0 at
`/tmp/gent-cell-child-overrides-gate.log`. `git diff --check` passed.

The source-loader inspection found no immutable builtin source build path to
reuse. Source-mode identity remains absent by design. No path or identity
fallback was added.

The current runtime measurement is 466 files and 90,223 raw lines. The baseline
method counts visible TS/TSX files below apps/packages src directories, including
comments and blank lines. Its current SHA-256 is
`6283d67dfc64febd17c5f9a43343d716a47047052315096cfa4406dabf075349`.
This is 3,014 lines above the 87,209 pre-goal baseline. The old Executor and fixed
workflow code still exist. This is not a net reduction or a completion claim.
No commit, push, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/delegate/child-agent-tools.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/agent.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/counsel/counsel-tool.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/artifact-identity.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/extensions/loader.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/plans/bun-rlm-baseline.md`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/docs/research/2026-09-06-gent-trim-candidates.md`

## Core owns the worker build

The worker build now belongs to core. Its package build writes dist/gent-cell.
The TUI copies that artifact beside gent instead of compiling core source itself.
The existing declared dependency and Turbo ^build rule order both tasks. The
existing dist output rule caches the core artifact. The Darwin ARM64 target and
disabled dotenv, bunfig, tsconfig, and package auto-loading remain unchanged.
No dependency or lock-file change was needed.

The root build passed with two successful tasks at
`/tmp/gent-core-worker-build.log`. Both artifacts were executable. Their SHA-256
hash was `996d472dfda035f478ded91b94c54a790b5819cc306f28bce777caac64244ae6`.
The actual core-built artifact passed a sandboxed openMacosCellKernel check:
one cell retained kept = 21; the next returned 42. The receipt is
`/tmp/gent-core-worker-kernel-proof.log`. The full gate exited 0 at
`/tmp/gent-core-worker-build-gate.log`. `git diff --check` passed.

Source-mode startup is not complete. CellExecution.Branch still looks beside
the host executable, which is Bun in source mode. Source-mode builtins also lack
a build-owned durable artifact identity. A path fallback alone cannot establish
that identity. No generation or sandbox check was weakened. Source-mode startup
must address both constraints before it can be claimed as supported.

This change moves build ownership. It is not runtime LOC reduction. No commit,
push, or release occurred. The full goal remains active.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/package.json`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/scripts/build.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/package.json`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/turbo.json`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/turbo.json`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-kernel.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-process.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/artifact-identity.ts`

## Child output through the existing session reader

The compiled-cell workflow now also starts a child that completes normally.
The parent waits, then calls the existing read_session tool with the returned
session and branch IDs. It reads the child's reply without an extraction goal.
The check observes 12 model calls: ten parent calls and two child calls. Reading
the result adds no model call. No new result service or persistence owner was
added. read_session still renders the session tree; it is not an exact-turn
result API or a task-success assertion.

This check found a real completed-child output error. The control tool included
an undefined optional flag. The cell JSON boundary rejected that result. The
tool now omits absent flags and declares optional keys. It preserves explicit
false values and the original completion flags. The JSON boundary is unchanged.
Tool guidance explains result reading and warns against treating completion as
task success.

The compiled-worker suite passed: three tests and 25 assertions at
`/tmp/gent-cell-child-results.log`. The full gate exited 0 at
`/tmp/gent-cell-child-results-gate.log`. `git diff --check` passed. No commit,
push, or release occurred. Default cutover and the remaining plan are not done.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/delegate/child-agent-tools.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/session-tools/read-session.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-host.ts`

## Durable child model-attempt admission

SessionOperationStorage now reserves up to 32 model-resolution attempts for an
admitted child session. Its branches share the existing durable-operation row.
The atomic update prevents concurrent callers from exceeding that limit.
Reservations are not refunded. Caller transactions and mismatched branch owners
fail before reservation. Root sessions without a child-start receipt return None.

Turn-source reserves before native model resolution. The summary path uses the
same reservation effect. Admitted children cannot use external drivers until
those drivers have an accounting contract. This does not limit tokens or total
subtree work. Legacy and ephemeral children without start receipts remain outside
this limit. Retry, summary, and process-restart behavior need further direct proof.

The focused runner suite passed: 31 tests and 137 assertions, recorded in
`/tmp/gent-child-model-limit-focused.log`. The new check issues 33 concurrent
reservations. Exactly 32 succeed. A second branch and a fresh storage service
still see exhaustion. Starting that exhausted child produces a failed-turn
receipt and the stored budget-exhaustion error. A fresh service is not a
process-restart test.

The final full gate exited 0 at `/tmp/gent-child-model-limit-final-gate.log`.
`git diff --check` passed. Sideshow is unavailable (HTTP 000). No commit, push,
release, or net runtime reduction is claimed. The full goal remains incomplete.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/agent.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/session-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-source.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Child tools through the compiled Bun cell

The exported, opt-in ChildAgentExtension declares two ordinary tools:
agent-start admits one durable child; agent-child inspects, waits, or cancels an
owned start. Start derives the request ID from the host-owned tool-call ID. It
returns that ID with child session and branch IDs. Control reports pending or
the original completed-turn flags, not task success. Wait is bounded to 1–30000
milliseconds and reports timeout without cancelling the child.

The tools use ExtensionContext.Agent. They do not import core internals or add
a cell-only callback registry. The existing bridge applies tool permissions,
bound source identity, and durable operation receipts. RequestId is now part of
the public extension authoring exports. ChildAgentExtension is not added to
BuiltinExtensions; default cutover and usage-limit enforcement remain open.

A real compiled-worker RPC check starts a gated child from a cell, inspects it
in another parent turn, resets the kernel, then inspects and cancels the same
child. A test host tool retains the returned handle outside the kernel; this
does not claim automatic handle recovery after process restart. The test proves
one child user message and the expected nine model-boundary calls. The fixture
uses explicit source identities. Its initial missing identity correctly failed
before starting work; the bridge check was not weakened.

All cell-lifetime checks passed: three tests and 24 assertions at
`/tmp/gent-cell-child-lifetime.log`. They include existing branch isolation and
worker closure checks. The full gate exited 0 at
`/tmp/gent-cell-child-verified-gate.log`. `git diff --check` passed. Temporary
event diagnostics were removed before final verification.

No commit, push, or release occurred. Sideshow remained unavailable (HTTP code
000). No net runtime reduction is claimed. Budget admission, process-crash
recovery, default cutover, old executor/workflow deletion, publication, and final
Herdr/E2E checks remain open.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/delegate/child-agent-tools.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/index.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-host.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-worker-fixture.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Extension child lifecycle and production construction order

ExtensionContext.Agent now exposes start, inspect, wait, and cancel. The host
supplies parent session and branch IDs. Start also supplies the current tool-call
ID and rejects a context without one. Inspection, wait, and cancellation use the
owned request receipt. The API preserves typed agent failures and wait timeout.
It does not grant a cell a second registry or direct storage access.

The real RPC check exposed a production construction defect: AgentLoop captured
its host context before AgentRunnerService existed. A child start failed with
`AgentRunnerService not available`. Existing mock-based RPC checks concealed this
because their runner was installed among early extra layers.

The production root now constructs the SessionRuntime client and agent runner
before registering AgentLoop handlers. It uses published Encore's client-only
`Actor.toLayer(actor)` overload. Client and handler support share memoized cluster
services and the state registry. No new actor, queue, worker, or scheduler was
added. Interaction recovery runs after registration. The combined SessionRuntime
Live layer remains available for existing isolated runtime fixtures.

The RPC check uses a real child runner and a gated model boundary. It proves
duplicate start reuse, child inspection after parent completion, bounded wait,
rejection of start without a tool context, foreign-branch cancellation rejection,
owned cancellation, and one child user message. The final focused run also checks
the existing delegate mock path: 31 tests and 130 assertions passed at
`/tmp/gent-extension-child-and-delegate-focused.log`. The test harness now selects
real child sessions with `subagentRunner: "live"`; mocks use the existing
agentRunnerLayer override, not early extra-layer shadowing.

Server-process checks passed seven tests and 30 assertions at
`/tmp/gent-extension-child-server-lifecycle.log`. These cover shared-server reuse,
workspace isolation, idle shutdown, and reconnect after server restart. They do
not prove child admission recovery across a process crash. The full gate exited 0
at `/tmp/gent-extension-child-accepted-gate.log`. `git diff --check` passed.

Earlier checks found an unregistered fixture agent, a request error-channel
mismatch, a missing debug fixture method set, and seven delegation mock failures.
The final source fixes each issue without replacing the real child check with a
mock. One agent applied the mechanical host-fixture updates. Sideshow remained
unavailable (HTTP code 000). No commit, push, release, or net reduction claim.

Cell-facing tools, durable usage limits, crash recovery, default cutover, executor
and workflow deletion, owned-library publication, and final verification remain
open. This completes the extension host path, not the whole RLM plan.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/extension-host-context.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/make-extension-host-context.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.actor.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/test-utils/e2e-layer.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/test-utils/extension-harness.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/test-utils/extension-host-context.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/tests/plan-tool.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/server/src/debug/scenario.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/e2e/tests/server-lifecycle.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/node_modules/effect-encore/dist/Actor.d.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/node_modules/effect-encore/dist/Actor.js`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Durable lifecycle through AgentRunnerService

The existing agent service now exposes start, inspect, wait, and cancel beside
blocking run. It delegates to the existing durable child implementation. The
service captures its runtime and event-storage dependencies at construction.
It adds no queue, worker, or persistence owner. Start accepts an explicit stable
request ID and parent/tool address. Storage/event failures map to AgentRunError.
Wait preserves TimeoutError; cancelling a wait does not cancel the child.

The real runner checks now use AgentRunnerService for admission, duplicate start,
foreign ownership/workspace rejection, bounded wait, exact completion, deleted
child rejection, cancellation, and protection of later child work. Focused checks
passed 29 tests and 116 assertions at `/tmp/gent-runner-lifecycle-focused.log`.
The full gate exited 0 at `/tmp/gent-runner-lifecycle-verified-gate.log`.
`git diff --check` passed. The first gate read fixtures before their final
Service.of fix and failed lint; the final gate ran after all edits stopped.

Test configurations that mock blocking run remain run-only. The complete test
service explicitly fails if an unconfigured lifecycle method is called. No new
silent-success mock was added. One agent applied the mechanical fixture changes.

This is the host service boundary, not ExtensionContext or cell exposure. Those
adapters, real RPC acceptance, durable usage limits, cutover, deletion, release,
and final checks remain open. No net runtime reduction is claimed. No commit,
push, or release occurred. Sideshow remained unavailable (HTTP code 000).

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/agent.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/make-extension-host-context.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/test-utils/e2e-layer.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/test-utils/extension-harness.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/extensions/host-facet-survivors.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/tests/todo/helpers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Branch-local child stream totals

Child result metadata now reads events for the requested branch, not all branches
in its session. Missing, negative, fractional, or unsafe token totals make the
aggregate unknown. Later known usage cannot restore a partial aggregate. Safe
explicit zero remains known; no stream receipts remains unknown. Addition also
rejects loss of safe integer precision.

The stored-event test covers eight cases across branches in one real SQLite
session. Focused checks passed 29 tests and 116 assertions at
`/tmp/gent-child-usage-focused.log`. The first gate found a fixture-only type
mismatch; the fixture now represents absence with `Option.none<never>()`.
The full gate exited 0 at `/tmp/gent-child-usage-verified-gate.log`.
`git diff --check` passed.

These totals cover stored StreamEnded receipts only. They do not account for
unrecorded attempts, compaction, or crashes. Durable budget admission, public
child/cell integration, cutover, old executor deletion, release, and final checks
remain open. This runtime change adds 14 lines; it is not a reduction claim.
No commit, push, or release occurred. Sideshow was unavailable (HTTP code 000).

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.metadata.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/event-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Summary usage and unknown totals

Response projection now shares one `responseUsage` conversion with compaction.
Both provider totals must be nonnegative safe integers. Missing or invalid totals
return unknown; explicit zero remains known. This removes the previous conversion
that replaced missing totals with zero.

Successful compaction stores the reported usage and model ID in the existing
durable summary details. Old summaries remain readable without those fields.
Reusing a stored summary retains its metadata and does not invoke the model again.
No new storage table or service was added.

The response check covers explicit zero, omitted totals, negative totals,
fractions, and NaN. The real compaction/storage check verifies the saved model and
usage, then verifies summary reuse with one model call. Focused checks passed
19 tests and 77 assertions at `/tmp/gent-summary-usage-focused.log`. The full gate
exited 0 at `/tmp/gent-summary-usage-verified-gate.log`. `git diff --check` passed.
An initial gate caught missing fixture fields and an explicit undefined fixture;
the fixture now uses the FinishPart decoder and Option.

This does not enforce a child budget. Failed summary attempts, crashes before
summary persistence, retries, and aggregate usage still need durable attempt
accounting. Unknown usage must not release a reservation or become free work.
Public/cell integration, restart checks, cutover, publication, deletion, and final
checks remain unfinished. No commit or release occurred. No net runtime reduction
is claimed for the goal.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/response-to-prompt.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/message-part-projection.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-response.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/model-compaction.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/model-compaction.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-turn-response.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/unstable/ai/Response.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Exact turn identity for stream accounting

New StreamStarted and StreamEnded receipts carry the user-message ID and step.
The turn owner supplies both fields. Normal completion, interruption, partial
model failure, exhausted pre-output retries, and external failure retain them.
The fields are optional in the stored event schema so historical events remain
readable. Forwarded ephemeral events still omit exact child identity in the
parent stream. Event ordering and existing usage/cost fields are unchanged.

The durable-child check now reads its stored StreamEnded by exact message ID.
The exhausted-retry check verifies one terminal stream receipt with that turn
and step after three attempts. Focused checks passed 56 tests and 193 assertions
at `/tmp/gent-stream-turn-identity-focused.log`. The full gate exited 0 at
`/tmp/gent-stream-turn-identity-verified-gate.log`. `git diff --check` passed.

This is an accounting prerequisite, not a token budget. The source trace found
that model compaction invokes a separate model through ModelResolver. It must
share the eventual budget policy. Missing usage, retries, uncertain attempts,
and forwarded ephemeral work cannot be counted as zero. Turn/step identity alone
does not prove per-attempt accounting or exactly-once charging after restart.
Budget enforcement, public/cell integration, restart proof, cutover, publication,
deletion, and final checks remain unfinished. No commit or release occurred.
No net runtime reduction is claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/agent.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/driver.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-response.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-source.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.run-spec.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.ephemeral.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/providers/model-resolver.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/model-compaction.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-turn-response.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/streaming.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Persistent child admission limit

The private durable start path now permits four unfinished start receipts per
parent branch. The existing creation transaction verifies parent-branch ownership,
reuses a matching receipt first, then checks capacity before creating a new child.
Capacity reads workspace-scoped durable start receipts and their exact child user
message's stored turn completion. It does not count live actors or kernel state.
The count and creation share the transaction, so concurrent calls cannot each
claim the last slot. Retries do not reserve another slot.

Unstarted and unknown outcomes keep their reservation. A completed turn releases
capacity. Missing or deleted completion evidence does not prove release. This is
a limit on the private durable start path, not legacy blocking or ephemeral runs.
It is not a token budget or a global limit across parent branches.

The real storage/runner check issues five concurrent admissions and verifies four
accepted reservations with no model calls. A fresh runner still rejects another
start, reuses an existing receipt, and rejects an invalid parent branch. It runs
one admitted child to completion, then admits another child. Focused checks passed
28 tests and 107 assertions at `/tmp/gent-child-admission-limit-focused.log`.
The full gate exited 0 at `/tmp/gent-child-admission-limit-verified-gate.log`.
`git diff --check` passed. The initial gate required a finite concurrency value
in the five-call test; the test now uses five.

No new table, scheduler, or runtime owner was added. Token budgets, public/cell
wiring, full restart recovery, cutover, publication, deletion, and final checks
remain unfinished. No commit or release occurred. No net runtime reduction is
claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/agent.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/session-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/schema.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Cancellation retained before turn admission

Targeted cancellation now records `turn.cancel` in the existing durable-operation
table before the steering handler starts the branch owner. The receipt is scoped
to workspace, session, branch, and message. Repeated writes retain it. A conflicting
owner fails. Existing branch deletion cascades remove it. No new table, engine,
scheduler, or persistence owner was added.

Turn entry reads this receipt before model work and sets the existing interruption
flag. User-message storage and in-flight marker clearing now occur once at turn
entry, not on each model step. Thus a turn cancelled before its first model step
still has a stored user message and terminal receipt. Cancellation does not undo
effects that ran before it was processed. Non-targeted steering keeps its existing
behavior.

The runtime check awaits targeted cancellation while the branch is idle, then
admits that exact message. It verifies zero model calls and stored turn completion.
A different later message runs normally. Focused checks passed 46 tests and 160
assertions at `/tmp/gent-durable-cancel-intent-focused.log`. The full gate exited
0 at `/tmp/gent-durable-cancel-intent-final-verified-gate.log`. `git diff --check`
passed. Initial checks found the missing early user-message write, the explicit
runtime-layer dependency, and a named-predicate lint requirement; all are fixed.

This verifies processed cancellation before admission, not the full child
creation-to-enqueue host-restart sequence. A cancelled child not yet submitted
still needs admission/recovery to produce its terminal turn receipt. Restart
checks, child budgets, public/cell wiring, cutover, publication, deletion, and
final checks remain unfinished. No commit or release occurred. No net runtime
reduction is claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/session-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/agent-loop-queue-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-persistence.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.runtime-context.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/streaming.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Turn-targeted child cancellation

The private durable runner now has `cancel`. It verifies the parent-owned receipt
through inspection and skips completed children. Otherwise it submits a stable
persisted steering command for the original child message. It rejects caller
transactions. Its return confirms submission, not finished cancellation; `wait`
reads the actual completion. It does not erase the child or its transcript.

Cancel and Interrupt accept an optional expected message ID. Existing callers
without it keep branch-wide behavior. The worker checks the target before
signaling the stream or cell and checks again before resuming a waiting
interaction. A local interruption permit serializes running cancellation cleanup
with worker finalization and next-turn selection. It does not use the side-mutation
permit held by active work, which would prevent cancellation from reaching it.
This is synchronization in the existing worker, not another execution owner.

The durable-child fixture verifies foreign-parent rejection, caller-transaction
rejection, actual interrupted completion, repeat cancellation, and later work in
the same child. A separate runtime check awaits processing of a stale targeted
cancel while a newer model stream is gated, then verifies the newer reply.
Focused checks passed 66 tests and 278 assertions across child, session, approval,
and streaming tests at `/tmp/gent-child-cancel-focused.log`. The full gate exited
0 at `/tmp/gent-child-cancel-verified-gate.log`. `git diff --check` passed.

Cancellation before queue admission and across the creation-to-enqueue crash gap
is not yet complete. The API remains private. Child budgets, public/cell wiring,
restart checks, cutover, release, old-code deletion, and final checks remain open.
No commit or release occurred. No net runtime reduction is claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/steer.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.worker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-response.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/helpers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/streaming.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Bounded child waiting

The private durable runner now exposes `wait` over its existing parent-owned
inspection. A caller supplies an integer deadline from 1 to 30000 milliseconds.
Effect Schedule spaces reads by 50 milliseconds. Each inspection closes its read
transaction before the next delay. Caller-owned transactions fail before polling
so a wait cannot hold the database transaction needed by the child's completion.

Timeout stops only this read operation. It does not send an interrupt, cancel the
child, restart an actor, or replay source. A saved completion returns through the
same exact-message inspection. No detached waiter, scheduler service, event bus,
or persistence owner was added. The existing raw completion flags retain their
limits; completion is not proof of task success.

The gated durable-child fixture verifies a wait timeout, no child completion at
that point, invalid deadlines, caller-transaction rejection, later completion of
the same child, and repeated waits returning the original receipt. The model runs
once. Focused checks passed 26 tests and 93 assertions at
`/tmp/gent-child-wait-focused.log`. The full gate exited 0 at
`/tmp/gent-child-wait-verified-gate.log`. `git diff --check` passed. An initial gate
required the typed schema decoder for the already typed deadline; this is fixed.

Cancel, bounded child admission, public facade/cell integration, restart recovery,
default cutover, releases, deletion, and final checks remain unfinished. No commit
or release occurred. No net runtime reduction is claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/Effect.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/Cause.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Parent-owned child inspection

The durable runner now has a private read-only `inspect` operation. Input is the
stable start request and exact parent session/branch. It reads the workspace-scoped
start receipt before any child lookup. It then checks the child's stored parent
and branch ownership. Missing or foreign receipts fail; deleted children fail.
The same read transaction retrieves only the admitted message's completion.
The existing event query accepts an optional message ID and still returns at most
one event. It does not load the child's full event history.

Inspection returns child IDs and an optional raw `TurnCompleted` receipt. No
receipt means no recorded completion, not a live actor. A receipt does not prove
task success. Inspection neither starts an actor nor resumes a cell. It uses no
new table, engine, scheduler, or persistence owner.

The real durable-child fixture checks inspection before and after completion,
wrong parent, wrong branch, missing request, another workspace, and child deletion.
It inserts a later unrelated turn event and checks that inspection still returns
the exact original completion. Focused checks passed 26 tests and 83 assertions
at `/tmp/gent-child-inspection-focused.log`. The full gate exited 0 at
`/tmp/gent-child-inspection-verified-gate.log`. `git diff --check` passed.
An initial gate found an overly broad test expectation type; schema decoding
now narrows the observed completion without a cast.

Public handles, wait/cancel, child budgets, creation-to-enqueue restart recovery,
cell integration, default cutover, publication, deletion, and final checks remain
unfinished. No commit or release occurred. This unit adds inspection code and
does not claim net runtime reduction.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/event-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/branch-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/workspace-rpc.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/plans/bun-rlm-and-harness-reduction.md`

## Durable model-failure receipts

Child inspection needs a durable outcome. The existing finalizer knew whether
the model stream failed, but `TurnCompleted` did not store that fact. New receipts
now include `streamFailed`, including explicit false, in the existing transaction
with turn duration. Historical receipts still decode without this field. Absence
does not prove success. No new storage table or execution owner was added.

The existing exhausted-retry runtime check now verifies a failed completion.
The real durable-child check waits for its stored completion and verifies explicit
false. A schema round trip verifies true, false, and historical absence. Focused
runtime checks passed 43 tests and 130 assertions at
`/tmp/gent-turn-failure-receipt-focused.log`. The schema check passed at
`/tmp/gent-turn-failure-receipt-schema.log`. The full gate exited 0 at
`/tmp/gent-turn-failure-receipt-gate.log`. `git diff --check` passed.

An initial test queried SQLite from an existing memory-event fixture and found
no event. The failure check now reads that fixture's recorded events; the child
check verifies the actual SQLite-backed path. This does not prove failed-child
restart recovery. Child inspect/wait/cancel remains unfinished. A false model
failure flag is not proof of task success; step limits and other terminal paths
still need explicit outcome handling. No commit or release occurred. This unit
adds runtime fields and makes no net-reduction claim. Sideshow was unavailable.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.metadata.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/event-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/event-publisher.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/helpers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/streaming.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/domain/event.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Queue-owned durable child start

The existing durable runner now has a private `start` operation. It first creates
or reuses the atomic child receipt. It then submits the prompt through the
existing persisted actor admission path. The command ID derives from the stable
start request. Retries reuse both child IDs and the command. The operation returns
the child session/branch IDs without waiting for the model. It creates no detached
fiber, worker, scheduler, or second session engine. Explicit ephemeral persistence
is rejected; the host tool-call ID supplies the parent identity in the run spec.

The real runner/runtime check starts a gated child inside a scope that then closes.
It retries while the model is gated and again after the answer is stored. It
checks one child, one user message, one answer, the stable message ID, and one
model call. Focused checks passed 26 tests and 75 assertions at
`/tmp/gent-durable-child-start-focused.log`. The full gate exited 0 at
`/tmp/gent-durable-child-start-gate.log`. `git diff --check` passed.

This operation is not yet exposed through the extension facade or cell tools.
The create-to-enqueue crash gap still needs a restart check. Receipt recovery,
handle ownership, inspect/wait/cancel, concurrency and token budgets, default
cutover, publication, executor deletion, and final checks remain unfinished.
No commit or release occurred. No net runtime reduction is claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Atomic child creation receipts

Durable child creation now accepts an optional admission request. It records
`agent.start` in the existing workspace-scoped durable-operation table. The
receipt contains original parent, agent name, prompt, cwd, tool-call ID, run spec,
and child session/branch IDs. Child creation, its spawn event, and this receipt
commit in one transaction. The event is delivered after commit. Legacy blocking
runs still omit admission and keep their existing creation behavior.

Concurrent identical requests return the same child. Changed input fails.
Comparison uses schema-encoded canonical JSON so omitted optional fields match
their stored representation. The receipt's subject is the parent branch, not
the child. After child deletion, a retry finds that receipt and fails rather than
creating another child. Caller-owned transactions are rejected before creation.
No new table, scheduler, persistence owner, or execution engine was added.

The real runner/storage fixture verifies concurrent reuse, one child, changed
input rejection, and no recreation after deletion. Focused checks passed 25 tests
and 68 assertions at `/tmp/gent-child-admission-focused.log`. An initial check
exposed optional-field presence differences in schema equivalence; canonical
encoded comparison fixed this. The full gate exited 0 at
`/tmp/gent-child-admission-verified-gate.log`. `git diff --check` passed.

This unit creates an admission receipt, not a running child handle. Joining that
receipt to durable queue submission, inspect/wait/cancel, limits, cross-restart
checks, cell/default integration, release, deletion, and final completion remain
open. No commit or release occurred. No net runtime reduction is claimed; full
HEAD diffs still include earlier and inherited changes.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/session-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/schema.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Durable admission without waiting for the turn

`SessionRuntime.sendUserMessage` now accepts `completion: "admission"` or
`completion: "turn"`. Admission executes the existing persisted `SubmitDurable`
actor operation. It returns after enqueue, while the existing actor queue owns
the work. Turn completion uses `SubmitAndWait`. Omission keeps the existing
correlation-based behavior. Retry callers must reuse their request or command ID.
No actor protocol, detached execution owner, or scheduler was added.

The runtime integration check submits a correlated admission while the model
is gated. Submission returns before the model is released. A repeat admission
returns without creating another user message or model call. After release, the
existing actor produces one answer. Focused checks passed 9 tests and 42
assertions at `/tmp/gent-durable-admission-focused.log`. The first gate rejected
inline layer provision in the new test. The test now builds its layer in an
owning scope. The final full gate exited 0 at
`/tmp/gent-durable-admission-verified-gate.log`. `git diff --check` passed.

This is the existing queue entry needed for durable child start. Atomic child
identity/admission, handle ownership, inspect/wait/cancel, concurrency and token
budgets, default cutover, release, deletion, and final checks remain unfinished.
No host-restart proof was added in this unit. No commit or release occurred.
No net runtime reduction is claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.protocol.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/session-runtime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Shared durable-child ancestry guard

Tracing child execution confirmed that `AgentRunner` already creates durable
sessions and delegates execution to `SessionRuntime`. The extension agent facade
only exposes a blocking `run`; it does not yet expose durable start, inspect,
wait, or cancel handles. The runner has a durable depth limit but no shared
concurrency or token admission budget. These remain implementation requirements.

The durable runner contained two copies of its ancestry calculation. Both
returned root depth for an absent session. The duplicate is removed. The shared
named check now rejects missing or incomplete ancestry. Durable admission uses
that check before creating a child session. The domain comment now states the
actual boundary: root depth is zero and a parent at depth three cannot spawn.

A real runner/storage test checks that a missing parent returns an error and
creates no child. The focused runner suite passed 24 tests and 63 assertions at
`/tmp/gent-child-ancestry-focused.log`. The first gate found a type-only import
used as a value in the new test. After correction, the full gate exited 0 at
`/tmp/gent-child-ancestry-verified-gate.log`. `git diff --check` passed.

This unit removes one net runtime source line after the stronger validation
(29 additions, 30 deletions in the durable runner; the domain comment is neutral).
It does not establish net reduction for the whole goal. No commit or release
occurred. Durable child handles, budgets, default cutover, publication, executor
deletion, and final completion checks remain open.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.durable.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.config.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/agent.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/relationship-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Policy-selected host bindings during unadmitted recovery

The shared dispatcher now accepts separate outer-call and host binding maps.
Normal turns pass the selected set for both. Recovery first validates pending
outer calls against their saved identities. For an unadmitted cell, it resolves
the current agent policy and passes that selected host set to cell execution.
Host tools are no longer restricted to the pending outer call names. If current
policy removes `cell`, recovery removes its outer execution binding and records
the normal unknown-tool failure. A saved identity cannot restore that authority.
Already admitted cells retain the no-source-replay recovery path.

The seeded RPC fixture now covers an unadmitted call. Its test tool observes a
host binding absent from the pending outer calls. A second case removes `cell`
through agent policy and checks zero cell executions. Both preserve the native
sibling result and final model answer. This fixture checks dispatcher authority;
it does not itself run Bun source in the unadmitted case. The companion lifetime
check still runs the declared tool and actual worker for normal turns.

Focused checks passed 3 tests and 53 assertions at
`/tmp/gent-cell-replay-host-bindings-focused.log`. The first gate rejected added
cognitive complexity in `resumeTurn`. Host-set resolution now has a named
operation. The final full gate exited 0 at
`/tmp/gent-cell-replay-host-bindings-verified-gate.log`. `git diff --check` passed.

Default cell-only advertisement, bounded recursive children, library publication,
old executor deletion, and final completion checks remain open. No commit or
release occurred. This unit does not establish net runtime reduction.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-recovery.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Discovery from selected capabilities

`ToolCatalog` now declares a read-only tool over the current call's selected
binding map. Search matches names and descriptions. It returns up to 20 sorted
names, a total, and the next offset. Describe reads the selected capability's
actual Effect AI input schema. There is no new schema registry, worker protocol,
or execution owner. Missing call context and unselected names return structured
failures. Discovery does not grant execution permission.

The cell prompt documents search and describe calls. The RPC lifetime fixture
registers the declaration beside `CellTool`. Its actual worker searches the
catalog, verifies that an agent-denied tool is absent, reads the worker tool's
numeric input schema, and then calls that tool. These calls pass through normal
host permissions and recorded operation admission. Focused checks passed 2 tests
and 17 assertions at `/tmp/gent-tool-catalog-focused.log`. The full gate exited 0
at `/tmp/gent-tool-catalog-gate.log`. `git diff --check` passed.

Default installation remains unfinished. The model-facing and host binding sets
must be separated before the model surface narrows to one cell. Unadmitted-cell
replay, bounded children, library publication, old executor deletion, and final
checks remain open. Pagination beyond 20 entries has not yet received a focused
behavioral check. No commit or release occurred. No net reduction is claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/tool-catalog.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/current-tool-call.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Selected host bindings before catalog discovery

Tracing discovery exposed a policy gap: fresh cell calls looked up tools in the
full registry, while native turns used the agent-filtered tool set. The turn
dispatcher now supplies its selected binding map with the host-owned call
address. Cell dispatch passes that map to the cell host. Fresh host calls use
only its exact entries. They no longer capture a tool from the registry by name.
The existing publication lease, durable binding admission, and permission check
still apply. Direct host fixtures now supply explicit binding maps too.

The RPC lifetime test registers a tool denied by the agent. Cell code attempts
to call it and receives a rejection. The test checks zero executions. Existing
approval, recorded results, cancellation, and recovery checks still pass.
Focused checks passed 6 tests and 103 assertions at
`/tmp/gent-cell-selected-tools-focused.log`. The full gate exited 0 at
`/tmp/gent-cell-selected-tools-gate.log`. `git diff --check` passed.

Discovery itself remains unfinished. It must derive descriptions from this
selected set. Default cutover must separate the host set from the cell-only
advertised model set. Replay of an unadmitted cell also needs a deliberate host
set: the current replay map contains only pending native tool bindings. Do not
restore full-registry lookup as a fallback. Recursive children, publication,
executor deletion, and final checks remain open. No commit or release occurred.
This unit does not establish net runtime reduction.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-resolve.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/current-tool-call.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-dispatch.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-host.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-tool-host.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-recovery.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Explicit recorded reset

The cell tool accepts optional `reset: true` through the shared `CellInput`
schema. Storage reads the flag from the owned assistant call. The execution
service commits a fresh claim before reset, then holds its existing permit for
reset and evaluation. Saved and incomplete calls return before reset. Cancelled
turns are rejected before reset. The existing kernel owns clearing values and
bounded replacement after worker loss. Operation receipts remain unchanged.

A service check records a reset, creates newer working state, repeats the old
reset call, and verifies that the newer value remains. The cancellation check
now recovers through a recorded reset call instead of invoking the service reset
directly. The RPC lifetime check sends `reset: true` through the declared tool
and verifies that retained values are cleared. These checks preserve the same
single branch owner and the existing cancellation path.

Focused checks passed 13 tests and 88 assertions at
`/tmp/gent-recorded-cell-reset-focused.log`. The full gate exited 0 at
`/tmp/gent-recorded-cell-reset-gate.log`. `git diff --check` passed.

Default catalog discovery, bounded recursive children, publication, executor
deletion, and the final checks remain open. No commit or release occurred.
This unit does not establish net runtime reduction.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/cell-input.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-execution-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-kernel.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-execution.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Fresh approval through the declared cell tool

A new RPC acceptance check starts the actual compiled worker through `CellTool`.
The source records a host effect, requests approval, then contains a second host
effect. Both allow and deny enter the actor's waiting state. Before the response,
the first effect exists once and no decision has been recorded. After the
response, the host tool records exactly one decision. Its body runs twice because
the host resumes from its approval boundary. The outer source does not restart,
and its second effect never runs.

The final transcript contains one failed outer cell result with `stateLost: true`
and completed receipts for the first effect and the approved or denied operation.
The model then receives this result and produces the expected final answer.
This verifies fresh suspension through the normal runner, unlike the earlier
seeded recovery fixture. It does not prove host restart or multiple approval
points within one host operation. Those cases remain open.

The focused check passed 1 test and 17 assertions at
`/tmp/gent-cell-fresh-approval-focused.log`. The full gate exited 0 at
`/tmp/gent-cell-fresh-approval-gate.log`. `git diff --check` passed. The initial
test command exposed an unsupported test API (`it.scopedLive.skipIf`); the test
now uses the established `describe.skipIf` wrapper. No runtime change was needed.

Default catalog discovery, explicit reset, bounded recursive children, release,
executor deletion, and final checks remain unfinished. No commit or release
occurred. This proof does not establish net runtime reduction.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-approval.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-recovery.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Declared cell tool and structured failure results

`CellTool` now declares the model-facing input, output, and execution body. The
RPC lifetime fixture uses this declaration instead of its own tool adapter.
The declaration returns saved JSON success data. It reports saved JSON failures
through the public `ToolResultFailure` error type. The existing runner creates
the final failed transcript part with the current call ID and tool name. Tools
cannot use this type to choose another result identity. Existing permissions,
preflight, completion events, and bound execution remain in the same path.

The RPC cancellation assertion now checks the saved `CellKernelError` tag,
`cancelled` reason, and `stateLost` flag in the failed result. This would fail if
the runner reduced the error to text or wrapped it as a successful result.
Focused cell and runner checks passed 15 tests and 51 assertions at
`/tmp/gent-cell-tool-focused.log`.

The declaration also maps `CellToolCallSuspended` back to its original pending
interaction. This preserves the actor control channel rather than reporting a
normal tool failure. A fresh approval through the declared tool still needs a
real RPC check; the existing recovery test only proves the seeded recovery path.
The final full gate exited 0 at `/tmp/gent-cell-tool-verified-gate.log`.

The declaration is not installed in the default model profile. Catalog discovery,
explicit reset, fresh approval validation, recursive children, source-mode worker
resolution, publication, and deletion remain open. No commit or release occurred.
No net runtime reduction is claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/tool-output.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-runner.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Cell entry failures and nested-call rejection

Cell dispatch now returns a typed `AgentLoopError` when branch ownership or
recorded turn context is absent. It does not acquire a worker or invent a call
address for those entries. A focused test checks the missing-owner error.

The real RPC lifetime test now calls the outer `cell` tool from inside a cell.
The worker catches the explicit nested-dispatch error. It then checks that the
attempted nested source did not change its retained value. This proves rejection
without a recursive admission deadlock. The same run still checks separate
receipts for identical sources, branch isolation, cancellation, and worker exit.

Focused checks passed 2 tests and 15 assertions at
`/tmp/gent-cell-entry-focused.log`. The full gate exited 0 at
`/tmp/gent-cell-entry-gate.log`. No commit or release occurred. The default cell
surface and result contract remain the next integration task. This unit does not
complete the goal or establish net runtime reduction.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-dispatch.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Host-owned outer call dispatch

The shared tool dispatcher now supplies the exact assistant message and tool
call address through `CurrentToolCall`. Both model turns and explicit tool
invocation supply this address. The cell dispatch adapter uses that address and
the live publication to call the branch-owned execution service. It does not
search transcript text or accept a model-selected call address. It rejects nested
outer dispatch from an inner cell operation before admission.

The RPC lifetime fixture now uses this production adapter. Its old source-text
message search is removed. Two identical sources in one assistant response now
increment retained state separately and produce distinct result IDs. The same
test still checks branch isolation, retained state, active cancellation, and
worker cleanup. Focused checks passed 2 tests and 37 assertions at
`/tmp/gent-cell-dispatch-focused.log`. The full gate exited 0 at
`/tmp/gent-cell-dispatch-verified-gate.log`. The first gate found a test type
narrowing error and a forbidden ternary; both were fixed before the final gate.

The default cell declaration and structured result contract remain unfinished.
Direct invocation without a branch-owned execution service still needs an
explicit failure path. Nested-dispatch rejection needs a behavioral check.
Recursive children, source-mode worker resolution, published shared evaluator,
old executor deletion, and the final completion checks remain open. This unit
does not establish net runtime reduction. No commit or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/current-tool-call.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-dispatch.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Active cell cancellation

The existing actor interrupt path now calls `CellExecution.cancel`. The service
signals active evaluation and waits for the execution permit. Evaluation
interruption closes the worker and waits for host cleanup. It saves a failed
outer receipt with a visible cancellation and possible-effects message. It does
not replay the source. Explicit reset is required after worker state loss.

A cancellation epoch stops calls already queued for the permit. The branch's
existing interrupt flag also blocks later calls from that interrupted turn. A
cell rejected before evaluation reports that it did not start, rather than
claiming that its code ran or that existing worker state was lost.

The RPC test now interrupts a CPU-bound cell after a recorded host call. It
observes process exit within two seconds, before the normal 30-second cell
deadline. The steering RPC acknowledges delivery through the existing `send`
path; it does not wait for execution. The test checks worker exit separately.
A service integration test covers active host finalizers, a queued cell that
must not run, saved-result reuse, one host execution, failure before reset, and
successful evaluation after explicit reset. Focused checks passed 6 tests and 47
assertions at `/tmp/gent-cell-cancel-verified-focused.log`.

One full-gate attempt failed in the GitReader temporary-directory fixture with
an ENOENT from scoped cleanup. That test is outside the edited runtime paths.
Its focused check passed 10 tests and 26 assertions at
`/tmp/gent-cell-cancel-git-reader-check.log`. The final full gate exited 0 at
`/tmp/gent-cell-cancel-verified-gate.log`. No GitReader source changed.
`git diff --check` passed after the documentation update.

Default model dispatch, source-mode artifact resolution, recursive children,
release, deletion, and final race/security/E2E/Herdr checks remain unfinished.
No commit, push, merge, or release occurred. Runtime source grew in this unit;
no net reduction is claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-kernel.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.worker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-execution.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/tests/librarian/git-reader.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Branch-owned lazy cells

The existing branch loop scope now builds `CellExecution.Branch` and supplies
its service to turns. The layer selects the compiled `gent-cell` beside the host
executable. It does not start a process during construction. Each branch has a
separate cell service and worker. Loop scope closure owns worker cleanup.

A real RPC test uses an explicit test tool to invoke the service with the saved
outer call and the real recorded host. It retains a value across turns, proves
that a second branch has separate state, and verifies that both worker PIDs no
longer exist after server scope closure. The test adapter is not the default
model surface. Initial production cell dispatch still needs implementation.

The earlier recovery RPC test now declares a model agent and checks its final
answer. Previously it proved recovered results and sibling execution, but did
not prove successful model continuation. Both RPC tests now pass. Focused checks
passed 6 tests and 63 assertions at `/tmp/gent-branch-cell-verified-focused.log`.
The final full gate exited 0 at `/tmp/gent-branch-cell-verified-gate.log`.
`git diff --check` passed after the documentation update.

Code inspection found a remaining cancellation gap. `AgentLoop.interrupt` sets
the interrupted flag and signals the active model stream. The stream handle is
cleared before tool execution. It does not cancel an active cell. Scope shutdown
does close the workers, but that is not proof of command-driven cancellation.
This must be fixed before cell cutover. Source-mode artifact resolution,
recursive children, release, deletion, and final checks remain unfinished.

No commit, push, merge, or release occurred. Runtime source grew in this unit;
no net reduction is claimed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.worker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-recovery.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-execution.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-host.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/test-utils/rpc-harness.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Compiled worker artifact and build-cache repair

The TUI build now produces `apps/tui/bin/gent-cell` beside `gent`. The worker
embeds Bun. It disables automatic dotenv, bunfig, tsconfig, and package.json
loading. The existing sandbox launcher runs it without an external Bun runtime.
No runtime source was added in this unit. Build configuration and tests grew;
this is not a runtime LOC saving.

The first gate reused an old build because Turbo did not hash `scripts/build.ts`.
The TUI package now extends its build inputs with that script directory and
declares both binary outputs. A new build produced the worker. A later cache hit
restored a temporarily moved worker byte for byte. The retained comparison copy
is `/tmp/gent-cell-cache-proof.G1Os62/gent-cell`. Both files had SHA-256
`0a601d2efefa9e60afcd83dcc2822733db01e66ff65731e2e465e36c42bb4b5a`.

The real packaged artifact returned `21` from a host call and `42` in a later
cell using retained data. Focused process tests passed 10 tests and 61 assertions
at `/tmp/gent-compiled-cell-focused.log`. They include compiled-worker execution,
retained data, host replies, reset, empty environment, and denied direct file
reads. Build receipts are `/tmp/gent-compiled-cell-build.log`,
`/tmp/gent-compiled-cell-cache-restore.log`, and
`/tmp/gent-compiled-cell-build-inputs.json`.

Final `bun run gate` exited 0 at `/tmp/gent-compiled-cell-final-gate.log`.
`git diff --check` passed after the documentation update.

Fresh branch dispatch still needs implementation. This unit supplies its worker
artifact prerequisite; it does not select cells in model profiles. Linux
isolation, source-mode artifact resolution, recursive children, default cutover,
old-code deletion, release, and final checks remain unfinished. No commit, push,
merge, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/scripts/build.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/turbo.json`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/turbo.json`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/main.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-process.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-sandbox.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-worker-fixture.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-process.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Saved cell routing through the branch actor

The branch turn recovery path now reads cell admission without creating a claim.
It routes admitted cells through recorded recovery before native binding replay.
An undecided inner approval keeps its original request ID. The actor parks with
the outer cell call ID. The normal response RPC resumes the inner operation.
The outer source never runs again. Recovered results join native sibling results
in one complete transcript message. Existing runtime context owns the storage
dependencies; this adds no second runtime or persistence owner.

The RPC acceptance test seeds the crash gap before actor startup. It covers an
incomplete cell, a saved completed cell, and an undecided inner approval followed
by a real response RPC. All three retain a native sibling result. The cell tool
implementation runs zero times. The approval tool runs once to request approval
and once after the response. This is inner-tool cold resume, not arbitrary
exactly-once tool execution or continuation of the discarded JavaScript stack.

Validation: full `bun run gate` exited 0 at
`/tmp/gent-cell-actor-final-gate.log`. Focused tests passed 16 tests and 160
assertions at `/tmp/gent-cell-actor-verified-focused.log`. `git diff --check`
passed. Sideshow was unavailable at localhost:8228. No commit, push, merge, or
release occurred. This unit adds runtime code; it does not prove net reduction.

Initial model dispatch, branch-owned kernel wiring, recursive children, published
shared evaluator consumption, default cutover, old-code deletion, and final
trust/E2E/Herdr checks remain unfinished. The full goal remains active.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.runtime-context.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-recovery.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-host.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-execution-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-persistence.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/cell-recovery.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-execution-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Stage 1: inactive runner removal

Removed the unselected `SubprocessRunner` and its `subprocessBinaryPath` option.
Removed runner-only database and server URL fields from `AgentRunnerConfig`.
Kept the normal durable and ephemeral child paths. Kept run-spec CLI coverage.
Updated the architecture reference. Existing FX and architecture edits remain.

The runner source and its configuration have 215 fewer lines against HEAD.
This is a narrow count, not a total goal reduction. The dependency selection
branch also lost 18 lines and its option declaration lost one line.

Validation: `bun run gate` exited 0 after the changes.
Log: `/tmp/gent-rlm-stage1-gate.log`. `git diff --check` passed.

Removed the now-unused `sharedServerUrl` configuration propagation in the server
and SDK. The removed `GENT_SHARED_SERVER_URL` environment option had no remaining
consumer. The shared server URL used for client connections remains unchanged.
The full gate exited 0 again. Log: `/tmp/gent-rlm-stage1-config-gate.log`.

Baseline counts are in `plans/bun-rlm-baseline.md`. The local deny-by-default Bun
process check is in `plans/bun-kernel-macos-proof.md`. It passed the listed probes,
but it is not a complete isolation proof. Stages 3–5 have not started.

Removed the unused session-controller spinner, its random frame selection, and
its clock subscription. Kept the visible phase label and thinking words. Kept
the shared spinner clock because other widgets use it. The full gate passed:
`/tmp/gent-rlm-stage1-activity-gate.log`.

Additional source receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-controller.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session-controller-activity.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/tests/composer-render.test.tsx`

Changed source receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.config.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/dependencies.ts`

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/execution-overrides.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/server/src/main.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/sdk/src/server.ts`

## Stage 2: evaluation boundary check

A local Bun check used `Bun.Transpiler` with `replMode: true` and `node:vm`.
The first cell declared `values = [1, 2, 3]`. The second awaited a supplied
host function and stored `total = 7`. The third returned `[1, 2, 3, 7]`.
A fresh context returned `undefined` for `typeof values`.

The same check evaluated `host.add.constructor("return typeof process")()`.
It returned `"object"`, although the context contained only the host object.
The check read no environment values and performed no filesystem or network work.
Removing ambient globals does not confine an injected host function. Do not use
this VM boundary as the enforcement point for Gent tool permissions.

This is a narrow evaluation check, not a worker, recovery, or confinement proof.
The production worker remains unimplemented. Inspect a process-level isolation
boundary before default cutover; do not substitute a JavaScript subset for the
requested Bun kernel without an explicit scope decision.

## Stage 2: evaluator boundary

Added the internal Bun evaluator and its Effect host-call service. It uses the
Loom replMode/context design without importing the Loom daemon. It is not wired
to Gent model execution. It must run inside the isolated process owner, which
does not exist yet. It is not an additional default execution path.

Six focused tests passed, with 16 assertions. They cover retained data, top-level
await, reset, separate contexts, source/display limits, invalid host arguments,
host replies during an active cell, and failures without replay. These are
evaluator checks, not process-protocol or durable approval checks.

The final full gate exited 0 after these changes.
Log: `/tmp/gent-rlm-evaluator-gate.log`. `git diff --check` passed.

Source and display limits currently count JavaScript string units. The process
protocol still needs byte limits. Cancellation, worker death, publication leases,
host permissions, durable operation receipts, and recursive children remain.
The shared library extraction also remains; do not count the local evaluator as
a completed Gent/Loom shared kernel.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/bun-evaluator-boundary.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/bun-cell-evaluator.test.ts`

## Stage 2: bounded process protocol

Added typed request/reply messages for evaluation, reset, startup, and host calls.
Moved the shared evaluation schemas out of the Bun adapter so the parent can
read the protocol without importing the VM implementation.

The frame reader holds at most one MiB of unfinished frame bytes. It decodes
UTF-8 only after a complete newline-delimited frame arrives. It rejects malformed
UTF-8, truncated final frames, and oversized frames. Encoders also enforce the
byte limit. Each pipe must own one reader and stop on its first protocol error.

Eleven focused evaluator/protocol tests passed, with 23 assertions. The final
full gate exited 0. Log: `/tmp/gent-rlm-protocol-gate.log`.
`git diff --check` passed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-protocol.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-protocol.test.ts`

## Stage 2: worker loop and stdio entry

Added the worker loop, its serialized stdio transport, and its private process
entry. The input loop continues while a cell awaits a host reply. It admits one
cell at a time. It rejects overlapping evaluation/reset requests and stale host
replies. It bounds pending host calls at 32 and total calls per cell at 4,096.
If a cell ends with pending host calls, the worker fails. The parent must treat
those effects as potentially incomplete, not replay the cell.

Six worker-loop tests passed, with 20 assertions. They cover host replies,
retained values, reset, overlapping requests, stale replies, host errors, and
the pending-call limit. The full loop gate exited 0 at
`/tmp/gent-rlm-worker-gate.log` before the process entry was added.

A separate real-process check launched the private entry with an empty
environment. The worker sent Ready, sent HostCall, accepted HostSucceeded,
returned Evaluated with display `42`, and acknowledged Reset. The check stopped
the process and awaited its exit. This check did not use an OS sandbox.

The same real-process check passed again after the entry-point scope correction.
The final full gate exited 0 at `/tmp/gent-rlm-worker-entry-gate.log`.
`git diff --check` passed. The four kernel source files now total 425 raw lines.
This is new implementation cost, not a claimed net reduction. The old executor
remains until cutover validation passes.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-worker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/main.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-worker.test.ts`

Next: implement the parent process owner and prove isolated launch, readiness
timeout, evaluation timeout, cancellation, and process loss. Add tests against
the real process boundary. No Gent model profile uses this worker yet. The host
permission, publication-lease, durable approval, and recursion work remains.

## Stage 2: generated sandbox and isolated worker

Added the macOS profile builder. The real bundled worker passed the isolated
pipe and access checks using that builder. Read/write/process denials returned
EPERM. Network denial used a verified live listener. VM import restrictions are
recorded separately from OS denials. The final full gate passed.

Exact commands, hashes, limits, and full source paths are in
`plans/bun-kernel-macos-proof.md`, under the 2026-09-07 built worker check.
The process owner, timeout/recovery tests, and Linux support still remain.

## Stage 2: scoped parent process boundary

Added `openMacosCellProcess`. It resolves the runtime and worker paths to regular
files, generates the sandbox profile, and launches with a replacement empty
environment. The caller must own immutable trusted artifacts. No insecure
fallback exists.

The process boundary keeps one stdin writer, an eight-frame outbound queue, a
bounded frame reader, and an 8 KiB diagnostic buffer. It drains excess stderr
without retaining it. It observes process exit and pipe failures. Scope closure
stops the child through the Effect process owner, with force-kill escalation.
Explicit stop waits for termination and closes later sends.

Two real-process tests passed, with nine assertions. They compile the actual
worker into scoped temporary storage and launch it under the sandbox. They
check host request/reply, empty worker environment, scope cleanup, explicit stop,
and rejection of later sends. These tests explicitly skip non-macOS hosts.

The full gate exited 0 after the final change.
Log: `/tmp/gent-rlm-process-final-gate.log`. `git diff --check` passed.

The pinned process API's `kill` waits for its exit event. Reading `exitCode`
after signal termination fails because no numeric code exists. The stop path
uses the completed kill operation instead. No dependency workaround was added.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-process.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-process.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/unstable/process/ChildProcess.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/unstable/process/ChildProcessSpawner.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/.bun/@effect+platform-node-shared@4.0.0-rc.112+11eac7cfbf53fc55/node_modules/@effect/platform-node-shared/dist/NodeChildProcessSpawner.js`

Next: build the small evaluate/reset/close owner over this process boundary.
It needs readiness and evaluation deadlines, bounded crash replacement, explicit
lost-state outcomes, and tests for interruption and worker failure. Do not replay
an effectful cell during replacement. The Gent host-policy integration remains.

## Stage 2: readiness deadline and persistent reply reader

The process boundary now owns one persistent stdout reader and an eight-frame
incoming queue. Reading one reply no longer closes the underlying process pipe.
The first reply must be Ready. Duplicate Ready messages fail the protocol.

Opening waits for Ready with a five-second default deadline. The caller can
supply a positive integer timeout. On failure or interruption, the boundary
stops the process before returning. A failure during this required cleanup stays
visible as a defect; it is not silently ignored.

Four real-process tests passed, with 18 assertions. The added checks cover
successive reply reads and a worker that loops before Ready. The timeout check
captures the worker PID through bounded stderr and verifies that the process is
gone before the opening call returns its timeout error.

The full gate exited 0 after the final change.
Log: `/tmp/gent-rlm-readiness-final-gate.log`. `git diff --check` passed.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-process.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-process.test.ts`

The evaluate/reset/close owner, evaluation deadlines, and bounded crash
replacement still remain. The readiness deadline does not replace those checks.

Source receipts:

- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel.ts`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel-worker.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/codemode/src/codemode.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/tool/code-mode.ts`

## Stage 2: evaluation owner and state-loss behavior

The kernel now exposes evaluate, reset, and close over one isolated process.
Evaluate and reset share a permit. Close can stop an active operation. The
evaluation deadline defaults to 30 seconds and accepts a positive integer override.
Process, protocol, and deadline failures close the worker and return a typed
state-loss error. External interruption also closes the worker before returning.
Normal source, compile, and cell execution errors preserve the working state.

Each evaluation gets its host service from the current caller context. The
response reader starts host operations in the evaluation scope. It rejects
wrong cell IDs, duplicate operation IDs, more than 32 pending calls, and more
than 4,096 calls per cell. The parent and worker share the protocol limits.
These transient IDs are not durable operation receipts or permission grants.

Seven real-process tests passed with 38 assertions. New checks prove retained
values after a cell error, current-host selection, reset, deadline termination
of a CPU-bound cell without repeating a host call, and cancellation of a pending
host operation. PID checks prove termination before timeout/interruption returns.
These checks run on macOS and explicitly skip other platforms.

The Effect skill kept host authority in the caller context and cleanup in scoped
effects. The test skill focused the new checks on real process recovery behavior.
The full gate exited 0. Log: `/tmp/gent-rlm-kernel-owner-final-gate.log`.
`git diff --check` passed. No commit, push, or release occurred.

This owner does not yet replace a crashed worker. It is not wired into Gent's
model profile or durable permission/approval paths. Shared Loom ownership,
Linux isolation, memory limits, and default cutover remain required. This unit
adds runtime code; it is not a net reduction claim.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-kernel.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-process.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-protocol.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-worker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-process.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/Effect.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/Stream.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Stage 2: bounded replacement and complete close

The kernel now owns a child scope for each worker. Discard closes that scope
and releases its pipes. Effect removes the closed child scope from its parent.
The kernel retains only the current process handle. It captures platform
services at construction, but still gets host-call authority from each evaluation.

After a worker fault or interruption, evaluation returns `recovery-required`.
Only explicit reset starts a fresh worker. The default limit is three replacement
attempts over the kernel lifetime. The caller can set a non-negative integer
limit. Failed starts consume attempts. A successful cell does not renew the
budget. This is request admission, not an automatic retry or background timer.
It does not replay the failed cell, restore its bindings, or undo host effects.

Close signals active work to stop, waits for its permit and scoped cleanup,
then closes the owner scope. Close cannot be interrupted midway through cleanup.
Further reset and evaluation requests cannot reopen the owner.

Nine real-process tests passed with 54 assertions. The recovery checks cover
reset after timeout and cancellation, missing old bindings, no repeated host
effect, a later worker exit, replacement exhaustion, failed replacement startup,
and close while a host operation waits. The close check verifies host cleanup
and process termination before close returns. These tests are macOS-only.

The full gate exited 0. Log: `/tmp/gent-rlm-replacement-final-gate.log`.
`git diff --check` passed. No commit, push, or release occurred.
The Effect skill guided scope detachment and interruption-safe close. The test
skill guided the real-process recovery checks. No Loom source was changed.

Shared kernel ownership, Linux isolation, memory policy, the Gent host-policy
bridge, durable receipts, default cutover, and net reduction are still required.
This change does not prove those completion requirements.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-kernel.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-process.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-process.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/Scope.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/Effect.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/internal/effect.ts`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel.ts`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel-process.ts`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel-process-lifecycle.ts`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel-supervisor-policy.ts`

## Stage 2: shared evaluator and Loom consumer

The isolated Loom checkout now contains `@cvr/bun-cell`. Loom's existing adapter
uses it. The package owns evaluation only; each host keeps process policy,
authority, and durable state. Its packed artifact passes tests and typechecking
with Gent's pinned Effect version. Both full repository gates passed.

See `plans/shared-bun-cell-proof.md` for exact file paths, logs, package evidence,
source counts, compatibility limits, and the Loom Rift path. The extraction
currently adds 26 combined runtime lines. Gent has not removed its duplicate
evaluator yet. No code relocation is counted as a reduction.

A minor Changeset is ready. Release setup, publication, the published Gent
dependency, and live Pi verification remain unfinished. Release authority was
requested. Work remains local while that request is pending.

## Stage 3: durable outer cell admission

`CellExecutionStorage` now records outer cell claims and results in Gent's
existing SQLite database. Migration 12 adds `cell_executions`. The existing
assistant message keeps the source. The store returns that source only for the
first claim. Eight concurrent requests admit one claimant. Repeat claims return
the completed tool result or `Incomplete`. Incomplete does not prove a live
worker and cannot grant another execution. Results cannot be overwritten.

The store validates workspace, session, branch, assistant role, and exact call
identity. Both binding storage and cell storage now use one owned-call reader.
Deleting an assistant message removes its cell receipts. Claim rejects an outer
SQL transaction: admission must commit before any external effect can start.
No new database, agent engine, scheduler, or VM checkpoint was added.

Five cell-storage tests cover concurrent admission, immutable success/failure,
cross-workspace and cross-branch denial, unclaimed or mismatched results,
corrupt result rejection, deletion, outer transaction rejection, and reopening
a real database with incomplete and completed calls. The focused run passed
36 tests with 133 assertions across cell, binding, and migration tests.
Log: `/tmp/gent-cell-receipt-focused.log`.

The full gate exited 0. Log: `/tmp/gent-cell-receipt-verified-gate.log`.
Earlier failed runs found two typed-decoder suggestions and migration-fixture
expectations. Those were fixed. The version-10 fixture now removes the new
table and all later migration records before testing forward migration.
The Effect and architecture skills guided committed admission and shared
ownership checks. The test skill guided real SQLite and reopen checks.

This unit adds 152 net runtime lines, including the new files. It is not counted
as reduction. The native cell adapter does not use the store yet. Host-operation
bindings, approvals, recursive children, and model cutover are still required.
There is no end-to-end claim that Gent now prevents cell replay. That proof must
cross the final native/RPC execution path. The current goal remains active.
No commit, push, merge, or release occurred. Sideshow remained unavailable.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-execution-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/sqlite/owned-tool-call.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/tool-call-binding-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/schema.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/sqlite-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/message-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-execution-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/tool-call-binding-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/sqlite-session-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/node_modules/effect/src/unstable/sql/SqlClient.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Stage 3: recorded execution through the real kernel

`CellExecution.Live` now fixes a session and branch for one scoped executor.
It uses the existing receipt store and kernel. One permit serializes admission,
evaluation, result storage, and reset. A worker starts only after a fresh durable
claim. The service returns saved successful and failed results without invoking
the host or starting a worker. An incomplete claim fails with
`CellExecutionIncomplete`, including an explicit warning that effects may have
occurred. It does not run the source again. Reusing a result does not restore VM
working state.

The initial kernel acquisition records its handle without an interruption gap.
Failed initial startup consumes the configured worker replacement budget. A
later successful startup receives only the remaining budget. There is no retry
loop. An unused reset does not start a worker. The current branch scope releases
the acquired kernel. Each evaluation still receives its host from its caller.

Three real-process checks cover the new service. The first writes a real file
through the host, retains values across an ordinary cell error, and reuses saved
results. A second owner can reuse the successful result even with a missing
worker path. The second check interrupts evaluation after a real host write,
verifies host cleanup, resets the worker, rejects replay of the old source, and
executes a new cell successfully. The third check fails initial startup, restores
the worker artifact, executes a new cell, crashes that worker, and proves that
the earlier failure consumed the remaining replacement budget.

The new checks and existing process checks passed: 12 tests, 75 assertions.
Log: `/tmp/gent-recorded-cell-focused.log`.
The full gate exited 0. Log: `/tmp/gent-recorded-cell-final-gate.log`.
The first focused run expected only the cell error message, but Bun includes its
stack. The assertion now checks the error tag and message text without assuming
a stack format. The first gate found type-only imports and void test signals;
those were corrected without suppressions.

The Effect, architecture, and test skills guided scoped acquisition, committed
admission, and real file-effect checks. The shared worker-build fixture keeps
the process and recorded-execution checks on the same worker artifact.
This unit adds 150 runtime lines. It is not counted as a reduction.

The model profile does not select this service yet. No final approval-resume
contract was introduced. Native approval resume reruns a pending tool, so the
inner operation must have its own durable identity and result. It cannot use
whole-cell replay. Host permissions/bindings, inner operation receipts, durable
approvals, recursive children, and RPC/default cutover remain unfinished.
No commit, push, merge, or release occurred. Sideshow remained unavailable.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-kernel.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-process.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-protocol.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-execution-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-binding-replay.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-profile.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-execution.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-process.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-worker-fixture.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Stage 3: bound tool adapter and host approval signal

`runCellToolCall` now adapts one host request to the real `ToolRunner.runBound`.
It requires an explicit Permission service. It executes the supplied capability,
not a fresh name lookup. A missing binding does not fall back to the registry.
It rejects a request name that does not match the supplied capability. Input
validation, hooks, permission checks, events, and tool result encoding remain
with ToolRunner. The adapter checks the JSON boundary and returns ordinary tool
failures as cell evaluation errors.

Pending approval is different. `CellToolCallSuspended` preserves the request,
operation ID, and host tool-call ID. The kernel passes this signal to its caller,
closes evaluation scope, and discards the worker. It does not send a HostFailed
reply for this signal. Thus cell JavaScript cannot catch approval suspension
and continue. Recorded execution passes suspension through without completing
the outer claim. A later evaluation of that same cell remains forbidden.

The adapter tests use the real ToolRunner, permission policy, and in-memory event
store. They cover a selected capability when the registry has another handler
under the same name, invalid input, denied permission, a mismatched name, missing
binding, and exact pending identity. The pending tool emits the typed signal in
this test; this is not a proof of durable approval storage or resume. The real
worker test tries to catch that host signal and run another host operation.
Only the first host call runs. Reset allows a new cell but does not replay the
old one. No publication reload or durable inner-operation resume is proved here.

The focused run passed 15 tests with 90 assertions across the tool adapter,
recorded execution, and process tests. Log:
`/tmp/gent-cell-tool-host-verified-focused.log`.
The full gate exited 0. Log: `/tmp/gent-cell-tool-host-final-gate.log`.
An initial typecheck exposed a union inference gap in the error callback. An
explicit Effect return type preserves both StorageError and suspension; no cast
or suppression was added. Final formatting and diff checks passed.

The Effect, architecture, and test skills guided error-channel separation and
reuse of the real tool runner. These changes add runtime code. They are not
counted as reduction. The model profile still does not select the new cell path.
The caller still must record the inner binding and hold its publication lease.

Next required boundary: persist inner operation identity/input/result before
resumable dispatch. The current interaction service correlates pending approval
by session and branch, not by tool-call ID. The resume adapter must select the
exact recorded operation before it consumes that branch resolution. Parallel
host requests must not let another operation consume it. This must be proved
with the real interaction store and RPC path before default cutover.

No commit, push, merge, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-call.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-kernel.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-runner.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-profile.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/extensions/resource-host/resource-leases.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/interaction-request.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/event-publisher.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-tool-call.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-execution.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-process.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/tool-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Stage 3: one validator for stored operation bindings

`resolveStoredToolBinding` now owns the loaded-source, schema, resource, and
dynamic replay checks for an already-owned durable binding. It does not assume
that the binding came from an assistant-message tool-call row. Native replay
uses it after the existing storage ownership check. The missing-row policy and
same-process fallback remain in the native adapter. Failed stored-binding
validation still removes the native process-local binding.

This lets inner cell receipts use the same policy without fake model messages
or a second binding validator. The caller must still verify receipt ownership
and hold the publication lease. The helper does not grant either authority.
It also does not authorize replay of arbitrary cell source.

A new test uses the real registry and runner without any message storage layer.
It accepts the matching stored binding, rejects a changed source, and rejects
a dynamic non-replayable binding. The existing replay matrix still passes.
Focused result: 18 tests, 39 assertions.
Log: `/tmp/gent-stored-binding-verified-focused.log`.
The full gate exited 0. Log: `/tmp/gent-shared-binding-gate.log`.
Final formatting and diff checks passed.

The Effect and architecture guidance kept storage ownership outside identity
validation. No policy was weakened. No reduction is claimed for this extraction.
Durable inner-operation storage, approval resume, recursive children, and model
cutover remain unfinished. No commit, push, merge, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-binding-resolution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-binding-replay.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/tool-call-binding-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/tool-binding-replay.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/AGENTS.md`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Stage 3: durable inner-operation storage

Migration 13 adds `cell_tool_operations` to the existing SQLite database.
`CellToolOperationStorage` owns admission, lookup, suspension, resume admission,
and result recording. Each record belongs to an admitted outer cell. It keeps
the original input and binding, plus a deterministic inner tool-call ID derived
from the outer call and operation ID. Equal duplicate admission does not grant
another execution. Changed input or binding fails. Completed results are
immutable and must match the bound tool and derived call ID.

States are Started, Waiting, Resuming, and Completed. Only Waiting with the exact
request ID and a valid saved decision can commit Resuming. Both approval and
denial decisions retain their content. Resuming cannot claim another attempt,
including after database reopen. Admission and resume reject an outer caller
transaction so their claim commits before external work. A completed outer cell
cannot admit or resume further effects. Message deletion cascades to operations.

The existing interaction store remains the owner of requests and decisions.
A unique request link prevents two operation rows from sharing an approval.
The read boundary checks the request link and call/result identity. The store
does not execute a tool, consume a decision through ApprovalService, or restore
a worker stack. These are receipts, not a second scheduler or database owner.

Five new storage tests cover concurrent admission, canonical input comparison,
immutable inputs/bindings/results, result identity, missing outer admission,
approval ownership, invalid and denied decisions, single resume admission,
workspace/branch isolation, transaction rejection, completed-cell rejection,
deletion, and reopening the real database before and after resume admission.
The focused run passed 31 tests with 142 assertions across operation, outer-cell,
and migration storage tests. Log: `/tmp/gent-cell-operation-verified-focused.log`.
The full gate exited 0. Log: `/tmp/gent-cell-operation-final-gate.log`.
The migration fixture removes child operation records before rebuilding its
older parent schema. Initial checks found a typed-decoder suggestion and a
named tagged-state predicate rule. Both were fixed without suppressions.

The Effect, architecture, and test guidance shaped transactions, ownership,
typed state, and real database checks. This unit adds 295 runtime lines across
the repository, migration, and wiring. No reduction is claimed. No commit, push,
merge, or release occurred.

Required next integration at this checkpoint: atomically persist the interaction request and its
operation link before publishing the approval event. A crash between those
writes must not leave an unowned pending request. Then connect stored operation
admission to the host adapter, validate the saved binding under its publication
lease, and resume only the selected operation through the real approval and RPC
path. The model profile and default cutover remain unfinished.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-tool-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-execution-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/interaction-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/schema.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/sqlite-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-tool-operation-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/sqlite-session-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md`

## Atomic cell approval storage

The operation store now accepts a new approval record for suspension. It uses
InteractionStorage to insert that record and links the operation in one SQLite
transaction. Failure rolls back both writes. Suspension rejects caller-owned
transactions, completed cells, another branch, and requests that already have a
decision. Repeated suspension fails instead of inserting a second request.

The real SQLite test forces the link update to fail after request insertion.
No pending request remains, and the operation remains Started. The same test
then proves successful storage of both records. Existing restart and decision
tests now use the atomic operation.

Validation: six focused tests passed with 46 assertions. Full gate exited 0.
Logs: `/tmp/gent-cell-atomic-approval-focused.log` and
`/tmp/gent-cell-atomic-approval-gate.log`.

This change adds 17 runtime lines. It does not prove net reduction. The runtime
approval callback still needs to use this store before event publication.
Exact operation resume, model integration, and the remaining plan are unfinished.
No commit, push, merge, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-tool-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/interaction-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/sqlite-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-tool-operation-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/dependencies.ts`

## Cell approval callback and exact decision selection

The production approval callback now uses atomic operation suspension when the
host supplies CurrentCellToolOperation. ApprovalService checks the admitted
operation and its branch. Started operations select no old decision. Resuming
operations select their exact saved request. Missing selected decisions fail
without creating a replacement request. Native branch replay remains unchanged.

The existing database permits one pending approval per branch. The integration
test confirmed this constraint. A second operation fails without consuming the
first saved decision or changing its own Started state. After the first decision
is consumed, the second operation can request approval. The test preserves denial
content and prevents repeated consumption of the first decision.

The test uses the production dependency graph and real SQLite. An event insertion
trigger rejects InteractionPresented unless both approval and operation link
already exist. This verifies ordering through the actual storage callback.
The earlier transaction test verifies rollback and caller-transaction rejection.

Focused validation passed 22 tests with 130 assertions across operation storage,
interaction mechanics, interaction commands, and native tool replay RPC tests.
Log: `/tmp/gent-cell-approval-wiring-verified-focused.log`.

The runtime host still needs to provide the operation address after admission,
hold the publication lease, validate the saved binding, and save tool outcomes.
The cell model profile, recursive children, and default cutover remain incomplete.
This unit adds runtime code. It does not prove net reduction or full cell resume.
No commit, push, merge, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/interaction-request.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/approval-service.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/current-cell-tool-operation.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-tool-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/schema.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-tool-operation-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/domain/interaction-request.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/server/interaction-commands.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/server/tool-replay-rpc.test.ts`

Full gate exited 0: `/tmp/gent-cell-approval-wiring-final-gate.log`.

## Recorded cell tool host

The private cell host now joins operation admission, bound execution, approval,
and result storage. Each call enters the existing live turn publication lease.
It checks the host branch and captures the exact capability with source identity.
The store commits the immutable operation before the tool can run. The host gives
the approval service that operation address. It saves the original tool result
before returning JSON or a cell error. Completed repeats use the saved result.
Unfinished repeats report an unknown outcome without another execution.

The tool adapter now separates execution from result conversion. This permits
storage of failed results as well as successful results before worker delivery.
No second executor, scheduler, or persistence owner was added.

The integration test uses the production root, real tool runner, live publication,
host facade, approval service, and SQLite. It proves successful result reuse,
failed validation result reuse, durable approval ownership, and interrupted work
without a second execution. The focused run passed 10 tests with 76 assertions.
Log: `/tmp/gent-cell-recorded-host-verified-focused.log`.
The full gate exited 0: `/tmp/gent-cell-recorded-host-verified-gate.log`.

The test gate first found an optional publication type, an incorrect test timeout
argument, and a finite-number schema suggestion. These were fixed without casts
or suppressions. An empty-struct test accepted its array input; the test now uses
a required boolean field to exercise actual validation failure.

This unit adds 98 runtime lines. Net reduction is not proved. The model path does
not select this host yet. The next unit must resume only the recorded inner tool
after exact saved-binding validation. It must not replay the outer cell source.
Recursive children, default cutover, and final plan checks remain unfinished.
No commit, push, merge, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-host.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-call.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-profile.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-binding-resolution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-binding-replay.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-runner.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/make-extension-host-context.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-tool-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-tool-host.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-tool-call.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-tool-operation-storage.test.ts`

## Exact inner-operation resume

The host now has an explicit resume operation. It reads the owned receipt and
checks the saved binding through the shared native replay policy. The existing
live publication lease covers validation, resume admission, tool execution, and
result storage. Only a matching Waiting request with a saved decision can commit
Resuming. The resumed tool receives its original input and inner call ID. The
host stores its original result. This path has no evaluator or outer-source call.

The tool adapter accepts only the request fields it uses. Resume does not create
a fake worker frame or synthetic assistant message. Native errors keep their
typed binding, storage, or lease reason for the eventual command adapter.

Tests prove wrong-request rejection, denial, one execution for two concurrent
resume requests, repeated-resume rejection, and an unchanged incomplete outer
cell receipt. A file-backed test closes the production server scope, reopens its
database, consumes the recovered approval, and checks the same tool-call ID.
It then opens a new scope with changed tool source. Resume fails with
SourceMismatch before admission; the operation stays Waiting and the changed
tool does not execute. This is a real server-scope/database recovery check, not
a subprocess crash test.

Focused validation passed 27 tests with 124 assertions across the cell host,
operation storage, and shared native binding replay tests.
Log: `/tmp/gent-cell-resume-verified-focused.log`.
The full gate exited 0: `/tmp/gent-cell-resume-final-gate.log`.

This unit adds 51 runtime lines. Net reduction remains unproved. The interaction
command router and model profile do not call this path yet. Worker continuation
is not restored. An inner tool can repeat work before its approval point, as in
the existing cold native tool protocol; this is not exactly-once execution for
arbitrary tool internals. Outer cell source is never replayed by this path.
No commit, push, merge, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-host.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-call.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-binding-resolution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-profile.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/approval-service.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-tool-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-tool-host.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/tool-binding-replay.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-tool-operation-storage.test.ts`

## Durable approval route and actor integration trace (superseded lookup)

CellToolOperationStorage now finds an operation by request ID within an exact
workspace, session, and branch. It validates the stored address and owned outer
cell before returning the key and operation. Missing or out-of-scope routes return
None. Corrupt owned records fail. The lookup preserves Completed receipts and
does not grant admission. It uses the existing unique request link and database.

The real storage test checks missing requests, exact ownership, cross-workspace
and cross-branch access, completed lookup, and no second admission. Focused tests
passed 10 tests with 92 assertions. Full gate exited 0.
Logs: `/tmp/gent-cell-approval-route-focused.log` and
`/tmp/gent-cell-approval-route-gate.log`.

The response trace confirms that InteractionCommands saves the decision, calls
SessionRuntime, and wakes the branch actor. The worker changes WaitingForInteraction
to Running, but currently drops the pending request ID. Turn recovery then invokes
native pending tools from the saved assistant message. Cell resume must enter here,
not run independently in the server handler. The latter would bypass actor ordering
and cancellation.

At this checkpoint the proposed integration was to retain the selected request in the Running checkpoint,
resolve its durable cell route inside turn recovery, and reuse or resume only
the inner operation. It must save a paired outer result that states the worker
continuation was lost. It must not invoke the native outer cell tool again.
Recovery must also handle a committed inner result before the outer result is
saved. The existing complete-cell receipt can close that persistence gap once
the turn adapter uses it. Mixed sibling results must not mark the whole step
complete early.

This unit adds 51 runtime lines. The actor routing is not implemented yet.
The full goal remains incomplete. No commit, push, merge, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-tool-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-execution-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/interaction-commands.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.worker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-tool-operation-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-tool-host.test.ts`

## Recover from the outer cell, not the transient phase

Further inspection corrected the preceding checkpoint proposal. The queue's
persistRuntimeState writes the queue row, then changes LoopState in memory.
It does not store the complete Running state. The persisted in-flight item has
the user message and turn options, not the approved request ID. Adding a field
only to Running would not provide durable recovery.

The unused request-ID lookup was replaced with listForCell. It validates the
admitted outer cell and returns all its operation receipts in a stable order.
It includes Started, Waiting, Resuming, and Completed records without claiming
another execution. It rejects another workspace or branch. Recovery can derive
the waiting request from its operation, and can distinguish a saved inner result
from an unknown outcome after the approval row has already been consumed.
No actor field, checkpoint table, or second persistence owner was added.

Real storage tests cover mixed completed/started receipts, ownership rejection,
and lookup after reopening the database in Waiting and Resuming states. The
focused run passed 10 tests with 95 assertions.
Log: `/tmp/gent-cell-recovery-route-focused.log`.
The full gate exited 0: `/tmp/gent-cell-recovery-route-final-gate.log`.
An initial typecheck requested the typed schema decoder for already-typed SQL
rows. The code now uses that decoder without a suppression.

This replacement removes 16 runtime lines relative to the preceding lookup.
It does not prove whole-plan net reduction. Actor turn recovery is still not
wired. The next adapter must inspect receipts from the saved assistant cell,
resume only a waiting approved inner call, and report lost worker continuation
without rerunning the outer tool. It must reuse already completed inner and
outer results after any gap between their writes. Normal native tool replay
must retain its current route.

No commit, push, merge, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.queue.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-loop.worker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/agent-loop-queue-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-tool-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-tool-operation-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-tool-host.test.ts`

## Paired outer recovery result

The recovery adapter reads all inner receipts for an admitted outer cell. It
checks the host branch. An undecided approval returns the same suspension signal
without executing a tool. A waiting operation with a saved decision enters the
existing exact-binding resume path. Completed receipts are reused. Started and
Resuming operations remain unknown and do not receive another execution attempt.

Recovery saves a failed outer tool result with stateLost and an explicit no-source-
replay message. The result separates completed inner tool results from unknown
operation identities. A repeated recovery returns the immutable saved outer
result. No evaluator, worker startup, or worker continuation is used here.

The tests cover undecided suspension, branch mismatch, unknown interrupted work,
saved result reuse, and real file-backed server-scope recovery. They also cover
the gap where one inner operation completed before the outer result was saved:
after reopening, that completed operation is not repeated, the other approved
operation resumes, and the paired outer result is saved and reused.
Focused validation passed 15 tests with 133 assertions.
Log: `/tmp/gent-cell-recovery-verified-focused.log`.
The full gate exited 0: `/tmp/gent-cell-recovery-final-gate.log`.

The adapter adds 80 runtime lines. Whole-plan net reduction is still unproved.
The branch owner must stop cell execution before calling recovery. Actor routing
must enforce this rule and preserve sibling results. That routing, initial model
cell dispatch, recursive children, default cutover, and final checks are still
unfinished. No commit, push, merge, or release occurred.

Sources:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-recovery.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-tool-host.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-execution-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/cell-tool-operation-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/storage/interaction-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-tool-host.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-execution-storage.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/storage/cell-tool-operation-storage.test.ts`
