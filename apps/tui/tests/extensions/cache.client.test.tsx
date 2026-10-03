/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { Clock, Deferred, Effect, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { createSignal } from "solid-js"
import {
  AgentEvent,
  AgentName,
  BranchId,
  dateFromMillis,
  EventEnvelope,
  Message,
  MessageId,
  Model,
  ModelId,
  ProviderId,
  SessionId,
  ToolCallId,
} from "@gent/core/protocol"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import { emptyQueueSnapshot, EventId, testAgent } from "@gent/core/test-utils"
import { CHILD_COMPLETION_TYPE, WAKE_MESSAGE_TYPE } from "@gent/extensions/client"
import cacheExtension, {
  CacheClock,
  cacheClock,
  cacheClockLabel,
  type CacheMiss,
  CacheMissCause,
  type CacheRefresh,
  type CacheScan,
  handsOffCold,
  makeCacheScan,
  missCostUsd,
  missText,
  resolveMiss,
  showsMissRow,
} from "../../src/extensions/cache.client"
import type { AnyExtensionClientModule, NoticeRow } from "../../src/extensions/client-facets"
import { App } from "../../src/app"
import { provideClientServices } from "../extension-test-harness-boundary"
import { createMockClient, createMockRuntime, renderScoped } from "../render-harness-boundary"
import { waitForFrame, waitForTerminal, waitUntil } from "../helpers-boundary"

// ── history builder ─────────────────────────────────────────────────────────

const sessionId = SessionId.make("session-cache")
const branchId = BranchId.make("branch-cache")
const SONNET = ModelId.make("anthropic/claude-sonnet-5")
const OPUS = ModelId.make("anthropic/claude-opus-5")
const GPT = ModelId.make("openai/gpt-5.5")
const SECOND = 1000
const MINUTE = 60 * SECOND

/** The cache lifetime both drivers name for their models. */
const CACHE_LIFETIME_MS = 5 * MINUTE
/** The input budget the loop projects for a 1M window less its 32k output reserve. */
const WIDE_BUDGET_TOKENS = 968_000
/** The lifetime a root step writes at; these models price every write alike. */
const ROOT_LIFETIME = Option.some(CACHE_LIFETIME_MS)

/** $/M: sonnet-5 as the catalog prices it; gpt with reads only, as OpenAI bills. */
const models = [
  new Model({
    id: SONNET,
    name: "Sonnet 5",
    provider: ProviderId.make("anthropic"),
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    promptCacheTtlMs: CACHE_LIFETIME_MS,
  }),
  new Model({
    id: GPT,
    name: "GPT 5.5",
    provider: ProviderId.make("openai"),
    pricing: { input: 1.25, output: 10, cacheRead: 0.125 },
    promptCacheTtlMs: CACHE_LIFETIME_MS,
  }),
]
const catalogEntry = (model: string) =>
  Option.fromUndefinedOr(models.find((entry) => entry.id === model))
const priceOf = (model: string) =>
  Option.flatMap(catalogEntry(model), (entry) => Option.fromUndefinedOr(entry.pricing))

/**
 * Every counted miss in one branch's history, in order: one scan over the
 * envelopes, each miss judged by the lifetime `lifetimeOf` names for the
 * model it was priced by (the test catalog's by default).
 */
const scanCacheMisses = (
  envelopes: Iterable<EventEnvelope>,
  lifetimeOf: (model: string) => Option.Option<number> = (model) =>
    Option.flatMap(catalogEntry(model), (entry) => Option.fromUndefinedOr(entry.promptCacheTtlMs)),
): ReadonlyArray<CacheMiss> => {
  const scan = makeCacheScan()
  const misses: Array<CacheMiss> = []
  for (const envelope of envelopes) {
    const miss = Option.flatMap(scan.fold(envelope), (scanned) =>
      resolveMiss(scanned, lifetimeOf(scanned.pricedModel)),
    )
    if (Option.isSome(miss)) misses.push(miss.value)
  }
  return misses
}

interface Usage {
  readonly inputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** A branch history written in order, one envelope per event, stamped at the given time. */
const makeHistory = () => {
  const envelopes: Array<EventEnvelope> = []
  const at = (createdAt: number, event: AgentEvent) => {
    envelopes.push(EventEnvelope.make({ id: EventId.make(envelopes.length + 1), createdAt, event }))
  }
  const input = (createdAt: number, turn: string, customType?: string) =>
    at(
      createdAt,
      AgentEvent.cases.MessageReceived.make({
        message: Message.cases.regular.make({
          id: MessageId.make(turn),
          sessionId,
          branchId,
          role: "user",
          parts: [],
          createdAt: dateFromMillis(createdAt),
          metadata: Option.getOrUndefined(
            Option.map(Option.fromUndefinedOr(customType), (type) => ({ customType: type })),
          ),
        }),
      }),
    )
  const step = (opts: {
    readonly start: number
    readonly end: number
    readonly turn: string
    readonly usage: Usage
    readonly model?: ModelId
    readonly pricedModel?: ModelId
    readonly costUsd?: number
    /** The cache writes the driver split by lifetime. */
    readonly cacheWritesByLifetime?: ReadonlyArray<{
      readonly ttlMs: number
      readonly tokens: number
    }>
    /** The step ran in a spawned child session. */
    readonly child?: boolean
    /** Refused attempts inside the step: when each was refused, and the delay before its retry. */
    readonly retries?: ReadonlyArray<{ readonly at: number; readonly delayMs: number }>
  }) => {
    at(
      opts.start,
      AgentEvent.cases.StreamStarted.make({
        sessionId,
        branchId,
        messageId: MessageId.make(opts.turn),
        step: 1,
      }),
    )
    for (const refused of opts.retries ?? []) retry(refused.at, refused.delayMs)
    at(
      opts.end,
      AgentEvent.cases.StreamEnded.make({
        sessionId,
        branchId,
        messageId: MessageId.make(opts.turn),
        step: 1,
        usage: { outputTokens: 100, ...opts.usage },
        model: opts.model ?? SONNET,
        pricedModel: opts.pricedModel ?? opts.model ?? SONNET,
        costUsd: opts.costUsd ?? 0.05,
        child: opts.child,
        cacheWritesByLifetime: opts.cacheWritesByLifetime,
      }),
    )
  }
  const tool = (start: number, end: number, name: string, parent?: string) => {
    const toolCallId = ToolCallId.make(`${name}-${start}`)
    const parentToolCallId = Option.getOrUndefined(
      Option.map(Option.fromUndefinedOr(parent), (id) => ToolCallId.make(id)),
    )
    at(
      start,
      AgentEvent.cases.ToolCallStarted.make({
        sessionId,
        branchId,
        toolCallId,
        toolName: name,
        parentToolCallId,
      }),
    )
    at(
      end,
      AgentEvent.cases.ToolCallSucceeded.make({
        sessionId,
        branchId,
        toolCallId,
        toolName: name,
        parentToolCallId,
      }),
    )
  }
  const approval = (start: number, end: number) => {
    const requestId = InteractionRequestId.make(`approval-${start}`)
    at(
      start,
      AgentEvent.cases.InteractionPresented.make({ sessionId, branchId, requestId, text: "run?" }),
    )
    at(
      end,
      AgentEvent.cases.InteractionResolved.make({ sessionId, branchId, requestId, approved: true }),
    )
  }
  /** A request the reader interrupted: it went out, and its stream reported no usage. */
  const interrupted = (start: number, end: number, turn: string) => {
    at(
      start,
      AgentEvent.cases.StreamStarted.make({
        sessionId,
        branchId,
        messageId: MessageId.make(turn),
        step: 1,
      }),
    )
    at(
      end,
      AgentEvent.cases.StreamEnded.make({
        sessionId,
        branchId,
        messageId: MessageId.make(turn),
        step: 1,
        model: SONNET,
        interrupted: true,
      }),
    )
  }
  /** The provider refused the request; the loop retries it `delayMs` later. */
  const retry = (createdAt: number, delayMs: number) =>
    at(
      createdAt,
      AgentEvent.cases.ProviderRetrying.make({
        sessionId,
        branchId,
        attempt: 1,
        maxAttempts: 3,
        delayMs,
        error: "rate limited",
      }),
    )
  const compaction = (createdAt: number) =>
    at(
      createdAt,
      AgentEvent.cases.ModelContextProjected.make({
        sessionId,
        branchId,
        estimatedTokens: 8000,
        availableInputTokens: 100_000,
        contextLimitTokens: 200_000,
        omittedMessages: 12,
        compacted: true,
      }),
    )
  /** A projection that compacted nothing: the window the step saw. */
  const projected = (createdAt: number, estimatedTokens: number) =>
    at(
      createdAt,
      AgentEvent.cases.ModelContextProjected.make({
        sessionId,
        branchId,
        estimatedTokens,
        availableInputTokens: WIDE_BUDGET_TOKENS,
        contextLimitTokens: 1_000_000,
        omittedMessages: 0,
        compacted: false,
      }),
    )
  return {
    envelopes,
    input,
    step,
    interrupted,
    tool,
    approval,
    compaction,
    projected,
    retry,
  }
}

/** The first step caches a 30k prefix; every scenario starts from it. */
const cachedFirstStep = () => {
  const history = makeHistory()
  history.input(0, "t1")
  history.step({
    start: 1 * SECOND,
    end: 10 * SECOND,
    turn: "t1",
    usage: { inputTokens: 30_000, cacheWriteTokens: 30_000 },
  })
  return history
}

const onlyMiss = (misses: ReadonlyArray<CacheMiss>): CacheMiss => {
  expect(misses.length).toBe(1)
  return Option.getOrThrow(Option.fromUndefinedOr(misses[0]))
}

/** A second step that read nothing of the 30k prefix and wrote it again. */
const missedStep = { inputTokens: 32_000, cacheWriteTokens: 32_000 }

// ── fold: causes ────────────────────────────────────────────────────────────

describe("scanCacheMisses", () => {
  it.live("a cell call longer than the TTL between two steps of a turn names the cell", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      const cellEnd = 11 * SECOND + 7 * MINUTE
      history.tool(11 * SECOND, cellEnd, "cell")
      // A call the cell admitted runs inside the cell's span; it is not the cause.
      history.tool(12 * SECOND, 20 * SECOND, "bash", "cell-11000")
      history.step({
        start: cellEnd + SECOND,
        end: cellEnd + 5 * SECOND,
        turn: "t1",
        usage: missedStep,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause).toEqual(
        CacheMissCause.cases.Tool.make({ toolName: "cell", ms: 7 * MINUTE }),
      )
      expect(miss.missedTokens).toBe(30_000)
      // The step wrote the prefix again at 2.5 $/M where a hit reads it at 0.2 $/M.
      expect(missCostUsd(miss, priceOf(SONNET), ROOT_LIFETIME)).toBeCloseTo(
        (30_000 * 2.3) / 1_000_000,
        10,
      )
      expect(missText(miss, missCostUsd(miss, priceOf(SONNET), ROOT_LIFETIME))).toBe(
        "cache expired during 7m cell · 30k tokens re-billed ~$0.07",
      )
    }),
  )

  it.live("a new user turn after the TTL is idle time", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: missedStep,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause._tag).toBe("Idle")
      expect(missText(miss, 0)).toBe("cache expired after 14m idle · 30k tokens re-billed")
    }),
  )

  it.live("a turn a child completion opened says the child ran", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.input(9 * MINUTE, "t2", CHILD_COMPLETION_TYPE)
      history.step({
        start: 9 * MINUTE + 10 * SECOND,
        end: 10 * MINUTE,
        turn: "t2",
        usage: missedStep,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause._tag).toBe("Child")
      expect(missText(miss, 0)).toStartWith("cache expired while a child ran 9m")
    }),
  )

  it.live("a turn a wake opened says so", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.input(20 * MINUTE, "t2", WAKE_MESSAGE_TYPE)
      history.step({
        start: 20 * MINUTE + 10 * SECOND,
        end: 21 * MINUTE,
        turn: "t2",
        usage: missedStep,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause._tag).toBe("Wake")
      expect(missText(miss, 0)).toStartWith("cache expired before the wake, 20m")
    }),
  )

  it.live("an approval wait inside the turn names the wait, not the tool that asked", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      const end = 12 * SECOND + 12 * MINUTE
      history.approval(12 * SECOND, end)
      history.tool(11 * SECOND, end + SECOND, "bash")
      history.step({
        start: end + 2 * SECOND,
        end: end + 9 * SECOND,
        turn: "t1",
        usage: missedStep,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause).toEqual(CacheMissCause.cases.Approval.make({ ms: 12 * MINUTE }))
      expect(missText(miss, 0)).toStartWith("cache expired waiting 12m for approval")
    }),
  )

  it.live("a gap inside a turn with nothing in it is a pause", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.step({ start: 52 * MINUTE, end: 53 * MINUTE, turn: "t1", usage: missedStep })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause._tag).toBe("Paused")
      expect(missText(miss, 0)).toStartWith("cache expired while the turn paused 51m")
    }),
  )

  it.live("a model switch counts, whatever the age", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.step({
        start: 20 * SECOND,
        end: 30 * SECOND,
        turn: "t1",
        usage: missedStep,
        model: OPUS,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause._tag).toBe("ModelSwitch")
      expect(missText(miss, 0)).toStartWith("cache miss after model switch")
    }),
  )

  it.live("a model whose catalog names no cache lifetime counts only a model switch", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.step({ start: 20 * SECOND, end: 30 * SECOND, turn: "t1", usage: missedStep })
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: missedStep,
      })
      history.step({
        start: 15 * MINUTE + 10 * SECOND,
        end: 16 * MINUTE,
        turn: "t2",
        usage: missedStep,
        model: OPUS,
      })
      const misses = scanCacheMisses(history.envelopes, () => Option.none())
      expect(misses.map((miss) => miss.cause._tag)).toEqual(["ModelSwitch"])
    }),
  )

  it.live("a response that took most of the lifetime names the response, not a short pause", () =>
    Effect.sync(() => {
      const history = makeHistory()
      history.input(0, "t1")
      const responseEnd = SECOND + 7 * MINUTE
      history.step({
        start: SECOND,
        end: responseEnd,
        turn: "t1",
        usage: { inputTokens: 30_000, cacheWriteTokens: 30_000 },
      })
      // One second after the long response ended, 7m after it started.
      history.step({
        start: responseEnd + SECOND,
        end: responseEnd + 5 * SECOND,
        turn: "t1",
        usage: missedStep,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause).toEqual(CacheMissCause.cases.Response.make({ ms: 7 * MINUTE }))
      expect(missText(miss, 0)).toBe("cache expired during a 7m response · 30k tokens re-billed")
    }),
  )

  it.live("the lifetime runs from the previous request's start, so its response uses it up", () =>
    Effect.sync(() => {
      const history = makeHistory()
      history.input(0, "t1")
      const responseEnd = SECOND + MINUTE
      history.step({
        start: SECOND,
        end: responseEnd,
        turn: "t1",
        usage: { inputTokens: 30_000, cacheWriteTokens: 30_000 },
      })
      // 4m30s after the response ended, 5m31s after its request started.
      const nextStart = responseEnd + 4 * MINUTE + 30 * SECOND
      history.input(nextStart - SECOND, "t2")
      history.step({ start: nextStart, end: nextStart + 5 * SECOND, turn: "t2", usage: missedStep })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause).toEqual(CacheMissCause.cases.Idle.make({ ms: nextStart - SECOND }))
    }),
  )

  it.live("an interrupted request with no usage still restarts the lifetime", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      // The request went out 4m10s in and read the cache, then was interrupted.
      history.input(4 * MINUTE, "t2")
      history.interrupted(4 * MINUTE + 10 * SECOND, 4 * MINUTE + 20 * SECOND, "t2")
      // 6m10s after the first request, 2m after the interrupted one.
      history.input(6 * MINUTE, "t3")
      history.step({
        start: 6 * MINUTE + 10 * SECOND,
        end: 7 * MINUTE,
        turn: "t3",
        usage: missedStep,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause._tag).toBe("PrefixChanged")
    }),
  )

  it.live("a retried request restarts the lifetime when the retry goes out", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.input(4 * MINUTE, "t2")
      // Refused at once, retried 3m later: the retry reads the whole prefix.
      const retryAt = 4 * MINUTE + 5 * SECOND + 3 * MINUTE
      history.step({
        start: 4 * MINUTE,
        retries: [{ at: 4 * MINUTE + 5 * SECOND, delayMs: 3 * MINUTE }],
        end: retryAt + 10 * SECOND,
        turn: "t2",
        usage: { inputTokens: 31_000, cacheReadTokens: 30_000, cacheWriteTokens: 1_000 },
      })
      // 5m30s after the refused attempt, 2m25s after the retry.
      history.input(9 * MINUTE + 20 * SECOND, "t3")
      history.step({
        start: 9 * MINUTE + 30 * SECOND,
        end: 10 * MINUTE,
        turn: "t3",
        usage: missedStep,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause._tag).toBe("PrefixChanged")
    }),
  )

  it.live("a miss inside the TTL on the same model is a changed prefix", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      // The response (9s) and the idle after it fill the lifetime exactly: still inside it.
      history.step({
        start: 1 * SECOND + CACHE_LIFETIME_MS,
        end: 2 * SECOND + CACHE_LIFETIME_MS,
        turn: "t1",
        usage: missedStep,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause._tag).toBe("PrefixChanged")
      expect(missText(miss, 0)).toStartWith("cache miss: prefix changed")
    }),
  )
})

// ── fold: what does not count ───────────────────────────────────────────────

describe("scanCacheMisses counts only a lost prefix", () => {
  it.live("a compaction between the steps resets the fold", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.input(14 * MINUTE, "t2")
      history.compaction(14 * MINUTE + 500)
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: missedStep,
      })
      expect(scanCacheMisses(history.envelopes)).toEqual([])
    }),
  )

  it.live("a branch that never reported cache activity stays silent", () =>
    Effect.sync(() => {
      const history = makeHistory()
      history.input(0, "t1")
      history.step({ start: SECOND, end: 10 * SECOND, turn: "t1", usage: { inputTokens: 30_000 } })
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: { inputTokens: 32_000 },
      })
      expect(scanCacheMisses(history.envelopes)).toEqual([])
    }),
  )

  // OpenAI caches implicitly and reports reads only: a request reads the
  // cache when it reaches a server that holds the prefix. Probe, Codex
  // gpt-5.6-luna, 2026-09-23: with the session-id header 17 of 36 later
  // steps read, and a step that read was followed by one that read nothing
  // on the same prefix. A zero read inside the lifetime is then no evidence
  // that the prefix changed.
  it.live("a reads-only provider's zero read inside the lifetime is not a changed prefix", () =>
    Effect.sync(() => {
      const history = makeHistory()
      history.input(0, "t1")
      history.step({
        start: SECOND,
        end: 10 * SECOND,
        turn: "t1",
        usage: { inputTokens: 30_000 },
        model: GPT,
      })
      history.step({
        start: 20 * SECOND,
        end: 30 * SECOND,
        turn: "t1",
        usage: { inputTokens: 31_000, cacheReadTokens: 29_500 },
        model: GPT,
      })
      history.step({
        start: 40 * SECOND,
        end: 50 * SECOND,
        turn: "t1",
        usage: { inputTokens: 32_000 },
        model: GPT,
      })
      expect(scanCacheMisses(history.envelopes)).toEqual([])
    }),
  )

  it.live("a miss of 1,024 tokens or fewer is noise", () =>
    Effect.sync(() => {
      const atFloor = cachedFirstStep()
      atFloor.step({
        start: 20 * SECOND,
        end: 30 * SECOND,
        turn: "t1",
        usage: { inputTokens: 32_000, cacheReadTokens: 30_000 - 1024, cacheWriteTokens: 3024 },
      })
      expect(scanCacheMisses(atFloor.envelopes)).toEqual([])
      const overFloor = cachedFirstStep()
      overFloor.step({
        start: 20 * SECOND,
        end: 30 * SECOND,
        turn: "t1",
        usage: { inputTokens: 32_000, cacheReadTokens: 30_000 - 1025, cacheWriteTokens: 3025 },
      })
      expect(onlyMiss(scanCacheMisses(overFloor.envelopes)).missedTokens).toBe(1025)
    }),
  )
})

// ── pricing and threshold ───────────────────────────────────────────────────

describe("cache miss price", () => {
  it.live("a reads-only provider counts a zero-read step once it has reported a read", () =>
    Effect.sync(() => {
      const history = makeHistory()
      history.input(0, "t1")
      history.step({
        start: SECOND,
        end: 10 * SECOND,
        turn: "t1",
        usage: { inputTokens: 30_000 },
        model: GPT,
      })
      history.step({
        start: 20 * SECOND,
        end: 30 * SECOND,
        turn: "t1",
        usage: { inputTokens: 31_000, cacheReadTokens: 29_500 },
        model: GPT,
      })
      history.input(10 * MINUTE, "t2")
      history.step({
        start: 10 * MINUTE + SECOND,
        end: 11 * MINUTE,
        turn: "t2",
        usage: { inputTokens: 33_000 },
        model: GPT,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.missedTokens).toBe(31_000)
      // No write billing: the missed tokens paid the input rate instead of the read rate.
      expect(missCostUsd(miss, priceOf(GPT), ROOT_LIFETIME)).toBeCloseTo(
        (31_000 * (1.25 - 0.125)) / 1_000_000,
        10,
      )
    }),
  )

  it.live("the missed tokens are the re-written prefix first, then uncached input", () =>
    Effect.sync(() => {
      // 30k cached before; this step read 10k, wrote 20k and sent 10k uncached.
      const history = cachedFirstStep()
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: { inputTokens: 40_000, cacheReadTokens: 10_000, cacheWriteTokens: 20_000 },
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.missedTokens).toBe(20_000)
      // All 20k were written again at 2.50 $/M where a hit reads them at 0.20 $/M.
      expect(missCostUsd(miss, priceOf(SONNET), ROOT_LIFETIME)).toBeCloseTo(0.046, 10)
      // Past the writes, the rest paid the input rate.
      expect(
        missCostUsd({ ...miss, missedTokens: 25_000 }, priceOf(SONNET), ROOT_LIFETIME),
      ).toBeCloseTo((20_000 * 2.3 + 5000 * 1.8) / 1_000_000, 10)
    }),
  )

  it.live("a rewrite the driver split by lifetime is priced at each lifetime's rate", () =>
    Effect.sync(() => {
      // A child asks for 5 minutes, but its shared prefix writes at one hour.
      const pricing = Option.some({
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 4,
        cacheWriteByLifetime: [
          { ttlMs: 5 * MINUTE, price: 2.5 },
          { ttlMs: 60 * MINUTE, price: 4 },
        ],
      })
      const childLifetime = Option.some(5 * MINUTE)
      const history = cachedFirstStep()
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: { inputTokens: 30_000, cacheWriteTokens: 30_000 },
        cacheWritesByLifetime: [
          { ttlMs: 60 * MINUTE, tokens: 20_000 },
          { ttlMs: 5 * MINUTE, tokens: 10_000 },
        ],
        child: true,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      // 20k rewritten at 4 $/M and 10k at 2.5 $/M, each over the 0.2 $/M read.
      expect(missCostUsd(miss, pricing, childLifetime)).toBeCloseTo(
        (20_000 * 3.8 + 10_000 * 2.3) / 1_000_000,
        10,
      )
      // The prefix is written first, and the longest-lived entry leads it.
      expect(missCostUsd({ ...miss, missedTokens: 20_000 }, pricing, childLifetime)).toBeCloseTo(
        (20_000 * 3.8) / 1_000_000,
        10,
      )
    }),
  )

  it.live("a step a driver routed is priced by the model the runtime priced it by", () =>
    Effect.sync(() => {
      const PROXIED = ModelId.make("proxy/claude-sonnet-5")
      const history = makeHistory()
      history.input(0, "t1")
      history.step({
        start: SECOND,
        end: 10 * SECOND,
        turn: "t1",
        usage: { inputTokens: 30_000, cacheWriteTokens: 30_000 },
        model: PROXIED,
        pricedModel: SONNET,
      })
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: missedStep,
        model: PROXIED,
        pricedModel: SONNET,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(miss.cause._tag).toBe("Idle")
      expect(miss.pricedModel).toBe(SONNET)
    }),
  )

  it.live("an unbilled step or an unpriced model costs nothing", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: missedStep,
        costUsd: 0,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(missCostUsd(miss, priceOf(SONNET), ROOT_LIFETIME)).toBe(0)
      expect(missCostUsd({ ...miss, billed: true }, Option.none(), ROOT_LIFETIME)).toBe(0)
    }),
  )

  it.live("a row shows for 20k tokens or 10 cents", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: missedStep,
      })
      const miss = onlyMiss(scanCacheMisses(history.envelopes))
      expect(showsMissRow({ ...miss, missedTokens: 19_999 }, 0.09)).toBe(false)
      expect(showsMissRow({ ...miss, missedTokens: 20_000 }, 0)).toBe(true)
      expect(showsMissRow({ ...miss, missedTokens: 5000 }, 0.1)).toBe(true)
    }),
  )
})

// ── replay ──────────────────────────────────────────────────────────────────

describe("cache scan replay", () => {
  it.live("the same history folded twice adds each miss once", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: missedStep,
      })
      const scan: CacheScan = makeCacheScan()
      const fold = () =>
        history.envelopes.flatMap((envelope) => Option.toArray(scan.fold(envelope)))
      expect(fold().length).toBe(1)
      expect(fold()).toEqual([])
    }),
  )
})

/** A history with one shown miss (idle, 30k tokens) and one counted below the row threshold. */
const twoMissHistory = () => {
  const history = cachedFirstStep()
  history.input(14 * MINUTE, "t2")
  history.step({
    start: 14 * MINUTE + 10 * SECOND,
    end: 15 * MINUTE,
    turn: "t2",
    usage: missedStep,
  })
  history.input(30 * MINUTE, "t3")
  history.step({
    start: 30 * MINUTE + SECOND,
    end: 31 * MINUTE,
    turn: "t3",
    usage: { inputTokens: 34_000, cacheReadTokens: 30_000, cacheWriteTokens: 4000 },
  })
  return history
}

const rowsOf = (rows: Option.Option<ReadonlyArray<NoticeRow>>) => Option.getOrThrow(rows)

/**
 * The client extension with a catalog the test sets, fed one history. The
 * session runs `selected` (Sonnet unless the test switches it); the timer
 * reads `clock`, a test clock at 0 unless the test passes its own.
 */
const setupWithCatalog = (
  initial: Option.Option<ReadonlyArray<Model>>,
  opts: { readonly clock?: TestClock.TestClock } = {},
) =>
  Effect.gen(function* () {
    const subscribers = new Set<(envelope: EventEnvelope) => void>()
    const session = { sessionId, branchId }
    const [catalog, setCatalog] = createSignal(initial)
    const [selected, setSelected] = createSignal<string>(SONNET)
    const clock = opts.clock ?? (yield* TestClock.make())
    const contributions = yield* provideClientServices(
      cacheExtension.setup.pipe(Effect.provideService(Clock.Clock, clock)),
      {
        currentSession: () => session,
        sessionEventSubscribers: subscribers,
        modelCatalog: catalog,
        selectedModel: selected,
      },
    )
    const deliver = (envelopes: ReadonlyArray<EventEnvelope>) => {
      for (const envelope of envelopes) for (const cb of subscribers) cb(envelope)
    }
    const [notices] = contributions.noticeRows ?? []
    const [label, timer] = contributions.statusLabels ?? []
    return {
      deliver,
      setCatalog,
      setSelected,
      rows: () => Option.flatten(Option.fromUndefinedOr(notices?.rows(session))),
      label: () => label?.produce() ?? [],
      /** The timer's text, or `none` when it draws nothing. */
      timer: () => {
        const items = timer?.produce() ?? []
        if (items.length === 0) return "none"
        return items.map((item) => `${item.text} [${String(item.color)}]`).join(" ")
      },
      timerAnchor: timer?.anchor,
    }
  })

describe("cache client extension", () => {
  it.scopedLive("a routed step's row carries the price of the model the runtime priced", () =>
    Effect.gen(function* () {
      const PROXIED = ModelId.make("proxy/claude-sonnet-5")
      const extension = yield* setupWithCatalog(Option.some(models))
      const history = makeHistory()
      history.input(0, "t1")
      history.step({
        start: SECOND,
        end: 10 * SECOND,
        turn: "t1",
        usage: { inputTokens: 30_000, cacheWriteTokens: 30_000 },
        model: PROXIED,
        pricedModel: SONNET,
      })
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: missedStep,
        model: PROXIED,
        pricedModel: SONNET,
      })
      extension.deliver(history.envelopes)
      expect(rowsOf(extension.rows()).map((row) => row.text)).toEqual([
        "cache expired after 14m idle · 30k tokens re-billed ~$0.07",
      ])
      expect(extension.label()).toEqual([{ text: "cache waste $0.07", color: "textMuted" }])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a total under a cent is spelled as a cost, never as $0.00", () =>
    Effect.gen(function* () {
      const extension = yield* setupWithCatalog(Option.some(models))
      const history = makeHistory()
      history.input(0, "t1")
      history.step({
        start: SECOND,
        end: 10 * SECOND,
        turn: "t1",
        usage: { inputTokens: 1_100, cacheWriteTokens: 1_100 },
        model: SONNET,
      })
      history.input(14 * MINUTE, "t2")
      history.step({
        start: 14 * MINUTE + 10 * SECOND,
        end: 15 * MINUTE,
        turn: "t2",
        usage: { inputTokens: 1_200, cacheWriteTokens: 1_200 },
        model: SONNET,
      })
      extension.deliver(history.envelopes)
      // 1.1k missed tokens re-billed at 2.3 $/M: a quarter of a cent.
      expect(extension.label()).toEqual([{ text: "cache waste $0.003", color: "textMuted" }])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a child's step is judged by the child lifetime, a root's by the root's", () =>
    Effect.gen(function* () {
      // A root keeps its prompt an hour and writes it at 4 $/M, a child
      // 5 minutes at 2.5 $/M.
      const lifetimes = models.map(
        (model) =>
          new Model({
            ...model,
            promptCacheTtlMs: 60 * MINUTE,
            childPromptCacheTtlMs: 5 * MINUTE,
            pricing: {
              input: 2,
              output: 10,
              cacheRead: 0.2,
              cacheWrite: 4,
              cacheWriteByLifetime: [
                { ttlMs: 5 * MINUTE, price: 2.5 },
                { ttlMs: 60 * MINUTE, price: 4 },
              ],
            },
          }),
      )
      // Two steps of one turn with a 6-minute approval wait between them.
      const waitedHistory = (child: boolean) => {
        const history = makeHistory()
        history.input(0, "t1")
        history.step({
          start: SECOND,
          end: 10 * SECOND,
          turn: "t1",
          usage: { inputTokens: 30_000, cacheWriteTokens: 30_000 },
          child,
        })
        history.approval(11 * SECOND, 6 * MINUTE + 11 * SECOND)
        history.step({
          start: 6 * MINUTE + 12 * SECOND,
          end: 6 * MINUTE + 20 * SECOND,
          turn: "t1",
          usage: missedStep,
          child,
        })
        return history
      }
      const rowsFor = (child: boolean) =>
        Effect.gen(function* () {
          const extension = yield* setupWithCatalog(Option.some(lifetimes))
          extension.deliver(waitedHistory(child).envelopes)
          return rowsOf(extension.rows()).map((row) => row.text)
        })
      // Each rewrote 30k tokens at its own lifetime's write rate: 2.3 and 3.8 $/M over a read.
      expect(yield* rowsFor(true)).toEqual([
        "cache expired waiting 6m for approval · 30k tokens re-billed ~$0.07",
      ])
      expect(yield* rowsFor(false)).toEqual([
        "cache miss: prefix changed · 30k tokens re-billed ~$0.11",
      ])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a catalog that names no cache lifetime draws no expiry row", () =>
    Effect.gen(function* () {
      const unnamed = models.map(
        ({ id, name, provider, pricing }) => new Model({ id, name, provider, pricing }),
      )
      const extension = yield* setupWithCatalog(Option.some(unnamed))
      extension.deliver(twoMissHistory().envelopes)
      expect(rowsOf(extension.rows())).toEqual([])
      expect(extension.label()).toEqual([])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("rows wait for the catalog, then are born priced and never change", () =>
    Effect.gen(function* () {
      const extension = yield* setupWithCatalog(Option.none())
      extension.deliver(twoMissHistory().envelopes)
      // No catalog yet: the source cannot say what its rows are.
      expect(Option.isNone(extension.rows())).toBe(true)
      expect(extension.label()).toEqual([])
      extension.setCatalog(Option.some(models))
      const [born] = rowsOf(extension.rows())
      expect(born?.text).toBe("cache expired after 14m idle · 30k tokens re-billed ~$0.07")
      // A catalog reload with other prices leaves the row it drew as it was.
      const doubled = models.map(
        (model) =>
          new Model({
            ...model,
            pricing: Option.getOrUndefined(
              Option.map(Option.fromUndefinedOr(model.pricing), (pricing) => ({
                ...pricing,
                cacheWrite: 10,
              })),
            ),
          }),
      )
      extension.setCatalog(Option.some(doubled))
      const [after] = rowsOf(extension.rows())
      expect(after).toBe(born)
      expect(extension.label()).toEqual([{ text: "cache waste $0.07", color: "textMuted" }])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("replayed then live envelopes draw one row and total every miss", () =>
    Effect.gen(function* () {
      const subscribers = new Set<(envelope: EventEnvelope) => void>()
      const session = { sessionId, branchId }
      const contributions = yield* provideClientServices(cacheExtension.setup, {
        currentSession: () => session,
        sessionEventSubscribers: subscribers,
        modelCatalog: () => Option.some(models),
      })
      const history = twoMissHistory()
      // The feed replays from the start on mount, then a reconnect delivers the same ids live.
      for (const _pass of [1, 2]) {
        for (const envelope of history.envelopes) for (const cb of subscribers) cb(envelope)
      }
      const [notices] = contributions.noticeRows ?? []
      const rows = rowsOf(
        Option.flatMap(Option.fromUndefinedOr(notices), (source) => source.rows(session)),
      )
      expect(rows.map((row) => row.text)).toEqual([
        "cache expired after 14m idle · 30k tokens re-billed ~$0.07",
      ])
      expect(rows[0]?.glyph).toBe("◌")
      expect(rows[0]?.color).toBe("warning")
      // The row sits where the paying request started, ahead of that step's answer.
      expect(rows[0]?.createdAt).toBe(14 * MINUTE + 10 * SECOND)
      const [label] = contributions.statusLabels ?? []
      // 30k + 2k missed tokens, each re-billed at 2.3 $/M.
      expect(label?.produce()).toEqual([{ text: "cache waste $0.07", color: "textMuted" }])
      const misses = scanCacheMisses(history.envelopes)
      expect(misses.length).toBe(2)
      const total = misses.reduce(
        (sum, miss) => sum + missCostUsd(miss, priceOf(SONNET), ROOT_LIFETIME),
        0,
      )
      expect(total).toBeCloseTo((32_000 * 2.3) / 1_000_000, 10)
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a resumed session draws the miss row in the transcript", () =>
    Effect.gen(function* () {
      const setup = yield* renderResumed({
        catalog: Effect.succeed(models),
        extension: cacheExtension,
      })
      yield* waitForTerminal(setup.rendered, (text) => text.includes(`◌ ${IDLE_ROW}`), "miss row")
      yield* waitForFrame(
        setup.rendered,
        (frame) => frame.includes("cache waste $0.07"),
        "status total",
      )
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.scopedLive("an extension that loads after the feed opened still draws the resumed rows", () =>
    Effect.gen(function* () {
      const loaded = yield* Deferred.make<void>()
      const late = {
        ...cacheExtension,
        setup: Deferred.await(loaded).pipe(Effect.andThen(cacheExtension.setup)),
      }
      const setup = yield* renderResumed({ catalog: Effect.succeed(models), extension: late })
      // The feed opens and replays without waiting for the extension.
      yield* waitForFrame(setup.rendered, () => setup.feedOpened(), "feed open", 4000)
      yield* Deferred.succeed(loaded, void 0)
      yield* waitForTerminal(
        setup.rendered,
        (text) => text.includes(`◌ ${IDLE_ROW}`),
        "miss row",
        4000,
      )
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.scopedLive("a catalog that lands after the feed shows the row once, already priced", () =>
    Effect.gen(function* () {
      const catalogReady = yield* Deferred.make<void>()
      const setup = yield* renderResumed({
        catalog: Deferred.await(catalogReady).pipe(Effect.as(models)),
        extension: cacheExtension,
      })
      const drawn: Array<string> = []
      const record = (frame: string) => {
        for (const line of frame.split("\n")) if (line.includes("◌")) drawn.push(line.trim())
      }
      yield* waitForFrame(setup.rendered, () => setup.feedOpened(), "feed open", 4000)
      // The feed has replayed; the rows wait for the prices.
      for (let pass = 0; pass < 10; pass++) {
        yield* waitForTerminal(setup.rendered, (text) => {
          record(text)
          return true
        })
      }
      expect(drawn).toEqual([])
      yield* Deferred.succeed(catalogReady, void 0)
      yield* waitForTerminal(
        setup.rendered,
        (text) => {
          record(text)
          return text.includes(`◌ ${IDLE_ROW}`)
        },
        "priced miss row",
        4000,
      )
      expect(new Set(drawn)).toEqual(new Set([`◌ ${IDLE_ROW}`]))
    }).pipe(Effect.timeout("8 seconds")),
  )
})

const IDLE_ROW = "cache expired after 14m idle · 30k tokens re-billed ~$0.07"

/** The App resumed on the two-miss history, with the catalog load and the cache extension given. */
const renderResumed = (opts: {
  readonly catalog: Effect.Effect<ReadonlyArray<Model>>
  readonly extension: AnyExtensionClientModule
  /** Terminal columns; 100 unless the test measures the status row. */
  readonly width?: number
}) =>
  Effect.gen(function* () {
    const history = twoMissHistory()
    const lastEventId = history.envelopes.length
    let opened = false
    const client = createMockClient({
      auth: { listProviders: () => Effect.succeed([]) },
      branch: { getTree: () => Effect.succeed([]) },
      model: { list: () => opts.catalog },
      // The shell's catalog holds the models of registered drivers.
      driver: {
        list: () =>
          Effect.succeed({ drivers: [{ id: "anthropic" }], overrides: {}, agents: [testAgent] }),
      },
      session: {
        getSnapshot: () =>
          Effect.succeed({
            sessionId,
            branchId,
            messages: [],
            lastEventId,
            resolvedModelId: SONNET,
            agent: AgentName.make("main"),
            runtime: { _tag: "Idle" satisfies "Idle", queue: emptyQueueSnapshot() },
            metrics: {
              turns: 3,
              durationMs: 0,
              costUsd: 0.15,
              lastInputTokens: 34_000,
              context: {
                estimatedTokens: 62_000,
                availableInputTokens: 200_000,
                contextLimitTokens: 200_000,
                omittedMessages: 0,
                compactions: 0,
              },
            },
          }),
        events: () => {
          opened = true
          return Stream.concat(Stream.make(...history.envelopes), Stream.never)
        },
      },
    })
    // The render closes with the test's scope.
    const rendered = yield* renderScoped(() => <App />, {
      client,
      runtime: createMockRuntime(),
      builtins: [opts.extension],
      width: opts.width ?? 100,
      height: 30,
      initialSession: {
        id: sessionId,
        activeBranchId: branchId,
        name: "Cache",
        createdAt: dateFromMillis(0),
        updatedAt: dateFromMillis(0),
      },
    })
    return { rendered, feedOpened: () => opened }
  })

// ── cache timer ─────────────────────────────────────────────────────────────

const HOUR = 60 * MINUTE

/** A refresh at time 0 on Sonnet, a root step on an explicit cache. */
const refreshAt = (overrides: Partial<CacheRefresh> = {}): Option.Option<CacheRefresh> =>
  Option.some({
    startedAt: 0,
    model: SONNET,
    catalogModel: SONNET,
    child: false,
    estimated: false,
    ...overrides,
  })

/** The label a clock reads as, `none` when there is no clock. */
const labelAt = (
  refresh: Option.Option<CacheRefresh>,
  lifetime: Option.Option<number>,
  now: number,
  opts: { readonly selected?: string; readonly compactsNext?: boolean } = {},
): string =>
  Option.match(cacheClock(refresh, lifetime, opts.selected ?? SONNET, now), {
    onNone: () => "none",
    onSome: (clock) => {
      const item = cacheClockLabel(clock, {
        estimated: Option.exists(refresh, (last) => last.estimated),
        compactsNext: opts.compactsNext ?? false,
      })
      return `${item.text} [${String(item.color)}]`
    },
  })

describe("cache clock", () => {
  test("reads the time left by the lifetime and the model in view", () => {
    const hour = Option.some(HOUR)
    const table: ReadonlyArray<readonly [string, string]> = [
      [labelAt(refreshAt(), hour, 18 * MINUTE), "cache 42m [textMuted]"],
      // The last fifth of the hour turns to the warning color.
      [labelAt(refreshAt(), hour, 47 * MINUTE), "cache 13m [textMuted]"],
      [labelAt(refreshAt(), hour, 48 * MINUTE), "cache 12m [warning]"],
      // Minutes round up: a minute and some left reads 2m.
      [labelAt(refreshAt(), hour, 58 * MINUTE + 30 * SECOND), "cache 2m [warning]"],
      [labelAt(refreshAt(), hour, 59 * MINUTE + 30 * SECOND), "cache <1m [warning]"],
      [labelAt(refreshAt(), hour, HOUR), "cache cold [textMuted]"],
      [labelAt(refreshAt(), hour, 61 * MINUTE), "cache cold [textMuted]"],
      // A measured lifetime is a guess: the count is marked.
      [
        labelAt(refreshAt({ estimated: true }), Option.some(30 * MINUTE), 2 * MINUTE),
        "cache ~28m [textMuted]",
      ],
      // Another model holds nothing of the prefix: cold at once.
      [labelAt(refreshAt(), hour, MINUTE, { selected: OPUS }), "cache cold [textMuted]"],
      // A lapsed cache on a large window: the next turn hands it off first.
      [
        labelAt(refreshAt(), hour, 2 * HOUR, { compactsNext: true }),
        "cache cold · next turn compacts [warning]",
      ],
      // A switch never hands off: the loop's cold check needs the same model.
      [
        labelAt(refreshAt(), hour, MINUTE, { selected: OPUS, compactsNext: true }),
        "cache cold [textMuted]",
      ],
      // A retry still waiting to go out has the whole lifetime left.
      [labelAt(refreshAt({ startedAt: 5 * SECOND }), hour, 0), "cache 60m [textMuted]"],
      // No lifetime, or no refresh: nothing to count.
      [labelAt(refreshAt(), Option.none(), MINUTE), "none"],
      [labelAt(Option.none(), hour, MINUTE), "none"],
    ]
    for (const [actual, expected] of table) expect(actual).toBe(expected)
  })

  test("a five-minute child cache warns in its last minute", () => {
    const five = Option.some(5 * MINUTE)
    expect(labelAt(refreshAt(), five, 3 * MINUTE + 59 * SECOND)).toBe("cache 2m [textMuted]")
    expect(labelAt(refreshAt(), five, 4 * MINUTE)).toBe("cache 1m [warning]")
    expect(labelAt(refreshAt(), five, 4 * MINUTE + 30 * SECOND)).toBe("cache <1m [warning]")
  })

  test("the next turn compacts where the loop's cold cost rule hands off", () => {
    const window = (estimatedTokens: number, availableInputTokens: number) =>
      Option.some({ estimatedTokens, availableInputTokens })
    const sonnet = priceOf(SONNET)
    // A 1M window hands off from the 150k floor, where the summary costs far
    // less than half the resend; a smaller budget from half of it.
    expect(handsOffCold(window(120_000, WIDE_BUDGET_TOKENS), sonnet, CACHE_LIFETIME_MS)).toBe(false)
    expect(handsOffCold(window(149_999, WIDE_BUDGET_TOKENS), sonnet, CACHE_LIFETIME_MS)).toBe(false)
    expect(handsOffCold(window(150_000, WIDE_BUDGET_TOKENS), sonnet, CACHE_LIFETIME_MS)).toBe(true)
    expect(handsOffCold(window(100_000, 180_000), sonnet, CACHE_LIFETIME_MS)).toBe(true)
    expect(handsOffCold(window(89_000, 180_000), sonnet, CACHE_LIFETIME_MS)).toBe(false)
    // An unpriced model hands off on the floor alone.
    expect(
      handsOffCold(window(150_000, WIDE_BUDGET_TOKENS), Option.none(), CACHE_LIFETIME_MS),
    ).toBe(true)
    // An output price that makes the summary dearer than half the resend keeps the window.
    const dearOutput = Option.some({ input: 1, output: 1_000, cacheWrite: 1 })
    expect(handsOffCold(window(200_000, WIDE_BUDGET_TOKENS), dearOutput, CACHE_LIFETIME_MS)).toBe(
      false,
    )
    expect(handsOffCold(Option.none(), sonnet, CACHE_LIFETIME_MS)).toBe(false)
  })

  test("the clock tags are the schema's", () => {
    expect(CacheClock.cases.Expired.make({})._tag).toBe("Expired")
  })
})

/** The refresh the scan holds after `envelopes`. */
const refreshAfter = (envelopes: ReadonlyArray<EventEnvelope>) => {
  const scan = makeCacheScan()
  for (const envelope of envelopes) scan.fold(envelope)
  return Option.map(scan.refresh(), (last) => last.startedAt)
}

describe("cache scan refresh", () => {
  test("the lifetime runs from the last request's start", () => {
    expect(refreshAfter(cachedFirstStep().envelopes)).toEqual(Option.some(SECOND))
  })

  test("a retry moves the start to when the retry went out", () => {
    const history = makeHistory()
    history.input(0, "t1")
    history.step({
      start: SECOND,
      end: 30 * SECOND,
      turn: "t1",
      usage: { inputTokens: 30_000, cacheWriteTokens: 30_000 },
      retries: [{ at: 5 * SECOND, delayMs: 10 * SECOND }],
    })
    expect(refreshAfter(history.envelopes)).toEqual(Option.some(15 * SECOND))
  })

  test("an interrupted request with no usage still restarts the clock", () => {
    const history = cachedFirstStep()
    history.input(MINUTE, "t2")
    history.interrupted(MINUTE + SECOND, MINUTE + 5 * SECOND, "t2")
    expect(refreshAfter(history.envelopes)).toEqual(Option.some(MINUTE + SECOND))
  })

  test("a request in flight counts from its own start", () => {
    const history = cachedFirstStep()
    history.input(MINUTE, "t2")
    history.step({
      start: MINUTE + SECOND,
      end: 2 * MINUTE,
      turn: "t2",
      usage: { inputTokens: 31_000, cacheReadTokens: 30_000 },
    })
    // Without its StreamEnded the second request is still running.
    expect(refreshAfter(history.envelopes.slice(0, -1))).toEqual(Option.some(MINUTE + SECOND))
  })

  test("a compaction clears the clock until the next request goes out", () => {
    const history = cachedFirstStep()
    history.compaction(MINUTE)
    expect(refreshAfter(history.envelopes)).toEqual(Option.none())
    history.step({
      start: MINUTE + SECOND,
      end: 2 * MINUTE,
      turn: "t1",
      usage: { inputTokens: 8_000, cacheWriteTokens: 8_000 },
    })
    expect(refreshAfter(history.envelopes)).toEqual(Option.some(MINUTE + SECOND))
  })

  test("a branch that never reported cache activity has no clock", () => {
    const history = makeHistory()
    history.input(0, "t1")
    history.step({ start: SECOND, end: 10 * SECOND, turn: "t1", usage: { inputTokens: 30_000 } })
    expect(refreshAfter(history.envelopes)).toEqual(Option.none())
  })
})

describe("cache timer label", () => {
  it.scopedLive("the label counts down on the client clock, then reads cold", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      const extension = yield* setupWithCatalog(Option.some(models), { clock })
      expect(extension.timerAnchor).toBe("right")
      expect(extension.timer()).toBe("none")
      // The first request went out at 1s and wrote the 5-minute cache.
      yield* clock.adjust("1 second")
      extension.deliver(cachedFirstStep().envelopes)
      yield* waitUntil(() => extension.timer() === "cache 5m [textMuted]", "a fresh cache")
      // Each step moves the test clock once, to a tick of the timer's 5-second
      // fiber: the label shows the clock as of its last tick.
      yield* clock.adjust("64 seconds")
      yield* waitUntil(() => extension.timer() === "cache 4m [textMuted]", "a minute later")
      yield* clock.adjust("210 seconds")
      yield* waitUntil(() => extension.timer() === "cache <1m [warning]", "the last half minute")
      yield* clock.adjust("30 seconds")
      yield* waitUntil(() => extension.timer() === "cache cold [textMuted]", "the lifetime ran out")
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a model switch reads cold before any request goes out", () =>
    Effect.gen(function* () {
      const extension = yield* setupWithCatalog(Option.some(models))
      extension.deliver(cachedFirstStep().envelopes)
      expect(extension.timer()).toBe("cache 5m [textMuted]")
      extension.setSelected(OPUS)
      expect(extension.timer()).toBe("cache cold [textMuted]")
      extension.setSelected(SONNET)
      expect(extension.timer()).toBe("cache 5m [textMuted]")
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a child's step counts the child lifetime, a root's the root's", () =>
    Effect.gen(function* () {
      const lifetimes = models.map(
        (model) =>
          new Model({ ...model, promptCacheTtlMs: HOUR, childPromptCacheTtlMs: 5 * MINUTE }),
      )
      const firstStep = (child: boolean) => {
        const history = makeHistory()
        history.input(0, "t1")
        history.step({
          start: 0,
          end: 10 * SECOND,
          turn: "t1",
          usage: { inputTokens: 30_000, cacheWriteTokens: 30_000 },
          child,
        })
        return history.envelopes
      }
      /** Six minutes after the step started, the timer reads `expected`. */
      const sixMinutesOn = (child: boolean, expected: string) =>
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          const extension = yield* setupWithCatalog(Option.some(lifetimes), { clock })
          extension.deliver(firstStep(child))
          yield* clock.adjust("6 minutes")
          yield* waitUntil(() => extension.timer() === expected, `${expected} six minutes on`)
        })
      yield* sixMinutesOn(true, "cache cold [textMuted]")
      yield* sixMinutesOn(false, "cache 54m [textMuted]")
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a reads-only provider's lifetime is marked as a guess", () =>
    Effect.gen(function* () {
      const extension = yield* setupWithCatalog(Option.some(models))
      extension.setSelected(GPT)
      const history = makeHistory()
      history.input(0, "t1")
      history.step({
        start: 0,
        end: 5 * SECOND,
        turn: "t1",
        usage: { inputTokens: 30_000 },
        model: GPT,
      })
      // Nothing reported yet: the provider has not shown it caches.
      extension.deliver(history.envelopes)
      expect(extension.timer()).toBe("none")
      history.step({
        start: 10 * SECOND,
        end: 20 * SECOND,
        turn: "t1",
        usage: { inputTokens: 31_000, cacheReadTokens: 29_000 },
        model: GPT,
      })
      extension.deliver(history.envelopes)
      expect(extension.timer()).toBe("cache ~5m [textMuted]")
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a lapsed cache says the next turn compacts only past the loop's cost rule", () =>
    Effect.gen(function* () {
      const lapsedLabel = (estimatedTokens: number, expected: string) =>
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          const extension = yield* setupWithCatalog(Option.some(models), { clock })
          const history = cachedFirstStep()
          history.projected(11 * SECOND, estimatedTokens)
          extension.deliver(history.envelopes)
          yield* clock.adjust("6 minutes")
          yield* waitUntil(
            () => extension.timer() === expected,
            `a lapsed ${estimatedTokens} window`,
          )
        })
      // Under the 150k floor the loop resends the window, so the label only says cold.
      yield* lapsedLabel(120_000, "cache cold [textMuted]")
      yield* lapsedLabel(200_000, "cache cold · next turn compacts [warning]")
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a catalog that names no lifetime, or no catalog, draws no timer", () =>
    Effect.gen(function* () {
      const unnamed = models.map(
        ({ id, name, provider, pricing }) => new Model({ id, name, provider, pricing }),
      )
      const extension = yield* setupWithCatalog(Option.some(unnamed))
      extension.deliver(cachedFirstStep().envelopes)
      expect(extension.timer()).toBe("none")
      extension.setCatalog(Option.none())
      expect(extension.timer()).toBe("none")
      extension.setCatalog(Option.some(models))
      expect(extension.timer()).toBe("cache 5m [textMuted]")
    }).pipe(Effect.timeout("4 seconds")),
  )
})

/** The status row: the last line that names the context gauge. */
const statusLine = (frame: string): string =>
  frame
    .split("\n")
    .filter((line) => line.includes("ctx "))
    .at(-1) ?? ""

describe("cache timer on the status row", () => {
  it.scopedLive("a resumed session whose last request is old reads cold, never a count", () =>
    Effect.gen(function* () {
      const setup = yield* renderResumed({
        catalog: Effect.succeed(models),
        extension: cacheExtension,
      })
      const frame = yield* waitForFrame(
        setup.rendered,
        (text) => statusLine(text).includes("cache cold"),
        "cold timer",
        4000,
      )
      expect(statusLine(frame)).not.toMatch(/cache \d/)
    }).pipe(Effect.timeout("8 seconds")),
  )

  for (const width of [60, 120]) {
    it.scopedLive(`the timer sits before the gauge and keeps its place at ${width} columns`, () =>
      Effect.gen(function* () {
        const setup = yield* renderResumed({
          catalog: Effect.succeed(models),
          extension: cacheExtension,
          width,
        })
        const frame = yield* waitForFrame(
          setup.rendered,
          (text) => statusLine(text).includes("cache cold · ctx 31% · $0.15"),
          "timer, gauge and cost",
          4000,
        )
        // The right group ends the row: the left group gave way, not the timer.
        expect(statusLine(frame).trimEnd().endsWith("cache cold · ctx 31% · $0.15")).toBe(true)
      }).pipe(Effect.timeout("8 seconds")),
    )
  }
})
