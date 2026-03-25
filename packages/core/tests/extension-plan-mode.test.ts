import { describe, test, expect } from "bun:test"
import { AgentDefinition } from "@gent/core/domain/agent"
import { StreamStarted, TurnCompleted, ToolCallSucceeded } from "@gent/core/domain/event"
import type { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import {
  PlanModeStateMachine,
  extractTodos,
  type PlanModeState,
  type PlanModeIntent,
} from "@gent/core/extensions/plan-mode"

const ctx = {
  sessionId: "test-session" as SessionId,
  branchId: "test-branch" as BranchId,
}

const deriveCtx = {
  agent: new AgentDefinition({ name: "cowork" as never, kind: "primary" }),
  allTools: [],
}

const reduce = (state: PlanModeState, event: Parameters<typeof PlanModeStateMachine.reduce>[1]) =>
  PlanModeStateMachine.reduce(state, event, ctx)

const derive = (state: PlanModeState) => PlanModeStateMachine.derive(state, deriveCtx)

const intent = (state: PlanModeState, i: PlanModeIntent) =>
  PlanModeStateMachine.handleIntent!(state, i)

describe("PlanModeStateMachine", () => {
  describe("initial state", () => {
    test("starts in normal mode with empty todos", () => {
      expect(PlanModeStateMachine.initial).toEqual({ mode: "normal", todos: [] })
    })
  })

  describe("derive", () => {
    test("normal mode — no tool policy, no prompt sections", () => {
      const projection = derive({ mode: "normal", todos: [] })
      expect(projection.toolPolicy).toBeUndefined()
      expect(projection.promptSections).toBeUndefined()
      expect(projection.uiModel).toBeDefined()
    })

    test("plan mode — restricts tools to read-only set", () => {
      const projection = derive({ mode: "plan", todos: [] })
      expect(projection.toolPolicy).toBeDefined()
      expect(projection.toolPolicy!.overrideSet).toEqual(["read", "bash", "grep", "glob"])
    })

    test("plan mode — injects prompt section", () => {
      const projection = derive({ mode: "plan", todos: [] })
      expect(projection.promptSections).toBeDefined()
      expect(projection.promptSections!.length).toBe(1)
      expect(projection.promptSections![0]!.id).toBe("plan-mode-restrictions")
    })

    test("executing mode — no tool policy restriction", () => {
      const projection = derive({
        mode: "executing",
        todos: [{ id: 1, text: "Do thing", status: "pending" }],
      })
      expect(projection.toolPolicy).toBeUndefined()
    })

    test("executing mode — injects plan context prompt section", () => {
      const todos = [
        { id: 1, text: "Read files", status: "done" as const },
        { id: 2, text: "Edit code", status: "in-progress" as const },
        { id: 3, text: "Run tests", status: "pending" as const },
      ]
      const projection = derive({ mode: "executing", todos })
      expect(projection.promptSections).toBeDefined()
      expect(projection.promptSections!.length).toBe(1)
      expect(projection.promptSections![0]!.id).toBe("plan-mode-executing")
      expect(projection.promptSections![0]!.content).toContain("[x] Read files")
      expect(projection.promptSections![0]!.content).toContain("[~] Edit code")
      expect(projection.promptSections![0]!.content).toContain("[ ] Run tests")
    })

    test("ui model includes progress counts", () => {
      const todos = [
        { id: 1, text: "A", status: "done" as const },
        { id: 2, text: "B", status: "in-progress" as const },
        { id: 3, text: "C", status: "pending" as const },
      ]
      const projection = derive({ mode: "executing", todos })
      const ui = projection.uiModel as {
        progress: { total: number; done: number; inProgress: number }
      }
      expect(ui.progress.total).toBe(3)
      expect(ui.progress.done).toBe(1)
      expect(ui.progress.inProgress).toBe(1)
    })
  })

  describe("reduce", () => {
    test("executing mode — marks first pending as in-progress on StreamStarted", () => {
      const state: PlanModeState = {
        mode: "executing",
        todos: [
          { id: 1, text: "A", status: "pending" },
          { id: 2, text: "B", status: "pending" },
        ],
      }
      const next = reduce(
        state,
        new StreamStarted({ sessionId: ctx.sessionId, branchId: ctx.branchId }),
      )
      expect(next.todos[0]!.status).toBe("in-progress")
      expect(next.todos[1]!.status).toBe("pending")
    })

    test("executing mode — marks in-progress as done on TurnCompleted", () => {
      const state: PlanModeState = {
        mode: "executing",
        todos: [
          { id: 1, text: "A", status: "in-progress" },
          { id: 2, text: "B", status: "pending" },
        ],
      }
      const next = reduce(
        state,
        new TurnCompleted({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          durationMs: 100,
        }),
      )
      expect(next.todos[0]!.status).toBe("done")
      expect(next.mode).toBe("executing") // Still have pending items
    })

    test("executing mode — transitions to normal when all done", () => {
      const state: PlanModeState = {
        mode: "executing",
        todos: [{ id: 1, text: "A", status: "in-progress" }],
      }
      const next = reduce(
        state,
        new TurnCompleted({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          durationMs: 100,
        }),
      )
      expect(next.todos[0]!.status).toBe("done")
      expect(next.mode).toBe("normal")
    })

    test("executing mode — edit tool success advances progress", () => {
      const state: PlanModeState = {
        mode: "executing",
        todos: [
          { id: 1, text: "A", status: "in-progress" },
          { id: 2, text: "B", status: "pending" },
        ],
      }
      const next = reduce(
        state,
        new ToolCallSucceeded({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          toolCallId: "tc1" as ToolCallId,
          toolName: "edit",
        }),
      )
      expect(next.todos[0]!.status).toBe("done")
      expect(next.todos[1]!.status).toBe("in-progress")
    })

    test("non-edit tool success does not advance in executing mode", () => {
      const state: PlanModeState = {
        mode: "executing",
        todos: [{ id: 1, text: "A", status: "in-progress" }],
      }
      const next = reduce(
        state,
        new ToolCallSucceeded({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          toolCallId: "tc1" as ToolCallId,
          toolName: "read",
        }),
      )
      expect(next.todos[0]!.status).toBe("in-progress")
    })

    test("normal mode — events are no-ops", () => {
      const state: PlanModeState = { mode: "normal", todos: [] }
      const next = reduce(
        state,
        new TurnCompleted({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          durationMs: 100,
        }),
      )
      expect(next).toBe(state) // Reference equality — no change
    })
  })

  describe("handleIntent", () => {
    test("togglePlanMode — normal → plan", () => {
      const result = intent({ mode: "normal", todos: [] }, { _tag: "TogglePlanMode" })
      expect(result.state.mode).toBe("plan")
      expect(result.state.todos).toEqual([])
    })

    test("togglePlanMode — plan → normal", () => {
      const result = intent(
        { mode: "plan", todos: [{ id: 1, text: "A", status: "pending" }] },
        { _tag: "TogglePlanMode" },
      )
      expect(result.state.mode).toBe("normal")
    })

    test("togglePlanMode — executing → normal", () => {
      const result = intent(
        { mode: "executing", todos: [{ id: 1, text: "A", status: "pending" }] },
        { _tag: "TogglePlanMode" },
      )
      expect(result.state.mode).toBe("normal")
    })

    test("executePlan — plan with todos → executing", () => {
      const result = intent(
        { mode: "plan", todos: [{ id: 1, text: "A", status: "pending" }] },
        { _tag: "ExecutePlan" },
      )
      expect(result.state.mode).toBe("executing")
    })

    test("executePlan — plan with no todos → no-op", () => {
      const result = intent({ mode: "plan", todos: [] }, { _tag: "ExecutePlan" })
      expect(result.state.mode).toBe("plan")
    })

    test("executePlan — normal mode → no-op", () => {
      const result = intent({ mode: "normal", todos: [] }, { _tag: "ExecutePlan" })
      expect(result.state.mode).toBe("normal")
    })

    test("refinePlan — plan mode → resets todos", () => {
      const result = intent(
        { mode: "plan", todos: [{ id: 1, text: "A", status: "pending" }] },
        { _tag: "RefinePlan" },
      )
      expect(result.state.mode).toBe("plan")
      expect(result.state.todos).toEqual([])
    })

    test("refinePlan — normal mode → no-op", () => {
      const state: PlanModeState = { mode: "normal", todos: [] }
      const result = intent(state, { _tag: "RefinePlan" })
      expect(result.state).toBe(state)
    })
  })
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
