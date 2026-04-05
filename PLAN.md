# Extension Runtime Audit And Simplification Plan

Status: closing. Batch 6 completed on 2026-04-05.

## Batch Tracker

- [x] Batch 1 — Tell The Truth About Ownership
- [x] Batch 2 — One Mailbox For All Actor Ingress
- [x] Batch 3 — Delete The Adapters And Standardize On One Actor Substrate
- [x] Batch 4 — Thin Server/Client Truth
- [x] Batch 5 — Consolidate Tests Around Behavior Seams
- [x] Batch 6 — Remove High-Value Suppression Debt
- [ ] Batch 7 — Final Verification

## Original Context

The current system is much better than it was. It is still not honest enough.

- The extension runtime is actor-shaped, not fully actor-faithful.
- The best mailbox seam is the per-session delivery queue in `EventPublisher`, but `send` / `ask` still bypass it.
- Some extensions own state. Some only expose tools/hooks/jobs/UI. We blur them together.
- We dogfood `effect-machine`, but only halfway. Gent still rebuilds mailbox, supervision, and lifecycle semantics around it.
- The client/runtime split is much healthier now, but server truth still leaks back into SDK/TUI seams.
- The test suite has strong behavior seams and weak shape/inventory ballast at the same time.
- Most `nodeBuiltinImport:off` suppressions are fine. Wildcard `*:off` suppressions are real debt.

This plan fixes the lie first, then deletes scaffolding.

## Scope

In scope:

- make the actor story honest
- simplify the extension model without losing features
- dogfood `effect-machine` more faithfully
- consolidate tests around behavior seams
- remove high-value effect-language-service suppression debt

Out of scope:

- changing local vs remote topology again
- redesigning provider auth
- changing memory semantics beyond architecture needed by these batches

## Governing Principles

- `/Users/cvr/.brain/principles/foundational-thinking.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/fix-root-causes.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/migrate-callers-then-delete-legacy-apis.md`
- `/Users/cvr/.brain/principles/prove-it-works.md`
- `/Users/cvr/.brain/principles/experience-first.md`

## Relevant Skills

- `architecture`
- `effect-v4`
- `code-style`
- `tdd`
- `test`
- `review`
- `bun`
- `opentui`
- `repo`

## Global Rules

Every batch must:

1. end with exactly one single-purpose commit
2. run `bun run gate`
3. get an independent review agent on the batch diff before continuing
4. stop if review finds a high-severity issue
5. only continue after review findings are addressed or explicitly deferred here
6. not begin the next batch until the current batch commit exists, verification is green, and review has signed off

## Audit Summary

### Current Truth

- Actor ownership is split. Some extensions own state. Others are just tools/hooks/jobs/UI around other owned boundaries.
- `task-tools` should be treated as one owned boundary and named honestly as the task extension. Do not split it into “service vs extension” in the architecture language.
- `publish` is queued by session. `send` and `ask` still hit refs directly.
- `fromReducer` is still a custom semaphore-backed pseudo-actor.
- `fromMachine` uses `effect-machine`, but Gent still rebuilds supervision and lifecycle above it.
- Health/status is much better, but still more distributed than it should be.
- Tests are strongest when they hit queue/transport/runtime seams and weakest when they mirror adapters or file layout.

### Prior Art: Copy / Reject

Copy:

- `opencode`: explicit local vs attach/server topology, race/reconnect/PTY regression posture
- `pi-mono`: one runtime core with multiple shells, runtime factory for session replacement, source provenance discipline
- `effect-machine`: mailbox, typed `ask`, supervision, exit/watch, simulation-oriented tests

Reject:

- `opencode` single-flight runners or buses as pretend actors
- `pi-mono` ambient imperative extension runtime as an end state
- Gent’s current split-brain actor story: semaphore actors, machine actors, and runtime supervision broker all at once

## Decisions Already Made

1. Keep one unified extension system.
2. Prefer composition over explicit discriminants or declared capability manifests.
3. Keep `actor` as the only public stateful extension primitive.
4. Stateful extensions must provide one actor-shaped definition. Stateless extensions do not need one.
5. Keep turn influence declarative and actor-owned via public snapshot directives, not imperative derive hooks where avoidable.
6. Use `.jobs(...)` for durable scheduled work.
7. The task extension is one owned boundary. Name it `TaskExtension`, not `TaskService`.
8. Bus stays observation/side-effect plumbing, not command ownership.
9. Keep explicit local vs remote topology.
10. `bun run gate` is the batch gate.
11. Delete both `fromReducer` and `fromMachine` from the target public model.

## Batches

### Batch 1 — Tell The Truth About Ownership

Goal:

- keep the public extension surface minimal:
  - actor optional for stateless extensions
  - actor required for stateful extensions
  - actor
  - tools
  - jobs
  - interceptors
  - client

Why:

- the current model calls too many things “actors”
- public API is more complicated than it needs to be
- this is the root lie behind later complexity

Justification:

- `foundational-thinking`
- `boundary-discipline`
- `subtract-before-you-add`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/task-tools.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/task-tools-service.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/handoff.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/auto.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/plan-integration.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/task-service.test.ts`

Brain principles:

- `foundational-thinking`
- `boundary-discipline`
- `subtract-before-you-add`

Relevant skills:

- `architecture`
- `effect-v4`
- `tdd`

Sketch:

```ts
const TaskExtension = extension("@gent/task")
  .actor(TaskActor)
  .tools(TaskCreateTool, TaskListTool, TaskGetTool)
  .jobs(...)
  .build()

interface GentExtension {
  readonly manifest: ExtensionManifest
  readonly spawn?: SpawnExtensionRef
  readonly tools?: ReadonlyArray<AnyToolDefinition>
  readonly jobs?: ReadonlyArray<ScheduledJobContribution>
  readonly interceptors?: ReadonlyArray<ExtensionInterceptorDescriptor>
}

const GitExtension = extension("@gent/git")
  .tools(GitStatusTool, GitDiffTool)
  .interceptors(GitPromptInterceptor)
  .build()
```

Changes:

- keep stateless extensions actorless
- keep actor as the only public stateful primitive
- require stateful extensions to provide one actor-shaped definition
- actor owns public snapshot and declarative turn directives
- rename scheduled work to `.jobs(...)`
- delete `fromReducer` and `fromMachine` from the target public surface
- keep the task extension as one owned boundary, just named honestly
- preserve feature set; this is a truth-and-boundary batch, not a behavior change batch

Tasks:

1. write red tests for the intended minimal builder surface where the public seam changes
2. redesign the extension builder around actor + tools + jobs + interceptors
3. define the actor-shaped extension contract without `fromReducer` / `fromMachine`
4. move current `derive(...).uiModel` cases to actor-owned `snapshot`
5. move current turn-time `derive` cases to declarative actor turn directives where possible
6. rename the task boundary in code/docs to `TaskExtension` semantics where needed
7. update current builtins that obviously violate the new public surface
8. run `bun run gate`
9. run independent review
10. commit exactly one Batch 1 commit

Verification:

- `bun run gate`
- focused tests around extension role composition
- independent review agent

Commit rule:

- one batch, one commit

### Batch 2 — One Mailbox For All Actor Ingress

Goal:

- make `publish`, `send`, and `ask` all serialize through the same per-session queue

Why:

- right now only event delivery is mailboxed
- direct `send` / `ask` calls weaken the actor claim

Justification:

- `serialize-shared-state-mutations`
- `fix-root-causes`
- `redesign-from-first-principles`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/event-publisher.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/state-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/from-reducer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/from-machine.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/turn-control.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/concurrency.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/event-routing.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/event-publisher.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/e2e/tests/queue-contract.test.ts`

Brain principles:

- `serialize-shared-state-mutations`
- `fix-root-causes`
- `boundary-discipline`

Relevant skills:

- `architecture`
- `effect-v4`
- `tdd`

Sketch:

```ts
interface QueuedEnvelope {
  readonly sessionId: SessionId
  readonly branchId?: BranchId
  readonly op:
    | { readonly _tag: "publish"; readonly event: AgentEvent }
    | { readonly _tag: "send"; readonly message: AnyExtensionCommandMessage }
    | {
        readonly _tag: "ask"
        readonly message: AnyExtensionRequestMessage
        readonly reply: Deferred.Deferred<unknown>
      }
}

interface ExtensionMailbox {
  readonly offer: (envelope: QueuedEnvelope) => Effect.Effect<void>
}
```

Changes:

- no mixed ingress semantics
- no synchronous direct actor mutation outside the queue
- nested same-session publishes queue behind current work instead of side-stepping semantics

Tasks:

1. add red tests for ordered `publish` / `send` / `ask` delivery through one queue
2. add a red test for slow extension isolation
3. route all actor ingress through the same queued runtime path
4. keep caller wait semantics explicit and tested
5. run `bun run gate`
6. run independent review
7. commit exactly one Batch 2 commit

Verification:

- `bun run gate`
- queue ordering and slow-handler regression coverage
- independent review agent

Commit rule:

- one batch, one commit

### Batch 3 — Delete The Adapters And Standardize On One Actor Substrate

Goal:

- delete `fromReducer` and `fromMachine`
- make extensions provide one actor-shaped definition backed by `effect-machine`

Why:

- Gent currently has three stories at once:
  - custom reducer pseudo-actors
  - machine adapters
  - runtime supervision glue
- that is architectural duplication disguised as flexibility

Justification:

- `fix-root-causes`
- `foundational-thinking`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/from-reducer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/from-machine.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/state-runtime.ts`
- `/Users/cvr/Developer/personal/effect-machine/src/actor.ts`
- `/Users/cvr/Developer/personal/effect-machine/src/internal/runtime.ts`
- `/Users/cvr/Developer/personal/effect-machine/test/ask.test.ts`
- `/Users/cvr/Developer/personal/effect-machine/test/supervision.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/actor.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/from-machine.test.ts`

Brain principles:

- `fix-root-causes`
- `foundational-thinking`
- `migrate-callers-then-delete-legacy-apis`

Relevant skills:

- `effect-v4`
- `architecture`
- `tdd`

Sketch:

```ts
type ExtensionActorInput =
  | {
      readonly _tag: "Published"
      readonly event: AgentEvent
      readonly ctx: ExtensionReduceContext
    }
  | {
      readonly _tag: "Command"
      readonly message: AnyExtensionCommandMessage
      readonly branchId?: BranchId
    }
  | ReplyEvent<
      "Request",
      {
        readonly message: AnyExtensionRequestMessage
        readonly branchId?: BranchId
      },
      unknown
    >

interface ExtensionActor<State> {
  readonly machine: Machine<State, ExtensionActorInput, ExtensionActorRequirements>
  readonly snapshot: {
    readonly schema: Schema.Schema<unknown>
    readonly project?: (state: State) => unknown
  }
}

const TaskActor: ExtensionActor<TaskState> = {
  machine: TaskMachine,
  snapshot: {
    schema: TaskListSnapshot,
    project: (state) => ({ tasks: state.tasks }),
  },
}
```

Changes:

- actor required only for stateful extensions
- keep one event algebra for publish/send/ask
- keep one actor substrate for lifecycle, supervision, ask, and snapshots
- remove Gent-owned adapter runtimes
- if ergonomic helpers survive, they compile to this actor shape and stay internal/thin

Tasks:

1. write red tests for the actor semantics Gent expects from one actor substrate
2. define the unified extension actor input algebra
3. migrate `fromReducer` callers onto the actor-shaped contract
4. migrate `fromMachine` callers onto the same contract
5. delete both adapter surfaces
6. collapse duplicated lifecycle/supervision logic where `effect-machine` already owns it
7. preserve current external behavior while deleting internal substrate duplication
8. run `bun run gate`
9. run independent review
10. commit exactly one Batch 3 commit

Verification:

- `bun run gate`
- adapter/runtime actor contract tests
- independent review agent

Commit rule:

- one batch, one commit

### Batch 4 — Thin Server/Client Truth

Goal:

- keep one server-owned health/protocol truth and delete leftover client-side reassembly

Why:

- current system is better, but SDK/TUI still carry more truth than they should

Justification:

- `boundary-discipline`
- `subtract-before-you-add`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/extension-health.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-client.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/local-supervisor.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/components/connection-widget.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/widgets-render.test.tsx`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-health.test.ts`

Brain principles:

- `boundary-discipline`
- `subtract-before-you-add`
- `experience-first`

Relevant skills:

- `architecture`
- `effect-v4`
- `opentui`
- `tdd`

Sketch:

```ts
interface ExtensionHealth {
  readonly summary: {
    readonly status: "healthy" | "degraded"
    readonly subtitle?: string
  }
  readonly extensions: ReadonlyArray<{
    readonly id: string
    readonly activation: { readonly status: "active" | "failed" }
    readonly actor?: ExtensionActorStatusInfo
    readonly scheduler?: { readonly failures: ReadonlyArray<ScheduledJobFailureInfo> }
  }>
}
```

Changes:

- one health truth from server to client
- delete client-side protocol/status reconstruction where transport can own it
- preserve explicit local vs remote topology

Tasks:

1. identify remaining duplicated truth between server, SDK, and TUI
2. move it server-side or delete it
3. simplify SDK/TUI consumers to thin adapters
4. tighten degraded-state UI tests around the remaining surface
5. run `bun run gate`
6. run independent review
7. commit exactly one Batch 4 commit

Verification:

- `bun run gate`
- degraded health and reconnect tests
- independent review agent

Commit rule:

- one batch, one commit

### Batch 5 — Consolidate Tests Around Behavior Seams

Goal:

- keep the strong behavior tests, delete duplicate shape/inventory ballast, and add missing bug-class coverage

Why:

- current suite has real value, but also repeats the same queue/event-publisher story and over-tests adapter state shape

Justification:

- `prove-it-works`
- `experience-first`
- `subtract-before-you-add`

Files:

- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/actor.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/concurrency.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/event-routing.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/from-machine.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/event-publisher.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/e2e/tests/core-boundary.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/e2e/tests/queue-contract.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/e2e/tests/watch-state-parity.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/e2e/tests/supervisor.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-integration.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/widgets-render.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/integration/session-feed-boundary.test.tsx`

Brain principles:

- `prove-it-works`
- `subtract-before-you-add`
- `experience-first`

Relevant skills:

- `tdd`
- `test`
- `bun`

Sketch:

```ts
describe("queue contract", () => {
  test("serializes publish/send/ask in order", ...)
  test("queues nested same-session work instead of skipping", ...)
  test("isolates a slow actor without corrupting ordering", ...)
})
```

Changes:

- one owner for each behavior seam
- fewer file-mirror tests
- more public contract and bug-class tests

Tasks:

1. delete exact duplicates first
2. collapse the event-publisher / queue overlap into fewer contract files
3. shrink adapter-shape tests to a minimal contract surface
4. keep and expand strong transport/queue/reconnect/runtime behavior tests
5. add any missing slow-handler or race regression found during audit
6. run `bun run gate`
7. run independent review
8. commit exactly one Batch 5 commit

Verification:

- `bun run gate`
- clear ownership of each major behavior seam in test files
- independent review agent

Commit rule:

- one batch, one commit

### Batch 6 — Remove High-Value Suppression Debt

Goal:

- remove or redesign wildcard `@effect-diagnostics-next-line *:off` seams

Why:

- these mark the places where runtime ownership is still not modeled cleanly
- host-edge `nodeBuiltinImport:off` comments are mostly justified and should not be churned gratuitously

Justification:

- `boundary-discipline`
- `fix-root-causes`

Files:

- `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/gent/apps/server/src/main.ts`
- `/Users/cvr/Developer/personal/gent/apps/server/src/debug/scenario.ts`
- any newly revealed wildcard suppression seams

Brain principles:

- `boundary-discipline`
- `fix-root-causes`

Relevant skills:

- `effect-v4`
- `code-style`
- `tdd`

Sketch:

```ts
interface GentRuntime {
  readonly cast: <A, E, R>(effect: Effect.Effect<A, E, R>) => void
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
}
```

Changes:

- remove wildcard suppressions where the model can be made honest
- keep narrow justified host-boundary suppressions

Tasks:

1. inventory remaining wildcard suppressions
2. fix model seams where possible instead of muting diagnostics
3. keep only narrow justified suppressions with explicit rationale
4. run `bun run gate`
5. run independent review
6. commit exactly one Batch 6 commit

Verification:

- `bun run gate`
- suppression inventory diff
- independent review agent

Commit rule:

- one batch, one commit

### Batch 7 — Final Verification

Goal:

- verify the implementation against this plan, update docs, and close the work cleanly

Why:

- architecture work rots immediately if the docs and plan are left behind

Justification:

- `prove-it-works`

Files:

- `/Users/cvr/Developer/personal/gent/PLAN.md`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- any doc or ADR files touched by the batches

Brain principles:

- `prove-it-works`
- `encode-lessons-in-structure`

Relevant skills:

- `architecture`
- `review`

Sketch:

```md
- [ ] plan batch goals all satisfied
- [ ] docs match shipped architecture
- [ ] `bun run gate` green
- [ ] worktree clean
- [ ] final review agent says no findings
```

Tasks:

1. audit the finished state against every batch goal
2. update docs to match reality
3. run `bun run gate`
4. run independent review
5. commit exactly one Batch 7 commit

Verification:

- `bun run gate`
- independent review agent
- worktree clean

Commit rule:

- one batch, one commit

## Open Questions To Resolve Before Batch 1 Starts

1. Should scheduled jobs remain host-global?
   Recommended: yes.
2. Should actor public snapshots default to raw state exposure, with `snapshot.project` only when internal state should stay private?
   Recommended: yes.
3. Should declarative turn directives live inside the actor config, not as top-level extension hooks?
   Recommended: yes.
4. Should stateless extensions remain actorless?
   Recommended: yes.
5. Should any public reducer/machine adapter survive the redesign?
   Recommended: no.
6. Should actor runtime failures auto-restart with bounded retries?
   Recommended: yes.
7. Should `publish` / `send` / `ask` all serialize through the same queue?
   Recommended: yes.
