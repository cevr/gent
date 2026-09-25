import { Option, Schema, SchemaGetter } from "effect"
import { branded, SessionId } from "./ids.js"
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
  /** Input read from the prompt cache; priced as `input` when absent. */
  cacheRead: Schema.optional(Schema.Finite),
  /** Input written to the prompt cache; priced as `input` when absent. */
  cacheWrite: Schema.optional(Schema.Finite),
})
export type ModelPricing = typeof ModelPricing.Type

// Model - individual model from a provider (built-in or custom)

export class Model extends Schema.Class<Model>("Model")({
  id: ModelId,
  name: Schema.String,
  provider: ProviderId,
  contextLength: Schema.optional(Schema.Finite),
  /**
   * The most input tokens one request may carry, when the catalog names a cap
   * below the window: GPT-5 has a 400k window and refuses input past 272k.
   * Absent when input may fill the window less the output.
   */
  inputLimit: Schema.optional(Schema.Finite),
  pricing: Schema.optional(ModelPricing),
  /** When the driver released the model; an ISO-8601 prefix: `2026-02-17` or `2025-04`. */
  releaseDate: Schema.optional(Schema.String),
  /** Whether the model reasons, as the catalog says; absent when it does not say. */
  reasoning: Schema.optional(Schema.Boolean),
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

/**
 * The USD cost of one step. `inputTokens` counts every input token, cached or
 * not; the tokens read from or written to the prompt cache take their own
 * price when the catalog has one.
 */
export const calculateCost = (
  usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
  },
  pricing: Option.Option<ModelPricing>,
): number => {
  if (Option.isNone(pricing)) return 0
  const price = pricing.value
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const uncached = Math.max(0, usage.inputTokens - cacheRead - cacheWrite)
  const inputCost =
    uncached * price.input +
    cacheRead * (price.cacheRead ?? price.input) +
    cacheWrite * (price.cacheWrite ?? price.input)
  return (inputCost + usage.outputTokens * price.output) / 1_000_000
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

// Agent driver — a reference to a registered model driver.
//
// Optional: when omitted, the loop resolves a model driver from the agent's
// model id (`provider/model` parses out the driver id).

export const DriverRef = Schema.TaggedStruct("Model", {
  /** Optional model-driver id override. When omitted, the loop derives it
   *  from the agent's model id segment. */
  id: Schema.optional(Schema.String),
})
export type DriverRef = typeof DriverRef.Type

/**
 * A driver override as it may appear in `.gent/config.json`. Two retired
 * shapes can still be on disk, and neither may fail the decode: `UserConfig`
 * rejecting one field fails the whole file, and `ConfigService` then serves
 * an empty config.
 *
 * - `{ "_tag": "model" }`: written before the variant keys became
 *   PascalCase. It decodes to the PascalCase ref; the next save rewrites it.
 * - `{ "_tag": "External", "id" }` (or `"external"`): an override that routed
 *   an agent through an external turn executor (ACP). Those drivers are
 *   removed, so the override decodes as absent and the agent falls back to
 *   its default model; `ConfigService` logs a warning once per file.
 */
const LegacyModelDriverRef = Schema.TaggedStruct("model", {
  id: Schema.optional(Schema.String),
})
const RetiredExternalDriverRef = Schema.Union([
  Schema.TaggedStruct("External", { id: Schema.String }),
  Schema.TaggedStruct("external", { id: Schema.String }),
])
const StoredDriverRef = Schema.Union([DriverRef, LegacyModelDriverRef, RetiredExternalDriverRef])
type StoredDriverRef = typeof StoredDriverRef.Type

/** True for a stored override whose external driver no longer exists. */
export const isRetiredDriverRef = Schema.is(RetiredExternalDriverRef)

const liveDriverRef = (ref: StoredDriverRef): Option.Option<DriverRef> => {
  if (ref._tag === "Model") return Option.some(ref)
  if (ref._tag !== "model") return Option.none()
  return Option.some(
    Option.match(Option.fromUndefinedOr(ref.id), {
      onNone: () => DriverRef.make({}),
      onSome: (id) => DriverRef.make({ id }),
    }),
  )
}

const liveDriverOverrides = (stored: Readonly<Record<AgentName, StoredDriverRef>>) =>
  Object.fromEntries(
    Object.entries(stored).flatMap(([agent, ref]) =>
      Option.toArray(Option.map(liveDriverRef(ref), (live): [string, DriverRef] => [agent, live])),
    ),
  )

/** The `driverOverrides` config field: decodes every stored shape, encodes only live refs. */
export const DriverOverridesFromConfig = Schema.Record(AgentName, StoredDriverRef).pipe(
  Schema.decodeTo(Schema.Record(AgentName, DriverRef), {
    decode: SchemaGetter.transform(liveDriverOverrides),
    encode: SchemaGetter.transform(
      (
        live: Readonly<Record<AgentName, DriverRef>>,
      ): Readonly<Record<AgentName, StoredDriverRef>> => live,
    ),
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

// ── Runtime driver routing ──

/** The model driver a turn dispatches through, and the catalog id of the model it reaches. */
export interface EffectiveModelDriver {
  /**
   * The driver `resolveSessionRoute` picked (the agent's own, else config
   * `driverOverrides[name]`), else the provider segment of the model id.
   */
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
  const override = Option.flatMap(driver, (ref) => Option.fromUndefinedOr(ref.id))
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
// Separates per-run concerns from agent identity: `overrides` reshape the
// agent's model, tools and prompt for every turn of the session.
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

/**
 * Rows written before `parentToolCallId` was dropped still carry it; a struct
 * decode ignores the extra key.
 */
export const RunSpecSchema = Schema.Struct({
  overrides: Schema.optional(AgentRunOverridesSchema),
})
export type RunSpec = typeof RunSpecSchema.Type

export const makeRunSpec = (input: RunSpec = {}): RunSpec => omitUndefined(input)

// Agent run depth

/**
 * Maximum session spawn depth. Derived from the persisted parent chain, where
 * only spawn edges count (a handoff keeps its parent's thread and depth); root
 * depth is 0, and a parent at depth 3 cannot spawn another child. Enforced in
 * one place, `admitChildSessionDepth` (`runtime/session.ts`), which the one
 * child writer calls: `SessionMutations.createSession` (a create with a
 * `parentSessionId` and no `continueThread`).
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
