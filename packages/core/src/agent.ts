import { Context, Effect, Layer, Schema } from "effect"
import type * as EffectNs from "effect/Effect"
import type { ModelId } from "./model"

// Agent definitions

export const AgentKind = Schema.Literal("primary", "subagent", "system")
export type AgentKind = typeof AgentKind.Type

export const AgentName = Schema.Literal(
  "cowork",
  "deep",
  "explore",
  "architect",
  "compaction",
  "title",
)
export type AgentName = typeof AgentName.Type

export class AgentDefinition extends Schema.Class<AgentDefinition>("AgentDefinition")({
  name: AgentName,
  description: Schema.optional(Schema.String),
  kind: AgentKind,
  hidden: Schema.optional(Schema.Boolean),
  systemPromptAddendum: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  temperature: Schema.optional(Schema.Number),
  canDelegateToAgents: Schema.optional(Schema.Array(AgentName)),
}) {}

export type AgentDefinitionInput = ConstructorParameters<typeof AgentDefinition>[0]

export const defineAgent = (input: AgentDefinitionInput): AgentDefinition =>
  new AgentDefinition(input)

// Prompts

export const COWORK_PROMPT = `
Cowork agent. Fast, practical, execute changes. Minimal prose. Ask only when blocked. Use tools freely.
`.trim()

export const DEEP_PROMPT = `
Deep agent. Thorough analysis, careful tradeoffs, explicit assumptions. Prefer correctness over speed. Ask clarifying questions when needed. Still execute when confident.
`.trim()

export const EXPLORE_PROMPT = `
Explore agent. Rapid codebase scanning. Prefer rg/glob/read. Short findings, paths, and next steps.
`.trim()

export const ARCHITECT_PROMPT = `
Architect agent. Design implementation approach, structure, tradeoffs, risks. No code changes.
`.trim()

export const COMPACTION_PROMPT = `
Compaction agent. Summarize prior context. Focus decisions, open questions, current state.
`.trim()

// Built-in agents

export const Agents = {
  cowork: defineAgent({
    name: "cowork",
    description: "General purpose - full tool access, can execute code changes",
    kind: "primary",
    canDelegateToAgents: ["explore", "architect"],
    systemPromptAddendum: COWORK_PROMPT,
  }),

  deep: defineAgent({
    name: "deep",
    description: "Deep reasoning mode - thorough analysis, slower/longer answers",
    kind: "primary",
    canDelegateToAgents: ["explore", "architect"],
    systemPromptAddendum: DEEP_PROMPT,
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

  compaction: defineAgent({
    name: "compaction",
    kind: "system",
    hidden: true,
    allowedTools: [],
    systemPromptAddendum: COMPACTION_PROMPT,
  }),

  title: defineAgent({
    name: "title",
    kind: "system",
    hidden: true,
    allowedTools: [],
    temperature: 0.5,
  }),
} as const

// Curated model mapping (not user-configurable)

export const AgentModels: Record<AgentName, ModelId> = {
  cowork: "openai/opus-4.5" as ModelId,
  deep: "openai/codex-5.2" as ModelId,
  explore: "anthropic/claude-3-5-haiku-20241022" as ModelId,
  architect: "openai/opus-4.5" as ModelId,
  compaction: "anthropic/claude-3-5-haiku-20241022" as ModelId,
  title: "anthropic/claude-3-5-haiku-20241022" as ModelId,
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

export class AgentRegistry extends Context.Tag("@gent/core/src/agent/AgentRegistry")<
  AgentRegistry,
  AgentRegistryService
>() {
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
      sessionId: string
      agentName: AgentName
      usage?: { input: number; output: number; cost: number }
    }
  | {
      _tag: "error"
      error: string
      sessionId?: string
      agentName?: AgentName
    }

export class SubagentError extends Schema.TaggedError<SubagentError>()("SubagentError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface SubagentRunner {
  readonly run: (params: {
    agent: AgentDefinition
    prompt: string
    parentSessionId: string
    parentBranchId: string
    cwd: string
  }) => EffectNs.Effect<SubagentResult, SubagentError>
}

export class SubagentRunnerService extends Context.Tag(
  "@gent/core/src/agent/SubagentRunnerService",
)<SubagentRunnerService, SubagentRunner>() {}
