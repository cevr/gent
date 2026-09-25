/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Option, Stream } from "effect"
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
  CACHE_EXTENSION_ID,
  CACHE_TTL_MS,
  type CacheMiss,
  CacheMissCause,
  type CacheScan,
  makeCacheScan,
  missCostUsd,
  missText,
  showsMissRow,
} from "../../src/extensions/cache.client"
import type { AnyExtensionClientModule, NoticeRow } from "../../src/extensions/client-facets"
import { App } from "../../src/app"
import { provideClientServices } from "../extension-test-harness-boundary"
import {
  createMockClient,
  createMockRuntime,
  renderWithProviders,
} from "../render-harness-boundary"
import { waitForFrame } from "../helpers-boundary"

// ── history builder ─────────────────────────────────────────────────────────

const sessionId = SessionId.make("session-cache")
const branchId = BranchId.make("branch-cache")
const SONNET = ModelId.make("anthropic/claude-sonnet-5")
const OPUS = ModelId.make("anthropic/claude-opus-5")
const GPT = ModelId.make("openai/gpt-5.5")
const SECOND = 1000
const MINUTE = 60 * SECOND

/** $/M: sonnet-5 as the catalog prices it; gpt with reads only, as OpenAI bills. */
const models = [
  new Model({
    id: SONNET,
    name: "Sonnet 5",
    provider: ProviderId.make("anthropic"),
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  }),
  new Model({
    id: GPT,
    name: "GPT 5.5",
    provider: ProviderId.make("openai"),
    pricing: { input: 1.25, output: 10, cacheRead: 0.125 },
  }),
]
const priceOf = (model: string) =>
  Option.flatMap(Option.fromUndefinedOr(models.find((entry) => entry.id === model)), (entry) =>
    Option.fromUndefinedOr(entry.pricing),
  )

/** Every counted miss in one branch's history, in order: one scan over the envelopes. */
const scanCacheMisses = (envelopes: Iterable<EventEnvelope>): ReadonlyArray<CacheMiss> => {
  const scan = makeCacheScan()
  const misses: Array<CacheMiss> = []
  for (const envelope of envelopes) {
    const miss = scan.fold(envelope)
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
  return { envelopes, input, step, tool, approval, compaction }
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
      expect(missCostUsd(miss, priceOf(SONNET))).toBeCloseTo((30_000 * 2.3) / 1_000_000, 10)
      expect(missText(miss, missCostUsd(miss, priceOf(SONNET)))).toBe(
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

  it.live("a miss inside the TTL on the same model is a changed prefix", () =>
    Effect.sync(() => {
      const history = cachedFirstStep()
      // Start to start is what the TTL runs on: the gap after the first step ended is shorter.
      history.step({
        start: 1 * SECOND + CACHE_TTL_MS,
        end: 2 * SECOND + CACHE_TTL_MS,
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
      expect(missCostUsd(miss, priceOf(GPT))).toBeCloseTo((31_000 * (1.25 - 0.125)) / 1_000_000, 10)
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
      expect(missCostUsd(miss, priceOf(SONNET))).toBeCloseTo(0.046, 10)
      // Past the writes, the rest paid the input rate.
      expect(missCostUsd({ ...miss, missedTokens: 25_000 }, priceOf(SONNET))).toBeCloseTo(
        (20_000 * 2.3 + 5000 * 1.8) / 1_000_000,
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
      expect(missCostUsd(miss, priceOf(SONNET))).toBe(0)
      expect(missCostUsd({ ...miss, billed: true }, Option.none())).toBe(0)
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

/** The client extension with a catalog the test sets, fed one history. */
const setupWithCatalog = (initial: Option.Option<ReadonlyArray<Model>>) =>
  Effect.gen(function* () {
    const subscribers = new Set<(envelope: EventEnvelope) => void>()
    const session = { sessionId, branchId }
    const [catalog, setCatalog] = createSignal(initial)
    const contributions = yield* provideClientServices(cacheExtension.setup, {
      currentSession: () => Option.some(session),
      sessionEventSubscribers: subscribers,
      modelCatalog: catalog,
    })
    const deliver = (envelopes: ReadonlyArray<EventEnvelope>) => {
      for (const envelope of envelopes) for (const cb of subscribers) cb(envelope)
    }
    const [notices] = contributions.noticeRows ?? []
    const [label] = contributions.statusLabels ?? []
    return {
      deliver,
      setCatalog,
      rows: () => Option.flatten(Option.fromUndefinedOr(notices?.rows(session))),
      label: () => label?.produce() ?? [],
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
        currentSession: () => Option.some(session),
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
      const total = misses.reduce((sum, miss) => sum + missCostUsd(miss, priceOf(SONNET)), 0)
      expect(total).toBeCloseTo((32_000 * 2.3) / 1_000_000, 10)
      expect(notices?.id).toBe("cache.misses")
      expect(CACHE_EXTENSION_ID).toBe("@gent/cache")
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("a resumed session draws the miss row in the transcript", () =>
    Effect.gen(function* () {
      const setup = yield* renderResumed({
        catalog: Effect.succeed(models),
        extension: cacheExtension,
      })
      yield* waitForFrame(setup.rendered, (frame) => frame.includes(`◌ ${IDLE_ROW}`), "miss row")
      yield* waitForFrame(
        setup.rendered,
        (frame) => frame.includes("cache waste $0.07"),
        "status total",
      )
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("an extension that loads after the feed opened still draws the resumed rows", () =>
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
      yield* waitForFrame(
        setup.rendered,
        (frame) => frame.includes(`◌ ${IDLE_ROW}`),
        "miss row",
        4000,
      )
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.live("a catalog that lands after the feed shows the row once, already priced", () =>
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
        yield* waitForFrame(setup.rendered, (frame) => {
          record(frame)
          return true
        })
      }
      expect(drawn).toEqual([])
      yield* Deferred.succeed(catalogReady, void 0)
      yield* waitForFrame(
        setup.rendered,
        (frame) => {
          record(frame)
          return frame.includes(`◌ ${IDLE_ROW}`)
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
            reasoningLevel: Option.getOrUndefined(Option.none()),
            resolvedModelId: SONNET,
            agent: AgentName.make("main"),
            runtime: { _tag: "Idle" satisfies "Idle", queue: emptyQueueSnapshot() },
            metrics: { turns: 3, durationMs: 0, costUsd: 0.15, lastInputTokens: 34_000 },
          }),
        events: () => {
          opened = true
          return Stream.concat(Stream.make(...history.envelopes), Stream.never)
        },
      },
    })
    const rendered = yield* Effect.promise(() =>
      renderWithProviders(() => <App />, {
        client,
        runtime: createMockRuntime(),
        builtins: [opts.extension],
        width: 100,
        height: 30,
        initialSession: {
          id: sessionId,
          activeBranchId: branchId,
          name: "Cache",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
        },
      }),
    )
    return { rendered, feedOpened: () => opened }
  })
