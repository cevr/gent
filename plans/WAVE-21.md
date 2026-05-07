# Planify: Wave 21 — Actor-Serialized Core And Minimal Extension Surface

## Thesis

The five-lane exploration found no current P0, but it found enough convergent
P1s that the next wave should be structural, not cosmetic. Gent is close to the
right center of gravity: Effect-native tools, Encore-backed actors, and an
extension system that can express the current product. The remaining problem is
ownership. Several surfaces claim actor, platform, or extension authority while
still allowing parallel writes, ambient host calls, broad privileged context, or
resource failures to become normal active state.

Wave 21 is done only when a fresh recursive audit finds no P0/P1. Scope is not
a constraint. Delete compatibility surfaces, rewrite schemas, and move work
upstream when that is the structurally correct place.

## Principles Applied

- `/Users/cvr/.brain/principles/never-block-on-the-human.md` — the direction is
  clear; do not ask for smaller scope or staged permission.
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md` — start from
  actor ownership and extension authority, not from current file boundaries.
- `/Users/cvr/.brain/principles/subtract-before-you-add.md` — shrink public
  surfaces before adding replacement abstractions.
- `/Users/cvr/.brain/principles/small-interface-deep-implementation.md` — the
  public extension API and runtime protocol should be narrow; depth belongs
  behind owned services.
- `/Users/cvr/.brain/principles/use-the-platform.md` — prefer Effect STM,
  Effect AI Tool/Toolkit, Effect platform services, and Encore actors over
  local copies.
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md` — durable
  queue mutations and config writes need one serialized owner.
- `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md` —
  an extension with a failed required resource must not remain active.
- `/Users/cvr/.brain/principles/test-through-public-interfaces.md` — prove the
  wave through SessionRuntime/RPC/extension harness behavior, not private helper
  assertions.
- `/Users/cvr/.brain/principles/correctness-over-pragmatism.md` — no carveouts,
  no backwards compatibility layers, no old-shape aliases.
- `/Users/cvr/.brain/principles/fix-root-causes.md` — upstream owned library
  DX issues instead of working around them in Gent.

## Non-Negotiable Execution Rules

- Break this into reviewable sub-commits. Each commit runs the narrowest
  meaningful focused test first, then the relevant repo gate.
- Gent gate: `bun run gate`. Use `bun run test`, `bun run test:e2e`, and
  `bun run test:diagnose` when the touched boundary needs them.
- Upstream gates: `bun run gate` in
  `/Users/cvr/Developer/personal/effect-encore`,
  `/Users/cvr/Developer/personal/effect-machine`, and
  `/Users/cvr/Developer/personal/effect-wide-event`.
- Mechanical migrations after the first worked example go to apply-tier agents
  with explicit recipes, examples, and stop conditions.
- Builtins are just the starting extension set. They must use the same public
  author API as third-party extensions. No private or privileged extension API.
- If a P0/P1 appears during the final recursive audit, create the next wave and
  keep going. Do not declare completion.

## Audit Synthesis

Five exploration agents independently audited Gent against local principles,
Effect v4/effect-smol, `badlogic/pi-mono`, `anomalyco/opencode`, and the owned
libraries. The P1s converged around four themes:

1. Actor ownership is not yet durable enough. The AgentLoop actor claims
   per-branch FIFO serialization while running handlers unbounded and
   persisting full queue snapshots outside the STM mutation.
2. Extension authority is too wide. The public author API re-exports internal
   runtime/domain pieces, and tool execution receives the wide host context by
   default.
3. Resource lifecycle is not activation state. A resource can fail `start` and
   the extension still remains active from the registry point of view.
4. Platform boundaries are declared but porous. Cron, SDK server locks, TUI
   health checks, and some extensions still reach Bun/Node/process-shaped APIs
   outside a single platform service.

External comparison mostly reinforces subtraction. `opencode` and `pi` both
show plugin surfaces that are useful but broad; they are cautionary examples,
not targets to copy. Effect v4 already gives Gent better primitives:
`SynchronizedRef`, `TxRef`, `TxQueue`, `TxHashMap`, Effect AI `Tool`, and
`Toolkit`.

## Progress And Re-Audit Addendum

Commits landed in this wave so far:

- `89737196 fix(runtime): serialize agent loop queue persistence`
- `835ac34f fix(runtime): serialize user config persistence`
- `fd01be17 fix(extensions): fail resource layer on startup failure`
- `8b5fb090 refactor(extensions): keep host loading out of author api`
- `5bb02ea9 refactor(extensions): require explicit wide tool context`
- `b9334674 refactor(extensions): keep tool runner in core runtime`
- `6b19a08a refactor(extensions): publish task state changes generically`
- `05579bfa refactor(task-tools): own task domain in extension`

Fresh five-lane audit at `b9334674` and follow-up correction at `6b19a08a`
found no P0, but Wave 21 is not closeable. The initial commits removed broad
classes of privilege and races, but the deeper P1s remain:

- AgentLoop queue mutation is serialized around persistence, but
  `TxSubscriptionRef.modify` still exposes the in-memory transition before the
  durable write can fail, and queue persistence failures still do not flow
  through actor persistence-failure handling.
- Resource start failure now fails the resource layer, but that is still the
  wrong ownership boundary. Startup failures must be extension activation
  failures, allowing unaffected extensions to remain active.
- Public resource scopes are not truthful yet. The production path builds only
  process resources, while ephemeral child runtimes can rebuild process-scoped
  extension resources.
- The extension author API is narrower, but it still exposes `runProcess` and
  `GentPlatform`. Builtins are still able to use host-level APIs that third
  party extensions should not receive by default.
- Task-tools now publishes a generic `ExtensionStateChanged` pulse and owns
  `Task`, `TaskId`, status/transition schemas, and task-storage integration
  tests. The previous task ownership mismatch is closed.
- OAuth credential refresh cells are still plain `Ref` read-refresh-write
  paths in OpenAI and Anthropic; concurrent stale calls can duplicate refresh
  work and race rotated refresh tokens.
- The child session tracker still mutates a `Ref<Map<...>>` from independent
  parent/child subscription fibers and can lose interleaved state updates.
- The scheduler still probes `globalThis.Bun.cron` from core runtime and fails
  open when cron is unavailable.

Fresh re-audit receipts to carry into the remaining batches:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:349`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:375`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:1035`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:1038`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/resource-layer.ts:52`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts:373`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:297`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:596`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts:43`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:85`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:256`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:258`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools/domain.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/index.ts:264`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/credential-service.ts:227`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts:248`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/credential-service.ts:210`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/services/child-session-tracker.ts:74`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/services/child-session-tracker.ts:201`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:152`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:250`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/SynchronizedRef.ts:137`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/SynchronizedRef.ts:205`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxSubscriptionRef.ts:204`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxSubscriptionRef.ts:570`

## P1 Findings

### P1.1 — AgentLoop Queue Durability Is Not Structurally Serialized

The actor header says a `(sessionId, branchId)` entity gives a FIFO mailbox, but
the actual actor layer is unbounded. Queue changes mutate a `TxSubscriptionRef`
and then persist a full JSON snapshot afterward. Same-branch concurrent ops can
therefore commit memory correctly while persisting stale snapshots out of
order.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:17`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:18`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:765`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:784`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:882`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:885`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:1033`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:1039`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:366`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:390`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/agent-loop-queue-storage.ts:83`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/agent-loop-queue-storage.ts:95`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/TxQueue.ts:1`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/TxQueue.ts:9`

Required correction:

- Add a red public behavior test for concurrent same-branch submissions followed
  by restart/resurrection.
- Make actor command handling sequential for the mutation lane.
- Separate long-running turn execution from mailbox mutation with an owned
  worker primitive: `TxQueue`, `FiberMap`, or an upstream Encore operation-lane
  helper.
- Persist queue transitions through the same serialized owner as the in-memory
  state change.

### P1.2 — Config Mutations Are Read-Modify-Write Races

`ConfigService` uses plain `Ref.get` + `Ref.set` + disk write for user config
updates. Concurrent permission or driver override updates can lose each other.
Effect v4 already has `SynchronizedRef.modifyEffect` and
`SynchronizedRef.updateEffect` for exactly this shape.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts:195`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts:204`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts:212`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts:222`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts:224`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts:237`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts:240`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts:249`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts:252`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/config-service.ts:265`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/SynchronizedRef.ts:160`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/SynchronizedRef.ts:172`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/SynchronizedRef.ts:269`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/SynchronizedRef.ts:280`

Required correction:

- Replace user config mutation with one serialized `mutateUserConfig` helper.
- Use `SynchronizedRef.modifyEffect` or an equivalent Effect-native serialized
  owner so memory update and disk write cannot interleave incorrectly.
- Add a concurrent mutation test that proves both updates survive.

### P1.3 — Resource Startup Failure Can Leave An Extension Active

`buildResourceLayer` logs failed `Resource.start` effects and continues.
Activation reconciliation then marks validated active extensions as activated
with no failed activation entries. That represents a failed required resource
as an active extension.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/resource-layer.ts:44`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/resource-layer.ts:58`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/resource-layer.ts:63`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/resource-layer.ts:70`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts:360`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts:377`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:21`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:89`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:116`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/project/instance-store.ts:17`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/project/instance-store.ts:23`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/project/instance-store.ts:102`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/project/instance-store.ts:139`

Required correction:

- Make resource lifecycle an input to extension activation state.
- Prevent contributions that depend on a failed resource from becoming active.
- Surface failed resources through `gent doctor` and registry health.
- Add a regression proving a failed `Resource.start` disables dependent tools,
  actions, reactions, and requests.

### P1.4 — Public Extension API Is A Private-Internals Barrel

`@gent/core/extensions/api` is documented as the single authoring entrypoint,
but it re-exports runtime internals, `GentPlatform`, `ToolRunner`,
`readDisabledExtensions`, host utilities, domain agent helpers, and many low
level schemas. That gives builtins and third-party extensions power that should
belong to host-owned capabilities.

Receipts:

- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:279`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:380`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:28`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:63`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:110`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:250`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:267`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:290`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:330`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:4`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:39`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:55`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:100`

Required correction:

- Redefine `@gent/core/extensions/api` as the only public author API.
- Remove runtime/platform/private host exports from the author API.
- Migrate builtins to the same API used by external extensions.
- Add static tests and lint guards proving extension source cannot import core
  internals or privileged APIs.

### P1.5 — Tool Execution Receives Wide Host Authority By Default

`ToolCapabilityContext` extends `ModelCapabilityContext`, which carries agent
running, session mutation, branch operations, deletion, message deletion,
interaction, and search. Tools should receive only the authority declared by
their capability needs.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:150`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:157`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:36`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:52`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:72`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:159`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:161`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:184`

Required correction:

- Replace wide default tool context with capability-specific facets.
- Keep host powers behind explicit declarations and runtime authorization.
- Make impossible contexts unrepresentable: a read-only tool should not even
  receive write/session-mutation methods.
- Update shipped extensions and tests through public behavior harnesses.

## P2 Findings

### P2.1 — SessionRuntime Duplicates Actor Protocol And Polls For Acceptance

`SessionRuntimeEntity` and `SessionRuntimeService` repeat a broad command
surface, then dispatch into AgentLoop and poll message storage / actor queue
for acceptance. Encore already has `execute` and operation receipts; Gent
should not need a polling acceptance loop for actor-owned commands.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:176`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:242`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:261`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:292`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:418`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:472`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:595`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:633`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:701`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:754`
- `/Users/cvr/Developer/personal/effect-encore/src/Actor.ts:261`
- `/Users/cvr/Developer/personal/effect-encore/src/Actor.ts:268`
- `/Users/cvr/Developer/personal/effect-encore/src/Actor.ts:320`
- `/Users/cvr/Developer/personal/effect-encore/src/Actor.ts:322`

Required correction:

- Replace send-plus-poll callers with actor `execute` or an upstream
  `sendAndWait` / receipt helper.
- Collapse duplicated command surfaces where SessionRuntime is only forwarding.
- Keep public RPC acceptance tests as the proof of behavior.

### P2.2 — Platform Boundaries Are Declared But Still Porous

`GentPlatform` says Bun/process/OS references live in one file. The scheduler
has a local `CronRuntime`, reaches `globalThis.Bun.cron`, and emits
process-shaped wrapper scripts. Some SDK/TUI/extension paths also use Node or
process APIs directly.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform.ts:30`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform-bun.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform-bun.ts:92`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:62`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:69`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:100`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:118`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:152`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:185`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:240`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:309`

Required correction:

- Move cron/runtime host APIs behind a real service layer.
- Decide whether `GentPlatform` absorbs `RuntimePlatform` or whether the latter
  is renamed into pure runtime config.
- Expand static guards to reject Bun/Node/process host APIs outside adapter,
  app-shell, test, and generated-script boundaries.

### P2.3 — Stateful Extensions Are Not Consistently Actor/Resource Owned

Several extensions hold state in process-local refs, maps, semaphores, or
module singletons. That can be fine only when the resource scope and lifecycle
make that ownership explicit.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts:43`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts:65`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:79`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:87`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts:7`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/controller.ts:383`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/controller.ts:412`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/controller.ts:50`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/controller.ts:66`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/controller.ts:125`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/controller.ts:147`

Required correction:

- Convert stateful extensions to resource-owned services or actors.
- If a scope is public, implement it truthfully. If a scope is not implemented,
  delete it from the public API until it is real.

### P2.4 — Owned Libraries Should Absorb Actor-Native DX

Gent needs patterns that belong upstream: per-operation concurrency defaults,
operation acceptance helpers, durable actor/machine composition, and actor-wide
event boundaries.

Receipts:

- `/Users/cvr/Developer/personal/effect-encore/src/Actor.ts:286`
- `/Users/cvr/Developer/personal/effect-encore/src/Actor.ts:291`
- `/Users/cvr/Developer/personal/effect-encore/src/Actor.ts:1207`
- `/Users/cvr/Developer/personal/effect-encore/src/Actor.ts:1213`
- `/Users/cvr/Developer/personal/effect-machine/src/actor.ts:119`
- `/Users/cvr/Developer/personal/effect-machine/src/actor.ts:126`
- `/Users/cvr/Developer/personal/effect-machine/src/actor.ts:168`
- `/Users/cvr/Developer/personal/effect-machine/src/actor.ts:188`
- `/Users/cvr/Developer/personal/effect-machine/src/actor.ts:305`
- `/Users/cvr/Developer/personal/effect-machine/src/actor.ts:315`
- `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:132`
- `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:215`

Required correction:

- Improve `effect-encore` before adding more Gent-local actor workarounds.
- Prove an `effect-machine` entity-machine shape before migrating AgentLoop.
- Add `effect-wide-event` helpers that make actor/request boundaries one-line
  and hard to forget.

### P2.5 — `effect-wide-event` Is Behind The Current Scaffolding Baseline

`effect-wide-event` still uses `tsc` scripts, Effect beta.52, and older
tooling while Gent and the other owned libraries have moved toward the
project-scaffolding baseline and latest beta.

Receipts:

- `/Users/cvr/Developer/personal/effect-wide-event/package.json:31`
- `/Users/cvr/Developer/personal/effect-wide-event/package.json:45`
- `/Users/cvr/Developer/personal/effect-wide-event/package.json:47`
- `/Users/cvr/Developer/personal/effect-wide-event/package.json:49`
- `/Users/cvr/Developer/personal/effect-wide-event/package.json:64`
- `/Users/cvr/Developer/personal/effect-wide-event/package.json:74`

Required correction:

- Update `effect-wide-event` to the current project-scaffolding baseline:
  `tsgo`, `effect-ts/tsgo`, latest Effect beta, current lint/fmt/build scripts.
- Mirror fixes to v3 if the repository still ships a v3 surface.
- Add docs, changeset, commit, push, and merge the generated version PR as part
  of the upstream batch.

## P3 Findings

- Effect AI tool usage has improved: Gent now passes `success: input.output` to
  `AiTool.dynamic`, so the prior Wave 20 output-schema P1 is resolved.
  Continue deleting local ToolRunner validation only where Effect `Toolkit`
  can own the full boundary.
  - `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:263`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:267`
  - `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts:175`
  - `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts:225`
- `ToolNeeds` is closed in core while the lock registry can support arbitrary
  resource tags. Either make needs extension-declared and open, or subtract the
  custom layer in favor of Effect annotations.
- Request capability inputs repeat `extensionId`; the registry should derive
  it from loaded extension identity where possible.
- Client facets are a separate broad surface. Keep them out of the server
  author API and test them as client-local lowering.

## Implementation Batches

### C21.1 — Red Tests For P1 Ownership Failures

Goal: prove the current failure modes before rewriting.

Work:

- Add a concurrent same-branch queue durability/restart regression through the
  public runtime path.
- Add concurrent config mutation regression.
- Add resource-start-failure regression proving dependent contributions do not
  remain usable.
- Add extension API authority tests that fail if extension source can import
  core internals or receive wide host power by default.

Validation:

- `bun run test -- tests/runtime`
- `bun run test -- tests/extensions`
- `bun run typecheck`

### C21.2 — Serialize AgentLoop Command Ownership

Goal: make queue mutation and durable persistence one actor-owned serialized
transition.

Status: partial. `89737196` added a queue persistence lane and concurrent
follow-up regression, but fresh audit found the acceptance boundary is still
not durable enough.

Work:

- Add a queue-persistence-failure regression proving failed durable writes do
  not appear accepted to observers.
- Change AgentLoop actor handling so mutation commands are sequential or make
  the mutation result visible only after the durable commit succeeds.
- Move long-running turn execution behind an owned worker queue/fiber map so
  slow runs do not require unbounded mailbox mutation.
- Persist queue snapshots only from the serialized mutation owner and route
  persistence failures through the actor failure state.
- Remove stale comments claiming FIFO serialization where the code does not
  enforce it.

Validation:

- Focused C21.1 queue regression.
- `bun run test -- tests/runtime/agent-loop-queue.test.ts`
- `bun run test`
- `bun run gate`

### C21.3 — Serialize Config Writes With Effect Primitives

Goal: replace ad hoc read-modify-write config mutation with one Effect-owned
serialized primitive.

Status: done in `835ac34f`; keep this batch closed unless recursive audit finds
new config-write races.

Work:

- Replace `Ref` write paths with `SynchronizedRef.modifyEffect` or an equivalent
  `mutateUserConfig` owner.
- Ensure disk writes and memory updates cannot lose concurrent mutations.
- Keep read paths simple and unchanged unless the new owner requires it.

Validation:

- Focused config concurrency test.
- `bun run test -- tests/runtime/config-service.test.ts`
- `bun run gate`

### C21.4 — Make Resource Lifecycle Activation-Stateful

Goal: remove the impossible state where a failed resource has active
contributions.

Status: partial. `fd01be17` made resource start failure fail the resource layer,
but fresh audit found startup failure still belongs in extension activation
state, not profile/runtime layer construction.

Work:

- Build/start resources per owning extension during activation or otherwise
  preserve extension identity across startup.
- Make lifecycle start failures part of activation/reconciliation output.
- Mark dependent contributions inactive when required resource startup fails.
- Prove one failed extension resource does not prevent unrelated extensions
  from activating.
- Make process/cwd/session/branch resource scopes truthful, or delete
  unimplemented scope literals until their owners exist.
- Expose resource health to doctor/diagnostic paths.
- Update docs for resource scope semantics.

Validation:

- Focused resource-start-failure regression.
- `bun run test -- tests/extensions`
- `bun run test:e2e` where extension startup is exercised.
- `bun run gate`

### C21.5 — Narrow The Public Extension Author API

Goal: make builtins and external extensions use one minimal, non-privileged API.

Status: partial. Commits `8b5fb090`, `5bb02ea9`, `b9334674`, `6b19a08a`, and
`05579bfa` removed several host-loader, tool-runner, wide-context, raw-event,
task event, and core-owned task-domain privileges. `runProcess` and
`GentPlatform` still remain.

Work:

- Redefine `packages/core/src/extensions/api.ts` as the small author API.
- Remove exports of runtime/platform/private host services, including
  `runProcess` and `GentPlatform`.
- Keep task-tools schemas/storage/events extension-owned; do not re-export them
  from core author APIs.
- Migrate builtins to the narrowed API.
- Add lint/static guards for forbidden extension imports.
- Delete compatibility aliases and old docs examples.

Validation:

- API surface tests.
- `bun run lint`
- `bun run typecheck`
- `bun run gate`

### C21.6 — Replace Wide Tool Context With Capability Facets

Goal: tools receive only declared authority.

Work:

- Split read/session/agent/interaction/write capabilities into explicit facets.
- Make `ToolCapabilityContext` narrow and derived from declared needs.
- Update shipped tools to request only the facets they actually use.
- Run apply-tier agents for repetitive extension migrations after the first
  worked example.

Validation:

- Extension behavior tests through RPC/request harnesses.
- `bun run test -- tests/tools`
- `bun run test -- tests/extensions`
- `bun run gate`

### C21.7 — Resource-Own Stateful Extensions

Goal: make extension state ownership explicit and scoped.

Work:

- Convert ACP, auto, and executor process-local state into resource-owned
  services or actors.
- Implement truthful resource scopes used by current extensions, or delete
  unsupported scopes from the public API.
- Add startup/shutdown/restart behavior tests.

Validation:

- Focused extension tests.
- `bun run test:e2e` for lifecycle-sensitive paths.
- `bun run gate`

### C21.8 — Collapse Runtime Protocol Duplication

Goal: SessionRuntime should not duplicate AgentLoop actor protocol or poll for
actor acceptance.

Work:

- Replace send-plus-poll with actor `execute` or an upstream acceptance helper.
- Delete polling helper paths once public tests cover the behavior.
- Revisit `SessionRuntimeEntity` vs `SessionRuntimeService`; keep the public
  protocol small and actor-owned.

Validation:

- SessionRuntime acceptance tests.
- RPC harness tests.
- `bun run gate`

### C21.9 — Enforce Platform Ownership

Goal: host APIs live behind explicit services; product/runtime code stays
portable and testable.

Status: not started. Fresh platform audit promoted scheduler cron failure-open,
SDK host identity, and shipped-extension ambient process reads to P1.

Work:

- Move cron runtime into a platform service and make missing cron a scheduled
  job failure, not silent success.
- Reconcile `GentPlatform` and `RuntimePlatform` naming/ownership.
- Add static guards for Bun/Node/process imports outside app-shell, adapter,
  test, tooling, and generated-script boundaries.
- Fix SDK/TUI/extension violations found by the new guard.

Validation:

- Guard tests.
- `bun run lint`
- `bun run gate`

### C21.9b — Serialize Extension Credential Refresh And Child Tracking

Goal: apply Effect-owned serialized state primitives to remaining extension/TUI
race surfaces found by the fresh Effect usage lane.

Work:

- Replace OpenAI and Anthropic credential refresh `Ref` cells with
  `SynchronizedRef.modifyEffect` or a single-flight credential service so stale
  concurrent calls cannot duplicate refresh or overwrite rotated tokens.
- Convert `ChildSessionTracker` mutations to `Ref.modify` at minimum, or to a
  `TxSubscriptionRef<Map<...>>` if subscribers need transactional change
  streams.
- Add concurrent stale-refresh tests for OpenAI and Anthropic credential
  services.
- Add parent/child interleaving regression for the TUI tracker.

Validation:

- Focused provider credential tests.
- Focused child session tracker tests.
- `bun run typecheck`
- `bun run gate`

### C21.10 — Upstream Encore Actor DX

Goal: remove Gent-local actor workarounds by improving the owned actor library.

Work in `/Users/cvr/Developer/personal/effect-encore`:

- Add per-operation concurrency or mutation-lane semantics with a sequential
  default for stateful entity handlers.
- Add an operation acceptance helper if Gent still needs send-and-wait semantics
  after C21.8.
- Document when to use `execute`, `send`, receipts, state materialization, and
  long-running worker fibers.
- Add changeset, commit, push, and handle generated version PR.

Validation:

- `bun run gate`
- Gent adoption commit runs `bun run gate`.

### C21.11 — Upstream Machine / Wide Event Actor Helpers

Goal: make the actor model easier to express without local ceremony.

Work:

- In `/Users/cvr/Developer/personal/effect-machine`, prototype or implement an
  entity-machine bridge that can express AgentLoop-like state, queued commands,
  drain/watch, and lifecycle.
- In `/Users/cvr/Developer/personal/effect-wide-event`, add actor/request
  boundary helpers so actor logs carry one structured boundary by default.
- Update `effect-wide-event` to the current project-scaffolding baseline:
  `tsgo`, `effect-ts/tsgo`, latest Effect beta, docs, changeset, v3 mirror, gate.
- Commit, push, and merge generated version PRs where produced.

Validation:

- `bun run gate` in each upstream repo.
- Gent adoption smoke after dependency updates.

### C21.12 — Documentation, Changesets, And Final Gate

Goal: make the new architecture discoverable and releasable.

Work:

- Update `ARCHITECTURE.md` around actor ownership, extension API authority,
  resource activation, and platform boundaries.
- Update package docs/examples for extension authoring.
- Add changesets for published package changes.
- Remove stale wave/migration terminology from active docs and tests.

Validation:

- `bun run gate`
- `bun run test:e2e`
- `bun run smoke`

### C21.13 — Recursive Verification Batch

Goal: independently prove there are no P0/P1 findings left.

Work:

- Launch five fresh exploration agents with this prompt, unchanged in substance:
  audit with `~/.brain/principles`, using
  `/Users/cvr/.cache/repo/effect-ts/effect-smol`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono`,
  `/Users/cvr/.cache/repo/anomalyco/opencode`,
  `/Users/cvr/Developer/personal/effect-machine`,
  `/Users/cvr/Developer/personal/effect-encore`, and
  `/Users/cvr/Developer/personal/effect-wide-event`.
- Require each lane to classify findings as P0/P1/P2/P3 with full file
  receipts.
- If any P0/P1 remains, synthesize `plans/WAVE-22.md` before declaring Wave 21
  complete.
- If no P0/P1 remains, close the wave with final gates and a summary commit.

Validation:

- Independent five-lane audit complete.
- No P0/P1 findings.
- `bun run gate`
- `bun run test:e2e`
- `bun run smoke`
