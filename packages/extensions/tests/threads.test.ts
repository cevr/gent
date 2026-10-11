import { describe, expect, it } from "effect-bun-test"
import { flow } from "effect/Function"
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  PubSub,
  Record,
  Result,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import { BunServices } from "@effect/platform-bun"
import type * as Prompt from "effect/ai/Prompt"
import { BunSqlite } from "@gent/core/host-bun"
import { workspaceIdForCwd } from "@gent/core/host"
import {
  CredentialSlot,
  DEFAULT_SESSION_NAME,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionServiceError,
  getToolId,
  messagePartsDisplayText,
  sessionThread,
  tool,
} from "@gent/core/extensions/api"
import {
  collectTestContributions,
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  CurrentWorkspaceId,
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  runtimeHostContext,
  runToolWithCtx,
  systemTextOf,
  textDeltaPart,
  toolCallPart,
  waitFor,
} from "@gent/core/test-utils"
import { BranchId, type EventEnvelope, SessionId, ToolCallId } from "@gent/core/protocol"
import { AgentsExtension } from "../src/agents.js"
import { SESSION_TOOLS_EXTENSION_ID, SessionToolsExtension } from "../src/session-tools.js"
import {
  THREAD_ROUND_END_TYPE,
  THREAD_ROUND_TYPE,
  threadRoundText,
  Threads,
} from "../src/threads.js"
import { e2ePreset } from "./helpers/test-preset"

// ── threads ─────────────────────────────────────────────────────────────────

/** Forks a reader that ends after `count` turns of the branch have ended. */
const turnEnds = <E>(stream: Stream.Stream<EventEnvelope, E>, count: number) =>
  stream.pipe(
    Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
    Stream.take(count),
    Stream.runDrain,
    Effect.forkScoped,
  )

const THREAD_TASK = "THREAD-TASK: tidy the changelog"

/** The text of each user message in a request, in order. */
const userTexts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) => {
    if (message.role !== "user") return []
    return message.content.flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
  })

/** A thread's request: its first user message carries a thread task. */
const isThreadRequest = (prompt: Prompt.Prompt): boolean =>
  userTexts(prompt)[0]?.includes("THREAD-TASK") === true

const reply = (text: string) =>
  Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })])

type SessionKey = { readonly sessionId: SessionId; readonly branchId: BranchId }

/** One thread-tool call a scripted model step makes. */
interface ThreadOp {
  readonly tool: "thread.start" | "thread.list" | "thread.stop"
  readonly input: Record<string, string>
  readonly id: string
}

/** A thread tool's result as its turn reported it. */
interface ThreadOpResult {
  readonly id: string
  readonly ok: boolean
  readonly output: string
}

const THREAD_TOOLS = new Set(["thread.start", "thread.list", "thread.stop"])

const StartedResult = Schema.Struct({ thread: SessionId, sessionId: SessionId, branchId: BranchId })
const StartedOutput = Schema.fromJsonString(StartedResult)
const ListedOutput = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      thread: SessionId,
      sessions: Schema.Finite,
      current: Schema.Struct({ sessionId: SessionId, branchId: BranchId }),
      status: Schema.Literals(["running", "idle"]),
      preview: Schema.String,
    }),
  ),
)
const StoppedOutput = Schema.fromJsonString(
  Schema.Struct({
    stopped: Schema.Array(Schema.Struct({ sessionId: SessionId, branchId: BranchId })),
  }),
)

/**
 * The thread tools as a model calls them, over the RPC harness and the
 * production extension, its process permit included. `act` sends a session a
 * message whose turn makes the given calls in one model step and returns
 * their results once the turn ends. A thread's own turn waits at the model
 * until `gate` opens, so it runs until then.
 */
const threadRig = Effect.gen(function* () {
  const gate = yield* Deferred.make<boolean>()
  const scripted = new Map<string, ReadonlyArray<ThreadOp>>()
  const providerLayer = LanguageModelLayers.testStream((options) => {
    if (isThreadRequest(options.prompt)) {
      return Deferred.await(gate).pipe(Effect.as(reply("THREAD-REPLY: changelog tidied")))
    }
    if (options.prompt.content.at(-1)?.role === "tool") return Effect.succeed(reply("noted"))
    const ops = scripted.get(userTexts(options.prompt).at(-1) ?? "") ?? []
    if (ops.length === 0) return Effect.succeed(reply("nothing to do"))
    return Effect.succeed(
      Stream.fromIterable([
        ...ops.map((op) => toolCallPart(op.tool, op.input, { toolCallId: ToolCallId.make(op.id) })),
        finishPart({ finishReason: "tool-calls" }),
      ]),
    )
  })
  const cwd = yield* makeTempDirectoryScoped("gent-threads-")
  const harness = yield* createRpcHarness({
    ...e2ePreset,
    cwd,
    providerLayer,
    extensionInputs: [AgentsExtension, SessionToolsExtension],
  })
  const { client } = harness
  const starter: SessionKey = { sessionId: harness.sessionId, branchId: harness.branchId }
  const act = (at: SessionKey, ops: ReadonlyArray<ThreadOp>) =>
    Effect.gen(function* () {
      const label = `OPS ${scripted.size + 1}`
      scripted.set(label, ops)
      const ids = new Set(ops.map((op) => op.id))
      const results: Array<ThreadOpResult> = []
      const turn = yield* client.session.events(at).pipe(
        Stream.tap(({ event }) =>
          Effect.sync(() => {
            if (event._tag !== "ToolCallSucceeded" && event._tag !== "ToolCallFailed") return
            if (!THREAD_TOOLS.has(event.toolName) || !ids.has(event.toolCallId)) return
            results.push({
              id: event.toolCallId,
              ok: event._tag === "ToolCallSucceeded",
              output: event.output ?? "",
            })
          }),
        ),
        // The turn's end that follows its last thread call.
        Stream.takeUntil(
          ({ event }) => event._tag === "TurnCompleted" && results.length === ops.length,
        ),
        Stream.runDrain,
        Effect.forkScoped,
      )
      yield* client.message.send({ ...at, content: label })
      yield* Fiber.join(turn)
      return yield* Effect.forEach(ops, (call) => {
        const found = results.find((result) => result.id === call.id)
        if (Predicate.isUndefined(found)) return Effect.die(`no result for ${call.id}`)
        return Effect.succeed(found)
      })
    })
  let calls = 0
  const op = (tool: ThreadOp["tool"], input: Record<string, string> = {}): ThreadOp => {
    calls += 1
    return { tool, input, id: `thread-op-${calls}` }
  }
  /** One call's output, which must have succeeded. */
  const one = (at: SessionKey, call: ThreadOp) =>
    Effect.flatMap(act(at, [call]), ([result]) => {
      if (result?.ok !== true) return Effect.die(`${call.tool} failed: ${result?.output}`)
      return Effect.succeed(result.output)
    })
  /** `at`'s listing, or one thread's row of it. */
  const list = (at: SessionKey, thread?: string) =>
    Effect.flatMap(
      one(at, op("thread.list", Record.filter({ thread }, Predicate.isNotUndefined))),
      decodeListed,
    )
  /** Read `at`'s listing until `ready` holds. */
  const listUntil = (
    at: SessionKey,
    ready: (rows: typeof ListedOutput.Type) => boolean,
    label: string,
  ) => waitFor(list(at), ready, 4_000, label)
  const start = (at: SessionKey, task: string) =>
    Effect.flatMap(one(at, op("thread.start", { task })), decodeStarted)
  /** A thread started on the credential `account`. */
  const startOn = (at: SessionKey, task: string, account: string) =>
    Effect.flatMap(one(at, op("thread.start", { task, account })), decodeStarted)
  const stop = (at: SessionKey, thread: string) =>
    Effect.flatMap(one(at, op("thread.stop", { thread })), decodeStopped)
  return { client, cwd, starter, gate, act, op, one, list, listUntil, start, startOn, stop }
})

type RigClient = Effect.Success<typeof threadRig>["client"]

/** The credential label each model step of the branch went out on, from its durable history. */
const stepSlots = (client: RigClient, target: SessionKey) =>
  client.session.events(target).pipe(
    Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
    Stream.flatMap((envelope) => {
      if (envelope.event._tag !== "StreamEnded") return Stream.empty
      return Stream.make(envelope.event.credential?.slot ?? "none")
    }),
    Stream.runCollect,
    Effect.map((slots) => Array.from(slots)),
  )

const decodeStarted = Schema.decodeEffect(StartedOutput)
const decodeListed = Schema.decodeEffect(ListedOutput)
const decodeStopped = Schema.decodeEffect(StoppedOutput)
const decodeStartedResult = Schema.decodeUnknownEffect(StartedResult)

/** A tool another extension registered, as the host holds it: its channels erased. */
type RegisteredTool = Parameters<typeof runToolWithCtx>[0]

const decodeMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))

/** A registered tool run as the host runs it; it fails with its error's message. */
const runRegistered = (
  leaf: RegisteredTool,
  input: Schema.Json,
  ctx: Parameters<typeof runToolWithCtx>[2],
): Effect.Effect<unknown, string> =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- a registered tool's channels are erased, as at the extension membrane
  runToolWithCtx(leaf, input, ctx).pipe(
    Effect.mapError((error) =>
      Option.match(decodeMessage(error), {
        onNone: () => String(error),
        onSome: (failure) => failure.message,
      }),
    ),
  )

describe("threads", () => {
  it.live(
    "a started thread is its own session under the starter, and nothing lands back on the starter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let starterCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            if (isThreadRequest(options.prompt)) return Effect.succeed(reply("thread done"))
            starterCalls += 1
            if (starterCalls > 1) return Effect.succeed(reply("started it"))
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart(
                  "thread.start",
                  { task: THREAD_TASK },
                  { toolCallId: ToolCallId.make("thread-start-call") },
                ),
                finishPart({ finishReason: "tool-calls" }),
              ]),
            )
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          const starterTurn = yield* turnEnds(client.session.events({ sessionId, branchId }), 1)
          yield* client.message.send({ sessionId, branchId, content: "Start a side thread" })
          yield* Fiber.join(starterTurn)
          const thread = yield* waitFor(
            client.session.list(),
            (sessions) => sessions.some((session) => session.parentSessionId === sessionId),
            3_000,
            "the thread session",
          ).pipe(Effect.map((sessions) => sessions.find((s) => s.parentSessionId === sessionId)))
          if (Predicate.isUndefined(thread?.activeBranchId)) return yield* Effect.die("no thread")
          // Its own key: a spawn, not a handoff of the starter.
          expect(sessionThread(thread)).toBe(thread.id)
          expect(thread.parentBranchId).toBe(branchId)
          const threadKey = { sessionId: thread.id, branchId: thread.activeBranchId }
          const threadMessages = yield* waitFor(
            client.message.list({ branchId: threadKey.branchId }),
            (messages) => messages.some((message) => message.role === "assistant"),
            3_000,
            "the thread's reply",
          )
          const task = threadMessages.find((message) => message.role === "user")
          expect(task?.metadata?.customType).toBe(THREAD_ROUND_TYPE)
          expect(messagePartsDisplayText(task?.parts ?? [])).toContain(THREAD_TASK)
          // The starter's conversation ends on its own reply: no completion,
          // no wake, so its cached prefix is what it was.
          const starterMessages = yield* client.message.list({ branchId })
          expect(starterMessages.at(-1)?.role).toBe("assistant")
          expect(messagePartsDisplayText(starterMessages.at(-1)?.parts ?? [])).toBe("started it")
          expect(starterCalls).toBe(2)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "thread.list shows a started thread running, then idle with its reply once its turn ends",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* threadRig
          const started = yield* rig.start(rig.starter, THREAD_TASK)
          const running = yield* rig.listUntil(
            rig.starter,
            (rows) => rows[0]?.status === "running",
            "the thread runs",
          )
          expect(running).toHaveLength(1)
          expect(running[0]).toMatchObject({
            thread: started.thread,
            sessions: 1,
            current: { sessionId: started.sessionId, branchId: started.branchId },
          })
          yield* Deferred.succeed(rig.gate, true)
          const idle = yield* rig.listUntil(
            rig.starter,
            (rows) => rows[0]?.status === "idle" && rows[0].preview.length > 0,
            "the thread ends",
          )
          expect(idle[0]?.preview).toBe("THREAD-REPLY: changelog tidied")
          const one = yield* rig.list(rig.starter, started.thread)
          expect(one.map((row) => row.preview)).toEqual(["THREAD-REPLY: changelog tidied"])
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a handoff inside a thread stays one thread, and its newest session is current",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* threadRig
          yield* Deferred.succeed(rig.gate, true)
          const started = yield* rig.start(rig.starter, THREAD_TASK)
          const handoff = yield* rig.client.session.create({
            cwd: rig.cwd,
            parentSessionId: started.sessionId,
            parentBranchId: started.branchId,
            continueThread: true,
          })
          const rows = yield* rig.list(rig.starter)
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({
            thread: started.thread,
            sessions: 2,
            current: { sessionId: handoff.sessionId, branchId: handoff.branchId },
          })
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a thread started with an account runs its rounds on that credential, and the starter keeps its own",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* threadRig
          yield* Deferred.succeed(rig.gate, true)
          const started = yield* rig.startOn(rig.starter, THREAD_TASK, "personal")
          const stored = yield* rig.client.session.get({ sessionId: started.sessionId })
          expect(stored?.admission?.runSpec?.credentialSlot).toBe(CredentialSlot.make("personal"))
          yield* rig.listUntil(
            rig.starter,
            (rows) => rows[0]?.status === "idle" && rows[0].preview.length > 0,
            "the thread's round ends",
          )
          const threadSlots = yield* stepSlots(rig.client, started)
          expect(threadSlots.length).toBeGreaterThan(0)
          expect(threadSlots.every((slot) => slot === "personal")).toBe(true)
          // The starter's run names no pin: it walks its order, whose first is the default.
          const starterSlots = yield* stepSlots(rig.client, rig.starter)
          expect(starterSlots.length).toBeGreaterThan(0)
          expect(starterSlots.every((slot) => slot === "default")).toBe(true)
          const starter = yield* rig.client.session.get({ sessionId: rig.starter.sessionId })
          expect(starter?.admission?.runSpec?.credentialSlot).toBeUndefined()
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a thread with no agent keeps its starter's account, and a named agent's thread runs on its own order",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* threadRig
          yield* Deferred.succeed(rig.gate, true)
          const pinned: SessionKey = yield* rig.client.session.create({
            cwd: rig.cwd,
            admission: { runSpec: { credentialSlot: CredentialSlot.make("work") } },
          })
          const pinOf = (call: ThreadOp) =>
            Effect.gen(function* () {
              const started = yield* Effect.flatMap(rig.one(pinned, call), decodeStarted)
              const stored = yield* rig.client.session.get({ sessionId: started.sessionId })
              return stored?.admission?.runSpec?.credentialSlot
            })
          expect(yield* pinOf(rig.op("thread.start", { task: THREAD_TASK }))).toBe(
            CredentialSlot.make("work"),
          )
          expect(
            yield* pinOf(rig.op("thread.start", { task: THREAD_TASK, account: "personal" })),
          ).toBe(CredentialSlot.make("personal"))
          expect(
            yield* pinOf(rig.op("thread.start", { task: THREAD_TASK, agent: "worker" })),
          ).toBeUndefined()
          expect(
            yield* pinOf(
              rig.op("thread.start", { task: THREAD_TASK, agent: "worker", account: "personal" }),
            ),
          ).toBe(CredentialSlot.make("personal"))
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live("a thread's account survives a handoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rig = yield* threadRig
        yield* Deferred.succeed(rig.gate, true)
        const started = yield* rig.startOn(rig.starter, THREAD_TASK, "personal")
        yield* rig.listUntil(
          rig.starter,
          (rows) => rows[0]?.status === "idle" && rows[0].preview.length > 0,
          "the thread's first round ends",
        )
        const handoff: SessionKey = yield* rig.client.session.create({
          cwd: rig.cwd,
          parentSessionId: started.sessionId,
          parentBranchId: started.branchId,
          continueThread: true,
        })
        const stored = yield* rig.client.session.get({ sessionId: handoff.sessionId })
        expect(stored?.admission?.runSpec?.credentialSlot).toBe(CredentialSlot.make("personal"))
        // The thread's next round runs on its newest session.
        const round = yield* turnEnds(rig.client.session.events(handoff), 1)
        yield* rig.client.message.send({ ...handoff, content: `${THREAD_TASK} again` })
        yield* Fiber.join(round)
        const slots = yield* stepSlots(rig.client, handoff)
        expect(slots.length).toBeGreaterThan(0)
        expect(slots.every((slot) => slot === "personal")).toBe(true)
      }).pipe(Effect.timeout("12 seconds")),
    ),
  )

  // A thread is a child session, named as a delegate child is: the TUI heads
  // with the name, so a long task gives a short label in whole words.
  it.live(
    "a thread is named by its task's first clause in whole words, or by its own name on one line",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* threadRig
          const nameOf = (input: Record<string, string>) =>
            Effect.gen(function* () {
              const output = yield* rig.one(rig.starter, rig.op("thread.start", input))
              const started = yield* decodeStarted(output)
              return (yield* rig.client.session.get({ sessionId: started.sessionId }))?.name
            })
          expect(
            yield* nameOf({
              task: `${THREAD_TASK} in every package (each release).\n\nThe rest of the task.`,
            }),
          ).toBe("THREAD-TASK: tidy the changelog…")
          expect(yield* nameOf({ task: THREAD_TASK, name: "  changelog\ntidy " })).toBe(
            "changelog tidy",
          )
          // A given default name is no name: the task names the thread.
          expect(yield* nameOf({ task: THREAD_TASK, name: DEFAULT_SESSION_NAME })).toBe(THREAD_TASK)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  // A default name marks a session the first message still names; a thread
  // is named when it starts, so its name never reads as the default.
  it.live(
    "a thread whose task opens with the default name keeps its name after its turns",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* threadRig
          const started = yield* rig.start(rig.starter, `${DEFAULT_SESSION_NAME} (${THREAD_TASK})`)
          const thread = { sessionId: started.sessionId, branchId: started.branchId }
          const nameOf = Effect.map(
            rig.client.session.get({ sessionId: thread.sessionId }),
            (found) => found?.name,
          )
          const named = yield* nameOf
          expect(named).not.toBe(DEFAULT_SESSION_NAME)
          const events = rig.client.session.events(thread)
          const first = yield* turnEnds(events, 1)
          // The loop runs a turn's `turnAfter` hooks before it takes the next
          // turn, so once the second turn ends the first one's hooks have run.
          const second = yield* turnEnds(events, 2)
          yield* Deferred.succeed(rig.gate, true)
          yield* Fiber.join(first)
          yield* rig.client.message.send({ ...thread, content: "again" })
          yield* Fiber.join(second)
          expect(yield* nameOf).toBe(named)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "thread.stop ends a running thread's turn, and refuses a thread another session started",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* threadRig
          const started = yield* rig.start(rig.starter, THREAD_TASK)
          yield* rig.listUntil(
            rig.starter,
            (rows) => rows[0]?.status === "running",
            "the thread runs",
          )
          const other: SessionKey = yield* rig.client.session.create({ cwd: rig.cwd })
          const [refused] = yield* rig.act(other, [
            rig.op("thread.stop", { thread: started.thread }),
          ])
          expect(refused?.ok).toBe(false)
          expect(refused?.output).toContain("is not a thread started by this session's thread")
          const result = yield* rig.stop(rig.starter, started.thread)
          expect(result.stopped).toEqual([
            { sessionId: started.sessionId, branchId: started.branchId },
          ])
          const after = yield* rig.listUntil(
            rig.starter,
            (rows) => rows[0]?.status === "idle",
            "the stopped thread is idle",
          )
          expect(after[0]?.preview).toBe("")
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "eight starts in one model step: four run and the rest are refused, naming them and leaving no session",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* threadRig
          const before = (yield* rig.client.session.list()).length
          // A step runs up to eight tool calls at once: every start races.
          const results = yield* rig.act(
            rig.starter,
            [1, 2, 3, 4, 5, 6, 7, 8].map((index) =>
              rig.op("thread.start", { task: `${THREAD_TASK} ${index}` }),
            ),
          )
          const refused = results.filter((result) => !result.ok)
          expect(refused).toHaveLength(4)
          const started = yield* Effect.forEach(
            results.filter((result) => result.ok),
            (result) => decodeStarted(result.output),
          )
          for (const refusal of refused) {
            expect(refusal.output).toContain("already runs 4 threads")
            for (const thread of started) expect(refusal.output).toContain(thread.thread)
          }
          // The refused start leaves no session behind.
          expect((yield* rig.client.session.list()).length).toBe(before + 4)
          const rows = yield* rig.listUntil(
            rig.starter,
            (found) => found.filter((row) => row.status === "running").length === 4,
            "four threads run",
          )
          expect(rows).toHaveLength(4)
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "after a handoff the new session lists, stops and counts the threads its thread started",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* threadRig
          const started = yield* rig
            .act(
              rig.starter,
              [1, 2, 3].map((index) => rig.op("thread.start", { task: `${THREAD_TASK} ${index}` })),
            )
            .pipe(Effect.flatMap(Effect.forEach((result) => decodeStarted(result.output))))
          const handoff: SessionKey = yield* rig.client.session.create({
            cwd: rig.cwd,
            parentSessionId: rig.starter.sessionId,
            parentBranchId: rig.starter.branchId,
            continueThread: true,
          })
          // The handoff starts a fourth: the cap holds four for the whole thread.
          const own = (yield* rig.start(handoff, `${THREAD_TASK} own`)).thread
          const rows = yield* rig.listUntil(
            handoff,
            (found) => found.length === 4 && found.every((row) => row.status === "running"),
            "the thread's four threads run",
          )
          expect(rows.map((row) => row.thread).toSorted()).toEqual(
            [...started.map((entry) => entry.thread), own].toSorted(),
          )
          // The cap counts every thread the thread started, in either session.
          const [capped] = yield* rig.act(handoff, [
            rig.op("thread.start", { task: `${THREAD_TASK} fifth` }),
          ])
          expect(capped?.ok).toBe(false)
          expect(capped?.output).toContain("already runs 4 threads")
          // The older session's thread is the handoff's to stop.
          const first = started[0]
          if (Predicate.isUndefined(first)) return yield* Effect.die("no started thread")
          const stopped = yield* rig.stop(handoff, first.thread)
          expect(stopped.stopped).toEqual([
            { sessionId: first.sessionId, branchId: first.branchId },
          ])
          // The older session reads the newer one's thread too.
          const fromStarter = yield* rig.list(rig.starter)
          expect(fromStarter.map((row) => row.thread)).toContain(own)
        }).pipe(Effect.timeout("14 seconds")),
      ),
    16_000,
  )

  it.live(
    "with the thread's first session deleted, its newest session still lists, stops and counts what the thread started",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rig = yield* threadRig
          // A1 hands off to A2, A2 starts C and hands off to A3.
          const handoff = (from: SessionKey) =>
            rig.client.session.create({
              cwd: rig.cwd,
              parentSessionId: from.sessionId,
              parentBranchId: from.branchId,
              continueThread: true,
            })
          const second: SessionKey = yield* handoff(rig.starter)
          const child = yield* rig.start(second, THREAD_TASK)
          const third: SessionKey = yield* handoff(second)
          // A delete of A1 keeps its handoffs and what they started.
          yield* rig.client.session.delete({ sessionId: rig.starter.sessionId })
          const rows = yield* rig.list(third)
          expect(rows.map((row) => row.thread)).toEqual([child.thread])
          // The cap counts C: three more run, and one of four is refused.
          const more = yield* rig.act(
            third,
            [1, 2, 3, 4].map((index) =>
              rig.op("thread.start", { task: `${THREAD_TASK} ${index}` }),
            ),
          )
          // The four starts run at once: which one is refused is not fixed.
          const refused = more.filter((result) => !result.ok)
          expect(more).toHaveLength(4)
          expect(refused).toHaveLength(1)
          expect(refused[0]?.output).toContain("already runs 4 threads")
          const stopped = yield* rig.stop(third, child.thread)
          expect(stopped.stopped).toEqual([
            { sessionId: child.sessionId, branchId: child.branchId },
          ])
        }).pipe(Effect.timeout("14 seconds")),
      ),
    16_000,
  )

  it.live(
    "a repeated start of one tool call is one thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // A model never repeats a call id, so a replay is run here as the
          // host replays a call a lost process left: the registered tool,
          // its process permit, the same call id twice.
          const contributions = yield* collectTestContributions(SessionToolsExtension.setup)
          const start = contributions.tools?.find((tool) => getToolId(tool) === "thread.start")
          const permit = contributions.resources?.find(
            (resource) => resource.id === "@gent/session-tools/threads",
          )
          if (Predicate.isUndefined(start) || Predicate.isUndefined(permit)) {
            return yield* Effect.die("session tools register no thread.start or permit")
          }
          const cwd = yield* makeTempDirectoryScoped("gent-threads-")
          const providerLayer = LanguageModelLayers.testStream(() =>
            Effect.succeed(reply("THREAD-REPLY: changelog tidied")),
          )
          const context = yield* Layer.build(createE2ELayer({ ...e2ePreset, cwd, providerLayer }))
          const buildPermits: Effect.Effect<
            Context.Context<never>,
            never,
            Scope.Scope
          > = Layer.build(permit.layer).pipe(Effect.provideContext(context), Effect.orDie)
          const permits = yield* buildPermits
          const { client } = yield* createRpcClient(Layer.succeedContext(context))
          const starter: SessionKey = yield* client.session.create({ cwd })
          const run = Effect.gen(function* () {
            const host = yield* runtimeHostContext(starter)
            const output = yield* runRegistered(
              start,
              { task: THREAD_TASK },
              {
                ...host,
                extensionId: SESSION_TOOLS_EXTENSION_ID,
                toolCallId: ToolCallId.make("same"),
              },
            ).pipe(Effect.orDie)
            return yield* decodeStartedResult(output)
          }).pipe(
            Effect.provideContext(Context.merge(context, permits)),
            Effect.provideService(CurrentWorkspaceId, workspaceIdForCwd(cwd)),
          )
          const first = yield* run
          const second = yield* run
          expect(second.sessionId).toBe(first.sessionId)
          const children = (yield* client.session.list()).filter(
            (session) => session.parentSessionId === starter.sessionId,
          )
          expect(children).toHaveLength(1)
          // Once the thread answered, its branch holds every task it was sent.
          const messages = yield* waitFor(
            client.message.list({ branchId: first.branchId }),
            (found) => found.some((message) => message.role === "assistant"),
            3_000,
            "the thread's reply",
          )
          expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a delegate thread is not offered thread.start; its starter is",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childTask = "CHILD-TASK: reply with pong"
          const offered = new Map<"parent" | "child", ReadonlyArray<string>>()
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const names = options.tools.map((entry) => entry.name)
            if (userTexts(options.prompt)[0]?.includes(childTask) === true) {
              offered.set("child", names)
              return Effect.succeed(reply("pong"))
            }
            if (!offered.has("parent")) offered.set("parent", names)
            if (options.prompt.content.some((message) => message.role === "tool")) {
              return Effect.succeed(reply("started"))
            }
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart(
                  "thread.start",
                  { task: childTask, agent: "delegate", notify: "starter" },
                  { toolCallId: ToolCallId.make("start-child") },
                ),
                finishPart({ finishReason: "tool-calls" }),
              ]),
            )
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "delegate it" })
          yield* waitFor(
            Effect.sync(() => offered.get("child")),
            Predicate.isNotUndefined,
            5_000,
            "the child's request",
          )
          expect(offered.get("parent")).toContain("thread__start")
          expect(offered.get("child")).not.toContain("thread__start")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── rounds: scripted models ─────────────────────────────────────────────────

/**
 * One model serves every session, so each request is routed by what it
 * carries: a worker's system prompt holds the worker agent's addendum, and
 * every other request is the starter's. The starter reads its last user
 * message: a `CALL <tool> <id> <json>` line per tool call, made once, then
 * `done`; any other message (a round's end) it notes. A worker reads its
 * round: `ECHO <text>` answers the text, `REPLY <tag> <json>` calls
 * `thread.reply` once then answers, and `HANG` never answers.
 */

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const billed = (text: string) =>
  Stream.fromIterable([
    textDeltaPart(text),
    finishPart({ finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20 } }),
  ])

const toolCalls = (
  calls: ReadonlyArray<{
    readonly tool: string
    readonly id: string
    readonly input: Schema.Json
  }>,
) =>
  Stream.fromIterable([
    ...calls.map((entry) =>
      toolCallPart(entry.tool, entry.input, { toolCallId: ToolCallId.make(entry.id) }),
    ),
    finishPart({ finishReason: "tool-calls", usage: { inputTokens: 50, outputTokens: 10 } }),
  ])

const userIndex = (prompt: Prompt.Prompt) =>
  prompt.content.findLastIndex((message) => message.role === "user")

const lastUserText = (prompt: Prompt.Prompt): string => {
  const message = prompt.content[userIndex(prompt)]
  if (Predicate.isUndefined(message) || message.role !== "user") return ""
  return message.content
    .flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
    .join("\n")
}

/** The model already answered the last user message with a step of its own. */
const acted = (prompt: Prompt.Prompt) => userIndex(prompt) < prompt.content.length - 1

const isWorkerRequest = (prompt: Prompt.Prompt) =>
  systemTextOf(prompt).includes("You are a worker thread")

const starterStep = (prompt: Prompt.Prompt) => {
  const text = lastUserText(prompt)
  if (!text.startsWith("CALL ")) return billed("noted")
  if (acted(prompt)) return billed("done")
  return toolCalls(
    text.split("\n").map((entry) => {
      const [, name = "", id = "", ...rest] = entry.split(" ")
      return { tool: name, id, input: parseJson(rest.join(" ")) }
    }),
  )
}

/** The tool a worker calls for a `BLOCK` round: it never returns (`blockProbe`). */
const BLOCK_TOOL = "probe.block"
const HOLD_TOOL = "probe.hold"

const workerStep = (prompt: Prompt.Prompt, hang: Effect.Effect<void>) => {
  const text = lastUserText(prompt)
  if (/^HANG/m.test(text)) return Stream.unwrap(Effect.as(hang, Stream.never))
  if (/^BLOCK/m.test(text)) {
    if (acted(prompt)) return billed("unblocked")
    return toolCalls([{ tool: BLOCK_TOOL, id: "block-1", input: {} }])
  }
  if (/^HOLD/m.test(text)) {
    if (acted(prompt)) return billed("released")
    return toolCalls([{ tool: HOLD_TOOL, id: "hold-1", input: {} }])
  }
  const replyLine = /^REPLY (\S+) (.*)$/m.exec(text)
  if (Predicate.isNotNull(replyLine)) {
    if (acted(prompt)) return billed(`replied ${replyLine[1]}`)
    return toolCalls([
      {
        tool: "thread.reply",
        id: `reply-${replyLine[1]}`,
        input: { value: parseJson(replyLine[2]) },
      },
    ])
  }
  const echo = /^ECHO (.*)$/m.exec(text)
  if (Predicate.isNull(echo)) return billed("nothing asked")
  return billed(echo[1] ?? "")
}

/** The routed model; `hang` runs before a `HANG` round stalls forever. */
const workerModels = (hang: Effect.Effect<void> = Effect.void) =>
  LanguageModelLayers.testStream((options) => {
    if (isWorkerRequest(options.prompt)) return Effect.succeed(workerStep(options.prompt, hang))
    return Effect.succeed(starterStep(options.prompt))
  })

// ── rounds: reading the starter ─────────────────────────────────────────────

type Client = Effect.Success<ReturnType<typeof createRpcClient>>["client"]

interface SnapshotMessage {
  readonly role: string
  readonly parts: ReadonlyArray<Prompt.Part>
  readonly metadata?: { readonly customType?: string; readonly details?: unknown }
}

/** Every result of one tool call id, in order. */
const toolResults = (messages: ReadonlyArray<SnapshotMessage>, id: string) =>
  messages
    .flatMap((message) => message.parts)
    .flatMap((part) => {
      if (part.type !== "tool-result" || part.id !== id) return []
      return [{ result: part.result, failed: part.isFailure }]
    })

const wakes = (messages: ReadonlyArray<SnapshotMessage>) =>
  messages.filter((message) => message.metadata?.customType === THREAD_ROUND_END_TYPE)

const partsText = (parts: ReadonlyArray<Prompt.Part>) =>
  parts.flatMap((part) => {
    if (part.type !== "text") return []
    return [part.text]
  })

const wakeTexts = (messages: ReadonlyArray<SnapshotMessage>) =>
  wakes(messages).flatMap((message) => partsText(message.parts))

const callLine = (name: string, id: string, input: Schema.Json) =>
  `CALL ${name} ${id} ${encodeJson(input)}`

/**
 * The starter makes each call once, in one step, and ends its turn; returns
 * each call's result by its id, in order.
 */
const call = (
  client: Client,
  place: SessionKey,
  calls: ReadonlyArray<readonly [tool: string, id: string, input: Schema.Json]>,
  within = 8_000,
) =>
  Effect.gen(function* () {
    const before = yield* client.session.getSnapshot(place)
    const counts = calls.map(([, id]) => toolResults(before.messages, id).length)
    yield* client.message.send({
      ...place,
      content: calls.map(([name, id, input]) => callLine(name, id, input)).join("\n"),
    })
    const snapshot = yield* waitFor(
      client.session.getSnapshot(place),
      (current) =>
        current.runtime._tag === "Idle" &&
        calls.every(
          ([, id], index) => toolResults(current.messages, id).length > (counts[index] ?? 0),
        ),
      within,
      `the starter ran ${calls.map(([, id]) => id).join(", ")}`,
    )
    return calls.map(([, id]) => toolResults(snapshot.messages, id).at(-1))
  })

const waitForWakes = (client: Client, place: SessionKey, count: number) =>
  waitFor(
    client.session.getSnapshot(place),
    (current) => current.runtime._tag === "Idle" && wakes(current.messages).length >= count,
    8_000,
    `${count} round ends woke the starter`,
  )

const decodeThread = Schema.decodeUnknownSync(StartedResult)
const RoundHandle = Schema.Struct({ round: Schema.String, number: Schema.Finite })
const decodeRound = Schema.decodeUnknownSync(RoundHandle)
const jsonText = (value: Schema.Json): string => {
  if (Predicate.isString(value)) return value
  return encodeJson(value)
}
/** A tool result as text: a string as it is, any other value as its JSON. */
const textOf = flow(Schema.decodeUnknownSync(Schema.Json), jsonText)
/** A round read's reply, absent when it is null. */
const replyOf = flow(
  Schema.decodeUnknownSync(Schema.Struct({ reply: Schema.NullOr(Schema.Json) })),
  (view) => Option.fromNullishOr(view.reply),
)

const roundHarness = (
  options: {
    readonly hang?: Effect.Effect<void>
    readonly extensions?: ReadonlyArray<(typeof e2ePreset.extensionInputs)[number]>
    /** The user's own `~/.gent/config.json`. */
    readonly userConfig?: string
  } = {},
) =>
  Effect.gen(function* () {
    const home = yield* makeTempDirectoryScoped("threads-")
    const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
    const userConfig = options.userConfig
    if (Predicate.isNotUndefined(userConfig)) {
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${home}/.gent`, { recursive: true })
        yield* fs.writeFileString(`${home}/.gent/config.json`, userConfig)
      }).pipe(Effect.provide(BunServices.layer))
    }
    return yield* createRpcHarness({
      ...e2ePreset,
      extensionInputs: [...e2ePreset.extensionInputs, ...(options.extensions ?? [])],
      providerLayer: workerModels(options.hang),
      cwd,
      home,
    })
  })

/** Two worker threads with no task: each waits for its first round. */
const startTwo = (client: Client, place: SessionKey) =>
  Effect.gen(function* () {
    const [impl, rev] = yield* call(client, place, [
      [
        "thread.start",
        "start-impl",
        {
          name: "impl",
          agent: "worker",
          model: "test/impl-model",
          effort: "medium",
          instructions: "ROLE impl",
        },
      ],
      [
        "thread.start",
        "start-rev",
        { name: "rev", agent: "worker", model: "test/rev-model", instructions: "ROLE rev" },
      ],
    ])
    expect(impl?.failed).toBe(false)
    expect(rev?.failed).toBe(false)
    return { impl: decodeThread(impl?.result), rev: decodeThread(rev?.result) }
  })

const ListedRows = Schema.Array(
  Schema.Struct({
    thread: SessionId,
    name: Schema.String,
    agent: Schema.optionalKey(Schema.String),
    sessions: Schema.Finite,
    current: Schema.Struct({ sessionId: SessionId, branchId: BranchId }),
    status: Schema.Literals(["running", "idle"]),
    openRound: Schema.optionalKey(RoundHandle),
    lastRound: Schema.optionalKey(
      Schema.Struct({
        ...RoundHandle.fields,
        interrupted: Schema.Boolean,
        streamFailed: Schema.Boolean,
        unanswered: Schema.Boolean,
        stopped: Schema.Boolean,
      }),
    ),
    preview: Schema.String,
  }),
)
const decodeListedRows = Schema.decodeUnknownSync(ListedRows)

/** A listing's rows by thread key: threads started in one step have no fixed order. */
const byThread = flow(decodeListedRows, (rows) =>
  Object.fromEntries(rows.map((row) => [row.thread, row])),
)

const placeOf = (thread: typeof StartedResult.Type): SessionKey => ({
  sessionId: thread.sessionId,
  branchId: thread.branchId,
})

/** One worker thread with no task, started by `place` under the call id `id`. */
const startWorker = (
  client: Client,
  place: SessionKey,
  id: string,
  input: Record<string, Schema.Json> = {},
) =>
  Effect.gen(function* () {
    const [started] = yield* call(client, place, [
      ["thread.start", id, { name: id, agent: "worker", ...input }],
    ])
    expect(started?.failed).toBe(false)
    return decodeThread(started?.result)
  })

/** The round read by `place` until `ready` holds. */
const readRoundUntil = (
  client: Client,
  place: SessionKey,
  round: string,
  id: string,
  ready: (text: string) => boolean,
) =>
  waitFor(
    call(client, place, [["thread.round", id, { round }]]),
    ([found]) => found?.failed === false && ready(textOf(found.result)),
    8_000,
    `round ${round} is read as ready`,
  ).pipe(Effect.map(([found]) => found))

/**
 * A tool that never returns: a worker's `BLOCK` round runs it, so its turn
 * is stopped between steps, with its first step's usage known.
 */
const blockProbe = (entered: Deferred.Deferred<boolean>) =>
  defineExtension({
    id: "threads-block-probe",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register(
        "tool",
        tool({
          id: BLOCK_TOOL,
          description: "Block until stopped.",
          params: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.andThen(Deferred.succeed(entered, true), Effect.never),
        }),
      )
    }),
  })

/**
 * A tool that holds its turn until `release`, and lets no stop cut it short:
 * it runs uninterruptible, as a tool that must finish its own cleanup does.
 */
const holdProbe = (entered: Deferred.Deferred<boolean>, release: Deferred.Deferred<boolean>) =>
  defineExtension({
    id: "threads-hold-probe",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register(
        "tool",
        tool({
          id: HOLD_TOOL,
          description: "Hold until released.",
          params: Schema.Struct({}),
          output: Schema.String,
          execute: () =>
            Effect.uninterruptible(
              Deferred.succeed(entered, true).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as("released"),
              ),
            ),
        }),
      )
    }),
  })

// ── rounds: acceptance ──────────────────────────────────────────────────────

describe("thread rounds", () => {
  it.live(
    "two worker threads take rounds, each end wakes the starter, a reply is recorded, and stop closes the thread's round",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, sessionId, branchId } = yield* roundHarness()
          const starter = { sessionId, branchId }
          const { impl, rev } = yield* startTwo(client, starter)
          expect(impl.thread).not.toBe(rev.thread)

          // A start with no task sends nothing: the worker waits.
          const idle = yield* client.session.getSnapshot(placeOf(impl))
          expect(idle.messages).toEqual([])
          const implSession = yield* client.session.get({ sessionId: impl.sessionId })
          expect(implSession?.parentSessionId).toBe(sessionId)

          // Round 1: impl answers in text; its message says an agent wrote it.
          const [sent] = yield* call(client, starter, [
            [
              "thread.send",
              "send-1",
              { thread: impl.thread, message: "ECHO built round one", notify: "starter" },
            ],
          ])
          const first = decodeRound(sent?.result)
          expect(first.number).toBe(1)
          const woke = yield* waitForWakes(client, starter, 1)
          const [wake] = wakeTexts(woke.messages)
          expect(wake).toContain(first.round)
          expect(wake).toContain("round 1 completed")
          expect(wake).toContain("built round one")
          const worker = yield* client.session.getSnapshot(placeOf(impl))
          expect(worker.messages[0]?.metadata).toMatchObject({
            customType: THREAD_ROUND_TYPE,
            details: { round: first.round, createdBy: "agent", starter: sessionId },
          })

          const [read] = yield* call(client, starter, [
            ["thread.round", "read-1", { round: first.round }],
          ])
          expect(replyOf(read?.result)).toEqual(Option.none())
          expect(read?.result).toMatchObject({
            status: "ended",
            round: first.round,
            thread: impl.thread,
            number: 1,
            text: "built round one",
            replyAsked: false,
            interrupted: false,
            usage: { input: 100, output: 20 },
          })

          // Round 2: rev must reply with a value, and does.
          const [sentRev] = yield* call(client, starter, [
            [
              "thread.send",
              "send-2",
              {
                thread: rev.thread,
                message: 'REPLY r2 {"verdict":"accepted","findings":[]}',
                reply: "verdict: accepted | changes, findings[]",
                notify: "starter",
              },
            ],
          ])
          const second = decodeRound(sentRev?.result)
          const wokeTwice = yield* waitForWakes(client, starter, 2)
          expect(wakeTexts(wokeTwice.messages)[1]).toContain("reply recorded")
          const [readRev] = yield* call(client, starter, [
            ["thread.round", "read-2", { round: second.round }],
          ])
          expect(readRev?.result).toMatchObject({
            status: "ended",
            text: "replied r2",
            reply: { verdict: "accepted", findings: [] },
            replyAsked: true,
            // Two steps: the reply call and the answer.
            usage: { input: 150, output: 30 },
          })
          const revSession = yield* client.session.getSnapshot(placeOf(rev))
          expect(partsText(revSession.messages[0]?.parts ?? []).join("\n")).toContain(
            "This round asks for a reply value: verdict: accepted | changes, findings[]",
          )

          // A round that asked for a reply and got none says so.
          const [sentBare] = yield* call(client, starter, [
            [
              "thread.send",
              "send-3",
              {
                thread: impl.thread,
                message: "ECHO no value here",
                reply: "a number",
                notify: "starter",
              },
            ],
          ])
          const bare = decodeRound(sentBare?.result)
          expect(bare.number).toBe(2)
          const wokeThrice = yield* waitForWakes(client, starter, 3)
          expect(wakeTexts(wokeThrice.messages)[2]).toContain("no reply")
          const [readBare] = yield* call(client, starter, [
            ["thread.round", "read-3", { round: bare.round }],
          ])
          expect(readBare?.result).toMatchObject({ replyAsked: true })
          expect(replyOf(readBare?.result)).toEqual(Option.none())

          // A round sent with the default notify wakes nobody; its end is recorded.
          const [sentQuiet] = yield* call(client, starter, [
            ["thread.send", "send-4", { thread: rev.thread, message: "ECHO for the user" }],
          ])
          const quiet = decodeRound(sentQuiet?.result)
          const [readQuiet] = yield* waitFor(
            call(client, starter, [["thread.round", "read-4", { round: quiet.round }]]),
            ([found]) => textOf(found?.result).includes('"status":"ended"'),
            8_000,
            "the user's round ended",
          )
          expect(readQuiet?.result).toMatchObject({ text: "for the user" })
          const [stopped, listed] = yield* call(client, starter, [
            ["thread.stop", "stop-1", { thread: impl.thread }],
            ["thread.list", "list-1", {}],
          ])
          expect(stopped?.result).toEqual({ stopped: [] })
          expect(byThread(listed?.result)).toMatchObject({
            [impl.thread]: { name: "impl", agent: "worker", status: "idle" },
            [rev.thread]: { name: "rev", agent: "worker", status: "idle" },
          })
          expect(wakes((yield* client.session.getSnapshot(starter)).messages)).toHaveLength(3)
        }).pipe(Effect.timeout("40 seconds")),
      ),
    45_000,
  )

  it.live(
    "a send to a thread with an open round is refused, naming it; thread.stop closes that round with no wake",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hanging = yield* Deferred.make<boolean>()
          const { client, sessionId, branchId } = yield* roundHarness({
            hang: Effect.asVoid(Deferred.succeed(hanging, true)),
          })
          const starter = { sessionId, branchId }
          const { impl, rev } = yield* startTwo(client, starter)
          const [sent] = yield* call(client, starter, [
            [
              "thread.send",
              "send-hang",
              { thread: impl.thread, message: "HANG", notify: "starter" },
            ],
          ])
          const open = decodeRound(sent?.result)
          yield* Deferred.await(hanging)
          const [busy] = yield* call(client, starter, [
            ["thread.send", "send-busy", { thread: impl.thread, message: "ECHO too soon" }],
          ])
          expect(busy?.failed).toBe(true)
          expect(textOf(busy?.result)).toContain(`is running round 1 (${open.round})`)

          const [listed] = yield* call(client, starter, [["thread.list", "list-busy", {}]])
          expect(byThread(listed?.result)).toMatchObject({
            [impl.thread]: { status: "running", openRound: open },
            [rev.thread]: { name: "rev", status: "idle" },
          })

          const [stopped] = yield* call(client, starter, [
            ["thread.stop", "stop-busy", { thread: impl.thread }],
          ])
          expect(stopped?.result).toMatchObject({ round: open.round })
          const [read] = yield* call(client, starter, [
            ["thread.round", "read-busy", { round: open.round }],
          ])
          expect(read?.result).toMatchObject({ status: "ended", interrupted: true, stopped: true })
          const snapshot = yield* client.session.getSnapshot(starter)
          expect(wakes(snapshot.messages)).toEqual([])
          // The thread takes its next round.
          const [next] = yield* call(client, starter, [
            ["thread.send", "send-next", { thread: impl.thread, message: "ECHO after the stop" }],
          ])
          expect(decodeRound(next?.result).number).toBe(2)
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "thread.list shows each thread's open round and its last ended round",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hanging = yield* Deferred.make<boolean>()
          const { client, sessionId, branchId } = yield* roundHarness({
            hang: Effect.asVoid(Deferred.succeed(hanging, true)),
          })
          const starter = { sessionId, branchId }
          const { impl, rev } = yield* startTwo(client, starter)
          // A thread that took no round has neither.
          const [fresh] = yield* call(client, starter, [["thread.list", "list-fresh", {}]])
          expect(byThread(fresh?.result)[impl.thread]?.openRound).toBeUndefined()
          expect(byThread(fresh?.result)[impl.thread]?.lastRound).toBeUndefined()

          const [sent] = yield* call(client, starter, [
            [
              "thread.send",
              "send-first",
              { thread: impl.thread, message: "ECHO first", notify: "starter" },
            ],
          ])
          const first = decodeRound(sent?.result)
          yield* waitForWakes(client, starter, 1)
          const [sentHang] = yield* call(client, starter, [
            [
              "thread.send",
              "send-hang-listed",
              { thread: impl.thread, message: "HANG", notify: "starter" },
            ],
          ])
          const open = decodeRound(sentHang?.result)
          yield* Deferred.await(hanging)
          // While the second round runs, the row names it open and the first as the last that ended.
          const [running] = yield* call(client, starter, [["thread.list", "list-running", {}]])
          expect(byThread(running?.result)).toMatchObject({
            [impl.thread]: {
              status: "running",
              openRound: open,
              lastRound: {
                ...first,
                interrupted: false,
                streamFailed: false,
                unanswered: false,
                stopped: false,
              },
            },
            [rev.thread]: { status: "idle" },
          })
          expect(byThread(running?.result)[rev.thread]?.lastRound).toBeUndefined()

          yield* call(client, starter, [["thread.stop", "stop-listed", { thread: impl.thread }]])
          // Once stopped, no round is open and the stopped one is the last, as stopped.
          const [listed] = yield* waitFor(
            call(client, starter, [["thread.list", "list-stopped", {}]]),
            ([found]) => byThread(found?.result)[impl.thread]?.lastRound?.round === open.round,
            8_000,
            "the stopped round is the thread's last",
          )
          const row = byThread(listed?.result)[impl.thread]
          expect(row?.openRound).toBeUndefined()
          expect(row?.lastRound).toMatchObject({ ...open, interrupted: true, stopped: true })
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a session whose thread did not start the thread cannot send to it or read its rounds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, sessionId, branchId } = yield* roundHarness()
          const starter = { sessionId, branchId }
          const { impl } = yield* startTwo(client, starter)
          const [sent] = yield* call(client, starter, [
            [
              "thread.send",
              "send-own",
              { thread: impl.thread, message: "ECHO mine", notify: "starter" },
            ],
          ])
          const round = decodeRound(sent?.result)
          yield* waitForWakes(client, starter, 1)

          const stranger = yield* client.session.create({})
          const place = { sessionId: stranger.sessionId, branchId: stranger.branchId }
          const results = yield* call(client, place, [
            ["thread.send", "send-other", { thread: impl.thread, message: "ECHO theirs" }],
            ["thread.round", "read-other", { round: round.round }],
            ["thread.stop", "stop-other", { thread: impl.thread }],
            ["thread.list", "list-other", {}],
          ])
          for (const result of results.slice(0, 3)) {
            expect(result?.failed).toBe(true)
            expect(textOf(result?.result)).toContain(
              "is not a thread started by this session's thread",
            )
          }
          expect(results[3]?.result).toEqual([])
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a round sent after the thread handed off reaches its new session, and its end is recorded",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, sessionId, branchId } = yield* roundHarness()
          const starter = { sessionId, branchId }
          const { impl, rev } = yield* startTwo(client, starter)
          const [sent] = yield* call(client, starter, [
            [
              "thread.send",
              "send-before",
              { thread: impl.thread, message: "ECHO before", notify: "starter" },
            ],
          ])
          decodeRound(sent?.result)
          yield* waitForWakes(client, starter, 1)

          // The worker's context filled: it hands off, and keeps its thread key.
          const handoff: SessionKey = yield* client.session.create({
            parentSessionId: impl.sessionId,
            parentBranchId: impl.branchId,
            continueThread: true,
          })
          const [after] = yield* call(client, starter, [
            [
              "thread.send",
              "send-after",
              { thread: impl.thread, message: "ECHO after", notify: "starter" },
            ],
          ])
          const round = decodeRound(after?.result)
          expect(round.number).toBe(2)
          const woke = yield* waitForWakes(client, starter, 2)
          expect(wakeTexts(woke.messages)[1]).toContain("after")
          const moved = yield* client.session.getSnapshot(handoff)
          expect(
            moved.messages.some((message) => message.metadata?.customType === THREAD_ROUND_TYPE),
          ).toBe(true)
          const old = yield* client.session.getSnapshot(placeOf(impl))
          expect(old.messages.filter((message) => message.role === "user")).toHaveLength(1)
          const [read, listed] = yield* call(client, starter, [
            ["thread.round", "read-after", { round: round.round }],
            ["thread.list", "list-after", {}],
          ])
          expect(read?.result).toMatchObject({
            status: "ended",
            thread: impl.thread,
            text: "after",
          })
          expect(byThread(listed?.result)).toMatchObject({
            [impl.thread]: {
              sessions: 2,
              current: { sessionId: handoff.sessionId, branchId: handoff.branchId },
            },
            [rev.thread]: { name: "rev", sessions: 1 },
          })
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )
})

describe("thread round ownership", () => {
  // A tool call id is unique only in its session: two sessions' calls may share one.
  it.live(
    "two sessions' starts under one tool call id make two threads, each under its own starter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, sessionId, branchId } = yield* roundHarness()
          const first = { sessionId, branchId }
          const second: SessionKey = yield* client.session.create({})
          const mine = yield* startWorker(client, first, "start-same")
          const [theirs] = yield* call(client, second, [
            [
              "thread.start",
              "start-same",
              { name: "theirs", agent: "worker", task: "ECHO the second session's task" },
            ],
          ])
          expect(theirs?.failed).toBe(false)
          const started = decodeThread(theirs?.result)
          expect(started.thread).not.toBe(mine.thread)
          const session = yield* client.session.get({ sessionId: started.sessionId })
          expect(session?.parentSessionId).toBe(second.sessionId)
          // The first session's thread got no round from the second one.
          const untouched = yield* client.session.getSnapshot(placeOf(mine))
          expect(untouched.messages).toEqual([])
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a round the thread's full queue refuses leaves no open round, so the thread is not held busy",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hanging = yield* Deferred.make<boolean>()
          const { client, sessionId, branchId } = yield* roundHarness({
            hang: Effect.asVoid(Deferred.succeed(hanging, true)),
          })
          const starter = { sessionId, branchId }
          const impl = yield* startWorker(client, starter, "start-impl")
          // The user keeps the thread busy and fills its follow-up queue.
          yield* client.message.send({ ...placeOf(impl), content: "HANG" })
          yield* Deferred.await(hanging)
          for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
            yield* client.message.send({ ...placeOf(impl), content: `ECHO queued ${index}` })
          }
          const [refused] = yield* call(client, starter, [
            ["thread.send", "send-full", { thread: impl.thread, message: "ECHO one more" }],
          ])
          expect(refused?.failed).toBe(true)
          expect(textOf(refused?.result)).toContain("queue full")
          const [listed] = yield* call(client, starter, [["thread.list", "list-full", {}]])
          expect(byThread(listed?.result)[impl.thread]?.openRound).toBeUndefined()
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a send that fails after its turn reached the thread keeps the round, and it ends with its bill",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // A send can fail after the loop admitted its turn (its reply was
          // lost, or a concurrent repeat of the same request was refused as
          // already processing). Only a full queue proves the turn is out.
          const contributions = yield* collectTestContributions(SessionToolsExtension.setup)
          const toolOf = (id: string) =>
            Effect.fromNullishOr(
              contributions.tools?.find((candidate) => getToolId(candidate) === id),
            ).pipe(Effect.orDie)
          const startTool = yield* toolOf("thread.start")
          const sendTool = yield* toolOf("thread.send")
          const roundTool = yield* toolOf("thread.round")
          const resource = yield* Effect.fromNullishOr(
            contributions.resources?.find(
              (candidate) => candidate.id === "@gent/session-tools/threads",
            ),
          ).pipe(Effect.orDie)
          const cwd = yield* makeTempDirectoryScoped("gent-threads-")
          const home = yield* makeTempDirectoryScoped("threads-")
          const context = yield* Layer.build(
            createE2ELayer({ ...e2ePreset, cwd, home, providerLayer: workerModels() }),
          )
          const buildResource: Effect.Effect<
            Context.Context<never>,
            never,
            Scope.Scope
          > = Layer.build(resource.layer).pipe(Effect.provideContext(context), Effect.orDie)
          const threads = yield* buildResource
          const { client } = yield* createRpcClient(Layer.succeedContext(context))
          const starter: SessionKey = yield* client.session.create({ cwd })
          const lost = new ExtensionServiceError({
            service: "ExtensionSession",
            operation: "send",
            message: "the reply was lost",
          })
          const run = (
            leaf: RegisteredTool,
            input: Record<string, Schema.Json>,
            id: string,
            reply: "kept" | "lost" = "kept",
          ) =>
            Effect.gen(function* () {
              const host = yield* runtimeHostContext(starter)
              const send: typeof host.Session.send = (params) => {
                if (reply === "kept") return host.Session.send(params)
                return Effect.andThen(host.Session.send(params), Effect.fail(lost))
              }
              return yield* Effect.result(
                runRegistered(leaf, input, {
                  ...host,
                  Session: { ...host.Session, send },
                  extensionId: SESSION_TOOLS_EXTENSION_ID,
                  toolCallId: ToolCallId.make(id),
                }),
              )
            }).pipe(
              Effect.provideContext(Context.merge(context, threads)),
              Effect.provideService(CurrentWorkspaceId, workspaceIdForCwd(cwd)),
            )
          const succeeded = (result: Result.Result<unknown, string>) =>
            Result.match(result, {
              onSuccess: (value) => Effect.succeed(value),
              onFailure: (message) => Effect.die(message),
            })
          const impl = decodeThread(
            yield* succeeded(
              yield* run(startTool, { name: "impl", agent: "worker" }, "start-impl"),
            ),
          )
          const failed = yield* run(
            sendTool,
            { thread: impl.thread, message: "ECHO kept through a lost reply" },
            "send-lost",
            "lost",
          )
          expect(Result.isFailure(failed) && failed.failure).toContain("the reply was lost")
          // The turn the lost send admitted runs to its end before the retry.
          yield* waitFor(
            client.message.list({ branchId: impl.branchId }),
            (messages) => messages.some((message) => message.role === "assistant"),
            5_000,
            "the thread's answer",
          )
          // No retry: the round the lost send claimed is still the thread's.
          const sql = Context.get(context, SqlClient.SqlClient)
          const kept = yield* sql<{
            readonly round: string
          }>`SELECT round FROM thread_rounds WHERE thread = ${impl.thread}`.pipe(Effect.orDie)
          expect(kept).toHaveLength(1)
          const round = kept[0]?.round ?? ""
          const ended = yield* waitFor(
            Effect.flatMap(run(roundTool, { round }, "read-lost"), succeeded),
            (read) => textOf(read).includes('"status":"ended"'),
            5_000,
            "the round's end",
          )
          expect(ended).toMatchObject({
            status: "ended",
            text: "kept through a lost reply",
            usage: { input: 100, output: 20 },
          })
          const worker = yield* client.session.getSnapshot(placeOf(impl))
          expect(worker.messages.filter((message) => message.role === "user")).toHaveLength(1)
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "the user's own config sets the running-thread cap",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, sessionId, branchId } = yield* roundHarness({
            userConfig: '{"threads":{"maxRunning":1}}',
          })
          const starter = { sessionId, branchId }
          const [first] = yield* call(client, starter, [
            ["thread.start", "start-cap-1", { agent: "worker", task: "HANG first" }],
          ])
          expect(first?.failed).toBe(false)
          const [second] = yield* call(client, starter, [
            ["thread.start", "start-cap-2", { agent: "worker", task: "HANG second" }],
          ])
          expect(second?.failed).toBe(true)
          expect(textOf(second?.result)).toContain("already runs 1 thread:")
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "deleting an older session of the starter's thread keeps the rounds it sent to a thread a newer session started",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, sessionId, branchId } = yield* roundHarness()
          const older = { sessionId, branchId }
          const newer: SessionKey = yield* client.session.create({
            parentSessionId: older.sessionId,
            parentBranchId: older.branchId,
            continueThread: true,
          })
          const impl = yield* startWorker(client, newer, "start-impl")
          const [sent] = yield* call(client, older, [
            ["thread.send", "send-old", { thread: impl.thread, message: "ECHO from the older" }],
          ])
          const round = decodeRound(sent?.result)
          yield* readRoundUntil(client, newer, round.round, "read-ended", (text) =>
            text.includes('"status":"ended"'),
          )
          yield* client.session.delete({ sessionId: older.sessionId })
          const [read] = yield* call(client, newer, [
            ["thread.round", "read-kept", { round: round.round }],
          ])
          expect(read?.failed).toBe(false)
          expect(read?.result).toMatchObject({ status: "ended", text: "from the older" })
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a round whose stopped turn holds out past the stop's wait keeps its bill when the turn ends",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<boolean>()
          const release = yield* Deferred.make<boolean>()
          const { client, sessionId, branchId } = yield* roundHarness({
            extensions: [holdProbe(entered, release)],
          })
          // Released before the server closes, so a failed check cannot hang its close.
          yield* Effect.addFinalizer(() => Deferred.succeed(release, true))
          const starter = { sessionId, branchId }
          const impl = yield* startWorker(client, starter, "start-impl")
          const [sent] = yield* call(client, starter, [
            ["thread.send", "send-hold", { thread: impl.thread, message: "HOLD" }],
          ])
          const round = decodeRound(sent?.result)
          yield* Deferred.await(entered)
          // The stop waits for the turn's end (10 s) and returns; the turn runs on.
          const [stopped] = yield* call(
            client,
            starter,
            [["thread.stop", "stop-hold", { thread: impl.thread }]],
            20_000,
          )
          expect(stopped?.result).toMatchObject({ round: round.round })
          const [open] = yield* call(client, starter, [
            ["thread.round", "read-held", { round: round.round }],
          ])
          expect(open?.result).toMatchObject({ status: "open" })
          yield* Deferred.succeed(release, true)
          const read = yield* readRoundUntil(
            client,
            starter,
            round.round,
            "read-released",
            (text) => text.includes('"status":"ended"'),
          )
          expect(read?.result).toMatchObject({
            status: "ended",
            stopped: true,
            usage: { input: 50, output: 10 },
          })
          expect(wakes((yield* client.session.getSnapshot(starter)).messages)).toEqual([])
        }).pipe(Effect.timeout("40 seconds")),
      ),
    45_000,
  )

  it.live(
    "a round thread.stop closes keeps the bill of the turn the stop interrupted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<boolean>()
          const { client, sessionId, branchId } = yield* roundHarness({
            extensions: [blockProbe(entered)],
          })
          const starter = { sessionId, branchId }
          const impl = yield* startWorker(client, starter, "start-impl")
          const [sent] = yield* call(client, starter, [
            ["thread.send", "send-block", { thread: impl.thread, message: "BLOCK" }],
          ])
          const round = decodeRound(sent?.result)
          yield* Deferred.await(entered)
          const [stopped] = yield* call(client, starter, [
            ["thread.stop", "stop-block", { thread: impl.thread }],
          ])
          expect(stopped?.result).toMatchObject({ round: round.round })
          // The turn's first step reported its usage before the tool blocked.
          const read = yield* readRoundUntil(client, starter, round.round, "read-billed", (text) =>
            text.includes('"usage"'),
          )
          expect(read?.result).toMatchObject({
            status: "ended",
            interrupted: true,
            stopped: true,
            usage: { input: 50, output: 10 },
          })
          expect(wakes((yield* client.session.getSnapshot(starter)).messages)).toEqual([])
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )
})

// ── rounds: the service ─────────────────────────────────────────────────────

/**
 * Another extension's sender, as a later machine is: it sends through the
 * `Threads` service with `notify: "none"` and hears the end on its own
 * subscription, so no message wakes the starter.
 */
const Heard = Schema.Struct({ round: Schema.String, notify: Schema.String, text: Schema.String })

const QuietRound = tool({
  id: "probe.quiet-round",
  description: "Send a thread a round nobody is woken for, and wait for its end.",
  params: Schema.Struct({ thread: SessionId, message: Schema.String }),
  output: Heard,
  execute: Effect.fn("QuietRound.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    // Another extension reads the service as threads read `Workspaces`.
    const threads = Option.getOrThrow(yield* Effect.serviceOption(Threads))
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const ends = yield* threads.subscribeRoundEnds
        const sent = yield* threads.send({
          ...params,
          key: ctx.toolCallId ?? "quiet",
          notify: "none",
        })
        let ended = yield* PubSub.take(ends)
        while (ended.round !== sent.round) ended = yield* PubSub.take(ends)
        const view = yield* threads.round(sent.round)
        let text = ""
        if (view.status === "ended") text = view.text
        return { round: sent.round, notify: ended.notify, text }
      }),
    )
  }),
})

/**
 * A retry of one send while its round runs, as the host replays a call a
 * lost process left: the same key twice. A model never repeats a call id.
 */
const SendTwice = tool({
  id: "probe.send-twice",
  description: "Send a thread one round under one key, twice.",
  params: Schema.Struct({ thread: SessionId, message: Schema.String }),
  output: Schema.Array(RoundHandle),
  execute: Effect.fn("SendTwice.execute")(function* (params) {
    const threads = Option.getOrThrow(yield* Effect.serviceOption(Threads))
    const send = threads.send({ ...params, key: "twice", notify: "starter" })
    return [yield* send, yield* send]
  }),
})

const ConcurrentSend = Schema.Struct({
  round: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})

/** Two sends of one round under one key at once, as two replays of one lost call can race. */
const SendConcurrently = tool({
  id: "probe.send-concurrently",
  description: "Send a thread one round under one key, twice at once.",
  params: Schema.Struct({ thread: SessionId, message: Schema.String }),
  output: Schema.Array(ConcurrentSend),
  execute: Effect.fn("SendConcurrently.execute")(function* (params) {
    const threads = Option.getOrThrow(yield* Effect.serviceOption(Threads))
    const send = threads.send({ ...params, key: "concurrent", notify: "none" }).pipe(
      Effect.match({
        onFailure: (error) => ({ error: error.message }),
        onSuccess: (sent) => ({ round: sent.round }),
      }),
    )
    return yield* Effect.all([send, send], { concurrency: 2 })
  }),
})

const decodeHeard = Schema.decodeUnknownSync(Heard)
const decodeRounds = Schema.decodeUnknownSync(Schema.Array(RoundHandle))
const decodeConcurrent = Schema.decodeUnknownSync(Schema.Array(ConcurrentSend))

const ServiceProbe = defineExtension({
  id: "threads-service-probe",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", QuietRound, SendTwice, SendConcurrently)
  }),
})

describe("the Threads service", () => {
  it.live(
    "a round sent with notify none publishes its end and wakes nobody",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, sessionId, branchId } = yield* roundHarness({
            extensions: [ServiceProbe],
          })
          const starter = { sessionId, branchId }
          const { impl } = yield* startTwo(client, starter)
          const [quiet] = yield* call(client, starter, [
            [
              "probe.quiet-round",
              "quiet-1",
              { thread: impl.thread, message: "ECHO heard by the probe" },
            ],
          ])
          const heard = decodeHeard(quiet?.result)
          expect(heard).toMatchObject({ notify: "none", text: "heard by the probe" })
          const [read] = yield* call(client, starter, [
            ["thread.round", "read-quiet", { round: heard.round }],
          ])
          expect(read?.result).toMatchObject({ status: "ended", text: "heard by the probe" })
          const snapshot = yield* client.session.getSnapshot(starter)
          expect(wakes(snapshot.messages)).toEqual([])
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  // A thread in another directory runs under that directory's profile.
  it.live(
    "a round end reaches a subscriber in the starter's directory when the thread runs in another",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const elsewhere = yield* makeTempDirectoryScoped("gent-thread-elsewhere-")
          const { client, sessionId, branchId } = yield* roundHarness({
            extensions: [ServiceProbe],
          })
          const starter = { sessionId, branchId }
          const impl = yield* startWorker(client, starter, "start-elsewhere", { cwd: elsewhere })
          const [quiet] = yield* call(client, starter, [
            [
              "probe.quiet-round",
              "quiet-elsewhere",
              { thread: impl.thread, message: "ECHO heard from another directory" },
            ],
          ])
          expect(decodeHeard(quiet?.result)).toMatchObject({
            notify: "none",
            text: "heard from another directory",
          })
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "two sends under one key at once are one send: both succeed, one turn runs, and its round ends with its bill",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, sessionId, branchId } = yield* roundHarness({
            extensions: [ServiceProbe],
          })
          const starter = { sessionId, branchId }
          const impl = yield* startWorker(client, starter, "start-impl")
          const [both] = yield* call(client, starter, [
            [
              "probe.send-concurrently",
              "concurrent-1",
              { thread: impl.thread, message: "ECHO sent twice at once" },
            ],
          ])
          expect(both?.failed).toBe(false)
          const results = decodeConcurrent(both?.result)
          expect(results.filter((result) => Predicate.isNotUndefined(result.error))).toEqual([])
          const round = results.find((result) => Predicate.isNotUndefined(result.round))?.round
          if (Predicate.isUndefined(round)) {
            return yield* Effect.die(`no round: ${textOf(both?.result)}`)
          }
          const read = yield* readRoundUntil(client, starter, round, "read-concurrent", (text) =>
            text.includes('"status":"ended"'),
          )
          expect(read?.result).toMatchObject({
            status: "ended",
            text: "sent twice at once",
            usage: { input: 100, output: 20 },
          })
          const worker = yield* client.session.getSnapshot(placeOf(impl))
          expect(worker.messages.filter((message) => message.role === "user")).toHaveLength(1)
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a retried send while its round runs returns that round, not a refusal, and sends no second turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hanging = yield* Deferred.make<boolean>()
          const { client, sessionId, branchId } = yield* roundHarness({
            hang: Effect.asVoid(Deferred.succeed(hanging, true)),
            extensions: [ServiceProbe],
          })
          const starter = { sessionId, branchId }
          const { impl } = yield* startTwo(client, starter)
          const [twice] = yield* call(client, starter, [
            ["probe.send-twice", "twice-1", { thread: impl.thread, message: "HANG" }],
          ])
          expect(twice?.failed).toBe(false)
          const [first, second] = decodeRounds(twice?.result)
          expect(second).toEqual(first)
          yield* Deferred.await(hanging)
          const worker = yield* client.session.getSnapshot(placeOf(impl))
          expect(worker.messages.filter((message) => message.role === "user")).toHaveLength(1)
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )
})

// ── rounds: a restart mid-round ─────────────────────────────────────────────

/** Processes over one file database and one home, each in its own scope. */
const restartableHome = Effect.gen(function* () {
  const home = yield* makeTempDirectoryScoped("threads-restart-")
  const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
  const storagePath = `${home}/gent.db`
  const layerFor = (providerLayer: Parameters<typeof createE2ELayer>[0]["providerLayer"]) =>
    createE2ELayer({ ...e2ePreset, providerLayer, storagePath, cwd, home })
  const sql = <A, E>(statement: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.scoped(
      statement.pipe(
        Effect.provide(BunSqlite.file(storagePath).pipe(Layer.provide(BunServices.layer))),
      ),
    )
  return { layerFor, sql }
})

/** A round saved and never sent, as a process that died between the two leaves it. */
const saveUnsentRound = (
  home: Effect.Success<typeof restartableHome>,
  input: {
    readonly round: string
    readonly starter: SessionKey
    readonly thread: typeof StartedResult.Type
    readonly message: string
    readonly startedAt: number
  },
) =>
  home.sql(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const content = threadRoundText({
        number: 1,
        starter: input.starter.sessionId,
        message: input.message,
        reply: Option.none(),
        notify: "starter",
        place: Option.none(),
      })
      yield* sql`
        INSERT INTO thread_rounds (
          round, thread, number, starter_session_id, starter_branch_id, starter_thread,
          session_id, branch_id, message_id, content, notify, started_at
        ) VALUES (
          ${input.round}, ${input.thread.thread}, 1, ${input.starter.sessionId},
          ${input.starter.branchId}, ${input.starter.sessionId}, ${input.thread.sessionId},
          ${input.thread.branchId}, ${`thread-round:${input.round}`}, ${content}, 'starter',
          ${input.startedAt}
        )
      `
    }),
  )

describe("a thread round running when the server stopped", () => {
  it.live(
    "resumes when the starter opens, wakes it once, and a later process loses no end and wakes it no more",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome

          // First process: the round's model call hangs, and the process stops.
          const stopped = yield* Effect.scoped(
            Effect.gen(function* () {
              const hanging = yield* Deferred.make<boolean>()
              const { client } = yield* createRpcClient(
                home.layerFor(workerModels(Effect.asVoid(Deferred.succeed(hanging, true)))),
              )
              const created = yield* client.session.create({})
              const starter = { sessionId: created.sessionId, branchId: created.branchId }
              const [started] = yield* call(client, starter, [
                [
                  "thread.start",
                  "start-impl",
                  { name: "impl", agent: "worker", model: "test/impl-model" },
                ],
              ])
              const impl = decodeThread(started?.result)
              const [sent] = yield* call(client, starter, [
                [
                  "thread.send",
                  "send-hang",
                  { thread: impl.thread, message: "HANG then answer", notify: "starter" },
                ],
              ])
              yield* Deferred.await(hanging)
              return { starter, impl, round: decodeRound(sent?.result) }
            }),
          )

          // Second process: the worker answers. Opening the starter resumes the round.
          const resumed = LanguageModelLayers.testStream((options) => {
            if (isWorkerRequest(options.prompt)) return Effect.succeed(billed("resumed answer"))
            return Effect.succeed(starterStep(options.prompt))
          })
          const userRound = yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(home.layerFor(resumed))
              const snapshot = yield* waitForWakes(client, stopped.starter, 1)
              expect(wakeTexts(snapshot.messages)[0]).toContain(stopped.round.round)
              const [read] = yield* call(client, stopped.starter, [
                ["thread.round", "read-resumed", { round: stopped.round.round }],
              ])
              expect(read?.result).toMatchObject({ status: "ended", text: "resumed answer" })
              // A round the user reads: its end wakes nobody.
              const [sent] = yield* call(client, stopped.starter, [
                ["thread.send", "send-user", { thread: stopped.impl.thread, message: "ECHO x" }],
              ])
              const round = decodeRound(sent?.result)
              yield* readRoundUntil(client, stopped.starter, round.round, "read-user", (text) =>
                text.includes('"status":"ended"'),
              )
              return round
            }),
          )

          const rowOf = (round: string) =>
            home.sql(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient
                return yield* sql<{
                  readonly text: string
                  readonly delivered: number
                }>`SELECT COALESCE(text, '') AS text, delivered_at IS NOT NULL AS delivered FROM thread_rounds WHERE round = ${round}`
              }),
            )
          // The two windows a process can die in once a turn ended. The
          // `starter` round's end was saved and its wake sent, and the process
          // died before marking it delivered. The `user` round's turn ended,
          // and the process died before its end was saved; nothing is sent
          // for it, so nothing else was.
          yield* home.sql(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`UPDATE thread_rounds SET delivered_at = NULL WHERE round = ${stopped.round.round}`
              yield* sql`UPDATE thread_rounds SET ended_at = NULL, text = NULL, usage_json = NULL, delivered_at = NULL WHERE round = ${userRound.round}`
            }),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(home.layerFor(resumed))
              yield* client.session.getSnapshot(stopped.starter)
              const rows = yield* waitFor(
                rowOf(userRound.round),
                (found) => found[0]?.delivered === 1,
                8_000,
                "the reconcile recorded the user's round again",
              )
              expect(rows[0]?.text).toBe("resumed answer")
              const [read] = yield* call(client, stopped.starter, [
                ["thread.round", "read-again", { round: userRound.round }],
              ])
              expect(read?.result).toMatchObject({
                status: "ended",
                text: "resumed answer",
                usage: { input: 100, output: 20 },
              })
              const woken = yield* rowOf(stopped.round.round)
              expect(woken[0]?.delivered).toBe(1)
              const snapshot = yield* waitFor(
                client.session.getSnapshot(stopped.starter),
                (current) => current.runtime._tag === "Idle",
                8_000,
                "the starter is idle",
              )
              expect(wakes(snapshot.messages)).toHaveLength(1)
            }),
          )
        }).pipe(Effect.timeout("40 seconds")),
      ),
    45_000,
  )

  it.live(
    "a round saved but never sent is sent when the starter opens, though the thread's loop opened first",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(home.layerFor(workerModels()))
              const starter: SessionKey = yield* client.session.create({})
              const impl = yield* startWorker(client, starter, "start-impl")
              return { starter, impl }
            }),
          )
          // The process died between saving a round and sending its turn.
          const round = "round-never-sent"
          yield* home.sql(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const content = threadRoundText({
                number: 1,
                starter: first.starter.sessionId,
                message: "ECHO sent at last",
                reply: Option.none(),
                notify: "starter",
                place: Option.none(),
              })
              yield* sql`
                INSERT INTO thread_rounds (
                  round, thread, number, starter_session_id, starter_branch_id, starter_thread,
                  session_id, branch_id, message_id, content, notify, started_at
                ) VALUES (
                  ${round}, ${first.impl.thread}, 1, ${first.starter.sessionId},
                  ${first.starter.branchId}, ${first.starter.sessionId}, ${first.impl.sessionId},
                  ${first.impl.branchId}, ${`thread-round:${round}`}, ${content}, 'starter', 0
                )
              `
            }),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(home.layerFor(workerModels()))
              // The thread's loop opens first: idle, with nothing to resume.
              yield* client.session.getSnapshot(placeOf(first.impl))
              const woke = yield* waitForWakes(client, first.starter, 1)
              expect(wakeTexts(woke.messages)[0]).toContain(round)
              const [read] = yield* call(client, first.starter, [
                ["thread.round", "read-sent", { round }],
              ])
              expect(read?.result).toMatchObject({ status: "ended", text: "sent at last" })
            }),
          )
        }).pipe(Effect.timeout("40 seconds")),
      ),
    45_000,
  )

  it.live(
    "at the starter's open, a round a full queue refuses is dropped, and the next round is still sent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const hanging = yield* Deferred.make<boolean>()
              const { client } = yield* createRpcClient(
                home.layerFor(workerModels(Effect.asVoid(Deferred.succeed(hanging, true)))),
              )
              const starter: SessionKey = yield* client.session.create({})
              const full = yield* startWorker(client, starter, "start-full")
              const free = yield* startWorker(client, starter, "start-free")
              // The user keeps one thread busy and fills its follow-up queue.
              yield* client.message.send({ ...placeOf(full), content: "HANG" })
              yield* Deferred.await(hanging)
              for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
                yield* client.message.send({ ...placeOf(full), content: `ECHO queued ${index}` })
              }
              return { starter, full, free }
            }),
          )
          // The process died between saving two rounds and sending their turns.
          yield* saveUnsentRound(home, {
            round: "round-refused",
            starter: first.starter,
            thread: first.full,
            message: "ECHO refused",
            startedAt: 0,
          })
          yield* saveUnsentRound(home, {
            round: "round-sent",
            starter: first.starter,
            thread: first.free,
            message: "ECHO sent after the refusal",
            startedAt: 1,
          })
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(home.layerFor(workerModels()))
              const woke = yield* waitForWakes(client, first.starter, 1)
              expect(wakeTexts(woke.messages)[0]).toContain("round-sent")
              const [read] = yield* call(client, first.starter, [
                ["thread.round", "read-sent", { round: "round-sent" }],
              ])
              expect(read?.result).toMatchObject({
                status: "ended",
                text: "sent after the refusal",
              })
            }),
          )
          const refused = yield* home.sql(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql<{
                readonly round: string
              }>`SELECT round FROM thread_rounds WHERE round = 'round-refused'`
            }),
          )
          expect(refused).toEqual([])
        }).pipe(Effect.timeout("40 seconds")),
      ),
    45_000,
  )

  it.live(
    "an end whose saved wake target was deleted wakes the starter's current session",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(home.layerFor(workerModels()))
              const starter: SessionKey = yield* client.session.create({})
              const impl = yield* startWorker(client, starter, "start-impl")
              // The end was to wake a handoff of the starter, deleted since.
              const gone: SessionKey = yield* client.session.create({
                parentSessionId: starter.sessionId,
                parentBranchId: starter.branchId,
                continueThread: true,
              })
              yield* client.session.delete({ sessionId: gone.sessionId })
              return { starter, impl, gone }
            }),
          )
          const round = "round-target-gone"
          yield* saveUnsentRound(home, {
            round,
            starter: first.starter,
            thread: first.impl,
            message: "ECHO answered",
            startedAt: 0,
          })
          // The process died after saving the target, before the wake landed.
          yield* home.sql(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`
                UPDATE thread_rounds
                SET ended_at = 1, text = 'answered', wake_session_id = ${first.gone.sessionId},
                  wake_branch_id = ${first.gone.branchId}
                WHERE round = ${round}
              `
            }),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(home.layerFor(workerModels()))
              const woke = yield* waitForWakes(client, first.starter, 1)
              expect(wakeTexts(woke.messages)[0]).toContain(round)
            }),
          )
          const target = yield* home.sql(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql<{
                readonly wake_session_id: string
              }>`SELECT wake_session_id FROM thread_rounds WHERE round = ${round}`
            }),
          )
          expect(target).toEqual([{ wake_session_id: first.starter.sessionId }])
        }).pipe(Effect.timeout("40 seconds")),
      ),
    45_000,
  )

  it.live(
    "a round stopped while its turn ran when the process died closes when only the starter opens",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const hanging = yield* Deferred.make<boolean>()
              const { client } = yield* createRpcClient(
                home.layerFor(workerModels(Effect.asVoid(Deferred.succeed(hanging, true)))),
              )
              const starter: SessionKey = yield* client.session.create({})
              const impl = yield* startWorker(client, starter, "start-impl")
              const [sent] = yield* call(client, starter, [
                [
                  "thread.send",
                  "send-hang",
                  { thread: impl.thread, message: "HANG until stopped", notify: "starter" },
                ],
              ])
              yield* Deferred.await(hanging)
              return { starter, round: decodeRound(sent?.result) }
            }),
          )
          // The stop marked the round, and the process died before its turn ended.
          yield* home.sql(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`UPDATE thread_rounds SET stopped_at = 1 WHERE round = ${first.round.round}`
            }),
          )
          const ended = (round: string) =>
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql<{
                readonly ended: number
                readonly interrupted: number
              }>`SELECT ended_at IS NOT NULL AS ended, interrupted FROM thread_rounds WHERE round = ${round}`
            })
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(home.layerFor(workerModels()))
              // Only the starter opens; the thread's own session is never read.
              yield* client.session.getSnapshot(first.starter)
              const rows = yield* waitFor(
                home.sql(ended(first.round.round)),
                (found) => found[0]?.ended === 1,
                8_000,
                "the stopped round closed",
              )
              expect(rows).toEqual([{ ended: 1, interrupted: 1 }])
              const starter = yield* waitFor(
                client.session.getSnapshot(first.starter),
                (current) => current.runtime._tag === "Idle",
                8_000,
                "the starter is idle",
              )
              expect(wakes(starter.messages)).toEqual([])
            }),
          )
        }).pipe(Effect.timeout("40 seconds")),
      ),
    45_000,
  )

  it.live(
    "a wake sent before the process died is not sent again to the starter's handoff",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(home.layerFor(workerModels()))
              const starter: SessionKey = yield* client.session.create({})
              const impl = yield* startWorker(client, starter, "start-impl")
              const [sent] = yield* call(client, starter, [
                [
                  "thread.send",
                  "send-once",
                  { thread: impl.thread, message: "ECHO woke once", notify: "starter" },
                ],
              ])
              yield* waitForWakes(client, starter, 1)
              return { starter, round: decodeRound(sent?.result) }
            }),
          )
          // The process died after the wake, before the end was marked delivered.
          const undelivered = (round: string) =>
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql<{
                readonly delivered: number
              }>`SELECT delivered_at IS NOT NULL AS delivered FROM thread_rounds WHERE round = ${round}`
            })
          yield* home.sql(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`UPDATE thread_rounds SET delivered_at = NULL WHERE round = ${first.round.round}`
            }),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(home.layerFor(workerModels()))
              // The starter hands off; the handoff's loop open delivers the end again.
              const handoff: SessionKey = yield* client.session.create({
                parentSessionId: first.starter.sessionId,
                parentBranchId: first.starter.branchId,
                continueThread: true,
              })
              yield* client.session.getSnapshot(handoff)
              yield* waitFor(
                home.sql(undelivered(first.round.round)),
                (rows) => rows[0]?.delivered === 1,
                8_000,
                "the handoff's reconcile delivered the round",
              )
              const moved = yield* waitFor(
                client.session.getSnapshot(handoff),
                (current) => current.runtime._tag === "Idle",
                8_000,
                "the handoff is idle",
              )
              expect(wakes(moved.messages)).toEqual([])
              const starter = yield* client.session.getSnapshot(first.starter)
              expect(wakes(starter.messages)).toHaveLength(1)
            }),
          )
        }).pipe(Effect.timeout("40 seconds")),
      ),
    45_000,
  )
})
