/**
 * Plan extension — stateful actor using fromReducer.
 *
 * State: mode (normal/plan/executing) + plan steps + task tracking.
 * Derive: tool policy restrictions in plan mode, prompt context injection, UI model.
 * Intents: togglePlan, executePlan, refinePlan.
 *
 * Step extraction: accumulates StreamChunk text in plan mode, extracts on TurnCompleted.
 * Task tracking: maps TaskCreated → plan steps, observes TaskCompleted/TaskFailed/TaskStopped.
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

export const PlanStepStatus = Schema.Literals([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "stopped",
])
export type PlanStepStatus = typeof PlanStepStatus.Type

export const PlanStep = Schema.Struct({
  id: Schema.Number,
  text: Schema.String,
  status: PlanStepStatus,
})
export type PlanStep = typeof PlanStep.Type

export const PlanState = Schema.Struct({
  mode: PlanStatus,
  steps: Schema.Array(PlanStep),
  /** Accumulated assistant text during plan mode turn — cleared on extraction */
  pendingText: Schema.optional(Schema.String),
  /** taskId → step index mapping for execution tracking */
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
  steps: Schema.Array(PlanStep),
  progress: Schema.Struct({
    total: Schema.Number,
    completed: Schema.Number,
    inProgress: Schema.Number,
  }),
})
export type PlanUiModel = typeof PlanUiModel.Type

// ── Step extraction from assistant text ──

const TODO_PATTERN = /^(?:\s*[-*]\s*\[([xX ]?)\]\s+(.+)|(\d+)[.)]\s+(.+))$/
const PLAN_HEADER_PATTERN = /^#+\s*(?:plan|todo|tasks?|steps?|checklist)/i

/**
 * Extract plan steps from assistant turn text.
 * Recognizes markdown checklists (`- [ ] item`) and numbered lists under plan-like headers.
 */
export const extractSteps = (text: string): PlanStep[] => {
  const lines = text.split("\n")
  const steps: PlanStep[] = []
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
        steps.push({
          id: nextId++,
          text: match[2].trim(),
          status: checked ? "completed" : "pending",
        })
      }
      // Numbered list match: groups 3,4 (only inside plan section)
      else if (inPlanSection && match[3] !== undefined && match[4] !== undefined) {
        steps.push({
          id: nextId++,
          text: match[4].trim(),
          status: "pending",
        })
      }
    }
  }

  return steps
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

const stepMark = (status: PlanStepStatus): string => {
  if (status === "completed") return "x"
  if (status === "in_progress") return "~"
  if (status === "failed") return "!"
  if (status === "stopped") return "-"
  return " "
}

const EXECUTING_PLAN_SECTION = (steps: ReadonlyArray<PlanStep>): PromptSection => {
  const checklist = steps.map((s) => `- [${stepMark(s.status)}] ${s.text}`).join("\n")

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
    total: state.steps.length,
    completed: state.steps.filter((s) => s.status === "completed").length,
    inProgress: state.steps.filter((s) => s.status === "in_progress").length,
  }

  const uiModel: PlanUiModel = {
    mode: state.mode,
    steps: state.steps,
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
    promptSections: state.steps.length > 0 ? [EXECUTING_PLAN_SECTION(state.steps)] : [],
    uiModel,
  }
}

// ── Reduce helpers ──

const setStepStatus = (
  steps: ReadonlyArray<PlanStep>,
  idx: number,
  status: PlanStepStatus,
): PlanStep[] => steps.map((s, i) => (i === idx ? { ...s, status } : s))

const allComplete = (steps: ReadonlyArray<PlanStep>): boolean =>
  steps.every((s) => s.status === "completed" || s.status === "failed" || s.status === "stopped")

const reducePlanMode = (state: PlanState, event: AgentEvent): ReduceResult<PlanState> => {
  if (event._tag === "StreamChunk") {
    return { state: { ...state, pendingText: (state.pendingText ?? "") + event.chunk } }
  }

  if (event._tag === "TurnCompleted") {
    if (state.pendingText === undefined || state.pendingText === "") return { state }
    const extracted = extractSteps(state.pendingText)
    if (extracted.length === 0) return { state: { ...state, pendingText: undefined } }
    return { state: { ...state, steps: extracted, pendingText: undefined } }
  }

  return { state }
}

const reduceExecutingTask = (
  state: PlanState,
  event: AgentEvent,
): ReduceResult<PlanState> | undefined => {
  if (event._tag === "TaskCreated") {
    const matchIdx = state.steps.findIndex(
      (s) =>
        s.status === "pending" &&
        (event.subject.includes(s.text) ||
          s.text.includes(event.subject) ||
          s.text.toLowerCase() === event.subject.toLowerCase()),
    )
    if (matchIdx === -1) return { state }
    const taskMap = { ...(state.taskMap ?? {}), [event.taskId]: matchIdx }
    return {
      state: { ...state, steps: setStepStatus(state.steps, matchIdx, "in_progress"), taskMap },
    }
  }

  if (event._tag === "TaskCompleted") {
    const stepIdx = state.taskMap?.[event.taskId]
    if (stepIdx === undefined) return { state }
    const updated = setStepStatus(state.steps, stepIdx, "completed")
    return {
      state: {
        mode: allComplete(updated) ? "normal" : state.mode,
        steps: updated,
        taskMap: state.taskMap,
      },
    }
  }

  if (event._tag === "TaskFailed") {
    const stepIdx = state.taskMap?.[event.taskId]
    if (stepIdx === undefined) return { state }
    const updated = setStepStatus(state.steps, stepIdx, "failed")
    return {
      state: {
        mode: allComplete(updated) ? "normal" : state.mode,
        steps: updated,
        taskMap: state.taskMap,
      },
    }
  }

  if (event._tag === "TaskStopped") {
    const stepIdx = state.taskMap?.[event.taskId]
    if (stepIdx === undefined) return { state }
    const updated = setStepStatus(state.steps, stepIdx, "stopped")
    return {
      state: {
        mode: allComplete(updated) ? "normal" : state.mode,
        steps: updated,
        taskMap: state.taskMap,
      },
    }
  }

  if (event._tag === "TaskUpdated") {
    const stepIdx = state.taskMap?.[event.taskId]
    if (stepIdx === undefined || event.status !== "in_progress") return { state }
    return {
      state: {
        ...state,
        steps: setStepStatus(state.steps, stepIdx, "in_progress"),
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
    const steps = extractSteps(parsed.plan)
    return {
      state: {
        ...state,
        mode: "executing",
        steps: steps.length > 0 ? steps : state.steps,
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
    const steps = extractSteps(parsed.plan)
    return {
      state: {
        ...state,
        mode: "plan",
        steps: steps.length > 0 ? steps : state.steps,
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
          state: { ...state, mode: "plan", steps: [], pendingText: undefined, taskMap: undefined },
        }
      }
      // Toggle off from any non-normal mode
      return { state: { ...state, mode: "normal", pendingText: undefined } }
    }
    case "ExecutePlan": {
      if (state.mode !== "plan" || state.steps.length === 0) return { state }
      return { state: { ...state, mode: "executing", pendingText: undefined, taskMap: {} } }
    }
    case "RefinePlan": {
      if (state.mode === "normal") return { state }
      // Pause execution (if executing) and return to plan mode for refinement
      return {
        state: { ...state, mode: "plan", steps: [], pendingText: undefined, taskMap: undefined },
      }
    }
  }
}

// ── Actor ──

/** Exported for pure test harness access */
export const PlanActorConfig = {
  id: "plan" as const,
  initial: { mode: "normal" as const, steps: [] as readonly never[] } satisfies PlanState,
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
