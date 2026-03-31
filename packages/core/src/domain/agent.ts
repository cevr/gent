import { ServiceMap, Schema } from "effect"
import type * as EffectNs from "effect/Effect"
import type { BranchId, SessionId, ToolCallId } from "./ids"
import { ModelId } from "./model"
import type { ToolAction as ToolActionType, AnyToolDefinition } from "./tool"

// Agent definitions

export const AgentKind = Schema.Literals(["primary", "subagent", "system"])
export type AgentKind = typeof AgentKind.Type

export const AgentName = Schema.String
export type AgentName = typeof AgentName.Type

export const ReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])
export type ReasoningEffort = typeof ReasoningEffort.Type

export const ToolAction = Schema.Literals([
  "read",
  "edit",
  "exec",
  "delegate",
  "interact",
  "network",
  "state",
])

/** Brand symbol for detecting full AgentDefinition vs SimpleAgentDef in overloaded APIs */
export const AgentDefinitionBrand: unique symbol = Symbol.for("@gent/AgentDefinition")

export class AgentDefinition extends Schema.Class<AgentDefinition>("AgentDefinition")({
  name: AgentName,
  description: Schema.optional(Schema.String),
  kind: AgentKind,
  hidden: Schema.optional(Schema.Boolean),
  model: Schema.optional(ModelId),
  systemPromptAddendum: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  allowedActions: Schema.optional(Schema.Array(ToolAction)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  temperature: Schema.optional(Schema.Number),
  reasoningEffort: Schema.optional(ReasoningEffort),
  canDelegateToAgents: Schema.optional(Schema.Array(AgentName)),
}) {}

export type AgentDefinitionInput = ConstructorParameters<typeof AgentDefinition>[0]

export const defineAgent = (input: AgentDefinitionInput): AgentDefinition => {
  const def = new AgentDefinition(input)
  Object.defineProperty(def, AgentDefinitionBrand, {
    value: true,
    enumerable: false,
    writable: false,
  })
  return def
}

// Prompts

export const COWORK_PROMPT = `
Cowork agent. Fast, practical, execute changes.
- Minimal prose. Summarize changes at turn end.
- Ask only when blocked. Investigate first.
- Prefer direct tool use over delegation for simple tasks.
- When editing multiple files, batch related changes together.
`.trim()

export const DEEPWORK_PROMPT = `
Deepwork agent. Thorough analysis, careful tradeoffs, explicit assumptions.
- Prefer correctness over speed. Verify before acting.
- Read widely before narrowing. Explore adjacent code that might be affected.
- Ask clarifying questions when requirements are ambiguous.
- Still execute when confident — analysis without action is incomplete.
`.trim()

export const EXPLORE_PROMPT = `
Explore agent. Rapid codebase scanning.
- Report: file paths, line numbers, brief context.
- End with next steps or open questions.
`.trim()

export const ARCHITECT_PROMPT = `
Architect agent. Design implementation approach.
- Enumerate structure, tradeoffs, and risks.
- Reference specific files and interfaces.
- No code changes — read-only analysis.
- End with a sequenced implementation plan.
`.trim()

export const LIBRARIAN_PROMPT = `
Librarian agent. Answer questions about an external repository by reading its source code.
You have access to a local clone at the path specified in the prompt.
Use read, grep, and glob tools to explore the code. Be precise — cite file paths and line numbers.
`.trim()

export const FINDER_PROMPT = `
Finder agent. Multi-step codebase search specialist. Chain grep/read/glob to answer precisely.
Report file paths and line numbers. Be exhaustive but concise.
`.trim()

export const REVIEWER_PROMPT = `
Reviewer agent. Examine code changes for bugs, security issues, and improvements.
Run git diff or read specified files, then produce a structured review.

Output format: JSON array of comments. Each comment:
- file: path to file
- line: line number (optional)
- severity: critical | high | medium | low
- type: bug | suggestion | style
- text: description of the issue
- fix: suggested fix (optional)

Severity definitions:
- critical: will cause data loss, security breach, or crash in production
- high: likely bug or regression that affects correctness
- medium: code smell, missed edge case, or maintainability concern
- low: style, naming, or minor improvement

Only output the JSON array, no other text.
`.trim()

export const AUDITOR_PROMPT = `
Auditor agent. Audit code for a specific concern category.
Read files, identify issues, produce concrete findings.
Every finding must reference a specific file and line.
Stay scoped to the assigned concern — do not drift into adjacent categories.
`.trim()

export const SUMMARIZER_PROMPT = `
Summarizer agent. Summarize prior context. Focus decisions, open questions, current state.
`.trim()

// Built-in agents

export const Agents = {
  cowork: defineAgent({
    name: "cowork",
    description: "General purpose - full tool access, can execute code changes",
    kind: "primary",
    model: "anthropic/claude-opus-4-6" as ModelId,
    canDelegateToAgents: ["explore", "architect", "librarian", "finder", "reviewer", "auditor"],
    systemPromptAddendum: COWORK_PROMPT,
  }),

  deepwork: defineAgent({
    name: "deepwork",
    description: "Adversarial reviewer — used by counsel tool for cross-vendor review",
    kind: "primary",
    hidden: true,
    model: "openai/gpt-5.4" as ModelId,
    canDelegateToAgents: ["explore", "architect", "librarian", "finder", "reviewer", "auditor"],
    systemPromptAddendum: DEEPWORK_PROMPT,
    reasoningEffort: "high",
  }),

  explore: defineAgent({
    name: "explore",
    description: "Fast codebase exploration - finds files, searches patterns",
    kind: "subagent",
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedActions: ["read"],
    allowedTools: ["bash"],
    systemPromptAddendum: EXPLORE_PROMPT,
  }),

  architect: defineAgent({
    name: "architect",
    description: "Designs implementation approaches",
    kind: "subagent",
    model: "anthropic/claude-opus-4-6" as ModelId,
    allowedActions: ["read", "network"],
    systemPromptAddendum: ARCHITECT_PROMPT,
  }),

  librarian: defineAgent({
    name: "librarian",
    description: "Answers questions about external repos using local cached clones",
    kind: "subagent",
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedActions: ["read"],
    systemPromptAddendum: LIBRARIAN_PROMPT,
  }),

  summarizer: defineAgent({
    name: "summarizer",
    kind: "system",
    hidden: true,
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedTools: [],
    systemPromptAddendum: SUMMARIZER_PROMPT,
  }),

  title: defineAgent({
    name: "title",
    kind: "system",
    hidden: true,
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedTools: [],
    temperature: 0.5,
  }),

  finder: defineAgent({
    name: "finder",
    description: "Fast multi-step codebase search via cheap model",
    kind: "subagent",
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedActions: ["read"],
    allowedTools: ["bash"],
    systemPromptAddendum: FINDER_PROMPT,
  }),

  reviewer: defineAgent({
    name: "reviewer",
    description: "Structured code review with severity-graded comments",
    kind: "subagent",
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedActions: ["read"],
    allowedTools: ["bash"],
    systemPromptAddendum: REVIEWER_PROMPT,
  }),

  auditor: defineAgent({
    name: "auditor",
    description: "Audits code for a specific concern category",
    kind: "subagent",
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedActions: ["read"],
    allowedTools: ["bash"],
    systemPromptAddendum: AUDITOR_PROMPT,
  }),
} as const

// Default model — used when an agent has no model set
export const DEFAULT_MODEL_ID = "openai/gpt-5.4-mini" as ModelId

/** Resolve model for an agent definition */
export const resolveAgentModel = (agent: AgentDefinition): ModelId =>
  agent.model ?? DEFAULT_MODEL_ID

// Agent Execution Overrides — per-run overrides for subagent dispatch

export interface AgentExecutionOverrides {
  readonly modelId?: ModelId
  readonly allowedActions?: ReadonlyArray<ToolActionType>
  readonly allowedTools?: ReadonlyArray<string>
  readonly deniedTools?: ReadonlyArray<string>
  readonly reasoningEffort?: ReasoningEffort
  readonly systemPromptAddendum?: string
  /** Tags passed to RunContext for tag injection decisions */
  readonly tags?: ReadonlyArray<string>
  /** @deprecated Use tags + tagInjections instead */
  readonly additionalTools?: ReadonlyArray<AnyToolDefinition>
}

export type BuiltinAgentName = keyof typeof Agents

// Subagent depth

/**
 * Maximum session nesting depth for subagent spawns. Derived from the persisted
 * parent chain (includes both subagent spawns and handoff sessions). A depth of 3
 * means root → child → grandchild → great-grandchild is blocked.
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3

// Subagent runner types

export interface SubagentToolCall {
  toolName: string
  args: Record<string, unknown>
  isError: boolean
}

export type SubagentResult =
  | {
      _tag: "success"
      text: string
      sessionId: SessionId
      agentName: AgentName
      usage?: { input: number; output: number; cost?: number }
      toolCalls?: ReadonlyArray<SubagentToolCall>
    }
  | {
      _tag: "error"
      error: string
      sessionId?: SessionId
      agentName?: AgentName
    }

export class SubagentError extends Schema.TaggedErrorClass<SubagentError>()("SubagentError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface SubagentRunner {
  readonly run: (params: {
    agent: AgentDefinition
    prompt: string
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    cwd: string
    overrides?: AgentExecutionOverrides
  }) => EffectNs.Effect<SubagentResult, SubagentError>
}

export class SubagentRunnerService extends ServiceMap.Service<
  SubagentRunnerService,
  SubagentRunner
>()("@gent/core/src/domain/agent/SubagentRunnerService") {}
