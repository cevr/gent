import { Option, Predicate, Schema, SchemaGetter } from "effect"
import { branded, SessionId, ToolCallId } from "./ids.js"
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

// Agent driver — discriminated reference into the resolved extension drivers.
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

export const RunSpecSchema = Schema.Struct({
  overrides: Schema.optional(AgentRunOverridesSchema),
  parentToolCallId: Schema.optional(ToolCallId),
})
export type RunSpec = typeof RunSpecSchema.Type

export const makeRunSpec = (input: RunSpec = {}): RunSpec => omitUndefined(input)

// Agent run depth

/**
 * Maximum session nesting depth. Derived from the persisted parent chain; root
 * depth is 0, and a parent at depth 3 cannot get another child. Enforced in one
 * place, `admitChildSessionDepth` (`runtime/session.ts`), which the one child
 * writer calls: `SessionMutations.createSession` (a create with a
 * `parentSessionId`).
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

// ── steer ───────────────────────────────────────────────────────────────────
