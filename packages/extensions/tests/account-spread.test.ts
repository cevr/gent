/**
 * The spread's cost in prompt-cache writes, measured on a cache model that
 * charges as a provider's prompt cache does: one entry per account and model,
 * read by the longest prefix it holds, written past it.
 */
import { describe, expect, it } from "effect-bun-test"
import {
  Clock,
  Console,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect"
import * as AiError from "effect/ai/AiError"
import * as AiModel from "effect/ai/Model"
import type * as Prompt from "effect/ai/Prompt"
import * as AiTool from "effect/ai/Tool"
import {
  AuthMethod,
  CredentialSlot,
  DEFAULT_RETRY_POLICY,
  defineExtension,
  ExtensionHost,
  Model,
  ModelId,
  type ModelDriverContribution,
  ProviderId,
  tool,
} from "@gent/core/extensions/api"
import {
  apiKeyAuth,
  ConfigService,
  createRpcHarness,
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textDeltaPart,
  toolCallPart,
  UserConfig,
} from "@gent/core/test-utils"
import { BranchId, type EventEnvelope, SessionId, ToolCallId } from "@gent/core/protocol"
import { AgentsExtension } from "../src/agents.js"
import { CompactionExtension } from "../src/compaction.js"
import { SessionToolsExtension } from "../src/session-tools.js"
import { e2ePreset } from "./helpers/test-preset"

// ── the cache model ─────────────────────────────────────────────────────────

/** The 1-hour lifetime the spread model lists. */
const CACHE_LIFETIME_MS = 3_600_000

/** A request as the cache sees it: canonical JSON per boundary. */
interface CacheRequest {
  readonly tools: string
  readonly system: ReadonlyArray<string>
  readonly conversation: ReadonlyArray<string>
}

/** What one request cost the cache. */
interface CacheCharge {
  readonly read: number
  readonly write: number
  /** The write tokens at or before the last system boundary. */
  readonly systemWrite: number
  /** The whole system prefix, as a key: what a system-prefix write wrote. */
  readonly systemKey: string
}

const tokensOf = (chars: number) => Math.ceil(chars / 4)

/**
 * Per (account, model), the prefixes the cache holds and until when. A
 * request reads the longest boundary its account holds unexpired and writes
 * every longer one up to its end; `commit` stores the writes, as a provider
 * makes an entry readable only once the response begins.
 */
const makeCacheModel = () => {
  const entries = new Map<string, number>()
  const charge = (account: string, model: string, request: CacheRequest, now: number) => {
    const segments = [request.tools, ...request.system, ...request.conversation]
    const keys: Array<string> = []
    const tokens: Array<number> = []
    let key = `${account}\u0001${model}`
    let chars = 0
    for (const segment of segments) {
      key = `${key}\u0000${segment}`
      chars += segment.length
      keys.push(key)
      tokens.push(tokensOf(chars))
    }
    // The boundary index read: -1 when nothing is held.
    let readAt = -1
    for (let index = keys.length - 1; index >= 0; index--) {
      const until = entries.get(keys[index] ?? "")
      if (Predicate.isNotUndefined(until) && until > now) {
        readAt = index
        break
      }
    }
    const systemEnd = request.system.length
    const tokensAt = (index: number) => {
      if (index < 0) return 0
      return tokens[index] ?? 0
    }
    const total = tokensAt(keys.length - 1)
    const read = tokensAt(readAt)
    const systemWrite = Math.max(0, tokensAt(systemEnd) - read)
    const result: CacheCharge = {
      read,
      write: total - read,
      systemWrite,
      systemKey: keys[systemEnd] ?? "",
    }
    const commit = (at: number) => {
      // A read refreshes the entry's lifetime, as a write sets it.
      for (let index = Math.max(readAt, 0); index < keys.length; index++) {
        entries.set(keys[index] ?? "", at + CACHE_LIFETIME_MS)
      }
    }
    return { charge: result, commit }
  }
  return { charge }
}

// ── the fake driver ─────────────────────────────────────────────────────────

const SPREAD = "spread"
const SPREAD_MODEL = ModelId.make(`${SPREAD}/model`)
const a = CredentialSlot.make("a")
const b = CredentialSlot.make("b")

type ProviderOptions = Parameters<Parameters<typeof LanguageModelLayers.testStream>[0]>[0]

/** The text of each user message in a request, in order. */
const userTexts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) => {
    if (message.role !== "user") return []
    return message.content.flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
  })

/** A value's JSON, as the wire carries it: the same value encodes the same. */
const jsonOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The request the cache charges: its tool definitions, system blocks and conversation. */
const cacheRequestOf = (options: ProviderOptions): CacheRequest => ({
  tools: jsonOf(
    options.tools.map((each) => ({
      name: each.name,
      description: each.description ?? "",
      parameters: AiTool.getJsonSchema(each),
    })),
  ),
  system: options.prompt.content
    .filter((message) => message.role === "system")
    .map((message) => jsonOf(message.content)),
  conversation: options.prompt.content
    .filter((message) => message.role !== "system")
    .map((message) => jsonOf({ role: message.role, content: message.content })),
})

/** One answered (or refused) request, as the fake saw it. */
interface RequestRecord {
  readonly account: string
  /** The first line of the request's last user text: the turn it belongs to. */
  readonly label: string
  readonly refused: boolean
  readonly charge: CacheCharge
  readonly total: number
}

const firstLine = (text: string) => text.split("\n")[0] ?? ""

const BURST_TASK = "BURST-TASK"
const FORK_TASK = "FORK-TASK"
const SUMMARY_PREFIX = "Conversation so far"
/** The turn whose first request the fake refuses for 10 minutes. */
const REFUSED_TURN = "R2-2"

/** The tool every scripted tool step calls: it echoes. */
const probeTool = tool({
  id: "probe",
  description: "Echoes its input",
  params: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: (params) => Effect.succeed({ text: params.text }),
})

/**
 * The world one run of the workload sends to: the `spread` driver over the
 * cache model, answering by the request's last user text. The first request
 * of each burst child waits until every child sent its first. With
 * `refuses`, the first request of `REFUSED_TURN` is refused once.
 */
const makeSpreadWorld = (burstSize: number, refuses: boolean) =>
  Effect.gen(function* () {
    const cache = makeCacheModel()
    const records: Array<RequestRecord> = []
    const burstOpen = yield* Deferred.make<void>()
    let burstFirsts = 0
    let refusedOnce = !refuses
    const scripted = new Map<string, ReadonlyArray<{ tool: string; input: object }>>()
    let calls = 0

    const parts = (options: ProviderOptions) => {
      const last = options.prompt.content.at(-1)
      const texts = userTexts(options.prompt)
      const lastUser = texts.at(-1) ?? ""
      if (lastUser.startsWith(SUMMARY_PREFIX)) {
        return [textDeltaPart("SUMMARY: the goal, what is done, the next step")]
      }
      if (last?.role === "tool") return [textDeltaPart("noted")]
      const ops = scripted.get(firstLine(lastUser))
      if (Predicate.isNotUndefined(ops)) {
        return ops.map((op) => {
          calls += 1
          return toolCallPart(op.tool, op.input, {
            toolCallId: ToolCallId.make(`spread-op-${calls}`),
          })
        })
      }
      if (lastUser.includes(BURST_TASK) || lastUser.includes(FORK_TASK)) {
        calls += 1
        return [
          toolCallPart(
            "probe",
            { text: "task" },
            {
              toolCallId: ToolCallId.make(`spread-op-${calls}`),
            },
          ),
        ]
      }
      return [textDeltaPart("done")]
    }

    const respond = (account: string, options: ProviderOptions) =>
      Effect.gen(function* () {
        const texts = userTexts(options.prompt)
        const lastUser = texts.at(-1) ?? ""
        const label = firstLine(lastUser)
        const opensTurn = options.prompt.content.at(-1)?.role === "user"
        const isBurstFirst =
          (texts[0] ?? "").includes(BURST_TASK) &&
          !options.prompt.content.some((message) => message.role === "assistant")
        if (isBurstFirst) {
          burstFirsts += 1
          if (burstFirsts >= burstSize) yield* Deferred.succeed(burstOpen, void 0)
          yield* Deferred.await(burstOpen)
        }
        const now = yield* Clock.currentTimeMillis
        const request = cacheRequestOf(options)
        const { charge, commit } = cache.charge(account, SPREAD_MODEL, request, now)
        const total = charge.read + charge.write
        if (label === REFUSED_TURN && opensTurn && !refusedOnce) {
          refusedOnce = true
          records.push({ account, label, refused: true, charge, total })
          return Stream.fail(
            AiError.make({
              module: "Spread",
              method: "streamText",
              reason: new AiError.RateLimitError({ retryAfter: Duration.minutes(10) }),
            }),
          )
        }
        records.push({ account, label, refused: false, charge, total })
        const toolStep = parts(options)
        let finishReason: "tool-calls" | "stop" = "stop"
        if (toolStep.some((part) => part.type === "tool-call")) finishReason = "tool-calls"
        return Stream.concat(
          Stream.fromIterable([
            ...toolStep,
            finishPart({
              finishReason,
              usage: {
                inputTokens: total,
                outputTokens: 20,
                cacheReadTokens: charge.read,
                cacheWriteTokens: charge.write,
              },
            }),
          ]),
          // The writes land once the response is out.
          Stream.fromEffect(
            Effect.flatMap(Clock.currentTimeMillis, (at) => Effect.sync(() => commit(at))),
          ).pipe(Stream.drain),
        )
      })

    const driver: ModelDriverContribution = {
      id: SPREAD,
      name: "Spread driver",
      auth: { methods: [AuthMethod.make({ type: "api", label: "Key" })] },
      // A refusal past this cap moves the run; a shorter wait retries in place.
      retry: { ...DEFAULT_RETRY_POLICY, initialDelay: 1, maxDelay: 5, maxAttempts: 2 },
      listModels: () =>
        Effect.succeed([
          Model.make({
            id: SPREAD_MODEL,
            name: "Spread model",
            provider: ProviderId.make(SPREAD),
            contextLength: 24_000,
            pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
            promptCacheTtlMs: CACHE_LIFETIME_MS,
          }),
        ]),
      resolveModel: (_name, authInfo) =>
        Effect.sync(() => {
          let account = "env"
          if (authInfo?._tag === "Api") account = authInfo.key.replace("key-", "")
          return AiModel.make(
            SPREAD,
            "model",
            LanguageModelLayers.testStream((options) => respond(account, options)),
          )
        }),
    }
    const extension = defineExtension({
      id: "@test/spread",
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.register("modelDriver", driver)
        yield* host.register("tool", probeTool)
      }),
    })
    return { extension, records, scripted }
  })

// ── the workload ────────────────────────────────────────────────────────────

type SessionKey = { readonly sessionId: SessionId; readonly branchId: BranchId }

const StartedOutput = Schema.fromJsonString(
  Schema.Struct({ thread: SessionId, sessionId: SessionId, branchId: BranchId }),
)
const decodeStarted = Schema.decodeEffect(StartedOutput)

/** A branch's durable history. */
const historyOf = (
  client: Effect.Success<ReturnType<typeof createRpcHarness>>["client"],
  target: SessionKey,
) =>
  client.session.events(target).pipe(
    Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
    Stream.runCollect,
    Effect.map((envelopes): ReadonlyArray<EventEnvelope> => Array.from(envelopes)),
  )

/** What one run of the workload measured. */
interface RunResult {
  readonly records: ReadonlyArray<RequestRecord>
  /** Each session's events, and the label of each user message, by its name in the workload. */
  readonly sessions: ReadonlyArray<{
    readonly name: string
    readonly events: ReadonlyArray<EventEnvelope>
    /** A user message's id → the first line of its text: the label the fake records. */
    readonly labels: ReadonlyMap<string, string>
  }>
}

const BURST_SIZE = 4
/** A big user message: two of them and the handoff turn's overflow the window. */
const bulk = (label: string) => `${label}\n${"lorem ipsum dolor ".repeat(1_400)}`

/** The workload of E1, on `order`; `refuses`: `REFUSED_TURN`'s first request is refused. */
const runWorkload = (
  order: {
    readonly authOrder: ReadonlyArray<CredentialSlot>
    readonly authSpread?: ReadonlyArray<CredentialSlot>
  },
  refuses: boolean,
) =>
  Effect.gen(function* () {
    const world = yield* makeSpreadWorld(BURST_SIZE, refuses)
    const cwd = yield* makeTempDirectoryScoped("gent-spread-")
    const harness = yield* createRpcHarness({
      ...e2ePreset,
      cwd,
      resolver: "drivers",
      models: "catalog",
      providerLayer: LanguageModelLayers.testStream(() => Effect.die("no scripted model")),
      authLayer: apiKeyAuth([
        [SPREAD, a, "key-a"],
        [SPREAD, b, "key-b"],
      ]),
      configServiceLayer: ConfigService.Test(
        new UserConfig({ model: SPREAD_MODEL, providers: { [SPREAD]: order } }),
      ),
      extensionInputs: [
        AgentsExtension,
        SessionToolsExtension,
        CompactionExtension,
        world.extension,
      ],
    })
    const { client } = harness
    const r1: SessionKey = { sessionId: harness.sessionId, branchId: harness.branchId }
    const turnsEnded = new Map<string, number>()
    /** Sends `content` and waits for the turn it opens to end. */
    const turn = (target: SessionKey, content: string) =>
      Effect.gen(function* () {
        const earlier = turnsEnded.get(target.sessionId) ?? 0
        const ended = yield* client.session.events(target).pipe(
          Stream.filter(({ event }) => event._tag === "TurnCompleted"),
          Stream.drop(earlier),
          Stream.runHead,
          Effect.forkScoped,
        )
        yield* client.message.send({ ...target, content })
        yield* Fiber.join(ended)
        turnsEnded.set(target.sessionId, earlier + 1)
      })
    /** The threads `target`'s history started, in order. */
    const startedBy = (target: SessionKey) =>
      Effect.flatMap(historyOf(client, target), (events) =>
        Effect.forEach(
          events.flatMap(({ event }) => {
            if (event._tag !== "ToolCallSucceeded" || event.toolName !== "thread.start") return []
            return [event.output ?? ""]
          }),
          (output) => decodeStarted(output),
        ),
      )
    /** Waits for a thread's first round to end. */
    const roundEnded = (target: SessionKey) =>
      client.session.events(target).pipe(
        Stream.filter(({ event }) => event._tag === "TurnCompleted"),
        Stream.runHead,
      )

    // 1. R1: two turns of a tool step and a text step, each a big message.
    world.scripted.set("R1-1", [{ tool: "probe", input: { text: "one" } }])
    world.scripted.set("R1-2", [{ tool: "probe", input: { text: "two" } }])
    yield* turn(r1, bulk("R1-1"))
    yield* turn(r1, bulk("R1-2"))
    // 2. A burst of fresh threads in one step.
    world.scripted.set(
      "R1-3",
      Array.from({ length: BURST_SIZE }, (_, index) => ({
        tool: "thread.start",
        input: { task: `${BURST_TASK} ${index + 1}: tidy part ${index + 1}` },
      })),
    )
    yield* turn(r1, "R1-3")
    const burst = yield* startedBy(r1)
    yield* Effect.forEach(burst, roundEnded, { concurrency: BURST_SIZE })
    // 3. A forked thread.
    world.scripted.set("R1-4", [
      { tool: "thread.start", input: { task: `${FORK_TASK}: check the burst`, fork: true } },
    ])
    yield* turn(r1, "R1-4")
    const fork = (yield* startedBy(r1)).slice(BURST_SIZE)
    yield* Effect.forEach(fork, roundEnded)
    // 4. A turn whose window overflows: a handoff, then one more step.
    yield* turn(r1, bulk("R1-5"))
    // 5. A handoff session of R1.
    const h1: SessionKey = yield* client.session.create({
      cwd,
      parentSessionId: r1.sessionId,
      parentBranchId: r1.branchId,
      continueThread: true,
    })
    yield* turn(h1, "H1-1")
    // 6. A second root session; its second turn's first request is refused.
    const r2: SessionKey = yield* client.session.create({ cwd })
    yield* turn(r2, "R2-1")
    yield* turn(r2, REFUSED_TURN)
    // 7. A small session's two turns: the second is warm and cheap, so a
    // move in it shows as a small write.
    const r3: SessionKey = yield* client.session.create({ cwd })
    yield* turn(r3, "R3-1")
    yield* turn(r3, "R3-2")

    const named: ReadonlyArray<readonly [string, SessionKey]> = [
      ["R1", r1],
      ...burst.map((child, index): readonly [string, SessionKey] => [`T${index + 1}`, child]),
      ...fork.map((child): readonly [string, SessionKey] => ["F1", child]),
      ["H1", h1],
      ["R2", r2],
      ["R3", r3],
    ]
    const sessions = yield* Effect.forEach(named, ([name, key]) =>
      Effect.gen(function* () {
        const events = yield* historyOf(client, key)
        const messages = yield* client.message.list({ branchId: key.branchId })
        const labels = new Map(
          messages
            .filter((message) => message.role === "user")
            .map((message): readonly [string, string] => [
              message.id,
              firstLine(
                message.parts.flatMap((part) => {
                  if (part.type !== "text") return []
                  return [part.text]
                })[0] ?? "",
              ),
            ]),
        )
        return { name, events, labels }
      }),
    )
    const result: RunResult = { records: [...world.records], sessions }
    return result
  })

// ── reading a run ───────────────────────────────────────────────────────────

/** The account each model step of a session went out on, in order. */
const stepSlots = (events: ReadonlyArray<EventEnvelope>) =>
  events.flatMap(({ event }) => {
    if (event._tag !== "StreamEnded") return []
    return Option.toArray(Option.map(Option.fromUndefinedOr(event.credential), (c) => c.slot))
  })

const sumOf = (records: ReadonlyArray<RequestRecord>, field: (record: RequestRecord) => number) =>
  records.reduce((sum, record) => sum + field(record), 0)

const answered = (run: RunResult) => run.records.filter((record) => !record.refused)
const writes = (run: RunResult) => sumOf(answered(run), (record) => record.charge.write)
const reads = (run: RunResult) => sumOf(answered(run), (record) => record.charge.read)
/** The system-prefix part of the writes; the rest is the conversation's. */
const prefixWrites = (run: RunResult) => sumOf(answered(run), (record) => record.charge.systemWrite)
/** The requests that wrote a system prefix. */
const prefixWriters = (run: RunResult) =>
  answered(run).filter((record) => record.charge.systemWrite > 0)
/** Each run writes each account's system prefix at most once. */
const expectPrefixesOnce = (runs: ReadonlyArray<RunResult>) => {
  for (const run of runs) {
    const written = prefixWriters(run).map((record) => record.charge.systemKey)
    expect(new Set(written).size).toBe(written.length)
  }
}

/**
 * Each session's steps stay on one account but where its cache starts over
 * by evidence the placement does not write: the first request of a turn
 * whose request the fake refused, or the step after a window handoff
 * (`ModelContextProjected { compacted: true }`).
 */
const expectNoUnexplainedMove = (run: RunResult) => {
  const refusedLabels = new Set(
    run.records.filter((record) => record.refused).map((record) => record.label),
  )
  for (const session of run.sessions) {
    let last = Option.none<string>()
    let exempt = false
    const turns = new Set<string>()
    for (const { event } of session.events) {
      if (event._tag === "ModelContextProjected" && event.compacted) exempt = true
      if (event._tag !== "StreamEnded" || Predicate.isUndefined(event.credential)) continue
      const turn = event.messageId ?? ""
      const label = session.labels.get(turn) ?? ""
      if (!turns.has(turn) && refusedLabels.has(label)) exempt = true
      turns.add(turn)
      const slot = event.credential.slot
      if (Option.isSome(last) && last.value !== slot) {
        expect({ session: session.name, label, exempt }).toEqual({
          session: session.name,
          label,
          exempt: true,
        })
      }
      last = Option.some(slot)
      exempt = false
    }
  }
}

describe("account spread", () => {
  it.effect(
    "the cache model charges an account's first request for the system prefix and reads it on the next",
    () =>
      Effect.sync(() => {
        const cache = makeCacheModel()
        const tools = jsonOf([{ name: "probe" }])
        const system = ["shared system part ".repeat(40), "agent system part ".repeat(20)]
        const first: CacheRequest = { tools, system, conversation: ["user: hello"] }
        const opened = cache.charge("a", "m", first, 0)
        expect(opened.charge.read).toBe(0)
        const systemTokens = tokensOf(tools.length + system.join("").length)
        expect(opened.charge.systemWrite).toBe(systemTokens)
        opened.commit(0)
        // The same session's next request reads all it sent before.
        const next = cache.charge(
          "a",
          "m",
          { tools, system, conversation: ["user: hello", "assistant: hi", "user: go on"] },
          1_000,
        )
        expect(next.charge.read).toBe(tokensOf(tools.length + system.join("").length + 11))
        expect(next.charge.systemWrite).toBe(0)
        next.commit(1_000)
        // A fresh child on the same account reads the shared prefix.
        const child: CacheRequest = { tools, system, conversation: ["user: a task"] }
        const sibling = cache.charge("a", "m", child, 2_000)
        expect(sibling.charge.read).toBe(systemTokens)
        expect(sibling.charge.systemWrite).toBe(0)
        // The same child on a cold account writes it.
        const cold = cache.charge("b", "m", child, 2_000)
        expect(cold.charge.read).toBe(0)
        expect(cold.charge.systemWrite).toBe(systemTokens)
        // Past the lifetime, the account is cold again.
        const expired = cache.charge("a", "m", child, 2_000 + CACHE_LIFETIME_MS)
        expect(expired.charge.read).toBe(0)
      }),
  )

  it.live(
    "spread across two accounts, the same workload writes at most one more system prefix per added account and moves no session mid-cache but for a rate limit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const off = yield* runWorkload({ authOrder: [a, b] }, true)
          const on = yield* runWorkload({ authOrder: [a, b], authSpread: [a, b] }, true)
          const W_off = writes(off)
          const W_on = writes(on)
          const PW_off = prefixWrites(off)
          const PW_on = prefixWrites(on)
          yield* Console.log(
            `W_off ${W_off} W_on ${W_on} PW_off ${PW_off} PW_on ${PW_on} R_off ${reads(off)} R_on ${reads(on)} prefixes_off ${prefixWriters(off).length} prefixes_on ${prefixWriters(on).length}`,
          )
          for (const [label, run] of [
            ["off", off],
            ["on", on],
          ] as const) {
            yield* Console.log(
              `${label}: ${run.sessions
                .map((session) => `${session.name} ${stepSlots(session.events).join("")}`)
                .join(", ")}`,
            )
          }

          // 1. The same work.
          expect(answered(on).length).toBe(answered(off).length)
          const inputOf = (run: RunResult) => sumOf(answered(run), (record) => record.total)
          expect(Math.abs(inputOf(on) - inputOf(off)) / inputOf(off)).toBeLessThanOrEqual(0.01)

          // 2. Off: every request on `a` but the rate-limit move's.
          const offElsewhere = off.records.filter((record) => record.account !== a)
          expect(offElsewhere.length).toBeGreaterThan(0)
          expect(offElsewhere.every((record) => record.label === REFUSED_TURN)).toBe(true)

          // 3. On: each account serves at least two sessions.
          const servedBy = (account: CredentialSlot) =>
            on.sessions.filter((session) => stepSlots(session.events).includes(account)).length
          expect(servedBy(a)).toBeGreaterThanOrEqual(2)
          expect(servedBy(b)).toBeGreaterThanOrEqual(2)

          // 4. Cache writes: no more conversation writes than without the
          // spread, each system prefix (per account) written once, and at most
          // one more prefix written per added account.
          expect(W_on - PW_on).toBeLessThanOrEqual(W_off - PW_off)
          expectPrefixesOnce([off, on])
          expect(prefixWriters(on).length).toBeLessThanOrEqual(prefixWriters(off).length + 1)

          // 5. No mid-cache move but where the cache starts over by evidence
          // the placement does not write.
          expectNoUnexplainedMove(on)
        }).pipe(Effect.timeout("60 seconds")),
      ),
    90_000,
  )

  it.live(
    "with no refusal to move a session, the spread costs the same workload exactly the added account's system prefix",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const off = yield* runWorkload({ authOrder: [a, b] }, false)
          const on = yield* runWorkload({ authOrder: [a, b], authSpread: [a, b] }, false)
          yield* Console.log(
            `no refusal: W_off ${writes(off)} W_on ${writes(on)} PW_off ${prefixWrites(off)} PW_on ${prefixWrites(on)} prefixes_off ${prefixWriters(off).length} prefixes_on ${prefixWriters(on).length}`,
          )
          expect(answered(on).length).toBe(answered(off).length)
          // Off: every request on `a`; on: `b` serves sessions too.
          expect(off.records.every((record) => record.account === a)).toBe(true)
          expect(on.records.some((record) => record.account === b)).toBe(true)
          // The spread's whole cost is `b`'s system prefix, written once: the
          // conversation writes match, so W_on − W_off = PW_on − PW_off.
          expect(writes(on) - prefixWrites(on)).toBe(writes(off) - prefixWrites(off))
          expectPrefixesOnce([off, on])
          expect(prefixWriters(on).length).toBe(prefixWriters(off).length + 1)
          expectNoUnexplainedMove(on)
        }).pipe(Effect.timeout("60 seconds")),
      ),
    90_000,
  )

  it.live(
    "a branch forked from a spread session runs its first turn on the account that holds its copied window",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* makeSpreadWorld(BURST_SIZE, true)
          const cwd = yield* makeTempDirectoryScoped("gent-spread-branch-fork-")
          const harness = yield* createRpcHarness({
            ...e2ePreset,
            cwd,
            resolver: "drivers",
            models: "catalog",
            providerLayer: LanguageModelLayers.testStream(() => Effect.die("no scripted model")),
            authLayer: apiKeyAuth([
              [SPREAD, a, "key-a"],
              [SPREAD, b, "key-b"],
            ]),
            configServiceLayer: ConfigService.Test(
              new UserConfig({
                model: SPREAD_MODEL,
                providers: { [SPREAD]: { authOrder: [a, b], authSpread: [a, b] } },
              }),
            ),
            extensionInputs: [
              AgentsExtension,
              SessionToolsExtension,
              CompactionExtension,
              world.extension,
            ],
          })
          const { client } = harness
          const root: SessionKey = { sessionId: harness.sessionId, branchId: harness.branchId }
          const ended = new Map<string, number>()
          const turn = (target: SessionKey, content: string) =>
            Effect.gen(function* () {
              const earlier = ended.get(target.branchId) ?? 0
              const done = yield* client.session.events(target).pipe(
                Stream.filter(({ event }) => event._tag === "TurnCompleted"),
                Stream.drop(earlier),
                Stream.runHead,
                Effect.forkScoped,
              )
              yield* client.message.send({ ...target, content })
              yield* Fiber.join(done)
              ended.set(target.branchId, earlier + 1)
            })
          yield* turn(root, bulk("P-1"))
          yield* turn(root, bulk("P-2"))
          const last = (yield* client.message.list({ branchId: root.branchId })).at(-1)
          if (Predicate.isUndefined(last)) return yield* Effect.die("the root has no message")
          // The root's cache lives on a: ranked, a fresh run would go to b.
          const { branchId } = yield* client.branch.fork({
            sessionId: root.sessionId,
            fromBranchId: root.branchId,
            atMessageId: last.id,
          })
          const forked: SessionKey = { sessionId: root.sessionId, branchId }
          yield* turn(forked, "P-fork")
          const rootEvents = yield* historyOf(client, root)
          const forkEvents = yield* historyOf(client, forked)
          expect(stepSlots(rootEvents)).toEqual([a, a])
          expect(stepSlots(forkEvents)).toEqual([a])
          expect(
            forkEvents.flatMap(({ event }) => {
              if (event._tag !== "CredentialAssigned") return []
              return [{ slot: event.slot, reason: event.reason }]
            }),
          ).toEqual([{ slot: a, reason: "fork" }])
          // The fork's request read the copied window from a's cache.
          const forkRequest = world.records.find((record) => record.label === "P-fork")
          expect(forkRequest?.charge.read).toBeGreaterThan(0)
        }).pipe(Effect.timeout("30 seconds")),
      ),
    45_000,
  )
})
