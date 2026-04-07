import { ServiceMap, Schema } from "effect"
import type * as EffectNs from "effect/Effect"
import type { BranchId, SessionId, ToolCallId } from "./ids"
import { ModelId } from "./model"
import type { AnyToolDefinition } from "./tool"

// Agent definitions

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

export const AgentPersistence = Schema.Literals(["durable", "ephemeral"])
export type AgentPersistence = typeof AgentPersistence.Type

/** Brand symbol for detecting full AgentDefinition vs SimpleAgentDef in overloaded APIs */
export const AgentDefinitionBrand: unique symbol = Symbol.for("@gent/AgentDefinition")

export class AgentDefinition extends Schema.Class<AgentDefinition>("AgentDefinition")({
  name: AgentName,
  description: Schema.optional(Schema.String),
  model: Schema.optional(ModelId),
  systemPromptAddendum: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  temperature: Schema.optional(Schema.Number),
  reasoningEffort: Schema.optional(ReasoningEffort),
  persistence: Schema.optional(AgentPersistence),
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
- Follow the plan. One commit per batch. Don't skip steps.
- No deferring, no skipping, no backing out of plan items without asking.
- When stuck: read more code, break the problem smaller, ask with options.
- When unsure about an approach: use the counsel tool for a second opinion.
- Gate after each batch: typecheck, lint, test.
`.trim()

export const DEEPWORK_PROMPT = `
Deepwork agent. Thorough analysis, careful tradeoffs, explicit assumptions.
- Less chatty, more focused. Minimize prose, maximize analysis.
- Prefer correctness over speed. Verify before acting.
- Read widely before narrowing. Explore adjacent code that might be affected.
- Cite specific file paths and line numbers for every claim.
- Read principles before architectural decisions.
- Still execute when confident — analysis without action is incomplete.
`.trim()

export const EXPLORE_PROMPT = `
Explore agent. Rapid codebase scanning and multi-step search.
- Chain grep/read/glob to answer precisely. Be exhaustive.
- Report: file paths, line numbers, brief context.
- End with next steps or open questions.
`.trim()

export const ARCHITECT_PROMPT = `
Architect agent. Design implementation approach.
- Enumerate structure, tradeoffs, and risks.
- Reference specific files and interfaces.
- No code changes — read-only analysis.
- Plans batched by commit — each batch is one shippable unit.
- Each batch: Goal, Why, Justification (principle names), Files, Changes, Verification.
- No addendums — plans must be cohesive, not main + appendix.
- Use the principles tool to ground justifications.
- End with a sequenced implementation plan.
`.trim()

export const LIBRARIAN_PROMPT = `
Librarian agent. Answer questions about an external repository by reading its source code.
You have access to a local clone at the path specified in the prompt.
Use read, grep, and glob tools to explore the code. Be precise — cite file paths and line numbers.
- Comparative architecture: compare 2-3 implementations before recommending.
- Pattern: fetch → explore → cite → compare.
- Always ground conclusions in specific file paths and line numbers.
`.trim()

export const AUDITOR_PROMPT = `
Auditor agent. Audit code for a specific concern category.
Read files, identify issues, produce concrete findings.
Every finding must reference a specific file and line.
Stay scoped to the assigned concern — do not drift into adjacent categories.
Use the principles tool for architectural concerns.
`.trim()

export const SUMMARIZER_PROMPT = `
Summarizer agent. Summarize prior context. Focus decisions, open questions, current state.
`.trim()

// Built-in agents

export const Agents = {
  cowork: defineAgent({
    name: "cowork",
    description: "General purpose - full tool access, can execute code changes",
    model: "anthropic/claude-opus-4-6" as ModelId,
    systemPromptAddendum: COWORK_PROMPT,
  }),

  deepwork: defineAgent({
    name: "deepwork",
    description: "Adversarial reviewer — used by counsel tool for cross-vendor review",
    model: "openai/gpt-5.4" as ModelId,
    systemPromptAddendum: DEEPWORK_PROMPT,
    reasoningEffort: "high",
  }),

  explore: defineAgent({
    name: "explore",
    description: "Fast codebase exploration - finds files, searches patterns",
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedTools: ["grep", "glob", "read", "memory_search", "bash"],
    systemPromptAddendum: EXPLORE_PROMPT,
    persistence: "ephemeral",
  }),

  architect: defineAgent({
    name: "architect",
    description: "Designs implementation approaches",
    model: "anthropic/claude-opus-4-6" as ModelId,
    allowedTools: ["grep", "glob", "read", "memory_search", "websearch", "webfetch"],
    systemPromptAddendum: ARCHITECT_PROMPT,
  }),

  librarian: defineAgent({
    name: "librarian",
    description: "Answers questions about external repos using local cached clones",
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedTools: ["grep", "glob", "read", "memory_search", "repo"],
    systemPromptAddendum: LIBRARIAN_PROMPT,
    persistence: "ephemeral",
  }),

  summarizer: defineAgent({
    name: "summarizer",
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedTools: [],
    systemPromptAddendum: SUMMARIZER_PROMPT,
    persistence: "ephemeral",
  }),

  title: defineAgent({
    name: "title",
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedTools: [],
    temperature: 0.5,
    persistence: "ephemeral",
  }),

  auditor: defineAgent({
    name: "auditor",
    description: "Audits code for a specific concern category",
    model: "openai/gpt-5.4-mini" as ModelId,
    allowedTools: ["grep", "glob", "read", "memory_search", "bash"],
    systemPromptAddendum: AUDITOR_PROMPT,
    persistence: "ephemeral",
  }),
} as const

// Default model — used when an agent has no model set
export const DEFAULT_MODEL_ID = "openai/gpt-5.4-mini" as ModelId

/** Resolve model for an agent definition */
export const resolveAgentModel = (agent: AgentDefinition): ModelId =>
  agent.model ?? DEFAULT_MODEL_ID

export const resolveAgentPersistence = (
  agent: AgentDefinition,
  override?: AgentPersistence,
): AgentPersistence => override ?? agent.persistence ?? "durable"

// Agent Execution Overrides — per-run overrides for agent dispatch

export interface AgentExecutionOverrides {
  readonly modelId?: ModelId
  readonly allowedTools?: ReadonlyArray<string>
  readonly deniedTools?: ReadonlyArray<string>
  readonly reasoningEffort?: ReasoningEffort
  readonly systemPromptAddendum?: string
  /** Tags passed to RunContext */
  readonly tags?: ReadonlyArray<string>
  /** @deprecated Use extension tool projections instead */
  readonly additionalTools?: ReadonlyArray<AnyToolDefinition>
}

export const AgentExecutionOverridesSchema = Schema.Struct({
  modelId: Schema.optional(ModelId),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  reasoningEffort: Schema.optional(ReasoningEffort),
  systemPromptAddendum: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
})
export type AgentExecutionOverridesSchema = typeof AgentExecutionOverridesSchema.Type

export type BuiltinAgentName = keyof typeof Agents

// Agent run depth

/**
 * Maximum session nesting depth for agent-run spawns. Derived from the persisted
 * parent chain (includes both subagent spawns and handoff sessions). A depth of 3
 * means root → child → grandchild → great-grandchild is blocked.
 */
export const DEFAULT_MAX_AGENT_RUN_DEPTH = 3

// Agent runner types

export interface AgentRunToolCall {
  toolName: string
  args: Record<string, unknown>
  isError: boolean
}

export type AgentRunResult =
  | {
      _tag: "success"
      text: string
      sessionId: SessionId
      agentName: AgentName
      persistence?: AgentPersistence
      usage?: { input: number; output: number; cost?: number }
      toolCalls?: ReadonlyArray<AgentRunToolCall>
      savedPath?: string
    }
  | {
      _tag: "error"
      error: string
      sessionId?: SessionId
      agentName?: AgentName
      persistence?: AgentPersistence
    }

export const getDurableAgentRunSessionId = (result: AgentRunResult): SessionId | undefined =>
  result.sessionId !== undefined && (result.persistence ?? "durable") === "durable"
    ? result.sessionId
    : undefined

export class AgentRunError extends Schema.TaggedErrorClass<AgentRunError>()("AgentRunError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface AgentRunner {
  readonly run: (params: {
    agent: AgentDefinition
    prompt: string
    parentSessionId: SessionId
    parentBranchId: BranchId
    toolCallId?: ToolCallId
    cwd: string
    overrides?: AgentExecutionOverrides
    persistence?: AgentPersistence
  }) => EffectNs.Effect<AgentRunResult, AgentRunError>
}

export class AgentRunnerService extends ServiceMap.Service<AgentRunnerService, AgentRunner>()(
  "@gent/core/src/domain/agent/AgentRunnerService",
) {}
