/**
 * Plan-mode extension — stateful actor using fromReducer.
 *
 * State: mode (normal/plan/executing) + todo items extracted from turn completions.
 * Derive: tool policy restrictions in plan mode, prompt context injection, UI model.
 * Intents: togglePlanMode, executePlan, refinePlan.
 */

import { Effect, Schema } from "effect"
import { defineExtension } from "../domain/extension.js"
import type {
  ExtensionDeriveContext,
  ExtensionProjection,
  ExtensionReduceContext,
  ReduceResult,
} from "../domain/extension.js"
import type { AgentEvent } from "../domain/event.js"
import type { PromptSection } from "../domain/prompt.js"
import { fromReducer } from "../runtime/extensions/from-reducer.js"

// ── State ──

export const PlanModeStatus = Schema.Literals(["normal", "plan", "executing"])
export type PlanModeStatus = typeof PlanModeStatus.Type

export const TodoStatus = Schema.Literals(["pending", "in-progress", "done"])
export type TodoStatus = typeof TodoStatus.Type

export const TodoItem = Schema.Struct({
  id: Schema.Number,
  text: Schema.String,
  status: TodoStatus,
})
export type TodoItem = typeof TodoItem.Type

export const PlanModeState = Schema.Struct({
  mode: PlanModeStatus,
  todos: Schema.Array(TodoItem),
})
export type PlanModeState = typeof PlanModeState.Type

// ── Intents ──

export const TogglePlanModeIntent = Schema.TaggedStruct("TogglePlanMode", {})
export const ExecutePlanIntent = Schema.TaggedStruct("ExecutePlan", {})
export const RefinePlanIntent = Schema.TaggedStruct("RefinePlan", {})

export const PlanModeIntent = Schema.Union([
  TogglePlanModeIntent,
  ExecutePlanIntent,
  RefinePlanIntent,
])
export type PlanModeIntent = typeof PlanModeIntent.Type

// ── UI Model ──

export const PlanModeUiModel = Schema.Struct({
  mode: PlanModeStatus,
  todos: Schema.Array(TodoItem),
  progress: Schema.Struct({
    total: Schema.Number,
    done: Schema.Number,
    inProgress: Schema.Number,
  }),
})
export type PlanModeUiModel = typeof PlanModeUiModel.Type

// ── Todo extraction from assistant text ──

const TODO_PATTERN = /^(?:\s*[-*]\s*\[([xX ]?)\]\s+(.+)|(\d+)[.)]\s+(.+))$/
const PLAN_HEADER_PATTERN = /^#+\s*(?:plan|todo|tasks?|steps?|checklist)/i

/**
 * Extract todo items from assistant turn text.
 * Recognizes markdown checklists (`- [ ] item`) and numbered lists under plan-like headers.
 */
export const extractTodos = (text: string): TodoItem[] => {
  const lines = text.split("\n")
  const todos: TodoItem[] = []
  let inPlanSection = false
  let nextId = 1

  for (const line of lines) {
    if (PLAN_HEADER_PATTERN.test(line)) {
      inPlanSection = true
      continue
    }

    // Blank line after plan section ends it for numbered lists
    if (inPlanSection && line.trim() === "") {
      // Keep going — might have more items after blank lines
      continue
    }

    // Another header ends the plan section
    if (inPlanSection && /^#+\s/.test(line) && !PLAN_HEADER_PATTERN.test(line)) {
      inPlanSection = false
      continue
    }

    const match = line.match(TODO_PATTERN)
    if (match !== null) {
      // Checkbox match: groups 1,2
      if (match[1] !== undefined && match[2] !== undefined) {
        const checked = match[1].toLowerCase() === "x"
        todos.push({
          id: nextId++,
          text: match[2].trim(),
          status: checked ? "done" : "pending",
        })
      }
      // Numbered list match: groups 3,4 (only inside plan section)
      else if (inPlanSection && match[3] !== undefined && match[4] !== undefined) {
        todos.push({
          id: nextId++,
          text: match[4].trim(),
          status: "pending",
        })
      }
    }
  }

  return todos
}

// ── Plan-mode restricted tools ──

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "glob"] as const

// ── Prompt sections for plan mode ──

const PLAN_RESTRICTIONS_SECTION: PromptSection = {
  id: "plan-mode-restrictions",
  content: `## Plan Mode Active

You are in **plan mode**. Your job is to analyze, plan, and organize — not execute.

### Restrictions
- Only use read-only tools: read, bash (read-only commands), grep, glob
- Do NOT edit, write, or delete files
- Do NOT run destructive commands

### Format
Present your plan as a markdown checklist:
\`\`\`
## Plan
- [ ] Step 1 description
- [ ] Step 2 description
\`\`\`

Each item should be a concrete, actionable step with file paths where relevant.`,
  priority: 92,
}

const todoMark = (status: TodoStatus): string => {
  if (status === "done") return "x"
  if (status === "in-progress") return "~"
  return " "
}

const EXECUTING_PLAN_SECTION = (todos: ReadonlyArray<TodoItem>): PromptSection => {
  const checklist = todos.map((t) => `- [${todoMark(t.status)}] ${t.text}`).join("\n")

  return {
    id: "plan-mode-executing",
    content: `## Executing Plan

Work through the remaining items in order:

${checklist}

Mark items complete as you finish them. Stay focused on the current item.`,
    priority: 92,
  }
}

// ── Derive ──

const deriveProjection = (
  state: PlanModeState,
  _ctx: ExtensionDeriveContext,
): ExtensionProjection => {
  const progress = {
    total: state.todos.length,
    done: state.todos.filter((t) => t.status === "done").length,
    inProgress: state.todos.filter((t) => t.status === "in-progress").length,
  }

  const uiModel: PlanModeUiModel = {
    mode: state.mode,
    todos: state.todos,
    progress,
  }

  if (state.mode === "normal") {
    return { uiModel }
  }

  if (state.mode === "plan") {
    return {
      toolPolicy: { overrideSet: [...PLAN_MODE_TOOLS] },
      promptSections: [PLAN_RESTRICTIONS_SECTION],
      uiModel,
    }
  }

  // executing
  return {
    promptSections: state.todos.length > 0 ? [EXECUTING_PLAN_SECTION(state.todos)] : [],
    uiModel,
  }
}

// ── Reduce ──

const reduce = (
  state: PlanModeState,
  event: AgentEvent,
  _ctx: ExtensionReduceContext,
): ReduceResult<PlanModeState> => {
  // In plan mode, extract todos from completed turns
  if (state.mode === "plan" && event._tag === "TurnCompleted") {
    // TurnCompleted doesn't carry text — todos are extracted from StreamChunk accumulation.
    // This is a no-op here; the real extraction happens when the assistant message is received.
    return { state }
  }

  // In executing mode, mark first pending todo as in-progress on stream start
  if (state.mode === "executing" && event._tag === "StreamStarted") {
    const pendingIdx = state.todos.findIndex((t) => t.status === "pending")
    if (pendingIdx === -1) return { state }
    return {
      state: {
        ...state,
        todos: state.todos.map((t, i) => (i === pendingIdx ? { ...t, status: "in-progress" } : t)),
      },
    }
  }

  // In executing mode, mark in-progress todos as done on turn completion
  if (state.mode === "executing" && event._tag === "TurnCompleted") {
    const hasInProgress = state.todos.some((t) => t.status === "in-progress")
    if (!hasInProgress) return { state }

    const updatedTodos = state.todos.map((t) =>
      t.status === "in-progress" ? { ...t, status: "done" as const } : t,
    )
    const allDone = updatedTodos.every((t) => t.status === "done")

    return {
      state: {
        mode: allDone ? "normal" : state.mode,
        todos: updatedTodos,
      },
    }
  }

  // In executing mode, mark in-progress as done on successful tool calls (heuristic)
  if (state.mode === "executing" && event._tag === "ToolCallSucceeded") {
    // Only mark progress on edit/write tools — concrete evidence of work done
    if (event.toolName !== "edit" && event.toolName !== "write") return { state }

    const inProgressIdx = state.todos.findIndex((t) => t.status === "in-progress")
    if (inProgressIdx === -1) return { state }

    const updatedTodos = state.todos.map((t, i) =>
      i === inProgressIdx ? { ...t, status: "done" as const } : t,
    )
    const nextPendingIdx = updatedTodos.findIndex((t) => t.status === "pending")
    // Auto-advance to next pending
    const nextPending = nextPendingIdx !== -1 ? updatedTodos[nextPendingIdx] : undefined
    if (nextPending !== undefined) {
      updatedTodos[nextPendingIdx] = { ...nextPending, status: "in-progress" }
    }

    const allDone = updatedTodos.every((t) => t.status === "done")
    return {
      state: {
        mode: allDone ? "normal" : state.mode,
        todos: updatedTodos,
      },
    }
  }

  return { state }
}

// ── Handle Intent ──

const handleIntent = (
  state: PlanModeState,
  intent: PlanModeIntent,
): ReduceResult<PlanModeState> => {
  switch (intent._tag) {
    case "TogglePlanMode": {
      if (state.mode === "normal") {
        return { state: { ...state, mode: "plan", todos: [] } }
      }
      // Toggle off from any non-normal mode
      return { state: { ...state, mode: "normal" } }
    }
    case "ExecutePlan": {
      if (state.mode !== "plan" || state.todos.length === 0) return { state }
      return { state: { ...state, mode: "executing" } }
    }
    case "RefinePlan": {
      if (state.mode !== "plan") return { state }
      // Reset todos so the agent produces a fresh plan
      return { state: { ...state, todos: [] } }
    }
  }
}

// ── Actor ──

/** Exported for pure test harness access */
export const PlanModeActorConfig = {
  id: "plan-mode" as const,
  initial: { mode: "normal" as const, todos: [] as readonly never[] } satisfies PlanModeState,
  reduce,
  derive: deriveProjection,
  handleIntent,
}

export const PlanModeSpawnActor = fromReducer<PlanModeState, PlanModeIntent>({
  ...PlanModeActorConfig,
  stateSchema: PlanModeState,
  intentSchema: PlanModeIntent,
  uiModelSchema: PlanModeUiModel,
})

// ── Extension ──

export const PlanModeExtension = defineExtension({
  manifest: { id: "@gent/plan-mode" },
  setup: () =>
    Effect.succeed({
      spawnActor: PlanModeSpawnActor,
    }),
})
