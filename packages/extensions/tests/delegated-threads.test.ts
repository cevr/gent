import { describe, expect, it, test } from "effect-bun-test"
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Record,
  Ref,
  Schema,
  Stream,
  Struct,
} from "effect"
import { SqlClient } from "effect/sql"
import { BunServices } from "@effect/platform-bun"
import { BunSqlite } from "@gent/core/host-bun"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  LoadedArtifactIdentity,
  type ModelPricing,
  RequestId,
  runProcess,
  tool,
} from "@gent/core/extensions/api"
import {
  ApprovalService,
  ConfigService,
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  finishPart,
  isHostContextUpdate,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  multiToolCallStep,
  runToolWithCtx,
  systemTextOf,
  TEST_MODEL_ID,
  testToolContext,
  textDeltaPart,
  textStep,
  toolCallPart,
  turnRequestText,
  UserConfig,
  waitFor,
} from "@gent/core/test-utils"
import {
  BranchId,
  DEFAULT_AGENT_NAME,
  ModelId,
  SessionId,
  SteerCommand,
  ToolCallId,
} from "@gent/core/protocol"
import {
  DELEGATE_AGENT_NAME,
  THREAD_ROUND_END_TYPE,
  THREAD_ROUND_TYPE,
  threadRoundText,
  ThreadStartTool,
} from "../src/threads.js"
import {
  makeWorkspacesExtension,
  WORKSPACES_EXTENSION_ID,
  WorkspacePlace,
} from "../src/workspaces.js"
import { e2ePreset, shippedPreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"
import * as AiError from "effect/ai/AiError"
import type * as Prompt from "effect/ai/Prompt"
import * as AiTool from "effect/ai/Tool"

// ── the delegated-thread harness ────────────────────────────────────────────

/**
 * Every test here runs a real thread through the public facade: a starter
 * calls `thread.start` with agent "delegate" and notify "starter", ends its
 * turn, and the round's end wakes it with the answer. The round table is read
 * back from the database file, so each assertion sees what a restarted
 * process would.
 */

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

/** Runs one statement on its own connection to the database file at `storagePath`. */
const sqlAt =
  (storagePath: string) =>
  <A, E>(statement: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.scoped(
      statement.pipe(
        Effect.provide(BunSqlite.file(storagePath).pipe(Layer.provide(BunServices.layer))),
      ),
    )

const harnessWithHome = (
  providerLayer: Parameters<typeof createRpcHarness>[0]["providerLayer"],
  options: {
    readonly config?: UserConfig
    readonly dialogs?: boolean
    readonly modelPricing?: ModelPricing
    /** Fixture extensions loaded beside the shipped ones. */
    readonly fixtures?: ReadonlyArray<(typeof e2ePreset.extensionInputs)[number]>
  } = {},
) =>
  Effect.gen(function* () {
    const home = yield* makeTempDirectoryScoped("delegated-threads-")
    const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
    const storagePath = `${home}/gent.db`
    const harness = yield* createRpcHarness({
      ...e2ePreset,
      extensionInputs: [...e2ePreset.extensionInputs, ...(options.fixtures ?? [])],
      providerLayer,
      cwd,
      home,
      storagePath,
      ...Record.filter(
        {
          modelPricing: options.modelPricing,
          // A test's config names the user's model unless it names its own.
          configServiceLayer: Option.map(Option.fromUndefinedOr(options.config), (config) =>
            ConfigService.Test(new UserConfig({ model: TEST_MODEL_ID, ...config })),
          ).pipe(Option.getOrUndefined),
          // `dialogs` presents approvals to the client instead of auto-approving them.
          approvalLayer: Option.getOrUndefined(
            Option.liftPredicate(ApprovalService.Live, () => options.dialogs === true),
          ),
        },
        Predicate.isNotUndefined,
      ),
    })
    return { ...harness, cwd, home, sql: sqlAt(storagePath) }
  })

type Harness = Effect.Success<ReturnType<typeof harnessWithHome>>
type Sql = Harness["sql"]

/**
 * One `thread_rounds` row, as a test reads it: its identity, its flags, and
 * whether each of its moments (a stop, an end, a delivery, a stop notice)
 * happened, 1 or 0.
 */
interface RoundRecord {
  readonly round: string
  readonly thread: string
  readonly starter_session_id: string
  readonly number: number
  readonly session_id: string
  readonly branch_id: string
  readonly notify: string
  readonly interrupted: number
  readonly stream_failed: number
  readonly unanswered: number
  readonly stopped: number
  readonly ended: number
  readonly delivered: number
  readonly stop_noticed: number
}

/** The round table once the threads' migrations ran: the stop-notice index is the last one. */
const roundTableReady = (sql: Sql) =>
  waitFor(
    sql(
      Effect.flatMap(
        SqlClient.SqlClient,
        (client) =>
          client<{
            readonly name: string
          }>`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'thread_rounds_stop_notices'`,
      ),
    ).pipe(Effect.orElseSucceed(() => [])),
    (rows) => rows.length === 1,
    5_000,
    "the round table exists",
  )

/** Every round the table holds, the oldest first. */
const roundsOf = (sql: Sql) =>
  sql(
    Effect.flatMap(
      SqlClient.SqlClient,
      (client) =>
        client<RoundRecord>`SELECT round, thread, starter_session_id, number, session_id, branch_id, notify, interrupted, stream_failed, unanswered, stopped_at IS NOT NULL AS stopped, ended_at IS NOT NULL AS ended, delivered_at IS NOT NULL AS delivered, stop_notice_at IS NOT NULL AS stop_noticed FROM thread_rounds ORDER BY started_at, round`,
    ),
  ).pipe(Effect.orDie)

const decodeRetries = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ retry_at: Schema.NullOr(Schema.Finite) })),
)

/** Each round's usage-limit reset, oldest first; null when its turn named none. */
const retriesOf = (sql: Sql) =>
  sql(
    Effect.flatMap(
      SqlClient.SqlClient,
      (client) => client`SELECT retry_at FROM thread_rounds ORDER BY started_at, round`,
    ),
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => decodeRetries(rows).map((row) => row.retry_at)),
  )

/** Runs raw statements (a trigger, a rename) on the database, as an outside writer would. */
const execute = (sql: Sql, statement: string) =>
  sql(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement))).pipe(Effect.orDie)

/**
 * A round row as a crash, an older process or a lost hook leaves it. The
 * columns named are written; the rest keep the table's defaults.
 */
interface PlantedRound {
  readonly round: string
  readonly thread: string
  readonly starter: BranchRef
  readonly session: BranchRef
  readonly content: string
  readonly notify?: "user" | "starter" | "none"
  readonly startedAt: number
  readonly endedAt?: number
  readonly stoppedAt?: number
  readonly text?: string
  readonly error?: string
  readonly interrupted?: boolean
  readonly streamFailed?: boolean
  readonly unanswered?: boolean
  readonly wake?: BranchRef
  readonly deliveredAt?: number
  readonly stopNoticeAt?: number
}

const flagOf = (raised = false) => Number(raised)

const plantRound = (sql: Sql, row: PlantedRound) =>
  roundTableReady(sql).pipe(
    Effect.andThen(
      sql(
        Effect.flatMap(SqlClient.SqlClient, (client) => {
          const record = Record.filter(
            {
              round: row.round,
              thread: row.thread,
              number: 1,
              starter_session_id: row.starter.sessionId,
              starter_branch_id: row.starter.branchId,
              starter_thread: row.starter.sessionId,
              session_id: row.session.sessionId,
              branch_id: row.session.branchId,
              message_id: `thread-round:${row.round}`,
              content: row.content,
              notify: row.notify ?? "starter",
              started_at: row.startedAt,
              ended_at: row.endedAt,
              stopped_at: row.stoppedAt,
              text: row.text,
              error: row.error,
              interrupted: flagOf(row.interrupted),
              stream_failed: flagOf(row.streamFailed),
              unanswered: flagOf(row.unanswered),
              wake_session_id: row.wake?.sessionId,
              wake_branch_id: row.wake?.branchId,
              delivered_at: row.deliveredAt,
              stop_notice_at: row.stopNoticeAt,
            },
            Predicate.isNotUndefined,
          )
          return client`INSERT INTO thread_rounds ${client.insert(record)}`
        }),
      ),
    ),
    Effect.orDie,
  )

/**
 * A `confirm` tool that asks the user before it acts, as any extension tool
 * may. Its result is `approved`, or `declined: ` and the decline's notes.
 */
const ConfirmTool = tool({
  id: "confirm",
  description: "Ask the user before acting",
  params: Schema.Struct({ action: Schema.String }),
  output: Schema.String,
  execute: (params) =>
    Effect.gen(function* () {
      const answer = yield* (yield* ExtensionContext).Interaction.approve({
        text: `Allow ${params.action}?`,
      })
      if (answer.approved) return "approved"
      return `declined: ${answer.notes ?? ""}`
    }),
})

const confirmFixture = {
  ...defineExtension({
    id: "confirm-fixture",
    setup: Effect.gen(function* () {
      yield* (yield* ExtensionHost).register("tool", ConfirmTool)
    }),
  }),
  artifactIdentity: LoadedArtifactIdentity.make("confirm-fixture-source"),
}

/** The one thread session under the starter, once it exists. */
const childOf = (harness: Harness) =>
  waitFor(
    harness.client.session.list(),
    (sessions) => sessions.some((session) => session.parentSessionId === harness.sessionId),
    5_000,
    "the thread session exists",
  ).pipe(
    Effect.flatMap((sessions) => {
      const child = sessions.find((session) => session.parentSessionId === harness.sessionId)
      if (Predicate.isUndefined(child) || Predicate.isUndefined(child.activeBranchId)) {
        return Effect.die("no thread session with an active branch")
      }
      return Effect.succeed({ sessionId: child.id, branchId: child.activeBranchId })
    }),
  )

/** The first result of one tool on the starter's branch. */
const toolResult = (harness: Harness, toolName: string) =>
  harness.client.session.events({ sessionId: harness.sessionId, branchId: harness.branchId }).pipe(
    Stream.filter(isToolResultFor(toolName)),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((events) => Array.from(events)[0]?.event),
    Effect.forkScoped,
  )

const reply = (text: string) =>
  Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })])

const toolStep = (name: string, input: Record<string, unknown>, id: string) =>
  Stream.fromIterable([
    toolCallPart(name, input, { toolCallId: ToolCallId.make(id) }),
    finishPart({ finishReason: "tool-calls" }),
  ])

/** A stream that opens, says so, and never ends: a turn that is still running. */
const stalledStream = (text: string, opened: Deferred.Deferred<void>) =>
  Stream.make(textDeltaPart(text)).pipe(
    Stream.concat(Stream.fromEffect(Deferred.succeed(opened, void 0)).pipe(Stream.drain)),
    Stream.concat(Stream.never),
  )

/**
 * Every text part of the prompt's user and assistant messages, in order. A
 * turn notice is no part of the conversation, as a system message or as the
 * user message that carries one.
 */
const promptTexts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) => {
    if (message.role === "system" || isHostContextUpdate(message)) return []
    return message.content.flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
  })

/** The turn notices the runtime places after the conversation. */
const noticeText = (prompt: Prompt.Prompt): string => turnRequestText(prompt).notices

const promptToolCallIds = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) => {
    if (message.role !== "assistant") return []
    return message.content.flatMap((part) => {
      if (part.type !== "tool-call") return []
      return [part.id]
    })
  })

const messageTexts = (messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Prompt.Part> }>) =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    }),
  )

const resultsOf = (
  toolName: string,
  messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Prompt.Part> }>,
) =>
  messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool-result" && part.name === toolName)

/** The round-end messages on a branch: each one a round's answer to its starter. */
const roundEndMessages = <M extends { readonly metadata?: { readonly customType?: string } }>(
  messages: ReadonlyArray<M>,
) => messages.filter((message) => message.metadata?.customType === THREAD_ROUND_END_TYPE)

/** Every round end says this; a starter's model tells a round's end from other text by it. */
const ROUND_END_MARK = "A round's end is a turn receipt, not task success"

const isRoundEndText = (text: string) => text.includes(ROUND_END_MARK)

const sendPrompt = (harness: Harness, content: string) =>
  harness.client.message.send({
    sessionId: harness.sessionId,
    branchId: harness.branchId,
    content,
  })

const childTask = "CHILD-TASK: reply with the single word pong"

/** A delegated round: the delegate agent on one task, whose end wakes its starter. */
const delegated = (task: string, extra: Record<string, unknown> = {}) => ({
  task,
  agent: "delegate",
  notify: "starter",
  ...extra,
})

/** How `LanguageModelLayers.testStream` answers one model request, and the answer. */
type ModelStep = Parameters<typeof LanguageModelLayers.testStream>[0]
type ModelReply = ReturnType<ModelStep>

/**
 * A starter that starts one delegate thread and ends its turn. The thread
 * reads the task at the end of its round's message, its first user text; the
 * starter carries it only inside the start call's params, so the two are told
 * apart by their first text. The round's end wakes the starter once more.
 * `child` answers each thread request; `onParent` sees each starter request
 * before it is answered.
 */
const startThenEndWith = (
  child: ModelStep,
  onParent: (options: Parameters<ModelStep>[0]) => void = () => {},
) => {
  let parentCalls = 0
  return LanguageModelLayers.testStream((options) => {
    if (promptTexts(options.prompt)[0]?.endsWith(childTask) === true) return child(options)
    onParent(options)
    parentCalls += 1
    if (parentCalls === 1) {
      return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
    }
    if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
    return Effect.succeed(reply("read it"))
  })
}

/** The same starter, with a thread that answers `childReply` once `childGate` opens. */
const startThenEnd = (childReply: string, childGate: Effect.Effect<void> = Effect.void) =>
  startThenEndWith(() => childGate.pipe(Effect.as(reply(childReply))))

/** A thread's model stream that fails on sign-in with `reason`. */
const childSignInFails = (reason: string): ModelReply =>
  Effect.fail(
    AiError.make({
      module: "ChildProvider",
      method: "streamText",
      reason: new AiError.AuthenticationError({ kind: "Unknown", description: reason }),
    }),
  )

/** The starter's branch once the round's end has landed and been read. */
const afterRoundEnd = (harness: Harness) =>
  waitFor(
    harness.client.session.getSnapshot({
      sessionId: harness.sessionId,
      branchId: harness.branchId,
    }),
    (current) => roundEndMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
    8_000,
    "the round's end woke the starter and the starter read it",
  )

/** The starter's branch once it answered `text` and went idle. */
const idleAfter = (harness: Harness, text: string) =>
  waitFor(
    harness.client.session.getSnapshot({
      sessionId: harness.sessionId,
      branchId: harness.branchId,
    }),
    (current) => current.runtime._tag === "Idle" && messageTexts(current.messages).includes(text),
    5_000,
    `the starter answered ${text}`,
  )

type BranchRef = { readonly sessionId: SessionId; readonly branchId: BranchId }

/** The model each of the branch's model streams ran on, in order. */
const modelsOf = (harness: Harness, target: BranchRef) =>
  harness.client.session.events(target).pipe(
    Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
    Stream.flatMap((envelope) => {
      if (envelope.event._tag !== "StreamEnded") return Stream.empty
      return Stream.make(envelope.event.model)
    }),
    Stream.runCollect,
    Effect.map((models) => Array.from(models)),
  )

/** The branch's turn receipts, from its durable history. */
const turnReceipts = (harness: Harness, target: BranchRef) =>
  harness.client.session.events(target).pipe(
    Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
    Stream.flatMap((envelope) => {
      if (envelope.event._tag !== "TurnCompleted") return Stream.empty
      return Stream.make(envelope.event)
    }),
    Stream.runCollect,
    Effect.map((receipts) => Array.from(receipts)),
  )

const StartedThread = Schema.Struct({
  thread: SessionId,
  sessionId: SessionId,
  branchId: BranchId,
  round: Schema.Struct({ round: Schema.String, number: Schema.Finite }),
})

/** A thread session made the way a start makes one, for a row a test plants. */
const threadSessionOf = (harness: Harness, admission?: { readonly modelId?: ModelId }) =>
  harness.client.session.create({
    parentSessionId: harness.sessionId,
    parentBranchId: harness.branchId,
    admission: { agent: DELEGATE_AGENT_NAME },
    ...Record.filter({ modelId: admission?.modelId }, Predicate.isNotUndefined),
  })

/** A planted round of `childTask`, open and never sent, on `thread`. */
const unsentRound = (harness: Harness, thread: BranchRef, round: string): PlantedRound => ({
  round,
  thread: thread.sessionId,
  starter: { sessionId: harness.sessionId, branchId: harness.branchId },
  session: thread,
  content: threadRoundText({
    number: 1,
    starter: harness.sessionId,
    message: childTask,
    reply: Option.none(),
    notify: "starter",
    place: Option.none(),
  }),
  startedAt: 1_000,
})

// ── a delegate thread's round end ───────────────────────────────────────────

/**
 * A thread never blocks its starter. The start returns at admission, the
 * starter ends its turn, and the round's end comes back as one message on the
 * starter's branch that wakes it. These tests read what that message and the
 * round table carry.
 */

describe("a delegate thread's round end", () => {
  it.live(
    "a delegate thread runs the delegate agent's configured model, and its round's end wakes the starter with the answer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* harnessWithHome(startThenEnd("pong"), {
            config: new UserConfig({
              agents: {
                [DEFAULT_AGENT_NAME]: { model: ModelId.make("test/parent-model") },
                [DELEGATE_AGENT_NAME]: { model: ModelId.make("test/child-model") },
              },
            }),
          })
          const { sessionId, branchId } = harness
          const started = yield* toolResult(harness, "thread.start")
          yield* sendPrompt(harness, "delegate this task")
          const running = yield* Fiber.join(started)
          expect(running?._tag).toBe("ToolCallSucceeded")
          if (running?._tag !== "ToolCallSucceeded") return
          const handle = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StartedThread))(
            running.output,
          )
          const snapshot = yield* afterRoundEnd(harness)
          // The round's end woke the starter for a fresh turn, and carries the answer.
          expect(messageTexts(snapshot.messages)).toContain("read it")
          const [end] = roundEndMessages(snapshot.messages)
          expect(messageTexts([end!])[0]).toContain("pong")

          const child = yield* childOf(harness)
          expect(handle).toMatchObject({ thread: child.sessionId, ...child, round: { number: 1 } })
          // The thread runs the delegate agent's configured model, not the starter's.
          expect(yield* modelsOf(harness, child)).toEqual([ModelId.make("test/child-model")])
          expect(yield* modelsOf(harness, { sessionId, branchId })).toContain(
            ModelId.make("test/parent-model"),
          )
          const [row] = yield* waitFor(
            roundsOf(harness.sql),
            (rows) => rows[0]?.delivered === 1,
            3_000,
            "the round is marked delivered",
          )
          // A clean turn raised no flag; the shape is the same whichever writer recorded it.
          expect(row).toMatchObject({
            round: handle.round.round,
            thread: child.sessionId,
            session_id: child.sessionId,
            notify: "starter",
            interrupted: 0,
            stream_failed: 0,
            unanswered: 0,
            stopped: 0,
            ended: 1,
          })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  // A starter that reads only "model stream failed" cannot tell a sign-in that
  // will never work from a flake, and starts the same thread again and again.
  it.live(
    "a delegate thread whose model stream failed hands its starter the error that ended it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const reason = "CHILD-AUTH-PROBE: the keychain is locked"
          const parentPrompts: Array<ReadonlyArray<string>> = []
          const providerLayer = startThenEndWith(
            () => childSignInFails(reason),
            (options) => parentPrompts.push(promptTexts(options.prompt)),
          )
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterRoundEnd(harness)
          const [end] = roundEndMessages(snapshot.messages)
          const text = messageTexts(roundEndMessages(snapshot.messages)).join("")
          expect(text).toContain("ended (model stream failed)")
          expect(text).toContain(reason)
          // The error sits in the header, before the round's text.
          const [header = ""] = text.split("\n\n")
          expect(header).toMatch(/\nError: .*CHILD-AUTH-PROBE: the keychain is locked/)
          expect(end?.metadata?.details).toMatchObject({
            streamFailed: true,
            error: expect.stringContaining(reason),
          })
          // The starter's model reads the reason in the turn the round's end woke.
          expect(parentPrompts.at(-1)?.some((line) => line.includes(reason))).toBe(true)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a long error reaches the starter as one line of at most 1,000 characters",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const reason = `CHILD-LONG-ERROR ${"word ".repeat(600)}`
          const harness = yield* harnessWithHome(startThenEndWith(() => childSignInFails(reason)))
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterRoundEnd(harness)
          const [end] = roundEndMessages(snapshot.messages)
          const decoded = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))(
            end?.metadata?.details,
          )
          const error = Option.getOrThrow(Option.map(decoded, (details) => details.error))
          expect(error).toContain("CHILD-LONG-ERROR")
          expect(error.endsWith("…")).toBe(true)
          expect([...error].length).toBe(1_000)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a delegate thread's later turns, from its own wake and from the starter's session.send, run as the delegate agent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childModel = ModelId.make("test/child-model")
          const childTools: Array<ReadonlyArray<string>> = []
          let childId = ""
          let parentCalls = 0
          const lastText = (prompt: Prompt.Prompt) => promptTexts(prompt).at(-1) ?? ""
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              childTools.push(options.tools.map((entry) => entry.name))
              if (!promptToolCallIds(options.prompt).includes("child-wake")) {
                return Effect.succeed(
                  toolStep("wake", { afterSeconds: 0.2, note: "CHILD-WAKE-NOTE" }, "child-wake"),
                )
              }
              if (lastText(options.prompt).includes("PARENT-NOTE")) {
                return Effect.succeed(reply("noted"))
              }
              if (lastText(options.prompt).includes("CHILD-WAKE-NOTE")) {
                return Effect.succeed(reply("woke"))
              }
              return Effect.succeed(reply("pong"))
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
            }
            const asked = lastText(options.prompt) === "SEND-TO-CHILD"
            if (asked && !promptToolCallIds(options.prompt).includes("parent-send")) {
              return Effect.succeed(
                toolStep("session.send", { to: childId, message: "PARENT-NOTE" }, "parent-send"),
              )
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer, {
            config: new UserConfig({
              agents: { [DELEGATE_AGENT_NAME]: { model: childModel } },
            }),
          })
          const { client } = harness
          yield* sendPrompt(harness, "delegate this task")
          yield* afterRoundEnd(harness)
          const child = yield* childOf(harness)
          childId = child.sessionId
          const childAnswered = (text: string) =>
            waitFor(
              client.session.getSnapshot(child),
              (current) =>
                current.runtime._tag === "Idle" &&
                current.messages.some(
                  (message) =>
                    message.role === "assistant" && messageTexts([message]).includes(text),
                ),
              8_000,
              `the thread answered ${text}`,
            )
          // The thread's own alarm wakes it for a turn no one sent it.
          yield* childAnswered("woke")
          // The starter's message wakes the idle thread for another.
          yield* sendPrompt(harness, "SEND-TO-CHILD")
          const snapshot = yield* childAnswered("noted")

          const models = yield* modelsOf(harness, child)
          // Four steps over three turns: the round (wake call, then pong), the wake, the send.
          expect(models).toEqual([childModel, childModel, childModel, childModel])
          expect(childTools).toHaveLength(4)
          for (const tools of childTools) expect(tools).not.toContain("thread__start")
          expect(snapshot.agent).toBe(DELEGATE_AGENT_NAME)
          expect(snapshot.resolvedModelId).toBe(childModel)
        }).pipe(Effect.timeout("20 seconds")),
      ),
    25_000,
  )

  it.live(
    "the round-end message carries the row it draws: name, outcome, usage, calls and duration",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              if (!promptToolCallIds(options.prompt).includes("child-read")) {
                return Effect.succeed(
                  Stream.fromIterable([
                    toolCallPart(
                      "read",
                      { path: "/tmp/no-such-file-for-a-child" },
                      { toolCallId: ToolCallId.make("child-read") },
                    ),
                    finishPart({
                      finishReason: "tool-calls",
                      usage: { inputTokens: 100, outputTokens: 10 },
                    }),
                  ]),
                )
              }
              return Effect.succeed(
                Stream.fromIterable([
                  textDeltaPart("pong"),
                  finishPart({
                    finishReason: "stop",
                    usage: { inputTokens: 120, outputTokens: 5 },
                  }),
                ]),
              )
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterRoundEnd(harness)
          const child = yield* childOf(harness)
          const [end] = roundEndMessages(snapshot.messages)
          expect(end?.metadata?.details).toMatchObject({
            round: expect.any(String),
            thread: child.sessionId,
            number: 1,
            ...child,
            agentName: DELEGATE_AGENT_NAME,
            // The thread session's name: the row heads with it, as the tray and the `»` row do.
            name: "CHILD-TASK: reply with the…",
            interrupted: false,
            streamFailed: false,
            unanswered: false,
            usage: { input: 220, output: 15 },
            tools: [{ name: "read", summary: "", status: "error" }],
            toolCount: 1,
            // Every call by tool and outcome: the head summarizes all, not only the kept ones.
            toolCounts: [{ name: "read", status: "error", count: 1 }],
            durationMs: expect.any(Number),
          })
          // The model reads the same row as words.
          expect(messageTexts([end!])[0]).toStartWith(
            `Thread "CHILD-TASK: reply with the…" (agent ${DELEGATE_AGENT_NAME}) round 1 completed.`,
          )
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "the round end carries the thread's whole bill: tokens, cache reads and writes, and cost",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              if (!promptToolCallIds(options.prompt).includes("child-read")) {
                return Effect.succeed(
                  Stream.fromIterable([
                    toolCallPart(
                      "read",
                      { path: "/tmp/no-such-file-for-a-child" },
                      { toolCallId: ToolCallId.make("child-read") },
                    ),
                    finishPart({
                      finishReason: "tool-calls",
                      usage: {
                        inputTokens: 1_000,
                        outputTokens: 100,
                        cacheReadTokens: 600,
                        cacheWriteTokens: 300,
                      },
                    }),
                  ]),
                )
              }
              return Effect.succeed(
                Stream.fromIterable([
                  textDeltaPart("pong"),
                  finishPart({
                    finishReason: "stop",
                    usage: { inputTokens: 1_200, outputTokens: 50, cacheReadTokens: 900 },
                  }),
                ]),
              )
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer, {
            // Dollars per million tokens.
            modelPricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          })
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterRoundEnd(harness)
          const [end] = roundEndMessages(snapshot.messages)
          const { usage } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              usage: Schema.Struct({
                input: Schema.Finite,
                output: Schema.Finite,
                cacheRead: Schema.Finite,
                cacheWrite: Schema.Finite,
                costUsd: Schema.Finite,
              }),
            }),
          )(end?.metadata?.details)
          expect(Struct.omit(usage, ["costUsd"])).toEqual({
            input: 2_200,
            output: 150,
            cacheRead: 1_500,
            cacheWrite: 300,
          })
          // Step 1: 100 uncached, 600 read, 300 written, 100 out. Step 2: 300
          // uncached, 900 read, 50 out.
          const stepOne = 100 * 3 + 600 * 0.3 + 300 * 3.75 + 100 * 15
          const stepTwo = 300 * 3 + 900 * 0.3 + 50 * 15
          expect(usage.costUsd).toBeCloseTo((stepOne + stepTwo) / 1_000_000, 12)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  // The hook and the recovery read one rule: a turn with no model step has no
  // bill. A round end written by the hook must match the one recovery writes
  // from the thread's `TurnCompleted` receipt, or a crash changes the record.
  it.live(
    "a delegate thread that ends before its first model step reports no usage, as its receipt does",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* harnessWithHome(startThenEnd("pong"), {
            config: new UserConfig({
              agents: {
                // The window cannot hold the thread's context: the turn ends before a step.
                [DELEGATE_AGENT_NAME]: { contextLength: 10 },
              },
            }),
          })
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterRoundEnd(harness)
          const child = yield* childOf(harness)
          const childEnds = yield* harness.client.session.events(child).pipe(
            Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
            Stream.flatMap((envelope): Stream.Stream<string> => {
              const event = envelope.event
              if (event._tag === "StreamEnded") return Stream.make("step")
              if (event._tag !== "TurnCompleted") return Stream.empty
              if (Predicate.isUndefined(event.usage)) return Stream.make("receipt")
              return Stream.make("receipt with usage")
            }),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
          )
          // No step ran, and the receipt recovery reads carries no usage.
          expect(childEnds).toEqual(["receipt"])
          const [end] = roundEndMessages(snapshot.messages)
          const details = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ usage: Schema.optional(Schema.Unknown) }),
          )(end?.metadata?.details)
          expect(Option.fromUndefinedOr(details.usage)).toEqual(Option.none())
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live("a delegate thread cannot start or stop threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childTools = yield* Deferred.make<ReadonlyArray<string>>()
        const parentTools = yield* Deferred.make<ReadonlyArray<string>>()
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const texts = promptTexts(options.prompt)
          const names = options.tools.map((entry) => entry.name)
          if (texts[0]?.endsWith(childTask) === true) {
            return Deferred.succeed(childTools, names).pipe(Effect.as(reply("could not delegate")))
          }
          if (!promptToolCallIds(options.prompt).includes("start-1")) {
            return Deferred.succeed(parentTools, names).pipe(
              Effect.as(toolStep("thread.start", delegated(childTask), "start-1")),
            )
          }
          return Effect.succeed(reply("done"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        yield* sendPrompt(harness, "delegate this task")
        const tools = yield* Deferred.await(childTools)
        const offered = yield* Deferred.await(parentTools)
        expect(tools).toEqual(expect.arrayContaining(["bash", "thread__reply"]))
        expect(tools).not.toContain("thread__start")
        expect(tools).not.toContain("thread__stop")
        expect(offered).toEqual(expect.arrayContaining(["thread__start", "thread__stop"]))
        // Nobody answers a round's turn: a confirm or a handoff would park it for good.
        const waitsOnUser = ["ask_user", "prompt", "handoff"]
        expect(tools.filter((name) => waitsOnUser.includes(name))).toEqual([])
        expect(offered).toEqual(expect.arrayContaining(waitsOnUser))
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )

  it.live(
    "a delegate thread's ask is declined at once, and its round ends and wakes its starter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // No user watches a round's turn, so no one could answer its ask.
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              if (!promptToolCallIds(options.prompt).includes("child-confirm")) {
                return Effect.succeed(toolStep("confirm", { action: "deploy" }, "child-confirm"))
              }
              return Effect.succeed(reply("CHILD: the ask was declined"))
            }
            if (!promptToolCallIds(options.prompt).includes("start-1")) {
              return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
            }
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer, { fixtures: [confirmFixture] })
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterRoundEnd(harness)
          const [end] = roundEndMessages(snapshot.messages)
          expect(messageTexts([end!])[0]).toContain("CHILD: the ask was declined")
          expect(messageTexts(snapshot.messages)).toContain("read it")
          const child = yield* childOf(harness)
          const childSnapshot = yield* harness.client.session.getSnapshot(child)
          expect(childSnapshot.runtime._tag).toBe("Idle")
          // The thread reads why, how to report it, and that no message grants it.
          expect(resultsOf("confirm", childSnapshot.messages)[0]).toMatchObject({
            result: expect.stringMatching(
              /^declined: [\s\S]*the way this turn reports its result[\s\S]*No message can grant it/,
            ),
          })
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a user who prompts a delegate thread directly gets a real approval; its round's turn still declines",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const action = "the child deploy"
          const userPrompt = "USER: deploy it here"
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            const called = promptToolCallIds(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              if (texts.includes(userPrompt)) {
                if (!called.includes("user-confirm")) {
                  return Effect.succeed(toolStep("confirm", { action }, "user-confirm"))
                }
                return Effect.succeed(reply("CHILD: ran it for the user"))
              }
              if (!called.includes("task-confirm")) {
                return Effect.succeed(toolStep("confirm", { action }, "task-confirm"))
              }
              return Effect.succeed(reply("CHILD: the ask was declined"))
            }
            if (!called.includes("start-1")) {
              return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
            }
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer, {
            dialogs: true,
            fixtures: [confirmFixture],
          })
          yield* sendPrompt(harness, "delegate this task")
          yield* afterRoundEnd(harness)
          const child = yield* childOf(harness)
          // The round's turn, which `thread.start` opened, declined at once.
          const afterTask = yield* harness.client.session.getSnapshot(child)
          expect(resultsOf("confirm", afterTask.messages)[0]).toMatchObject({
            result: expect.stringMatching(/^declined: /),
          })
          // The user switches to the thread and prompts it: a user watches that turn.
          const presented = yield* harness.client.session.events(child).pipe(
            Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* harness.client.message.send({ ...child, content: userPrompt })
          const dialog = Array.from(yield* Fiber.join(presented))[0]?.event
          if (dialog?._tag !== "InteractionPresented") return yield* Effect.die("no dialog")
          expect(dialog.text).toContain(action)
          yield* harness.client.interaction.respondInteraction({
            ...child,
            requestId: dialog.requestId,
            approved: true,
          })
          const afterUser = yield* waitFor(
            harness.client.session.getSnapshot(child),
            (current) =>
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).includes("CHILD: ran it for the user"),
            5_000,
            "the thread acted on the user's approval",
          )
          expect(resultsOf("confirm", afterUser.messages)[1]).toMatchObject({
            result: "approved",
          })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a top-level session's wake turn that asks gets a real approval",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const action = "the wake deploy"
          const note = "WAKE: deploy"
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            const called = promptToolCallIds(options.prompt)
            if (texts.some((text) => text.includes(note))) {
              if (!called.includes("wake-confirm")) {
                return Effect.succeed(toolStep("confirm", { action }, "wake-confirm"))
              }
              return Effect.succeed(reply("ran it on the wake"))
            }
            if (!called.includes("set-wake")) {
              return Effect.succeed(toolStep("wake", { afterSeconds: 0.2, note }, "set-wake"))
            }
            return Effect.succeed(reply("alarm set"))
          })
          const harness = yield* harnessWithHome(providerLayer, {
            dialogs: true,
            fixtures: [confirmFixture],
          })
          const top = { sessionId: harness.sessionId, branchId: harness.branchId }
          const presented = yield* harness.client.session.events(top).pipe(
            Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* sendPrompt(harness, "set an alarm")
          // The wake opens a turn nobody sent; the session's user still sees it.
          const dialog = Array.from(yield* Fiber.join(presented))[0]?.event
          if (dialog?._tag !== "InteractionPresented") return yield* Effect.die("no dialog")
          expect(dialog.text).toContain(action)
          yield* harness.client.interaction.respondInteraction({
            ...top,
            requestId: dialog.requestId,
            approved: true,
          })
          const after = yield* waitFor(
            harness.client.session.getSnapshot(top),
            (current) =>
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).includes("ran it on the wake"),
            5_000,
            "the wake turn acted on the approval",
          )
          expect(resultsOf("confirm", after.messages)[0]).toMatchObject({ result: "approved" })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── the round-end message ───────────────────────────────────────────────────

/**
 * The message a starter's model reads when a round ends.
 *
 * A turn receipt is not task success. A thread's turn can be interrupted,
 * have its model stream fail, or spend its continuations without ever
 * answering, and in each case the text it produced looks like an ordinary (if
 * short) result. If the outcome is not named in the message, the starter
 * reads a failure as a completed answer. The rows are planted ended and not
 * delivered, as a hook that died after the record leaves them; the starter's
 * next loop delivers each.
 */
describe("the round-end message", () => {
  it.live(
    "a round end names each way its turn ended badly, warns that a receipt is not task success, and puts the error in its header",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("ack"),
            textStep("read them"),
          ])
          const harness = yield* harnessWithHome(providerLayer)
          const starter = { sessionId: harness.sessionId, branchId: harness.branchId }
          const ends: ReadonlyArray<{
            readonly key: string
            readonly text: string
            readonly flags: Pick<PlantedRound, "interrupted" | "streamFailed" | "unanswered">
            readonly error?: string
            readonly status: string
          }> = [
            { key: "clean", text: "the thread output", flags: {}, status: "completed" },
            {
              key: "unanswered",
              text: "",
              flags: { unanswered: true },
              status: "ended (no answer produced)",
            },
            {
              key: "interrupted",
              text: "the thread output",
              flags: { interrupted: true },
              status: "ended (interrupted)",
            },
            {
              key: "failed",
              text: "the thread output",
              flags: { streamFailed: true },
              error: "sign-in failed",
              status: "ended (model stream failed)",
            },
            {
              key: "all",
              text: "the thread output",
              flags: { interrupted: true, streamFailed: true, unanswered: true },
              status: "ended (interrupted, model stream failed, no answer produced)",
            },
          ]
          for (const [index, end] of ends.entries()) {
            const thread = yield* threadSessionOf(harness)
            yield* plantRound(harness.sql, {
              round: `round-${end.key}`,
              thread: thread.sessionId,
              starter,
              session: thread,
              content: `${end.key} task`,
              startedAt: 1_000 + index,
              endedAt: 2_000 + index,
              text: end.text,
              ...end.flags,
              ...Record.filter({ error: end.error }, Predicate.isNotUndefined),
            })
          }
          yield* sendPrompt(harness, "anything new?")
          const snapshot = yield* waitFor(
            harness.client.session.getSnapshot(starter),
            (current) =>
              roundEndMessages(current.messages).length === ends.length &&
              current.runtime._tag === "Idle",
            8_000,
            "every planted round end was delivered",
          )
          const byRound = new Map(
            roundEndMessages(snapshot.messages).map((message) => {
              const details = Schema.decodeUnknownSync(Schema.Struct({ round: Schema.String }))(
                message.metadata?.details,
              )
              return [details.round, messageTexts([message]).join("")] as const
            }),
          )
          for (const end of ends) {
            const text = byRound.get(`round-${end.key}`) ?? ""
            expect(text).toContain(` round 1 ${end.status}.`)
            expect(text).toContain(ROUND_END_MARK)
          }
          expect(byRound.get("round-clean")).not.toContain("ended (")
          expect(byRound.get("round-clean")).toContain("the thread output")
          // The error a failed turn ended on is in the header, not in the output.
          const [header = "", output = ""] = (byRound.get("round-failed") ?? "").split("\n\n")
          expect(header).toContain("Error: sign-in failed")
          expect(output).toBe("the thread output")
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

// ── the starter's interrupt ─────────────────────────────────────────────────

/**
 * A starter's interrupted turn stops the `starter` rounds it waits for. Left
 * running they have no one waiting: the gamut testbed showed six such
 * children editing files after an Escape. A stopped round wakes nobody, so
 * the starter's next turns read a notice instead.
 */

const interruptStarter = (harness: Harness, requestId: string, branchId = harness.branchId) =>
  harness.client.steer.command({
    command: SteerCommand.cases.Cancel.make({
      sessionId: harness.sessionId,
      branchId,
      requestId: RequestId.make(requestId),
    }),
  })

/** A round the starter's interrupt stopped, planted with an unread stop notice. */
const stoppedRound = (
  harness: Harness,
  n: number,
  stopNoticeAt: number,
  round = `stopped-${n}`,
): PlantedRound => {
  const starter = { sessionId: harness.sessionId, branchId: harness.branchId }
  return {
    round,
    thread: `stopped-thread-${n}`,
    starter,
    session: {
      sessionId: SessionId.make(`stopped-session-${n}`),
      branchId: BranchId.make(`stopped-branch-${n}`),
    },
    content: `stopped task ${n}\nsecond line`,
    startedAt: stopNoticeAt - 500,
    stoppedAt: stopNoticeAt,
    endedAt: stopNoticeAt,
    interrupted: true,
    deliveredAt: stopNoticeAt,
    wake: starter,
    stopNoticeAt,
  }
}

const noticeLine = (n: number) =>
  `- "stopped task ${n}" · thread stopped-thread-${n} · round stopped-${n}`

/** The receipt of the starter's `count`th turn. */
const turnEnd = (harness: Harness, count: number) =>
  harness.client.session.events({ sessionId: harness.sessionId, branchId: harness.branchId }).pipe(
    Stream.map((envelope) => envelope.event),
    Stream.filter((event) => event._tag === "TurnCompleted"),
    Stream.take(count),
    Stream.runLast,
    Effect.map(Option.getOrUndefined),
  )

describe("the starter's interrupt", () => {
  // The live run: an interrupt stopped three children, and the parent's next
  // turn said "Tasks 4–6 are still running". The stop wakes nobody, so the
  // next turn the user starts reads a notice, until a turn answers.
  it.live(
    "the starter's interrupt stops its open starter rounds, wakes nobody, and its next turn names them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childStreaming = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const parentRequests: Array<{
            readonly system: string
            readonly notices: string
            /** The notices arrived in the `<host-context-update>` user message. */
            readonly noticesWrapped: boolean
            readonly last: string
          }> = []
          // A model that takes a system message in its history: only the
          // notice's provenance keeps it out of that role.
          const providerLayer = LanguageModelLayers.testStream(
            (options) => {
              const texts = promptTexts(options.prompt)
              // The thread's stream opens and stalls: it is mid-turn when the
              // starter is interrupted.
              if (texts[0]?.endsWith(childTask) === true)
                return Effect.succeed(stalledStream("working", childStreaming))
              parentRequests.push({
                system: systemTextOf(options.prompt),
                notices: noticeText(options.prompt),
                noticesWrapped: Option.exists(
                  Option.fromUndefinedOr(options.prompt.content.at(-1)),
                  isHostContextUpdate,
                ),
                last: texts.at(-1) ?? "",
              })
              if (parentRequests.length === 1) {
                return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
              }
              // The starter's turn is still open after the start, so the
              // interrupt lands on a turn that waits for a running round.
              if (parentRequests.length === 2)
                return Effect.succeed(stalledStream("planning", parentStreaming))
              return Effect.succeed(reply("ack"))
            },
            { supportsSystemMessagesInHistory: true },
          )
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate one task")
          yield* Deferred.await(childStreaming)
          yield* Deferred.await(parentStreaming)
          const child = yield* childOf(harness)
          yield* interruptStarter(harness, "interrupt-starter-of-running-thread")
          const childEnd = yield* client.session.events(child).pipe(
            Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
            Stream.take(1),
            Stream.runHead,
          )
          expect(Option.map(childEnd, (envelope) => envelope.event._tag)).toEqual(
            Option.some("TurnCompleted"),
          )
          expect(Option.map(childEnd, (envelope) => envelope.event)).toMatchObject(
            Option.some({ interrupted: true }),
          )
          const [row] = yield* waitFor(
            roundsOf(harness.sql),
            (rows) => rows[0]?.delivered === 1,
            3_000,
            "the starter's interrupt closed the round",
          )
          expect(row).toMatchObject({ interrupted: 1, stopped: 1, ended: 1, stop_noticed: 1 })
          const settled = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            3_000,
            "the starter is idle",
          )
          // The stop woke nobody: no round end, and no turn of its own.
          expect(roundEndMessages(settled.messages)).toHaveLength(0)
          expect(parentRequests).toHaveLength(2)

          yield* sendPrompt(harness, "WHAT-IS-RUNNING")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" && messageTexts(current.messages).includes("ack"),
            3_000,
            "the starter answered the next prompt",
          )
          const next = parentRequests[2]
          expect(next?.last).toBe("WHAT-IS-RUNNING")
          // The notice rides after the conversation; the system prompt is the
          // one the turns before it sent.
          expect(next?.system).toBe(parentRequests[0]?.system)
          expect(next?.notices).toContain("# Stopped threads")
          expect(next?.notices).toContain(childTask)
          expect(next?.notices).toContain(child.sessionId)
          // It quotes the round's task, which a model wrote, so it is
          // untrusted: a user message, never a system message.
          expect(next?.noticesWrapped).toBe(true)
          // The user's interrupt stopped them: the notice asks for a report, not a restart.
          expect(next?.notices).toContain("Tell the user which threads stopped")
          expect(next?.notices).toContain("only when the user asks for it")

          // The answered turn read the notice; the one after it does not see it again.
          yield* sendPrompt(harness, "AND-NOW")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).filter((text) => text === "ack").length === 2,
            3_000,
            "the starter answered the prompt after",
          )
          expect(parentRequests).toHaveLength(4)
          expect(parentRequests[3]?.notices).toBe("")
          expect(parentRequests[3]?.system).toBe(parentRequests[0]?.system)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live("leaves a user round running: it is the user's side thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childStreaming = yield* Deferred.make<void>()
        const parentStreaming = yield* Deferred.make<void>()
        const notices: Array<string> = []
        let parentCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const texts = promptTexts(options.prompt)
          if (texts[0]?.endsWith(childTask) === true)
            return Effect.succeed(stalledStream("working", childStreaming))
          notices.push(noticeText(options.prompt))
          parentCalls += 1
          if (parentCalls === 1) {
            // No notify: the round's replies go to the user in the thread.
            return Effect.succeed(
              toolStep("thread.start", { task: childTask, agent: "delegate" }, "start-1"),
            )
          }
          if (parentCalls === 2) return Effect.succeed(stalledStream("planning", parentStreaming))
          return Effect.succeed(reply("ack"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        yield* sendPrompt(harness, "start a side thread")
        yield* Deferred.await(childStreaming)
        yield* Deferred.await(parentStreaming)
        const child = yield* childOf(harness)
        yield* interruptStarter(harness, "interrupt-starter-of-user-thread")
        yield* waitFor(
          harness.client.session.getSnapshot(harness),
          (current) => current.runtime._tag === "Idle",
          3_000,
          "the starter is idle",
        )
        yield* sendPrompt(harness, "NEXT")
        yield* idleAfter(harness, "ack")
        // The thread still runs its round, and nothing names it as stopped.
        expect((yield* harness.client.session.getSnapshot(child)).runtime._tag).toBe("Running")
        expect(yield* turnReceipts(harness, child)).toHaveLength(0)
        const [row] = yield* roundsOf(harness.sql)
        expect(row).toMatchObject({ notify: "user", stopped: 0, ended: 0 })
        expect(notices.join("\n")).not.toContain("# Stopped threads")
      }).pipe(Effect.timeout("10 seconds")),
    ),
  )

  it.live("an interrupt on another branch of the starter leaves the round it did not send", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childStreaming = yield* Deferred.make<void>()
        const otherStreaming = yield* Deferred.make<void>()
        let parentCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const texts = promptTexts(options.prompt)
          if (texts[0]?.endsWith(childTask) === true)
            return Effect.succeed(stalledStream("working", childStreaming))
          if (texts.includes("OTHER-BRANCH"))
            return Effect.succeed(stalledStream("elsewhere", otherStreaming))
          parentCalls += 1
          if (parentCalls === 1) {
            return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
          }
          return Effect.succeed(reply("started, ending my turn"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { client, sessionId, branchId } = harness
        yield* sendPrompt(harness, "delegate one task")
        yield* Deferred.await(childStreaming)
        yield* idleAfter(harness, "started, ending my turn")
        const child = yield* childOf(harness)
        // The user moves the starter to another branch and interrupts a turn there.
        const other = yield* client.branch.create({ sessionId, name: "elsewhere" })
        yield* client.branch.switch({
          sessionId,
          fromBranchId: branchId,
          toBranchId: other.branchId,
        })
        yield* client.message.send({ sessionId, branchId: other.branchId, content: "OTHER-BRANCH" })
        yield* Deferred.await(otherStreaming)
        yield* interruptStarter(harness, "interrupt-the-other-branch", other.branchId)
        yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId: other.branchId }),
          (current) => current.runtime._tag === "Idle",
          3_000,
          "the other branch is idle",
        )
        // The round the first branch sent still runs, and no stop names it.
        expect((yield* client.session.getSnapshot(child)).runtime._tag).toBe("Running")
        const [row] = yield* roundsOf(harness.sql)
        expect(row).toMatchObject({ stopped: 0, ended: 0, stop_noticed: 0 })
      }).pipe(Effect.timeout("10 seconds")),
    ),
  )

  it.live("keeps the stop notice through a turn that never answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const systems: Array<{ readonly notices: string; readonly last: string }> = []
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const last = promptTexts(options.prompt).at(-1) ?? ""
          systems.push({ notices: noticeText(options.prompt), last })
          // Every request of the first turn gets an empty reply: it spends its
          // continuations and ends unanswered.
          if (last === "NEXT") return Effect.succeed(reply("ack"))
          return Effect.succeed(reply(""))
        })
        const harness = yield* harnessWithHome(providerLayer)
        yield* plantRound(harness.sql, stoppedRound(harness, 1, 1_000))
        yield* sendPrompt(harness, "SILENT")
        const first = yield* turnEnd(harness, 1)
        expect(first).toMatchObject({ unanswered: true })
        expect(systems[0]?.notices).toContain(noticeLine(1))

        yield* sendPrompt(harness, "NEXT")
        yield* turnEnd(harness, 2)
        const next = systems.find((request) => request.last === "NEXT")
        expect(next?.notices).toContain(noticeLine(1))
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )

  it.live("keeps a stop notice the turn could not read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const restores: Array<Effect.Effect<void>> = []
        const systems: Array<{ readonly notices: string; readonly last: string }> = []
        const providerLayer = LanguageModelLayers.testStream((options) =>
          Effect.gen(function* () {
            // The projection already ran: the table reads again from here on.
            yield* Effect.all(restores.splice(0), { discard: true })
            const last = promptTexts(options.prompt).at(-1) ?? ""
            systems.push({ notices: noticeText(options.prompt), last })
            return reply("ack")
          }),
        )
        const harness = yield* harnessWithHome(providerLayer)
        yield* plantRound(harness.sql, stoppedRound(harness, 1, 1_000))
        // The table is out of reach for the first turn's projection, as a
        // locked or broken database leaves it.
        yield* execute(harness.sql, "ALTER TABLE thread_rounds RENAME TO thread_rounds_away")
        restores.push(
          execute(harness.sql, "ALTER TABLE thread_rounds_away RENAME TO thread_rounds").pipe(
            Effect.asVoid,
          ),
        )
        yield* sendPrompt(harness, "UNREAD")
        yield* turnEnd(harness, 1)
        expect(systems[0]?.notices).not.toContain("# Stopped threads")

        yield* sendPrompt(harness, "NEXT")
        yield* turnEnd(harness, 2)
        const next = systems.find((request) => request.last === "NEXT")
        expect(next?.notices).toContain(noticeLine(1))
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )

  it.live("names a bounded number of stopped threads, one line each, and clears only those", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const systems: Array<string> = []
        const providerLayer = LanguageModelLayers.testStream((options) => {
          systems.push(noticeText(options.prompt))
          return Effect.succeed(reply("ack"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        // Twelve threads; thread 12 was stopped twice, so it has two rounds.
        for (const n of Array.from({ length: 12 }, (_, index) => index + 1)) {
          yield* plantRound(harness.sql, stoppedRound(harness, n, 1_000 + n))
        }
        yield* plantRound(harness.sql, stoppedRound(harness, 12, 2_000, "stopped-12-again"))
        yield* sendPrompt(harness, "FIRST")
        yield* turnEnd(harness, 1)
        const first = systems[0] ?? ""
        const named = first.split("\n").filter((line) => line.startsWith('- "'))
        // The newest eight, thread 12 once at its latest stop, and a count of the rest.
        expect(named).toHaveLength(8)
        expect(named.filter((line) => line.includes("stopped task 12"))).toEqual([
          '- "stopped task 12" · thread stopped-thread-12 · round stopped-12-again',
        ])
        expect(first).toContain(noticeLine(5))
        expect(first).not.toContain(noticeLine(4))
        expect(first).toContain("and 4 more stopped threads")

        yield* sendPrompt(harness, "SECOND")
        yield* turnEnd(harness, 2)
        const second = systems.at(-1) ?? ""
        expect(second).toContain(noticeLine(4))
        // The answered turn cleared the notices it named, both of thread 12's rounds too.
        expect(second).not.toContain("stopped task 12")
        expect(second).not.toContain(noticeLine(5))
        expect(second).not.toContain("more stopped threads")
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )
})

// ── a start nobody waits for ────────────────────────────────────────────────

/**
 * A start nobody waits for is background delegation. The round's end must
 * come back as a message on the starter's branch, which wakes the starter for
 * another turn. Nothing else carries the result.
 */
describe("a start nobody waits for", () => {
  /** The session name of the thread one `thread.start` with `params` made. */
  const startedThreadName = (params: { readonly task: string; readonly name?: string }) =>
    Effect.scoped(
      Effect.gen(function* () {
        let parentCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          if (promptTexts(options.prompt)[0]?.includes("CHILD-NAME") === true) {
            return Effect.succeed(reply("named"))
          }
          parentCalls += 1
          if (parentCalls === 1) {
            return Effect.succeed(
              toolStep("thread.start", delegated(params.task, params), "named-child"),
            )
          }
          return Effect.succeed(reply("started"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        yield* sendPrompt(harness, "delegate a named task")
        const child = yield* childOf(harness)
        const sessions = yield* harness.client.session.list()
        return sessions.find((session) => session.id === child.sessionId)?.name
      }),
    )

  // The tray, the sessions pane and the round-end row head with the name: a
  // short label, never the agent's name again (every delegate thread runs as
  // `delegate`).
  it.live("a thread is named by its task's first clause, cut at a whole word", () =>
    Effect.gen(function* () {
      const context = "\n\nContext: the rest of the task. CHILD-NAME"
      expect(
        yield* startedThreadName({ task: `Check the greeting files (debug tools).${context}` }),
      ).toBe("Check the greeting files")
      expect(
        yield* startedThreadName({
          task: `## Audit every loader path and report each failure mode${context}`,
        }),
      ).toBe("Audit every loader path and…")
      // A word longer than the name is cut between characters: the emoji
      // straddling the cut goes whole, no half of a surrogate pair stays.
      expect(yield* startedThreadName({ task: `${"a".repeat(30)}🙂tail${context}` })).toBe(
        `${"a".repeat(30)}…`,
      )
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.live("a start's own name names the thread, on one line", () =>
    Effect.gen(function* () {
      expect(
        yield* startedThreadName({
          task: "CHILD-NAME: check the greeting files",
          name: "  greeting\naudit ",
        }),
      ).toBe("greeting audit")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("refuses a start without a host-owned tool call", () =>
    Effect.gen(function* () {
      const ctx = Struct.omit(testToolContext(), ["toolCallId"])
      const error = yield* runToolWithCtx(
        ThreadStartTool,
        { task: "analyze the codebase", agent: DELEGATE_AGENT_NAME, notify: "starter" },
        ctx,
      ).pipe(Effect.flip)
      expect(error._tag).toBe("ThreadError")
      expect(error).toMatchObject({ message: "thread.start requires a host-owned tool call" })
    }),
  )

  it.live(
    "a round saved and never sent is sent on the starter's next turn, runs under its thread session's model, and still delivers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const providerLayer = LanguageModelLayers.testStream((options) => {
            if (promptTexts(options.prompt)[0]?.endsWith(childTask) === true) {
              return Effect.succeed(reply("pong"))
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          // A process that died between saving the round and sending it. The
          // thread session carries its model from its creation, as a start makes it.
          const thread = yield* threadSessionOf(harness, {
            modelId: ModelId.make("test/override-model"),
          })
          yield* plantRound(harness.sql, unsentRound(harness, thread, "crashed-start"))
          yield* sendPrompt(harness, "hello again")
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              roundEndMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
            8_000,
            "the recovered round delivered its end",
          )
          expect(messageTexts(roundEndMessages(snapshot.messages))[0]).toContain("pong")
          const [row] = yield* roundsOf(harness.sql)
          expect(row).toMatchObject({ round: "crashed-start", interrupted: 0, delivered: 1 })
          const threadMessages = yield* client.message.list(thread)
          expect(threadMessages.filter((m) => m.role === "user")).toHaveLength(1)
          expect(yield* modelsOf(harness, thread)).toEqual([ModelId.make("test/override-model")])
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "the thread.start schema the model sees has flat parameters and no overrides",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const schemas: Array<string> = []
          const providerLayer = LanguageModelLayers.testStream((options) => {
            for (const entry of options.tools) {
              if (entry.name === "thread__start") {
                schemas.push(encodeJson(AiTool.getJsonSchema(entry)))
              }
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "hello")
          yield* waitFor(
            Effect.sync(() => schemas.length),
            (count) => count > 0,
            8_000,
            "the starter's turn declared its tools",
          )
          const schema = schemas[0] ?? ""
          for (const key of ["task", "agent", "model", "effort", "tools", "notify", "workspace"]) {
            expect(schema).toContain(`"${key}"`)
          }
          expect(schema).toContain('"fork"')
          for (const key of ["overrides", "todo", "paths", "maxSteps", "modelId", "allowedTools"]) {
            expect(schema).not.toContain(`"${key}"`)
          }
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── a stop ──────────────────────────────────────────────────────────────────

/**
 * A stop ends the thread its starter names. Two starters in one workspace can
 * each start a thread under the tool call id `start-1`; the stop each sends
 * must be its own, or the second returns the first's receipt and its thread
 * runs on.
 */

/** The thread the starter's `thread.start` result named, once the prompt carries it. */
const startedSessionId = (prompt: Prompt.Prompt): Option.Option<string> =>
  Option.fromUndefinedOr(
    prompt.content
      .flatMap((message) => {
        if (message.role !== "tool") return []
        return message.content
      })
      .flatMap((part) => {
        if (part.type !== "tool-result" || part.name !== "thread__start") return []
        const decoded = Schema.decodeUnknownOption(Schema.Struct({ sessionId: Schema.String }))(
          part.result,
        )
        return Option.match(decoded, { onNone: () => [], onSome: (value) => [value.sessionId] })
      })[0],
  )

describe("a stop", () => {
  it.live(
    "two starters that each stop the thread their call start-1 started end both rounds as interrupted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const names = ["first", "second"] as const
          const opened = {
            first: yield* Deferred.make<void>(),
            second: yield* Deferred.make<void>(),
          }
          /** Which starter a request belongs to: its first text ends with the starter's name. */
          const nameOf = (texts: ReadonlyArray<string>) =>
            names.find((name) => texts[0]?.endsWith(name) === true)
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            const name = nameOf(texts)
            if (Predicate.isUndefined(name)) return Effect.succeed(reply("no such starter"))
            // Each thread's stream opens and stalls: it runs until its starter stops it.
            if (texts[0]?.includes(childTask) === true)
              return Effect.succeed(stalledStream("working", opened[name]))
            const calls = promptToolCallIds(options.prompt).length
            if (calls === 0) {
              return Effect.succeed(
                toolStep("thread.start", delegated(`${childTask} ${name}`), "start-1"),
              )
            }
            if (calls === 1) {
              const thread = Option.getOrThrow(startedSessionId(options.prompt))
              return Deferred.await(opened[name]).pipe(
                Effect.as(toolStep("thread.stop", { thread }, "stop-1")),
              )
            }
            return Effect.succeed(reply("stopped"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client } = harness
          const second = yield* client.session.create({ cwd: harness.cwd })
          const starters = [{ sessionId: harness.sessionId, branchId: harness.branchId }, second]
          for (const [index, starter] of starters.entries()) {
            yield* client.message.send({ ...starter, content: `starter ${names[index]}` })
            const rows = yield* waitFor(
              roundsOf(harness.sql),
              (found) =>
                found.some(
                  (row) => row.starter_session_id === starter.sessionId && row.ended === 1,
                ),
              5_000,
              `the ${names[index]} starter's stop ended its round`,
            )
            expect(rows.find((row) => row.starter_session_id === starter.sessionId)).toMatchObject({
              interrupted: 1,
              stopped: 1,
            })
          }
          const threads = (yield* client.session.list()).filter((session) =>
            starters.some((starter) => starter.sessionId === session.parentSessionId),
          )
          expect(threads).toHaveLength(2)
          for (const thread of threads) {
            if (Predicate.isUndefined(thread.activeBranchId)) return yield* Effect.die("no branch")
            const end = yield* client.session
              .events({ sessionId: thread.id, branchId: thread.activeBranchId })
              .pipe(
                Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
                Stream.take(1),
                Stream.runHead,
              )
            expect(Option.map(end, (envelope) => envelope.event._tag)).toEqual(
              Option.some("TurnCompleted"),
            )
            expect(Option.map(end, (envelope) => envelope.event)).toMatchObject(
              Option.some({ interrupted: true }),
            )
          }
        }).pipe(Effect.timeout("14 seconds")),
      ),
    16_000,
  )
})

// ── the running cap ─────────────────────────────────────────────────────────

/**
 * A starter's thread runs at most four threads with an open round. A fifth
 * and sixth start in the same step must fail as ordinary tool results, not as
 * a turn failure: the model reads the refusal and keeps going. This is the
 * shape that broke in the gamut testbed (six starts in one `Promise.all`, two
 * over the cap), so the cap must refuse the extra threads while the four
 * admitted ones still run and deliver.
 */

const startCall = (task: string) => ({ toolName: "thread.start", input: delegated(task) })

/**
 * The failed start results on the starter's branch that name the cap. A
 * failed tool result carries its message in `result`, so the refusal is
 * readable model input rather than a dead turn.
 */
const cappedResults = (messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Prompt.Part> }>) =>
  resultsOf("thread.start", messages).filter((part) => {
    if (part.type !== "tool-result" || !part.isFailure) return false
    const result = part.result
    if (!Predicate.isReadonlyObject(result)) return false
    return String(result["error"]).includes("already runs")
  })

describe("the running cap", () => {
  it.live(
    "starts past the cap are refused as tool results, and the admitted threads run",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The starter's follow-up turn and the four admitted threads all
          // draw from the gated steps, in whatever order they reach the model.
          // They stay closed until both refusals are on the branch: a thread
          // that finished between two admissions would free its place, and the
          // sixth start would be admitted.
          const followUps = 16
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            multiToolCallStep(
              startCall("Reply with the single word one"),
              startCall("Reply with the single word two"),
              startCall("Reply with the single word three"),
              startCall("Reply with the single word four"),
              startCall("Reply with the single word five"),
              startCall("Reply with the single word six"),
            ),
            ...Array.from({ length: followUps }, () => ({ ...textStep("ack"), gated: true })),
          ])
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate six tasks")

          // The two starts past the cap come back as ordinary tool results on
          // the starter's branch. A turn that died on the refusal would never
          // persist them.
          const afterAdmission = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => cappedResults(current.messages).length >= 2,
            10_000,
            "the capped starts returned as tool results",
          )
          expect(cappedResults(afterAdmission.messages)).toHaveLength(2)
          // The refusal names the cap the starter's thread is at.
          for (const refused of cappedResults(afterAdmission.messages)) {
            expect(refused).toMatchObject({
              result: { error: expect.stringContaining("thread already runs 4 threads") },
            })
          }
          // A refused start makes no session.
          const threads = (yield* client.session.list()).filter(
            (session) => session.parentSessionId === sessionId,
          )
          expect(threads).toHaveLength(4)
          yield* Effect.forEach(
            Array.from({ length: followUps }, (_, index) => index + 1),
            controls.emitAll,
            { discard: true },
          )

          // The four admitted threads still deliver; the cap refused the
          // extras without disturbing them.
          const settled = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              roundEndMessages(current.messages).length >= 4 && current.runtime._tag === "Idle",
            20_000,
            "the four admitted threads delivered their round ends",
          )
          expect(roundEndMessages(settled.messages)).toHaveLength(4)
          // Each admitted thread ran as the delegate agent, and its round completed.
          for (const text of messageTexts(roundEndMessages(settled.messages))) {
            expect(text).toMatch(/^Thread ".+" \(agent delegate\) round 1 completed\./)
          }
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a thread deleted from the agents pane frees its place, and wakes nobody",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let parentCalls = 0
          // The threads never answer: each one holds its place until it is deleted.
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.startsWith("Round ") === true) return Effect.never
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(
                Stream.fromIterable([
                  ...["one", "two", "three", "four"].map((word) =>
                    toolCallPart("thread.start", delegated(`Reply with ${word}`), {
                      toolCallId: ToolCallId.make(`start-${word}`),
                    }),
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            if (parentCalls === 3) {
              return Effect.succeed(
                toolStep("thread.start", delegated("Reply with five"), "start-five"),
              )
            }
            return Effect.succeed(reply("ok"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate four tasks")
          const idle = (count: number) =>
            waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (current) =>
                current.runtime._tag === "Idle" &&
                resultsOf("thread.start", current.messages).length === count,
              8_000,
              `the starter ended its turn with ${count} start results`,
            )
          yield* idle(4)
          const admitted = yield* roundsOf(harness.sql)
          expect(admitted).toHaveLength(4)
          // The user deletes every thread from the agents pane.
          yield* Effect.forEach(
            admitted,
            (row) => client.session.delete({ sessionId: SessionId.make(row.session_id) }),
            { discard: true },
          )
          yield* sendPrompt(harness, "start one more")
          const snapshot = yield* idle(5)
          const results = resultsOf("thread.start", snapshot.messages)
          expect(results.filter((part) => part.type === "tool-result" && part.isFailure)).toEqual(
            [],
          )
          // The deleted threads' rounds went with their sessions; only the fifth is open.
          const rows = yield* roundsOf(harness.sql)
          expect(rows.map((row) => row.ended)).toEqual([0])
          expect(admitted.map((row) => row.round)).not.toContain(rows[0]?.round)
          // A deleted thread goes quietly: the user removed it, so nothing wakes the starter.
          expect(roundEndMessages(snapshot.messages)).toEqual([])
        }).pipe(Effect.timeout("15 seconds")),
      ),
    20_000,
  )

  it.live(
    "the starter's next turn drops a round whose thread was deleted while no process ran",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          // The thread's session is gone, and no delete hook dropped its round.
          const thread = yield* threadSessionOf(harness)
          yield* client.session.delete({ sessionId: thread.sessionId })
          yield* plantRound(harness.sql, unsentRound(harness, thread, "deleted-thread"))
          yield* sendPrompt(harness, "anything new?")
          yield* waitFor(
            roundsOf(harness.sql),
            (rows) => rows.length === 0,
            5_000,
            "reconcile dropped the deleted thread's round",
          )
          const snapshot = yield* idleAfter(harness, "ok")
          expect(roundEndMessages(snapshot.messages)).toEqual([])
          expect((yield* client.session.getSnapshot({ sessionId, branchId })).runtime._tag).toBe(
            "Idle",
          )
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── turn-time reconcile ─────────────────────────────────────────────────────

describe("turn-time reconcile", () => {
  it.live(
    "a branch's turns reconcile once per process, so later model steps do not replay thread logs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("first"),
            textStep("second"),
          ])
          const harness = yield* harnessWithHome(providerLayer)
          const { client } = harness
          yield* sendPrompt(harness, "one")
          yield* idleAfter(harness, "first")
          // A round that only a crash leaves, planted after this process reconciled the branch.
          const thread = yield* threadSessionOf(harness)
          yield* plantRound(harness.sql, unsentRound(harness, thread, "planted-start"))
          yield* sendPrompt(harness, "two")
          yield* idleAfter(harness, "second")
          const [row] = yield* roundsOf(harness.sql)
          expect(row).toMatchObject({ round: "planted-start", ended: 0 })
          expect(yield* client.message.list(thread)).toHaveLength(0)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "thread.list reads a running round and sends it no second time",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) return Effect.succeed(reply("pong"))
            if (!texts.includes("list them")) return Effect.succeed(reply("first"))
            if (promptToolCallIds(options.prompt).includes("list-1")) {
              return Effect.succeed(reply("listed"))
            }
            return Effect.succeed(toolStep("thread.list", {}, "list-1"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client } = harness
          // The starter's loop is open and reconciled in this process.
          yield* sendPrompt(harness, "one")
          yield* idleAfter(harness, "first")
          // A round saved with no turn on its thread: as far as the table
          // knows it runs, so a re-send would show.
          const thread = yield* threadSessionOf(harness)
          yield* plantRound(harness.sql, unsentRound(harness, thread, "running-start"))
          yield* sendPrompt(harness, "list them")
          const snapshot = yield* idleAfter(harness, "listed")
          // The listing names the open round and sent the thread nothing.
          expect(resultsOf("thread.list", snapshot.messages)[0]).toMatchObject({
            isFailure: false,
            result: [{ thread: thread.sessionId, openRound: { round: "running-start" } }],
          })
          expect(yield* client.message.list(thread)).toHaveLength(0)
          const [row] = yield* roundsOf(harness.sql)
          expect(row).toMatchObject({ round: "running-start", ended: 0, delivered: 0 })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── a failed round-end delivery ─────────────────────────────────────────────

/**
 * The starter starts one delegate thread and ends its turn. The round table
 * then refuses the delivery's write, and `gate` opens the thread's model, so
 * the thread's own hook records the round's end but cannot deliver it; only
 * reconcile can. `threadRan` waits on the thread; the table takes the write
 * again once it returns.
 */
const failDelivery = <E, R>(
  harness: Harness,
  gate: Deferred.Deferred<void>,
  threadRan: (thread: BranchRef) => Effect.Effect<unknown, E, R>,
) =>
  Effect.gen(function* () {
    yield* sendPrompt(harness, "delegate this task")
    yield* idleAfter(harness, "started, ending my turn")
    const thread = yield* childOf(harness)
    yield* execute(
      harness.sql,
      "CREATE TRIGGER refuse_wake BEFORE UPDATE OF wake_session_id ON thread_rounds BEGIN SELECT RAISE(ABORT, 'wake target refused'); END",
    )
    yield* Deferred.succeed(gate, void 0)
    yield* threadRan(thread)
    const [stuck] = yield* roundsOf(harness.sql)
    expect(stuck).toMatchObject({ ended: 1, delivered: 0 })
    yield* execute(harness.sql, "DROP TRIGGER refuse_wake")
  })

/** The starter's next turn, which delivers the round end its thread could not. */
const deliveredOnNextTurn = (harness: Harness) =>
  sendPrompt(harness, "anything new?").pipe(
    Effect.andThen(
      waitFor(
        harness.client.session.getSnapshot({
          sessionId: harness.sessionId,
          branchId: harness.branchId,
        }),
        (current) =>
          roundEndMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
        8_000,
        "the starter's next turn delivered the round end",
      ),
    ),
  )

describe("a failed round-end delivery", () => {
  it.live(
    "a round whose turn died at a usage limit keeps the reset, read from its history when its hook could not record it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          // A limit that resets in 60 s is past the retry cap: the turn ends on it.
          const harness = yield* harnessWithHome(
            startThenEndWith(() =>
              Deferred.await(gate).pipe(
                Effect.andThen(
                  Effect.fail(
                    AiError.make({
                      module: "ChildProvider",
                      method: "streamText",
                      reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(60) }),
                    }),
                  ),
                ),
              ),
            ),
          )
          yield* sendPrompt(harness, "delegate this task")
          yield* idleAfter(harness, "started, ending my turn")
          const thread = yield* childOf(harness)
          // The thread's own hook cannot record the end: only its history keeps the reset.
          yield* execute(
            harness.sql,
            "CREATE TRIGGER refuse_end BEFORE UPDATE OF ended_at ON thread_rounds BEGIN SELECT RAISE(ABORT, 'end refused'); END",
          )
          const before = yield* Clock.currentTimeMillis
          yield* Deferred.succeed(gate, void 0)
          yield* waitFor(
            harness.client.session.getSnapshot(thread),
            (current) => current.runtime._tag === "Idle" && current.metrics.turns > 0,
            5_000,
            "the thread's turn failed and its hook could not record it",
          )
          const [open] = yield* roundsOf(harness.sql)
          expect(open).toMatchObject({ ended: 0 })
          yield* execute(harness.sql, "DROP TRIGGER refuse_end")
          yield* deliveredOnNextTurn(harness)
          const [row] = yield* roundsOf(harness.sql)
          expect(row).toMatchObject({ ended: 1, stream_failed: 1 })
          const [retry] = yield* retriesOf(harness.sql)
          expect(retry).toBeGreaterThanOrEqual(before + 60_000)
          expect(retry).toBeLessThanOrEqual((yield* Clock.currentTimeMillis) + 60_000)
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a round end whose delivery failed is delivered on the starter's next turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const reason = "CHILD-AUTH-PROBE: recovered after a failed hook"
          const gate = yield* Deferred.make<void>()
          const harness = yield* harnessWithHome(
            startThenEndWith(() =>
              Deferred.await(gate).pipe(Effect.andThen(childSignInFails(reason))),
            ),
          )
          const { client } = harness
          // The starter's branch was reconciled in this process before the failure.
          yield* failDelivery(harness, gate, (thread) =>
            waitFor(
              client.session.getSnapshot(thread),
              (current) => current.runtime._tag === "Idle" && current.metrics.turns > 0,
              5_000,
              "the thread's turn failed and its delivery failed",
            ),
          )
          const snapshot = yield* deliveredOnNextTurn(harness)
          const [end] = roundEndMessages(snapshot.messages)
          // The round end still names the error the thread ended on.
          expect(messageTexts(roundEndMessages(snapshot.messages)).join("")).toContain(reason)
          expect(end?.metadata?.details).toMatchObject({
            streamFailed: true,
            error: expect.stringContaining(reason),
          })
          const [row] = yield* roundsOf(harness.sql)
          expect(row?.delivered).toBe(1)
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a recovered round end reports the round's turn, not a wake turn that ran before recovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const providerLayer = startThenEndWith((options) => {
            if (promptTexts(options.prompt).some((text) => text.includes("WAKE-NOTE"))) {
              return Effect.succeed(reply("LATER-ANSWER"))
            }
            if (!promptToolCallIds(options.prompt).includes("arm-wake")) {
              return Deferred.await(gate).pipe(
                Effect.as(
                  toolStep("wake", { afterSeconds: 0.2, note: "WAKE-NOTE: check" }, "arm-wake"),
                ),
              )
            }
            return Effect.succeed(reply("START-ANSWER"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          // The round's hook delivery fails; the thread's wake turn then runs.
          yield* failDelivery(harness, gate, (thread) =>
            waitFor(
              harness.client.session.getSnapshot(thread),
              (current) =>
                current.runtime._tag === "Idle" &&
                messageTexts(current.messages).includes("LATER-ANSWER"),
              6_000,
              "the thread's wake turn ran before recovery",
            ),
          )
          const snapshot = yield* deliveredOnNextTurn(harness)
          const text = messageTexts(roundEndMessages(snapshot.messages)).join("")
          expect(text).toContain("START-ANSWER")
          expect(text).not.toContain("LATER-ANSWER")
          expect(roundEndMessages(snapshot.messages)[0]?.metadata?.details).toMatchObject({
            tools: [{ name: "wake" }],
            toolCount: 1,
          })
        }).pipe(Effect.timeout("14 seconds")),
      ),
    16_000,
  )

  it.live(
    "a recovered round end ends before a turn an interjection woke",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const providerLayer = startThenEndWith((options) => {
            if (promptTexts(options.prompt).some((text) => text.includes("STEER-NOTE"))) {
              return Effect.succeed(reply("LATER-ANSWER"))
            }
            return Deferred.await(gate).pipe(Effect.as(reply("START-ANSWER")))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client } = harness
          yield* failDelivery(harness, gate, (thread) =>
            Effect.gen(function* () {
              yield* waitFor(
                client.session.getSnapshot(thread),
                (current) =>
                  current.runtime._tag === "Idle" &&
                  messageTexts(current.messages).includes("START-ANSWER"),
                5_000,
                "the thread's round turn ended and its delivery failed",
              )
              // An interjection with wake starts the idle thread's next turn.
              yield* client.steer.command({
                command: SteerCommand.cases.Interject.make({
                  ...thread,
                  requestId: RequestId.make("steer-idle-thread"),
                  message: "STEER-NOTE: one more thing",
                  wake: true,
                }),
              })
              yield* waitFor(
                client.session.getSnapshot(thread),
                (current) =>
                  current.runtime._tag === "Idle" &&
                  messageTexts(current.messages).includes("LATER-ANSWER"),
                5_000,
                "the woken turn ran before recovery",
              )
            }),
          )
          const snapshot = yield* deliveredOnNextTurn(harness)
          const text = messageTexts(roundEndMessages(snapshot.messages)).join("")
          expect(text).toContain("START-ANSWER")
          expect(text).not.toContain("LATER-ANSWER")
        }).pipe(Effect.timeout("14 seconds")),
      ),
    16_000,
  )
})

// ── thread guidance ─────────────────────────────────────────────────────────

/**
 * The shipped composition: a cell turn, project instructions in the cwd. The
 * starter starts, from the cell, one delegate thread that denies
 * `deniedTool`. Returns the system blocks of each starter and thread request,
 * once the thread sent its first.
 */
const systemBlocksWithThreadDenying = (deniedTool: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const home = yield* makeTempDirectoryScoped("threads-shared-home-")
    const cwd = yield* makeTempDirectoryScoped("threads-shared-cwd-")
    yield* fs.writeFileString(`${cwd}/AGENTS.md`, "PROJECT-RULE: every agent reads this.")
    const parentBlocks: Array<ReadonlyArray<string>> = []
    const childBlocks: Array<ReadonlyArray<string>> = []
    let parentCalls = 0
    const providerLayer = LanguageModelLayers.testStream((options) => {
      const blocks = turnRequestText(options.prompt).systemBlocks
      if (promptTexts(options.prompt)[0]?.endsWith(childTask) === true) {
        childBlocks.push(blocks)
        return Effect.succeed(reply("pong"))
      }
      parentBlocks.push(blocks)
      parentCalls += 1
      if (parentCalls === 1) {
        const input = `{ task: "${childTask}", agent: "delegate", notify: "starter", tools: ["*", "!${deniedTool}"] }`
        const code = `await tools.thread.start(${input})`
        return Effect.succeed(toolStep("cell", { code }, "cell-start-1"))
      }
      if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
      return Effect.succeed(reply("read it"))
    })
    const harness = yield* createRpcHarness({ ...shippedPreset, providerLayer, cwd, home })
    yield* harness.client.message.send({
      sessionId: harness.sessionId,
      branchId: harness.branchId,
      content: "delegate the ping",
    })
    yield* waitFor(
      Effect.sync(() => childBlocks.length),
      (count) => count > 0,
      8_000,
      "the thread sent its first request",
    )
    return { parentBlocks, childBlocks }
  }).pipe(Effect.provide(BunServices.layer))

describe("thread guidance", () => {
  test("a starter round's text names its final text as the result and keeps session.send for later turns", () => {
    const [source, later, blank, task] = threadRoundText({
      number: 1,
      starter: SessionId.make("parent-1"),
      message: "do it",
      reply: Option.none(),
      notify: "starter",
      place: Option.none(),
    }).split("\n")
    expect(source).toStartWith("Round 1 from session parent-1.")
    expect(source).toContain("Your final text in this turn is the round's result")
    expect(source).toContain("do not also send it with session.send")
    // A question in this turn is the final text too, so the starter is woken once.
    expect(source).toContain("end it with your question as that text")
    // A turn the starter's message starts returns nothing by itself.
    expect(later).toContain(
      'A later turn that is not a round (a wake, a monitor, a goal, a message from that session) returns nothing by itself: send its result or question with session.send to "parent"',
    )
    expect(blank).toBe("")
    expect(task).toBe("do it")
  })

  test("a snapshot thread's round names the copy it works in and the branch its work returns on", () => {
    const lines = threadRoundText({
      number: 2,
      starter: SessionId.make("parent-1"),
      message: "do it",
      reply: Option.none(),
      notify: "starter",
      place: Option.some(
        WorkspacePlace.cases.Copy.make({
          kind: "snapshot",
          name: "copy",
          path: "/nonexistent/copy",
          cwd: "/nonexistent/copy",
          branch: "gent/copy",
          backend: "worktree",
          notes: [],
        }),
      ),
    }).split("\n")
    expect(lines[0]).toStartWith("Round 2 from session parent-1.")
    expect(lines[2]).toContain("private copy of your starter's working tree at /nonexistent/copy")
    expect(lines[2]).toContain("the git branch gent/copy")
    expect(lines.slice(3)).toEqual(["", "do it"])
  })

  test("a path thread's round names its directory and says nothing comes back as a branch", () => {
    const lines = threadRoundText({
      number: 1,
      starter: SessionId.make("parent-1"),
      message: "do it",
      reply: Option.none(),
      notify: "starter",
      place: Option.some(
        WorkspacePlace.cases.Attached.make({
          name: "attached",
          path: "/nonexistent/dir",
          cwd: "/nonexistent/dir",
          notes: [],
        }),
      ),
    }).split("\n")
    expect(lines[2]).toContain("You work in /nonexistent/dir")
    expect(lines[2]).toContain("It is not a copy")
    expect(lines[2]).not.toContain("branch gent/")
  })

  it.live(
    "the starter's prompt says how to use threads; a delegate thread, which cannot start them, does not get it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const parentSystems: Array<string> = []
          const childSystems: Array<string> = []
          const providerLayer = startThenEndWith(
            (options) => {
              childSystems.push(systemTextOf(options.prompt))
              return Effect.succeed(reply("pong"))
            },
            (options) => parentSystems.push(systemTextOf(options.prompt)),
          )
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "delegate the ping")
          yield* afterRoundEnd(harness)
          expect(parentSystems.length).toBeGreaterThan(0)
          expect(childSystems.length).toBeGreaterThan(0)
          const guidance = "Delegate independent, self-contained work to threads"
          for (const text of parentSystems) {
            expect(text).toContain("# Sessions")
            expect(text).toContain(guidance)
          }
          for (const text of childSystems) {
            expect(text).not.toContain(guidance)
            // A delegate thread still asks its starter with session.send.
            expect(text).toContain("# Sessions")
          }
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  // The thread denies session.send, so a section that follows the tool set
  // would differ here if it sat in the shared part.
  it.live(
    "a fresh thread's prompt opens with its starter's shared part, byte for byte, whatever tools it denies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { parentBlocks, childBlocks } = yield* systemBlocksWithThreadDenying("session.send")
          const [parentShared = "", parentOwn = ""] = parentBlocks[0] ?? []
          const [childShared = "", childOwn = ""] = childBlocks[0] ?? []
          // The shared part: persona, project instructions.
          expect(childShared).toBe(parentShared)
          expect(parentShared).toContain("PROJECT-RULE")
          // The agent's own part follows it: the cell guide, the sessions and
          // threads guidance, the host tools.
          const own = ["# Working in the cell", "# Sessions", "## Host Tools"]
          for (const section of own) {
            expect(parentShared).not.toContain(section)
            expect(parentOwn).toContain(section)
          }
          expect(childOwn).not.toContain("# Sessions")
        }).pipe(Effect.timeout("14 seconds")),
      ),
    16_000,
  )

  // The tool list, the tool guidelines and the cell guide follow the tool set,
  // so they are the agent's own part.
  it.live(
    "a fresh thread with other tools than its starter still opens with its starter's shared part",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { parentBlocks, childBlocks } = yield* systemBlocksWithThreadDenying("cell")
          const [parentShared = "", parentOwn = ""] = parentBlocks[0] ?? []
          const [childShared = "", childOwn = ""] = childBlocks[0] ?? []
          expect(childShared).toBe(parentShared)
          expect(parentShared).toContain("PROJECT-RULE")
          // The starter works in the cell; the thread, denied it, calls tools natively.
          expect(parentOwn).toContain("# Working in the cell")
          expect(childOwn).not.toContain("# Working in the cell")
          expect(childOwn).toContain("## Available Tools")
          // Every later step of the starter sends the same shared block.
          for (const blocks of parentBlocks) expect(blocks[0]).toBe(parentShared)
        }).pipe(Effect.timeout("14 seconds")),
      ),
    16_000,
  )
})

// ── a forked thread ─────────────────────────────────────────────────────────

describe("a forked thread", () => {
  it.live(
    "a forked thread starts from the starter's context window, minus the start call still in flight",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const parentContext = "PARENT-CONTEXT: the answer is 42"
          let childPrompt: Option.Option<Prompt.Prompt> = Option.none()
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts.at(-1)?.endsWith(childTask) === true) {
              childPrompt = Option.some(options.prompt)
              return Effect.succeed(reply("42, read from the fork"))
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(
                toolStep("thread.start", delegated(childTask, { fork: true }), "fork-child"),
              )
            }
            if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, parentContext)
          const snapshot = yield* afterRoundEnd(harness)
          expect(messageTexts(snapshot.messages)).toContain("read it")
          const seen = Option.getOrThrow(childPrompt)
          const roundText = threadRoundText({
            number: 1,
            starter: harness.sessionId,
            message: childTask,
            reply: Option.none(),
            notify: "starter",
            place: Option.none(),
          })
          // The thread read the starter's user message, then its round, which names its source.
          expect(promptTexts(seen)).toEqual([parentContext, roundText])
          // The start call had no result when the copy was taken, so the thread never sees it.
          expect(promptToolCallIds(seen)).toEqual([])
          const child = yield* childOf(harness)
          const childSnapshot = yield* harness.client.session.getSnapshot(child)
          expect(messageTexts(childSnapshot.messages)).toContain(parentContext)
          // The round message is typed, so a transcript shows the task, not its frame.
          const typed = childSnapshot.messages.filter(
            (message) => message.metadata?.customType === THREAD_ROUND_TYPE,
          )
          expect(messageTexts(typed)).toEqual([roundText])
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a forked thread with no answer reports neither the starter's reply nor the starter's calls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const parentReply = "PARENT-OWN-REPLY"
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            const calls = promptToolCallIds(options.prompt)
            // The forked thread ends every step without writing anything.
            if (texts.some((text) => text.endsWith(childTask))) {
              return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
            }
            if (texts.at(-1) === "first") {
              if (calls.includes("rn-1")) return Effect.succeed(reply(parentReply))
              return Effect.succeed(toolStep("rename_session", { name: "parent work" }, "rn-1"))
            }
            if (texts.at(-1) === "second: fork a thread") {
              if (calls.includes("fork-empty")) return Effect.succeed(reply("started, ending"))
              return Effect.succeed(
                toolStep("thread.start", delegated(childTask, { fork: true }), "fork-empty"),
              )
            }
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "first")
          yield* idleAfter(harness, parentReply)
          yield* sendPrompt(harness, "second: fork a thread")
          const snapshot = yield* afterRoundEnd(harness)
          const [end] = roundEndMessages(snapshot.messages)
          expect(messageTexts(roundEndMessages(snapshot.messages)).join("")).not.toContain(
            parentReply,
          )
          expect(end?.metadata?.details).toMatchObject({
            unanswered: true,
            tools: [],
            toolCount: 0,
          })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── a snapshot thread ───────────────────────────────────────────────────────

/** One shell command; its trimmed stdout, or a defect that names it. */
const sh = (cwd: string, command: string) =>
  runProcess("sh", ["-c", command], { cwd }).pipe(
    Effect.orDie,
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeed(result.stdout.trim())
      return Effect.die(`${command} exited ${result.exitCode}: ${result.stderr}`)
    }),
  )

describe("a snapshot thread", () => {
  it.live(
    "a snapshot thread works in its own copy, and its round's end names the branch that holds its work",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("threads-snapshot-")
        yield* sh(
          root,
          [
            "mkdir origin && cd origin",
            "git init -q -b main",
            "git config user.name Test",
            "git config user.email test@example.com",
            "printf 'one\\n' > kept.txt",
            "git add -A",
            "git commit -qm init",
          ].join(" && "),
        )
        const origin = yield* sh(`${root}/origin`, "pwd -P")
        const home = yield* makeTempDirectoryScoped("threads-snapshot-home-")
        const roundTexts: Array<string> = []
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const texts = promptTexts(options.prompt)
          if (texts[0]?.endsWith(childTask) === true) {
            roundTexts.push(texts[0])
            if (!promptToolCallIds(options.prompt).includes("write-1")) {
              return Effect.succeed(
                toolStep("write", { path: "child.txt", content: "from the thread\n" }, "write-1"),
              )
            }
            return Effect.succeed(reply("wrote it"))
          }
          if (texts.some(isRoundEndText)) return Effect.succeed(reply("read it"))
          if (!promptToolCallIds(options.prompt).includes("start-1")) {
            return Effect.succeed(
              toolStep(
                "thread.start",
                delegated(childTask, { workspace: { snapshot: true } }),
                "start-1",
              ),
            )
          }
          return Effect.succeed(reply("started"))
        })
        const harness = yield* createRpcHarness({
          ...e2ePreset,
          extensionInputs: [
            ...e2ePreset.extensionInputs.filter(
              (extension) => extension.manifest.id !== WORKSPACES_EXTENSION_ID,
            ),
            makeWorkspacesExtension({ rift: "/nonexistent/gent-test/rift" }),
          ],
          providerLayer,
          cwd: origin,
          home,
        })
        yield* harness.client.message.send({
          sessionId: harness.sessionId,
          branchId: harness.branchId,
          content: "delegate it in a copy",
        })
        const snapshot = yield* waitFor(
          harness.client.session.getSnapshot({
            sessionId: harness.sessionId,
            branchId: harness.branchId,
          }),
          (current) =>
            roundEndMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
          15_000,
          "the snapshot thread's round end woke the starter",
        )
        const thread = (yield* harness.client.session.list()).find(
          (session) => session.parentSessionId === harness.sessionId,
        )
        const copy = thread?.cwd ?? ""
        // The thread works in its copy, not in the starter's tree, and its round says where.
        expect(copy).not.toBe(origin)
        expect(roundTexts[0]).toContain(`private copy of your starter's working tree at ${copy}`)
        expect(yield* sh(copy, "cat child.txt")).toBe("from the thread")
        expect(yield* sh(origin, "ls")).toBe("kept.txt")
        const [end] = roundEndMessages(snapshot.messages)
        const { workspace } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ workspace: Schema.Struct({ branch: Schema.String }) }),
        )(end?.metadata?.details)
        expect(workspace.branch).toBe(`gent/${copy.split("/").at(-1)}`)
        expect(messageTexts([end!])[0]).toContain(`Work: branch ${workspace.branch}`)
        // The origin holds the branch, and the branch holds the thread's work.
        expect(
          yield* sh(origin, `git rev-parse --verify --quiet refs/heads/${workspace.branch}`),
        ).toMatch(/^[0-9a-f]{40}$/)
        expect(yield* sh(origin, `git show ${workspace.branch}:child.txt`)).toBe("from the thread")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
    30_000,
  )
})

// ── session.send ────────────────────────────────────────────────────────────

/**
 * Every session can message another. A starter corrects a thread that is
 * still working: the message joins the thread's running turn and its next
 * model step reads it. A thread asks its starter: the starter wakes and
 * answers. A finished thread is idle, so a later message wakes it for
 * another turn.
 */

const correction = "CORRECTION: only look at src/store"
const question = "QUESTION: which store, sqlite or memory?"

/** Messages another session sent: the envelope names the sender. */
const sessionMessages = <
  M extends {
    readonly parts: ReadonlyArray<Prompt.Part>
    readonly metadata?: { readonly customType?: string; readonly details?: unknown }
  },
>(
  messages: ReadonlyArray<M>,
) =>
  messages.filter((message) =>
    Schema.is(Schema.Struct({ from: Schema.Struct({ relation: Schema.String }) }))(
      message.metadata?.details,
    ),
  )

describe("session.send", () => {
  // The round's text names its starter's id, so a model may address it by id.
  const addresses: ReadonlyArray<readonly [string, (parent: string) => string]> = [
    ["parent", () => "parent"],
    ["the starter's id", (parent) => parent],
  ]
  for (const [addressed, address] of addresses)
    it.live(`a thread's message to ${addressed} lands on the branch that owns the thread`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const report = "CHILD-REPORT: done"
          const parentId = yield* Deferred.make<string>()
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts.some((text) => text.includes("report upward"))) {
              if (!promptToolCallIds(options.prompt).includes("send-up")) {
                return Deferred.await(parentId).pipe(
                  Effect.map((to) => toolStep("session.send", { to, message: report }, "send-up")),
                )
              }
              return Effect.succeed(reply("sent"))
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* Deferred.succeed(parentId, address(sessionId))
          const thread = yield* threadSessionOf(harness)
          // The person moves the starter to another branch while the thread works.
          const other = yield* client.branch.create({ sessionId, name: "elsewhere" })
          yield* client.branch.switch({
            sessionId,
            fromBranchId: branchId,
            toBranchId: other.branchId,
          })
          yield* client.message.send({ ...thread, content: "report upward" })
          const owning = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              sessionMessages(current.messages).some((message) =>
                messageTexts([message]).some((text) => text.includes(report)),
              ),
            5_000,
            "the report reached the branch that owns the thread",
          )
          expect(sessionMessages(owning.messages)).toHaveLength(1)
          const elsewhere = yield* client.session.getSnapshot({
            sessionId,
            branchId: other.branchId,
          })
          expect(sessionMessages(elsewhere.messages)).toHaveLength(0)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    )

  it.live("a starter's message reaches a running thread's next model step", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childStarted = yield* Deferred.make<void>()
        const delivered = yield* Deferred.make<void>()
        const childSawCorrection = yield* Deferred.make<void>()
        let parentCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const texts = promptTexts(options.prompt)
          if (texts[0]?.endsWith(childTask) === true) {
            if (texts.some((text) => text.includes(correction))) {
              return Deferred.succeed(childSawCorrection, void 0).pipe(
                Effect.as(reply("narrowed to src/store")),
              )
            }
            // The thread's first step stays open until the starter's message lands.
            return Deferred.succeed(childStarted, void 0).pipe(
              Effect.andThen(Deferred.await(delivered)),
              Effect.as(reply("first pass done")),
            )
          }
          parentCalls += 1
          if (parentCalls === 1) {
            return Effect.succeed(toolStep("thread.start", delegated(childTask), "bg-child"))
          }
          if (parentCalls === 2) {
            const to = Option.getOrThrow(startedSessionId(options.prompt))
            return Deferred.await(childStarted).pipe(
              Effect.as(toolStep("session.send", { to, message: correction }, "send-1")),
            )
          }
          return Effect.succeed(reply("ack"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { client, sessionId, branchId } = harness
        yield* sendPrompt(harness, "split the work")
        yield* Deferred.await(childStarted)
        // `session.send` returns once the thread's actor has the message, not
        // once it parked it: end the first step only after it waits there.
        const running = yield* childOf(harness)
        yield* waitFor(
          client.queue.get(running),
          (queue) => queue.steering.length === 1,
          3_000,
          "the correction parked in the thread",
        )
        yield* Deferred.succeed(delivered, void 0)
        yield* Deferred.await(childSawCorrection)
        // The starter hears a round once. Its end must carry the answer the
        // thread gave after it read the correction, not the one before.
        const snapshot = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) =>
            messageTexts(roundEndMessages(current.messages)).some((text) =>
              text.includes("narrowed to src/store"),
            ),
          3_000,
          "the round end carried the corrected answer",
        )
        expect(resultsOf("session.send", snapshot.messages)[0]).toMatchObject({
          isFailure: false,
          result: { relation: "child" },
        })
        const child = yield* childOf(harness)
        const childSnapshot = yield* client.session.getSnapshot(child)
        const [received] = sessionMessages(childSnapshot.messages)
        expect(received?.metadata?.details).toMatchObject({
          // The sender names its branch: the one whose interrupt stops a turn the message opens.
          from: { sessionId, branchId, relation: "parent" },
        })
        expect(messageTexts([received!])[0]).toContain("Message from your parent")
      }).pipe(Effect.timeout("6 seconds")),
    ),
  )

  it.live(
    "a thread's question wakes its idle starter, who answers in a turn of its own",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let parentCalls = 0
          let childCalls = 0
          const answered = yield* Deferred.make<void>()
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              childCalls += 1
              if (childCalls === 1) {
                return Effect.succeed(
                  toolStep("session.send", { to: "parent", message: question }, "ask-parent"),
                )
              }
              return Effect.succeed(reply("pong"))
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("thread.start", delegated(childTask), "bg-child"))
            }
            if (texts.some((text) => text.includes(question))) {
              return Deferred.succeed(answered, void 0).pipe(Effect.as(reply("ANSWER: sqlite")))
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "split the work")
          // The model serves the answer once the question reached the starter;
          // the poll then waits only for the answer's write.
          yield* Deferred.await(answered)
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              messageTexts(current.messages).some((text) => text.includes("ANSWER: sqlite")),
            10_000,
            "the starter answered the thread's question",
          )
          const [asked] = sessionMessages(snapshot.messages)
          expect(asked?.metadata?.details).toMatchObject({ from: { relation: "child" } })
          expect(messageTexts([asked!])[0]).toContain("Message from your child")
          // A question mid-turn must not read as the round's end.
          expect(messageTexts([asked!])[0]).toContain("this message is not one")
          // The question was a turn of its own: the starter's last user text before the answer.
          const texts = messageTexts(snapshot.messages)
          expect(texts.indexOf(texts.find((t) => t.includes(question))!)).toBeLessThan(
            texts.indexOf("ANSWER: sqlite"),
          )
          const child = yield* childOf(harness)
          const childSnapshot = yield* client.session.getSnapshot(child)
          expect(resultsOf("session.send", childSnapshot.messages)[0]).toMatchObject({
            isFailure: false,
            result: { sessionId, relation: "parent" },
          })
          // A deadlock bound only: the waits above are events, not deadlines.
        }).pipe(Effect.timeout("20 seconds")),
      ),
    30_000,
  )

  it.live(
    "a message to a finished thread wakes it for another turn, and ends no second round",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let parentCalls = 0
          let childCalls = 0
          const childAnsweredTwice = yield* Deferred.make<void>()
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              childCalls += 1
              if (childCalls === 1) return Effect.succeed(reply("done"))
              return Deferred.succeed(childAnsweredTwice, void 0).pipe(
                Effect.as(reply("done again")),
              )
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("thread.start", delegated(childTask), "bg-done"))
            }
            // The round end has arrived once the starter is asked again.
            if (
              texts.some(isRoundEndText) &&
              !promptToolCallIds(options.prompt).includes("send-late")
            ) {
              const to = Option.getOrThrow(startedSessionId(options.prompt))
              return Effect.succeed(
                toolStep("session.send", { to, message: correction }, "send-late"),
              )
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "split the work")
          yield* Deferred.await(childAnsweredTwice)
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => resultsOf("session.send", current.messages).length === 1,
            3_000,
            "the late send returned a result",
          )
          expect(resultsOf("session.send", snapshot.messages)[0]).toMatchObject({
            isFailure: false,
            result: { relation: "child" },
          })
          // One round end per round: the thread's second turn is no round.
          expect(roundEndMessages(snapshot.messages)).toHaveLength(1)
        }).pipe(Effect.timeout("6 seconds")),
      ),
  )

  it.live("a session with no parent cannot address `parent`", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const providerLayer = LanguageModelLayers.testStream((options) => {
          if (promptToolCallIds(options.prompt).includes("no-parent")) {
            return Effect.succeed(reply("ok"))
          }
          return Effect.succeed(
            toolStep("session.send", { to: "parent", message: "hello?" }, "no-parent"),
          )
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { client, sessionId, branchId } = harness
        yield* sendPrompt(harness, "ask upward")
        const snapshot = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) => resultsOf("session.send", current.messages).length === 1,
          3_000,
          "the send returned a result",
        )
        expect(resultsOf("session.send", snapshot.messages)[0]).toMatchObject({
          isFailure: true,
          result: { error: expect.stringContaining("no parent") },
        })
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

// ── a starter's interrupt and its session.send turns ───────────────────────

/**
 * A starter's session.send can open a turn in a thread whose round has ended,
 * so no round owns it. The live run showed one such turn still running after
 * the user's Ctrl-C. The sender owns it: its interrupted turn stops that
 * turn, takes back a message no step has read, and tells its next turn which
 * thread it stopped.
 */

const idle = (harness: Harness, target: BranchRef, label: string) =>
  waitFor(
    harness.client.session.getSnapshot(target),
    (current) => current.runtime._tag === "Idle",
    3_000,
    label,
  )

/**
 * Holds the end of a turn in the `held` session open until `release`. Hooks
 * run in id order, and this id sorts before every shipped extension's, so no
 * shipped hook has read the turn's end while it is held.
 */
const holdTurnEnd = (options: {
  readonly held: Ref.Ref<Option.Option<SessionId>>
  readonly ending: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}) => ({
  ...defineExtension({
    id: "0-turn-end-hold",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.on("turnAfter", (input) =>
        Effect.gen(function* () {
          if (!Option.contains(yield* Ref.get(options.held), input.sessionId)) return
          yield* Deferred.succeed(options.ending, void 0)
          yield* Deferred.await(options.release)
        }),
      )
    }),
  }),
  artifactIdentity: LoadedArtifactIdentity.make("turn-end-hold-source"),
})

type StarterRequest = { readonly notices: string; readonly last: string }

/**
 * The starter: start one delegate thread, end the turn, and on the round's
 * end send the thread the correction, then keep its own turn open.
 * `beforeSend` holds the send until a test has the thread where it wants it.
 */
const correctFinishedThread = (options: {
  readonly child: (texts: ReadonlyArray<string>) => ModelReply
  readonly parentStreaming: Deferred.Deferred<void>
  readonly beforeSend?: Effect.Effect<void>
  readonly parentRequests: Array<StarterRequest>
}) =>
  LanguageModelLayers.testStream((request) => {
    const texts = promptTexts(request.prompt)
    if (texts[0]?.endsWith(childTask) === true) return options.child(texts)
    const last = texts.at(-1) ?? ""
    options.parentRequests.push({ notices: noticeText(request.prompt), last })
    const ids = promptToolCallIds(request.prompt)
    if (last.startsWith("NEXT-")) return Effect.succeed(reply("ack"))
    if (!ids.includes("start-1")) {
      return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
    }
    if (!texts.some(isRoundEndText)) return Effect.succeed(reply("started, ending my turn"))
    if (!ids.includes("send-fix")) {
      const to = Option.getOrThrow(startedSessionId(request.prompt))
      return (options.beforeSend ?? Effect.void).pipe(
        Effect.as(toolStep("session.send", { to, message: correction }, "send-fix")),
      )
    }
    return Effect.succeed(stalledStream("waiting on the thread", options.parentStreaming))
  })

/** The starter's `NEXT-…` turn: sent, answered, and the request it made. */
const nextTurn = (harness: Harness, requests: ReadonlyArray<StarterRequest>, content: string) =>
  Effect.gen(function* () {
    const before = requests.filter((request) => request.last.startsWith("NEXT-")).length
    yield* sendPrompt(harness, content)
    yield* waitFor(
      harness.client.session.getSnapshot({
        sessionId: harness.sessionId,
        branchId: harness.branchId,
      }),
      (current) =>
        current.runtime._tag === "Idle" &&
        messageTexts(current.messages).filter((text) => text === "ack").length === before + 1,
      3_000,
      `the starter answered ${content}`,
    )
    return requests.find((request) => request.last === content)
  })

/**
 * A starter whose second request sends a correction to the thread it just
 * started, while that thread's round still runs, then keeps its turn open.
 * `correcting` answers the thread's turn that reads the correction.
 */
const correctRunningThread = (options: {
  readonly childStreaming: Deferred.Deferred<void>
  readonly parentStreaming: Deferred.Deferred<void>
  readonly parentRequests: Array<StarterRequest>
  readonly correcting: () => ModelReply
}) => {
  let parentCalls = 0
  return LanguageModelLayers.testStream((request) => {
    const texts = promptTexts(request.prompt)
    if (texts[0]?.endsWith(childTask) === true) {
      if (texts.some((text) => text.includes(correction))) return options.correcting()
      // The thread's first turn never reaches a step boundary, so the
      // correction waits in its queue.
      return Effect.succeed(stalledStream("working", options.childStreaming))
    }
    const last = texts.at(-1) ?? ""
    options.parentRequests.push({ notices: noticeText(request.prompt), last })
    if (last.startsWith("NEXT-")) return Effect.succeed(reply("ack"))
    parentCalls += 1
    if (parentCalls === 1) {
      return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
    }
    if (parentCalls === 2) {
      const to = Option.getOrThrow(startedSessionId(request.prompt))
      return Effect.succeed(toolStep("session.send", { to, message: correction }, "send-fix"))
    }
    return Effect.succeed(stalledStream("waiting on the thread", options.parentStreaming))
  })
}

describe("a starter's interrupt and the turns its session.send opened", () => {
  it.live(
    "stops the turn a correction opened in a finished thread, and the next turn names that thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childCorrecting = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const parentRequests: Array<StarterRequest> = []
          const providerLayer = correctFinishedThread({
            parentStreaming,
            parentRequests,
            child: (texts) => {
              if (texts.some((text) => text.includes(correction))) {
                return Effect.succeed(stalledStream("correcting", childCorrecting))
              }
              return Effect.succeed(reply("pong"))
            },
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { sessionId, branchId } = harness
          yield* sendPrompt(harness, "split the work")
          yield* Deferred.await(childCorrecting)
          yield* Deferred.await(parentStreaming)
          const child = yield* childOf(harness)
          yield* interruptStarter(harness, "interrupt-starter-of-corrected-thread")

          const receipts = yield* waitFor(
            turnReceipts(harness, child),
            (current) => current.length === 2,
            3_000,
            "the starter's interrupt ended the thread's correction turn",
          )
          expect(receipts[1]).toMatchObject({ interrupted: true })
          yield* idle(harness, child, "the thread is idle")
          yield* idle(harness, { sessionId, branchId }, "the starter is idle")

          const next = yield* nextTurn(harness, parentRequests, "NEXT-WHAT-IS-RUNNING")
          expect(next?.notices).toContain(child.sessionId)
          expect(next?.notices).toContain("session.send")

          // The answered turn read the notice; the turn after it does not see it.
          const after = yield* nextTurn(harness, parentRequests, "NEXT-AND-NOW")
          expect(after?.notices ?? "").not.toContain(child.sessionId)
        }).pipe(Effect.timeout("12 seconds")),
      ),
    14_000,
  )

  it.live(
    "a correction that still waits in a running thread at the interrupt never runs, and the thread is named once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childStreaming = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const parentRequests: Array<StarterRequest> = []
          let correctionRuns = 0
          const providerLayer = correctRunningThread({
            childStreaming,
            parentStreaming,
            parentRequests,
            correcting: () => {
              correctionRuns += 1
              return Effect.succeed(reply("corrected"))
            },
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate one task")
          yield* Deferred.await(childStreaming)
          yield* Deferred.await(parentStreaming)
          const child = yield* childOf(harness)
          yield* interruptStarter(harness, "interrupt-starter-with-waiting-correction")
          yield* waitFor(
            turnReceipts(harness, child),
            (current) => current.length >= 1,
            3_000,
            "the starter's interrupt ended the thread's round turn",
          )
          yield* idle(harness, child, "the thread is idle")
          yield* idle(harness, { sessionId, branchId }, "the starter is idle")
          expect(correctionRuns).toBe(0)
          expect(yield* turnReceipts(harness, child)).toHaveLength(1)

          const next = yield* nextTurn(harness, parentRequests, "NEXT-WHAT-IS-RUNNING")
          // The round's stop names the thread; the correction went with its turn.
          expect(next?.notices).toContain("# Stopped threads")
          expect(next?.notices).not.toContain("# Stopped child turns")
          expect(next?.notices.split(child.sessionId)).toHaveLength(2)
          // A whole starter turn later the correction has still not run in the thread.
          expect(correctionRuns).toBe(0)
          expect(yield* turnReceipts(harness, child)).toHaveLength(1)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  // Threads and session.send's sent turns share one extension, whose hook
  // stops the starter's rounds before it stops its sent turns: no hook can
  // run between the two. The stop waits for the round's turn to end, and the
  // correction goes with it, before the sent-turn stop looks at the thread.
  it.live(
    "a correction waiting in a thread the interrupt stopped goes with its turn, before the sent-turn stop runs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childStreaming = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const correctionStreaming = yield* Deferred.make<void>()
          const parentRequests: Array<StarterRequest> = []
          let correctionRuns = 0
          const providerLayer = correctRunningThread({
            childStreaming,
            parentStreaming,
            parentRequests,
            // A correction that ran would hold the thread's turn open.
            correcting: () => {
              correctionRuns += 1
              return Effect.succeed(stalledStream("correcting", correctionStreaming))
            },
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate one task")
          yield* Deferred.await(childStreaming)
          yield* Deferred.await(parentStreaming)
          const child = yield* childOf(harness)
          yield* interruptStarter(harness, "interrupt-starter-before-the-send-stop")
          yield* idle(harness, { sessionId, branchId }, "the starter is idle")
          // The starter's interrupt has ended; the thread runs no turn for the correction.
          const thread = yield* idle(harness, child, "the thread is idle")
          expect(thread.runtime._tag).toBe("Idle")
          expect(correctionRuns).toBe(0)

          const next = yield* nextTurn(harness, parentRequests, "NEXT-WHAT-IS-RUNNING")
          expect(next?.notices).toContain("# Stopped threads")
          expect(next?.notices).not.toContain("# Stopped child turns")
          expect(next?.notices.split(child.sessionId)).toHaveLength(2)
          expect(correctionRuns).toBe(0)
        }).pipe(Effect.timeout("12 seconds")),
      ),
    14_000,
  )

  it.live("a correction turn that ended before the interrupt is not named as stopped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parentStreaming = yield* Deferred.make<void>()
        const parentRequests: Array<StarterRequest> = []
        const providerLayer = correctFinishedThread({
          parentStreaming,
          parentRequests,
          child: (texts) => {
            if (texts.some((text) => text.includes(correction))) {
              return Effect.succeed(reply("corrected"))
            }
            return Effect.succeed(reply("pong"))
          },
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { sessionId, branchId } = harness
        yield* sendPrompt(harness, "split the work")
        yield* Deferred.await(parentStreaming)
        const child = yield* childOf(harness)
        yield* waitFor(
          turnReceipts(harness, child),
          (current) => current.length === 2,
          3_000,
          "the thread answered the correction",
        )
        yield* idle(harness, child, "the thread is idle")
        yield* interruptStarter(harness, "interrupt-starter-after-correction-ended")
        yield* idle(harness, { sessionId, branchId }, "the starter is idle")

        const next = yield* nextTurn(harness, parentRequests, "NEXT-WHAT-IS-RUNNING")
        expect(next?.notices ?? "").not.toContain(child.sessionId)
        expect(yield* turnReceipts(harness, child)).toHaveLength(2)
      }).pipe(Effect.timeout("10 seconds")),
    ),
  )

  it.live(
    "a correction turn the user already stopped is not named as stopped by the starter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childCorrecting = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const childEnding = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const held = yield* Ref.make(Option.none<SessionId>())
          const parentRequests: Array<StarterRequest> = []
          const providerLayer = correctFinishedThread({
            parentStreaming,
            parentRequests,
            child: (texts) => {
              if (texts.some((text) => text.includes(correction))) {
                return Effect.succeed(stalledStream("correcting", childCorrecting))
              }
              return Effect.succeed(reply("pong"))
            },
          })
          const harness = yield* harnessWithHome(providerLayer, {
            fixtures: [holdTurnEnd({ held, ending: childEnding, release })],
          })
          const { sessionId, branchId } = harness
          yield* sendPrompt(harness, "split the work")
          yield* Deferred.await(childCorrecting)
          yield* Deferred.await(parentStreaming)
          const child = yield* childOf(harness)
          yield* Ref.set(held, Option.some(child.sessionId))
          // The user stops the thread's correction turn first; its end is held
          // open while the starter is interrupted.
          yield* harness.client.steer.command({
            command: SteerCommand.cases.Cancel.make({
              ...child,
              requestId: RequestId.make("interrupt-thread-before-starter"),
            }),
          })
          yield* Deferred.await(childEnding)
          yield* interruptStarter(harness, "interrupt-starter-after-user-stopped-thread")
          yield* idle(harness, { sessionId, branchId }, "the starter is idle")
          yield* Deferred.succeed(release, void 0)
          yield* idle(harness, child, "the thread is idle")
          const receipts = yield* turnReceipts(harness, child)
          expect(receipts[1]).toMatchObject({ interrupted: true })

          const next = yield* nextTurn(harness, parentRequests, "NEXT-WHAT-IS-RUNNING")
          expect(next).toBeDefined()
          expect(next?.notices ?? "").not.toContain(child.sessionId)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a turn a user opened in the thread keeps running, and the waiting correction is taken back",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userTurnOpen = yield* Deferred.make<void>()
          const userGate = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const parentRequests: Array<StarterRequest> = []
          let correctionRuns = 0
          const providerLayer = correctFinishedThread({
            parentStreaming,
            parentRequests,
            // The starter sends only once the user's turn in the thread is open.
            beforeSend: Deferred.await(userTurnOpen),
            child: (texts) => {
              if (texts.some((text) => text.includes(correction))) {
                correctionRuns += 1
                return Effect.succeed(reply("corrected"))
              }
              if (texts.at(-1) === "USER-ASKS-THREAD") {
                return Deferred.succeed(userTurnOpen, void 0).pipe(
                  Effect.andThen(Deferred.await(userGate)),
                  Effect.as(reply("answered the user")),
                )
              }
              return Effect.succeed(reply("pong"))
            },
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "split the work")
          const child = yield* childOf(harness)
          yield* waitFor(
            turnReceipts(harness, child),
            (current) => current.length === 1,
            3_000,
            "the thread's round ended",
          )
          yield* idle(harness, child, "the thread is idle")
          yield* harness.client.message.send({ ...child, content: "USER-ASKS-THREAD" })
          yield* Deferred.await(parentStreaming)
          yield* interruptStarter(harness, "interrupt-starter-while-user-drives-thread")
          yield* idle(harness, harness, "the starter is idle")

          const running = yield* harness.client.session.getSnapshot(child)
          expect(running.runtime._tag).toBe("Running")
          expect(yield* turnReceipts(harness, child)).toHaveLength(1)

          yield* Deferred.succeed(userGate, void 0)
          yield* idle(harness, child, "the user's turn in the thread ended")
          const receipts = yield* turnReceipts(harness, child)
          expect(receipts).toHaveLength(2)
          expect(receipts[1]?.interrupted).not.toBe(true)
          expect(correctionRuns).toBe(0)
        }).pipe(Effect.timeout("10 seconds")),
      ),
  )

  it.live(
    "a correction taken back from a thread turn the user already stops is named to the starter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userTurnOpen = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const childEnding = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const held = yield* Ref.make(Option.none<SessionId>())
          const parentRequests: Array<StarterRequest> = []
          let correctionRuns = 0
          const providerLayer = correctFinishedThread({
            parentStreaming,
            parentRequests,
            // The starter sends only once the user's turn in the thread is open.
            beforeSend: Deferred.await(userTurnOpen),
            child: (texts) => {
              if (texts.some((text) => text.includes(correction))) {
                correctionRuns += 1
                return Effect.succeed(reply("corrected"))
              }
              // The user's turn never reaches a step boundary, so the
              // correction waits in its queue.
              if (texts.at(-1) === "USER-ASKS-THREAD") {
                return Effect.succeed(stalledStream("answering the user", userTurnOpen))
              }
              return Effect.succeed(reply("pong"))
            },
          })
          const harness = yield* harnessWithHome(providerLayer, {
            fixtures: [holdTurnEnd({ held, ending: childEnding, release })],
          })
          const { sessionId, branchId } = harness
          yield* sendPrompt(harness, "split the work")
          const child = yield* childOf(harness)
          yield* waitFor(
            turnReceipts(harness, child),
            (current) => current.length === 1,
            3_000,
            "the thread's round ended",
          )
          yield* idle(harness, child, "the thread is idle")
          yield* harness.client.message.send({ ...child, content: "USER-ASKS-THREAD" })
          yield* Deferred.await(parentStreaming)
          // `session.send` returns once the thread's actor has the
          // correction, not once it parked it.
          yield* waitFor(
            harness.client.queue.get(child),
            (queue) => queue.steering.length === 1,
            3_000,
            "the correction parked in the thread",
          )
          yield* Ref.set(held, Option.some(child.sessionId))
          // The user stops the thread's turn; its end is held open, so the
          // correction still waits to join a turn that is stopping.
          yield* harness.client.steer.command({
            command: SteerCommand.cases.Cancel.make({
              ...child,
              requestId: RequestId.make("user-stops-thread-with-correction-waiting"),
            }),
          })
          yield* Deferred.await(childEnding)
          yield* interruptStarter(harness, "interrupt-starter-takes-correction-back")
          yield* idle(harness, { sessionId, branchId }, "the starter is idle")
          yield* Deferred.succeed(release, void 0)
          yield* idle(harness, child, "the thread is idle")
          expect(correctionRuns).toBe(0)

          const next = yield* nextTurn(harness, parentRequests, "NEXT-WHAT-IS-RUNNING")
          // The user's stop is the thread's own news; the lost correction is the starter's.
          expect(next?.notices).toContain("# Stopped child turns")
          expect(next?.notices.split(child.sessionId)).toHaveLength(2)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── a starter's interrupt as a thread finishes ──────────────────────────────

describe("a starter's interrupt as a thread finishes", () => {
  it.live(
    "a round whose turn completed before the interrupt's stop reached it still wakes the starter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childGo = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const childEnding = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const held = yield* Ref.make(Option.none<SessionId>())
          const parentRequests: Array<StarterRequest> = []
          const providerLayer = LanguageModelLayers.testStream((request) => {
            const texts = promptTexts(request.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              return Deferred.await(childGo).pipe(Effect.as(reply("pong")))
            }
            parentRequests.push({ notices: noticeText(request.prompt), last: texts.at(-1) ?? "" })
            if (parentRequests.length === 1) {
              return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
            }
            if (parentRequests.length === 2) {
              return Effect.succeed(stalledStream("waiting on the thread", parentStreaming))
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer, {
            fixtures: [holdTurnEnd({ held, ending: childEnding, release })],
          })
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate one task")
          yield* Deferred.await(parentStreaming)
          const child = yield* childOf(harness)
          yield* Ref.set(held, Option.some(child.sessionId))
          yield* Deferred.succeed(childGo, void 0)
          // The thread's turn completed and its receipt is stored; its end is
          // held open before the threads hook reads it.
          yield* Deferred.await(childEnding)
          yield* interruptStarter(harness, "interrupt-starter-as-thread-finishes")
          // The starter's interrupt has run its cascade: the starter is idle,
          // or the round's end already woke it.
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" || roundEndMessages(current.messages).length > 0,
            3_000,
            "the starter's interrupt ran its cascade",
          )
          yield* Deferred.succeed(release, void 0)
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              roundEndMessages(current.messages).length === 1 &&
              messageTexts(current.messages).includes("ack"),
            5_000,
            "the round's end woke the starter and the starter read it",
          )
          const [row] = yield* waitFor(
            roundsOf(harness.sql),
            (rows) => rows[0]?.delivered === 1,
            3_000,
            "the round is delivered",
          )
          // The round completed: no stop notice names it.
          expect(row).toMatchObject({ interrupted: 0, stop_noticed: 0 })
          const woken = parentRequests.at(-1)
          expect(woken?.last).toContain("pong")
          expect(woken?.notices ?? "").not.toContain("# Stopped threads")
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a thread whose own round end fails to record still stops the rounds it started",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const middleTask = "MIDDLE-TASK: delegate the ping"
          const grandchildStreaming = yield* Deferred.make<void>()
          const middleStreaming = yield* Deferred.make<void>()
          const providerLayer = LanguageModelLayers.testStream((request) => {
            const texts = promptTexts(request.prompt)
            const ids = promptToolCallIds(request.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              return Effect.succeed(stalledStream("working", grandchildStreaming))
            }
            if (texts[0]?.endsWith(middleTask) === true) {
              if (!ids.includes("start-g")) {
                return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-g"))
              }
              return Effect.succeed(stalledStream("waiting on the thread", middleStreaming))
            }
            if (!ids.includes("start-m")) {
              // The middle thread runs the default agent, which may start threads.
              return Effect.succeed(
                toolStep("thread.start", { task: middleTask, notify: "starter" }, "start-m"),
              )
            }
            return Effect.succeed(reply("started"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId } = harness
          yield* sendPrompt(harness, "start the middle")
          yield* Deferred.await(grandchildStreaming)
          yield* Deferred.await(middleStreaming)
          const sessions = yield* client.session.list()
          const middle = sessions.find((session) => session.parentSessionId === sessionId)
          const grandchild = sessions.find(
            (session) => Predicate.isNotUndefined(middle) && session.parentSessionId === middle.id,
          )
          if (
            Predicate.isUndefined(middle?.activeBranchId) ||
            Predicate.isUndefined(grandchild?.activeBranchId)
          ) {
            return yield* Effect.die("no middle or grandchild session")
          }
          // The middle thread's own round end cannot be recorded.
          yield* execute(
            harness.sql,
            `CREATE TRIGGER refuse_middle_end BEFORE UPDATE OF ended_at ON thread_rounds WHEN OLD.session_id = '${middle.id}' BEGIN SELECT RAISE(ABORT, 'middle end refused'); END`,
          )
          yield* client.steer.command({
            command: SteerCommand.cases.Cancel.make({
              sessionId: middle.id,
              branchId: middle.activeBranchId,
              requestId: RequestId.make("interrupt-middle"),
            }),
          })
          const target = { sessionId: grandchild.id, branchId: grandchild.activeBranchId }
          const receipts = yield* waitFor(
            turnReceipts(harness, target),
            (current) => current.length === 1,
            3_000,
            "the middle thread's interrupt stopped its own thread",
          )
          expect(receipts[0]).toMatchObject({ interrupted: true })
          const rows = yield* waitFor(
            roundsOf(harness.sql),
            (current) => current.find((row) => row.session_id === grandchild.id)?.ended === 1,
            3_000,
            "the stopped round's end is recorded",
          )
          expect(rows.find((row) => row.session_id === middle.id)?.ended).toBe(0)
          expect(rows.find((row) => row.session_id === grandchild.id)).toMatchObject({
            interrupted: 1,
            stopped: 1,
          })
          yield* execute(harness.sql, "DROP TRIGGER refuse_middle_end")
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── a delegate thread's later turn ──────────────────────────────────────────

/**
 * Only a round's own turn returns as its end. A thread that arms a wake, a
 * monitor or a goal runs later turns nobody waits for, so its round's text
 * tells it to send each later result to its starter with session.send.
 */
describe("a delegate thread's later turn", () => {
  it.live(
    "a delegate thread that arms a wake ends its round, and the wake's result reaches the starter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const laterResult = "CHILD-LATER: CI is green"
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              const ids = promptToolCallIds(options.prompt)
              if (!ids.includes("arm-wake")) {
                return Effect.succeed(
                  toolStep("wake", { afterSeconds: 0.2, note: "WAKE-NOTE: check CI" }, "arm-wake"),
                )
              }
              if (!texts.some((text) => text.includes("WAKE-NOTE"))) {
                return Effect.succeed(reply("armed a wake for CI"))
              }
              // The wake's turn: a model that follows its round sends the result upward.
              const told = texts[0].includes("A later turn that is not a round")
              if (told && !ids.includes("send-later")) {
                return Effect.succeed(
                  toolStep("session.send", { to: "parent", message: laterResult }, "send-later"),
                )
              }
              return Effect.succeed(reply("checked CI"))
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("thread.start", delegated(childTask), "wake-child"))
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate the CI watch")
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              sessionMessages(current.messages).some((message) =>
                messageTexts([message]).some((text) => text.includes(laterResult)),
              ),
            6_000,
            "the thread's later result reached the starter",
          )
          // The round's end came first, at the end of the turn that armed the wake.
          const [end] = roundEndMessages(snapshot.messages)
          expect(messageTexts([end!])[0]).toContain("armed a wake for CI")
          const [later] = sessionMessages(snapshot.messages)
          expect(later?.metadata?.details).toMatchObject({ from: { relation: "child" } })
          expect(snapshot.messages.indexOf(end!)).toBeLessThan(snapshot.messages.indexOf(later!))
          // The round's end already landed: the later message must not promise one.
          const laterText = messageTexts([later!])[0] ?? ""
          expect(laterText).not.toContain("still running")
          expect(laterText).toContain("round-end message; this message is not one")
          expect(roundEndMessages(snapshot.messages)).toHaveLength(1)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── a round's turn with runtime lines ───────────────────────────────────────

/**
 * The loop writes user-role lines inside a turn: a continuation after an
 * empty or cut-off step, the max-steps instruction before the last step, a
 * model-change notice, and a mid-turn compaction marker. None opens a turn,
 * so the round's end reads past them to the thread's real answer.
 */

/** A starter that starts one delegate thread, and a thread scripted step by step. */
const scriptedThread = (childStep: (call: number) => ReturnType<typeof reply>) => {
  let parentCalls = 0
  let childCalls = 0
  return LanguageModelLayers.testStream((options) => {
    const texts = promptTexts(options.prompt)
    if (texts[0]?.endsWith(childTask) === true) {
      childCalls += 1
      return Effect.succeed(childStep(childCalls))
    }
    parentCalls += 1
    if (parentCalls === 1) {
      return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
    }
    return Effect.succeed(reply("ack"))
  })
}

const roundEndText = (harness: Harness) =>
  afterRoundEnd(harness).pipe(
    Effect.map((snapshot) => {
      const [end] = roundEndMessages(snapshot.messages)
      return { text: messageTexts([end!]).join(""), details: end?.metadata?.details }
    }),
  )

describe("a round's turn with runtime lines", () => {
  it.live(
    "an empty first step and its continuation still return the thread's answer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* harnessWithHome(
            scriptedThread((call) => {
              if (call === 1) return Stream.make(finishPart({ finishReason: "stop" }))
              return reply("CHILD-FINAL-ANSWER")
            }),
          )
          yield* sendPrompt(harness, "delegate this task")
          const { text } = yield* roundEndText(harness)
          expect(text).toContain(`(agent ${DELEGATE_AGENT_NAME}) round 1 completed.`)
          expect(text).toContain("CHILD-FINAL-ANSWER")
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a step cut off at the output limit returns the continued text",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* harnessWithHome(
            scriptedThread((call) => {
              if (call === 1) {
                return Stream.fromIterable([
                  textDeltaPart("PART-ONE"),
                  finishPart({ finishReason: "length" }),
                ])
              }
              return reply("PART-TWO")
            }),
          )
          yield* sendPrompt(harness, "delegate this task")
          const { text } = yield* roundEndText(harness)
          expect(text).toContain("PART-TWO")
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "the max-steps instruction before the last step keeps that step's answer and calls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* harnessWithHome(
            scriptedThread((call) => {
              if (call === 1) {
                return toolStep("read", { path: "/tmp/no-such-file-for-a-child" }, "child-read")
              }
              return reply("ANSWER-AT-BUDGET")
            }),
            // The delegate agent's step budget comes from config, as a start has no overrides.
            { config: new UserConfig({ agents: { [DELEGATE_AGENT_NAME]: { maxSteps: 2 } } }) },
          )
          yield* sendPrompt(harness, "delegate this task")
          const { text, details } = yield* roundEndText(harness)
          expect(text).toContain("ANSWER-AT-BUDGET")
          expect(details).toMatchObject({ toolCount: 1 })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── a restart mid-round ─────────────────────────────────────────────────────

/**
 * Two processes over one file database and one home: the first stops while
 * its threads run, the second is the restarted server. Each process lives in
 * its own scope.
 */
const restartableHome = Effect.gen(function* () {
  const home = yield* makeTempDirectoryScoped("threads-restart-")
  const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
  const storagePath = `${home}/gent.db`
  const layerFor = (providerLayer: Parameters<typeof createRpcHarness>[0]["providerLayer"]) =>
    createE2ELayer({ ...e2ePreset, providerLayer, storagePath, cwd, home })
  return { layerFor, sql: sqlAt(storagePath) }
})

type RestartableHome = Effect.Success<typeof restartableHome>

/**
 * First process: the starter starts one delegate thread per task and ends its
 * turn. Every thread's model call hangs, so the process stops with all of
 * them mid-turn. Returns the starter once each thread is running and the
 * starter is idle.
 */
const stopWithRunningThreads = (home: RestartableHome, tasks: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const running = yield* Deferred.make<void>()
      let childCalls = 0
      let parentCalls = 0
      const providerLayer = LanguageModelLayers.testStream((options) => {
        const texts = promptTexts(options.prompt)
        if (tasks.some((task) => texts[0]?.endsWith(task) === true)) {
          childCalls += 1
          if (childCalls < tasks.length) return Effect.never
          return Deferred.succeed(running, void 0).pipe(Effect.andThen(Effect.never))
        }
        parentCalls += 1
        if (parentCalls > 1) return Effect.succeed(reply("started, ending my turn"))
        return Effect.succeed(
          Stream.fromIterable([
            ...tasks.map((task, index) =>
              toolCallPart("thread.start", delegated(task), {
                toolCallId: ToolCallId.make(`start-${index + 1}`),
              }),
            ),
            finishPart({ finishReason: "tool-calls" }),
          ]),
        )
      })
      const { client } = yield* createRpcClient(home.layerFor(providerLayer))
      const created = yield* client.session.create({})
      const starter = { sessionId: created.sessionId, branchId: created.branchId }
      yield* client.message.send({ ...starter, content: "delegate these" })
      yield* Deferred.await(running)
      yield* waitFor(
        client.session.getSnapshot(starter),
        (current) =>
          current.runtime._tag === "Idle" &&
          messageTexts(current.messages).includes("started, ending my turn"),
        5_000,
        "the starter ended its turn with its threads running",
      )
      return starter
    }),
  )

describe("a delegate thread running when the server stopped", () => {
  it.live(
    "a delegate thread running when the server stopped resumes when its starter opens, and its end wakes the starter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          const starter = yield* stopWithRunningThreads(home, [childTask])
          const [stuck] = yield* roundsOf(home.sql)
          expect(stuck).toMatchObject({ ended: 0, delivered: 0 })

          const providerLayer = LanguageModelLayers.testStream((options) => {
            if (promptTexts(options.prompt)[0]?.endsWith(childTask) === true) {
              return Effect.succeed(reply("pong"))
            }
            return Effect.succeed(reply("read it"))
          })
          const { client } = yield* createRpcClient(home.layerFor(providerLayer))
          const snapshot = yield* waitFor(
            client.session.getSnapshot(starter),
            (current) =>
              roundEndMessages(current.messages).length === 1 &&
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).includes("read it"),
            8_000,
            "the resumed thread's round end woke the starter",
          )
          expect(messageTexts(roundEndMessages(snapshot.messages)).join("\n")).toContain("pong")
          const [row] = yield* waitFor(
            roundsOf(home.sql),
            (rows) => rows[0]?.delivered === 1,
            3_000,
            "the resumed round is delivered",
          )
          expect(row).toMatchObject({ interrupted: 0, ended: 1 })
        }).pipe(Effect.timeout("20 seconds")),
      ),
    25_000,
  )

  it.live(
    "delegate threads running when the server stopped resume, end, and free their places under the cap",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          const tasks = [1, 2, 3, 4].map((n) => `CHILD-TASK-${n}: reply with pong`)
          const starter = yield* stopWithRunningThreads(home, tasks)
          const stuck = yield* roundsOf(home.sql)
          expect(stuck.filter((row) => row.ended === 0)).toHaveLength(4)

          const fifth = "CHILD-TASK-5: reply with pong"
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if ([...tasks, fifth].some((task) => texts[0]?.endsWith(task) === true)) {
              return Effect.succeed(reply("pong"))
            }
            const asked = texts.includes("START-FIFTH")
            if (asked && !promptToolCallIds(options.prompt).includes("start-5")) {
              return Effect.succeed(toolStep("thread.start", delegated(fifth), "start-5"))
            }
            return Effect.succeed(reply("read it"))
          })
          const { client } = yield* createRpcClient(home.layerFor(providerLayer))
          yield* waitFor(
            client.session.getSnapshot(starter),
            (current) =>
              roundEndMessages(current.messages).length === 4 && current.runtime._tag === "Idle",
            10_000,
            "all four resumed threads ended",
          )
          yield* client.message.send({ ...starter, content: "START-FIFTH" })
          const settled = yield* waitFor(
            client.session.getSnapshot(starter),
            (current) =>
              roundEndMessages(current.messages).length === 5 && current.runtime._tag === "Idle",
            10_000,
            "the fifth thread was admitted and ended",
          )
          expect(cappedResults(settled.messages)).toHaveLength(0)
        }).pipe(Effect.timeout("30 seconds")),
      ),
    35_000,
  )

  it.live(
    "a delegate thread whose turn ended with no recorded end before the server stopped still wakes the starter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          // First process: the thread finishes, but its round's end is never
          // recorded, as a process that stopped inside the hook leaves it.
          const starter = yield* Effect.scoped(
            Effect.gen(function* () {
              const childCalled = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const providerLayer = LanguageModelLayers.testStream((options) => {
                const texts = promptTexts(options.prompt)
                if (texts[0]?.endsWith(childTask) === true) {
                  return Deferred.succeed(childCalled, void 0).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(reply("pong")),
                  )
                }
                if (promptToolCallIds(options.prompt).includes("start-1")) {
                  return Effect.succeed(reply("started, ending my turn"))
                }
                return Effect.succeed(toolStep("thread.start", delegated(childTask), "start-1"))
              })
              const { client } = yield* createRpcClient(home.layerFor(providerLayer))
              const created = yield* client.session.create({})
              const starter = { sessionId: created.sessionId, branchId: created.branchId }
              yield* client.message.send({ ...starter, content: "delegate this" })
              yield* Deferred.await(childCalled)
              yield* waitFor(
                client.session.getSnapshot(starter),
                (current) =>
                  current.runtime._tag === "Idle" &&
                  messageTexts(current.messages).includes("started, ending my turn"),
                5_000,
                "the starter ended its turn",
              )
              const [row] = yield* roundsOf(home.sql)
              if (Predicate.isUndefined(row)) return yield* Effect.die("no round row")
              yield* execute(
                home.sql,
                "CREATE TRIGGER refuse_end BEFORE UPDATE OF ended_at ON thread_rounds BEGIN SELECT RAISE(ABORT, 'end refused'); END",
              )
              yield* Deferred.succeed(release, void 0)
              yield* waitFor(
                client.session.getSnapshot({
                  sessionId: SessionId.make(row.session_id),
                  branchId: BranchId.make(row.branch_id),
                }),
                (current) =>
                  current.runtime._tag === "Idle" &&
                  messageTexts(current.messages).includes("pong"),
                5_000,
                "the thread finished",
              )
              const [unrecorded] = yield* roundsOf(home.sql)
              expect(unrecorded?.ended).toBe(0)
              const before = yield* client.session.getSnapshot(starter)
              expect(roundEndMessages(before.messages)).toHaveLength(0)
              return starter
            }),
          )
          yield* execute(home.sql, "DROP TRIGGER refuse_end")

          // Second process: opening the starter reads the thread's receipt and
          // delivers its round end.
          const providerLayer = LanguageModelLayers.testStream(() =>
            Effect.succeed(reply("read it")),
          )
          const { client } = yield* createRpcClient(home.layerFor(providerLayer))
          const snapshot = yield* waitFor(
            client.session.getSnapshot(starter),
            (current) =>
              roundEndMessages(current.messages).length === 1 &&
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).includes("read it"),
            8_000,
            "the finished thread's round end woke the starter",
          )
          expect(messageTexts(roundEndMessages(snapshot.messages)).join("\n")).toContain("pong")
          const [row] = yield* roundsOf(home.sql)
          expect(row?.delivered).toBe(1)
        }).pipe(Effect.timeout("20 seconds")),
      ),
    25_000,
  )
})

// ── end of the ported sections ──────────────────────────────────────────────
