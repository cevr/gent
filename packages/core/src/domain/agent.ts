import { Context, Option, Predicate, Schema, SchemaGetter } from "effect"
import { BranchId, branded, MessageId, RequestId, SessionId, ToolCallId } from "./ids.js"
import type * as EffectNs from "effect/Effect"
import type { AgentEvent, TurnCompleted } from "./event.js"
import { omitUndefined } from "./guards.js"

// ── model ───────────────────────────────────────────────────────────────────

// Model ID - provider/model format

export const ModelId = Schema.String.pipe(branded("ModelId"))
export type ModelId = typeof ModelId.Type

// Provider - AI provider identifier (open, branded string — extensible via extensions)

export const ProviderId = Schema.String.pipe(branded("ProviderId"))
export type ProviderId = typeof ProviderId.Type

// Model pricing per million tokens (USD)

export const ModelPricing = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
})
export type ModelPricing = typeof ModelPricing.Type

// Model - individual model from a provider (built-in or custom)

export class Model extends Schema.Class<Model>("Model")({
  id: ModelId,
  name: Schema.String,
  provider: ProviderId,
  contextLength: Schema.optional(Schema.Finite),
  pricing: Schema.optional(ModelPricing),
  /** When the driver released the model; an ISO-8601 prefix: `2026-02-17` or `2025-04`. */
  releaseDate: Schema.optional(Schema.String),
}) {}

/**
 * Newest release first; models without a date sort last.
 *
 * ISO-8601 prefixes compare correctly as plain strings, so a partial
 * `2025-04` orders just ahead of any fuller date in that month.
 */
export const byReleaseDateDesc = (models: readonly Model[]): readonly Model[] =>
  [...models].sort((left, right) => {
    const l = Option.getOrElse(Option.fromUndefinedOr(left.releaseDate), () => "")
    const r = Option.getOrElse(Option.fromUndefinedOr(right.releaseDate), () => "")
    if (l === r) return 0
    if (l.length === 0) return 1
    if (r.length === 0) return -1
    if (l > r) return -1
    return 1
  })

// Calculate cost from token usage

export const calculateCost = (
  usage: { inputTokens: number; outputTokens: number },
  pricing: Option.Option<ModelPricing>,
): number => {
  if (Option.isNone(pricing)) return 0
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.value.input
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.value.output
  return inputCost + outputCost
}

export const parseModelProvider = (modelId: string): Option.Option<ProviderId> => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return Option.none()
  return Option.some(ProviderId.make(modelId.slice(0, slash)))
}

export const parseModelId = (modelId: string): Option.Option<readonly [ProviderId, string]> => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return Option.none()
  return Option.some([ProviderId.make(modelId.slice(0, slash)), modelId.slice(slash + 1)])
}

// ── agent ───────────────────────────────────────────────────────────────────

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
// `{ _tag: "External", id }` to route through an `ExternalDriverContribution`
// (e.g. ACP agents) instead of a model provider.

const ModelDriverRefStruct = Schema.TaggedStruct("Model", {
  /** Optional model-driver id override. When omitted, the loop derives it
   *  from the agent's model id segment. */
  id: Schema.optional(Schema.String),
})
const ExternalDriverRefStruct = Schema.TaggedStruct("External", {
  /** External driver id — must match a registered
   *  `ExternalDriverContribution.id`. */
  id: Schema.String,
})

export const DriverRef = Schema.Union([ModelDriverRefStruct, ExternalDriverRefStruct]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type DriverRef = Schema.Schema.Type<typeof DriverRef>

// Per-variant aliases — same TaggedStruct identity, convenience names.
export const ModelDriverRef = DriverRef.cases.Model
export type ModelDriverRef = typeof DriverRef.cases.Model.Type
export const ExternalDriverRef = DriverRef.cases.External
export type ExternalDriverRef = typeof DriverRef.cases.External.Type

/**
 * `DriverRef` as it may appear on disk. A `.gent/config.json` written before
 * the variant keys became PascalCase holds `{ "_tag": "external" }`, and
 * `UserConfig` rejects it — which fails the decode of the *whole* file, not
 * just this field. `ConfigService.readConfigOrEmpty` maps any such failure to
 * an empty config and the next `set()` writes that empty config back, so an
 * unmigrated tag silently discards the user's other settings.
 *
 * Decoding accepts both spellings; encoding emits only PascalCase, so a config
 * is migrated in place the first time gent saves it.
 */
const LegacyModelDriverRefStruct = Schema.TaggedStruct("model", {
  id: Schema.optional(Schema.String),
})
const LegacyExternalDriverRefStruct = Schema.TaggedStruct("external", { id: Schema.String })

type LegacyDriverRef =
  | typeof LegacyModelDriverRefStruct.Type
  | typeof LegacyExternalDriverRefStruct.Type

const canonicalDriverRef = (ref: DriverRef | LegacyDriverRef): DriverRef => {
  if (ref._tag === "model") {
    return Option.match(Option.fromUndefinedOr(ref.id), {
      onNone: () => ModelDriverRefStruct.make({}),
      onSome: (id) => ModelDriverRefStruct.make({ id }),
    })
  }
  if (ref._tag === "external") return ExternalDriverRefStruct.make({ id: ref.id })
  return ref
}

export const DriverRefFromConfig = Schema.Union([
  ModelDriverRefStruct,
  ExternalDriverRefStruct,
  LegacyModelDriverRefStruct,
  LegacyExternalDriverRefStruct,
]).pipe(
  Schema.decodeTo(DriverRef, {
    decode: SchemaGetter.transform(canonicalDriverRef),
    encode: SchemaGetter.transform((ref: DriverRef): DriverRef => ref),
  }),
)

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
  /** Input window in tokens. Overrides the model catalog's limit; a smaller value hands off sooner. */
  contextLength: Schema.optional(Schema.Natural),
  /** Model steps one turn may take. Lowers the loop's own ceiling; it cannot raise it. */
  maxSteps: Schema.optional(Schema.Natural),
  /**
   * Durable model resolutions one turn may make, counted across restarts.
   * A turn that keeps being recovered and re-resolved stops here instead of
   * spending forever; unset, the turn has no such ceiling.
   */
  maxModelAttempts: Schema.optional(Schema.Natural),
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

/** The model driver a turn dispatches through, and the catalog id of the model it reaches. */
export interface EffectiveModelDriver {
  /** The agent's model driver when it names one, else the provider segment of the model id. */
  readonly driverId: Option.Option<string>
  /** `driver/model` as the model catalog sees it: a driver override replaces the provider segment. */
  readonly contextModelId: ModelId
}

/**
 * Derive the effective model driver once. The resolver, the retry policy,
 * and the model catalog all read this one result instead of re-parsing the
 * model id against the driver reference.
 */
export const effectiveModelDriver = (
  driver: Option.Option<DriverRef>,
  modelId: ModelId,
): EffectiveModelDriver => {
  const parsed = parseModelId(modelId)
  const override = Option.flatMap(driver, (ref) => {
    if (ref._tag !== "Model") return Option.none()
    return Option.fromUndefinedOr(ref.id)
  })
  return Option.match(override, {
    onNone: () => ({
      driverId: Option.map(parsed, ([provider]) => provider),
      contextModelId: modelId,
    }),
    onSome: (id) => ({
      driverId: Option.some(id),
      contextModelId: Option.match(parsed, {
        onNone: () => modelId,
        onSome: ([, modelName]) => ModelId.make(`${id}/${modelName}`),
      }),
    }),
  })
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
  contextLength: Schema.optional(Schema.Natural),
  maxSteps: Schema.optional(Schema.Natural),
  maxModelAttempts: Schema.optional(Schema.Natural),
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

export const makeRunSpec = (input: RunSpec = {}): RunSpec => omitUndefined(input)

// Agent run depth

/**
 * Maximum session nesting depth. Derived from the persisted parent chain; root
 * depth is 0, and a parent at depth 3 cannot get another child. Enforced in one
 * place, `admitChildSessionDepth` (`runtime/session-depth.ts`), which both
 * child writers call: `admitChildSession` (delegate/btw/read-session spawns)
 * and `SessionMutations.createSession` (`session.create` with a
 * `parentSessionId`, the compaction handoff).
 */
export const DEFAULT_MAX_AGENT_RUN_DEPTH = 3

/** A parent at the nesting cap asked for one more child. */
export class SessionDepthLimitError extends Schema.TaggedError<SessionDepthLimitError>()(
  "SessionDepthLimitError",
  {
    message: Schema.String,
    parentSessionId: SessionId,
    depth: Schema.Int,
    max: Schema.Int,
  },
) {}
/** Maximum unfinished durable start receipts owned by one parent branch. */
export const DEFAULT_MAX_PENDING_AGENT_STARTS = 4

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

const AgentRunSuccessStruct = Schema.TaggedStruct("Success", {
  text: Schema.String,
  sessionId: SessionId,
  agentName: AgentName,
  usage: Schema.optional(AgentRunUsageSchema),
  toolCalls: Schema.optional(Schema.Array(AgentRunToolCallSchema)),
})
const AgentRunFailureStruct = Schema.TaggedStruct("Error", {
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
  /**
   * Put a message into the child's running turn; it reads it at its next
   * step. A finished child takes no more messages: one start owes the parent
   * one completion, and a second turn would have no one to report to.
   * `sendId` makes a replayed call deliver once.
   */
  readonly send: (
    params: Parameters<AgentRunner["inspect"]>[0] & {
      readonly message: string
      readonly sendId: RequestId
    },
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

// ── steer ───────────────────────────────────────────────────────────────────

// Steer Command — RPC payload that targets a session/branch loop.
// Lives in domain so transport-contract and runtime can both import without
// either taking a dependency on the other.

const SteerTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
}

export const SteerCommand = Schema.Union([
  Schema.TaggedStruct("Cancel", {
    ...SteerTargetFields,
    messageId: Schema.optional(MessageId),
  }),
  Schema.TaggedStruct("Interrupt", {
    ...SteerTargetFields,
    messageId: Schema.optional(MessageId),
  }),
  Schema.TaggedStruct("Interject", {
    ...SteerTargetFields,
    message: Schema.String,
    agent: Schema.optional(AgentName),
    /**
     * Start a turn when the branch is idle, instead of waiting in the queue.
     *
     * Steering exists to reach a turn that is already running, so an idle
     * branch parks it by default and a reader can still see it through
     * `queue.get`. A caller that wants an answer now — a queued question
     * being answered, a child reporting back — says so here.
     */
    wake: Schema.optional(Schema.Boolean),
  }),
])
export type SteerCommand = typeof SteerCommand.Type
