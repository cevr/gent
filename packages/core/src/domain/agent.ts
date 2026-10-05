import { Effect, Option, Predicate, Schema, SchemaGetter, SchemaIssue, Struct } from "effect"
import { omitUndefined } from "./guards.js"
import { SessionId } from "./ids.js"

// ── model ───────────────────────────────────────────────────────────────────

// Model ID - provider/model format

export const ModelId = Schema.String.pipe(Schema.brand("ModelId"))
export type ModelId = typeof ModelId.Type

// Provider - AI provider identifier (open, branded string — extensible via extensions)

export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"))
export type ProviderId = typeof ProviderId.Type

// Model pricing per million tokens (USD)

export const ModelPricing = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  /** Input read from the prompt cache; priced as `input` when absent. */
  cacheRead: Schema.optional(Schema.Finite),
  /** Input written to the prompt cache; priced as `input` when absent. */
  cacheWrite: Schema.optional(Schema.Finite),
  /**
   * The price of a cache write by the lifetime of the entry it writes, for a
   * driver whose writes cost more the longer they live. A write the driver
   * splits by lifetime (`ModelDriverContribution.cacheWritesByLifetime`)
   * takes the rate of its lifetime; any other write takes `cacheWrite`.
   */
  cacheWriteByLifetime: Schema.optional(
    Schema.Array(Schema.Struct({ ttlMs: Schema.Finite, price: Schema.Finite })),
  ),
})
export type ModelPricing = typeof ModelPricing.Type

/** The input tokens one response wrote to cache entries of one lifetime. */
export interface CacheWriteByLifetime {
  readonly ttlMs: number
  readonly tokens: number
}

/**
 * How hard a model reasons, lowest first. `none` is no reasoning: a request
 * at `none` turns reasoning off where the model can, else asks for its
 * lowest effort.
 */
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

/**
 * The tool images one request may carry: how many, and how many base64
 * characters in all. A request past either leaves out its oldest images, a
 * fixed number at a time, so its prefix changes only when the count of left
 * out images does (`toolImagesToDrop` in `model-context.ts`).
 */
export const ImageLimit = Schema.Struct({
  images: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  base64Chars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type ImageLimit = typeof ImageLimit.Type

const PositiveCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * How a model counts the tokens of one image, as its API class says
 * (`imageTokens` in `model-context.ts`):
 * - `Pixels`: `width * height / pixelsPerToken`, with no cap (Anthropic).
 * - `Tiles`: OpenAI's tiles at the `high` detail: the image fit in 2048x2048,
 *   its short side cut to 768, then `baseTokens` and `tileTokens` for each
 *   512-pixel tile.
 * - `Patches`: OpenAI's 32-pixel patches, the image shrunk to `maxPatches`,
 *   each patch at `multiplier` tokens.
 */
export const ImageCost = Schema.TaggedUnion({
  Pixels: { pixelsPerToken: PositiveCount },
  Tiles: { baseTokens: PositiveCount, tileTokens: PositiveCount },
  Patches: { multiplier: Schema.Finite, maxPatches: PositiveCount },
})
export type ImageCost = typeof ImageCost.Type

/** Provider options an image part of a request carries, by provider (`Prompt.FilePart.options`). */
export const ImagePartOptions = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, Schema.Json),
)
export type ImagePartOptions = typeof ImagePartOptions.Type

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
  /**
   * The most output tokens one reply may carry, as the catalog says. The
   * output reserve is this up to 32k (`outputReserveTokens`); absent when the
   * catalog does not say.
   */
  outputLimit: Schema.optional(Schema.Finite),
  pricing: Schema.optional(ModelPricing),
  /** When the driver released the model; an ISO-8601 prefix: `2026-02-17` or `2025-04`. */
  releaseDate: Schema.optional(Schema.String),
  /** Whether the model reasons, as the catalog says; absent when it does not say. */
  reasoning: Schema.optional(Schema.Boolean),
  /**
   * The effort levels a request to the model names, lowest first, as its
   * driver plans them from the catalog: a hint between or past them goes to
   * one of them (`effectiveEffort`). Absent or empty when the model takes no
   * effort level (a thinking budget or an on/off toggle): the hint then
   * passes as it is.
   */
  efforts: Schema.optional(Schema.Array(ReasoningEffort)),
  /**
   * Whether the model reads images, as the catalog says (`modalities.input`).
   * False: a request sends a line in place of each tool image. Absent when
   * the catalog does not say: the request sends the images.
   */
  imageInput: Schema.optional(Schema.Boolean),
  /**
   * The tool images one request may carry, as the model's API class says
   * (`ApiClassContribution.imageLimit`). Absent: the default bound
   * (`toolImagesToDrop` in `model-context.ts`).
   */
  imageLimit: Schema.optional(ImageLimit),
  /**
   * What one tool image costs the model, as its API class says
   * (`ApiClassContribution.imageCost`). Absent: the highest of the known
   * costs, so an estimate never counts low.
   */
  imageCost: Schema.optional(ImageCost),
  /**
   * The provider options each image part of a request carries, as the
   * model's API class says (`ApiClassContribution.imagePartOptions`): the
   * detail its `imageCost` assumes, so the estimate and the request agree.
   */
  imagePartOptions: Schema.optional(ImagePartOptions),
  /**
   * How long the provider keeps a request's prompt cached after the request,
   * in milliseconds, as the model's driver says. A turn that starts on a large
   * window after it lapsed hands the window off first (`projectContextWindow`),
   * and the TUI's cache extension tells an expired cache from a changed
   * prefix by it. Absent when the driver names no lifetime: then neither
   * happens.
   */
  promptCacheTtlMs: Schema.optional(Schema.Finite),
  /**
   * The lifetime a spawned child session's requests ask for, when the driver
   * gives children a shorter one (`ProviderHints.child`); absent, a child's
   * requests keep `promptCacheTtlMs`. Read through `promptCacheTtlMsFor`.
   */
  childPromptCacheTtlMs: Schema.optional(Schema.Finite),
  /**
   * `classifier`: the model answers typed decisions (`effect/ai/Decision`)
   * through its driver's `resolveDecisionModel` and never runs a turn.
   * `virtual`: a model router's id (`router/auto`); each turn runs on the
   * concrete model the router picks (`ModelRouted`). Absent for a chat model.
   */
  kind: Schema.optional(Schema.Literals(["classifier", "virtual"])),
}) {}

/**
 * How long a request's prompt stays cached: the one reading of the two
 * catalog lifetimes, for the loop's cold handoff and the TUI's cache notice.
 */
export const promptCacheTtlMsFor = (
  model: Pick<Model, "promptCacheTtlMs" | "childPromptCacheTtlMs">,
  child: boolean,
): Option.Option<number> => {
  const own = Option.fromUndefinedOr(model.promptCacheTtlMs)
  if (!child) return own
  return Option.orElse(Option.fromUndefinedOr(model.childPromptCacheTtlMs), () => own)
}

/**
 * The level a request names for `level` when the model accepts `accepted`
 * (lowest first): the lowest accepted level at or above it, else the highest.
 * None when it accepts none.
 */
export const clampEffort = (
  accepted: ReadonlyArray<ReasoningEffort>,
  level: ReasoningEffort,
): Option.Option<ReasoningEffort> => {
  const order = ReasoningEffort.literals
  const rank = order.indexOf(level)
  return Option.fromUndefinedOr(accepted.find((each) => order.indexOf(each) >= rank)).pipe(
    Option.orElse(() => Option.fromUndefinedOr(accepted.at(-1))),
  )
}

/**
 * The effort a request to `model` sends for the hint `level`: none for a
 * model the catalog says does not reason, the hint itself for a model that
 * takes no effort level, else the clamped level (`clampEffort`). The one
 * reading for the step's receipt (`StreamEnded.reasoningLevel`), the drivers'
 * request plans, and the level a client shows.
 */
export const effectiveEffort = (
  model: Pick<Model, "reasoning" | "efforts">,
  level: ReasoningEffort,
): Option.Option<ReasoningEffort> => {
  if (model.reasoning === false) return Option.none()
  const accepted = model.efforts ?? []
  if (accepted.length === 0) return Option.some(level)
  return clampEffort(accepted, level)
}

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
 * The $/M price of a cache write whose entry lives `ttlMs`: the catalog's
 * rate for that lifetime, else `cacheWrite`, else `input`. The one reading
 * of the write rate, for step cost and the TUI's cache-miss cost.
 */
export const cacheWriteRate = (pricing: ModelPricing, ttlMs: Option.Option<number>): number => {
  const byLifetime = Option.flatMap(ttlMs, (lifetime) =>
    Option.fromUndefinedOr(
      (pricing.cacheWriteByLifetime ?? []).find((entry) => entry.ttlMs === lifetime),
    ),
  )
  return Option.match(byLifetime, {
    onSome: (entry) => entry.price,
    onNone: () => pricing.cacheWrite ?? pricing.input,
  })
}

/**
 * The USD cost of one step. `inputTokens` counts every input token, cached or
 * not; the tokens read from or written to the prompt cache take their own
 * price when the catalog has one. The part of the cache writes the driver
 * splits by lifetime (`cacheWritesByLifetime`) takes the rate the catalog
 * names for that lifetime; the rest takes `cacheWrite`.
 */
export const calculateCost = (
  usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
    readonly cacheWritesByLifetime?: ReadonlyArray<CacheWriteByLifetime>
  },
  pricing: Option.Option<ModelPricing>,
): number => {
  if (Option.isNone(pricing)) return 0
  const price = pricing.value
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const uncached = Math.max(0, usage.inputTokens - cacheRead - cacheWrite)
  const splitWrites = usage.cacheWritesByLifetime ?? []
  const splitTokens = splitWrites.reduce((sum, write) => sum + write.tokens, 0)
  const otherWrites = Math.max(0, cacheWrite - splitTokens)
  const inputCost =
    uncached * price.input +
    cacheRead * (price.cacheRead ?? price.input) +
    splitWrites.reduce(
      (sum, write) => sum + write.tokens * cacheWriteRate(price, Option.some(write.ttlMs)),
      0,
    ) +
    otherWrites * cacheWriteRate(price, Option.none())
  return (inputCost + usage.outputTokens * price.output) / 1_000_000
}

export const parseModelId = (modelId: string): Option.Option<readonly [ProviderId, string]> => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return Option.none()
  return Option.some([ProviderId.make(modelId.slice(0, slash)), modelId.slice(slash + 1)])
}

// ── agent ───────────────────────────────────────────────────────────────────

// Agent definitions

export const AgentName = Schema.String.pipe(Schema.brand("AgentName"))
export type AgentName = typeof AgentName.Type

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

// ── tools and paths ─────────────────────────────────────────────────────────

/** `text` with every regular-expression metacharacter escaped. */
const escapeRegExp = (text: string): string => text.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")

/**
 * One tool pattern as a matcher of the whole id: `*` is any run of
 * characters, dots too (so `*` is every tool and `film.*` every `film.` tool
 * at any depth), and every other character matches itself.
 */
const patternMatcher = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`)

/**
 * Whether ordered tool patterns admit the tool `id`. The last pattern that
 * matches decides: a plain pattern admits, a `!` pattern takes back. A tool
 * no pattern matches is left out; absent patterns admit every tool.
 */
const toolPatternsAdmit = (patterns: Option.Option<ReadonlyArray<string>>, id: string): boolean =>
  Option.match(patterns, {
    onNone: () => true,
    onSome: (list) =>
      list.reduce((admitted, pattern) => {
        const negated = pattern.startsWith("!")
        const body = pattern.slice(Number(negated))
        if (patternMatcher(body).test(id)) return !negated
        return admitted
      }, false),
  })

/** What an agent may do under a path: `write` includes `read`. */
const AgentPathAccess = Schema.Literals(["read", "write"])

/** One `paths` entry with its access spelled out. */
const AgentPathEntry = Schema.Struct({ path: Schema.String, access: AgentPathAccess })

/**
 * One folder or file the shipped file tools confine an agent to, relative to
 * the session cwd: `{ path, access }`, where `access` absent is `write`, or a
 * bare string, a `write` entry. Both decode to the entry with its access;
 * the entry encodes as the object.
 */
const AgentPath = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    access: AgentPathAccess.pipe(Schema.withDecodingDefaultKey(Effect.succeed("write" as const))),
  }),
  Schema.String.pipe(
    Schema.decodeTo(Schema.toType(AgentPathEntry), {
      decode: SchemaGetter.transform((path: string) => ({ path, access: "write" as const })),
      encode: SchemaGetter.transform((entry: AgentPathEntry) => entry.path),
    }),
  ),
])

/** One `paths` entry as resolution reads it: the path as written and its access. */
export type AgentPathEntry = typeof AgentPathEntry.Type

/**
 * Whether `scope` reaches `entry`: one of its entries holds the entry's path
 * (`within(inner, outer)`) with at least the entry's access, `write` holding
 * `read`. The caller resolves both sides first (absolute, links followed):
 * the file tools before each call, a session create before it admits a run.
 */
export const scopeReaches = (
  scope: ReadonlyArray<AgentPathEntry>,
  entry: AgentPathEntry,
  within: (inner: string, outer: string) => boolean,
): boolean =>
  scope.some(
    (outer) =>
      (entry.access === "read" || outer.access === "write") && within(entry.path, outer.path),
  )

/** One scope a session's file tool calls must lie in: `paths` entries and the cwd they resolve against. */
export interface PathScope {
  readonly cwd: string
  readonly entries: ReadonlyArray<AgentPathEntry>
}

/**
 * What a session's run may do, as resolution finds it (`bindSessionAgent`):
 * tool pattern lists a tool must pass, every one, and path scopes a file
 * tool call must lie in, every one. The agent's own `tools` and `paths`, the
 * run's, and those of every parent run it was spawned under. Not a field of
 * any definition: a run only narrows its agent, and a child its parent.
 */
export interface RunBound {
  readonly tools: ReadonlyArray<ReadonlyArray<string>>
  readonly paths: ReadonlyArray<PathScope>
}

/** The bound of a session with no parent run. */
export const noRunBound: RunBound = { tools: [], paths: [] }

// ── agent definition ────────────────────────────────────────────────────────

/** The fields of `AgentDefinition`. */
const agentDefinitionFields = {
  name: AgentName,
  description: Schema.optional(Schema.String),
  model: Schema.optional(ModelId),
  systemPromptAddendum: Schema.optional(Schema.String),
  /**
   * Ordered tool patterns: the tools the agent's turns hold. The last
   * pattern that matches a tool id decides; `!` takes a tool back; `*` is
   * any run of characters, dots included. Absent: every tool. Availability
   * only: a held tool still asks the user where it asks (`admitsTool`).
   */
  tools: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The folders the shipped file tools (`read`, `write`, `edit`, `grep`)
   * confine the agent to, relative to the session cwd. `read` and `grep`
   * take any entry, `write` and `edit` only `write` entries. Absent: no
   * confinement. Not a sandbox: the cell and bash are not confined.
   */
  paths: Schema.optional(Schema.Array(AgentPath)),
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
}

/** What `new AgentDefinition` and its static constructors take. */
type AgentDefinitionInput = Schema.Struct.MakeIn<typeof agentDefinitionFields>

/**
 * Why an agent's input is refused: the keys the schema does not name, read
 * before a constructor parses them away. `None` when every key is named.
 */
const refusedAgentKeys = (input: AgentDefinitionInput): Option.Option<string> => {
  const unknown = Object.keys(input).filter((key) => !Object.hasOwn(agentDefinitionFields, key))
  if (unknown.length === 0) return Option.none()
  return Option.some(
    `AgentDefinition "${input.name}" has keys the schema does not name: ${unknown.join(", ")}. Tool lists are \`tools\` patterns: allowedTools [a, b] is tools [a, b]; deniedTools [x] is tools ["*", "!x"].`,
  )
}

/**
 * AgentDefinition — agent identity + defaults.
 *
 * Per `composability-not-flags`, agent specs carry only what makes the agent
 * what it is: name, description, model, prompt, tool patterns, the paths
 * its file tools may touch, sampling defaults, and driver routing. One
 * schema, written two ways: TS through `host.register("agent",
 * AgentDefinition.make(...))`, and JSON in a config file's `agents` key, an
 * `AgentPatch` by name that creates an agent or reshapes a registered one
 * (`resolveAgentRoster`). Per-run overrides are a part of the same patch, on
 * `RunSpec`; their `tools` and `paths` only narrow the agent (`SessionAgent`).
 * A config entry keeps the keys its author wrote (`AuthoredAgentPatch`);
 * stored rows and the wire also carry the old keys, for an older gent
 * (`StoredRunOverrides`, `StoredAgentDefinition`). A `delegate.start` call
 * sends the new keys only (`RunOverrides`).
 */
export class AgentDefinition extends Schema.Class<AgentDefinition>("AgentDefinition")(
  agentDefinitionFields,
) {
  /**
   * Builds an agent and refuses a key the schema does not name. The schema
   * would drop such a key, so an extension written before `tools`
   * (`allowedTools`, `deniedTools`) or with a misspelled field would run
   * with every tool; it fails where it builds the agent instead. Every
   * authoring constructor asks `refusedAgentKeys` before it parses: `new`
   * and `make` throw, `makeEffect` fails with the same message, `makeOption`
   * is `None`. A decode (stored rows, the wire) passes only named keys.
   */
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off -- the check refuses only keys the schema does not name, and a decode passes only named keys; `new` must be as strict as `make`.
  constructor(props: AgentDefinitionInput, options?: Schema.MakeOptions) {
    const refused = refusedAgentKeys(props)
    if (Option.isSome(refused)) {
      // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- A definition with a key the schema drops is programmer misuse; it must fail where the extension builds it.
      throw new Error(refused.value)
    }
    super(props, options)
  }

  static override make(input: AgentDefinitionInput, options?: Schema.MakeOptions): AgentDefinition {
    return new AgentDefinition(input, options)
  }

  static override makeEffect(
    input: AgentDefinitionInput,
    options?: Schema.MakeOptions,
  ): Effect.Effect<AgentDefinition, SchemaIssue.Issue> {
    return Option.match(refusedAgentKeys(input), {
      onSome: (message) => Effect.fail(new SchemaIssue.InvalidValue({ message }, input)),
      onNone: () => super.makeEffect(input, options),
    })
  }

  static override makeOption(
    input: AgentDefinitionInput,
    options?: Schema.MakeOptions,
  ): Option.Option<AgentDefinition> {
    if (Option.isSome(refusedAgentKeys(input))) return Option.none()
    return super.makeOption(input, options)
  }

  /**
   * Whether a turn of this agent holds the tool `id` (`toolPatternsAdmit`
   * over `tools`). The patterns are authoritative: no extension adds a tool
   * they leave out (`compileToolPolicy`). An extension that selects or
   * describes its own tool asks this first. A session's agent is a
   * `SessionAgent`, whose answer is its run's whole bound.
   */
  admitsTool(id: string): boolean {
    return toolPatternsAdmit(Option.fromUndefinedOr(this.tools), id)
  }
}

/**
 * The agent one session runs as: its definition (config entries and the
 * run's model, effort, limits and addendum applied) with the run's bound
 * (`RunBound`). A turn, its hooks and `Session.getAgent` get this one, so
 * `admitsTool` and `pathScopes` answer for the run, not the definition. It
 * is a resolution result, never a definition: no author builds one, and the
 * wire codec of a definition refuses it (`StoredAgentDefinition`). Spread
 * into `AgentDefinition.make`, its `bound` key is refused.
 */
export class SessionAgent extends AgentDefinition {
  readonly bound: RunBound

  // @effect-diagnostics-next-line overriddenSchemaConstructor:off -- a run agent is built only by `bindSessionAgent`, from a definition that already parsed.
  constructor(definition: AgentDefinition, bound: RunBound) {
    super({ ...definition })
    this.bound = bound
  }

  /** Every tool pattern list of the run admits `id`. */
  override admitsTool(id: string): boolean {
    return this.bound.tools.every((patterns) => toolPatternsAdmit(Option.some(patterns), id))
  }

  /**
   * The scopes a file tool call must lie in, each with the cwd its entries
   * resolve against. A call is in reach when every scope reaches it
   * (`scopeReaches`); no scope, every path is.
   */
  pathScopes(): ReadonlyArray<PathScope> {
    return this.bound.paths
  }
}

/**
 * An agent's fields but `name`, each optional (every field but `name` is
 * optional already): what a config `agents` entry and a run's overrides
 * write. A config entry replaces each field it names (`mergeAgentPatches`);
 * a run's `tools` and `paths` narrow instead (`bindSessionAgent`).
 */
const AgentPatch = Schema.Struct(Struct.omit(agentDefinitionFields, ["name"]))
type AgentPatch = typeof AgentPatch.Type

// ── old tool lists ──────────────────────────────────────────────────────────

/**
 * What an old patch's tool lists did to the tools of the agent it landed on,
 * where one list alone did not replace them. `Deny` (a `deniedTools` list
 * alone) takes the ids away from the inherited tools. `Allow` (an
 * `allowedTools` list alone) replaces them with the ids and keeps the
 * inherited denials, less its own `denied` (from a later deny list). Both
 * lists together replace the tools, so they decode into `tools`. Internal to
 * the stored codecs and the merge: no author writes it.
 */
const LegacyToolEdit = Schema.TaggedUnion({
  Deny: { denied: Schema.Array(Schema.String) },
  Allow: { allowed: Schema.Array(Schema.String), denied: Schema.Array(Schema.String) },
})
type LegacyToolEdit = typeof LegacyToolEdit.Type

const negated = (ids: ReadonlyArray<string>): ReadonlyArray<string> => ids.map((id) => `!${id}`)

/** The tools an old edit leaves on an agent whose patterns are `inherited`. */
const applyLegacyToolEdit = (
  inherited: Option.Option<ReadonlyArray<string>>,
  edit: LegacyToolEdit,
): ReadonlyArray<string> =>
  LegacyToolEdit.match(edit, {
    Deny: ({ denied }) => [...Option.getOrElse(inherited, () => ["*"]), ...negated(denied)],
    Allow: ({ allowed, denied }) => [
      ...allowed,
      ...Option.getOrElse(inherited, () => []).filter((pattern) => pattern.startsWith("!")),
      ...negated(denied),
    ],
  })

/** `first` then `second` as one edit: what applying both in turn leaves. */
const composeLegacyToolEdits = (first: LegacyToolEdit, second: LegacyToolEdit): LegacyToolEdit =>
  LegacyToolEdit.match(second, {
    Deny: ({ denied }) =>
      LegacyToolEdit.match(first, {
        Deny: (edit): LegacyToolEdit =>
          LegacyToolEdit.cases.Deny.make({ denied: [...edit.denied, ...denied] }),
        Allow: (edit): LegacyToolEdit =>
          LegacyToolEdit.cases.Allow.make({
            allowed: edit.allowed,
            denied: [...edit.denied, ...denied],
          }),
      }),
    Allow: ({ allowed, denied }) =>
      LegacyToolEdit.cases.Allow.make({ allowed, denied: [...first.denied, ...denied] }),
  })

/**
 * The two lists an older gent reads for `patterns`, when they say the same:
 * plain ids are an allow list, `"*"` then negated ids a deny list, and plain
 * ids then negated ids both. Any other wildcard or order cannot be said in
 * two lists: it is an empty allow list, so an older reader holds no tool
 * rather than every tool.
 */
interface LegacyToolLists {
  readonly allowedTools?: ReadonlyArray<string>
  readonly deniedTools?: ReadonlyArray<string>
}

const legacyToolLists = (patterns: ReadonlyArray<string>): LegacyToolLists => {
  const plain = (pattern: string) => !pattern.includes("*") && !pattern.startsWith("!")
  const denial = (pattern: string) => pattern.startsWith("!") && plain(pattern.slice(1))
  const ids = (denials: ReadonlyArray<string>) => denials.map((pattern) => pattern.slice(1))
  if (patterns[0] === "*" && patterns.slice(1).every(denial)) {
    return { deniedTools: ids(patterns.slice(1)) }
  }
  let split = patterns.findIndex((pattern) => !plain(pattern))
  if (split < 0) split = patterns.length
  const rest = patterns.slice(split)
  if (!rest.every(denial)) return { allowedTools: [] }
  if (rest.length === 0) return { allowedTools: patterns }
  return { allowedTools: patterns.slice(0, split), deniedTools: ids(rest) }
}

// ── stored agents ───────────────────────────────────────────────────────────

/**
 * The keys a stored or sent agent carried before `tools`: the two tool
 * lists, and `modelId`, a run override's name for `model`.
 */
const LegacyAgentKeys = {
  modelId: Schema.optional(ModelId).annotate({ description: "Older name of `model`." }),
  allowedTools: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Older form of `tools`: exactly these tool ids.",
  }),
  deniedTools: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Older form of `tools`: every tool the agent holds but these ids.",
  }),
}

/** A patch as stored rows, config files and old clients carry it. */
const StoredPatchFields = Schema.Struct({ ...AgentPatch.fields, ...LegacyAgentKeys })
type StoredPatchFields = typeof StoredPatchFields.Type

/** A patch as resolution reads it: its fields, and the edit of old tool lists. */
const PatchFields = Schema.Struct({
  ...AgentPatch.fields,
  legacyTools: Schema.optional(LegacyToolEdit),
})
export type StoredAgentPatch = typeof PatchFields.Type

/**
 * Read a stored patch. New keys win: `tools` over the two lists, `model` over
 * `modelId`. Both lists together are `tools`; one list alone is a
 * `LegacyToolEdit`, applied to the tools the patch lands on.
 */
const readStoredPatch = (stored: StoredPatchFields): StoredAgentPatch => {
  const { modelId, allowedTools, deniedTools, ...patch } = stored
  const model = Option.orElse(Option.fromUndefinedOr(patch.model), () =>
    Option.fromUndefinedOr(modelId),
  )
  const allowed = Option.fromUndefinedOr(allowedTools)
  const denied = Option.fromUndefinedOr(deniedTools)
  const tools: Pick<StoredAgentPatch, "tools" | "legacyTools"> = Option.match(
    Option.fromUndefinedOr(patch.tools),
    {
      onSome: (patterns) => ({ tools: patterns }),
      onNone: () => {
        if (Option.isSome(allowed) && Option.isSome(denied)) {
          return { tools: [...allowed.value, ...negated(denied.value)] }
        }
        if (Option.isSome(allowed)) {
          return {
            legacyTools: LegacyToolEdit.cases.Allow.make({ allowed: allowed.value, denied: [] }),
          }
        }
        if (Option.isSome(denied)) {
          return { legacyTools: LegacyToolEdit.cases.Deny.make({ denied: denied.value }) }
        }
        return {}
      },
    },
  )
  return omitUndefined({ ...patch, model: Option.getOrUndefined(model), ...tools })
}

/**
 * Write a patch so an older gent reads it too. Every key is additive: `model`
 * goes out under `model` and `modelId`; `tools` goes out with the two lists
 * that say the same (`legacyToolLists`), or an empty allow list where they
 * cannot, so an older reader never holds more tools than the patterns. An
 * old edit goes back out as the list it was read from. `paths` has no older
 * form: an older reader ignores it, and it is no sandbox.
 */
const writeStoredPatch = (patch: StoredAgentPatch): StoredPatchFields => {
  const { legacyTools, ...fields } = patch
  const lists = Option.match(Option.fromUndefinedOr(fields.tools), {
    onSome: legacyToolLists,
    onNone: () => editLists(Option.fromUndefinedOr(legacyTools)),
  })
  return omitUndefined({ ...fields, modelId: fields.model, ...lists })
}

/** An old edit as the list it was read from. */
const editLists = (edit: Option.Option<LegacyToolEdit>): LegacyToolLists =>
  Option.match(edit, {
    onNone: (): LegacyToolLists => ({}),
    onSome: (some) =>
      LegacyToolEdit.match(some, {
        Deny: ({ denied }): LegacyToolLists => ({ deniedTools: denied }),
        // The previous reader keeps the inherited denials of an allow
        // list alone; the edit's own denials leave the list.
        Allow: ({ allowed, denied }): LegacyToolLists => ({
          allowedTools: allowed.filter((id) => !denied.includes(id)),
        }),
      }),
  })

/**
 * Write a config entry as its author wrote it: the new keys, and an old list
 * only where the entry held one. A config file is the user's, not a row an
 * older gent reads, so it gets none of the keys `writeStoredPatch` adds.
 */
const writeAuthoredPatch = (patch: StoredAgentPatch): StoredPatchFields => {
  const { legacyTools, ...fields } = patch
  return omitUndefined({ ...fields, ...editLists(Option.fromUndefinedOr(legacyTools)) })
}

/** Agent field names a config entry may write: the patch fields and the old keys. */
const authoredKeys: ReadonlySet<string> = new Set(Object.keys(StoredPatchFields.fields))

/**
 * A config `agents` entry: read as a stored patch, old keys included, but a
 * key it does not name fails, since a misspelled field would leave an agent
 * with every tool. The error names the entry and the key. It writes back
 * the keys its author used (`writeAuthoredPatch`).
 */
export const AuthoredAgentPatch = Schema.StructWithRest(StoredPatchFields, [
  Schema.Record(
    Schema.String.check(Schema.makeFilter((key: string) => !authoredKeys.has(key))),
    Schema.Unknown.check(Schema.makeFilter(() => false, { message: "is not an agent field" })),
  ),
]).pipe(
  Schema.decodeTo(Schema.toType(PatchFields), {
    decode: SchemaGetter.transform(readStoredPatch),
    encode: SchemaGetter.transform(writeAuthoredPatch),
  }),
)

/** The fields a run may override: the ones a model picks for one task. */
const RUN_OVERRIDE_KEYS = [
  "model",
  "tools",
  "paths",
  "reasoningEffort",
  "contextLength",
  "maxSteps",
  "maxModelAttempts",
  "systemPromptAddendum",
] as const

/**
 * A run's overrides as `RunSpec` stores them (`sessions.admission_json`):
 * the run fields of a stored patch, through `readStoredPatch` and
 * `writeStoredPatch`, so an old row keeps its meaning and an older gent
 * reads a new one. A caller writes them as `RunOverrides`.
 */
const StoredRunOverrides = StoredPatchFields.mapFields(
  Struct.pick([...RUN_OVERRIDE_KEYS, "modelId", "allowedTools", "deniedTools"] as const),
).pipe(
  Schema.decodeTo(
    Schema.toType(
      PatchFields.mapFields(Struct.pick([...RUN_OVERRIDE_KEYS, "legacyTools"] as const)),
    ),
    {
      decode: SchemaGetter.transform(readStoredPatch),
      encode: SchemaGetter.transform(writeStoredPatch),
    },
  ),
)

const RunFields = AgentPatch.mapFields(Struct.pick(RUN_OVERRIDE_KEYS))
const runKeys: ReadonlySet<string> = new Set(RUN_OVERRIDE_KEYS)

/** What replaced each old run key, for the failure that refuses it. */
const replacedRunKeys = new Map([
  ["modelId", "model"],
  ["allowedTools", 'tools, ordered patterns such as ["read", "grep"]'],
  ["deniedTools", 'tools, ordered patterns such as ["*", "!bash"]'],
])

/** The run fields, and any other key, kept for the decode to refuse. */
const RunOverridesInput = Schema.StructWithRest(RunFields, [
  Schema.Record(
    Schema.String.check(Schema.makeFilter((key: string) => !runKeys.has(key))),
    Schema.Unknown,
  ),
])

/** One line for each key of `input` that is not a run field. */
const refusedRunKeys = (input: typeof RunOverridesInput.Type): ReadonlyArray<string> =>
  Object.keys(input)
    .filter((key) => !runKeys.has(key))
    .map((key) =>
      Option.match(Option.fromUndefinedOr(replacedRunKeys.get(key)), {
        onSome: (replacement) => `${key} is gone: use ${replacement}`,
        onNone: () => `${key} is not a run override`,
      }),
    )

/**
 * A run's overrides as a caller writes them (`delegate.start`): the new keys
 * only, so the schema a model reads names nothing else. A call with another
 * key fails, and the failure names it and, for an old key (`modelId`,
 * `allowedTools`, `deniedTools`), the key that replaced it. A dropped key
 * could give the child more than the caller asked, so none is dropped. The
 * refusal is in the decode, not in the encoded form: a model's call decodes
 * its encoded form as it streams, and the tool runner reports the decode
 * failure to the model. The run spec stores the result through
 * `StoredRunOverrides`.
 */
export const RunOverrides = RunOverridesInput.pipe(
  Schema.decodeTo(Schema.toType(RunFields), {
    decode: SchemaGetter.transformEffect((input) => {
      const refused = refusedRunKeys(input)
      if (refused.length === 0) return Effect.succeed(input)
      return Effect.fail(new SchemaIssue.InvalidValue({ message: refused.join("; ") }, input))
    }),
    encode: SchemaGetter.transform((overrides) => overrides),
  }),
)

// ── agent resolution ────────────────────────────────────────────────────────

/**
 * `first` then `second`: each field `second` names replaces the one in
 * `first`, except `systemPromptAddendum`, which appends after a blank line,
 * since an addendum adds to the agent's own prompt, and an old tool edit,
 * which applies to the tools `first` leaves. User then project config
 * entries merge this way: they are the author's own edits. A run's
 * overrides merge this way too, but for `tools` and `paths`
 * (`resolveSessionAgent`, `bindSessionAgent`).
 */
export const mergeAgentPatches = (
  first: StoredAgentPatch,
  second: StoredAgentPatch,
): StoredAgentPatch => {
  const addenda = [first.systemPromptAddendum, second.systemPromptAddendum].filter(
    Predicate.isString,
  )
  return {
    ...Struct.omit(first, ["tools", "legacyTools"]),
    ...omitUndefined(Struct.omit(second, ["tools", "legacyTools"])),
    ...mergeTools(first, second),
    ...(addenda.length > 0 && { systemPromptAddendum: addenda.join("\n\n") }),
  }
}

/** The tools `second` leaves over `first`: new patterns replace, an old edit applies. */
const mergeTools = (
  first: StoredAgentPatch,
  second: StoredAgentPatch,
): Pick<StoredAgentPatch, "tools" | "legacyTools"> => {
  if (Predicate.isNotUndefined(second.tools)) return { tools: second.tools }
  return Option.match(Option.fromUndefinedOr(second.legacyTools), {
    onNone: () => omitUndefined({ tools: first.tools, legacyTools: first.legacyTools }),
    onSome: (edit) =>
      Option.match(Option.fromUndefinedOr(first.tools), {
        onSome: (patterns) => ({ tools: applyLegacyToolEdit(Option.some(patterns), edit) }),
        onNone: () => ({
          legacyTools: Option.match(Option.fromUndefinedOr(first.legacyTools), {
            onNone: () => edit,
            onSome: (earlier) => composeLegacyToolEdits(earlier, edit),
          }),
        }),
      }),
  })
}

/** The agent `name` that `patch` describes; an old tool edit applies to every tool. */
const agentFromPatch = (name: AgentName, patch: StoredAgentPatch): AgentDefinition => {
  const { legacyTools, ...fields } = patch
  const tools = Option.match(Option.fromUndefinedOr(legacyTools), {
    onNone: () => fields.tools,
    onSome: (edit) => applyLegacyToolEdit(Option.none(), edit),
  })
  return AgentDefinition.make({ ...fields, tools, name })
}

/** `agent` reshaped by `patch` as `mergeAgentPatches` merges a config entry. */
const applyAgentPatch = (agent: AgentDefinition, patch: StoredAgentPatch): AgentDefinition =>
  agentFromPatch(agent.name, mergeAgentPatches({ ...agent }, patch))

/**
 * The definition a session's run reshapes: `name` from the roster
 * (`resolveAgentRoster`) with the run overrides' model, effort, limits and
 * addendum applied as a config entry applies them; none when no agent has
 * the name. The run's `tools` and `paths` are not applied: they narrow, in
 * `bindSessionAgent`. This answers routing (model, driver); authority is the
 * bound agent's.
 */
export const resolveSessionAgent = (params: {
  readonly agents: Iterable<AgentDefinition>
  readonly configAgents: Option.Option<Readonly<Record<AgentName, StoredAgentPatch>>>
  readonly name: AgentName
  readonly overrides: Option.Option<StoredAgentPatch>
}): Option.Option<AgentDefinition> =>
  Option.map(
    Option.fromUndefinedOr(resolveAgentRoster(params.agents, params.configAgents).get(params.name)),
    (agent) =>
      Option.match(params.overrides, {
        onNone: () => agent,
        onSome: ({ tools: _tools, legacyTools: _legacy, paths: _paths, ...fields }) =>
          applyAgentPatch(agent, fields),
      }),
  )

/**
 * `definition` as one session's run, in `cwd`, spawned under a run whose
 * bound is `parent` (`noRunBound` for none). The definition is the bound
 * its author set, and a run only narrows it (least authority): the run's
 * `tools` patterns are one more list a tool must pass, so `["*"]` holds
 * what the agent holds; its `paths` are one more scope; an old tool edit
 * narrows as the patterns it gives every tool. A child never exceeds its
 * parent: the parent's lists and scopes come after, each scope with its
 * own cwd.
 */
export const bindSessionAgent = (
  definition: AgentDefinition,
  params: {
    readonly overrides: Option.Option<StoredAgentPatch>
    readonly cwd: string
    readonly parent: RunBound
  },
): SessionAgent => {
  const run = Option.getOrElse(params.overrides, (): StoredAgentPatch => ({}))
  const runTools = Option.orElse(Option.fromUndefinedOr(run.tools), () =>
    Option.map(Option.fromUndefinedOr(run.legacyTools), (edit) =>
      applyLegacyToolEdit(Option.none(), edit),
    ),
  )
  const scope = (entries: Option.Option<ReadonlyArray<AgentPathEntry>>) =>
    Option.map(entries, (some): PathScope => ({ cwd: params.cwd, entries: some }))
  return new SessionAgent(definition, {
    tools: [
      ...Option.toArray(Option.fromUndefinedOr(definition.tools)),
      ...Option.toArray(runTools),
      ...params.parent.tools,
    ],
    paths: [
      ...Option.toArray(scope(Option.fromUndefinedOr(definition.paths))),
      ...Option.toArray(scope(Option.fromUndefinedOr(run.paths))),
      ...params.parent.paths,
    ],
  })
}

/**
 * The agents a session can run as: each extension agent with the config
 * entry of its name applied, and each entry that names no extension agent
 * as a new agent. The config entries come merged, user then project
 * (`mergeAgentPatches`), so a field resolves project > user > extension.
 */
export const resolveAgentRoster = (
  agents: Iterable<AgentDefinition>,
  configAgents: Option.Option<Readonly<Record<AgentName, StoredAgentPatch>>>,
): ReadonlyMap<AgentName, AgentDefinition> => {
  const roster = new Map<AgentName, AgentDefinition>()
  for (const agent of agents) roster.set(agent.name, agent)
  const entries = Option.getOrElse(configAgents, () => ({}))
  for (const [key, patch] of Object.entries(entries)) {
    const name = AgentName.make(key)
    const agent = Option.match(Option.fromUndefinedOr(roster.get(name)), {
      onNone: () => agentFromPatch(name, patch),
      onSome: (registered) => applyAgentPatch(registered, patch),
    })
    roster.set(name, agent)
  }
  return roster
}

/**
 * An agent as the wire sends it: the definition, and the two tool lists an
 * older client reads (`writeStoredPatch`). An old definition's lists read
 * into `tools`; a definition inherits nothing, so one list alone applies to
 * every tool.
 */
export const StoredAgentDefinition = Schema.Struct({
  ...StoredPatchFields.fields,
  name: AgentName,
}).pipe(
  Schema.decodeTo(Schema.toType(AgentDefinition), {
    decode: SchemaGetter.transform(
      ({ name, ...stored }: StoredPatchFields & { readonly name: AgentName }) =>
        agentFromPatch(name, readStoredPatch(stored)),
    ),
    // Only definitions go out. A run agent's bound would not survive the
    // trip, and a client would read a wider agent, so it is refused.
    encode: SchemaGetter.transformEffect((agent: AgentDefinition) => {
      // A definition never holds `bound`: its constructors refuse the key.
      if (Predicate.hasProperty(agent, "bound")) {
        return Effect.fail(
          new SchemaIssue.InvalidValue(
            { message: `"${agent.name}" is a session's run agent, not a definition` },
            agent,
          ),
        )
      }
      return Effect.succeed({ ...writeStoredPatch({ ...agent }), name: agent.name })
    }),
  }),
)

// Default model — used when an agent has no model set
export const DEFAULT_MODEL_ID = ModelId.make("anthropic/claude-sonnet-5")

/** Resolve model for an agent definition */
export const resolveAgentModel = (agent: AgentDefinition): ModelId =>
  agent.model ?? DEFAULT_MODEL_ID

// ── driver routing ──────────────────────────────────────────────────────────

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

// ── run spec ────────────────────────────────────────────────────────────────

// Per-run dispatch configuration.
//
// Separates per-run concerns from agent identity: `overrides` reshape the
// agent's model, tools and prompt for every turn of the session.
//
// Every child is a durable session driven by the same loop as its parent.

/**
 * Rows written before `parentToolCallId` was dropped still carry it; a struct
 * decode ignores the extra key. Overrides go through `StoredRunOverrides`,
 * which reads rows written before `tools` and writes rows an older gent reads.
 */
export const RunSpecSchema = Schema.Struct({
  overrides: Schema.optional(StoredRunOverrides),
})
export type RunSpec = typeof RunSpecSchema.Type

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

/**
 * A session create asked for a run `paths` entry its agent does not reach,
 * or, for a child, one its parent run does not reach. The whole run is
 * refused: a dropped entry would change what the run means.
 */
export class RunPathRefusedError extends Schema.TaggedError<RunPathRefusedError>()(
  "RunPathRefusedError",
  {
    message: Schema.String,
    path: Schema.String,
    access: AgentPathAccess,
  },
) {}

/**
 * The bound of a spawned session's parent run cannot be resolved: the
 * parent row cannot be read, its agent is gone from its roster, or its
 * config does not load. A child is bounded by its parent run, so it fails
 * closed: its create is refused, and its turns and file calls do not run.
 */
export class ParentBoundError extends Schema.TaggedError<ParentBoundError>()("ParentBoundError", {
  message: Schema.String,
  parentSessionId: SessionId,
  agent: Schema.optional(AgentName),
}) {}

/**
 * The agent a session runs as cannot be resolved: the session cannot be
 * read, or its agent is gone from its roster. Its run's bound is unknown,
 * so it fails closed: a file call is refused, never read as unbounded.
 */
export class SessionAgentError extends Schema.TaggedError<SessionAgentError>()(
  "SessionAgentError",
  {
    message: Schema.String,
    sessionId: SessionId,
    agent: Schema.optional(AgentName),
  },
) {}

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
