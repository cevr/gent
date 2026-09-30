/** @jsxImportSource @opentui/solid */
import { Effect, Option, Schema } from "effect"
import { type Accessor, createMemo, createRoot, createSignal, type Setter } from "solid-js"
import { AgentEvent, type EventEnvelope, type Model } from "@gent/core/protocol"
import { CHILD_COMPLETION_TYPE, WAKE_MESSAGE_TYPE } from "@gent/extensions/client"
import {
  type ActiveExtensionSession,
  ClientContext,
  clientContributions,
  defineClientExtension,
  formatAge,
  formatTokens,
  type NoticeRow,
  noticeRowContribution,
  statusLabelContribution,
} from "@gent/tui/extensions"

// ── cache-miss notices ──────────────────────────────────────────────────────

/**
 * Prompt-cache misses, as transcript notices.
 *
 * A step that re-sends a prefix the provider no longer holds pays for it again
 * at the full input or cache-write price. This extension folds the branch's
 * events (the feed replays them from the start on every mount, so resume
 * derives the same rows) into the misses and why each happened: the cache
 * expired during a long tool call, while the turn waited for an approval,
 * while the reader was idle, before a child's completion or a wake, or after a
 * model switch. A miss inside the cache lifetime with the same model, on a
 * provider that reports cache writes, is a changed prefix: the regression
 * alarm for a moved cache marker. On a provider that caches implicitly and
 * reports reads only, such a miss is no evidence and is not counted.
 *
 * The cache lifetime is the model catalog's (`Model.promptCacheTtlMs`, as the
 * model's driver says), so a miss is judged once the catalog is there. A model
 * whose entry names no lifetime counts only a model switch: without a
 * lifetime an expiry cannot be told from a changed prefix.
 *
 * Nothing is stored and the model never sees it. A notice row shows a miss
 * large enough to matter; the status row shows the branch's total.
 */

export const CACHE_EXTENSION_ID = "@gent/cache"

/** A miss at or under this is cache breakpoint granularity, not a lost prefix. */
const NOISE_FLOOR_TOKENS = 1024

/** A row shows only a miss this large, in tokens or in dollars; the total counts every miss. */
const NOTICE_MIN_TOKENS = 20_000
const NOTICE_MIN_COST_USD = 0.1

/** The glyph column of a miss row, drawn in the warning color. */
const MISS_GLYPH = "◌"

// ── fold ────────────────────────────────────────────────────────────────────

/** Why a prefix the previous request cached was billed again. */
export const CacheMissCause = Schema.TaggedUnion({
  /** The step ran on another model; its cache holds nothing of this prefix. */
  ModelSwitch: {},
  /** Same model inside the cache lifetime, on a provider that writes its cache: the prefix itself changed. */
  PrefixChanged: {},
  /** The previous response ran out the lifetime that began when its request started. */
  Response: { ms: Schema.Finite },
  /** The cache expired while one tool call ran between two steps of a turn. */
  Tool: { toolName: Schema.String, ms: Schema.Finite },
  /** The cache expired while the turn waited for an interaction to be answered. */
  Approval: { ms: Schema.Finite },
  /** The cache expired between two steps of a turn with nothing to account for it. */
  Paused: { ms: Schema.Finite },
  /** A child's completion opened this turn after the cache expired. */
  Child: { ms: Schema.Finite },
  /** A wake opened this turn after the cache expired. */
  Wake: { ms: Schema.Finite },
  /** Any other new turn after the cache expired. */
  Idle: { ms: Schema.Finite },
})
export type CacheMissCause = typeof CacheMissCause.Type

export interface CacheMiss {
  /** The `StreamEnded` envelope that paid for the miss. */
  readonly eventId: number
  /** When the paying request started; the row sits there, ahead of the step's answer. */
  readonly startedAt: number
  readonly model: string
  /** The catalog id the runtime priced the step by; a driver override routes it. */
  readonly pricedModel: string
  /** Prefix tokens the previous request had cached that this one did not read. */
  readonly missedTokens: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** The step was billed; a subscription step reports no cost. */
  readonly billed: boolean
  readonly cause: CacheMissCause
}

/** A lost prefix as the fold sees it, before the model's cache lifetime says why. */
interface ScannedMiss extends Omit<CacheMiss, "cause"> {
  /**
   * How long after the previous step ended this request started: the idle
   * time the loop measures from the branch's last `StreamEnded` when it
   * decides a turn starts cold.
   */
  readonly idleMs: number
  /** How long the previous step's response ran. */
  readonly responseMs: number
  /** The step ran on another model than the previous one; its cache holds nothing of the prefix. */
  readonly modelSwitch: boolean
  /** The model reported cache writes: it holds a written prefix for the lifetime. */
  readonly explicitCache: boolean
  /** What took the idle time, if it outlived the lifetime. */
  readonly lapse: CacheMissCause
}

/**
 * The miss and its cause by the model's cache lifetime. Idle past the
 * lifetime is the lapse's doing. A provider refreshes its cache when a
 * request starts, so a response that ran the rest of the lifetime expired it
 * too. Otherwise only an explicit cache's miss counts, as a changed prefix.
 * With no lifetime only a model switch counts.
 */
export const resolveMiss = (
  scanned: ScannedMiss,
  lifetimeMs: Option.Option<number>,
): Option.Option<CacheMiss> => {
  const { idleMs, responseMs, modelSwitch, explicitCache, lapse, ...miss } = scanned
  const cause = Option.flatMap(lifetimeMs, (lifetime) => {
    if (idleMs > lifetime) return Option.some(lapse)
    if (idleMs + responseMs > lifetime) {
      return Option.some(CacheMissCause.cases.Response.make({ ms: responseMs }))
    }
    return Option.liftPredicate(CacheMissCause.cases.PrefixChanged.make({}), () => explicitCache)
  })
  const switched = Option.liftPredicate(
    CacheMissCause.cases.ModelSwitch.make({}),
    () => modelSwitch,
  )
  return Option.map(
    Option.orElse(switched, () => cause),
    (value) => ({ ...miss, cause: value }),
  )
}

/** The request that last refreshed the cache: everything in its prompt should read back. */
interface CachedRequest {
  readonly promptTokens: number
  readonly model: string
  readonly startedAt: number
  readonly endedAt: number
  readonly input: Option.Option<string>
  /**
   * Some request since the last reset reported cache activity. A later step
   * that reads nothing is then a total miss (a provider that reports reads
   * only, like OpenAI), not a provider that never reports caching.
   */
  readonly reportedCache: boolean
}

interface Span {
  readonly name: string
  readonly ms: number
}

const longest = (spans: ReadonlyArray<Span>): Option.Option<Span> => {
  let best = Option.none<Span>()
  for (const span of spans) {
    if (!Option.exists(best, (held) => held.ms >= span.ms)) best = Option.some(span)
  }
  return best
}

/** A span "covers" the gap when it took at least half of it. */
const covers = (span: Option.Option<Span>, gapMs: number): Option.Option<Span> =>
  Option.filter(span, (value) => value.ms * 2 >= gapMs)

export interface CacheScan {
  /**
   * Fold one envelope and answer the miss it settled, if any. An envelope at
   * or below the last folded id is skipped, so a replay that repeats history
   * adds nothing.
   */
  readonly fold: (envelope: EventEnvelope) => Option.Option<ScannedMiss>
}

/** One branch's incremental fold. Feed it that branch's envelopes in id order. */
export const makeCacheScan = (): CacheScan => {
  let lastId = Number.NEGATIVE_INFINITY
  let previous = Option.none<CachedRequest>()
  let started = Option.none<{ readonly at: number; readonly input: Option.Option<string> }>()
  const openTools = new Map<string, { readonly name: string; readonly at: number }>()
  const openWaits = new Map<string, number>()
  let tools: Array<Span> = []
  let waits: Array<Span> = []
  /** `metadata.customType` of each message that carries one: what opened a turn. */
  const inputTypes = new Map<string, string>()
  /**
   * The models whose steps reported cache writes. Such a provider caches
   * explicitly (Anthropic's `cache_control`): it holds a written prefix for
   * the lifetime, so a zero read inside it means the prefix changed. A
   * provider that reports reads only caches implicitly (OpenAI): a request
   * reads the cache only when it reaches a server that holds the prefix, so a
   * zero read inside the lifetime is no evidence of anything.
   */
  const writers = new Set<string>()

  const reset = () => {
    previous = Option.none()
    tools = []
    waits = []
  }

  /** Why a prefix outlived its lifetime: what took the idle time since the previous step ended. */
  const expiredCause = (
    prior: CachedRequest,
    gapMs: number,
    input: Option.Option<string>,
  ): CacheMissCause => {
    const sameTurn =
      Option.isSome(input) && Option.isSome(prior.input) && input.value === prior.input.value
    if (sameTurn) {
      const wait = covers(longest(waits), gapMs)
      if (Option.isSome(wait)) return CacheMissCause.cases.Approval.make({ ms: wait.value.ms })
      const tool = covers(longest(tools), gapMs)
      if (Option.isSome(tool)) {
        return CacheMissCause.cases.Tool.make({ toolName: tool.value.name, ms: tool.value.ms })
      }
      return CacheMissCause.cases.Paused.make({ ms: gapMs })
    }
    const opener = Option.flatMap(input, (id) => Option.fromUndefinedOr(inputTypes.get(id)))
    if (Option.contains(opener, CHILD_COMPLETION_TYPE))
      return CacheMissCause.cases.Child.make({ ms: gapMs })
    if (Option.contains(opener, WAKE_MESSAGE_TYPE))
      return CacheMissCause.cases.Wake.make({ ms: gapMs })
    return CacheMissCause.cases.Idle.make({ ms: gapMs })
  }

  const settle = (
    envelope: EventEnvelope,
    event: Extract<AgentEvent, { _tag: "StreamEnded" }>,
  ): Option.Option<ScannedMiss> => {
    const begun = Option.getOrElse(started, () => ({
      at: envelope.createdAt,
      input: Option.fromUndefinedOr(event.messageId),
    }))
    started = Option.none()
    const usage = Option.fromUndefinedOr(event.usage)
    // A step with no usage (an interrupted stream) refreshed nothing we can count.
    if (Option.isNone(usage) || usage.value.inputTokens <= 0) return Option.none()
    const promptTokens = usage.value.inputTokens
    const cacheReadTokens = usage.value.cacheReadTokens ?? 0
    const cacheWriteTokens = usage.value.cacheWriteTokens ?? 0
    const model = event.model ?? ""
    const pricedModel = event.pricedModel ?? model
    const reported = cacheReadTokens + cacheWriteTokens > 0
    if (cacheWriteTokens > 0) writers.add(model)
    const miss = Option.flatMap(previous, (prior): Option.Option<ScannedMiss> => {
      if (!reported && !prior.reportedCache) return Option.none()
      const missedTokens = Math.min(prior.promptTokens, promptTokens) - cacheReadTokens
      if (missedTokens <= NOISE_FLOOR_TOKENS) return Option.none()
      // Idle runs from the end of the previous step, as the loop counts it;
      // the lapse names what took that interval.
      const idleMs = Math.max(0, begun.at - prior.endedAt)
      return Option.some({
        eventId: envelope.id,
        startedAt: begun.at,
        model,
        pricedModel,
        missedTokens,
        inputTokens: promptTokens,
        cacheReadTokens,
        cacheWriteTokens,
        billed: (event.costUsd ?? 0) > 0,
        idleMs,
        responseMs: Math.max(0, prior.endedAt - prior.startedAt),
        modelSwitch: model !== prior.model,
        explicitCache: writers.has(model),
        lapse: expiredCause(prior, idleMs, begun.input),
      })
    })
    previous = Option.some({
      promptTokens,
      model,
      startedAt: begun.at,
      endedAt: envelope.createdAt,
      input: begun.input,
      reportedCache: reported || Option.exists(previous, (prior) => prior.reportedCache),
    })
    tools = []
    waits = []
    return miss
  }

  const fold = (envelope: EventEnvelope): Option.Option<ScannedMiss> => {
    if (envelope.id <= lastId) return Option.none()
    lastId = envelope.id
    const event = envelope.event
    switch (event._tag) {
      case "MessageReceived": {
        Option.map(Option.fromUndefinedOr(event.message.metadata?.customType), (customType) =>
          inputTypes.set(event.message.id, customType),
        )
        return Option.none()
      }
      case "ModelContextProjected":
        // A compaction rewrote the context: the next prompt is new content, not a re-bill.
        if (event.compacted) reset()
        return Option.none()
      case "StreamStarted":
        started = Option.some({
          at: envelope.createdAt,
          input: Option.fromUndefinedOr(event.messageId),
        })
        return Option.none()
      case "ToolCallStarted":
        // A call a cell admitted runs inside the cell's own span.
        if (Option.isNone(Option.fromUndefinedOr(event.parentToolCallId))) {
          openTools.set(event.toolCallId, { name: event.toolName, at: envelope.createdAt })
        }
        return Option.none()
      case "ToolCallSucceeded":
      case "ToolCallFailed": {
        Option.map(Option.fromUndefinedOr(openTools.get(event.toolCallId)), (open) => {
          openTools.delete(event.toolCallId)
          tools.push({ name: open.name, ms: envelope.createdAt - open.at })
        })
        return Option.none()
      }
      case "InteractionPresented":
        openWaits.set(event.requestId, envelope.createdAt)
        return Option.none()
      case "InteractionResolved": {
        Option.map(Option.fromUndefinedOr(openWaits.get(event.requestId)), (at) => {
          openWaits.delete(event.requestId)
          waits.push({ name: "approval", ms: envelope.createdAt - at })
        })
        return Option.none()
      }
      case "StreamEnded":
        return settle(envelope, event)
      default:
        return Option.none()
    }
  }

  return { fold }
}

// ── price and text ──────────────────────────────────────────────────────────

type ModelPricing = NonNullable<Model["pricing"]>

/**
 * What the miss cost over a cache hit. The re-billed prefix was written to
 * the cache again, so the missed tokens fill this step's cache writes first,
 * at the write rate; the rest paid the uncached input rate. Each part is
 * priced over the cache-read rate it would have paid. A provider that bills
 * no writes (OpenAI) reports none, so every missed token paid the input rate.
 * An unbilled step, or a model the catalog does not price, cost nothing.
 */
export const missCostUsd = (miss: CacheMiss, pricing: Option.Option<ModelPricing>): number => {
  if (!miss.billed || Option.isNone(pricing)) return 0
  const price = pricing.value
  const readRate = price.cacheRead ?? price.input
  const rewritten = Math.min(miss.missedTokens, miss.cacheWriteTokens)
  const uncached = Math.max(0, miss.missedTokens - rewritten)
  const writeWaste = rewritten * Math.max(0, (price.cacheWrite ?? price.input) - readRate)
  const inputWaste = uncached * Math.max(0, price.input - readRate)
  return (writeWaste + inputWaste) / 1_000_000
}

/** pi's rule: a row for a miss of at least 20k tokens or 10 cents. */
export const showsMissRow = (miss: CacheMiss, costUsd: number): boolean =>
  miss.missedTokens >= NOTICE_MIN_TOKENS || costUsd >= NOTICE_MIN_COST_USD

const causeText = CacheMissCause.match({
  ModelSwitch: () => "cache miss after model switch",
  PrefixChanged: () => "cache miss: prefix changed",
  Response: (cause) => `cache expired during a ${formatAge(cause.ms)} response`,
  Tool: (cause) => `cache expired during ${formatAge(cause.ms)} ${cause.toolName}`,
  Approval: (cause) => `cache expired waiting ${formatAge(cause.ms)} for approval`,
  Paused: (cause) => `cache expired while the turn paused ${formatAge(cause.ms)}`,
  Child: (cause) => `cache expired while a child ran ${formatAge(cause.ms)}`,
  Wake: (cause) => `cache expired before the wake, ${formatAge(cause.ms)}`,
  Idle: (cause) => `cache expired after ${formatAge(cause.ms)} idle`,
})

/** `cache expired during 7m cell · 14k tokens re-billed ~$0.08`; a cent or less is not named. */
export const missText = (miss: CacheMiss, costUsd: number): string => {
  let cost = ""
  if (costUsd >= 0.01) cost = ` ~$${costUsd.toFixed(2)}`
  return `${causeText(miss.cause)} · ${formatTokens(miss.missedTokens)} tokens re-billed${cost}`
}

// ── client extension ────────────────────────────────────────────────────────

/** The events the fold reads; each names its session and branch. */
const isBranchEvent = AgentEvent.isAnyOf([
  "StreamStarted",
  "StreamEnded",
  "ToolCallStarted",
  "ToolCallSucceeded",
  "ToolCallFailed",
  "InteractionPresented",
  "InteractionResolved",
  "ModelContextProjected",
])

const branchKey = (session: ActiveExtensionSession): string =>
  `${session.sessionId}:${session.branchId}`

const envelopeBranch = (event: AgentEvent): Option.Option<string> => {
  if (event._tag === "MessageReceived") return Option.some(branchKey(event.message))
  if (isBranchEvent(event)) return Option.some(branchKey(event))
  return Option.none()
}

/** A miss as priced when its row was born; the row is absent below the display threshold. */
interface PricedMiss {
  readonly costUsd: number
  readonly row: Option.Option<NoticeRow>
}

interface BranchMisses {
  readonly scan: CacheScan
  readonly misses: Accessor<ReadonlyArray<ScannedMiss>>
  readonly setMisses: Setter<ReadonlyArray<ScannedMiss>>
  /** Each miss as priced the first time the catalog was there to price it. */
  readonly born: Map<number, PricedMiss>
}

export default defineClientExtension(CACHE_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, lifecycle } = yield* ClientContext
    return createRoot((dispose) => {
      lifecycle.addCleanup(dispose)
      const branches = new Map<string, BranchMisses>()
      const branch = (key: string): BranchMisses => {
        const known = Option.fromUndefinedOr(branches.get(key))
        if (Option.isSome(known)) return known.value
        const [misses, setMisses] = createSignal<ReadonlyArray<ScannedMiss>>([])
        const created = { scan: makeCacheScan(), misses, setMisses, born: new Map() }
        branches.set(key, created)
        return created
      }

      // Replayed and live envelopes both arrive here; the scan skips any it has folded.
      lifecycle.addCleanup(
        transport.onSessionEvent((envelope) =>
          Option.map(envelopeBranch(envelope.event), (key) => {
            const target = branch(key)
            Option.map(target.scan.fold(envelope), (miss) =>
              target.setMisses((misses) => [...misses, miss]),
            )
          }),
        ),
      )

      // Neither a price nor a cache lifetime is known until the catalog
      // settles, so no miss is judged or priced before then.
      const catalogModels = createMemo(() =>
        Option.map(
          transport.modelCatalog(),
          (catalog) => new Map<string, Model>(catalog.map((model) => [model.id, model])),
        ),
      )

      // A miss is judged and priced once, when it is first read with the
      // catalog, and its row is born then with its final text: scrollback
      // never holds a row that changes after, and a later catalog reload
      // rewrites nothing. A miss the lifetime does not count costs nothing.
      const priceOnce = (
        born: Map<number, PricedMiss>,
        scanned: ScannedMiss,
        catalog: ReadonlyMap<string, Model>,
      ): PricedMiss => {
        const known = Option.fromUndefinedOr(born.get(scanned.eventId))
        if (Option.isSome(known)) return known.value
        const model = Option.fromUndefinedOr(catalog.get(scanned.pricedModel))
        const lifetime = Option.flatMap(model, (entry) =>
          Option.fromUndefinedOr(entry.promptCacheTtlMs),
        )
        const priced = Option.match(resolveMiss(scanned, lifetime), {
          onNone: (): PricedMiss => ({ costUsd: 0, row: Option.none() }),
          onSome: (miss): PricedMiss => {
            const costUsd = missCostUsd(
              miss,
              Option.flatMap(model, (entry) => Option.fromUndefinedOr(entry.pricing)),
            )
            const row = Option.some<NoticeRow>({
              key: String(miss.eventId),
              createdAt: miss.startedAt,
              glyph: MISS_GLYPH,
              color: "warning",
              text: missText(miss, costUsd),
            }).pipe(Option.filter(() => showsMissRow(miss, costUsd)))
            return { costUsd, row }
          },
        })
        born.set(scanned.eventId, priced)
        return priced
      }
      const priced = (key: string): Option.Option<ReadonlyArray<PricedMiss>> =>
        Option.map(catalogModels(), (catalog) => {
          const target = branch(key)
          return target.misses().map((miss) => priceOnce(target.born, miss, catalog))
        })

      return clientContributions(
        noticeRowContribution({
          id: "cache.misses",
          rows: (session) =>
            Option.map(priced(branchKey(session)), (misses) =>
              misses.flatMap((miss) => Option.toArray(miss.row)),
            ),
        }),
        statusLabelContribution({
          priority: 60,
          produce: (): ReadonlyArray<{ readonly text: string; readonly color: "textMuted" }> => {
            const total = Option.getOrElse(
              Option.map(
                Option.flatMap(transport.currentSession(), (session) => priced(branchKey(session))),
                (misses) => misses.reduce((sum, miss) => sum + miss.costUsd, 0),
              ),
              () => 0,
            )
            if (total <= 0) return []
            return [{ text: `cache waste $${total.toFixed(2)}`, color: "textMuted" }]
          },
        }),
      )
    })
  }),
})
