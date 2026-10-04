import { Effect, FileSystem, Option, Path, Predicate, Result, Schema } from "effect"
import { Decision } from "effect/ai"
import {
  cacheWriteRate,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionServiceError,
  headChars,
  headTailChars,
  isProjectTrusted,
  type Message,
  messagePartsDisplayText,
  type Model,
  ModelId,
  type ModelRouteCurrent,
  type ModelRouteDecision,
  type ModelRouteInput,
  type ModelRouterContribution,
  omitUndefined,
  promptCacheTtlMsFor,
  ReasoningEffort,
  tailChars,
  type VirtualModel,
  type VirtualModelProblem,
} from "@gent/core/extensions/api"

/*
 * @gent/router: virtual models the owner writes as JSON. Each entry of
 * `routers` in `~/.gent/config.json` (and in a trusted project's
 * `.gent/config.json`, whose entries shadow the user's by name) serves
 * `router/<name>`, selectable wherever a model id goes:
 *
 *   "routers": {
 *     "auto": {
 *       "label": "Auto",
 *       "choices": [
 *         { "model": "anthropic/claude-haiku-4-5", "reason": "quick questions and small edits", "default": true },
 *         { "model": "anthropic/claude-sonnet-5", "reason": "difficult work: design, debugging, long changes" }
 *       ]
 *     }
 *   }
 *
 * Core routes each turn once, before its first request, and records the
 * pick. This router asks one classifier (the entry's `classifier`, else the
 * cheapest System One decision model with a credential) which choice's
 * `reason` fits the user's latest request, then holds a warm model unless
 * the switch pays: a stronger choice needs the classifier's confidence, a
 * cheaper one must save more than rewriting the prompt cache on it costs.
 */

// ── config ──────────────────────────────────────────────────────────────────

/** The router id: the provider segment of every virtual model this extension serves. */
const ROUTER_ID = "router"

const ChoiceConfig = Schema.Struct({
  /** Absent: the choice keeps the model the branch runs on and sets only `effort`. */
  model: Schema.optional(ModelId),
  /** When the choice fits; the classifier reads it. */
  reason: Schema.String.check(Schema.isMinLength(1)),
  effort: Schema.optional(ReasoningEffort),
  /** The choice a turn takes when the router does not choose. At most one; none means the first. */
  default: Schema.optional(Schema.Boolean),
})

const RouterConfig = Schema.Struct({
  label: Schema.optional(Schema.String),
  /** The decision model that classifies; absent, the cheapest one with a credential. */
  classifier: Schema.optional(ModelId),
  choices: Schema.Array(ChoiceConfig),
})
type RouterConfig = typeof RouterConfig.Type

const ConfigFile = Schema.fromJsonString(
  Schema.Struct({ routers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
)

/** One config router: its virtual model and the classifier it names, or why it cannot serve. */
interface ConfiguredRouter {
  readonly model: VirtualModel
  readonly classifier: Option.Option<ModelId>
}

const configReason = (error: Schema.SchemaError) =>
  error.message.replace(/\n\s+at /g, " at ").replace(/\n/g, "; ")

/** `auto` → `Auto`: the label of an entry that names none. */
const labelOf = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`

/** Each entry of a file, decoded on its own: one that does not decode says why. */
type RouterEntries = Readonly<Record<string, Result.Result<RouterConfig, string>>>

const decodeRouterConfig = Schema.decodeUnknownResult(RouterConfig)

/** The entry as a virtual model, or why it cannot be one. */
const configuredRouter = (
  name: string,
  entry: Result.Result<RouterConfig, string>,
): Result.Result<ConfiguredRouter, string> => {
  if (name.length === 0 || name.includes("/"))
    return Result.fail(`a router name is one path segment, without "/"`)
  return Result.flatMap(entry, (config: RouterConfig) => {
    if (config.choices.length === 0) return Result.fail("it has no choices")
    const defaults = config.choices.flatMap((choice, index) => {
      if (choice.default !== true) return []
      return [index + 1]
    })
    if (defaults.length > 1)
      return Result.fail(
        `choices ${defaults.join(" and ")} are each marked "default": true; mark one`,
      )
    return Result.succeed({
      model: {
        name,
        label: config.label ?? labelOf(name),
        choices: config.choices.map((choice) => ({
          reason: choice.reason,
          ...omitUndefined({ model: choice.model, effort: choice.effort }),
        })),
        fallback: Math.max(0, (defaults[0] ?? 1) - 1),
      },
      classifier: Option.fromUndefinedOr(config.classifier),
    })
  })
}

/**
 * The `routers` entries of one config file. A missing file has none; one
 * that is not JSON is logged and has none (the config service reports it).
 */
const readRouterEntries = Effect.fn("Router.readEntries")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const none: RouterEntries = {}
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return none
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ConfigFile)),
    Effect.map((config): RouterEntries =>
      Object.fromEntries(
        Object.entries(config.routers ?? {}).map(([name, raw]) => [
          name,
          Result.mapError(decodeRouterConfig(raw), configReason),
        ]),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("router.config.unreadable").pipe(
        Effect.annotateLogs({ file, error: String(cause) }),
        Effect.as(none),
      ),
    ),
  )
})

/** The user's routers, then a trusted project's over them by name, each decoded on its own. */
const readRouters = Effect.fn("Router.readRouters")(function* (home: string, cwd: string) {
  const path = yield* Path.Path
  const user = yield* readRouterEntries(path.join(home, ".gent", "config.json"))
  let project: RouterEntries = {}
  if (yield* isProjectTrusted({ home, cwd }))
    project = yield* readRouterEntries(path.join(cwd, ".gent", "config.json"))
  const routers = new Map<string, ConfiguredRouter>()
  const problems: Array<VirtualModelProblem> = []
  for (const [name, entry] of Object.entries({ ...user, ...project })) {
    const configured = configuredRouter(name, entry)
    if (Result.isFailure(configured)) problems.push({ name, reason: configured.failure })
    else routers.set(name, configured.success)
  }
  return { routers, problems }
})

// ── classify ────────────────────────────────────────────────────────────────

/** The most of the latest request the classifier reads. */
const REQUEST_CHARS = 3_000

/** The most of the request before it the classifier reads, for context. */
const EARLIER_CHARS = 400

/** The classifier's whole input; the decision itself adds the choices. */
const INPUT_CHARS = 4_000

/** The classifier's own deadline, inside the 10 s core gives a route. */
const CLASSIFY_DEADLINE_MS = 8_000

const userText = (message: Message) =>
  messagePartsDisplayText(message.parts, { maxToolChars: 0 }).trim()

/**
 * What the classifier reads: the latest user request, head and tail, and the
 * end of the one before it. Small and bounded, whatever the history holds.
 */
const classifierInput = (messages: ReadonlyArray<Message>): string => {
  const requests = messages.flatMap((message) => {
    if (message.role !== "user") return []
    const text = userText(message)
    if (text.length === 0) return []
    return [text]
  })
  const latest = headTailChars(requests.at(-1) ?? "", REQUEST_CHARS).text
  const lines = [`Latest request:\n${latest}`]
  const earlier = Option.fromUndefinedOr(requests.at(-2))
  if (Option.isSome(earlier))
    lines.push(`Earlier request (end):\n${tailChars(earlier.value, EARLIER_CHARS)}`)
  return headChars(lines.join("\n\n"), INPUT_CHARS)
}

const choiceLabel = (index: number) => `choice${index + 1}`

/** The decision: one label per choice, its `reason` the criterion. */
const routeDecision = (model: VirtualModel) =>
  Decision.make({
    input: Schema.String,
    decisions: {
      choice: Decision.classify({
        instructions:
          "Pick the choice whose description best fits the work the latest request asks for. Judge the work; do not answer the request.",
        criteria: Object.fromEntries(
          model.choices.map((choice, index) => [choiceLabel(index), choice.reason]),
        ),
      }),
    },
  })

// ── stickiness ──────────────────────────────────────────────────────────────

/** The classifier confidence a switch to a stronger model needs away from a warm cache. */
const STRONGER_CONFIDENCE = 0.6

/**
 * The output a turn is priced at when a cheaper switch is weighed: a typical
 * turn's replies across its steps. The switch saves on these; it pays the
 * history's cache write once.
 */
const TURN_OUTPUT_TOKENS = 4_000

/** A model's price per million tokens, input and output together; none when unpriced. */
const priceOf = (model: Model) =>
  Option.map(Option.fromUndefinedOr(model.pricing), (pricing) => pricing.input + pricing.output)

/**
 * Whether a switch from the warm `current` to the cheaper `target` pays on
 * this turn: the history written to the new model's cache at its write rate
 * (the lifetime its requests ask for) and the turn's output at its price,
 * against the history read from the warm cache and the output on `current`.
 */
const cheaperSwitchPays = (params: {
  readonly current: ModelRouteCurrent
  readonly target: Model
  readonly child: boolean
}): boolean =>
  Option.match(
    Option.all([
      Option.fromUndefinedOr(params.current.model.pricing),
      Option.fromUndefinedOr(params.target.pricing),
    ]),
    {
      onNone: () => false,
      onSome: ([stay, move]) => {
        const history = params.current.historyTokens
        const stayCost = history * (stay.cacheRead ?? stay.input) + TURN_OUTPUT_TOKENS * stay.output
        const ttl = promptCacheTtlMsFor(params.target, params.child)
        const moveCost = history * cacheWriteRate(move, ttl) + TURN_OUTPUT_TOKENS * move.output
        return moveCost < stayCost
      },
    },
  )

/**
 * The choice the turn runs: the classifier's pick, unless the branch's
 * cache is warm on another model that is a choice and the switch does not
 * pay. A pick on the current model is no switch, whatever its effort.
 */
const holdOrSwitch = (params: {
  readonly input: ModelRouteInput
  readonly picked: number
  readonly confidence: number
  readonly reason: string
}): ModelRouteDecision => {
  const { input, picked, confidence, reason } = params
  const switchTo = { choice: picked, reason }
  const candidate = Option.flatten(Option.fromUndefinedOr(input.candidates[picked]))
  const warm = Option.filter(input.current, (current) => current.warm)
  if (Option.isNone(warm) || Option.isNone(candidate)) return switchTo
  const current = warm.value
  const target = candidate.value
  if (target.id === current.model.id) return switchTo
  // The choice that keeps the warm model: one that names it, else one that keeps it.
  const runsOnCurrent = (index: number) =>
    Option.exists(
      Option.flatten(Option.fromUndefinedOr(input.candidates[index])),
      (model) => model.id === current.model.id,
    )
  const indexes = input.model.choices.map((_, index) => index)
  const stay = Option.orElse(
    Option.fromUndefinedOr(
      indexes.find(
        (index) =>
          runsOnCurrent(index) && Predicate.isNotUndefined(input.model.choices[index]?.model),
      ),
    ),
    () => Option.fromUndefinedOr(indexes.find(runsOnCurrent)),
  )
  if (Option.isNone(stay)) return switchTo
  const hold = (why: string) => ({
    choice: stay.value,
    reason: `${reason}; held ${current.model.id}: ${why}`,
  })
  const prices = Option.all([priceOf(current.model), priceOf(target)])
  const cheaper = Option.exists(prices, ([stayPrice, movePrice]) => movePrice < stayPrice)
  const level = Option.exists(prices, ([stayPrice, movePrice]) => movePrice === stayPrice)
  if (level) return hold("a switch at the same price only rewrites the cache")
  if (cheaper) {
    if (cheaperSwitchPays({ current, target, child: input.child })) return switchTo
    return hold(
      `rewriting ${current.historyTokens} history tokens costs more than the switch saves`,
    )
  }
  // Stronger, or unpriced: the classifier must be sure.
  if (confidence >= STRONGER_CONFIDENCE) return switchTo
  return hold(`confidence ${confidence.toFixed(2)} is under ${STRONGER_CONFIDENCE}`)
}

// ── route ───────────────────────────────────────────────────────────────────

const routeError = (message: string) =>
  new ExtensionServiceError({ service: "Router", operation: "route", message })

const routeWith =
  (routers: ReadonlyMap<string, ConfiguredRouter>): ModelRouterContribution["route"] =>
  (input) =>
    Effect.gen(function* () {
      if (input.model.choices.length === 1) return { choice: 0, reason: "the only choice" }
      const ctx = yield* ExtensionContext
      const named = Option.flatMap(Option.fromUndefinedOr(routers.get(input.model.name)), (r) =>
        Option.map(r.classifier, String),
      )
      const classifier = yield* Option.match(named, {
        onSome: Effect.succeed,
        onNone: () =>
          ctx.Models.classifiers.pipe(
            Effect.flatMap((models) =>
              Option.match(Option.fromUndefinedOr(models[0]), {
                onNone: () => Effect.fail(routeError("no classifier model has a credential")),
                onSome: (model) => Effect.succeed(String(model.id)),
              }),
            ),
          ),
      })
      const reply = yield* ctx.Models.decide({
        definition: routeDecision(input.model),
        input: classifierInput(input.messages),
        model: classifier,
        timeoutMs: CLASSIFY_DEADLINE_MS,
      })
      const answer = reply.answers.choice
      const picked = input.model.choices.findIndex(
        (_, index) => choiceLabel(index) === answer.label,
      )
      if (picked < 0) return yield* routeError(`the classifier answered "${answer.label}"`)
      const confidence = answer.confidence ?? answer.probabilities[answer.label] ?? 0
      return holdOrSwitch({
        input,
        picked,
        confidence,
        reason: `${input.model.choices[picked]?.reason ?? answer.label} (${confidence.toFixed(2)})`,
      })
    })

// ── extension ───────────────────────────────────────────────────────────────

/**
 * @gent/router: every `routers` entry of the config files as a virtual model
 * `router/<name>`. An entry that cannot serve is reported as a catalog
 * failure, and a turn on it fails with why. The files are read when the
 * extensions load.
 */
export const RouterExtension = defineExtension({
  id: "@gent/router",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    const { routers, problems } = yield* readRouters(host.home, host.cwd)
    if (routers.size === 0 && problems.length === 0) return
    yield* host.register("modelRouter", {
      id: ROUTER_ID,
      name: "Router",
      models: [...routers.values()].map((router) => router.model),
      problems,
      route: routeWith(routers),
    })
  }),
})
