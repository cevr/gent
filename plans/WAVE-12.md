# Planify: Wave 12 — Corrective Substrate Closure + Simplification

## Context

Wave 12 was originally written as a post-W11 verification pass. That
premise is false at HEAD `b42bda57b5ae3ca66b945943943120c612a9c5ca`.
The gate was green before this planning audit (`bun run gate`), but the
tree still carries the W10/W11 surfaces the old plan assumed were gone:
`Capability`, `Intent`, `Projection`, `Resource.layer`/subscriptions,
`pulseTags`, `actorRoute`, `protocols`, string `resources`, and
hand-set `idempotent`.

This wave therefore changes from "verify the settled substrate" to
"close the substrate honestly, then recursively verify it." The
simplification audit against `badlogic/pi-mono` and
`anomalyco/opencode` is included in scope: Gent keeps Effect and its
stronger durability model, but removes abstraction generations peers do
not need for the same feature set.

Research inputs used for this rewrite:

- Codex lane agents: runtime ownership, extension boundaries, provider,
  storage, domain modeling, suppression debt, SDK/TUI, tests, substrate
  consistency, and peer-codebase simplification.
- Opus counsel:
  `/tmp/counsel/personal-gent-860892a9/20260428-124634-codex-to-claude-ed0802/claude.md`
  and
  `/tmp/counsel/personal-gent-860892a9/20260428-125625-codex-to-claude-93fd67/claude.md`.
- External repositories fetched through `okra repo`:
  `/Users/cvr/.cache/repo/badlogic/pi-mono` and
  `/Users/cvr/.cache/repo/anomalyco/opencode`.

## Scope

- **In**: finish the W10 extension-surface collapse; finish the W11
  `needs`/lock-registry migration; remove deleted substrate shapes;
  repair P1/P2 runtime, storage, SDK/TUI, and test findings; simplify
  architecture/runtime/storage while preserving the current feature set;
  update architecture docs; finish with recursive dual-model audit.
- **In**: total rearchitecture when it reduces LOC and keeps Effect as
  the execution model.
- **Out**: compatibility shims, deprecation windows, public legacy
  paths, non-Effect runtime rewrites, switching away from SQLite, and a
  new `keybinds` bucket. The old plan referenced `keybinds`, but the
  codebase does not currently have that bucket; do not invent it in
  this wave without a separate product requirement.

## Constraints

- Stay within Effect.
- Follow `migrate-callers-then-delete-legacy-apis`: no parallel user
  APIs remain at a batch boundary.
- High-blast-radius work is split into reviewable sub-commits. Each
  sub-commit must compile and run the relevant gate before the next one.
- Mechanical migrations go to apply-tier agents with exact recipes,
  import rules, before/after examples, validation commands, and a
  "stop if the file does not fit" instruction.
- After every implementation batch and sub-commit, run a bug-review
  gate before continuing: one fresh Codex review subagent and one
  `okra counsel` review. Any P0/P1/P2 bug finding becomes fix work in
  the same batch; do not proceed to the next batch with unresolved
  review findings.
- No P0/P1/P2 finding may remain after the final recursive audit.
- Every finding and architectural conclusion must cite full paths and
  line numbers.

## Applicable Skills

`planify`, `architecture`, `effect-v4`, `test`, `code-style`, `bun`,
`repo`, `counsel`

## Gate Command

`bun run gate`

Targeted gates between logical units:

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run test:e2e` for lifecycle, PTY, supervisor, or transport
  changes
- focused `bun test <path>` commands before full gate when a batch owns
  a narrow subsystem

## Review Gate

Every Batch 1-12 sub-commit and final batch candidate must pass this
review gate after its verification command and before the next
sub-commit starts:

1. Launch a fresh Codex code-review subagent with the exact diff,
   intended batch scope, relevant plan section, and validation output.
   Ask specifically for bugs, regressions, missing tests, hidden legacy
   compatibility paths, and violations of the Wave 12 invariants.
2. Run `okra counsel` with the same packet and ask Opus to review the
   commit for bugs. Instruct it to launch its own subagents where the
   diff crosses runtime, storage, extension, SDK/TUI, or test
   boundaries.
3. Classify both reviews with the Wave 12 rubric. P0/P1/P2 findings are
   blocking and must be fixed in the current batch, followed by the
   relevant gate and another review gate. P3 findings may be recorded in
   the closeout receipt only if they cannot hide behavior or
   architecture drift.
4. Record the review receipt in the batch notes: Codex subagent id,
   `okra counsel` output path, findings, fixes applied, and the
   post-fix verification command.

---

## Research Synthesis

### Blocking Findings

| Severity | Finding                                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0       | The previous Wave 12 baseline was fiction: it claimed the post-W11 substrate already existed.                                  | `/Users/cvr/Developer/personal/gent/plans/WAVE-12.md:5-28`, `/Users/cvr/Developer/personal/gent/plans/WAVE-12.md:110-119`                                                                                                                                                                                                                                                                                                                                    |
| P1       | Extension authoring still exposes the deleted mixed substrate.                                                                 | `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:217-262`, `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:317-378`, `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:570-608`, `/Users/cvr/Developer/personal/gent/packages/core/src/domain/contribution.ts:79-150`                                                                                                                   |
| P1       | `Capability` still centralizes tools, commands, and RPC through audience/intent routing.                                       | `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:77-97`, `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:131-163`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/capability-host.ts:135-245`                                                                                                                                                                       |
| P1       | W11 `needs`/`LOCK_REGISTRY` did not land; tools still use string `resources` and bool `idempotent`.                            | `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:91-97`, `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:151-152`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/resource-manager.ts:1-79`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:1088-1089`                                                                                      |
| P1       | Actor runtime ownership leaks through `ActorEngine`, `actorRoute`, `protocols`, resource start hooks, and state side channels. | `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:217-218`, `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:351-367`, `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/index.ts:48-74`, `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/connection-runner.ts:19-43`, `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/connection-runner.ts:136-140` |
| P1       | SDK/TUI transport still treats `commands` as transport-public RPC, so `rpc` is not the sole RPC surface.                       | `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts:67-70`, `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handler-groups/extension.ts:233-247`, `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/context.tsx:264-284`                                                                                                                                                                            |
| P1       | The test suite does not yet prove the desired post-W10/W11 contract.                                                           | `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/task-tools/task-rpc.test.ts:46-59`, `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop.test.ts:491`, `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop.test.ts:2911-3014`                                                                                                                                                                |

### Simplification Findings

Gent should keep its features and Effect model, but peers show where the
current architecture is broader than necessary:

- Gent's main loop is 3,893 LOC in one file before helper files, while
  pi-mono keeps the equivalent loop shape concentrated around a plain
  loop and tool executor. Evidence:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:155-234`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:240-352`.
- pi-mono keeps LLM conversion at the provider boundary instead of
  spreading conversion semantics through runtime layers. Evidence:
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:1-4`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:247-255`.
- pi-mono's extension runtime is one imperative registration surface:
  `on(...)`, `registerTool`, `registerCommand`, `registerShortcut`,
  `registerFlag`, and loaded maps. Evidence:
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1069-1145`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1515-1526`.
- opencode's Effect tool contract is a small deep interface:
  `id`, `description`, `parameters`, `execute`, with centralized
  decode/truncation/span wrapping. Evidence:
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/tool/tool.ts:34-43`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/tool/tool.ts:77-148`.
- opencode plugins are `trigger`, `list`, `init` over flat hooks, not a
  dozen contribution buckets. Evidence:
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/plugin/index.ts:40-54`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/plugin/index.ts:259-283`.
- opencode separates typed bus delivery from transactional event
  projection. Evidence:
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/bus/index.ts:30-41`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/bus/index.ts:80-122`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/sync/index.ts:124-185`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/sync/index.ts:234-260`.

---

## Batch 1: `refactor(extensions): introduce final bucket ids and leaf contracts`

**Justification**: the bucket name should be the discriminant. Shared
`Capability` and audience/intent flags keep impossible mixed states
representable.

**Principles**:

- `make-impossible-states-unrepresentable`
- `derive-dont-sync`
- `migrate-callers-then-delete-legacy-apis`

**Skills**: `architecture`, `effect-v4`, `code-style`, `test`, `bun`

**Changes**:

| File                                                                                | Change                                                                                                              | Lines              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/ids.ts`                | Add branded `ToolId`, `CommandId`, `RpcId`; do not add `KeybindId` unless a bucket is introduced.                   | ~1-80              |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`    | Replace `ToolToken` lowering with a standalone `ToolDefinition` leaf using branded id and `needs`.                  | ~70-170            |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts`  | Replace `ActionToken` with `CommandDefinition`; remove `transport-public` command semantics.                        | ~1-160             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts` | Replace `RequestToken` with `RpcDefinition`; RPC becomes the only transport-public extension call shape.            | ~1-170             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`            | Stop exporting `CapabilityToken`, `Audience`, `Intent`, `CAPABILITY_REF`, `ref`; expose only bucket leaf factories. | ~217-262, ~317-378 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/contribution.ts`       | Type `tools`, `commands`, and `rpc` as independent leaves with no shared capability parent.                         | ~79-150            |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/`                    | Add brand/schema roundtrip tests for the new ids and leaves.                                                        | new/updated        |

**Verification**: `bun run typecheck`, focused domain tests, then
`bun run gate`.

---

## Batch 2: `refactor(extensions): migrate builtins to the final leaves`

**Justification**: deleting legacy API before migrating callers would
only move complexity into broken call sites. This batch is mechanical
and should be delegated after the first two worked examples land.

**Principles**:

- `migrate-callers-then-delete-legacy-apis`
- `small-interface-deep-implementation`

**Skills**: `effect-v4`, `code-style`, `test`, `bun`

**Changes**:

| File                                                                                   | Change                                                              | Lines    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/read.ts`          | Convert string `resources`/`idempotent` to `needs`.                 | ~1-80    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts`         | Convert write locks to `needs`.                                     | ~1-80    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts`        | Convert execution locking to `needs`; preserve permission behavior. | ~100-140 |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/network-tools/webfetch.ts` | Convert read/network locking to `needs`.                            | ~1-70    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools/index.ts`       | Move transport calls to `rpc` leaves only.                          | ~1-90    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools/requests.ts`    | Replace `request(...)` compatibility shape with final `rpc(...)`.   | ~1-90    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto-checkpoint.ts`        | Convert checkpoint tool metadata to `needs`.                        | ~1-60    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/ask-user.ts`               | Convert interaction metadata to `needs`.                            | ~1-100   |

**Delegation recipe**:

1. Import-rename rule: old `tool` metadata fields
   `resources`/`idempotent` become `needs: [Tag, ...]`; no string locks
   remain.
2. Transformation rule: read-only services use read locks; mutating
   services use write locks; tools with no shared resource use a `none`
   lock entry.
3. Worked examples: migrate `fs-tools/read.ts` and
   `fs-tools/write.ts` locally first.
4. Validation after each batch of 3-5 files: `bun run typecheck &&
bun run lint`.
5. Stop and report if a file computes resource names dynamically or if
   the needed service Tag has no lock-registry entry.

**Verification**: focused extension tests, `bun run test`, then
`bun run gate`.

---

## Batch 3: `refactor(runtime): delete CapabilityHost and audience dispatch`

**Justification**: once callers are on leaf registries, the shared
dispatcher is pure indirection and keeps the old flag matrix alive.

**Principles**:

- `subtract-before-you-add`
- `make-impossible-states-unrepresentable`
- `fix-root-causes`

**Skills**: `architecture`, `effect-v4`, `test`, `bun`

**Changes**:

| File                                                                                          | Change                                                                          | Lines                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/capability-host.ts`  | Delete; replace with explicit `ToolRegistry`, `CommandRegistry`, `RpcRegistry`. | whole file             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`         | Stop compiling generic capabilities; compile typed leaf registries.             | ~81-150                |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`            | Tool execution resolves through `ToolRegistry`; no audience/intent dispatch.    | ~1088-1197, ~2478-2827 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handler-groups/extension.ts` | Extension requests resolve only through `RpcRegistry`.                          | ~220-260               |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/context.tsx`                      | TUI extension calls target `rpc`; commands stay human-surface only.             | ~264-284               |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts`                   | Delete after final import removal.                                              | whole file             |

**Verification**: RPC acceptance tests, TUI typecheck, `bun run gate`.

---

## Batch 4: `feat(runtime): derive tool concurrency from needs`

**Justification**: W11's structural goal was correct; the implementation
needs to happen for real. Concurrency and replay safety should derive
from service needs, not handwritten strings and booleans.

**Principles**:

- `derive-dont-sync`
- `correctness-over-pragmatism`
- `prove-it-works`

**Skills**: `effect-v4`, `test`, `bun`

**Changes**:

| File                                                                                          | Change                                                                                                  | Lines                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/resource-manager.ts`            | Replace string-resource locking with Tag-backed lock acquisition; delete old API after callers migrate. | ~1-90                  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts` | Add `LOCK_REGISTRY` entries for every host service Tag exposed to tools.                                | ~1-380                 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/tool.ts`                         | Define `NeedsTag`, lock metadata, and `UnknownNeedsTagError`.                                           | ~1-80                  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`            | Use lock registry to schedule parallel/sequential tool execution.                                       | ~1088-1090, ~2478-2827 |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/`                             | Add read/read parallel, read/write serial, unknown tag fail-closed, and replay-safety tests.            | updated/new            |

**Verification**: targeted runtime tests, `bun run test`, then
`bun run gate`.

---

## Batch 5: `refactor(extensions): collapse resource/projection/pulse surfaces into services and reactions`

**Justification**: `resources`, `projections`, `pulseTags`,
`protocols`, and `actorRoute` are parallel ways to say "stateful
service," "derived prompt state," or "react to event." Keep the deep
implementation; remove the shallow public knobs.

**Principles**:

- `small-interface-deep-implementation`
- `composition-over-flags`
- `subtract-before-you-add`

**Skills**: `architecture`, `effect-v4`, `test`, `bun`

**Changes**:

| File                                                                                                           | Change                                                                               | Lines      |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts`                                      | Delete `ResourceContribution`, subscriptions, schedule descriptors after migrations. | whole file |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/projection.ts`                                    | Delete projection primitive; prompt derivation moves to reactions/services.          | whole file |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/read-only.ts`                                     | Delete `ReadOnlyTag` fence if no non-projection caller remains.                      | whole file |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/projection-registry.ts`               | Delete; replace call sites with reaction-driven prompt sections.                     | whole file |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/subscription-engine.ts` | Delete subscription engine.                                                          | whole file |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-publisher.ts`                               | Delete `pulseTags` fanout; publish committed events only.                            | ~36-112    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto.ts`                                           | Migrate projections/pulse behavior to reactions/services.                            | ~700-750   |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/index.ts`                                   | Replace `Resource.start` actor spawn with declared actor/service layer.              | ~48-74     |

**Verification**: extension lifecycle tests, prompt-section regression
tests, `bun run test`, then `bun run gate`.

---

## Batch 6: `fix(runtime): make actor ownership and persistence fail closed`

**Justification**: the actor primitive should own lifecycle and
protocol. Persistence failures must be observable; state side channels
must not become a second runtime.

**Principles**:

- `boundary-discipline`
- `serialize-shared-state-mutations`
- `prove-it-works`

**Skills**: `effect-v4`, `test`, `bun`

**Changes**:

| File                                                                                       | Change                                                                                          | Lines            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts`  | Add behavior-level supervision policy if still needed; remove hardcoded-only restart semantics. | ~455-475         |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-host.ts`    | Surface durable persistence failures instead of suppressing them.                               | ~232-320         |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/actor.ts`                     | Make `ActorRef` construction disciplined and non-structural from tests/callers.                 | ~31-60, ~200-220 |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/connection-runner.ts` | Remove `subscribeState`/`peekView` side channel or move it behind actor protocol.               | ~19-43, ~136-140 |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/actor-engine.test.ts`      | Update actor tests to use public constructors/protocols.                                        | ~48-100          |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/receptionist.test.ts`      | Stop hand-constructing refs.                                                                    | ~1-40            |

**Verification**: actor runtime tests, persistence failure tests,
`bun run gate`.

---

## Batch 7: `refactor(runtime): split the agent loop into a smaller Effect runtime`

**Justification**: pi-mono proves the turn loop can stay conceptually
small; opencode proves streaming, session writes, and tool execution can
be separate without losing feature depth. Gent keeps Effect, durable
checkpointing, queue drain, cold interaction suspension, and provider
abstraction, but splits responsibilities.

**Principles**:

- `redesign-from-first-principles`
- `subtract-before-you-add`
- `small-interface-deep-implementation`

**Skills**: `architecture`, `effect-v4`, `test`, `bun`

**Changes**:

| File                                                                                        | Change                                                           | Lines      |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------- | ------------------------------------------------------------ | ---------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`          | Reduce to orchestration of `Idle                                 | Running    | WaitingForInteraction`; delegate details to focused modules. | whole file |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-processor.ts`      | New: provider stream consumption and turn lifecycle.             | new        |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-executor.ts`       | New: tool dispatch, permission, needs locks, result persistence. | new        |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/queue-runtime.ts`       | New: steering/follow-up/queue drain behavior.                    | new        |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/checkpoint-recovery.ts` | New: durable checkpoint encode/decode and recovery.              | new        |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`    | Delete or shrink to exported domain state only.                  | whole file |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`         | Delete after `tool-executor.ts` owns the behavior.               | whole file |

**Sub-commits**:

- 7.1: extract checkpoint recovery, no behavior change.
- 7.2: extract tool execution, no behavior change.
- 7.3: extract queue runtime, no behavior change.
- 7.4: shrink `agent-loop.ts` orchestration and delete dead helpers.

**Verification**: full agent-loop suite, W8 durable suspension and queue
drain regressions, `bun run test:e2e`, then `bun run gate`.

---

## Batch 8: `refactor(storage): narrow storage and eventing to committed journals`

**Justification**: opencode separates a typed bus from transactional
event projection. Gent currently has event store, SQLite event APIs,
event publisher fanout, pulse tags, and resource subscriptions. The
canonical mutation path should be one SQLite-backed journal/projector;
the bus should broadcast committed envelopes only.

**Principles**:

- `derive-dont-sync`
- `serialize-shared-state-mutations`
- `use-the-platform`

**Skills**: `architecture`, `effect-v4`, `test`, `bun`

**Changes**:

| File                                                                                        | Change                                                                                                                                        | Lines                                    |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`                      | Remove production memory event-store path if SQLite is the canonical runtime journal.                                                         | ~536                                     |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`            | Keep SQLite implementation, but expose narrow repositories to runtime callers. Remove dead `actor_inbox`/`extension_state` paths when unused. | ~87-170, ~548-557, ~764-1091, ~1701-1838 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/actor-persistence-storage.ts` | Keep as narrow actor state repository.                                                                                                        | whole file                               |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/extension-state-storage.ts`   | Delete if projection/resource state is gone.                                                                                                  | whole file                               |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-publisher.ts`            | Reduce to post-commit broadcast.                                                                                                              | ~36-112                                  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts`                   | Wire narrow repos directly; remove deleted storage services.                                                                                  | ~317-382                                 |

**Verification**: storage tests, event replay/projector tests, session
recovery tests, `bun run gate`.

---

## Batch 9: `test(runtime): harden acceptance coverage for the final substrate`

**Justification**: the wave is not complete until tests prove the public
behavior and prevent backsliding to deleted shapes.

**Principles**:

- `test-through-public-interfaces`
- `prove-it-works`
- `fix-root-causes`

**Skills**: `test`, `effect-v4`, `bun`

**Changes**:

| File                                                                                            | Change                                                                                             | Lines            |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/task-tools/task-rpc.test.ts` | Prove `rpc` bucket acceptance through `createRpcHarness`; no command transport fallback.           | whole file       |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop.test.ts`             | Replace sleep polling/bun timeout reliance with inside-Effect timeouts and deterministic controls. | ~491, ~2911-3014 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/rpc-harness.ts`                | Extend harness only if needed for final extension RPC shape.                                       | whole file       |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/actor-lifecycle.test.ts`     | Add lifecycle regression for actor-owned state/protocol.                                           | whole file       |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/needs-locks.test.ts`            | New: lock-registry and concurrency acceptance.                                                     | new              |

**Verification**: targeted tests, `bun run test`, `bun run test:e2e`,
then `bun run gate`.

---

## Batch 10: `refactor(tui): remove suppression debt at UI state boundaries`

**Justification**: P2 suppression debt can hide schema drift. Final
recursive audit requires no P0/P1/P2 findings, so these cannot be
deferred.

**Principles**:

- `boundary-discipline`
- `correctness-over-pragmatism`

**Skills**: `effect-v4`, `test`, `bun`

**Changes**:

| File                                                                                       | Change                                                                                        | Lines  |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------ |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/components/command-palette-state.ts`      | Replace `Schema.Any as unknown as Schema.Schema<T>` with real schemas or local event helpers. | ~34    |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/components/composer-state.ts`             | Same.                                                                                         | ~16-18 |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/auth-state.ts`                     | Same.                                                                                         | ~7-11  |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-ui-state.ts`               | Same.                                                                                         | ~10-14 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`           | Remove in-memory blob-through-string config workaround.                                       | ~1833  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/connection-runner.ts` | Replace production `Effect.die` bootstrap failure with typed failure or scoped startup error. | ~115   |

**Verification**: TUI typecheck, focused reducer tests if present,
`bun run gate`.

---

## Batch 11: `docs(architecture): sync docs with the converged substrate`

**Justification**: stale docs caused this wave to plan against an
imagined state. Docs must describe the tree after deletion, not the wish.

**Principles**:

- `prove-it-works`
- `fix-root-causes`

**Skills**: `architecture`, `code-style`

**Changes**:

| File                                                  | Change                                                                                                          | Lines               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`  | Replace Capability/Resource/Projection-era guidance with final extension, runtime, storage, and eventing model. | ~7-15, ~326-405     |
| `/Users/cvr/Developer/personal/gent/AGENTS.md`        | Update gotchas if runtime composition/storage instructions change.                                              | project-doc section |
| `/Users/cvr/Developer/personal/gent/plans/WAVE-12.md` | Record final batch receipts and recursive audit outcome.                                                        | this file           |

**Verification**: docs spellcheck/format if available, `bun run
fmt:check`, then `bun run gate`.

---

## Batch 12: `test(migration): remove promise control flow from tests`

**Justification**: the test suite now has a lint guard that bans new
`try/finally`, `async`, and `await` in test files, but the guard still
uses a legacy baseline. The final recursive audit should not have to
trust grandfathered promise control flow. Tests should use Effect
scopes, `it.live`, `Effect.scoped`, `FileSystem.makeTempDirectoryScoped`,
and explicit runtime boundaries.

**Principles**:

- `prove-it-works`
- `test-through-public-interfaces`
- `use-the-platform`
- `subtract-before-you-add`

**Skills**: `effect-v4`, `test`, `bun`, `code-style`

**Changes**:

| File / Area                                                                                       | Change                                                                                                           | Lines |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----- |
| `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts`                                        | Replace the legacy baseline map with a zero-tolerance rule once migrations land.                                 | ~871  |
| `/Users/cvr/Developer/personal/gent/apps/tui/tests/**/*.test.ts*`                                 | Migrate async/await Promise-style tests to Effect-backed helpers or explicit non-test runtime adapter functions. | many  |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/**/*.test.ts`                             | Replace `try/finally` temp cleanup with `Effect.scoped`, `it.live`, and scoped platform services.                | many  |
| `/Users/cvr/Developer/personal/gent/packages/tooling/tests/fixtures.test.ts`                      | Keep CLI process boundary isolated behind a helper if it cannot reasonably become Effect-scoped.                 | ~43   |
| `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/no-promise-control-flow-in-tests.*` | Update fixtures to prove zero-tolerance behavior rather than baseline behavior.                                  | whole |

**Migration recipe**:

1. Count current offenders with:
   `rg -n "async\\s+|\\bawait\\b|try\\s*\\{|finally\\s*\\{" packages/core/tests apps/tui/tests packages/tooling/tests --glob '*.{test.ts,test.tsx}'`.
2. Migrate by directory, not opportunistically:
   - temp dirs/files → `FileSystem.makeTempDirectoryScoped()` plus `Effect.scoped`;
   - Effect assertions → `it.live` with `yield*`;
   - UI render loops → shared Effect-compatible helpers or an explicit adapter outside the `test(...)` callback;
   - subprocess/process-bound tests → one quarantined helper boundary with no `async` test callbacks.
3. Run `bun run lint` after each directory batch so the baseline count
   only moves down.
4. When the offender count is zero, delete the baseline map and make
   `gent/no-promise-control-flow-in-tests` fail on any occurrence.

**Verification**: `bun run lint`, `bun run typecheck`, targeted test
directories after each migration slice, then `bun run gate`.

---

## Final Batch 13: `chore(audit): recursive dual-model closeout`

**Justification**: the user explicitly requested the final batch be a
recursive audit where both Codex and Opus launch new subagents and
confirm no P0/P1/P2 findings remain. This is a blocking closeout gate,
not a summary exercise.

**Principles**:

- `prove-it-works`
- `correctness-over-pragmatism`
- `test-through-public-interfaces`

**Skills**: `planify`, `counsel`, `repo`, `architecture`, `test`, `bun`

**Procedure**:

1. Run `bun run gate` at the candidate closeout SHA.
2. Codex launches fresh independent subagents for these lanes:
   runtime ownership, extension API, provider/tool execution, storage,
   domain modeling, suppression debt, SDK/TUI, tests, substrate
   consistency, and peer simplification.
3. Opus counsel receives the same prompt and is explicitly instructed
   to launch its own subagents for the same lanes.
4. Both model families must re-read:
   `/Users/cvr/Developer/personal/gent/plans/WAVE-12.md`,
   `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`,
   `/Users/cvr/.cache/repo/badlogic/pi-mono`, and
   `/Users/cvr/.cache/repo/anomalyco/opencode`.
5. Classification rubric:
   - P0: plan/tree mismatch, broken gate, data loss, or deleted surface
     still public.
   - P1: architecture invariant violation, public contract ambiguity,
     missing acceptance coverage for shipped behavior.
   - P2: suppression debt, stale docs that can mislead future agents,
     narrow runtime/storage risk, or unproved migration edge.
   - P3: cleanup that cannot hide behavior or architecture drift.
6. If either Codex or Opus reports any P0/P1/P2, stop closeout and add
   new fix batches before rerunning this final batch from step 1.
7. Close only when both reports say no P0/P1/P2 and the final gate
   passes.

**Required output files**:

| File                                                                 | Content                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/plans/WAVE-12-CODEX-CLOSEOUT.md` | Codex subagent matrix, findings, and no-P0/P1/P2 receipt. |
| `/Users/cvr/Developer/personal/gent/plans/WAVE-12-OPUS-CLOSEOUT.md`  | Opus subagent matrix, findings, and no-P0/P1/P2 receipt.  |
| `/Users/cvr/Developer/personal/gent/plans/WAVE-12.md`                | Final closeout status and links to receipts.              |

**Verification**: no P0/P1/P2 from either recursive audit; final gate
green; `git diff --check` clean.

---

## Evidence Trail

Brain principles:

- `/Users/cvr/.brain/principles.md`
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/small-interface-deep-implementation.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/use-the-platform.md`
- `/Users/cvr/.brain/principles/derive-dont-sync.md`
- `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md`
- `/Users/cvr/.brain/principles/name-events-not-setters.md`
- `/Users/cvr/.brain/principles/migrate-callers-then-delete-legacy-apis.md`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`
- `/Users/cvr/.brain/principles/prove-it-works.md`
- `/Users/cvr/.brain/principles/test-through-public-interfaces.md`
- `/Users/cvr/.brain/principles/fix-root-causes.md`
- `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`

Gent files:

- `/Users/cvr/Developer/personal/gent/AGENTS.md`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/plans/WAVE-10.md`
- `/Users/cvr/Developer/personal/gent/plans/WAVE-11.md`
- `/Users/cvr/Developer/personal/gent/plans/WAVE-12.md`
- `/Users/cvr/Developer/personal/gent/package.json`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/actor.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/contribution.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/ids.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/projection.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/read-only.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.checkpoint.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.utils.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-host.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/capability-host.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/projection-registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/receptionist.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/subscription-engine.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/resource-manager.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-publisher.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handler-groups/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/actor-persistence-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/checkpoint-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/extension-state-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/in-process-layer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/rpc-harness.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/actor.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/actor-lifecycle.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/task-tools/task-rpc.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/actor-engine.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/receptionist.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/ask-user.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto-checkpoint.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/connection-runner.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/read.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/network-tools/webfetch.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools/requests.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/command-palette-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/composer-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/auth-state.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-ui-state.ts`

Peer files:

- `/Users/cvr/.cache/repo/badlogic/pi-mono/README.md`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/types.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/ai/src/stream.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/mom/src/events.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/mom/src/store.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/agent/agent.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/bus/bus-event.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/bus/index.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/effect/instance-state.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/plugin/index.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/provider/provider.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/compaction.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/llm.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/message-v2.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/status.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/summary.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/sync/index.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/tool/registry.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/tool/tool.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts`
