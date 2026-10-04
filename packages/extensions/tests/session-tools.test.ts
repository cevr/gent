import { describe, expect, it, test } from "effect-bun-test"
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Semaphore,
  Stream,
} from "effect"
import type { LanguageModel } from "effect/ai"
import { AgentsExtension } from "../src/agents.js"
import {
  DEFAULT_SESSION_NAME,
  getToolId,
  messagePartsDisplayText,
  sessionThread,
  type ToolCapability,
} from "@gent/core/extensions/api"
import {
  collectTestContributions,
  createE2ELayer,
  CurrentWorkspaceId,
  createRpcClient,
  createRpcHarness,
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
  ThreadListTool,
  ThreadStarts,
  ThreadStartTool,
  ThreadStopTool,
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

/**
 * A starter session the test runs the thread tools in, outside a turn, over
 * the real runtime: the facade the tools call creates, sends to and stops the
 * thread sessions as a turn's facade does.
 */
const threadHarness = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
  Effect.gen(function* () {
    const cwd = yield* makeTempDirectoryScoped("gent-threads-")
    const context = yield* Layer.build(createE2ELayer({ ...e2ePreset, cwd, providerLayer }))
    const permits = Context.make(ThreadStarts, yield* Semaphore.make(1))
    const { client } = yield* createRpcClient(Layer.succeedContext(context))
    const starter: SessionKey = yield* client.session.create({ cwd })
    const run = <Input, Output, Failure>(
      capability: ToolCapability<Input, Output, Failure>,
      input: Input,
      options: { readonly call: string; readonly at?: SessionKey },
    ) =>
      Effect.gen(function* () {
        const host = yield* runtimeHostContext(options.at ?? starter)
        return yield* runToolWithCtx(capability, input, {
          ...host,
          extensionId: SESSION_TOOLS_EXTENSION_ID,
          toolCallId: ToolCallId.make(options.call),
        })
      }).pipe(
        Effect.provideContext(Context.merge(context, permits)),
        Effect.provideService(CurrentWorkspaceId, workspaceIdForCwd(cwd)),
      )
    return { client, cwd, starter, run }
  })

/** Threads that answer once `gate` opens; until then each is at the model, running. */
const gatedThreads = (gate: Deferred.Deferred<boolean>) =>
  LanguageModelLayers.testStream((options) => {
    if (!isThreadRequest(options.prompt)) return Effect.succeed(reply("starter"))
    return Deferred.await(gate).pipe(Effect.as(reply("THREAD-REPLY: changelog tidied")))
  })

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
          const gate = yield* Deferred.make<boolean>()
          const { run } = yield* threadHarness(gatedThreads(gate))
          const started = yield* run(ThreadStartTool, { task: THREAD_TASK }, { call: "start-1" })
          const running = yield* waitFor(
            run(ThreadListTool, {}, { call: "list-1" }),
            (rows) => rows[0]?.status === "running",
            3_000,
            "the thread runs",
          )
          expect(running).toHaveLength(1)
          expect(running[0]).toMatchObject({
            thread: started.thread,
            sessions: 1,
            current: { sessionId: started.sessionId, branchId: started.branchId },
          })
          yield* Deferred.succeed(gate, true)
          const idle = yield* waitFor(
            run(ThreadListTool, {}, { call: "list-2" }),
            (rows) => rows[0]?.status === "idle" && rows[0].preview.length > 0,
            3_000,
            "the thread ends",
          )
          expect(idle[0]?.preview).toBe("THREAD-REPLY: changelog tidied")
          const one = yield* run(ThreadListTool, { thread: started.thread }, { call: "list-3" })
          expect(one.map((row) => row.preview)).toEqual(["THREAD-REPLY: changelog tidied"])
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a handoff inside a thread stays one thread, and its newest session is current",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<boolean>()
          yield* Deferred.succeed(gate, true)
          const { client, cwd, run } = yield* threadHarness(gatedThreads(gate))
          const started = yield* run(ThreadStartTool, { task: THREAD_TASK }, { call: "start-1" })
          const handoff = yield* client.session.create({
            cwd,
            parentSessionId: started.sessionId,
            parentBranchId: started.branchId,
            continueThread: true,
          })
          const rows = yield* run(ThreadListTool, {}, { call: "list-1" })
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
          const gate = yield* Deferred.make<boolean>()
          const { client, cwd, run } = yield* threadHarness(gatedThreads(gate))
          const started = yield* run(ThreadStartTool, { task: THREAD_TASK }, { call: "start-1" })
          yield* waitFor(
            run(ThreadListTool, {}, { call: "list-1" }),
            (rows) => rows[0]?.status === "running",
            3_000,
            "the thread runs",
          )
          const other: SessionKey = yield* client.session.create({ cwd })
          const refused = yield* run(
            ThreadStopTool,
            { thread: started.thread },
            { call: "stop-other", at: other },
          ).pipe(Effect.flip)
          expect(refused.message).toContain("is not a thread this session started")
          const result = yield* run(ThreadStopTool, { thread: started.thread }, { call: "stop-1" })
          expect(result.stopped).toEqual([
            { sessionId: started.sessionId, branchId: started.branchId },
          ])
          const after = yield* waitFor(
            run(ThreadListTool, {}, { call: "list-2" }),
            (rows) => rows[0]?.status === "idle",
            3_000,
            "the stopped thread is idle",
          )
          expect(after[0]?.preview).toBe("")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a fifth running thread is refused and names the four that run",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<boolean>()
          const { client, run } = yield* threadHarness(gatedThreads(gate))
          for (const index of [1, 2, 3, 4]) {
            yield* run(ThreadStartTool, { task: `${THREAD_TASK} ${index}` }, { call: `s-${index}` })
          }
          yield* waitFor(
            run(ThreadListTool, {}, { call: "list-1" }),
            (rows) => rows.filter((row) => row.status === "running").length === 4,
            3_000,
            "four threads run",
          )
          const before = (yield* client.session.list()).length
          const refused = yield* run(
            ThreadStartTool,
            { task: `${THREAD_TASK} 5` },
            { call: "s-5" },
          ).pipe(Effect.flip)
          expect(refused.message).toContain("already runs 4 threads")
          // The refused start leaves no session behind.
          expect((yield* client.session.list()).length).toBe(before)
          yield* Deferred.succeed(gate, true)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a repeated start of one tool call is one thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<boolean>()
          yield* Deferred.succeed(gate, true)
          const { client, starter, run } = yield* threadHarness(gatedThreads(gate))
          const first = yield* run(ThreadStartTool, { task: THREAD_TASK }, { call: "same" })
          const second = yield* run(ThreadStartTool, { task: THREAD_TASK }, { call: "same" })
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
