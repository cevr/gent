import { Context, Schema } from "effect"
import type * as EffectNs from "effect/Effect"
import { ToolCallId } from "./ids.js"
import type { BranchId, SessionId } from "./ids.js"
import { ModelId } from "./model"

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

export const AgentRole = Schema.Literals(["primary", "reviewer"])
export type AgentRole = typeof AgentRole.Type

// Agent execution strategy — model-backed (default) or external (TurnExecutor dispatch)

export class ModelExecution extends Schema.TaggedClass<ModelExecution>()("model", {}) {}

export class ExternalExecution extends Schema.TaggedClass<ExternalExecution>()("external", {
  runnerId: Schema.String,
}) {}

export const AgentExecution = Schema.Union([ModelExecution, ExternalExecution])
export type AgentExecution = typeof AgentExecution.Type

/** Default agent name — used when no agent is explicitly specified. */
export const DEFAULT_AGENT_NAME = "cowork" as AgentName

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
  role: Schema.optional(AgentRole),
  execution: Schema.optional(AgentExecution),
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

// Built-in agents are defined in their respective extensions:
// - @gent/agents (extensions/agents.ts): cowork, deepwork, explore, summarizer, title
// - @gent/research (extensions/research/index.ts): architect
// - @gent/audit (extensions/audit/index.ts): auditor
// - @gent/librarian (extensions/librarian/index.ts): librarian

// Agent collections are in extensions/all-agents.ts — import from there for test harnesses.

// Default model — used when an agent has no model set
export const DEFAULT_MODEL_ID = ModelId.of("openai/gpt-5.4-mini")

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
  /** Tool call that spawned this run (subagent/ephemeral) — threaded to ExtensionTurnContext */
  readonly parentToolCallId?: ToolCallId
}

export const AgentExecutionOverridesSchema = Schema.Struct({
  modelId: Schema.optional(ModelId),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  reasoningEffort: Schema.optional(ReasoningEffort),
  systemPromptAddendum: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  parentToolCallId: Schema.optional(ToolCallId),
})
export type AgentExecutionOverridesSchema = typeof AgentExecutionOverridesSchema.Type

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

export class AgentRunnerService extends Context.Service<AgentRunnerService, AgentRunner>()(
  "@gent/core/src/domain/agent/AgentRunnerService",
) {}
