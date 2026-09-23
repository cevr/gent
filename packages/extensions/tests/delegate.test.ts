import { describe, expect, it, test } from "effect-bun-test"
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Predicate,
  Record,
  Schema,
  Stream,
  Struct,
} from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import {
  childTaskText,
  DELEGATE_AGENT_NAME,
  DelegateEntry,
  describeChildCompletion,
  readChildCompletionHeadline,
  StartChild,
  startTurnMessages,
} from "../src/delegate.js"
import { DEFAULT_AGENT_NAME, RequestId } from "@gent/core/extensions/api"
import {
  createRpcHarness,
  runToolWithCtx,
  testToolContext,
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  multiToolCallStep,
  textDeltaPart,
  textStep,
  toolCallPart,
  waitFor,
  ConfigService,
  RuntimeEnvironment,
  UserConfig,
} from "@gent/core/test-utils"
import {
  BranchId,
  MessageId,
  ModelId,
  SessionId,
  SteerCommand,
  ToolCallId,
} from "@gent/core/protocol"
import { e2ePreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"
import type * as Prompt from "effect/unstable/ai/Prompt"

// ── delegate/harness ────────────────────────────────────────────────────────

/**
 * Every test here runs a real child through the public facade. The registry
 * the extension keeps is read back from the temp home so each assertion sees
 * what a restarted process would.
 */

const registryCodec = Schema.fromJsonString(Schema.Array(DelegateEntry))
const decodeRegistry = Schema.decodeUnknownSync(registryCodec)
const encodeRegistry = Schema.encodeSync(registryCodec)
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const harnessWithHome = (
  providerLayer: Parameters<typeof createRpcHarness>[0]["providerLayer"],
  options: { readonly config?: UserConfig } = {},
) =>
  Effect.gen(function* () {
    const home = yield* makeTempDirectoryScoped("delegate-")
    const harness = yield* createRpcHarness({
      ...e2ePreset,
      providerLayer,
      extraLayers: [RuntimeEnvironment.Live({ cwd: "/tmp", home })],
      ...Record.filter(
        {
          configServiceLayer: Option.map(
            Option.fromUndefinedOr(options.config),
            ConfigService.Test,
          ).pipe(Option.getOrUndefined),
        },
        Predicate.isNotUndefined,
      ),
    })
    const fs = yield* FileSystem.FileSystem
    const registryOf = (branchId: BranchId) =>
      fs.readFileString(`${home}/.gent/delegates/${branchId}.json`).pipe(Effect.map(decodeRegistry))
    const writeRegistry = (branchId: BranchId, entries: ReadonlyArray<DelegateEntry>) =>
      fs
        .makeDirectory(`${home}/.gent/delegates`, { recursive: true })
        .pipe(
          Effect.andThen(
            fs.writeFileString(`${home}/.gent/delegates/${branchId}.json`, encodeRegistry(entries)),
          ),
        )
    return { ...harness, home, registryOf, writeRegistry }
  }).pipe(Effect.provide(BunFileSystem.layer))

type Harness = Effect.Success<ReturnType<typeof harnessWithHome>>

/** The one child session under the parent, once it exists. */
const childOf = (harness: Harness) =>
  waitFor(
    harness.client.session.list(),
    (sessions) => sessions.some((session) => session.parentSessionId === harness.sessionId),
    5_000,
    "the child session exists",
  ).pipe(
    Effect.flatMap((sessions) => {
      const child = sessions.find((session) => session.parentSessionId === harness.sessionId)
      if (Predicate.isUndefined(child) || Predicate.isUndefined(child.activeBranchId)) {
        return Effect.die("no child session with an active branch")
      }
      return Effect.succeed({ sessionId: child.id, branchId: child.activeBranchId })
    }),
  )

/** The first result of one delegate tool on the parent branch. */
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

/** Every text part of the prompt's user and assistant messages, in order. */
const promptTexts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) => {
    if (message.role === "system") return []
    return message.content.flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
  })

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

const completionMessages = <M extends { readonly metadata?: { readonly customType?: string } }>(
  messages: ReadonlyArray<M>,
) => messages.filter((message) => message.metadata?.customType === "child-completion")

const sendPrompt = (harness: Harness, content: string) =>
  harness.client.message.send({
    sessionId: harness.sessionId,
    branchId: harness.branchId,
    content,
  })

const childTask = "CHILD-TASK: reply with the single word pong"

/**
 * A parent that starts one child and ends its turn. The child reads the task
 * as its own user message; the parent only carries it inside the start
 * call's params, so the two are told apart by their first text. The child's
 * completion wakes the parent once more.
 */
const startThenEnd = (childReply: string, childGate: Effect.Effect<void> = Effect.void) => {
  let parentCalls = 0
  return LanguageModelLayers.testStream((options) => {
    const texts = promptTexts(options.prompt)
    if (texts[0]?.endsWith(childTask) === true) return childGate.pipe(Effect.as(reply(childReply)))
    parentCalls += 1
    if (parentCalls === 1) {
      return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
    }
    if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
    return Effect.succeed(reply("read it"))
  })
}

/** The parent branch once the child's completion has landed and been read. */
const afterCompletion = (harness: Harness) =>
  waitFor(
    harness.client.session.getSnapshot({
      sessionId: harness.sessionId,
      branchId: harness.branchId,
    }),
    (current) =>
      completionMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
    8_000,
    "the child's completion woke the parent and the parent read it",
  )

// ── delegate/completion ─────────────────────────────────────────────────────

/**
 * A child never blocks its parent. The start returns at admission, the parent
 * ends its turn, and the child's receipt comes back as one message on the
 * parent branch that wakes it. These tests read what that message and the
 * registry carry.
 */

describe("a child's completion", () => {
  it.live(
    "runs the model paired in config for the delegate agent, not the caller's",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* harnessWithHome(startThenEnd("pong"), {
            config: new UserConfig({
              agents: {
                [DEFAULT_AGENT_NAME]: { modelId: ModelId.make("test/parent-model") },
                [DELEGATE_AGENT_NAME]: { modelId: ModelId.make("test/child-model") },
              },
            }),
          })
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterCompletion(harness)
          expect(messageTexts(snapshot.messages)).toContain("read it")

          const modelsOf = (target: { sessionId: typeof sessionId; branchId: BranchId }) =>
            client.session.events(target).pipe(
              Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
              Stream.flatMap((envelope) => {
                if (envelope.event._tag !== "StreamEnded") return Stream.empty
                return Stream.make(envelope.event.model)
              }),
              Stream.runCollect,
              Effect.map((models) => Array.from(models)),
            )
          const child = yield* childOf(harness)
          expect(yield* modelsOf(child)).toEqual([ModelId.make("test/child-model")])
          expect(yield* modelsOf({ sessionId, branchId })).toContain(
            ModelId.make("test/parent-model"),
          )
          const [entry] = yield* harness.registryOf(branchId)
          expect(entry).toMatchObject({
            requestId: "start-1",
            ...child,
            agentName: DELEGATE_AGENT_NAME,
            toolCallId: "start-1",
            private: false,
            submitted: true,
            delivered: true,
          })
          expect(entry?.completed).toEqual({})
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a child's later turns, from its own wake and from the parent's session.send, run as the delegate agent",
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
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
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
              agents: { [DELEGATE_AGENT_NAME]: { modelId: childModel } },
            }),
          })
          const { client } = harness
          yield* sendPrompt(harness, "delegate this task")
          yield* afterCompletion(harness)
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
              `the child answered ${text}`,
            )
          // The child's own alarm wakes it for a turn no one sent it.
          yield* childAnswered("woke")
          // The parent's message wakes the idle child for another.
          yield* sendPrompt(harness, "SEND-TO-CHILD")
          const snapshot = yield* childAnswered("noted")

          const models = yield* client.session.events(child).pipe(
            Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
            Stream.flatMap((envelope) => {
              if (envelope.event._tag !== "StreamEnded") return Stream.empty
              return Stream.make(envelope.event.model)
            }),
            Stream.runCollect,
            Effect.map((found) => Array.from(found)),
          )
          // Four steps over three turns: the start (wake call, then pong), the wake, the send.
          expect(models).toEqual([childModel, childModel, childModel, childModel])
          expect(childTools).toHaveLength(4)
          for (const tools of childTools) expect(tools).not.toContain("delegate.start")
          expect(snapshot.agent).toBe(DELEGATE_AGENT_NAME)
          expect(snapshot.resolvedModelId).toBe(childModel)
        }).pipe(Effect.timeout("20 seconds")),
      ),
    25_000,
  )

  it.live(
    "the completion message carries the row it draws: agent, outcome, usage, and the child's calls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              if (!promptToolCallIds(options.prompt).includes("child-read")) {
                return Effect.succeed(
                  toolStep("read", { path: "/tmp/no-such-file-for-a-child" }, "child-read"),
                )
              }
              return Effect.succeed(reply("pong"))
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterCompletion(harness)
          const [completion] = completionMessages(snapshot.messages)
          expect(completion?.metadata?.details).toMatchObject({
            requestId: "start-1",
            agentName: DELEGATE_AGENT_NAME,
            outcome: {},
            tools: [{ name: "read", summary: "", status: "error" }],
            toolCount: 1,
          })
          // The model still reads the same envelope.
          expect(messageTexts([completion!])[0]).toContain(
            `Child agent "${DELEGATE_AGENT_NAME}" completed.`,
          )
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live("a child cannot delegate further, and gets no tool that waits on the user", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childTools = yield* Deferred.make<ReadonlyArray<string>>()
        const parentTools = yield* Deferred.make<ReadonlyArray<string>>()
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const texts = promptTexts(options.prompt)
          const names = options.tools.map((tool) => tool.name)
          if (texts[0]?.endsWith(childTask) === true) {
            return Deferred.succeed(childTools, names).pipe(Effect.as(reply("could not delegate")))
          }
          if (!promptToolCallIds(options.prompt).includes("start-1")) {
            return Deferred.succeed(parentTools, names).pipe(
              Effect.as(toolStep("delegate.start", { todo: childTask }, "start-1")),
            )
          }
          return Effect.succeed(reply("done"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        yield* sendPrompt(harness, "delegate this task")
        const tools = yield* Deferred.await(childTools)
        expect(tools).toContain("bash")
        expect(tools.filter((name) => name.startsWith("delegate."))).toEqual([])
        // Nobody answers a non-interactive child: a confirm or a handoff would park it for good.
        const waitsOnUser = ["ask_user", "prompt", "handoff"]
        expect(tools.filter((name) => waitsOnUser.includes(name))).toEqual([])
        expect(yield* Deferred.await(parentTools)).toEqual(expect.arrayContaining(waitsOnUser))
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )
})

// ── delegate/completion-message ─────────────────────────────────────────────

/**
 * The message a parent agent reads when a child finishes.
 *
 * A turn receipt is not task success. A child can be interrupted, have its
 * model stream fail, or spend its continuations without ever answering — and
 * in each case the text it produced looks like an ordinary (if short) result.
 * If the outcome is not named in the message, the parent model reads a failure
 * as a completed answer.
 */

const childCompletion = (
  outcome: Parameters<typeof describeChildCompletion>[0]["outcome"],
  text = "the child output",
) =>
  describeChildCompletion({
    requestId: RequestId.make("child-request"),
    agentName: DELEGATE_AGENT_NAME,
    sessionId: SessionId.make("child-session"),
    branchId: BranchId.make("child-branch"),
    outcome,
    text,
  })

describe("child completion message", () => {
  test("reports a clean turn as completed", () => {
    const rendered = childCompletion({})
    expect(rendered).toContain("completed")
    expect(rendered).not.toContain("ended (")
    expect(rendered).toContain("the child output")
  })

  test("names an unanswered turn so the parent does not read it as an answer", () => {
    // The child ran, spent both continuations, and produced nothing. Without
    // this the parent sees "completed" and an empty body.
    expect(childCompletion({ unanswered: true }, "")).toContain("ended (no answer produced)")
  })

  test("names an interrupted turn", () => {
    expect(childCompletion({ interrupted: true })).toContain("ended (interrupted)")
  })

  test("names a failed model stream", () => {
    expect(childCompletion({ streamFailed: true })).toContain("ended (model stream failed)")
  })

  test("names every outcome when a turn ends badly in more than one way", () => {
    const rendered = childCompletion({ interrupted: true, streamFailed: true, unanswered: true })
    expect(rendered).toContain("ended (interrupted, model stream failed, no answer produced)")
  })

  test("always warns that a receipt is not task success", () => {
    expect(childCompletion({})).toContain("Completion is a turn receipt, not task success")
  })
})

describe("the completion headline", () => {
  const headlineOf = (outcome: Parameters<typeof describeChildCompletion>[0]["outcome"]) =>
    readChildCompletionHeadline(childCompletion(outcome, "answer"))

  test("reads back the agent and status the envelope writes", () => {
    expect(Option.getOrThrow(headlineOf({}))).toEqual({
      agentName: DELEGATE_AGENT_NAME,
      status: "completed",
    })
    expect(Option.getOrThrow(headlineOf({ interrupted: true, streamFailed: true })).status).toBe(
      "ended (interrupted, model stream failed)",
    )
  })

  test("the child's task names its reply as the result and keeps session.send for later turns", () => {
    const [source, later, blank, task] = childTaskText(SessionId.make("parent-1"), "do it").split(
      "\n",
    )
    expect(source).toContain("Your final reply in this turn is your result")
    expect(source).toContain("do not also send it with session.send")
    expect(later).toContain(
      'A later turn started by one of them returns nothing by itself: send that turn\'s result with session.send to "parent"',
    )
    expect(later).not.toContain("send each one")
    expect(blank).toBe("")
    expect(task).toBe("do it")
  })

  test("text that is not an envelope reads as nothing", () => {
    expect(Option.isNone(readChildCompletionHeadline("plain answer"))).toBe(true)
  })
})

// ── delegate/parent-interrupt ───────────────────────────────────────────────

/**
 * A parent's interrupted turn stops the children it has not heard from. Left
 * running they have no owner: the parent's next turn can neither read them nor
 * cancel them, and the gamut testbed showed six such children editing files
 * after an Escape. The rows settle before the children stop, so no completion
 * message wakes the parent the user just interrupted.
 */

describe("a parent interrupt", () => {
  it.live(
    "ends a running child's turn as interrupted and settles its row without a message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childStreaming = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const stalled = (text: string, opened: Deferred.Deferred<void>) =>
            Stream.make(textDeltaPart(text)).pipe(
              Stream.concat(Stream.fromEffect(Deferred.succeed(opened, void 0)).pipe(Stream.drain)),
              Stream.concat(Stream.never),
            )
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            // The child's stream opens and stalls: it is mid-turn when the
            // parent is interrupted.
            if (texts[0]?.endsWith(childTask) === true)
              return Effect.succeed(stalled("working", childStreaming))
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            // The parent's turn is still open after the start, so the
            // interrupt lands on a turn that owns a running child.
            if (parentCalls === 2) return Effect.succeed(stalled("planning", parentStreaming))
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate one task")
          yield* Deferred.await(childStreaming)
          yield* Deferred.await(parentStreaming)
          const child = yield* childOf(harness)
          yield* client.steer.command({
            command: SteerCommand.make({
              _tag: "Cancel",
              sessionId,
              branchId,
              requestId: RequestId.make("interrupt-parent-of-running-child"),
            }),
          })
          const childEnd = yield* client.session.events(child).pipe(
            Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
            Stream.take(1),
            Stream.runHead,
          )
          expect(Option.map(childEnd, (envelope) => envelope.event)).toMatchObject(
            Option.some({ _tag: "TurnCompleted", interrupted: true }),
          )
          const [entry] = yield* waitFor(
            harness.registryOf(branchId),
            (entries) => entries[0]?.delivered === true,
            3_000,
            "the parent's interrupt settled the child's row",
          )
          expect(entry).toMatchObject({ delivered: true, completed: { interrupted: true } })
          const settled = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            3_000,
            "the parent is idle",
          )
          expect(completionMessages(settled.messages)).toHaveLength(0)
        }).pipe(Effect.timeout("6 seconds")),
      ),
    8_000,
  )
})

// ── delegate/background ─────────────────────────────────────────────────────

/**
 * A start nobody waits for is background delegation. The child's completion
 * must come back as a message on the parent branch, which wakes the parent
 * for another turn. Nothing else carries the result.
 */

describe("a start nobody waits for", () => {
  it.live(
    "returns the handle under the tool call id; the completion lands on the parent branch and wakes it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) return Effect.succeed(reply("pong"))
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "bg-child"))
            }
            if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
            return Effect.succeed(reply("parent read pong"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          const started = yield* toolResult(harness, "delegate.start")
          yield* sendPrompt(harness, "delegate this task")
          const running = yield* Fiber.join(started)
          expect(running?._tag).toBe("ToolCallSucceeded")
          if (running?._tag !== "ToolCallSucceeded") return
          // The handle is keyed by the tool call, so a replayed call finds its child.
          expect(parseJson(running.output)).toMatchObject({ requestId: "bg-child" })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              completionMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
            8_000,
            "child completion delivered to the parent",
          )
          // The completion woke the parent for a fresh turn.
          expect(messageTexts(snapshot.messages)).toContain("parent read pong")

          const child = yield* childOf(harness)
          const [entry] = yield* harness.registryOf(branchId)
          expect(entry).toMatchObject({
            requestId: "bg-child",
            ...child,
            private: false,
            submitted: true,
            delivered: true,
          })
          // A clean turn raised no flag; the shape is the same whichever writer recorded it.
          expect(entry?.completed).toEqual({})
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live("refuses a start without a host-owned tool call", () =>
    Effect.gen(function* () {
      const ctx = Struct.omit(testToolContext(), ["toolCallId"])
      const error = yield* runToolWithCtx(
        StartChild,
        { todo: "analyze the codebase", overrides: { deniedTools: ["bash"] } },
        ctx,
      ).pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "DelegateError",
        message: "delegate.start requires a host-owned tool call",
      })
    }),
  )

  it.live(
    "a start left unsubmitted on disk is sent on the parent's next turn and still delivers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The parent's turn, the child's answer, and the parent's reading of
          // it draw from one queue in whichever order they reach the model.
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("ack"),
            textStep("ack"),
            textStep("ack"),
          ])
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          // A process that died between admitting the child and sending its prompt.
          const child = yield* client.session.create({
            cwd: "/tmp",
            parentSessionId: sessionId,
            parentBranchId: branchId,
          })
          yield* harness.writeRegistry(branchId, [
            {
              requestId: RequestId.make("crashed-start"),
              sessionId: child.sessionId,
              branchId: child.branchId,
              agentName: DELEGATE_AGENT_NAME,
              prompt: childTask,
              toolCallId: ToolCallId.make("crashed-tool"),
              private: false,
              submitted: false,
              delivered: false,
            },
          ])
          yield* sendPrompt(harness, "hello again")
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              completionMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
            8_000,
            "the recovered child delivered its completion",
          )
          expect(completionMessages(snapshot.messages)).toHaveLength(1)
          const [entry] = yield* harness.registryOf(branchId)
          expect(entry).toMatchObject({
            requestId: "crashed-start",
            submitted: true,
            delivered: true,
          })
          const childMessages = yield* client.message.list(child)
          expect(childMessages.filter((m) => m.role === "user")).toHaveLength(1)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a re-sent start runs under the run spec its child session was created with",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("ack"),
            textStep("ack"),
            textStep("ack"),
          ])
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          const runSpec = { overrides: { modelId: ModelId.make("test/override-model") } }
          // The child session carries its admission from creation, as `admitChild` makes it.
          const child = yield* client.session.create({
            cwd: "/tmp",
            parentSessionId: sessionId,
            parentBranchId: branchId,
            admission: { agent: DELEGATE_AGENT_NAME, interactive: false, runSpec },
          })
          // The row is written before the start is sent.
          yield* harness.writeRegistry(branchId, [
            {
              requestId: RequestId.make("written-ahead"),
              sessionId: child.sessionId,
              branchId: child.branchId,
              agentName: DELEGATE_AGENT_NAME,
              prompt: childTask,
              toolCallId: ToolCallId.make("written-ahead"),
              private: false,
              submitted: false,
              delivered: false,
            },
          ])
          yield* sendPrompt(harness, "hello again")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              completionMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
            8_000,
            "the re-sent child delivered its completion",
          )
          const models = yield* client.session.events(child).pipe(
            Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
            Stream.flatMap((envelope) => {
              if (envelope.event._tag !== "StreamEnded") return Stream.empty
              return Stream.make(envelope.event.model)
            }),
            Stream.runCollect,
            Effect.map((found) => Array.from(found)),
          )
          expect(models).toEqual([ModelId.make("test/override-model")])
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a private row whose child answers after an upgrade wakes no one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<boolean>()
          const harness = yield* harnessWithHome(
            startThenEnd("secret extraction", Deferred.await(gate).pipe(Effect.asVoid)),
          )
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate this task")
          const running = yield* waitFor(
            harness.registryOf(branchId).pipe(Effect.orElseSucceed(() => [])),
            (entries) => entries.length === 1 && entries[0]?.submitted === true,
            5_000,
            "the child is admitted",
          )
          const [row] = running
          if (Predicate.isUndefined(row)) return yield* Effect.die("no registry row")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "the parent ended its turn",
          )
          // A `read_session` child an older binary started, still mid-turn at the upgrade.
          yield* harness.writeRegistry(branchId, [{ ...row, private: true }])
          yield* Deferred.succeed(gate, true)
          yield* waitFor(
            client.session.getSnapshot({ sessionId: row.sessionId, branchId: row.branchId }),
            (child) =>
              child.runtime._tag === "Idle" &&
              messageTexts(child.messages).includes("secret extraction"),
            5_000,
            "the child answered and ended its turn",
          )
          const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
          expect(completionMessages(snapshot.messages)).toHaveLength(0)
          const [kept] = yield* harness.registryOf(branchId)
          expect(kept?.delivered).toBe(false)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a private row an older binary left undelivered is removed on reconcile, never delivered",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("nothing new"),
          ])
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          // The row an older binary wrote for a `read_session` child whose waiter
          // died after its answer; this process reads it on its first turn.
          const child = yield* client.session.create({
            cwd: "/tmp",
            parentSessionId: sessionId,
            parentBranchId: branchId,
          })
          yield* harness.writeRegistry(branchId, [
            {
              requestId: RequestId.make("old-private"),
              sessionId: child.sessionId,
              branchId: child.branchId,
              agentName: DELEGATE_AGENT_NAME,
              prompt: "a side question",
              private: true,
              submitted: true,
              delivered: false,
            },
          ])
          yield* sendPrompt(harness, "anything new?")
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).includes("nothing new"),
            8_000,
            "the parent answered",
          )
          // The private child woke no one, and reconcile removed it with its session.
          expect(completionMessages(snapshot.messages)).toHaveLength(0)
          expect(yield* harness.registryOf(branchId)).toEqual([])
          const sessions = yield* client.session.list()
          expect(sessions.some((session) => session.id === child.sessionId)).toBe(false)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  test("a registry row that still carries its run spec decodes", () => {
    // Rows kept the start's run spec, with its parent tool call, until nothing read it.
    const row = Schema.decodeSync(registryCodec)(
      `[{"requestId":"start-1","sessionId":"child","branchId":"child-branch","agentName":"${DELEGATE_AGENT_NAME}","prompt":"task","toolCallId":"start-1","runSpec":{"overrides":{"maxModelAttempts":32},"parentToolCallId":"start-1"},"private":false,"submitted":true,"delivered":true}]`,
    )
    expect(row[0]?.requestId).toBe(RequestId.make("start-1"))
    expect(row[0]?.submitted).toBe(true)
  })

  test("a registry row an older binary wrote, private and claimed, still decodes", () => {
    // The bytes an older binary wrote: a private extraction child its waiter still claimed.
    const row = Schema.decodeSync(registryCodec)(
      `[{"requestId":"run:old-child","sessionId":"old-child","branchId":"old-child-branch","agentName":"${DELEGATE_AGENT_NAME}","prompt":"a side question","private":true,"submitted":true,"delivered":false,"waiter":"waiter:a-process-that-is-gone"}]`,
    )
    expect(row[0]?.requestId).toBe(RequestId.make("run:old-child"))
    expect(row[0]?.private).toBe(true)
  })
})

// ── delegate/pending-cap ────────────────────────────────────────────────────

/**
 * The parent branch admits at most four unfinished children. A fifth and
 * sixth start in the same step must fail as ordinary tool results, not as a
 * turn failure: the model reads the rejection and keeps going. This is the
 * shape that broke in the gamut testbed — six starts in one `Promise.all`,
 * two over the cap — so the cap must reject the extra children while the four
 * admitted ones still run and deliver.
 */

const startCall = (todo: string) => ({ toolName: "delegate.start", input: { todo } })

/**
 * The failed start results on the parent branch that name the cap. A failed
 * tool result carries its message in `result`, so the cap rejection is
 * readable model input rather than a dead turn.
 */
const cappedResults = (messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Prompt.Part> }>) =>
  resultsOf("delegate.start", messages).filter((part) => {
    if (part.type !== "tool-result" || !part.isFailure) return false
    const result = part.result
    if (!Predicate.isReadonlyObject(result)) return false
    return String(result["error"]).includes("unfinished children")
  })

describe("starts over the pending cap", () => {
  it.live(
    "rejects the children past the cap as tool results and still runs the admitted four",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The parent's follow-up turn and the four admitted children all
          // draw from the gated steps, in whatever order they reach the model.
          // They stay closed until both rejections are on the branch: a child
          // that finished between two admissions would free its slot, and the
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

          // The two over-cap starts come back as ordinary tool results on the
          // parent branch. A turn that died on the rejection would never
          // persist them.
          const afterAdmission = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => cappedResults(current.messages).length >= 2,
            10_000,
            "the capped starts returned as tool results",
          )
          expect(cappedResults(afterAdmission.messages)).toHaveLength(2)
          yield* Effect.forEach(
            Array.from({ length: followUps }, (_, index) => index + 1),
            controls.emitAll,
            { discard: true },
          )

          // The four admitted children still deliver; the cap rejected the
          // extras without disturbing them.
          const settled = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              completionMessages(current.messages).length >= 4 && current.runtime._tag === "Idle",
            20_000,
            "the four admitted children delivered their completions",
          )
          expect(completionMessages(settled.messages)).toHaveLength(4)
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a child deleted from the agents pane frees its slot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let parentCalls = 0
          // The children never answer: each one holds its slot until it is deleted.
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.startsWith("Task from your parent session") === true) return Effect.never
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(
                Stream.fromIterable([
                  ...["one", "two", "three", "four"].map((word) =>
                    toolCallPart(
                      "delegate.start",
                      { todo: `Reply with ${word}` },
                      { toolCallId: ToolCallId.make(`start-${word}`) },
                    ),
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            if (parentCalls === 3) {
              return Effect.succeed(
                toolStep("delegate.start", { todo: "Reply with five" }, "start-five"),
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
                resultsOf("delegate.start", current.messages).length === count,
              8_000,
              `the parent ended its turn with ${count} start results`,
            )
          yield* idle(4)
          const admitted = yield* harness.registryOf(branchId)
          expect(admitted).toHaveLength(4)
          // The user deletes every child from the agents pane.
          yield* Effect.forEach(
            admitted,
            (row) => client.session.delete({ sessionId: row.sessionId }),
            { discard: true },
          )
          yield* sendPrompt(harness, "start one more")
          const snapshot = yield* idle(5)
          const results = resultsOf("delegate.start", snapshot.messages)
          expect(results.filter((part) => part.type === "tool-result" && part.isFailure)).toEqual(
            [],
          )
          const rows = yield* harness.registryOf(branchId)
          expect(rows.filter((row) => row.requestId !== "start-five")).toEqual(
            admitted.map((row) =>
              expect.objectContaining({
                requestId: row.requestId,
                completed: { interrupted: true },
                delivered: true,
              }),
            ),
          )
          // A deleted child settles quietly: the user removed it, so nothing wakes the parent.
          expect(completionMessages(snapshot.messages)).toEqual([])
        }).pipe(Effect.timeout("15 seconds")),
      ),
    20_000,
  )

  it.live(
    "the parent's next turn settles a child deleted while no process ran",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          const child = yield* client.session.create({
            cwd: "/tmp",
            parentSessionId: sessionId,
            parentBranchId: branchId,
          })
          yield* harness.writeRegistry(branchId, [
            {
              requestId: RequestId.make("deleted-child"),
              sessionId: child.sessionId,
              branchId: child.branchId,
              agentName: DELEGATE_AGENT_NAME,
              prompt: childTask,
              private: false,
              submitted: true,
              delivered: false,
            },
          ])
          yield* client.session.delete({ sessionId: child.sessionId })
          yield* sendPrompt(harness, "anything new?")
          const rows = yield* waitFor(
            harness.registryOf(branchId),
            (entries) => entries[0]?.delivered === true,
            5_000,
            "reconcile settled the deleted child",
          )
          expect(rows[0]?.completed).toEqual({ interrupted: true })
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── session.send ────────────────────────────────────────────────────────────

/**
 * Every session can message another. A parent corrects a child that is still
 * working: the message joins the child's running turn and its next model step
 * reads it. A child asks its parent: the parent wakes and answers. A finished
 * child is idle, so a later message wakes it for another turn.
 */

const correction = "CORRECTION: only look at src/store"
const question = "QUESTION: which store, sqlite or memory?"

/** The child session the parent's `delegate.start` result named, once the prompt carries it. */
const startedSessionId = (prompt: Prompt.Prompt): Option.Option<string> =>
  Option.fromUndefinedOr(
    prompt.content
      .flatMap((message) => {
        if (message.role !== "tool") return []
        return message.content
      })
      .flatMap((part) => {
        if (part.type !== "tool-result" || part.name !== "delegate.start") return []
        const decoded = Schema.decodeUnknownOption(Schema.Struct({ sessionId: Schema.String }))(
          part.result,
        )
        return Option.match(decoded, { onNone: () => [], onSome: (value) => [value.sessionId] })
      })[0],
  )

/** Messages another session sent: the envelope names the sender. A joined one reads `steering`, a waking one keeps its own type. */
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

/** The system text of one model call. */
const systemText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (message.role !== "system") return []
      return [message.content]
    })
    .join("\n")

describe("turn-time reconcile", () => {
  it.live(
    "a branch's turns reconcile once per process, so later model steps do not replay child logs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("first"),
            textStep("second"),
          ])
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          const idleAfter = (text: string) =>
            waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (current) =>
                current.runtime._tag === "Idle" && messageTexts(current.messages).includes(text),
              5_000,
              `the parent answered ${text}`,
            )
          yield* sendPrompt(harness, "one")
          yield* idleAfter("first")
          // A row that only a crash leaves, planted after this process reconciled the branch.
          const child = yield* client.session.create({
            cwd: "/tmp",
            parentSessionId: sessionId,
            parentBranchId: branchId,
          })
          yield* harness.writeRegistry(branchId, [
            {
              requestId: RequestId.make("planted-start"),
              sessionId: child.sessionId,
              branchId: child.branchId,
              agentName: DELEGATE_AGENT_NAME,
              prompt: childTask,
              private: false,
              submitted: false,
              delivered: false,
            },
          ])
          yield* sendPrompt(harness, "two")
          yield* idleAfter("second")
          const [entry] = yield* harness.registryOf(branchId)
          expect(entry?.submitted).toBe(false)
          expect(yield* client.message.list(child)).toHaveLength(0)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

describe("a failed completion delivery", () => {
  it.live(
    "is delivered on the parent's next turn, although the branch was reconciled in this process",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<boolean>()
          const harness = yield* harnessWithHome(
            startThenEnd("pong", Deferred.await(gate).pipe(Effect.asVoid)),
          )
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate this task")
          const [row] = yield* waitFor(
            harness.registryOf(branchId).pipe(Effect.orElseSucceed(() => [])),
            (entries) => entries.length === 1 && entries[0]?.submitted === true,
            5_000,
            "the child is admitted",
          )
          if (Predicate.isUndefined(row)) return yield* Effect.die("no registry row")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "the parent ended its turn",
          )
          // The child's receipt cannot reach the registry: its hook delivery fails.
          const fs = yield* FileSystem.FileSystem
          const file = `${harness.home}/.gent/delegates/${branchId}.json`
          yield* fs.chmod(file, 0o000)
          yield* Deferred.succeed(gate, true)
          yield* waitFor(
            client.session.getSnapshot({ sessionId: row.sessionId, branchId: row.branchId }),
            (child) =>
              child.runtime._tag === "Idle" && messageTexts(child.messages).includes("pong"),
            5_000,
            "the child answered and its delivery failed",
          )
          yield* fs.chmod(file, 0o644)
          const [stuck] = yield* harness.registryOf(branchId)
          expect(stuck?.delivered).toBe(false)
          yield* sendPrompt(harness, "anything new?")
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              completionMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
            8_000,
            "the next parent turn delivered the completion",
          )
          expect(completionMessages(snapshot.messages)).toHaveLength(1)
          const [entry] = yield* harness.registryOf(branchId)
          expect(entry?.delivered).toBe(true)
        }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a recovered completion reports the start turn, not a wake turn that ran before recovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              if (texts.some((text) => text.includes("WAKE-NOTE"))) {
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
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate this task")
          const [row] = yield* waitFor(
            harness.registryOf(branchId).pipe(Effect.orElseSucceed(() => [])),
            (entries) => entries.length === 1 && entries[0]?.submitted === true,
            5_000,
            "the child is admitted",
          )
          if (Predicate.isUndefined(row)) return yield* Effect.die("no registry row")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "the parent ended its turn",
          )
          // The start turn's hook delivery fails; the child's wake turn then runs.
          const fs = yield* FileSystem.FileSystem
          const file = `${harness.home}/.gent/delegates/${branchId}.json`
          yield* fs.chmod(file, 0o000)
          yield* Deferred.succeed(gate, void 0)
          yield* waitFor(
            client.session.getSnapshot({ sessionId: row.sessionId, branchId: row.branchId }),
            (child) =>
              child.runtime._tag === "Idle" &&
              messageTexts(child.messages).includes("LATER-ANSWER"),
            6_000,
            "the child's wake turn ran before recovery",
          )
          yield* fs.chmod(file, 0o644)
          yield* sendPrompt(harness, "anything new?")
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              completionMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
            8_000,
            "the next parent turn delivered the completion",
          )
          const text = messageTexts(completionMessages(snapshot.messages)).join("")
          expect(text).toContain("START-ANSWER")
          expect(text).not.toContain("LATER-ANSWER")
          expect(completionMessages(snapshot.messages)[0]?.metadata?.details).toMatchObject({
            tools: [{ name: "wake" }],
            toolCount: 1,
          })
        }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("14 seconds")),
      ),
    16_000,
  )

  it.live(
    "a recovered completion ends before a turn an interjection woke",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              if (texts.some((text) => text.includes("STEER-NOTE"))) {
                return Effect.succeed(reply("LATER-ANSWER"))
              }
              return Deferred.await(gate).pipe(Effect.as(reply("START-ANSWER")))
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate this task")
          const [row] = yield* waitFor(
            harness.registryOf(branchId).pipe(Effect.orElseSucceed(() => [])),
            (entries) => entries.length === 1 && entries[0]?.submitted === true,
            5_000,
            "the child is admitted",
          )
          if (Predicate.isUndefined(row)) return yield* Effect.die("no registry row")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "the parent ended its turn",
          )
          const fs = yield* FileSystem.FileSystem
          const file = `${harness.home}/.gent/delegates/${branchId}.json`
          yield* fs.chmod(file, 0o000)
          yield* Deferred.succeed(gate, void 0)
          const child = { sessionId: row.sessionId, branchId: row.branchId }
          yield* waitFor(
            client.session.getSnapshot(child),
            (current) =>
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).includes("START-ANSWER"),
            5_000,
            "the child's start turn ended and its delivery failed",
          )
          // An interjection with wake starts the idle child's next turn.
          yield* client.steer.command({
            command: SteerCommand.make({
              _tag: "Interject",
              ...child,
              requestId: RequestId.make("steer-idle-child"),
              message: "STEER-NOTE: one more thing",
              wake: true,
            }),
          })
          yield* waitFor(
            client.session.getSnapshot(child),
            (current) =>
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).includes("LATER-ANSWER"),
            5_000,
            "the woken turn ran before recovery",
          )
          yield* fs.chmod(file, 0o644)
          yield* sendPrompt(harness, "anything new?")
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              completionMessages(current.messages).length === 1 && current.runtime._tag === "Idle",
            8_000,
            "the next parent turn delivered the completion",
          )
          const text = messageTexts(completionMessages(snapshot.messages)).join("")
          expect(text).toContain("START-ANSWER")
          expect(text).not.toContain("LATER-ANSWER")
        }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("14 seconds")),
      ),
    16_000,
  )
})

describe("delegation guidance", () => {
  it.live(
    "the parent's prompt says how to use children; a child, which cannot delegate, does not get it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const parentSystems: Array<string> = []
          const childSystems: Array<string> = []
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            if (promptTexts(options.prompt)[0]?.endsWith(childTask) === true) {
              childSystems.push(systemText(options.prompt))
              return Effect.succeed(reply("pong"))
            }
            parentSystems.push(systemText(options.prompt))
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "delegate the ping")
          yield* afterCompletion(harness)
          expect(parentSystems.length).toBeGreaterThan(0)
          expect(childSystems.length).toBeGreaterThan(0)
          for (const text of parentSystems) {
            expect(text).toContain("# Children")
            expect(text).toContain("# Sessions")
          }
          for (const text of childSystems) {
            expect(text).not.toContain("# Children")
            // A child still asks its parent with session.send.
            expect(text).toContain("# Sessions")
          }
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

describe("a forked child", () => {
  it.live(
    "starts from the parent's context window, minus the start call still in flight",
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
                toolStep("delegate.start", { todo: childTask, context: "fork" }, "fork-child"),
              )
            }
            if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, parentContext)
          const snapshot = yield* afterCompletion(harness)
          expect(messageTexts(snapshot.messages)).toContain("read it")
          const seen = Option.getOrThrow(childPrompt)
          // The child read the parent's user message, then its own task, which names its source.
          expect(promptTexts(seen)).toEqual([
            parentContext,
            childTaskText(harness.sessionId, childTask),
          ])
          expect(promptTexts(seen)[1]).toStartWith(
            `Task from your parent session ${harness.sessionId}.`,
          )
          // The start call had no result when the copy was taken, so the child never sees it.
          expect(promptToolCallIds(seen)).toEqual([])
          const child = yield* childOf(harness)
          const childSnapshot = yield* harness.client.session.getSnapshot(child)
          expect(messageTexts(childSnapshot.messages)).toContain(parentContext)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
  it.live(
    "with no answer reports neither the parent's reply nor the parent's calls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const parentReply = "PARENT-OWN-REPLY"
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            const calls = promptToolCallIds(options.prompt)
            // The forked child ends every step without writing anything.
            if (texts.some((text) => text.endsWith(childTask))) {
              return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
            }
            if (texts.at(-1) === "first") {
              if (calls.includes("rn-1")) return Effect.succeed(reply(parentReply))
              return Effect.succeed(toolStep("rename_session", { name: "parent work" }, "rn-1"))
            }
            if (texts.at(-1) === "second: fork a child") {
              if (calls.includes("fork-empty")) return Effect.succeed(reply("started, ending"))
              return Effect.succeed(
                toolStep("delegate.start", { todo: childTask, context: "fork" }, "fork-empty"),
              )
            }
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "first")
          yield* waitFor(
            harness.client.session.getSnapshot({
              sessionId: harness.sessionId,
              branchId: harness.branchId,
            }),
            (current) =>
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).includes(parentReply),
            5_000,
            "the parent's first turn ended",
          )
          yield* sendPrompt(harness, "second: fork a child")
          const snapshot = yield* afterCompletion(harness)
          const completion = completionMessages(snapshot.messages)[0]
          expect(messageTexts(completionMessages(snapshot.messages)).join("")).not.toContain(
            parentReply,
          )
          expect(completion?.metadata?.details).toMatchObject({ tools: [], toolCount: 0 })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

describe("session.send", () => {
  it.live("a child's message to its parent lands on the branch that owns the child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const report = "CHILD-REPORT: done"
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const texts = promptTexts(options.prompt)
          if (texts.some((text) => text.includes("report upward"))) {
            if (!promptToolCallIds(options.prompt).includes("send-up")) {
              return Effect.succeed(
                toolStep("session.send", { to: "parent", message: report }, "send-up"),
              )
            }
            return Effect.succeed(reply("sent"))
          }
          return Effect.succeed(reply("ack"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { client, sessionId, branchId } = harness
        const child = yield* client.session.create({
          cwd: "/tmp",
          parentSessionId: sessionId,
          parentBranchId: branchId,
        })
        // The person moves the parent to another branch while the child works.
        const other = yield* client.branch.create({ sessionId, name: "elsewhere" })
        yield* client.branch.switch({
          sessionId,
          fromBranchId: branchId,
          toBranchId: other.branchId,
        })
        yield* client.message.send({ ...child, content: "report upward" })
        const owning = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) =>
            current.runtime._tag === "Idle" &&
            sessionMessages(current.messages).some((message) =>
              messageTexts([message]).some((text) => text.includes(report)),
            ),
          5_000,
          "the report reached the branch that owns the child",
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

  it.live("a parent's message reaches a running child's next model step", () =>
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
            // The child's first step stays open until the parent's message lands.
            return Deferred.succeed(childStarted, void 0).pipe(
              Effect.andThen(Deferred.await(delivered)),
              Effect.as(reply("first pass done")),
            )
          }
          parentCalls += 1
          if (parentCalls === 1) {
            return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "bg-child"))
          }
          if (parentCalls === 2) {
            const to = Option.getOrThrow(startedSessionId(options.prompt))
            return Deferred.await(childStarted).pipe(
              Effect.as(toolStep("session.send", { to, message: correction }, "send-1")),
            )
          }
          return Deferred.succeed(delivered, void 0).pipe(Effect.as(reply("ack")))
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { client, sessionId, branchId } = harness
        yield* sendPrompt(harness, "split the work")
        yield* Deferred.await(childSawCorrection)
        // The parent hears a child once. The receipt must carry the answer the
        // child gave after it read the correction, not the one before.
        const snapshot = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) =>
            messageTexts(current.messages).some((text) => text.includes("narrowed to src/store")),
          3_000,
          "the child's completion carried its corrected answer",
        )
        expect(resultsOf("session.send", snapshot.messages)[0]).toMatchObject({
          isFailure: false,
          result: { relation: "child" },
        })
        const child = yield* childOf(harness)
        const childSnapshot = yield* client.session.getSnapshot(child)
        const [received] = sessionMessages(childSnapshot.messages)
        expect(received?.metadata?.details).toMatchObject({
          from: { sessionId, relation: "parent" },
        })
        expect(messageTexts([received!])[0]).toContain("Message from your parent")
        expect(messageTexts([received!])[0]).not.toContain("not its completion")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("a child's question wakes its idle parent, who answers in a turn of its own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let parentCalls = 0
        let childCalls = 0
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
            return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "bg-child"))
          }
          if (texts.some((text) => text.includes(question))) {
            return Effect.succeed(reply("ANSWER: sqlite"))
          }
          return Effect.succeed(reply("ack"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { client, sessionId, branchId } = harness
        yield* sendPrompt(harness, "split the work")
        const snapshot = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) =>
            messageTexts(current.messages).some((text) => text.includes("ANSWER: sqlite")),
          3_000,
          "the parent answered the child's question",
        )
        const [asked] = sessionMessages(snapshot.messages)
        expect(asked?.metadata?.details).toMatchObject({ from: { relation: "child" } })
        expect(messageTexts([asked!])[0]).toContain("Message from your child")
        // A question mid-turn must not read as the child being done.
        expect(messageTexts([asked!])[0]).toContain("this message is not one")
        // The question was a turn of its own: the parent's last user text before the answer.
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
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("a message to a finished child wakes it for another turn", () =>
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
            return Deferred.succeed(childAnsweredTwice, void 0).pipe(Effect.as(reply("done again")))
          }
          parentCalls += 1
          if (parentCalls === 1) {
            return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "bg-done"))
          }
          // The completion message has arrived once the parent is asked again.
          if (
            texts.some((text) => text.includes("requestId bg-done")) &&
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
        // One completion per start: the child's second turn wakes nobody.
        expect(completionMessages(snapshot.messages).length).toBe(1)
      }).pipe(Effect.timeout("4 seconds")),
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

// ── delegate/later-turns ────────────────────────────────────────────────────

/**
 * Only a child's first turn returns as its completion. A child that arms a
 * wake, a monitor or a goal runs later turns nobody waits for, so its task
 * tells it to send each later result to its parent with session.send.
 */

describe("a child's later turn", () => {
  it.live(
    "a child that arms a wake completes, and the wake's result reaches the parent",
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
              // The wake's turn: a model that follows its task sends the result upward.
              const told = texts[0].includes("A later turn started by one of them returns nothing")
              if (told && !ids.includes("send-later")) {
                return Effect.succeed(
                  toolStep("session.send", { to: "parent", message: laterResult }, "send-later"),
                )
              }
              return Effect.succeed(reply("checked CI"))
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "wake-child"))
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
            "the child's later result reached the parent",
          )
          // The completion came first, at the end of the turn that armed the wake.
          const [completion] = completionMessages(snapshot.messages)
          expect(messageTexts([completion!])[0]).toContain("armed a wake for CI")
          const [later] = sessionMessages(snapshot.messages)
          expect(later?.metadata?.details).toMatchObject({ from: { relation: "child" } })
          expect(snapshot.messages.indexOf(completion!)).toBeLessThan(
            snapshot.messages.indexOf(later!),
          )
          // The completion already landed: the later message must not promise one.
          const laterText = messageTexts([later!])[0] ?? ""
          expect(laterText).not.toContain("still running")
          expect(laterText).not.toContain("arrives as a separate message")
          expect(laterText).toContain("child-completion message; this message is not one")
          expect(completionMessages(snapshot.messages)).toHaveLength(1)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── delegate/start-turn ─────────────────────────────────────────────────────

/**
 * The loop writes user-role lines inside a turn: a continuation after an
 * empty or cut-off step, the max-steps instruction before the last step, a
 * model-change notice, and a mid-turn compaction marker. None opens a turn,
 * so the completion reads past them to the child's real answer.
 */

/** A parent that starts one child with `overrides`, and a child scripted step by step. */
const scriptedChild = (
  childStep: (call: number) => ReturnType<typeof reply>,
  overrides: Record<string, unknown> = {},
) => {
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
      return Effect.succeed(toolStep("delegate.start", { todo: childTask, overrides }, "start-1"))
    }
    return Effect.succeed(reply("ack"))
  })
}

const completionText = (harness: Harness) =>
  afterCompletion(harness).pipe(
    Effect.map((snapshot) => {
      const [completion] = completionMessages(snapshot.messages)
      return { text: messageTexts([completion!]).join(""), details: completion?.metadata?.details }
    }),
  )

describe("a child's start turn with runtime lines", () => {
  it.live(
    "an empty first step and its continuation still return the child's answer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* harnessWithHome(
            scriptedChild((call) => {
              if (call === 1) return Stream.make(finishPart({ finishReason: "stop" }))
              return reply("CHILD-FINAL-ANSWER")
            }),
          )
          yield* sendPrompt(harness, "delegate this task")
          const { text } = yield* completionText(harness)
          expect(text).toContain(`Child agent "${DELEGATE_AGENT_NAME}" completed.`)
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
            scriptedChild((call) => {
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
          const { text } = yield* completionText(harness)
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
            scriptedChild(
              (call) => {
                if (call === 1) {
                  return toolStep("read", { path: "/tmp/no-such-file-for-a-child" }, "child-read")
                }
                return reply("ANSWER-AT-BUDGET")
              },
              { maxSteps: 2 },
            ),
          )
          yield* sendPrompt(harness, "delegate this task")
          const { text, details } = yield* completionText(harness)
          expect(text).toContain("ANSWER-AT-BUDGET")
          expect(details).toMatchObject({ toolCount: 1 })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

describe("the start turn's messages", () => {
  const line = (id: string, role: "user" | "assistant", metadata?: Record<string, unknown>) => ({
    id: MessageId.make(id),
    role,
    ...Record.filter({ metadata }, Predicate.isNotUndefined),
  })
  const startId = MessageId.make("delegate-start:start-1")
  const ids = (messages: ReadonlyArray<{ readonly id: string }>) => messages.map((m) => m.id)

  test.each(["continuation", "context-window", "max-steps", "model-change", "steering"])(
    "a %s line inside the turn does not end it",
    (customType) => {
      const messages = [
        line("seed", "assistant"),
        line(startId, "user"),
        line("a1", "assistant"),
        line("runtime", "user", { customType }),
        line("a2", "assistant"),
      ]
      expect(ids(startTurnMessages(messages, startId))).toEqual([startId, "a1", "runtime", "a2"])
    },
  )

  test("a message joined into the running turn does not end it", () => {
    const messages = [
      line(startId, "user"),
      line("steer", "user", { customType: "session-message", joinedTurn: true }),
      line("a1", "assistant"),
    ]
    expect(ids(startTurnMessages(messages, startId))).toEqual([startId, "steer", "a1"])
  })

  test("a message that opens a later turn ends it", () => {
    const messages = [
      line(startId, "user"),
      line("a1", "assistant"),
      line("wake", "user", { customType: "wake" }),
      line("a2", "assistant"),
    ]
    expect(ids(startTurnMessages(messages, startId))).toEqual([startId, "a1"])
  })

  test("a branch without the start message has no start turn", () => {
    expect(startTurnMessages([line("a1", "assistant")], startId)).toEqual([])
  })
})
