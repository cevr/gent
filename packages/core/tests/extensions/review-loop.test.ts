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
  ReviewLoopExtension,
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

    test("StartReview intent → Reviewing state", () => {
      const result = intent!({ _tag: "Inactive" }, { _tag: "StartReview" })
      expect(result.state._tag).toBe("Reviewing")
      if (result.state._tag === "Reviewing") {
        expect(result.state.iteration).toBe(1)
        expect(result.state.maxIterations).toBe(3)
        expect(result.state.findings).toEqual([])
      }
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
      expect(result.state).toBe(state)
    })

    test("CancelReview → Inactive", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 2,
        maxIterations: 3,
        findings: [{ iteration: 1, summary: "found a bug" }],
      }
      const result = intent!(state, { _tag: "CancelReview" })
      expect(result.state._tag).toBe("Inactive")
    })

    test("CancelReview when inactive → no-op", () => {
      const state: ReviewLoopState = { _tag: "Inactive" }
      const result = intent!(state, { _tag: "CancelReview" })
      expect(result.state).toBe(state)
    })
  })

  describe("reduce — signal-driven advancement", () => {
    test("code_review tool success advances iteration", () => {
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
          toolName: "code_review",
          summary: "Found 3 issues in auth module",
        }),
      )
      if (result.state._tag === "Reviewing") {
        expect(result.state.iteration).toBe(2)
        expect(result.state.findings.length).toBe(1)
        expect(result.state.findings[0]!.summary).toBe("Found 3 issues in auth module")
      }
    })

    test("code_review at max iteration → Inactive", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 3,
        maxIterations: 3,
        findings: [{ iteration: 1, summary: "issue found" }],
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolCallId: "tc-1" as ToolCallId,
          toolName: "code_review",
          summary: "Final review clean",
        }),
      )
      expect(result.state._tag).toBe("Inactive")
    })

    test("TurnCompleted does not advance — only tool signal does", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 1,
        maxIterations: 3,
        findings: [],
      }
      const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
      expect(result.state).toBe(state) // No change
      expect(result.effects).toBeUndefined()
    })

    test("non-signal tool success does not advance", () => {
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
      expect(result.state).toBe(state)
    })

    test("uses event.summary for finding, falls back to event.output", () => {
      const state: ReviewLoopState = {
        _tag: "Reviewing",
        iteration: 1,
        maxIterations: 3,
        findings: [],
      }
      // With output but no summary
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolCallId: "tc-1" as ToolCallId,
          toolName: "code_review",
          output: "Detailed review output here",
        }),
      )
      if (result.state._tag === "Reviewing") {
        expect(result.state.findings[0]!.summary).toBe("Detailed review output here")
      }
    })

    test("Inactive ignores all events", () => {
      const state: ReviewLoopState = { _tag: "Inactive" }
      const r1 = reduce(state, events.turnCompleted({ durationMs: 100 }))
      expect(r1.state).toBe(state)
      const r2 = reduce(
        state,
        events.toolCallSucceeded({ toolCallId: "tc" as ToolCallId, toolName: "code_review" }),
      )
      expect(r2.state).toBe(state)
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
  manifest: ReviewLoopExtension.manifest,
  kind: "builtin",
  sourcePath: "builtin",
  setup: Effect.runSync(ReviewLoopExtension.setup({ cwd: "/tmp", source: "test" })),
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
    yield* runtime.handleIntent(sessionId, "review-loop", intent, epoch, branchId)
  })

const reviewSignal = (summary?: string) =>
  new ToolCallSucceeded({
    sessionId,
    branchId,
    toolCallId: "tc-review" as ToolCallId,
    toolName: "code_review",
    summary,
  })

describe("ReviewLoop runtime integration", () => {
  test("full lifecycle: start → signal → iterate → signal → complete", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // Start review (queues first follow-up)
        yield* sendIntent(runtime, { _tag: "StartReview", focus: "test", maxIterations: 2 })

        const snap1 = yield* getSnapshot(runtime)
        const ui1 = snap1!.model as ReviewLoopUiModel
        expect(ui1.active).toBe(true)
        expect(ui1.iteration).toBe(1)

        // First review signal — advances to iteration 2
        yield* runtime.reduce(reviewSignal("Found auth issue"), { sessionId, branchId })

        const snap2 = yield* getSnapshot(runtime)
        const ui2 = snap2!.model as ReviewLoopUiModel
        expect(ui2.active).toBe(true)
        expect(ui2.iteration).toBe(2)
        expect(ui2.findingsCount).toBe(1)

        // Second review signal (at max) — completes
        yield* runtime.reduce(reviewSignal("All clear"), { sessionId, branchId })

        const snap3 = yield* getSnapshot(runtime)
        const ui3 = snap3!.model as ReviewLoopUiModel
        expect(ui3.active).toBe(false)
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  test("TurnCompleted does not advance the loop in runtime", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendIntent(runtime, { _tag: "StartReview", maxIterations: 2 })

        // TurnCompleted should not change state
        const changed = yield* runtime.reduce(
          new TurnCompleted({ sessionId, branchId, durationMs: 100 }),
          { sessionId, branchId },
        )
        expect(changed).toBe(false)

        const snap = yield* getSnapshot(runtime)
        const ui = snap!.model as ReviewLoopUiModel
        expect(ui.iteration).toBe(1) // Unchanged
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
        expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: true })

        yield* sendIntent(runtime, { _tag: "CancelReview" })
        expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: false })
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  test("persistence: state survives actor hydration", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage

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
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  test("tool signal records real summary from event", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendIntent(runtime, { _tag: "StartReview", maxIterations: 3 })

        yield* runtime.reduce(reviewSignal("Missing error handling in src/api.ts"), {
          sessionId,
          branchId,
        })

        // Verify the real summary is captured (via derive prompt section)
        const projections = yield* runtime.deriveAll(sessionId, {
          agent: undefined as never,
          allTools: [],
        })
        const pm = projections.find((p) => p.extensionId === "review-loop")
        const section = pm!.projection.promptSections![0]!
        expect(section.content).toContain("Missing error handling in src/api.ts")
      }).pipe(Effect.provide(makeLayer())),
    )
  })
})
