import { Context, Schema } from "effect"
import type * as EffectNs from "effect/Effect"
import { ToolCallId } from "./ids.js"
import type { BranchId, SessionId } from "./ids.js"
import { ModelId } from "./model"
import { TaggedEnumClass } from "./schema-tagged-enum-class.js"

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

// Agent driver — discriminated reference into `DriverRegistry`.
//
// Optional: when omitted, the loop resolves a model driver from the agent's
// model id (`provider/model` parses out the driver id). Specify
// `{ _tag: "external", id }` to route through an `ExternalDriverContribution`
// (e.g. ACP agents) instead of a model provider.

export const DriverRef = TaggedEnumClass("DriverRef", {
  model: {
    /** Optional model-driver id override. When omitted, the loop derives it
     *  from the agent's model id segment. */
    id: Schema.optional(Schema.String),
  },
  external: {
    /** External driver id — must match a registered
     *  `ExternalDriverContribution.id`. */
    id: Schema.String,
  },
})
export type DriverRef = Schema.Schema.Type<typeof DriverRef>

// Per-variant aliases — same class identity, convenience names.
export const ModelDriverRef = DriverRef.model
export type ModelDriverRef = (typeof DriverRef)["model"]["Type"]
export const ExternalDriverRef = DriverRef.external
export type ExternalDriverRef = (typeof DriverRef)["external"]["Type"]

/** Default agent name — used when no agent is explicitly specified. */
export const DEFAULT_AGENT_NAME = "cowork" as AgentName

/** Brand symbol identifying values produced by `defineAgent`. */
export const AgentDefinitionBrand: unique symbol = Symbol.for("@gent/AgentDefinition")

/**
 * AgentSpec — agent identity + defaults.
 *
 * Per `composability-not-flags`, agent specs carry only what makes the agent
 * what it is: name, description, model, prompt, tool allow/deny, sampling
 * defaults, and driver routing. Per-run concerns (persistence/retention,
 * overrides, parent-tool linkage, tags) live on `RunSpec`.
 *
 * Built-in prompts moved to their owning extensions (`@gent/agents`,
 * `@gent/audit`, `@gent/librarian`, `@gent/research`).
 */
export class AgentDefinition extends Schema.Class<AgentDefinition>("AgentDefinition")({
  name: AgentName,
  description: Schema.optional(Schema.String),
  model: Schema.optional(ModelId),
  systemPromptAddendum: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  temperature: Schema.optional(Schema.Number),
  reasoningEffort: Schema.optional(ReasoningEffort),
  driver: Schema.optional(DriverRef),
}) {}

/** @alias retained for transitional readability — `AgentSpec` is the conceptual name. */
export const AgentSpec = AgentDefinition
export type AgentSpec = AgentDefinition

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

// Built-in agents and their prompts live in their owning extensions:
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

// ── RunSpec — per-run dispatch configuration ──
//
// Per `composability-not-flags`, separates per-run concerns from agent identity:
//   - `persistence`   — durable vs ephemeral storage (was on AgentDefinition)
//   - `overrides`     — per-turn model/tool/prompt overrides
//   - `tags`          — RunContext annotations
//   - `parentToolCallId` — links a child run to the tool call that spawned it
//
// Replaces the old `AgentExecutionOverrides` interface, which conflated
// "what to override" with "how to invoke". Spawn callers always pass a
// `RunSpec` (possibly empty) instead of a flat positional bag.

export const AgentRunOverridesSchema = Schema.Struct({
  modelId: Schema.optional(ModelId),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  reasoningEffort: Schema.optional(ReasoningEffort),
  systemPromptAddendum: Schema.optional(Schema.String),
})
export type AgentRunOverrides = typeof AgentRunOverridesSchema.Type

export const RunSpecSchema = Schema.Struct({
  persistence: Schema.optional(AgentPersistence),
  overrides: Schema.optional(AgentRunOverridesSchema),
  tags: Schema.optional(Schema.Array(Schema.String)),
  parentToolCallId: Schema.optional(ToolCallId),
})
export type RunSpec = typeof RunSpecSchema.Type

/** Resolve persistence for a run — explicit RunSpec wins; default `durable`. */
export const resolveRunPersistence = (runSpec?: RunSpec): AgentPersistence =>
  runSpec?.persistence ?? "durable"

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
    cwd: string
    /** Per-run dispatch config. `persistence`, `overrides`, `tags`, `parentToolCallId`. */
    runSpec?: RunSpec
  }) => EffectNs.Effect<AgentRunResult, AgentRunError>
}

export class AgentRunnerService extends Context.Service<AgentRunnerService, AgentRunner>()(
  "@gent/core/src/domain/agent/AgentRunnerService",
) {}
