import { describe, it, test, expect } from "effect-bun-test"
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
  AutoActorConfig,
  AutoExtension,
  type AutoState,
  type AutoUiModel,
} from "@gent/core/extensions/auto"
import { createActorHarness } from "@gent/core/test-utils/extension-harness"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { Storage } from "@gent/core/storage/sqlite-storage"

// ── Pure reducer tests ──

describe("Auto pure reducer", () => {
  const { reduce, derive, intent, events } = createActorHarness(AutoActorConfig)

  // ── State machine contracts ──

  describe("state transitions", () => {
    test("initial state is Inactive", () => {
      expect(AutoActorConfig.initial._tag).toBe("Inactive")
    })

    test("StartAuto intent → Working { iteration: 1 }", () => {
      const result = intent!({ _tag: "Inactive" }, { _tag: "StartAuto", goal: "fix all bugs" })
      expect(result.state._tag).toBe("Working")
      if (result.state._tag === "Working") {
        expect(result.state.iteration).toBe(1)
        expect(result.state.maxIterations).toBe(10)
        expect(result.state.goal).toBe("fix all bugs")
        expect(result.state.learnings).toEqual([])
        expect(result.state.metrics).toEqual([])
        expect(result.state.turnsSinceCheckpoint).toBe(0)
      }
    })

    test("StartAuto with custom maxIterations", () => {
      const result = intent!(
        { _tag: "Inactive" },
        { _tag: "StartAuto", goal: "audit", maxIterations: 5 },
      )
      if (result.state._tag === "Working") {
        expect(result.state.maxIterations).toBe(5)
      }
    })

    test("StartAuto when already active → no-op", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 2,
        maxIterations: 10,
        goal: "test",
        learnings: [],
        metrics: [],
        turnsSinceCheckpoint: 0,
      }
      const result = intent!(state, { _tag: "StartAuto", goal: "new goal" })
      expect(result.state).toBe(state)
    })

    test("Working + AutoSignal(continue) → AwaitingCounsel", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 1,
        maxIterations: 5,
        goal: "audit code",
        learnings: [],
        metrics: [],
        turnsSinceCheckpoint: 2,
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolName: "auto_checkpoint",
          output: JSON.stringify({
            status: "continue",
            summary: "Found 3 issues",
            learnings: "Auth module needs refactor",
            nextIdea: "Check error handling next",
          }),
        }),
      )
      expect(result.state._tag).toBe("AwaitingCounsel")
      if (result.state._tag === "AwaitingCounsel") {
        expect(result.state.iteration).toBe(1) // stays at current iteration
        expect(result.state.learnings.length).toBe(1)
        expect(result.state.learnings[0]!.content).toBe("Auth module needs refactor")
        expect(result.state.lastSummary).toBe("Found 3 issues")
        expect(result.state.nextIdea).toBe("Check error handling next")
      }
    })

    test("Working + AutoSignal(complete) → Inactive", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 3,
        maxIterations: 5,
        goal: "test",
        learnings: [],
        metrics: [],
        turnsSinceCheckpoint: 0,
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolName: "auto_checkpoint",
          output: JSON.stringify({ status: "complete", summary: "All done" }),
        }),
      )
      expect(result.state._tag).toBe("Inactive")
    })

    test("Working + AutoSignal(abandon) → Inactive", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 2,
        maxIterations: 5,
        goal: "test",
        learnings: [],
        metrics: [],
        turnsSinceCheckpoint: 0,
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolName: "auto_checkpoint",
          output: JSON.stringify({ status: "abandon", summary: "Not feasible" }),
        }),
      )
      expect(result.state._tag).toBe("Inactive")
    })

    test("AwaitingCounsel + CounselSignal → Working { iteration: N+1 }", () => {
      const state: AutoState = {
        _tag: "AwaitingCounsel",
        iteration: 2,
        maxIterations: 5,
        goal: "audit",
        learnings: [{ iteration: 1, content: "learned something" }],
        metrics: [],
        lastSummary: "prev summary",
        nextIdea: "try this",
      }
      const result = reduce(state, events.toolCallSucceeded({ toolName: "counsel" }))
      expect(result.state._tag).toBe("Working")
      if (result.state._tag === "Working") {
        expect(result.state.iteration).toBe(3)
        expect(result.state.turnsSinceCheckpoint).toBe(0)
        expect(result.state.learnings.length).toBe(1) // preserved
        expect(result.state.lastSummary).toBe("prev summary")
        expect(result.state.nextIdea).toBe("try this")
      }
    })

    test("AwaitingCounsel at maxIterations + CounselSignal → Inactive", () => {
      const state: AutoState = {
        _tag: "AwaitingCounsel",
        iteration: 5,
        maxIterations: 5,
        goal: "test",
        learnings: [],
        metrics: [],
      }
      const result = reduce(state, events.toolCallSucceeded({ toolName: "counsel" }))
      expect(result.state._tag).toBe("Inactive")
    })

    test("Working + CancelAuto → Inactive", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 3,
        maxIterations: 10,
        goal: "test",
        learnings: [],
        metrics: [],
        turnsSinceCheckpoint: 0,
      }
      const result = intent!(state, { _tag: "CancelAuto" })
      expect(result.state._tag).toBe("Inactive")
    })

    test("AwaitingCounsel + CancelAuto → Inactive", () => {
      const state: AutoState = {
        _tag: "AwaitingCounsel",
        iteration: 2,
        maxIterations: 5,
        goal: "test",
        learnings: [],
        metrics: [],
      }
      const result = intent!(state, { _tag: "CancelAuto" })
      expect(result.state._tag).toBe("Inactive")
    })

    test("CancelAuto when Inactive → no-op", () => {
      const state: AutoState = { _tag: "Inactive" }
      const result = intent!(state, { _tag: "CancelAuto" })
      expect(result.state).toBe(state)
    })
  })

  // ── Wedge prevention ──

  describe("wedge prevention", () => {
    test("TurnCompleted increments turnsSinceCheckpoint", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 1,
        maxIterations: 5,
        goal: "test",
        learnings: [],
        metrics: [],
        turnsSinceCheckpoint: 2,
      }
      const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
      if (result.state._tag === "Working") {
        expect(result.state.turnsSinceCheckpoint).toBe(3)
      }
    })

    test("turnsSinceCheckpoint >= 5 → Inactive (wedge auto-cancel)", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 1,
        maxIterations: 10,
        goal: "test",
        learnings: [],
        metrics: [],
        turnsSinceCheckpoint: 4,
      }
      const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
      expect(result.state._tag).toBe("Inactive")
    })
  })

  // ── mapEvent contracts ──

  describe("mapEvent filtering", () => {
    test("auto_checkpoint while Working → AutoSignal", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 1,
        maxIterations: 3,
        goal: "test",
        learnings: [],
        metrics: [],
        turnsSinceCheckpoint: 0,
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolName: "auto_checkpoint",
          output: JSON.stringify({ status: "continue", summary: "ok" }),
        }),
      )
      expect(result.state._tag).toBe("AwaitingCounsel")
    })

    test("auto_checkpoint while AwaitingCounsel → ignored (must counsel first)", () => {
      const state: AutoState = {
        _tag: "AwaitingCounsel",
        iteration: 1,
        maxIterations: 5,
        goal: "test",
        learnings: [],
        metrics: [],
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolName: "auto_checkpoint",
          output: JSON.stringify({ status: "continue", summary: "trying again" }),
        }),
      )
      // AwaitingCounsel doesn't handle AutoSignal — stays unchanged
      expect(result.state).toBe(state)
    })

    test("counsel while AwaitingCounsel → CounselSignal", () => {
      const state: AutoState = {
        _tag: "AwaitingCounsel",
        iteration: 1,
        maxIterations: 5,
        goal: "test",
        learnings: [],
        metrics: [],
      }
      const result = reduce(state, events.toolCallSucceeded({ toolName: "counsel" }))
      expect(result.state._tag).toBe("Working")
    })

    test("counsel while Working → ignored (CounselSignal not handled in Working)", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 1,
        maxIterations: 5,
        goal: "test",
        learnings: [],
        metrics: [],
        turnsSinceCheckpoint: 0,
      }
      const result = reduce(state, events.toolCallSucceeded({ toolName: "counsel" }))
      expect(result.state).toBe(state)
    })

    test("unrelated tool does not advance", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 1,
        maxIterations: 3,
        goal: "test",
        learnings: [],
        metrics: [],
        turnsSinceCheckpoint: 0,
      }
      const result = reduce(state, events.toolCallSucceeded({ toolName: "read" }))
      expect(result.state).toBe(state)
    })

    test("Inactive ignores all events", () => {
      const state: AutoState = { _tag: "Inactive" }
      const r1 = reduce(state, events.turnCompleted({ durationMs: 100 }))
      expect(r1.state).toBe(state)
      const r2 = reduce(
        state,
        events.toolCallSucceeded({
          toolName: "auto_checkpoint",
          output: JSON.stringify({ status: "continue", summary: "x" }),
        }),
      )
      expect(r2.state).toBe(state)
    })
  })

  // ── Learnings accumulation ──

  describe("learnings", () => {
    test("learnings from AutoSignal are appended, not overwritten", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 2,
        maxIterations: 5,
        goal: "test",
        learnings: [{ iteration: 1, content: "first insight" }],
        metrics: [],
        turnsSinceCheckpoint: 0,
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolName: "auto_checkpoint",
          output: JSON.stringify({
            status: "continue",
            summary: "more work",
            learnings: "second insight",
          }),
        }),
      )
      if (result.state._tag === "AwaitingCounsel") {
        expect(result.state.learnings.length).toBe(2)
        expect(result.state.learnings[0]!.content).toBe("first insight")
        expect(result.state.learnings[1]!.content).toBe("second insight")
        expect(result.state.learnings[1]!.iteration).toBe(2)
      }
    })

    test("no learnings field → existing learnings preserved", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 2,
        maxIterations: 5,
        goal: "test",
        learnings: [{ iteration: 1, content: "existing" }],
        metrics: [],
        turnsSinceCheckpoint: 0,
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolName: "auto_checkpoint",
          output: JSON.stringify({ status: "continue", summary: "no new learnings" }),
        }),
      )
      if (result.state._tag === "AwaitingCounsel") {
        expect(result.state.learnings.length).toBe(1)
        expect(result.state.learnings[0]!.content).toBe("existing")
      }
    })

    test("metrics are accumulated across iterations", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 2,
        maxIterations: 5,
        goal: "test",
        learnings: [],
        metrics: [{ iteration: 1, values: { findings: 3 } }],
        turnsSinceCheckpoint: 0,
      }
      const result = reduce(
        state,
        events.toolCallSucceeded({
          toolName: "auto_checkpoint",
          output: JSON.stringify({
            status: "continue",
            summary: "more",
            metrics: { findings: 5, coverage: 80 },
          }),
        }),
      )
      if (result.state._tag === "AwaitingCounsel") {
        expect(result.state.metrics.length).toBe(2)
        expect(result.state.metrics[1]!.values).toEqual({ findings: 5, coverage: 80 })
      }
    })
  })

  // ── Derive contracts ──

  describe("derive", () => {
    test("Inactive — no prompt sections, active: false, excludes auto_checkpoint", () => {
      const projection = derive({ _tag: "Inactive" })
      expect(projection.promptSections).toBeUndefined()
      expect(projection.toolPolicy?.exclude).toEqual(["auto_checkpoint"])
      const ui = projection.uiModel as AutoUiModel
      expect(ui.active).toBe(false)
      expect(ui.learningsCount).toBe(0)
    })

    test("Working — injects prompt section with goal + checkpoint instruction", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 2,
        maxIterations: 5,
        goal: "audit code quality",
        learnings: [{ iteration: 1, content: "auth needs refactor" }],
        metrics: [],
        turnsSinceCheckpoint: 1,
        lastSummary: "found issues",
        nextIdea: "check error handling",
      }
      const projection = derive(state)
      expect(projection.promptSections).toBeDefined()
      expect(projection.promptSections!.length).toBe(1)
      const section = projection.promptSections![0]!
      expect(section.id).toBe("auto-loop-context")
      expect(section.priority).toBe(91)
      expect(section.content).toContain("Iteration 2/5")
      expect(section.content).toContain("audit code quality")
      expect(section.content).toContain("auth needs refactor")
      expect(section.content).toContain("auto_checkpoint")
      expect(section.content).toContain("check error handling")
      expect(section.content).toContain("found issues")
      // auto_checkpoint should NOT be excluded when active
      expect(projection.toolPolicy).toBeUndefined()
    })

    test("Working — ui model shows working phase", () => {
      const state: AutoState = {
        _tag: "Working",
        iteration: 3,
        maxIterations: 10,
        goal: "fix bugs",
        learnings: [
          { iteration: 1, content: "a" },
          { iteration: 2, content: "b" },
        ],
        metrics: [],
        turnsSinceCheckpoint: 0,
      }
      const projection = derive(state)
      const ui = projection.uiModel as AutoUiModel
      expect(ui.active).toBe(true)
      expect(ui.phase).toBe("working")
      expect(ui.iteration).toBe(3)
      expect(ui.maxIterations).toBe(10)
      expect(ui.goal).toBe("fix bugs")
      expect(ui.learningsCount).toBe(2)
    })

    test("AwaitingCounsel — injects counsel requirement prompt", () => {
      const state: AutoState = {
        _tag: "AwaitingCounsel",
        iteration: 2,
        maxIterations: 5,
        goal: "audit",
        learnings: [],
        metrics: [],
      }
      const projection = derive(state)
      expect(projection.promptSections).toBeDefined()
      const section = projection.promptSections![0]!
      expect(section.content).toContain("counsel")
      expect(section.content).toContain("MUST call")
    })

    test("AwaitingCounsel — ui model shows awaiting-counsel phase", () => {
      const state: AutoState = {
        _tag: "AwaitingCounsel",
        iteration: 2,
        maxIterations: 5,
        goal: "test",
        learnings: [{ iteration: 1, content: "x" }],
        metrics: [],
      }
      const projection = derive(state)
      const ui = projection.uiModel as AutoUiModel
      expect(ui.active).toBe(true)
      expect(ui.phase).toBe("awaiting-counsel")
      expect(ui.learningsCount).toBe(1)
    })
  })
})

// ── Runtime integration tests ──

const sessionId = "auto-session" as SessionId
const branchId = "auto-branch" as BranchId

const autoExtension: LoadedExtension = {
  manifest: AutoExtension.manifest,
  kind: "builtin",
  sourcePath: "builtin",
  setup: Effect.runSync(AutoExtension.setup({ cwd: "/tmp", source: "test", home: "/tmp" })),
}

const makeLayer = () =>
  Layer.mergeAll(
    ExtensionStateRuntime.Live([autoExtension]),
    EventStore.Memory,
    ExtensionTurnControl.Test(),
    Storage.Test(),
  )

const getSnapshot = (runtime: ExtensionStateRuntime) =>
  Effect.gen(function* () {
    const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
    return snapshots.find((s) => s.extensionId === "auto")
  })

const sendIntent = (runtime: ExtensionStateRuntime, intent: unknown) =>
  Effect.gen(function* () {
    const snap = yield* getSnapshot(runtime)
    const epoch = snap?.epoch ?? 0
    yield* runtime.handleIntent(sessionId, "auto", intent, epoch, branchId)
  })

const checkpointSignal = (output: Record<string, unknown>) =>
  new ToolCallSucceeded({
    sessionId,
    branchId,
    toolCallId: "tc-checkpoint" as ToolCallId,
    toolName: "auto_checkpoint",
    output: JSON.stringify(output),
  })

const counselSignal = () =>
  new ToolCallSucceeded({
    sessionId,
    branchId,
    toolCallId: "tc-counsel" as ToolCallId,
    toolName: "counsel",
  })

const turnCompleted = () => new TurnCompleted({ sessionId, branchId, durationMs: 100 })

describe("Auto runtime integration", () => {
  it.live("full lifecycle: start → checkpoint → counsel → iterate → complete", () =>
    Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      // Start auto
      yield* sendIntent(runtime, { _tag: "StartAuto", goal: "fix all bugs", maxIterations: 3 })

      const snap1 = yield* getSnapshot(runtime)
      const ui1 = snap1!.model as AutoUiModel
      expect(ui1.active).toBe(true)
      expect(ui1.phase).toBe("working")
      expect(ui1.iteration).toBe(1)

      // Checkpoint with continue → AwaitingCounsel
      yield* runtime.reduce(
        checkpointSignal({ status: "continue", summary: "Found issues", learnings: "auth bad" }),
        { sessionId, branchId },
      )

      const snap2 = yield* getSnapshot(runtime)
      const ui2 = snap2!.model as AutoUiModel
      expect(ui2.phase).toBe("awaiting-counsel")
      expect(ui2.learningsCount).toBe(1)

      // Counsel → Working (iteration 2)
      yield* runtime.reduce(counselSignal(), { sessionId, branchId })

      const snap3 = yield* getSnapshot(runtime)
      const ui3 = snap3!.model as AutoUiModel
      expect(ui3.phase).toBe("working")
      expect(ui3.iteration).toBe(2)

      // Complete
      yield* runtime.reduce(checkpointSignal({ status: "complete", summary: "All fixed" }), {
        sessionId,
        branchId,
      })

      const snap4 = yield* getSnapshot(runtime)
      const ui4 = snap4!.model as AutoUiModel
      expect(ui4.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("TurnCompleted does not advance the loop, only increments watchdog", () =>
    Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendIntent(runtime, { _tag: "StartAuto", goal: "test" })

      // TurnCompleted should not change UI iteration
      yield* runtime.reduce(turnCompleted(), { sessionId, branchId })

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoUiModel
      expect(ui.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("cancel mid-working returns to Inactive", () =>
    Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendIntent(runtime, { _tag: "StartAuto", goal: "test" })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: true })

      yield* sendIntent(runtime, { _tag: "CancelAuto" })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: false })
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("cancel from AwaitingCounsel returns to Inactive", () =>
    Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendIntent(runtime, { _tag: "StartAuto", goal: "test" })

      // Move to AwaitingCounsel
      yield* runtime.reduce(checkpointSignal({ status: "continue", summary: "x" }), {
        sessionId,
        branchId,
      })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ phase: "awaiting-counsel" })

      yield* sendIntent(runtime, { _tag: "CancelAuto" })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: false })
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("wedge prevention: 5 turns without checkpoint → auto-cancel", () =>
    Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendIntent(runtime, { _tag: "StartAuto", goal: "test" })

      // 5 turns without checkpoint
      for (let i = 0; i < 5; i++) {
        yield* runtime.reduce(turnCompleted(), { sessionId, branchId })
      }

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoUiModel
      expect(ui.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("maxIterations reached after counsel → Inactive", () =>
    Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendIntent(runtime, { _tag: "StartAuto", goal: "test", maxIterations: 1 })

      // Checkpoint continue at iteration 1/1
      yield* runtime.reduce(checkpointSignal({ status: "continue", summary: "done" }), {
        sessionId,
        branchId,
      })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ phase: "awaiting-counsel" })

      // Counsel at max → should go Inactive, not Working
      yield* runtime.reduce(counselSignal(), { sessionId, branchId })

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoUiModel
      expect(ui.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("persistence: state survives actor hydration", () =>
    Effect.gen(function* () {
      const storage = yield* Storage

      const autoState: AutoState = {
        _tag: "Working",
        iteration: 3,
        maxIterations: 10,
        goal: "audit security",
        learnings: [
          { iteration: 1, content: "found XSS" },
          { iteration: 2, content: "fixed XSS" },
        ],
        metrics: [],
        turnsSinceCheckpoint: 1,
      }
      yield* storage.saveExtensionState({
        sessionId,
        extensionId: "auto",
        stateJson: JSON.stringify(autoState),
        version: 5,
      })

      const runtime = yield* ExtensionStateRuntime
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      const snap = yield* getSnapshot(runtime)
      expect(snap).toBeDefined()
      expect(snap!.epoch).toBe(5)
      const ui = snap!.model as AutoUiModel
      expect(ui.active).toBe(true)
      expect(ui.iteration).toBe(3)
      expect(ui.learningsCount).toBe(2)
      expect(ui.goal).toBe("audit security")
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("derive injects learnings into prompt sections", () =>
    Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendIntent(runtime, { _tag: "StartAuto", goal: "audit" })

      // Checkpoint with learnings
      yield* runtime.reduce(
        checkpointSignal({
          status: "continue",
          summary: "found issues",
          learnings: "SQL injection in user service",
        }),
        { sessionId, branchId },
      )

      // Move to next iteration
      yield* runtime.reduce(counselSignal(), { sessionId, branchId })

      // Check prompt sections have the learning
      const projections = yield* runtime.deriveAll(sessionId, {
        agent: undefined as never,
        allTools: [],
      })
      const pm = projections.find((p) => p.extensionId === "auto")
      const section = pm!.projection.promptSections![0]!
      expect(section.content).toContain("SQL injection in user service")
    }).pipe(Effect.provide(makeLayer())),
  )
})
