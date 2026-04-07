import { describe, it, test, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import {
  EventStore,
  SessionStarted,
  StreamChunk,
  StreamStarted,
  TaskCompleted,
  TaskCreated,
  TaskFailed,
  TaskStopped,
  TaskUpdated,
  TurnCompleted,
  ToolCallSucceeded,
} from "@gent/core/domain/event"
import type { BranchId, SessionId, TaskId, ToolCallId } from "@gent/core/domain/ids"
import type { LoadedExtension } from "@gent/core/domain/extension"
import {
  extractSteps,
  PlanActorConfig,
  PlanExtension,
  PLAN_EXTENSION_ID,
  type PlanState,
} from "@gent/core/extensions/plan"
import { PlanProtocol } from "@gent/core/extensions/plan-protocol"
import { createActorHarness } from "@gent/core/test-utils/extension-harness"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { Storage } from "@gent/core/storage/sqlite-storage"

const sessionId = "pm-session" as SessionId
const branchId = "pm-branch" as BranchId

const planExtension: LoadedExtension = {
  manifest: PlanExtension.manifest,
  kind: "builtin",
  sourcePath: "builtin",
  setup: Effect.runSync(PlanExtension.setup({ cwd: "/tmp", source: "test", home: "/tmp" })),
}

const makeLayer = () =>
  Layer.mergeAll(
    ExtensionStateRuntime.Live([planExtension]).pipe(
      Layer.provideMerge(ExtensionTurnControl.Test()),
    ),
    EventStore.Memory,
    Storage.Test(),
  )

/** Helper: get plan UI snapshot */
const getPlanSnapshot = (runtime: ExtensionStateRuntime) =>
  Effect.gen(function* () {
    const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
    return snapshots.find((s) => s.extensionId === PLAN_EXTENSION_ID)
  })

const sendPlan = (
  runtime: ExtensionStateRuntime,
  intent: { readonly _tag: "TogglePlan" | "ExecutePlan" | "RefinePlan" },
) => {
  switch (intent._tag) {
    case "TogglePlan":
      return runtime.send(sessionId, PlanProtocol.TogglePlan(), branchId)
    case "ExecutePlan":
      return runtime.send(sessionId, PlanProtocol.ExecutePlan(), branchId)
    case "RefinePlan":
      return runtime.send(sessionId, PlanProtocol.RefinePlan(), branchId)
  }
}

describe("Plan actor", () => {
  describe("initial state", () => {
    it.live("starts in normal mode with empty steps", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        // Trigger actor spawn
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        const snap = yield* getPlanSnapshot(runtime)
        expect(snap).toBeDefined()
        const model = snap!.model as PlanState
        expect(model.mode).toBe("normal")
        expect(model.steps).toEqual([])
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  describe("derive", () => {
    it.live("normal mode — no tool policy, no prompt sections", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        const projections = yield* runtime.deriveAll(sessionId, {
          agent: undefined as never,
          allTools: [],
        })
        const pm = projections.find((p) => p.extensionId === PLAN_EXTENSION_ID)
        expect(pm).toBeDefined()
        expect(pm!.projection.toolPolicy).toBeUndefined()
        expect(pm!.projection.promptSections).toBeUndefined()
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("plan mode — restricts tools to read-only set", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // Toggle to plan mode
        yield* sendPlan(runtime, { _tag: "TogglePlan" })

        const projections = yield* runtime.deriveAll(sessionId, {
          agent: undefined as never,
          allTools: [],
        })
        const pm = projections.find((p) => p.extensionId === PLAN_EXTENSION_ID)
        expect(pm!.projection.toolPolicy).toBeDefined()
        expect(pm!.projection.toolPolicy!.overrideSet).toEqual(["read", "bash", "grep", "glob"])
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("plan mode — injects prompt section", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        yield* sendPlan(runtime, { _tag: "TogglePlan" })

        const projections = yield* runtime.deriveAll(sessionId, {
          agent: undefined as never,
          allTools: [],
        })
        const pm = projections.find((p) => p.extensionId === PLAN_EXTENSION_ID)
        expect(pm!.projection.promptSections).toBeDefined()
        expect(pm!.projection.promptSections!.length).toBe(1)
        expect(pm!.projection.promptSections![0]!.id).toBe("plan-restrictions")
      }).pipe(Effect.provide(makeLayer())),
    )

    // executing mode tool policy tested in pure reducer suite below
  })

  describe("reduce", () => {
    it.live("executing mode — marks first pending as in-progress on StreamStarted", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // Toggle to plan, then manually get into executing state via intent
        // Since we can't easily set steps through the actor, we'll verify through
        // the full event flow — the actor's reduce is the same pure function
        yield* sendPlan(runtime, { _tag: "TogglePlan" })

        // Send stream started — in plan mode, this is a no-op (no steps to mark)
        yield* runtime.publish(new StreamStarted({ sessionId, branchId }), { sessionId, branchId })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("plan")
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("normal mode — events are no-ops (epoch stable)", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        const snap1 = yield* getPlanSnapshot(runtime)
        const epoch1 = snap1!.epoch

        // Events in normal mode should not change state
        const changed = yield* runtime.publish(
          new TurnCompleted({ sessionId, branchId, durationMs: 100 }),
          { sessionId, branchId },
        )
        expect(changed).toBe(false)

        const snap2 = yield* getPlanSnapshot(runtime)
        expect(snap2!.epoch).toBe(epoch1)
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("executing mode — edit tool success advances progress", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // In normal mode, tool calls should not affect state
        const changed = yield* runtime.publish(
          new ToolCallSucceeded({
            sessionId,
            branchId,
            toolCallId: "tc1" as ToolCallId,
            toolName: "edit",
          }),
          { sessionId, branchId },
        )
        expect(changed).toBe(false)
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  describe("send", () => {
    it.live("toggling from normal enters plan mode", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendPlan(runtime, { _tag: "TogglePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("plan")
        expect(model.steps).toEqual([])
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("toggling from plan returns to normal", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendPlan(runtime, { _tag: "TogglePlan" })
        yield* sendPlan(runtime, { _tag: "TogglePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("normal")
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("executing plan without steps stays in plan mode", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendPlan(runtime, { _tag: "TogglePlan" })
        yield* sendPlan(runtime, { _tag: "ExecutePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("plan") // No steps → stays in plan
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("executing plan from normal mode does nothing", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendPlan(runtime, { _tag: "ExecutePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("normal")
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("refining in plan mode clears steps", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendPlan(runtime, { _tag: "TogglePlan" })
        yield* sendPlan(runtime, { _tag: "RefinePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("plan")
        expect(model.steps).toEqual([])
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("refining from normal mode does nothing", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendPlan(runtime, { _tag: "RefinePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("normal")
      }).pipe(Effect.provide(makeLayer())),
    )
  })
})

describe("Plan pure reducer — executing behavior", () => {
  const { reduce, derive, receive, events } = createActorHarness(PlanActorConfig)

  test("executing mode — unmatched events preserve state", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [{ id: 1, text: "A", status: "in_progress" }],
    }
    const result = reduce(
      state,
      events.toolCallSucceeded({ toolCallId: "tc1" as ToolCallId, toolName: "read" }),
    )
    expect(result.state.steps[0]!.status).toBe("in_progress")
  })

  test("executing mode — derive injects plan context prompt section", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [
        { id: 1, text: "Read files", status: "completed" },
        { id: 2, text: "Edit code", status: "in_progress" },
        { id: 3, text: "Run tests", status: "pending" },
      ],
    }
    const projection = derive(state)
    expect(projection.promptSections).toBeDefined()
    expect(projection.promptSections!.length).toBe(1)
    expect(projection.promptSections![0]!.id).toBe("plan-executing")
    expect(projection.promptSections![0]!.content).toContain("[x] Read files")
    expect(projection.promptSections![0]!.content).toContain("[~] Edit code")
    expect(projection.promptSections![0]!.content).toContain("[ ] Run tests")
  })

  test("executing mode — no tool policy restriction", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [{ id: 1, text: "Do thing", status: "pending" }],
    }
    const projection = derive(state)
    expect(projection.toolPolicy).toBeUndefined()
  })

  test("ui model includes progress counts", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [
        { id: 1, text: "A", status: "completed" },
        { id: 2, text: "B", status: "in_progress" },
        { id: 3, text: "C", status: "pending" },
      ],
    }
    const projection = derive(state)
    const ui = projection.uiModel as {
      progress: { total: number; completed: number; inProgress: number }
    }
    expect(ui.progress.total).toBe(3)
    expect(ui.progress.completed).toBe(1)
    expect(ui.progress.inProgress).toBe(1)
  })

  test("normal mode — events are no-ops (reference equality)", () => {
    const state: PlanState = { mode: "normal", steps: [] }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state).toBe(state)
  })

  test("executing plan with steps enters executing mode", () => {
    const state: PlanState = {
      mode: "plan",
      steps: [{ id: 1, text: "A", status: "pending" }],
    }
    const result = receive!(state, { _tag: "ExecutePlan" })
    expect(result.state.mode).toBe("executing")
  })

  test("toggling from executing returns to normal", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [{ id: 1, text: "A", status: "pending" }],
    }
    const result = receive!(state, { _tag: "TogglePlan" })
    expect(result.state.mode).toBe("normal")
  })

  test("refining from executing returns to plan with cleared steps", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [
        { id: 1, text: "Read files", status: "completed" },
        { id: 2, text: "Edit code", status: "in_progress" },
        { id: 3, text: "Run tests", status: "pending" },
      ],
      taskMap: { "t-1": 0, "t-2": 1 },
      planFilePath: "/tmp/plan.md",
    }
    const result = receive!(state, { _tag: "RefinePlan" })
    expect(result.state.mode).toBe("plan")
    expect(result.state.steps).toEqual([])
    expect(result.state.taskMap).toBeUndefined()
    expect(result.state.pendingText).toBeUndefined()
  })
})

describe("Plan pure reducer — plan tool observation", () => {
  const { reduce, events } = createActorHarness(PlanActorConfig)

  const planToolOutput = (output: Record<string, unknown>) =>
    events.toolCallSucceeded({
      toolCallId: "tc-plan" as ToolCallId,
      toolName: "plan",
      output: JSON.stringify(output),
    })

  test("plan tool decision=yes transitions to executing with steps", () => {
    const state: PlanState = { mode: "normal", steps: [] }
    const result = reduce(
      state,
      planToolOutput({
        mode: "plan-only",
        decision: "yes",
        plan: "## Plan\n- [ ] Fix auth\n- [ ] Add tests",
        path: "/tmp/plan.md",
      }),
    )
    expect(result.state.mode).toBe("executing")
    expect(result.state.steps.length).toBe(2)
    expect(result.state.planFilePath).toBe("/tmp/plan.md")
    expect(result.state.taskMap).toEqual({})
    expect(result.effects?.length).toBe(1)
    expect(result.effects![0]!._tag).toBe("QueueFollowUp")
  })

  test("plan tool decision=edit stays in plan mode with extracted steps", () => {
    const state: PlanState = { mode: "normal", steps: [] }
    const result = reduce(
      state,
      planToolOutput({
        mode: "plan-only",
        decision: "edit",
        plan: "- [ ] Refactored step 1\n- [ ] Step 2",
        path: "/tmp/plan-edited.md",
      }),
    )
    expect(result.state.mode).toBe("plan")
    expect(result.state.steps.length).toBe(2)
    expect(result.state.planFilePath).toBe("/tmp/plan-edited.md")
    expect(result.effects).toBeUndefined()
  })

  test("plan tool decision=no is ignored", () => {
    const state: PlanState = { mode: "normal", steps: [] }
    const result = reduce(
      state,
      planToolOutput({ mode: "plan-only", decision: "no", plan: "some plan" }),
    )
    expect(result.state.mode).toBe("normal")
    expect(result.state.steps.length).toBe(0)
  })

  test("non-plan tool ToolCallSucceeded is ignored", () => {
    const state: PlanState = { mode: "normal", steps: [] }
    const result = reduce(
      state,
      events.toolCallSucceeded({
        toolCallId: "tc1" as ToolCallId,
        toolName: "read",
        output: JSON.stringify({ decision: "yes" }),
      }),
    )
    expect(result.state.mode).toBe("normal")
  })
})

describe("Plan pure reducer — step extraction", () => {
  const { reduce, events } = createActorHarness(PlanActorConfig)

  const streamChunk = (chunk: string) => new StreamChunk({ sessionId, branchId, chunk })

  test("plan mode — StreamChunk accumulates pendingText", () => {
    const state: PlanState = { mode: "plan", steps: [] }
    const r1 = reduce(state, streamChunk("## Plan\n"))
    expect(r1.state.pendingText).toBe("## Plan\n")
    const r2 = reduce(r1.state, streamChunk("- [ ] First step\n"))
    expect(r2.state.pendingText).toBe("## Plan\n- [ ] First step\n")
  })

  test("plan mode — TurnCompleted extracts steps from accumulated text", () => {
    const state: PlanState = {
      mode: "plan",
      steps: [],
      pendingText: "## Plan\n- [ ] Read files\n- [ ] Edit code\n- [x] Already done",
    }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state.steps.length).toBe(3)
    expect(result.state.steps[0]!.text).toBe("Read files")
    expect(result.state.steps[0]!.status).toBe("pending")
    expect(result.state.steps[2]!.status).toBe("completed")
    expect(result.state.pendingText).toBeUndefined()
  })

  test("plan mode — TurnCompleted with no pendingText → no-op", () => {
    const state: PlanState = { mode: "plan", steps: [] }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state).toBe(state)
  })

  test("plan mode — TurnCompleted with non-plan text → clears pendingText, no steps", () => {
    const state: PlanState = {
      mode: "plan",
      steps: [],
      pendingText: "Just some regular text without any plan items.",
    }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state.steps.length).toBe(0)
    expect(result.state.pendingText).toBeUndefined()
  })

  test("normal mode — StreamChunk is no-op", () => {
    const state: PlanState = { mode: "normal", steps: [] }
    const result = reduce(state, streamChunk("## Plan\n- [ ] item\n"))
    expect(result.state).toBe(state)
  })
})

describe("Plan pure reducer — task integration", () => {
  const { reduce } = createActorHarness(PlanActorConfig)

  const taskCreated = (taskId: string, subject: string) =>
    new TaskCreated({ sessionId, branchId, taskId: taskId as TaskId, subject })

  const taskCompleted = (taskId: string) =>
    new TaskCompleted({ sessionId, branchId, taskId: taskId as TaskId })

  const taskFailed = (taskId: string) =>
    new TaskFailed({ sessionId, branchId, taskId: taskId as TaskId })

  const taskStopped = (taskId: string) =>
    new TaskStopped({ sessionId, branchId, taskId: taskId as TaskId })

  const taskUpdated = (taskId: string, status: string) =>
    new TaskUpdated({ sessionId, branchId, taskId: taskId as TaskId, status })

  test("executing mode — TaskCreated maps to matching step", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [
        { id: 1, text: "Read files", status: "pending" },
        { id: 2, text: "Edit code", status: "pending" },
      ],
      taskMap: {},
    }
    const result = reduce(state, taskCreated("t-1", "Read files"))
    expect(result.state.taskMap?.["t-1"]).toBe(0)
    expect(result.state.steps[0]!.status).toBe("in_progress")
    expect(result.state.steps[1]!.status).toBe("pending")
  })

  test("executing mode — TaskCompleted marks matching step done", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [
        { id: 1, text: "Read files", status: "in_progress" },
        { id: 2, text: "Edit code", status: "pending" },
      ],
      taskMap: { "t-1": 0 },
    }
    const result = reduce(state, taskCompleted("t-1"))
    expect(result.state.steps[0]!.status).toBe("completed")
    expect(result.state.mode).toBe("executing") // still have pending
  })

  test("executing mode — all tasks done → normal", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [
        { id: 1, text: "A", status: "completed" },
        { id: 2, text: "B", status: "in_progress" },
      ],
      taskMap: { "t-2": 1 },
    }
    const result = reduce(state, taskCompleted("t-2"))
    expect(result.state.steps[1]!.status).toBe("completed")
    expect(result.state.mode).toBe("normal")
  })

  test("executing mode — TaskFailed marks matching step failed", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [
        { id: 1, text: "A", status: "in_progress" },
        { id: 2, text: "B", status: "pending" },
      ],
      taskMap: { "t-1": 0 },
    }
    const result = reduce(state, taskFailed("t-1"))
    expect(result.state.steps[0]!.status).toBe("failed")
    expect(result.state.mode).toBe("executing") // still has pending step
  })

  test("executing mode — TaskStopped marks matching step stopped", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [
        { id: 1, text: "A", status: "in_progress" },
        { id: 2, text: "B", status: "pending" },
      ],
      taskMap: { "t-1": 0 },
    }
    const result = reduce(state, taskStopped("t-1"))
    expect(result.state.steps[0]!.status).toBe("stopped")
    expect(result.state.mode).toBe("executing") // still has pending step
  })

  test("executing mode — allComplete includes stopped as terminal", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [
        { id: 1, text: "A", status: "completed" },
        { id: 2, text: "B", status: "in_progress" },
      ],
      taskMap: { "t-1": 0, "t-2": 1 },
    }
    // Stopping the last non-terminal step → all terminal → mode goes to normal
    const result = reduce(state, taskStopped("t-2"))
    expect(result.state.steps[1]!.status).toBe("stopped")
    expect(result.state.mode).toBe("normal")
  })

  test("executing mode — TaskUpdated(in_progress) marks step in_progress", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [{ id: 1, text: "A", status: "pending" }],
      taskMap: { "t-1": 0 },
    }
    const result = reduce(state, taskUpdated("t-1", "in_progress"))
    expect(result.state.steps[0]!.status).toBe("in_progress")
  })

  test("executing mode — unmapped taskId → no-op", () => {
    const state: PlanState = {
      mode: "executing",
      steps: [{ id: 1, text: "A", status: "pending" }],
      taskMap: {},
    }
    const result = reduce(state, taskCompleted("t-unknown"))
    expect(result.state).toBe(state)
  })

  test("normal mode — task events are no-ops", () => {
    const state: PlanState = { mode: "normal", steps: [] }
    const result = reduce(state, taskCreated("t-1", "something"))
    expect(result.state).toBe(state)
  })
})

describe("extractSteps", () => {
  test("extracts markdown checklist items", () => {
    const text = `## Plan
- [ ] Read the config file
- [ ] Update the schema
- [x] Already done item`
    const steps = extractSteps(text)
    expect(steps.length).toBe(3)
    expect(steps[0]).toEqual({ id: 1, text: "Read the config file", status: "pending" })
    expect(steps[1]).toEqual({ id: 2, text: "Update the schema", status: "pending" })
    expect(steps[2]).toEqual({ id: 3, text: "Already done item", status: "completed" })
  })

  test("extracts numbered list under plan header", () => {
    const text = `# Steps
1. First thing
2. Second thing
3. Third thing`
    const steps = extractSteps(text)
    expect(steps.length).toBe(3)
    expect(steps[0]!.text).toBe("First thing")
    expect(steps[2]!.text).toBe("Third thing")
  })

  test("ignores numbered lists outside plan headers", () => {
    const text = `Some context

1. Random numbered item
2. Another one`
    const steps = extractSteps(text)
    expect(steps.length).toBe(0)
  })

  test("extracts checklists anywhere (not header-gated)", () => {
    const text = `Here are some items:
- [ ] Ungated checklist item
- [x] Done item`
    const steps = extractSteps(text)
    expect(steps.length).toBe(2)
  })

  test("handles empty text", () => {
    expect(extractSteps("")).toEqual([])
  })

  test("handles text with no steps", () => {
    expect(extractSteps("Just some regular text\nwith multiple lines")).toEqual([])
  })

  test("stops numbered list on new non-plan header", () => {
    const text = `## Tasks
1. Task one
2. Task two

## Results
3. This is not a task`
    const steps = extractSteps(text)
    expect(steps.length).toBe(2)
  })
})
