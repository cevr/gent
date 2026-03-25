import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import {
  EventStore,
  SessionStarted,
  TurnCompleted,
  ToolCallSucceeded,
} from "@gent/core/domain/event"
import type { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import type { LoadedExtension } from "@gent/core/domain/extension"
import {
  ReviewLoopActorConfig,
  ReviewLoopSpawnActor,
  type ReviewLoopState,
  type ReviewLoopUiModel,
} from "@gent/core/extensions/review-loop"
import { createActorHarness } from "@gent/core/test-utils/extension-harness"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ExtensionEventBus } from "@gent/core/runtime/extensions/event-bus"
import { Storage } from "@gent/core/storage/sqlite-storage"

// ── Pure reducer tests ──

describe("ReviewLoop pure reducer", () => {
  const { reduce, derive, intent, events } = createActorHarness(ReviewLoopActorConfig)

  describe("state transitions", () => {
    test("initial state is Inactive", () => {
      expect(ReviewLoopActorConfig.initial._tag).toBe("Inactive")
    })

    test("StartReview intent → Reviewing with defaults", () => {
      const result = intent!({ _tag: "Inactive" }, { _tag: "StartReview" })
      expect(result.state._tag).toBe("Reviewing")
      if (result.state._tag === "Reviewing") {
        expect(result.state.iteration).toBe(1)
        expect(result.state.maxIterations).toBe(3)
        expect(result.state.findings).toEqual([])
      }
      expect(result.effects).toBeDefined()
      expect(result.effects!.some((e) => e._tag === "Persist")).toBe(true)
    })

    test("StartReview intent with options", () => {
      const result = intent!(
        { _tag: "Inactive" },
        { _tag: "StartReview", focus: "auth module", paths: ["src/auth/"], maxIterations: 5 },
      )
      if (result.state._tag === "Reviewing") {
        expect(result.state.focus).toBe("auth module")
        expect(result.state.paths).toEqual(["src/auth/"])
        expect(result.state.maxIterations).toBe(5)
      }
    })

    test("StartReview when already reviewing → no-op", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 2,
        maxIterations: 3,
        findings: [],
      }
      const result = intent!(state, { _tag: "StartReview" })
      expect(result.state).toBe(state) // Reference equality
    })

    test("CancelReview → Inactive with Persist", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 2,
        maxIterations: 3,
        findings: [{ iteration: 1, summary: "found a bug" }],
      }
      const result = intent!(state, { _tag: "CancelReview" })
      expect(result.state._tag).toBe("Inactive")
      expect(result.effects).toBeDefined()
      expect(result.effects!.some((e) => e._tag === "Persist")).toBe(true)
    })

    test("CancelReview when inactive → no-op", () => {
      const state: ReviewLoopState = { _tag: "Inactive" }
      const result = intent!(state, { _tag: "CancelReview" })
      expect(result.state).toBe(state)
    })
  })

  describe("reduce — iteration advancement", () => {
    test("TurnCompleted in Reviewing advances iteration with QueueFollowUp", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 1,
        maxIterations: 3,
        findings: [],
      }
      const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
      if (result.state._tag === "Reviewing") {
        expect(result.state.iteration).toBe(2)
      }
      expect(result.effects).toBeDefined()
      const followUp = result.effects!.find((e) => e._tag === "QueueFollowUp")
      expect(followUp).toBeDefined()
      const persist = result.effects!.find((e) => e._tag === "Persist")
      expect(persist).toBeDefined()
    })

    test("TurnCompleted at max iteration → Inactive with EmitEvent", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 3,
        maxIterations: 3,
        findings: [{ iteration: 1, summary: "issue found" }],
      }
      const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
      expect(result.state._tag).toBe("Inactive")
      expect(result.effects).toBeDefined()
      const emitEvent = result.effects!.find((e) => e._tag === "EmitEvent")
      expect(emitEvent).toBeDefined()
      if (emitEvent !== undefined && emitEvent._tag === "EmitEvent") {
        expect(emitEvent.channel).toBe("review:completed")
      }
    })

    test("TurnCompleted when Inactive → no-op", () => {
      const state: ReviewLoopState = { _tag: "Inactive" }
      const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
      expect(result.state).toBe(state)
    })
  })

  describe("reduce — finding recording", () => {
    test("code_review tool success records finding", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 2,
        maxIterations: 3,
        findings: [],
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolCallId: "tc-1" as ToolCallId,
          toolName: "code_review",
        }),
      )
      if (result.state._tag === "Reviewing") {
        expect(result.state.findings.length).toBe(1)
        expect(result.state.findings[0]!.iteration).toBe(2)
      }
    })

    test("non-signal tool success does not record finding", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 1,
        maxIterations: 3,
        findings: [],
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolCallId: "tc-1" as ToolCallId,
          toolName: "read",
        }),
      )
      if (result.state._tag === "Reviewing") {
        expect(result.state.findings.length).toBe(0)
      }
    })
  })

  describe("derive", () => {
    test("Inactive — no prompt sections, active: false", () => {
      const projection = derive({ _tag: "Inactive" })
      expect(projection.promptSections).toBeUndefined()
      const ui = projection.uiModel as ReviewLoopUiModel
      expect(ui.active).toBe(false)
      expect(ui.findingsCount).toBe(0)
    })

    test("Reviewing — injects prompt section with context", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 2,
        maxIterations: 3,
        focus: "auth module",
        paths: ["src/auth/"],
        findings: [{ iteration: 1, summary: "missing null check" }],
      }
      const projection = derive(state)
      expect(projection.promptSections).toBeDefined()
      expect(projection.promptSections!.length).toBe(1)
      const section = projection.promptSections![0]!
      expect(section.id).toBe("review-loop-context")
      expect(section.content).toContain("Iteration 2/3")
      expect(section.content).toContain("auth module")
      expect(section.content).toContain("src/auth/")
      expect(section.content).toContain("missing null check")
    })

    test("Reviewing — ui model shows active state", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 2,
        maxIterations: 5,
        findings: [{ iteration: 1, summary: "x" }],
      }
      const projection = derive(state)
      const ui = projection.uiModel as ReviewLoopUiModel
      expect(ui.active).toBe(true)
      expect(ui.iteration).toBe(2)
      expect(ui.maxIterations).toBe(5)
      expect(ui.findingsCount).toBe(1)
    })
  })
})

// ── Runtime integration tests ──

const sessionId = "rl-session" as SessionId
const branchId = "rl-branch" as BranchId

const reviewLoopExtension: LoadedExtension = {
  manifest: { id: "@gent/review-loop" },
  kind: "builtin",
  sourcePath: "builtin",
  setup: { spawnActor: ReviewLoopSpawnActor },
}

const makeLayer = () =>
  Layer.mergeAll(
    ExtensionStateRuntime.Live([reviewLoopExtension]),
    EventStore.Memory,
    ExtensionTurnControl.Test(),
    ExtensionEventBus.Test(),
    Storage.Test(),
  )

const getSnapshot = (runtime: ExtensionStateRuntime) =>
  Effect.gen(function* () {
    const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
    return snapshots.find((s) => s.extensionId === "review-loop")
  })

const sendIntent = (runtime: ExtensionStateRuntime, intent: unknown) =>
  Effect.gen(function* () {
    const snap = yield* getSnapshot(runtime)
    const epoch = snap?.epoch ?? 0
    yield* runtime.handleIntent(sessionId, "review-loop", intent, epoch)
  })

describe("ReviewLoop runtime integration", () => {
  test("full lifecycle: start → iterate → complete", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        // Spawn
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // Start review
        yield* sendIntent(runtime, { _tag: "StartReview", focus: "test", maxIterations: 2 })

        const snap1 = yield* getSnapshot(runtime)
        const ui1 = snap1!.model as ReviewLoopUiModel
        expect(ui1.active).toBe(true)
        expect(ui1.iteration).toBe(1)
        expect(ui1.maxIterations).toBe(2)

        // Simulate first iteration complete
        yield* runtime.reduce(new TurnCompleted({ sessionId, branchId, durationMs: 100 }), {
          sessionId,
          branchId,
        })

        const snap2 = yield* getSnapshot(runtime)
        const ui2 = snap2!.model as ReviewLoopUiModel
        expect(ui2.active).toBe(true)
        expect(ui2.iteration).toBe(2)

        // Second iteration (last) — should complete
        yield* runtime.reduce(new TurnCompleted({ sessionId, branchId, durationMs: 100 }), {
          sessionId,
          branchId,
        })

        const snap3 = yield* getSnapshot(runtime)
        const ui3 = snap3!.model as ReviewLoopUiModel
        expect(ui3.active).toBe(false)
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  test("cancel mid-review returns to Inactive", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendIntent(runtime, { _tag: "StartReview" })

        const snap1 = yield* getSnapshot(runtime)
        expect((snap1!.model as ReviewLoopUiModel).active).toBe(true)

        yield* sendIntent(runtime, { _tag: "CancelReview" })

        const snap2 = yield* getSnapshot(runtime)
        expect((snap2!.model as ReviewLoopUiModel).active).toBe(false)
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  test("persistence: state survives actor hydration", async () => {
    const layer = makeLayer()
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage

        // Pre-seed persisted state
        const reviewState: ReviewLoopState = {
          _tag: "Reviewing",
          iteration: 2,
          maxIterations: 5,
          findings: [{ iteration: 1, summary: "found issue" }],
        }
        yield* storage.saveExtensionState({
          sessionId,
          extensionId: "review-loop",
          stateJson: JSON.stringify(reviewState),
          version: 3,
        })

        // Create runtime — actor init should hydrate
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        const snap = yield* getSnapshot(runtime)
        expect(snap).toBeDefined()
        expect(snap!.epoch).toBe(3)
        const ui = snap!.model as ReviewLoopUiModel
        expect(ui.active).toBe(true)
        expect(ui.iteration).toBe(2)
        expect(ui.findingsCount).toBe(1)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("tool signal records finding in runtime", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendIntent(runtime, { _tag: "StartReview" })

        // Simulate code_review tool success
        yield* runtime.reduce(
          new ToolCallSucceeded({
            sessionId,
            branchId,
            toolCallId: "tc-review" as ToolCallId,
            toolName: "code_review",
          }),
          { sessionId, branchId },
        )

        const snap = yield* getSnapshot(runtime)
        const ui = snap!.model as ReviewLoopUiModel
        expect(ui.findingsCount).toBe(1)
      }).pipe(Effect.provide(makeLayer())),
    )
  })
})
