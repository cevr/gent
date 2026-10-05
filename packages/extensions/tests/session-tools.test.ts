import { describe, expect, it, test } from "effect-bun-test"
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Record,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { AgentsExtension } from "../src/agents.js"
import {
  DEFAULT_SESSION_NAME,
  getToolId,
  messagePartsDisplayText,
  sessionThread,
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
  textDeltaPart,
  toolCallPart,
  textStep,
  toolCallStep,
  waitFor,
} from "@gent/core/test-utils"
import * as Prompt from "effect/ai/Prompt"
import { workspaceIdForCwd } from "@gent/core/host"
import {
  renderSessionTree,
  SESSION_TOOLS_EXTENSION_ID,
  type SessionMessageDetails,
  sessionMessageBody,
  sessionMessageText,
  sessionTitleOf,
  SessionToolsExtension,
  THREAD_TASK_TYPE,
} from "../src/session-tools.js"
import { toolResultSummary } from "@gent/core/extensions/branch-tools"
import {
  Branch,
  dateFromMillis,
  Message,
  BranchId,
  MessageId,
  SessionId,
  ToolCallId,
  type EventEnvelope,
} from "@gent/core/protocol"
import { e2ePreset } from "./helpers/test-preset"
import { isToolEventFor } from "./helpers/tool-event.js"

// ── session naming ──────────────────────────────────────────────────────────

/** Forks a reader that ends after `count` turns of the branch have ended. */
const turnEnds = <E>(stream: Stream.Stream<EventEnvelope, E>, count: number) =>
  stream.pipe(
    Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
    Stream.take(count),
    Stream.runDrain,
    Effect.forkScoped,
  )

describe("session naming", () => {
  it.live(
    "a root session takes its name from the first line of its first message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("done")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          yield* client.message.send({
            sessionId,
            branchId,
            content: "  Fix the login redirect\nIt loops after sign-in.",
          })
          const named = yield* waitFor(
            client.session.get({ sessionId }),
            (session) => session?.name !== DEFAULT_SESSION_NAME,
            3_000,
            "the session's name",
          )
          expect(named?.name).toBe("Fix the login redirect")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
  it.live(
    "a name the model gives in the first turn wins over the first message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("rename_session", { name: "auth redirect work" }),
            textStep("done"),
            textStep("again"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          const events = client.session.events({ sessionId, branchId })
          const first = yield* turnEnds(events, 1)
          // The loop runs a turn's `turnAfter` hooks before it takes the next
          // turn, so once the second turn ends the first one's hooks have run.
          const second = yield* turnEnds(events, 2)
          yield* client.message.send({ sessionId, branchId, content: "Fix the login redirect" })
          yield* Fiber.join(first)
          yield* client.message.send({ sessionId, branchId, content: "And the logout one" })
          yield* Fiber.join(second)
          expect((yield* client.session.get({ sessionId }))?.name).toBe("auth redirect work")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  // A handoff's first message is the model's markdown, and an `@file`
  // reference arrives as a fenced block: the title is the first plain words.
  test("the title skips fenced file text and leading markdown markers", () => {
    const fileRef = "```src/foo.ts\nconst a = 1\n```"
    const cases: ReadonlyArray<readonly [string, Option.Option<string>]> = [
      ["## Current task\nShip the fix.", Option.some("Current task")],
      ["- **Ship the fix**", Option.some("Ship the fix")],
      ["> `retry` loops forever", Option.some("`retry` loops forever")],
      [`${fileRef} fix this`, Option.some("fix this")],
      [`${fileRef}\nfix this`, Option.some("fix this")],
      ["---\n\nFix the login redirect", Option.some("Fix the login redirect")],
      ["  Fix the login redirect\nIt loops.", Option.some("Fix the login redirect")],
      [fileRef, Option.none()],
    ]
    for (const [text, title] of cases) expect([text, sessionTitleOf(text)]).toEqual([text, title])
  })

  test("a fence closes only on a fence of its own kind, as long or longer", () => {
    const nested = "````md\n```ts\nconst a = 1\n```\n````\nShip the docs"
    const tildes = "~~~\n```\nnot a title\n~~~\nShip the docs"
    expect(sessionTitleOf(nested)).toEqual(Option.some("Ship the docs"))
    expect(sessionTitleOf(tildes)).toEqual(Option.some("Ship the docs"))
  })
})

// ── session tool output ─────────────────────────────────────────────────────

describe("session.send summary", () => {
  it.live("a sent message reads as who got it and what it said, not JSON", () =>
    Effect.gen(function* () {
      const contributions = yield* collectTestContributions(SessionToolsExtension.setup)
      const send = Option.fromUndefinedOr(
        contributions.tools?.find((candidate) => getToolId(candidate) === "session.send"),
      )
      expect(Option.isSome(send)).toBe(true)
      expect(
        toolResultSummary(
          send,
          { to: "parent", message: "  CI is green  " },
          { isFailure: false, result: { sessionId: "parent-1", relation: "parent" } },
        ),
      ).toBe("to parent · CI is green")
    }),
  )
})

describe("renderSessionTree", () => {
  const now = dateFromMillis(0)
  const sid = SessionId.make("s1")
  const bid1 = BranchId.make("b1")
  const bid2 = BranchId.make("b2")

  const makeBranch = (id: BranchId, opts?: { parentBranchId?: BranchId; name?: string }) =>
    new Branch({
      id,
      sessionId: sid,
      parentBranchId: opts?.parentBranchId,
      name: opts?.name,
      createdAt: now,
    })

  let messageIndex = 0
  const makeMessage = (branchId: BranchId, role: "user" | "assistant", text: string) =>
    Message.cases.regular.make({
      id: MessageId.make(`msg-${messageIndex++}`),
      sessionId: sid,
      branchId,
      role,
      parts: [Prompt.textPart({ text })],
      createdAt: now,
    })

  test("single branch → '# Branch: name' header + messages", () => {
    const branch = makeBranch(bid1, { name: "main" })
    const msg = makeMessage(bid1, "user", "hello")
    const result = renderSessionTree([{ branch, messages: [msg] }], Option.none())
    expect(result).toContain("# Branch: main")
    expect(result).toContain("## user")
    expect(result).toContain("hello")
  })

  test("target branch → '[TARGET BRANCH]' marker", () => {
    const branch = makeBranch(bid1, { name: "main" })
    const msg = makeMessage(bid1, "user", "hello")
    const result = renderSessionTree([{ branch, messages: [msg] }], Option.some(bid1))
    expect(result).toContain("[TARGET BRANCH]")
  })

  test("child branch → '--- branch point ---' separator", () => {
    const parent = makeBranch(bid1, { name: "main" })
    const child = makeBranch(bid2, { parentBranchId: bid1, name: "fix" })
    const result = renderSessionTree(
      [
        { branch: parent, messages: [makeMessage(bid1, "user", "start")] },
        { branch: child, messages: [makeMessage(bid2, "assistant", "fixed")] },
      ],
      Option.none(),
    )
    expect(result).toContain("# Branch: main")
    expect(result).toContain("--- branch point: fix ---")
  })
})

// ── session tools rpc ───────────────────────────────────────────────────────

const toolEventsFor = <E>(stream: Stream.Stream<EventEnvelope, E>, toolName: string) =>
  stream.pipe(
    Stream.filter(isToolEventFor(toolName)),
    Stream.take(2),
    Stream.runCollect,
    Effect.forkScoped,
  )

describe("Session tools via model turn", () => {
  it.live(
    "read_session of a session that does not exist fails with the load reason",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("read_session", { sessionId: "missing-session-tools-rpc" }),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          const eventFiber = yield* toolEventsFor(
            client.session.events({ sessionId, branchId }),
            "read_session",
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "Read this session",
          })

          const events = Array.from(yield* Fiber.join(eventFiber))
          const failed = events.find((event) => event.event._tag === "ToolCallFailed")
          expect(failed?.event._tag).toBe("ToolCallFailed")
          if (failed?.event._tag === "ToolCallFailed") {
            expect(failed.event.output).toContain("Failed to load session")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
  it.live(
    "read_session refuses a branch the session does not have",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let target = ""
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream(() => {
            calls += 1
            if (calls > 1) {
              return Effect.succeed(
                Stream.fromIterable([textDeltaPart("done"), finishPart({ finishReason: "stop" })]),
              )
            }
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart(
                  "read_session",
                  { sessionId: target, branchId: "no-such-branch" },
                  { toolCallId: ToolCallId.make("read-unknown-branch") },
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
          target = sessionId
          const eventFiber = yield* toolEventsFor(
            client.session.events({ sessionId, branchId }),
            "read_session",
          )
          yield* client.message.send({ sessionId, branchId, content: "Read this session" })
          const events = Array.from(yield* Fiber.join(eventFiber))
          const failed = events.find((event) => event.event._tag === "ToolCallFailed")
          expect(failed?.event._tag).toBe("ToolCallFailed")
          if (failed?.event._tag === "ToolCallFailed") {
            expect(failed.event.output).toContain("has no branch no-such-branch")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
  it.live(
    "read_session refuses a message the session does not have",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let target = ""
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream(() => {
            calls += 1
            if (calls > 1) {
              return Effect.succeed(
                Stream.fromIterable([textDeltaPart("done"), finishPart({ finishReason: "stop" })]),
              )
            }
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart(
                  "read_session",
                  { sessionId: target, fromMessageId: "no-such-message" },
                  { toolCallId: ToolCallId.make("read-unknown-message") },
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
          target = sessionId
          const eventFiber = yield* toolEventsFor(
            client.session.events({ sessionId, branchId }),
            "read_session",
          )
          yield* client.message.send({ sessionId, branchId, content: "Read this session" })
          const events = Array.from(yield* Fiber.join(eventFiber))
          const failed = events.find((event) => event.event._tag === "ToolCallFailed")
          expect(failed?.event._tag).toBe("ToolCallFailed")
          if (failed?.event._tag === "ToolCallFailed") {
            expect(failed.event.output).toContain("has no message no-such-message")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
  it.live(
    "a handoff session messages its predecessor as a session, not as its child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream(() => {
            calls += 1
            if (calls > 1) {
              return Effect.succeed(
                Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
              )
            }
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart(
                  "session.send",
                  { to: "parent", message: "picked up where you left off" },
                  { toolCallId: ToolCallId.make("handoff-send") },
                ),
                finishPart({ finishReason: "tool-calls" }),
              ]),
            )
          })
          const cwd = yield* makeTempDirectoryScoped("gent-session-tools-")
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            cwd,
            providerLayer,
            extensionInputs: [AgentsExtension, SessionToolsExtension],
          })
          const handoff = yield* client.session.create({
            cwd,
            parentSessionId: sessionId,
            parentBranchId: branchId,
            continueThread: true,
          })
          const eventFiber = yield* toolEventsFor(
            client.session.events({ sessionId: handoff.sessionId, branchId: handoff.branchId }),
            "session.send",
          )
          yield* client.message.send({
            sessionId: handoff.sessionId,
            branchId: handoff.branchId,
            content: "Tell the last session",
          })
          const events = Array.from(yield* Fiber.join(eventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded?.event._tag).toBe("ToolCallSucceeded")
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain('"relation": "session"')
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── threads ─────────────────────────────────────────────────────────────────

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
  const stop = (at: SessionKey, thread: string) =>
    Effect.flatMap(one(at, op("thread.stop", { thread })), decodeStopped)
  return { client, cwd, starter, gate, act, op, list, listUntil, start, stop }
})

const decodeStarted = Schema.decodeEffect(StartedOutput)
const decodeListed = Schema.decodeEffect(ListedOutput)
const decodeStopped = Schema.decodeEffect(StoppedOutput)
const decodeStartedResult = Schema.decodeUnknownEffect(StartedResult)

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
          expect(task?.metadata?.customType).toBe(THREAD_TASK_TYPE)
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
            (resource) => resource.id === "@gent/session-tools/thread-starts",
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
          > = Layer.build(permit.layer).pipe(Effect.orDie)
          const permits = yield* buildPermits
          const { client } = yield* createRpcClient(Layer.succeedContext(context))
          const starter: SessionKey = yield* client.session.create({ cwd })
          const run = Effect.gen(function* () {
            const host = yield* runtimeHostContext(starter)
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- a registered tool's channels are erased, as at the extension membrane
            const output: unknown = yield* runToolWithCtx(
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
    "a delegate child is not offered thread.start; its parent is",
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
                  "delegate.start",
                  { todo: childTask },
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

describe("session message header", () => {
  const from = {
    sessionId: SessionId.make("child-1"),
    relation: "child",
  } satisfies SessionMessageDetails["from"]

  test("a child's message says it is not the completion, before and after it", () => {
    const text = sessionMessageText({ from, message: "CI is green" })
    expect(text).toContain("child-completion message; this message is not one")
    expect(text).not.toContain("still running")
    expect(sessionMessageBody(from, text)).toBe("CI is green")
  })

  test("a stored row with the earlier status line still shows only its body", () => {
    const stored =
      "Message from your child (session child-1):\nYour child is still running. This is not its completion; that arrives as a separate message.\n\nCI is green"
    expect(sessionMessageBody(from, stored)).toBe("CI is green")
  })
})
