/**
 * Plan extension — stateful actor using fromReducer.
 *
 * State: mode (normal/plan/executing) + todo items + task tracking.
 * Derive: tool policy restrictions in plan mode, prompt context injection, UI model.
 * Intents: togglePlan, executePlan, refinePlan.
 *
 * Todo extraction: accumulates StreamChunk text in plan mode, extracts on TurnCompleted.
 * Task tracking: maps TaskCreated → todo items, observes TaskCompleted/TaskFailed.
 */

import { Schema } from "effect"
import type {
  ExtensionDeriveContext,
  ExtensionProjection,
  ExtensionReduceContext,
  ReduceResult,
} from "../domain/extension.js"
import type { AgentEvent } from "../domain/event.js"
import type { PromptSection } from "../domain/prompt.js"
import { extension, fromReducer } from "./api.js"

// ── State ──

export const PlanStatus = Schema.Literals(["normal", "plan", "executing"])
export type PlanStatus = typeof PlanStatus.Type

export const TodoStatus = Schema.Literals(["pending", "in-progress", "done", "failed"])
export type TodoStatus = typeof TodoStatus.Type

export const TodoItem = Schema.Struct({
  id: Schema.Number,
  text: Schema.String,
  status: TodoStatus,
})
export type TodoItem = typeof TodoItem.Type

export const PlanState = Schema.Struct({
  mode: PlanStatus,
  todos: Schema.Array(TodoItem),
  /** Accumulated assistant text during plan mode turn — cleared on extraction */
  pendingText: Schema.optional(Schema.String),
  /** taskId → todo index mapping for execution tracking */
  taskMap: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  /** Path to the plan file on disk (set when plan tool approves) */
  planFilePath: Schema.optional(Schema.String),
})
export type PlanState = typeof PlanState.Type

// ── Intents ──

export const TogglePlanIntent = Schema.TaggedStruct("TogglePlan", {})
export const ExecutePlanIntent = Schema.TaggedStruct("ExecutePlan", {})
export const RefinePlanIntent = Schema.TaggedStruct("RefinePlan", {})

export const PlanIntent = Schema.Union([TogglePlanIntent, ExecutePlanIntent, RefinePlanIntent])
export type PlanIntent = typeof PlanIntent.Type

// ── UI Model ──

export const PlanUiModel = Schema.Struct({
  mode: PlanStatus,
  todos: Schema.Array(TodoItem),
  progress: Schema.Struct({
    total: Schema.Number,
    done: Schema.Number,
    inProgress: Schema.Number,
  }),
})
export type PlanUiModel = typeof PlanUiModel.Type

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

    // Blank line after plan section — keep going
    if (inPlanSection && line.trim() === "") {
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

// ── Plan restricted tools ──

const PLAN_TOOLS = ["read", "bash", "grep", "glob"] as const

// ── Prompt sections for plan ──

const PLAN_RESTRICTIONS_SECTION: PromptSection = {
  id: "plan-restrictions",
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
  if (status === "failed") return "!"
  return " "
}

const EXECUTING_PLAN_SECTION = (todos: ReadonlyArray<TodoItem>): PromptSection => {
  const checklist = todos.map((t) => `- [${todoMark(t.status)}] ${t.text}`).join("\n")

  return {
    id: "plan-executing",
    content: `## Executing Plan

Work through the remaining items in order:

${checklist}

Mark items complete as you finish them. Stay focused on the current item.`,
    priority: 92,
  }
}

// ── Derive ──

const deriveProjection = (state: PlanState, _ctx?: ExtensionDeriveContext): ExtensionProjection => {
  const progress = {
    total: state.todos.length,
    done: state.todos.filter((t) => t.status === "done").length,
    inProgress: state.todos.filter((t) => t.status === "in-progress").length,
  }

  const uiModel: PlanUiModel = {
    mode: state.mode,
    todos: state.todos,
    progress,
  }

  if (state.mode === "normal") {
    return { uiModel }
  }

  if (state.mode === "plan") {
    return {
      toolPolicy: { overrideSet: [...PLAN_TOOLS] },
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

// ── Reduce helpers ──

const setTodoStatus = (
  todos: ReadonlyArray<TodoItem>,
  idx: number,
  status: TodoStatus,
): TodoItem[] => todos.map((t, i) => (i === idx ? { ...t, status } : t))

const allComplete = (todos: ReadonlyArray<TodoItem>): boolean =>
  todos.every((t) => t.status === "done" || t.status === "failed")

const reducePlanMode = (state: PlanState, event: AgentEvent): ReduceResult<PlanState> => {
  if (event._tag === "StreamChunk") {
    return { state: { ...state, pendingText: (state.pendingText ?? "") + event.chunk } }
  }

  if (event._tag === "TurnCompleted") {
    if (state.pendingText === undefined || state.pendingText === "") return { state }
    const extracted = extractTodos(state.pendingText)
    if (extracted.length === 0) return { state: { ...state, pendingText: undefined } }
    return { state: { ...state, todos: extracted, pendingText: undefined } }
  }

  return { state }
}

const reduceExecutingTask = (
  state: PlanState,
  event: AgentEvent,
): ReduceResult<PlanState> | undefined => {
  if (event._tag === "TaskCreated") {
    const matchIdx = state.todos.findIndex(
      (t) =>
        t.status === "pending" &&
        (event.subject.includes(t.text) ||
          t.text.includes(event.subject) ||
          t.text.toLowerCase() === event.subject.toLowerCase()),
    )
    if (matchIdx === -1) return { state }
    const taskMap = { ...(state.taskMap ?? {}), [event.taskId]: matchIdx }
    return {
      state: { ...state, todos: setTodoStatus(state.todos, matchIdx, "in-progress"), taskMap },
    }
  }

  if (event._tag === "TaskCompleted") {
    const todoIdx = state.taskMap?.[event.taskId]
    if (todoIdx === undefined) return { state }
    const updated = setTodoStatus(state.todos, todoIdx, "done")
    return {
      state: {
        mode: allComplete(updated) ? "normal" : state.mode,
        todos: updated,
        taskMap: state.taskMap,
      },
    }
  }

  if (event._tag === "TaskFailed" || event._tag === "TaskStopped") {
    const todoIdx = state.taskMap?.[event.taskId]
    if (todoIdx === undefined) return { state }
    return {
      state: {
        ...state,
        todos: setTodoStatus(state.todos, todoIdx, "failed"),
        taskMap: state.taskMap,
      },
    }
  }

  if (event._tag === "TaskUpdated") {
    const todoIdx = state.taskMap?.[event.taskId]
    if (todoIdx === undefined || event.status !== "in_progress") return { state }
    return {
      state: {
        ...state,
        todos: setTodoStatus(state.todos, todoIdx, "in-progress"),
        taskMap: state.taskMap,
      },
    }
  }

  return undefined
}

const reduceExecutingMode = (state: PlanState, event: AgentEvent): ReduceResult<PlanState> =>
  reduceExecutingTask(state, event) ?? { state }

// ── Plan tool observation ──

/** Parse plan tool output from ToolCallSucceeded.output (stringified JSON) */
const parsePlanToolOutput = (
  output: unknown,
): { decision: string; plan?: string; path?: string } | undefined => {
  // ToolCallSucceeded.output is Schema.optional(Schema.String) — JSON-stringified
  if (typeof output !== "string") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const obj = parsed as Record<string, unknown>
  if (typeof obj["decision"] !== "string") return undefined
  return {
    decision: obj["decision"],
    plan: typeof obj["plan"] === "string" ? obj["plan"] : undefined,
    path: typeof obj["path"] === "string" ? obj["path"] : undefined,
  }
}

const reducePlanToolResult = (
  state: PlanState,
  event: AgentEvent,
): ReduceResult<PlanState> | undefined => {
  if (event._tag !== "ToolCallSucceeded" || event.toolName !== "plan") return undefined

  const parsed = parsePlanToolOutput(event.output)
  if (parsed === undefined) return undefined

  if (parsed.decision === "yes" && parsed.plan !== undefined) {
    const todos = extractTodos(parsed.plan)
    return {
      state: {
        ...state,
        mode: "executing",
        todos: todos.length > 0 ? todos : state.todos,
        pendingText: undefined,
        taskMap: {},
        planFilePath: parsed.path,
      },
      effects: [
        {
          _tag: "QueueFollowUp" as const,
          content: [
            "The plan has been approved. Execute it by calling the handoff tool with the plan as context.",
            parsed.path !== undefined ? `Plan file: ${parsed.path}` : undefined,
            parsed.plan !== undefined ? `Plan:\n${parsed.plan}` : undefined,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    }
  }

  if (parsed.decision === "edit" && parsed.plan !== undefined) {
    const todos = extractTodos(parsed.plan)
    return {
      state: {
        ...state,
        mode: "plan",
        todos: todos.length > 0 ? todos : state.todos,
        pendingText: undefined,
        planFilePath: parsed.path,
      },
    }
  }

  return undefined
}

// ── Reduce ──

const reduce = (
  state: PlanState,
  event: AgentEvent,
  _ctx: ExtensionReduceContext,
): ReduceResult<PlanState> => {
  // Plan tool result can fire in any mode
  const planToolResult = reducePlanToolResult(state, event)
  if (planToolResult !== undefined) return planToolResult

  if (state.mode === "plan") return reducePlanMode(state, event)
  if (state.mode === "executing") return reduceExecutingMode(state, event)
  return { state }
}

// ── Handle Intent ──

const handleIntent = (state: PlanState, intent: PlanIntent): ReduceResult<PlanState> => {
  switch (intent._tag) {
    case "TogglePlan": {
      if (state.mode === "normal") {
        return {
          state: { ...state, mode: "plan", todos: [], pendingText: undefined, taskMap: undefined },
        }
      }
      // Toggle off from any non-normal mode
      return { state: { ...state, mode: "normal", pendingText: undefined } }
    }
    case "ExecutePlan": {
      if (state.mode !== "plan" || state.todos.length === 0) return { state }
      return { state: { ...state, mode: "executing", pendingText: undefined, taskMap: {} } }
    }
    case "RefinePlan": {
      if (state.mode !== "plan") return { state }
      // Reset todos so the agent produces a fresh plan
      return { state: { ...state, todos: [], pendingText: undefined } }
    }
  }
}

// ── Actor ──

/** Exported for pure test harness access */
export const PlanActorConfig = {
  id: "plan" as const,
  initial: { mode: "normal" as const, todos: [] as readonly never[] } satisfies PlanState,
  reduce,
  derive: deriveProjection,
  handleIntent,
}

const planActor = fromReducer<PlanState, PlanIntent>({
  ...PlanActorConfig,
  stateSchema: PlanState,
  intentSchema: PlanIntent,
  uiModelSchema: PlanUiModel,
  persist: true,
})

export const PlanSpawnActor = planActor.spawnActor

// ── Extension ──

import { PlanTool } from "../tools/plan.js"
export { PlanTool, PlanParams } from "../tools/plan.js"

export const PlanExtension = extension("@gent/plan", (ext) => {
  ext.actor(planActor)
  ext.tool(PlanTool)
})
