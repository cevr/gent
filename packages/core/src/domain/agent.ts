import { Context, Option, Predicate, Schema } from "effect"
import type * as EffectNs from "effect/Effect"
import { branded, BranchId, RequestId, SessionId, ToolCallId } from "./ids.js"
import type { AgentEvent, TurnCompleted } from "./event.js"
import { ModelId } from "./model"

// Agent definitions

export const AgentName = Schema.String.pipe(branded("AgentName"))
export type AgentName = typeof AgentName.Type

export const ReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])
export type ReasoningEffort = typeof ReasoningEffort.Type
export const isReasoningEffort = Schema.is(ReasoningEffort)

// Agent driver — discriminated reference into `DriverRegistry`.
//
// Optional: when omitted, the loop resolves a model driver from the agent's
// model id (`provider/model` parses out the driver id). Specify
// `{ _tag: "external", id }` to route through an `ExternalDriverContribution`
// (e.g. ACP agents) instead of a model provider.

const ModelDriverRefStruct = Schema.TaggedStruct("model", {
  /** Optional model-driver id override. When omitted, the loop derives it
   *  from the agent's model id segment. */
  id: Schema.optional(Schema.String),
})
const ExternalDriverRefStruct = Schema.TaggedStruct("external", {
  /** External driver id — must match a registered
   *  `ExternalDriverContribution.id`. */
  id: Schema.String,
})

export const DriverRef = Schema.Union([ModelDriverRefStruct, ExternalDriverRefStruct]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type DriverRef = Schema.Schema.Type<typeof DriverRef>

// Per-variant aliases — same TaggedStruct identity, convenience names.
export const ModelDriverRef = DriverRef.cases.model
export type ModelDriverRef = typeof DriverRef.cases.model.Type
export const ExternalDriverRef = DriverRef.cases.external
export type ExternalDriverRef = typeof DriverRef.cases.external.Type

/** Default agent name — used when no agent is explicitly specified. */
export const DEFAULT_AGENT_NAME = AgentName.make("main")

/**
 * AgentDefinition — agent identity + defaults.
 *
 * Per `composability-not-flags`, agent specs carry only what makes the agent
 * what it is: name, description, model, prompt, tool allow/deny, sampling
 * defaults, and driver routing. Per-run concerns (persistence/retention,
 * overrides, parent-tool linkage, tags) live on `RunSpec`.
 *
 * Built-in prompts moved to their owning extensions.
 */
export class AgentDefinition extends Schema.Class<AgentDefinition>("AgentDefinition")({
  name: AgentName,
  description: Schema.optional(Schema.String),
  model: Schema.optional(ModelId),
  systemPromptAddendum: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  temperature: Schema.optional(Schema.Finite),
  reasoningEffort: Schema.optional(ReasoningEffort),
  driver: Schema.optional(DriverRef),
}) {}

// The one shipped agent (`main`) lives in @gent/agents (extensions/agents.ts).
// Children spawned from a cell inherit the caller's agent and model.

// Default model — used when an agent has no model set
export const DEFAULT_MODEL_ID = ModelId.make("anthropic/claude-sonnet-5")

/** Resolve model for an agent definition */
export const resolveAgentModel = (agent: AgentDefinition): ModelId =>
  agent.model ?? DEFAULT_MODEL_ID

/** Model of the default agent, when it is registered. */
export const resolveDefaultAgentModel = (
  agents: ReadonlyArray<AgentDefinition>,
): Option.Option<ModelId> =>
  Option.fromUndefinedOr(agents.find((agent) => agent.name === DEFAULT_AGENT_NAME)).pipe(
    Option.map(resolveAgentModel),
  )

// ── Runtime driver routing ──

/** Where the resolved driver came from; a config-routed driver is checked against the registry. */
type DriverSource = "agent" | "config" | "default"

interface ResolvedAgentDriver {
  /** The driver to dispatch through. `undefined` ⇒ default model path
   *  (the loop derives a model driver from the agent's model id). */
  readonly driver: AgentDefinition["driver"]
  readonly source: DriverSource
}

/**
 * Resolve which driver an agent should dispatch through. Precedence:
 *
 *   1. `AgentDefinition.driver`        — hardcoded by the extension author.
 *      Not overridable (the author opted into a specific backend).
 *   2. `overrides[agent.name]`         — runtime config (`UserConfig.driverOverrides`,
 *      project shadows user). Used by the `/driver` command.
 *   3. `undefined`                     — default; the loop derives a model
 *      driver from `agent.model`.
 *
 * Pure function — no Effect, no service dependency. Callers thread the
 * `overrides` map in from `ConfigService` (the loop yields it during turn
 * context resolution; auth-guard takes it as a param).
 */
export const resolveAgentDriver = (
  agent: AgentDefinition,
  overrides?: Readonly<Record<AgentName, DriverRef>>,
): ResolvedAgentDriver => {
  if (Predicate.isNotUndefined(agent.driver)) {
    return { driver: agent.driver, source: "agent" }
  }
  const fromConfig = overrides?.[agent.name]
  if (Predicate.isNotUndefined(fromConfig)) {
    return { driver: fromConfig, source: "config" }
  }
  return { driver: agent.driver, source: "default" }
}

// ── RunSpec — per-run dispatch configuration ──
//
// Separates per-run concerns from agent identity:
//   - `history`       — whether the child starts from the caller's branch history
//   - `visibility`    — whether the child leaves a trace on the parent
//   - `overrides`     — per-turn model/tool/prompt overrides
//   - `parentToolCallId` — links a child run to the tool call that spawned it
//
// Every child is a durable session driven by the same loop as its parent.

export const AgentRunOverridesSchema = Schema.Struct({
  modelId: Schema.optional(ModelId),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  reasoningEffort: Schema.optional(ReasoningEffort),
  systemPromptAddendum: Schema.optional(Schema.String),
})
export type AgentRunOverrides = typeof AgentRunOverridesSchema.Type

/** Whether a run starts from a copy of the caller's branch history or from nothing. */
const AgentRunHistory = Schema.Literals(["none", "inherit"])
type AgentRunHistory = typeof AgentRunHistory.Type

/**
 * `private` keeps a run off the parent's event stream, and its session is
 * deleted when the run ends. Side questions and one-shot extractions rely on it.
 */
const AgentRunVisibility = Schema.Literals(["parent", "private"])
type AgentRunVisibility = typeof AgentRunVisibility.Type

export const RunSpecSchema = Schema.Struct({
  /** `inherit` copies the parent branch's visible messages into the child before its prompt. */
  history: Schema.optional(AgentRunHistory),
  visibility: Schema.optional(AgentRunVisibility),
  overrides: Schema.optional(AgentRunOverridesSchema),
  parentToolCallId: Schema.optional(ToolCallId),
})
export type RunSpec = typeof RunSpecSchema.Type

interface RunSpecInput extends RunSpec {}

export const makeRunSpec = (input: RunSpecInput = {}): RunSpec => {
  const spec: { -readonly [K in keyof RunSpec]: RunSpec[K] } = {}
  if (Predicate.isNotUndefined(input.history)) spec.history = input.history
  if (Predicate.isNotUndefined(input.visibility)) spec.visibility = input.visibility
  if (Predicate.isNotUndefined(input.overrides)) spec.overrides = input.overrides
  if (Predicate.isNotUndefined(input.parentToolCallId))
    spec.parentToolCallId = input.parentToolCallId
  return spec
}

// Agent run depth

/**
 * Maximum session nesting depth for agent-run spawns. Derived from the persisted
 * parent chain (includes both subagent spawns and handoff sessions). Root depth
 * is 0. A session at depth 3 cannot create another child.
 */
export const DEFAULT_MAX_AGENT_RUN_DEPTH = 3
/** Maximum unfinished durable start receipts owned by one parent branch. */
export const DEFAULT_MAX_PENDING_AGENT_STARTS = 4
/** Durable native-model resolution attempts per admitted child session. */
export const DEFAULT_MAX_CHILD_MODEL_ATTEMPTS = 32

// Agent runner types

export const AgentRunToolCallSchema = Schema.Struct({
  toolName: Schema.String,
  args: Schema.Record(Schema.String, Schema.Unknown),
  isError: Schema.Boolean,
})
export type AgentRunToolCall = Schema.Schema.Type<typeof AgentRunToolCallSchema>

const AgentRunUsageSchema = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cost: Schema.optional(Schema.Finite),
})
type AgentRunUsage = typeof AgentRunUsageSchema.Type

/** The receipt's token totals in the run-result shape. */
export const agentRunUsage = (usage: {
  readonly inputTokens: number
  readonly outputTokens: number
}): AgentRunUsage => ({ input: usage.inputTokens, output: usage.outputTokens })

const AgentRunSuccessStruct = Schema.TaggedStruct("success", {
  text: Schema.String,
  sessionId: SessionId,
  agentName: AgentName,
  usage: Schema.optional(AgentRunUsageSchema),
  toolCalls: Schema.optional(Schema.Array(AgentRunToolCallSchema)),
})
const AgentRunFailureStruct = Schema.TaggedStruct("error", {
  error: Schema.String,
  sessionId: Schema.optional(SessionId),
  agentName: Schema.optional(AgentName),
})

export const AgentRunResult = Schema.Union([AgentRunSuccessStruct, AgentRunFailureStruct]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type AgentRunResult = Schema.Schema.Type<typeof AgentRunResult>

export class AgentRunError extends Schema.TaggedError<AgentRunError>()("AgentRunError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** One child known to the parent host. Completed is a turn receipt, not task success. */
export const ChildAgentRegistryEntry = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  branchId: BranchId,
  agentName: AgentName,
  completed: Schema.Boolean,
})
export type ChildAgentRegistryEntry = typeof ChildAgentRegistryEntry.Type

export interface AgentRunner {
  /** Admit one durable child. Reuse requestId only with identical input. */
  readonly start: (params: {
    agent: AgentDefinition
    prompt: string
    parentSessionId: SessionId
    parentBranchId: BranchId
    cwd: string
    requestId: RequestId
    toolCallId: ToolCallId
    runSpec?: RunSpec
  }) => EffectNs.Effect<{ sessionId: SessionId; branchId: BranchId }, AgentRunError>
  /** Missing completion is unknown, not proof of a running child. */
  readonly inspect: (params: {
    requestId: RequestId
    parentSessionId: SessionId
    parentBranchId: BranchId
  }) => EffectNs.Effect<
    { sessionId: SessionId; branchId: BranchId; completion: Option.Option<TurnCompleted> },
    AgentRunError
  >
  /** The parent-owned child registry for one branch. Completion arrives as a follow-up message. */
  readonly list: (params: {
    parentSessionId: SessionId
    parentBranchId: BranchId
  }) => EffectNs.Effect<ReadonlyArray<ChildAgentRegistryEntry>, AgentRunError>
  /** Submit cancellation for the admitted turn only. Completion arrives as a follow-up message. */
  readonly cancel: (
    params: Parameters<AgentRunner["inspect"]>[0],
  ) => EffectNs.Effect<void, AgentRunError>
  readonly run: (params: {
    agent: AgentDefinition
    prompt: string
    parentSessionId: SessionId
    parentBranchId: BranchId
    cwd: string
    /** Per-run dispatch config. `history`, `visibility`, `overrides`, `tags`, `parentToolCallId`. */
    runSpec?: RunSpec
    /** Sees child events in order as they happen, private runs included. Best effort: the run result can return before trailing events are observed, so read the answer from the result. */
    observe?: (event: AgentEvent) => EffectNs.Effect<void>
  }) => EffectNs.Effect<AgentRunResult, AgentRunError>
}

export class AgentRunnerService extends Context.Service<AgentRunnerService, AgentRunner>()(
  "@gent/core/src/domain/agent/AgentRunnerService",
) {}
