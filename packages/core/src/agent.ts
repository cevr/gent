import { ServiceMap, Effect, Layer, Schema } from "effect"
import type * as EffectNs from "effect/Effect"
import type { BranchId, SessionId } from "./ids"
import type { ModelId } from "./model"

// Agent definitions

export const AgentKind = Schema.Literals(["primary", "subagent", "system"])
export type AgentKind = typeof AgentKind.Type

export const AgentName = Schema.Literals([
  "cowork",
  "deepwork",
  "explore",
  "architect",
  "librarian",
  "summarizer",
  "title",
  "finder",
  "oracle",
  "reviewer",
])
export type AgentName = typeof AgentName.Type

export const ReasoningEffort = Schema.Literals(["minimal", "low", "medium", "high"])
export type ReasoningEffort = typeof ReasoningEffort.Type

export class AgentDefinition extends Schema.Class<AgentDefinition>("AgentDefinition")({
  name: AgentName,
  description: Schema.optional(Schema.String),
  kind: AgentKind,
  hidden: Schema.optional(Schema.Boolean),
  systemPromptAddendum: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  temperature: Schema.optional(Schema.Number),
  reasoningEffort: Schema.optional(ReasoningEffort),
  canDelegateToAgents: Schema.optional(Schema.Array(AgentName)),
}) {}

export type AgentDefinitionInput = ConstructorParameters<typeof AgentDefinition>[0]

export const defineAgent = (input: AgentDefinitionInput): AgentDefinition =>
  new AgentDefinition(input)

// Prompts

export const COWORK_PROMPT = `
Cowork agent. Fast, practical, execute changes. Minimal prose. Ask only when blocked. Use tools freely.
`.trim()

export const DEEPWORK_PROMPT = `
Deepwork agent. Thorough analysis, careful tradeoffs, explicit assumptions. Prefer correctness over speed. Ask clarifying questions when needed. Still execute when confident.
`.trim()

export const EXPLORE_PROMPT = `
Explore agent. Rapid codebase scanning. Prefer rg/glob/read. Short findings, paths, and next steps.
`.trim()

export const ARCHITECT_PROMPT = `
Architect agent. Design implementation approach, structure, tradeoffs, risks. No code changes.
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

export const ORACLE_PROMPT = `
Oracle agent. Expert reasoning for hard problems — architecture review, debugging, complex planning.
Provide comprehensive zero-shot analysis. Cite specific file paths and line numbers.
Structure: problem → analysis → recommendation → implementation.
`.trim()

export const REVIEWER_PROMPT = `
Reviewer agent. Examine code changes for bugs, security issues, and improvements.
Run git diff or read specified files, then produce a structured review.
Output a JSON array of review comments, each with: file, line (optional), severity (critical/high/medium/low), type (bug/suggestion/style), text, fix (optional).
Only output the JSON array, no other text.
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
    canDelegateToAgents: ["explore", "architect", "librarian", "finder", "oracle", "reviewer"],
    systemPromptAddendum: COWORK_PROMPT,
  }),

  deepwork: defineAgent({
    name: "deepwork",
    description: "Deep reasoning mode - thorough analysis, slower/longer answers",
    kind: "primary",
    canDelegateToAgents: ["explore", "architect", "librarian", "finder", "oracle", "reviewer"],
    systemPromptAddendum: DEEPWORK_PROMPT,
    reasoningEffort: "high",
  }),

  explore: defineAgent({
    name: "explore",
    description: "Fast codebase exploration - finds files, searches patterns",
    kind: "subagent",
    allowedTools: ["read", "grep", "glob", "bash"],
    systemPromptAddendum: EXPLORE_PROMPT,
  }),

  architect: defineAgent({
    name: "architect",
    description: "Designs implementation approaches",
    kind: "subagent",
    allowedTools: ["read", "grep", "glob", "webfetch", "websearch"],
    systemPromptAddendum: ARCHITECT_PROMPT,
  }),

  librarian: defineAgent({
    name: "librarian",
    description: "Answers questions about external repos using local cached clones",
    kind: "subagent",
    allowedTools: ["read", "grep", "glob"],
    systemPromptAddendum: LIBRARIAN_PROMPT,
  }),

  summarizer: defineAgent({
    name: "summarizer",
    kind: "system",
    hidden: true,
    allowedTools: [],
    systemPromptAddendum: SUMMARIZER_PROMPT,
  }),

  title: defineAgent({
    name: "title",
    kind: "system",
    hidden: true,
    allowedTools: [],
    temperature: 0.5,
  }),

  finder: defineAgent({
    name: "finder",
    description: "Fast multi-step codebase search via cheap model",
    kind: "subagent",
    allowedTools: ["read", "grep", "glob", "bash"],
    systemPromptAddendum: FINDER_PROMPT,
  }),

  oracle: defineAgent({
    name: "oracle",
    description: "Expert reasoning for hard problems via strong model",
    kind: "subagent",
    allowedTools: ["read", "grep", "glob", "bash"],
    systemPromptAddendum: ORACLE_PROMPT,
  }),

  reviewer: defineAgent({
    name: "reviewer",
    description: "Structured code review with severity-graded comments",
    kind: "subagent",
    allowedTools: ["read", "grep", "glob", "bash"],
    systemPromptAddendum: REVIEWER_PROMPT,
  }),
} as const

// Curated model mapping (not user-configurable)

export const AgentModels: Record<AgentName, ModelId> = {
  cowork: "anthropic/claude-opus-4-6" as ModelId,
  deepwork: "openai/gpt-5.4" as ModelId,
  explore: "anthropic/claude-3-5-haiku-20241022" as ModelId,
  architect: "anthropic/claude-opus-4-6" as ModelId,
  librarian: "anthropic/claude-3-5-haiku-20241022" as ModelId,
  summarizer: "anthropic/claude-3-5-haiku-20241022" as ModelId,
  title: "anthropic/claude-3-5-haiku-20241022" as ModelId,
  finder: "anthropic/claude-3-5-haiku-20241022" as ModelId,
  oracle: "anthropic/claude-opus-4-6" as ModelId,
  reviewer: "anthropic/claude-3-5-haiku-20241022" as ModelId,
}

export const resolveAgentModelId = (agent: AgentName): ModelId => AgentModels[agent]

export type BuiltinAgentName = keyof typeof Agents

// Agent registry

export interface AgentRegistryService {
  readonly get: (name: string) => Effect.Effect<AgentDefinition | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<AgentDefinition>>
  readonly listPrimary: () => Effect.Effect<ReadonlyArray<AgentDefinition>>
  readonly listSubagents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>
  readonly register: (agent: AgentDefinition) => Effect.Effect<void>
}

export class AgentRegistry extends ServiceMap.Service<AgentRegistry, AgentRegistryService>()(
  "@gent/core/src/agent/AgentRegistry",
) {
  static Live = Layer.effect(
    AgentRegistry,
    Effect.sync(() => {
      const agents = new Map<string, AgentDefinition>()
      for (const agent of Object.values(Agents)) {
        agents.set(agent.name, agent)
      }

      return AgentRegistry.of({
        get: (name) => Effect.succeed(agents.get(name)),
        list: () => Effect.succeed([...agents.values()]),
        listPrimary: () =>
          Effect.succeed(
            [...agents.values()].filter((a) => a.kind === "primary" && a.hidden !== true),
          ),
        listSubagents: () =>
          Effect.succeed([...agents.values()].filter((a) => a.kind === "subagent")),
        register: (agent) => Effect.sync(() => void agents.set(agent.name, agent)),
      })
    }),
  )
}

// Subagent runner types

export type SubagentResult =
  | {
      _tag: "success"
      text: string
      sessionId: SessionId
      agentName: AgentName
      usage?: { input: number; output: number; cost: number }
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
    cwd: string
  }) => EffectNs.Effect<SubagentResult, SubagentError>
}

export class SubagentRunnerService extends ServiceMap.Service<
  SubagentRunnerService,
  SubagentRunner
>()("@gent/core/src/agent/SubagentRunnerService") {}
