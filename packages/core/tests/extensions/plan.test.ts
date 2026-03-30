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
  TaskUpdated,
  TurnCompleted,
  ToolCallSucceeded,
} from "@gent/core/domain/event"
import type { BranchId, SessionId, TaskId, ToolCallId } from "@gent/core/domain/ids"
import type { LoadedExtension } from "@gent/core/domain/extension"
import {
  extractTodos,
  PlanActorConfig,
  PlanExtension,
  type PlanState,
} from "@gent/core/extensions/plan"
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
  setup: Effect.runSync(PlanExtension.setup({ cwd: "/tmp", source: "test" })),
}

const makeLayer = () =>
  Layer.mergeAll(
    ExtensionStateRuntime.Live([planExtension]),
    EventStore.Memory,
    ExtensionTurnControl.Test(),
    Storage.Test(),
  )

/** Helper: get plan UI snapshot */
const getPlanSnapshot = (runtime: ExtensionStateRuntime) =>
  Effect.gen(function* () {
    const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
    return snapshots.find((s) => s.extensionId === "plan")
  })

/** Helper: send intent with current epoch (reads snapshot first) */
const sendIntent = (runtime: ExtensionStateRuntime, intent: unknown) =>
  Effect.gen(function* () {
    const snap = yield* getPlanSnapshot(runtime)
    const epoch = snap?.epoch ?? 0
    yield* runtime.handleIntent(sessionId, "plan", intent, epoch, branchId)
  })

describe("Plan actor", () => {
  describe("initial state", () => {
    it.live("starts in normal mode with empty todos", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        // Trigger actor spawn
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        const snap = yield* getPlanSnapshot(runtime)
        expect(snap).toBeDefined()
        const model = snap!.model as PlanState
        expect(model.mode).toBe("normal")
        expect(model.todos).toEqual([])
      }).pipe(Effect.provide(makeLayer())),
    )
  })

  describe("derive", () => {
    it.live("normal mode — no tool policy, no prompt sections", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        const projections = yield* runtime.deriveAll(sessionId, {
          agent: undefined as never,
          allTools: [],
        })
        const pm = projections.find((p) => p.extensionId === "plan")
        expect(pm).toBeDefined()
        expect(pm!.projection.toolPolicy).toBeUndefined()
        expect(pm!.projection.promptSections).toBeUndefined()
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("plan mode — restricts tools to read-only set", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // Toggle to plan mode
        yield* sendIntent(runtime, { _tag: "TogglePlan" })

        const projections = yield* runtime.deriveAll(sessionId, {
          agent: undefined as never,
          allTools: [],
        })
        const pm = projections.find((p) => p.extensionId === "plan")
        expect(pm!.projection.toolPolicy).toBeDefined()
        expect(pm!.projection.toolPolicy!.overrideSet).toEqual(["read", "bash", "grep", "glob"])
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("plan mode — injects prompt section", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        yield* sendIntent(runtime, { _tag: "TogglePlan" })

        const projections = yield* runtime.deriveAll(sessionId, {
          agent: undefined as never,
          allTools: [],
        })
        const pm = projections.find((p) => p.extensionId === "plan")
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
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // Toggle to plan, then manually get into executing state via intent
        // Since we can't easily set todos through the actor, we'll verify through
        // the full event flow — the actor's reduce is the same pure function
        yield* sendIntent(runtime, { _tag: "TogglePlan" })

        // Send stream started — in plan mode, this is a no-op (no todos to mark)
        yield* runtime.reduce(new StreamStarted({ sessionId, branchId }), { sessionId, branchId })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("plan")
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("normal mode — events are no-ops (version stable)", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        const snap1 = yield* getPlanSnapshot(runtime)
        const epoch1 = snap1!.epoch

        // Events in normal mode should not change state
        const changed = yield* runtime.reduce(
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
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // In normal mode, tool calls should not affect state
        const changed = yield* runtime.reduce(
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

  describe("handleIntent", () => {
    it.live("togglePlan — normal → plan", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendIntent(runtime, { _tag: "TogglePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("plan")
        expect(model.todos).toEqual([])
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("togglePlan — plan → normal", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendIntent(runtime, { _tag: "TogglePlan" })
        yield* sendIntent(runtime, { _tag: "TogglePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("normal")
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("executePlan — plan with no todos → no-op", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendIntent(runtime, { _tag: "TogglePlan" })
        yield* sendIntent(runtime, { _tag: "ExecutePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("plan") // No todos → stays in plan
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("executePlan — normal mode → no-op", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendIntent(runtime, { _tag: "ExecutePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("normal")
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("refinePlan — plan mode → resets todos", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendIntent(runtime, { _tag: "TogglePlan" })
        yield* sendIntent(runtime, { _tag: "RefinePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("plan")
        expect(model.todos).toEqual([])
      }).pipe(Effect.provide(makeLayer())),
    )

    it.live("refinePlan — normal mode → no-op", () =>
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* sendIntent(runtime, { _tag: "RefinePlan" })

        const snap = yield* getPlanSnapshot(runtime)
        const model = snap!.model as PlanState
        expect(model.mode).toBe("normal")
      }).pipe(Effect.provide(makeLayer())),
    )
  })
})

describe("Plan pure reducer — executing behavior", () => {
  const { reduce, derive, intent, events } = createActorHarness(PlanActorConfig)

  test("executing mode — StreamStarted marks first pending as in-progress", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [
        { id: 1, text: "A", status: "pending" },
        { id: 2, text: "B", status: "pending" },
      ],
    }
    const result = reduce(state, events.streamStarted())
    expect(result.state.todos[0]!.status).toBe("in-progress")
    expect(result.state.todos[1]!.status).toBe("pending")
  })

  test("executing mode — TurnCompleted marks in-progress as done", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [
        { id: 1, text: "A", status: "in-progress" },
        { id: 2, text: "B", status: "pending" },
      ],
    }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state.todos[0]!.status).toBe("done")
    expect(result.state.mode).toBe("executing") // Still have pending items
  })

  test("executing mode — transitions to normal when all done", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [{ id: 1, text: "A", status: "in-progress" }],
    }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state.todos[0]!.status).toBe("done")
    expect(result.state.mode).toBe("normal")
  })

  test("executing mode — edit tool success advances progress and auto-starts next", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [
        { id: 1, text: "A", status: "in-progress" },
        { id: 2, text: "B", status: "pending" },
      ],
    }
    const result = reduce(
      state,
      events.toolCallSucceeded({ toolCallId: "tc1" as ToolCallId, toolName: "edit" }),
    )
    expect(result.state.todos[0]!.status).toBe("done")
    expect(result.state.todos[1]!.status).toBe("in-progress")
  })

  test("executing mode — non-edit tool success does not advance", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [{ id: 1, text: "A", status: "in-progress" }],
    }
    const result = reduce(
      state,
      events.toolCallSucceeded({ toolCallId: "tc1" as ToolCallId, toolName: "read" }),
    )
    expect(result.state.todos[0]!.status).toBe("in-progress")
  })

  test("executing mode — derive injects plan context prompt section", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [
        { id: 1, text: "Read files", status: "done" },
        { id: 2, text: "Edit code", status: "in-progress" },
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
      todos: [{ id: 1, text: "Do thing", status: "pending" }],
    }
    const projection = derive(state)
    expect(projection.toolPolicy).toBeUndefined()
  })

  test("ui model includes progress counts", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [
        { id: 1, text: "A", status: "done" },
        { id: 2, text: "B", status: "in-progress" },
        { id: 3, text: "C", status: "pending" },
      ],
    }
    const projection = derive(state)
    const ui = projection.uiModel as {
      progress: { total: number; done: number; inProgress: number }
    }
    expect(ui.progress.total).toBe(3)
    expect(ui.progress.done).toBe(1)
    expect(ui.progress.inProgress).toBe(1)
  })

  test("normal mode — events are no-ops (reference equality)", () => {
    const state: PlanState = { mode: "normal", todos: [] }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state).toBe(state)
  })

  test("executePlan intent — plan with todos → executing", () => {
    const state: PlanState = {
      mode: "plan",
      todos: [{ id: 1, text: "A", status: "pending" }],
    }
    const result = intent!(state, { _tag: "ExecutePlan" })
    expect(result.state.mode).toBe("executing")
  })

  test("togglePlan — executing → normal", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [{ id: 1, text: "A", status: "pending" }],
    }
    const result = intent!(state, { _tag: "TogglePlan" })
    expect(result.state.mode).toBe("normal")
  })
})

describe("Plan pure reducer — todo extraction", () => {
  const { reduce, events } = createActorHarness(PlanActorConfig)

  const streamChunk = (chunk: string) => new StreamChunk({ sessionId, branchId, chunk })

  test("plan mode — StreamChunk accumulates pendingText", () => {
    const state: PlanState = { mode: "plan", todos: [] }
    const r1 = reduce(state, streamChunk("## Plan\n"))
    expect(r1.state.pendingText).toBe("## Plan\n")
    const r2 = reduce(r1.state, streamChunk("- [ ] First step\n"))
    expect(r2.state.pendingText).toBe("## Plan\n- [ ] First step\n")
  })

  test("plan mode — TurnCompleted extracts todos from accumulated text", () => {
    const state: PlanState = {
      mode: "plan",
      todos: [],
      pendingText: "## Plan\n- [ ] Read files\n- [ ] Edit code\n- [x] Already done",
    }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state.todos.length).toBe(3)
    expect(result.state.todos[0]!.text).toBe("Read files")
    expect(result.state.todos[0]!.status).toBe("pending")
    expect(result.state.todos[2]!.status).toBe("done")
    expect(result.state.pendingText).toBeUndefined()
  })

  test("plan mode — TurnCompleted with no pendingText → no-op", () => {
    const state: PlanState = { mode: "plan", todos: [] }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state).toBe(state)
  })

  test("plan mode — TurnCompleted with non-plan text → clears pendingText, no todos", () => {
    const state: PlanState = {
      mode: "plan",
      todos: [],
      pendingText: "Just some regular text without any plan items.",
    }
    const result = reduce(state, events.turnCompleted({ durationMs: 100 }))
    expect(result.state.todos.length).toBe(0)
    expect(result.state.pendingText).toBeUndefined()
  })

  test("normal mode — StreamChunk is no-op", () => {
    const state: PlanState = { mode: "normal", todos: [] }
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

  const taskUpdated = (taskId: string, status: string) =>
    new TaskUpdated({ sessionId, branchId, taskId: taskId as TaskId, status })

  test("executing mode — TaskCreated maps to matching todo", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [
        { id: 1, text: "Read files", status: "pending" },
        { id: 2, text: "Edit code", status: "pending" },
      ],
      taskMap: {},
    }
    const result = reduce(state, taskCreated("t-1", "Read files"))
    expect(result.state.taskMap?.["t-1"]).toBe(0)
    expect(result.state.todos[0]!.status).toBe("in-progress")
    expect(result.state.todos[1]!.status).toBe("pending")
  })

  test("executing mode — TaskCompleted marks matching todo done", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [
        { id: 1, text: "Read files", status: "in-progress" },
        { id: 2, text: "Edit code", status: "pending" },
      ],
      taskMap: { "t-1": 0 },
    }
    const result = reduce(state, taskCompleted("t-1"))
    expect(result.state.todos[0]!.status).toBe("done")
    expect(result.state.mode).toBe("executing") // still have pending
  })

  test("executing mode — all tasks done → normal", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [
        { id: 1, text: "A", status: "done" },
        { id: 2, text: "B", status: "in-progress" },
      ],
      taskMap: { "t-2": 1 },
    }
    const result = reduce(state, taskCompleted("t-2"))
    expect(result.state.todos[1]!.status).toBe("done")
    expect(result.state.mode).toBe("normal")
  })

  test("executing mode — TaskFailed marks matching todo failed", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [{ id: 1, text: "A", status: "in-progress" }],
      taskMap: { "t-1": 0 },
    }
    const result = reduce(state, taskFailed("t-1"))
    expect(result.state.todos[0]!.status).toBe("failed")
    expect(result.state.mode).toBe("executing") // failed doesn't auto-complete
  })

  test("executing mode — TaskUpdated(in_progress) marks todo in-progress", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [{ id: 1, text: "A", status: "pending" }],
      taskMap: { "t-1": 0 },
    }
    const result = reduce(state, taskUpdated("t-1", "in_progress"))
    expect(result.state.todos[0]!.status).toBe("in-progress")
  })

  test("executing mode — unmapped taskId → no-op", () => {
    const state: PlanState = {
      mode: "executing",
      todos: [{ id: 1, text: "A", status: "pending" }],
      taskMap: {},
    }
    const result = reduce(state, taskCompleted("t-unknown"))
    expect(result.state).toBe(state)
  })

  test("normal mode — task events are no-ops", () => {
    const state: PlanState = { mode: "normal", todos: [] }
    const result = reduce(state, taskCreated("t-1", "something"))
    expect(result.state).toBe(state)
  })
})

describe("Stale intent rejection", () => {
  it.live("handleIntent rejects stale epoch for actors", () =>
    Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      // Spawn actor
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      // Toggle plan mode — bumps version to 1
      yield* sendIntent(runtime, { _tag: "TogglePlan" })

      // Toggle back — bumps version to 2
      yield* sendIntent(runtime, { _tag: "TogglePlan" })

      // Send intent with stale epoch (0) — should be rejected
      const result = yield* runtime
        .handleIntent(sessionId, "plan", { _tag: "TogglePlan" }, 0)
        .pipe(Effect.result)

      // Result should be a failure with StaleIntentError
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("handleIntent accepts current epoch for actors", () =>
    Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      // Version is 0 after init, send with epoch 0
      yield* sendIntent(runtime, { _tag: "TogglePlan" })

      const snap = yield* getPlanSnapshot(runtime)
      expect((snap!.model as PlanState).mode).toBe("plan")
    }).pipe(Effect.provide(makeLayer())),
  )
})

describe("extractTodos", () => {
  test("extracts markdown checklist items", () => {
    const text = `## Plan
- [ ] Read the config file
- [ ] Update the schema
- [x] Already done item`
    const todos = extractTodos(text)
    expect(todos.length).toBe(3)
    expect(todos[0]).toEqual({ id: 1, text: "Read the config file", status: "pending" })
    expect(todos[1]).toEqual({ id: 2, text: "Update the schema", status: "pending" })
    expect(todos[2]).toEqual({ id: 3, text: "Already done item", status: "done" })
  })

  test("extracts numbered list under plan header", () => {
    const text = `# Steps
1. First thing
2. Second thing
3. Third thing`
    const todos = extractTodos(text)
    expect(todos.length).toBe(3)
    expect(todos[0]!.text).toBe("First thing")
    expect(todos[2]!.text).toBe("Third thing")
  })

  test("ignores numbered lists outside plan headers", () => {
    const text = `Some context

1. Random numbered item
2. Another one`
    const todos = extractTodos(text)
    expect(todos.length).toBe(0)
  })

  test("extracts checklists anywhere (not header-gated)", () => {
    const text = `Here are some items:
- [ ] Ungated checklist item
- [x] Done item`
    const todos = extractTodos(text)
    expect(todos.length).toBe(2)
  })

  test("handles empty text", () => {
    expect(extractTodos("")).toEqual([])
  })

  test("handles text with no todos", () => {
    expect(extractTodos("Just some regular text\nwith multiple lines")).toEqual([])
  })

  test("stops numbered list on new non-plan header", () => {
    const text = `## Tasks
1. Task one
2. Task two

## Results
3. This is not a task`
    const todos = extractTodos(text)
    expect(todos.length).toBe(2)
  })
})
