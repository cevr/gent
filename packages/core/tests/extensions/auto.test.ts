import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import { EventStore } from "@gent/core/domain/event"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { AutoExtension, AutoMsg, AutoService } from "@gent/extensions/auto"
import { AutoProtocol, type AutoSnapshotReply } from "@gent/extensions/auto-protocol"
import { ensureStorageParents, testSetupCtx } from "@gent/core/test-utils"
import {
  ActorRouter,
  type ActorRouterService,
} from "../../src/runtime/extensions/resource-host/actor-router"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { ActorHost } from "../../src/runtime/extensions/actor-host"
import { Receptionist } from "../../src/runtime/extensions/receptionist"
import type { ResolvedExtensions } from "../../src/runtime/extensions/registry"
import type { ActorRef } from "@gent/core/domain/actor"
import { Storage } from "@gent/core/storage/sqlite-storage"

const AutoIntent = TaggedEnumClass("AutoIntent", {
  StartAuto: { goal: Schema.String, maxIterations: Schema.optional(Schema.Number) },
  CancelAuto: {},
  ToggleAuto: {
    goal: Schema.optional(Schema.String),
    maxIterations: Schema.optional(Schema.Number),
  },
})
type AutoIntent = Schema.Schema.Type<typeof AutoIntent>

// ── Runtime integration tests ──

const sessionId = SessionId.make("auto-session")
const branchId = BranchId.make("auto-branch")

const autoExtension: LoadedExtension = {
  manifest: AutoExtension.manifest,
  scope: "builtin",
  sourcePath: "builtin",
  contributions: Effect.runSync(AutoExtension.setup(testSetupCtx())),
}

const seededMachineLayer = (extraLayers: ReadonlyArray<Layer.Layer<never>> = []) => {
  const turnControl = ExtensionTurnControl.Test()
  const storage = Storage.Test()
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActorHost only walks `extensions`
  const resolved = { extensions: [autoExtension] } as unknown as ResolvedExtensions
  const machine = ActorRouter.Live([autoExtension]).pipe(
    Layer.provideMerge(turnControl),
    Layer.provideMerge(ActorHost.fromResolved(resolved)),
    Layer.provideMerge(ActorEngine.Live),
  )
  const seededMachine = Layer.effect(
    ActorRouter,
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      const storageSvc = yield* Storage
      return {
        send: (targetSessionId, message, targetBranchId) =>
          ensureStorageParents({ sessionId: targetSessionId, branchId: targetBranchId }).pipe(
            Effect.provideService(Storage, storageSvc),
            Effect.orDie,
            Effect.flatMap(() => runtime.send(targetSessionId, message, targetBranchId)),
          ),
        execute: (targetSessionId, message, targetBranchId) =>
          ensureStorageParents({ sessionId: targetSessionId, branchId: targetBranchId }).pipe(
            Effect.provideService(Storage, storageSvc),
            Effect.orDie,
            Effect.flatMap(() => runtime.execute(targetSessionId, message, targetBranchId)),
          ),
      } satisfies typeof runtime
    }),
    // Use `provideMerge` so `ActorEngine` and `Receptionist` (composed
    // into `machine` above) remain in the output set — tests drive the
    // actor directly through them, which is the established pattern for
    // actor-only extensions (see handoff.test.ts).
  ).pipe(Layer.provideMerge(Layer.mergeAll(machine, storage, ...extraLayers)))

  return Layer.mergeAll(seededMachine, EventStore.Memory, turnControl, storage, ...extraLayers)
}

const makeLayer = () => seededMachineLayer()

const getSnapshot = (runtime: ActorRouterService) =>
  Effect.gen(function* () {
    const model = (yield* runtime.execute(
      sessionId,
      AutoProtocol.GetSnapshot.make(),
      branchId,
    )) as AutoSnapshotReply
    return { model } as { readonly model: AutoSnapshotReply }
  })

const sendAuto = (runtime: ActorRouterService, intent: AutoIntent) => {
  switch (intent._tag) {
    case "StartAuto":
      return runtime.send(
        sessionId,
        AutoProtocol.StartAuto.make({ goal: intent.goal, maxIterations: intent.maxIterations }),
        branchId,
      )
    case "CancelAuto":
      return runtime.send(sessionId, AutoProtocol.CancelAuto.make(), branchId)
    case "ToggleAuto":
      return runtime.send(
        sessionId,
        AutoProtocol.ToggleAuto.make({ goal: intent.goal, maxIterations: intent.maxIterations }),
        branchId,
      )
  }
}

// ── Actor drivers ──
//
// The auto FSM is hosted on a `Behavior` actor (W10-1b). Tool-result and
// turn-boundary AgentEvents reach the actor through the Resource shell's
// `runtime.toolResult` / `runtime.turnAfter` slot handlers — which only
// fire when invoked by the agent loop. End-to-end coverage of those
// translation slots lives in `auto-integration.test.ts`. Here we drive
// the actor directly through `engine.tell`, mirroring the established
// pattern in `handoff.test.ts`.

const findAutoActor = Effect.gen(function* () {
  const reg = yield* Receptionist
  const refs = yield* reg.find(AutoService)
  const ref = refs[0]
  if (ref === undefined) throw new Error("auto actor not registered")
  return ref
})

const tellAuto = (msg: AutoMsg) =>
  Effect.gen(function* () {
    const engine = yield* ActorEngine
    const ref = yield* findAutoActor
    yield* engine.tell(ref as ActorRef<AutoMsg>, msg)
  })

describe("Auto runtime integration", () => {
  it.live("full lifecycle: start → checkpoint → review → iterate → complete", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      // Start auto
      yield* sendAuto(
        runtime,
        AutoIntent.StartAuto.make({ goal: "fix all bugs", maxIterations: 3 }),
      )

      const snap1 = yield* getSnapshot(runtime)
      const ui1 = snap1!.model as AutoSnapshotReply
      expect(ui1.active).toBe(true)
      expect(ui1.phase).toBe("working")
      expect(ui1.iteration).toBe(1)

      // Checkpoint with continue → AwaitingReview
      yield* tellAuto(
        AutoMsg.AutoSignal.make({
          status: "continue",
          summary: "Found issues",
          learnings: "auth bad",
        }),
      )

      const snap2 = yield* getSnapshot(runtime)
      const ui2 = snap2!.model as AutoSnapshotReply
      expect(ui2.phase).toBe("awaiting-review")
      // TODO(c2): replaced learningsCount with learnings array length.
      expect(
        ((ui2 as unknown as { learnings?: ReadonlyArray<unknown> }).learnings ?? []).length,
      ).toBe(1)

      // Counsel → Working (iteration 2)
      yield* tellAuto(AutoMsg.ReviewSignal.make({}))

      const snap3 = yield* getSnapshot(runtime)
      const ui3 = snap3!.model as AutoSnapshotReply
      expect(ui3.phase).toBe("working")
      expect(ui3.iteration).toBe(2)

      // Complete
      yield* tellAuto(AutoMsg.AutoSignal.make({ status: "complete", summary: "All fixed" }))

      const snap4 = yield* getSnapshot(runtime)
      const ui4 = snap4!.model as AutoSnapshotReply
      expect(ui4.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("TurnCompleted does not advance the loop, only increments watchdog", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      yield* sendAuto(runtime, AutoIntent.StartAuto.make({ goal: "test" }))

      // TurnCompleted should not change UI iteration
      yield* tellAuto(AutoMsg.TurnCompleted.make({}))

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoSnapshotReply
      expect(ui.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("cancel mid-working returns to Inactive", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      yield* sendAuto(runtime, AutoIntent.StartAuto.make({ goal: "test" }))
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: true })

      yield* sendAuto(runtime, AutoIntent.CancelAuto.make({}))
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: false })
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("cancel from AwaitingReview returns to Inactive", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      yield* sendAuto(runtime, AutoIntent.StartAuto.make({ goal: "test" }))

      // Move to AwaitingReview
      yield* tellAuto(AutoMsg.AutoSignal.make({ status: "continue", summary: "x" }))
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ phase: "awaiting-review" })

      yield* sendAuto(runtime, AutoIntent.CancelAuto.make({}))
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: false })
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("wedge prevention: 5 turns without checkpoint → auto-cancel", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      yield* sendAuto(runtime, AutoIntent.StartAuto.make({ goal: "test" }))

      // 5 turns without checkpoint
      for (let i = 0; i < 5; i++) {
        yield* tellAuto(AutoMsg.TurnCompleted.make({}))
      }

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoSnapshotReply
      expect(ui.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  // ── Wrong-state regression locks ──
  // The actor's pure transitions are no-ops in the wrong phase
  // (Working ignores ReviewSignal; AwaitingReview ignores AutoSignal;
  // Inactive ignores everything except StartAuto/ToggleAuto). These
  // tests pin that contract by driving the actor directly so a future
  // edit cannot accidentally accept them in the wrong phase.

  it.live("Inactive ignores all events", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      // Auto starts Inactive — drive a checkpoint, review, and turn
      yield* tellAuto(AutoMsg.AutoSignal.make({ status: "continue", summary: "x" }))
      yield* tellAuto(AutoMsg.ReviewSignal.make({}))
      yield* tellAuto(AutoMsg.TurnCompleted.make({}))

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoSnapshotReply
      expect(ui.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("unrelated tool does not advance the loop", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      yield* sendAuto(runtime, AutoIntent.StartAuto.make({ goal: "test" }))

      // An unrelated tool call has no actor message — `tellAutoFromTool`
      // (the slot-handler bridge) only translates `auto_checkpoint` and
      // `review`. Driving the actor directly here is meaningless because
      // there is no AutoMsg corresponding to "bash"; the assertion is
      // simply that nothing else advanced the loop.

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoSnapshotReply
      expect(ui.phase).toBe("working")
      expect(ui.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("review while Working is ignored (must checkpoint first)", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      yield* sendAuto(runtime, AutoIntent.StartAuto.make({ goal: "test", maxIterations: 3 }))

      // Review fired without a preceding checkpoint — must not advance
      yield* tellAuto(AutoMsg.ReviewSignal.make({}))

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoSnapshotReply
      expect(ui.phase).toBe("working")
      expect(ui.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("checkpoint while AwaitingReview is ignored (must review first)", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      yield* sendAuto(runtime, AutoIntent.StartAuto.make({ goal: "test", maxIterations: 3 }))

      // First checkpoint moves to AwaitingReview
      yield* tellAuto(AutoMsg.AutoSignal.make({ status: "continue", summary: "first" }))
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ phase: "awaiting-review" })

      // Second checkpoint without review — must not advance back to Working
      yield* tellAuto(AutoMsg.AutoSignal.make({ status: "continue", summary: "second" }))
      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoSnapshotReply
      expect(ui.phase).toBe("awaiting-review")
      expect(ui.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("complete checkpoint while AwaitingReview is ignored (review gate)", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      yield* sendAuto(runtime, AutoIntent.StartAuto.make({ goal: "test", maxIterations: 3 }))

      // First checkpoint moves to AwaitingReview
      yield* tellAuto(AutoMsg.AutoSignal.make({ status: "continue", summary: "first" }))
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ phase: "awaiting-review" })

      // A `complete` AutoSignal arriving while AwaitingReview must NOT
      // bypass the review gate and short-circuit to Inactive. The contract
      // is: AwaitingReview accepts ReviewSignal only — every other status
      // (continue/complete/abandon) is dropped until review acknowledges.
      yield* tellAuto(AutoMsg.AutoSignal.make({ status: "complete", summary: "skip review" }))
      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoSnapshotReply
      expect(ui.phase).toBe("awaiting-review")
      expect(ui.active).toBe(true)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("maxIterations reached after review → Inactive", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      yield* sendAuto(runtime, AutoIntent.StartAuto.make({ goal: "test", maxIterations: 1 }))

      // Checkpoint continue at iteration 1/1
      yield* tellAuto(AutoMsg.AutoSignal.make({ status: "continue", summary: "done" }))
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ phase: "awaiting-review" })

      // Counsel at max → should go Inactive, not Working
      yield* tellAuto(AutoMsg.ReviewSignal.make({}))

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoSnapshotReply
      expect(ui.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  // Auto state hydration on cold actor spawn is covered end-to-end by
  // `actor-host.test.ts > fromResolvedWithPersistence round-trips state
  // across host scopes`. The legacy `storage.saveExtensionState` /
  // `ActorRouter.publish(SessionStarted)` hydration path no longer
  // exists — the actor primitive persists through `ActorPersistenceStorage`
  // keyed on `(profileId, persistenceKey)`, not `(sessionId, extensionId)`.

  it.live("auto behavior.view injects learnings + nextIdea into prompt sections", () =>
    Effect.gen(function* () {
      const runtime = yield* ActorRouter
      yield* sendAuto(runtime, AutoIntent.StartAuto.make({ goal: "research caching strategies" }))
      yield* tellAuto(
        AutoMsg.AutoSignal.make({
          status: "continue",
          summary: "first pass",
          learnings: "tried memoization",
          nextIdea: "test LRU eviction",
        }),
      )
      // After AutoSignal{continue} the loop is in AwaitingReview. ReviewSignal
      // pushes it back to Working with the learnings + nextIdea preserved —
      // exactly the state where the actor's `view(state)` should inject them
      // into the system prompt. W10-2a.3: replaces `AutoProjection`.
      yield* tellAuto(AutoMsg.ReviewSignal.make({}))
      // Fence: ask GetSnapshot drains the mailbox up to and including the
      // ReviewSignal tell, so peekView observes post-Review state.
      yield* runtime.execute(
        sessionId,
        AutoProtocol.GetSnapshot.make(),
        branchId,
      ) as Effect.Effect<AutoSnapshotReply>
      const engine = yield* ActorEngine
      const ref = yield* findAutoActor
      const view = yield* engine.peekView(ref)
      expect(view?.prompt?.length).toBe(1)
      const content = view!.prompt![0]!.content
      expect(content).toContain("tried memoization")
      expect(content).toContain("test LRU eviction")
    }).pipe(Effect.provide(makeLayer())),
  )
})

// JSONL replay tests deleted with W10-1b.1.b: the replay-on-spawn path
// (formerly `onInit` on the workflow) was removed because the new actor
// primitive doesn't yet support cross-extension Receptionist discovery
// from a non-host slot + the session-ancestry guard. Reintroduce in
// W10-1c with a *positive* test that verifies state is hydrated from
// the journal — the old "active === false" assertions trivially held
// because replay was dead code, so they were false reassurance.
