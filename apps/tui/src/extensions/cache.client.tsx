/** @jsxImportSource @opentui/solid */
import { Clock, Effect, Option, Schedule, Schema } from "effect"
import { type Accessor, createMemo, createRoot, createSignal, type Setter } from "solid-js"
import {
  AgentEvent,
  cacheWriteRate,
  coldHandoffPays,
  type EventEnvelope,
  type Model,
  promptCacheTtlMsFor,
} from "@gent/core/protocol"
import { CHILD_COMPLETION_TYPE, WAKE_MESSAGE_TYPE } from "@gent/extensions/client"
import {
  type ActiveExtensionSession,
  ClientContext,
  clientContributions,
  defineClientExtension,
  formatAge,
  formatCost,
  formatTokens,
  type NoticeRow,
  noticeRowContribution,
  statusLabelContribution,
  type StatusLabelItem,
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
 * The cache lifetime is the model catalog's (`promptCacheTtlMsFor`, as the
 * model's driver says, a spawned child's when the step says it ran in one),
 * so a miss is judged once the catalog is there. A model
 * whose entry names no lifetime counts only a model switch: without a
 * lifetime an expiry cannot be told from a changed prefix.
 *
 * Nothing is stored and the model never sees it. A notice row shows a miss
 * large enough to matter; the status row shows the branch's total, and, in
 * its right group, the time the cached prefix has left (`cache 42m`, then
 * `cache cold`, with `next turn compacts` when the loop would hand the
 * window off first).
 */

const CACHE_EXTENSION_ID = "@gent/cache"

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
  /**
   * A changed prefix whose two requests ran on different extension profiles
   * (`StreamStarted.profileRevision`): an extension change rewrote it, as a
   * model switch would, not a regression.
   */
  ExtensionsChanged: {},
  /** The previous response itself took most of the lifetime, measured from its start. */
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
  /** The part of the writes the driver split by lifetime; the rest took the step's. */
  readonly cacheWritesByLifetime: NonNullable<
    Extract<AgentEvent, { _tag: "StreamEnded" }>["cacheWritesByLifetime"]
  >
  /** The step was billed; a subscription step reports no cost. */
  readonly billed: boolean
  readonly cause: CacheMissCause
}

/** A lost prefix as the fold sees it, before the model's cache lifetime says why. */
interface ScannedMiss extends Omit<CacheMiss, "cause"> {
  /**
   * How long after the previous request started this one started. The
   * provider refreshes its cache when a request starts, so the lifetime runs
   * from there, as the loop counts it when it decides a turn starts cold.
   */
  readonly sinceRefreshMs: number
  /** The step ran on another model than the previous one; its cache holds nothing of the prefix. */
  readonly modelSwitch: boolean
  /** The model reported cache writes: it holds a written prefix for the lifetime. */
  readonly explicitCache: boolean
  /** Both requests name their extension profile, and the two differ. */
  readonly extensionsChanged: boolean
  /** What took that time, if it outlived the lifetime. */
  readonly lapse: CacheMissCause
  /** The step ran in a spawned child session, whose requests ask for the child lifetime. */
  readonly child: boolean
}

/**
 * The miss and its cause by the model's cache lifetime. Time past the
 * lifetime since the previous request started is the lapse's doing.
 * Otherwise only an explicit cache's miss counts, as a changed prefix, named
 * an extension change when the two requests ran on different profiles. With
 * no lifetime only a model switch counts.
 */
export const resolveMiss = (
  scanned: ScannedMiss,
  lifetimeMs: Option.Option<number>,
): Option.Option<CacheMiss> => {
  const {
    sinceRefreshMs,
    modelSwitch,
    explicitCache,
    extensionsChanged,
    lapse,
    child: _child,
    ...miss
  } = scanned
  const changed = Option.getOrElse(
    Option.liftPredicate(CacheMissCause.cases.ExtensionsChanged.make({}), () => extensionsChanged),
    () => CacheMissCause.cases.PrefixChanged.make({}),
  )
  const cause = Option.flatMap(lifetimeMs, (lifetime) => {
    if (sinceRefreshMs > lifetime) return Option.some(lapse)
    return Option.liftPredicate(changed, () => explicitCache)
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

/** The last request that reported usage: everything in its prompt should read back. */
interface CachedRequest {
  readonly promptTokens: number
  readonly model: string
  /** The extension profile it ran on; none on a row written before the field. */
  readonly profileRevision: Option.Option<string>
  /**
   * Some request since the last reset reported cache activity. A later step
   * that reads nothing is then a total miss (a provider that reports reads
   * only, like OpenAI), not a provider that never reports caching.
   */
  readonly reportedCache: boolean
}

/**
 * The last request that went out, with usage or without: an interrupted
 * request read the cache too. The lifetime runs from its start, as the loop
 * counts it; a retry starts it again when the retry goes out.
 */
interface Refresh {
  readonly startedAt: number
  readonly endedAt: number
  readonly input: Option.Option<string>
}

/** A request that went out: when, for which input, on which extension profile. */
interface Begun {
  readonly at: number
  readonly input: Option.Option<string>
  readonly profileRevision: Option.Option<string>
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

/**
 * The request the branch's prompt cache lives on, as the timer reads it: when
 * it started, and whose cache it is.
 */
export interface CacheRefresh {
  /** When the newest request went out (a retry: when the retry went out). */
  readonly startedAt: number
  /** The model the request ran on, to tell a switch. */
  readonly model: string
  /** The catalog id the step was priced by: its entry names the lifetime. */
  readonly catalogModel: string
  /** The step ran in a spawned child session, whose requests ask for the child lifetime. */
  readonly child: boolean
  /**
   * The model reports no cache writes: it caches implicitly, and the lifetime
   * the catalog names is a measured guess, not one the request asked for.
   */
  readonly estimated: boolean
}

/**
 * What a turn that starts now would hand off, and the input budget. The
 * history is the window of the branch's last step: everything before the
 * next prompt but that step's reply (one step's output). It counts at least
 * that step's reported input less the system and tool size its request
 * carried (`StreamEnded.requestOverheadTokens`), as the loop's projection
 * counts the same messages.
 */
interface CacheWindow {
  readonly historyTokens: number
  readonly availableInputTokens: number
}

export interface CacheScan {
  /**
   * Fold one envelope and answer the miss it settled, if any. An envelope at
   * or below the last folded id is skipped, so a replay that repeats history
   * adds nothing.
   */
  readonly fold: (envelope: EventEnvelope) => Option.Option<ScannedMiss>
  /**
   * The request the cache lifetime runs from: the one in flight, else the
   * last that went out. `None` before a step settled with a model, on a
   * branch that never reported cache activity, and after a compaction until
   * the next request goes out: the old prefix is gone.
   */
  readonly refresh: () => Option.Option<CacheRefresh>
  /** The history the next turn would hand off; `None` before a projection. */
  readonly window: () => Option.Option<CacheWindow>
}

/** One branch's incremental fold. Feed it that branch's envelopes in id order. */
export const makeCacheScan = (): CacheScan => {
  let lastId = Number.NEGATIVE_INFINITY
  let previous = Option.none<CachedRequest>()
  let refreshed = Option.none<Refresh>()
  let started = Option.none<Begun>()
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
  /** The model and session kind of the last step that named its model. */
  let lastStep = Option.none<{
    readonly model: string
    readonly catalogModel: string
    readonly child: boolean
  }>()
  /** Some step on the branch reported a cache read or write. */
  let cacheReported = false
  /** A compaction since the last request went out: the prefix that request cached is gone. */
  let compactedSince = false
  /** The last projection's estimate and budget. */
  let lastWindow = Option.none<{
    readonly estimatedTokens: number
    readonly availableInputTokens: number
  }>()
  /** The reported input of the step that projection shaped, less its system and tool size. */
  let lastMeasured = Option.none<number>()

  const reset = () => {
    previous = Option.none()
    tools = []
    waits = []
  }

  /** Why a prefix outlived its lifetime: what took the time since the previous request started. */
  const expiredCause = (
    refresh: Refresh,
    gapMs: number,
    input: Option.Option<string>,
  ): CacheMissCause => {
    const response = { name: "response", ms: Math.max(0, refresh.endedAt - refresh.startedAt) }
    if (Option.isSome(covers(Option.some(response), gapMs))) {
      return CacheMissCause.cases.Response.make({ ms: response.ms })
    }
    const sameTurn =
      Option.isSome(input) && Option.isSome(refresh.input) && input.value === refresh.input.value
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

  /** The miss a request with usage paid, against the last request with usage and the last refresh. */
  const scanMiss = (
    envelope: EventEnvelope,
    event: Extract<AgentEvent, { _tag: "StreamEnded" }>,
    begun: Begun,
  ): Option.Option<ScannedMiss> => {
    const usage = Option.fromUndefinedOr(event.usage)
    // A step with no usage (an interrupted stream) has no tokens to compare.
    if (Option.isNone(usage) || usage.value.inputTokens <= 0) return Option.none()
    const promptTokens = usage.value.inputTokens
    const cacheReadTokens = usage.value.cacheReadTokens ?? 0
    const cacheWriteTokens = usage.value.cacheWriteTokens ?? 0
    const model = event.model ?? ""
    const pricedModel = event.pricedModel ?? model
    const reported = cacheReadTokens + cacheWriteTokens > 0
    if (reported) cacheReported = true
    if (cacheWriteTokens > 0) writers.add(model)
    const miss = Option.flatMap(
      Option.all([previous, refreshed]),
      ([prior, refresh]): Option.Option<ScannedMiss> => {
        if (!reported && !prior.reportedCache) return Option.none()
        const missedTokens = Math.min(prior.promptTokens, promptTokens) - cacheReadTokens
        if (missedTokens <= NOISE_FLOOR_TOKENS) return Option.none()
        // The lifetime runs from the start of the last request that went out,
        // as the loop counts it; the lapse names what took that interval.
        const sinceRefreshMs = Math.max(0, begun.at - refresh.startedAt)
        return Option.some({
          eventId: envelope.id,
          startedAt: begun.at,
          model,
          pricedModel,
          missedTokens,
          inputTokens: promptTokens,
          cacheReadTokens,
          cacheWriteTokens,
          cacheWritesByLifetime: event.cacheWritesByLifetime ?? [],
          billed: (event.costUsd ?? 0) > 0,
          sinceRefreshMs,
          modelSwitch: model !== prior.model,
          explicitCache: writers.has(model),
          extensionsChanged: Option.isSome(
            Option.filter(
              Option.all([prior.profileRevision, begun.profileRevision]),
              ([before, now]) => before !== now,
            ),
          ),
          lapse: expiredCause(refresh, sinceRefreshMs, begun.input),
          child: event.child ?? false,
        })
      },
    )
    previous = Option.some({
      promptTokens,
      model,
      profileRevision: begun.profileRevision,
      reportedCache: reported || Option.exists(previous, (prior) => prior.reportedCache),
    })
    return miss
  }

  const settle = (
    envelope: EventEnvelope,
    event: Extract<AgentEvent, { _tag: "StreamEnded" }>,
  ): Option.Option<ScannedMiss> => {
    const begun = Option.getOrElse(started, (): Begun => ({
      at: envelope.createdAt,
      input: Option.fromUndefinedOr(event.messageId),
      profileRevision: Option.none(),
    }))
    started = Option.none()
    const miss = scanMiss(envelope, event, begun)
    // An interrupted step names its model but not its session kind: the
    // session's kind does not change, so the last known one holds.
    Option.map(Option.fromUndefinedOr(event.model), (model) => {
      lastStep = Option.some({
        model,
        catalogModel: event.pricedModel ?? model,
        child:
          event.child ??
          Option.getOrElse(
            Option.map(lastStep, (step) => step.child),
            () => false,
          ),
      })
    })
    // Every request that went out refreshed the cache, with usage or without.
    refreshed = Option.some({
      startedAt: begun.at,
      endedAt: envelope.createdAt,
      input: begun.input,
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
        lastWindow = Option.some({
          estimatedTokens: event.estimatedTokens,
          availableInputTokens: event.availableInputTokens,
        })
        // A new step's projection: the last measure belongs to the step before it.
        lastMeasured = Option.none()
        // A compaction rewrote the context: the next prompt is new content, not a re-bill.
        if (event.compacted) {
          reset()
          compactedSince = true
        }
        return Option.none()
      case "StreamStarted":
        compactedSince = false
        started = Option.some({
          at: envelope.createdAt,
          input: Option.fromUndefinedOr(event.messageId),
          profileRevision: Option.fromUndefinedOr(event.profileRevision),
        })
        return Option.none()
      case "ProviderRetrying":
        // The refused attempt read nothing; the retry goes out `delayMs` later.
        started = Option.map(started, (begun) => ({
          ...begun,
          at: envelope.createdAt + event.delayMs,
        }))
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
      case "StreamEnded": {
        // The loop's step measure: a row with no recorded overhead measures nothing.
        const measured = Option.all([
          Option.fromUndefinedOr(event.usage),
          Option.fromUndefinedOr(event.requestOverheadTokens),
        ]).pipe(Option.map(([usage, overheadTokens]) => usage.inputTokens - overheadTokens))
        if (Option.isSome(measured)) lastMeasured = measured
        return settle(envelope, event)
      }
      default:
        return Option.none()
    }
  }

  const refresh = (): Option.Option<CacheRefresh> => {
    if (!cacheReported || compactedSince) return Option.none()
    const startedAt = Option.orElse(
      Option.map(started, (begun) => begun.at),
      () => Option.map(refreshed, (last) => last.startedAt),
    )
    return Option.map(Option.all([startedAt, lastStep]), ([at, step]) => ({
      startedAt: at,
      model: step.model,
      catalogModel: step.catalogModel,
      child: step.child,
      estimated: !writers.has(step.model),
    }))
  }

  const window = (): Option.Option<CacheWindow> =>
    Option.map(lastWindow, (projected) => ({
      historyTokens: Math.max(
        projected.estimatedTokens,
        Option.getOrElse(lastMeasured, () => 0),
      ),
      availableInputTokens: projected.availableInputTokens,
    }))

  return { fold, refresh, window }
}

// ── cache timer ─────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000

/** The share of the lifetime under which the count turns to the warning color. */
const WARN_SHARE = 0.2

/** How often the timer reads the clock. The label has minute grain. */
const CLOCK_PERIOD = "5 seconds"

/** What the branch's prompt cache holds now, by its lifetime and the model in view. */
export const CacheClock = Schema.TaggedUnion({
  /** The prefix is cached for `leftMs` more of its `ttlMs` lifetime. */
  Warm: { leftMs: Schema.Finite, ttlMs: Schema.Finite },
  /** The lifetime ran out: the next request resends the prefix uncached. */
  Expired: {},
  /** The session runs another model now: its cache holds nothing of this prefix. */
  Switched: {},
})
export type CacheClock = typeof CacheClock.Type

/**
 * The cache's state at `now`. The lifetime runs from the start of the last
 * request, as the loop counts it when it decides a turn starts cold, and the
 * cache belongs to that request's model: another selected model reads cold at
 * once. No refresh, or no lifetime (the catalog names none), says nothing.
 */
export const cacheClock = (
  refresh: Option.Option<CacheRefresh>,
  lifetimeMs: Option.Option<number>,
  selectedModel: string,
  now: number,
): Option.Option<CacheClock> =>
  Option.map(Option.all([refresh, lifetimeMs]), ([last, ttlMs]): CacheClock => {
    if (last.model !== selectedModel) return CacheClock.cases.Switched.make({})
    const elapsedMs = now - last.startedAt
    if (elapsedMs >= ttlMs) return CacheClock.cases.Expired.make({})
    // A retry still waiting to go out starts the lifetime later: it is all left.
    return CacheClock.cases.Warm.make({ leftMs: Math.min(ttlMs, ttlMs - elapsedMs), ttlMs })
  })

/**
 * The status label of a cache clock: `cache 42m`, minutes rounded up, so the
 * number keeps one unit while it falls; `~` when the lifetime is a measured
 * guess; the warning color in the last fifth, and `cache <1m` under a minute.
 * A lapsed cache on a window the next turn hands off says so: that turn
 * compacts before it calls the model.
 */
export const cacheClockLabel = (
  clock: CacheClock,
  opts: { readonly estimated: boolean; readonly compactsNext: boolean },
): StatusLabelItem =>
  CacheClock.match(clock, {
    Warm: (warm): StatusLabelItem => {
      let color: StatusLabelItem["color"] = "textMuted"
      if (warm.leftMs <= warm.ttlMs * WARN_SHARE) color = "warning"
      if (warm.leftMs < MINUTE_MS) return { text: "cache <1m", color: "warning" }
      let mark = ""
      if (opts.estimated) mark = "~"
      return { text: `cache ${mark}${Math.ceil(warm.leftMs / MINUTE_MS)}m`, color }
    },
    Expired: (): StatusLabelItem => {
      if (opts.compactsNext) return { text: "cache cold · next turn compacts", color: "warning" }
      return { text: "cache cold", color: "textMuted" }
    },
    Switched: (): StatusLabelItem => ({ text: "cache cold", color: "textMuted" }),
  })

/**
 * Whether a turn that starts now on this lapsed window hands it off first:
 * the loop's own cost rule (`coldHandoffPays`), over the history that turn
 * would hand off, the model's catalog price and the lifetime its requests
 * ask for. The new prompt is not known yet, and the rule does not count it.
 */
export const handsOffCold = (
  window: Option.Option<CacheWindow>,
  pricing: Option.Option<ModelPricing>,
  cacheTtlMs: number,
): boolean =>
  Option.exists(window, (value) =>
    coldHandoffPays({
      historyTokens: value.historyTokens,
      availableInputTokens: value.availableInputTokens,
      pricing,
      cacheTtlMs,
    }),
  )

// ── price and text ──────────────────────────────────────────────────────────

type ModelPricing = NonNullable<Model["pricing"]>

/**
 * What the miss cost over a cache hit. The re-billed prefix was written to
 * the cache again, so the missed tokens fill this step's cache writes first;
 * the rest paid the uncached input rate. The writes run in prompt order: the
 * ones the driver split by lifetime, longest-lived first (a child's shared
 * prefix writes at the root lifetime), then the rest at the step's lifetime
 * (a child's own). Each part is priced over the cache-read rate it would
 * have paid. A provider that bills no writes (OpenAI) reports none, so every
 * missed token paid the input rate. An unbilled step, or a model the catalog
 * does not price, cost nothing.
 */
export const missCostUsd = (
  miss: CacheMiss,
  pricing: Option.Option<ModelPricing>,
  lifetimeMs: Option.Option<number>,
): number => {
  if (!miss.billed || Option.isNone(pricing)) return 0
  const price = pricing.value
  const readRate = price.cacheRead ?? price.input
  const rewritten = Math.min(miss.missedTokens, miss.cacheWriteTokens)
  const uncached = Math.max(0, miss.missedTokens - rewritten)
  const split = [...miss.cacheWritesByLifetime].sort((a, b) => b.ttlMs - a.ttlMs)
  const splitTokens = split.reduce((sum, write) => sum + write.tokens, 0)
  const writes = [
    ...split.map((write) => ({ tokens: write.tokens, lifetime: Option.some(write.ttlMs) })),
    { tokens: Math.max(0, miss.cacheWriteTokens - splitTokens), lifetime: lifetimeMs },
  ]
  let left = rewritten
  let writeWaste = 0
  for (const write of writes) {
    const tokens = Math.min(left, write.tokens)
    writeWaste += tokens * Math.max(0, cacheWriteRate(price, write.lifetime) - readRate)
    left -= tokens
  }
  const inputWaste = uncached * Math.max(0, price.input - readRate)
  return (writeWaste + inputWaste) / 1_000_000
}

/** pi's rule: a row for a miss of at least 20k tokens or 10 cents. */
export const showsMissRow = (miss: CacheMiss, costUsd: number): boolean =>
  miss.missedTokens >= NOTICE_MIN_TOKENS || costUsd >= NOTICE_MIN_COST_USD

const causeText = CacheMissCause.match({
  ModelSwitch: () => "cache miss after model switch",
  PrefixChanged: () => "cache miss: prefix changed",
  ExtensionsChanged: () => "cache miss after an extension change",
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
  if (costUsd >= 0.01) cost = ` ~${formatCost(costUsd)}`
  return `${causeText(miss.cause)} · ${formatTokens(miss.missedTokens)} tokens re-billed${cost}`
}

// ── client extension ────────────────────────────────────────────────────────

/** The events the fold reads; each names its session and branch. */
const isBranchEvent = AgentEvent.isAnyOf([
  "StreamStarted",
  "ProviderRetrying",
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
  /** What the timer reads: the scan's refresh and window after the last fold. */
  readonly clock: Accessor<BranchClock>
  readonly setClock: Setter<BranchClock>
}

interface BranchClock {
  readonly refresh: Option.Option<CacheRefresh>
  readonly window: Option.Option<CacheWindow>
}

export default defineClientExtension(CACHE_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, lifecycle } = yield* ClientContext
    // The timer's clock: a slow fiber on the client runtime reads `Clock`, so
    // a test clock moves it. The label has minute grain; Solid's equality
    // check keeps a tick that changes no text from drawing.
    const [now, setNow] = createSignal(yield* Clock.currentTimeMillis)
    yield* lifecycle.scoped(
      Effect.forkScoped(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((millis) => Effect.sync(() => setNow(millis))),
          Effect.repeat(Schedule.spaced(CLOCK_PERIOD)),
        ),
      ),
    )
    return createRoot((dispose) => {
      lifecycle.addCleanup(dispose)
      const branches = new Map<string, BranchMisses>()
      const branch = (key: string): BranchMisses => {
        const known = Option.fromUndefinedOr(branches.get(key))
        if (Option.isSome(known)) return known.value
        const [misses, setMisses] = createSignal<ReadonlyArray<ScannedMiss>>([])
        const [clock, setClock] = createSignal<BranchClock>({
          refresh: Option.none(),
          window: Option.none(),
        })
        const created = {
          scan: makeCacheScan(),
          misses,
          setMisses,
          born: new Map(),
          clock,
          setClock,
        }
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
            target.setClock({ refresh: target.scan.refresh(), window: target.scan.window() })
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
        const lifetime = Option.flatMap(model, (entry) => promptCacheTtlMsFor(entry, scanned.child))
        const priced = Option.match(resolveMiss(scanned, lifetime), {
          onNone: (): PricedMiss => ({ costUsd: 0, row: Option.none() }),
          onSome: (miss): PricedMiss => {
            const costUsd = missCostUsd(
              miss,
              Option.flatMap(model, (entry) => Option.fromUndefinedOr(entry.pricing)),
              lifetime,
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
              Option.map(priced(branchKey(transport.currentSession())), (misses) =>
                misses.reduce((sum, miss) => sum + miss.costUsd, 0),
              ),
              () => 0,
            )
            if (total <= 0) return []
            return [{ text: `cache waste ${formatCost(total)}`, color: "textMuted" }]
          },
        }),
        // The time the cached prefix has left: a glance number, so it sits in
        // the right group, before the context gauge, and keeps its place on a
        // narrow row.
        statusLabelContribution({
          priority: 55,
          anchor: "right",
          produce: (): ReadonlyArray<StatusLabelItem> => {
            const state = branch(branchKey(transport.currentSession())).clock()
            const entry = Option.flatMap(
              Option.all([state.refresh, catalogModels()]),
              ([last, catalog]) => Option.fromUndefinedOr(catalog.get(last.catalogModel)),
            )
            const lifetime = Option.flatMap(Option.all([state.refresh, entry]), ([last, model]) =>
              promptCacheTtlMsFor(model, last.child),
            )
            const pricing = Option.flatMap(entry, (model) => Option.fromUndefinedOr(model.pricing))
            const clock = cacheClock(state.refresh, lifetime, transport.selectedModel(), now())
            return Option.toArray(
              Option.map(clock, (value) =>
                cacheClockLabel(value, {
                  estimated: Option.exists(state.refresh, (last) => last.estimated),
                  compactsNext: Option.exists(lifetime, (ttlMs) =>
                    handsOffCold(state.window, pricing, ttlMs),
                  ),
                }),
              ),
            )
          },
        }),
      )
    })
  }),
})
