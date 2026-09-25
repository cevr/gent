import { describe, expect, it, test } from "effect-bun-test"
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Predicate,
  Record,
  Ref,
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
} from "../src/delegate.js"
import {
  defineExtension,
  ExtensionHost,
  LoadedArtifactIdentity,
  type ModelPricing,
  RequestId,
} from "@gent/core/extensions/api"
import {
  ApprovalService,
  createE2ELayer,
  createRpcClient,
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
  turnRequestText,
  waitFor,
  ConfigService,
  RuntimeEnvironment,
  UserConfig,
} from "@gent/core/test-utils"
import {
  BranchId,
  DEFAULT_AGENT_NAME,
  ModelId,
  SessionId,
  SteerCommand,
  ToolCallId,
} from "@gent/core/protocol"
import { e2ePreset, shippedPreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"
import * as AiError from "effect/unstable/ai/AiError"
import type * as Prompt from "effect/unstable/ai/Prompt"

// ── delegate harness ────────────────────────────────────────────────────────

/**
 * Every test here runs a real child through the public facade. The registry
 * the extension keeps is read back from the temp home so each assertion sees
 * what a restarted process would.
 */

const registryCodec = Schema.fromJsonString(Schema.Array(DelegateEntry))
const decodeRegistry = Schema.decodeUnknownSync(registryCodec)
const encodeRegistry = Schema.encodeSync(registryCodec)
/** A missing registry file is the empty registry, as the store reads it. */
const storedRegistry = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(file))) return decodeRegistry("[]")
    return decodeRegistry(yield* fs.readFileString(file))
  })
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

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
    const home = yield* makeTempDirectoryScoped("delegate-")
    const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
    const harness = yield* createRpcHarness({
      ...e2ePreset,
      extensionInputs: [...e2ePreset.extensionInputs, ...(options.fixtures ?? [])],
      providerLayer,
      extraLayers: [RuntimeEnvironment.Live({ cwd, home })],
      ...Record.filter(
        {
          modelPricing: options.modelPricing,
          configServiceLayer: Option.map(
            Option.fromUndefinedOr(options.config),
            ConfigService.Test,
          ).pipe(Option.getOrUndefined),
          // `dialogs` presents approvals to the client instead of auto-approving them.
          approvalLayer: Option.getOrUndefined(
            Option.liftPredicate(ApprovalService.Live, () => options.dialogs === true),
          ),
        },
        Predicate.isNotUndefined,
      ),
    })
    const fs = yield* FileSystem.FileSystem
    const registryOf = (branchId: BranchId) =>
      storedRegistry(`${home}/.gent/delegates/${branchId}.json`).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      )
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

/** The prompt's system text, where standing extension prompt sections land. */
const systemText = (prompt: Prompt.Prompt): string => turnRequestText(prompt).systemPrompt

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

// ── child completion ────────────────────────────────────────────────────────

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

  // A parent that reads only "model stream failed" cannot tell a sign-in that
  // will never work from a flake, and starts the same child again and again.
  it.live(
    "a child whose model stream failed hands its parent the error that ended it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const reason = "CHILD-AUTH-PROBE: the keychain is locked"
          const parentPrompts: Array<ReadonlyArray<string>> = []
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              return Effect.fail(
                AiError.make({
                  module: "ChildProvider",
                  method: "streamText",
                  reason: new AiError.AuthenticationError({ kind: "Unknown", description: reason }),
                }),
              )
            }
            parentCalls += 1
            parentPrompts.push(texts)
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterCompletion(harness)
          const [completion] = completionMessages(snapshot.messages)
          const text = messageTexts(completionMessages(snapshot.messages)).join("")
          expect(text).toContain("ended (model stream failed)")
          expect(text).toContain(reason)
          expect(completion?.metadata?.details).toMatchObject({
            outcome: { streamFailed: true },
            error: expect.stringContaining(reason),
          })
          // The parent's model reads the reason in the turn the completion woke.
          expect(parentPrompts.at(-1)?.some((line) => line.includes(reason))).toBe(true)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a long error reaches the parent as one line of at most 1,000 characters",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const reason = `CHILD-LONG-ERROR ${"word ".repeat(600)}`
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              return Effect.fail(
                AiError.make({
                  module: "ChildProvider",
                  method: "streamText",
                  reason: new AiError.AuthenticationError({ kind: "Unknown", description: reason }),
                }),
              )
            }
            parentCalls += 1
            if (parentCalls === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterCompletion(harness)
          const [completion] = completionMessages(snapshot.messages)
          const decoded = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))(
            completion?.metadata?.details,
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

  it.live(
    "the completion carries the child's whole bill: tokens, cache reads and writes, and cost",
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
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            return Effect.succeed(reply("ack"))
          })
          const harness = yield* harnessWithHome(providerLayer, {
            // Dollars per million tokens.
            modelPricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          })
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterCompletion(harness)
          const [completion] = completionMessages(snapshot.messages)
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
          )(completion?.metadata?.details)
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
  // bill. A completion written by the hook must match the one recovery writes
  // from the child's `TurnCompleted` receipt, or a crash changes the record.
  it.live(
    "a child that ends before its first model step reports no usage, as its receipt does",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* harnessWithHome(startThenEnd("pong"), {
            config: new UserConfig({
              agents: {
                // The window cannot hold the child's context: the turn ends before a step.
                [DELEGATE_AGENT_NAME]: { contextLength: 10 },
              },
            }),
          })
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterCompletion(harness)
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
          const [completion] = completionMessages(snapshot.messages)
          const details = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ usage: Schema.optional(Schema.Unknown) }),
          )(completion?.metadata?.details)
          expect(Option.fromUndefinedOr(details.usage)).toEqual(Option.none())
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

  it.live(
    "a child whose command needs an approval is declined at once, completes, and wakes its parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // `rm -f` asks for an approval; no user sees a child, so no one could give it.
          const guarded = "rm -f /tmp/gent-child-approval-probe"
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              if (!promptToolCallIds(options.prompt).includes("guarded-bash")) {
                return Effect.succeed(toolStep("bash", { command: guarded }, "guarded-bash"))
              }
              return Effect.succeed(reply("CHILD: the command was blocked"))
            }
            if (!promptToolCallIds(options.prompt).includes("start-1")) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          yield* sendPrompt(harness, "delegate this task")
          const snapshot = yield* afterCompletion(harness)
          const [completion] = completionMessages(snapshot.messages)
          expect(messageTexts([completion!])[0]).toContain("CHILD: the command was blocked")
          expect(messageTexts(snapshot.messages)).toContain("read it")
          const child = yield* childOf(harness)
          const childSnapshot = yield* harness.client.session.getSnapshot(child)
          expect(childSnapshot.runtime._tag).toBe("Idle")
          // The child reads why, how to report it, and that no message grants it.
          expect(resultsOf("bash", childSnapshot.messages)[0]).toMatchObject({
            result: {
              status: "blocked",
              stdout: expect.stringMatching(
                /the way this turn reports its result[\s\S]*No message can grant it/,
              ),
            },
          })
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a user who prompts a child directly gets a real approval; the child's task turn still declines",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const guarded = "rm -f /tmp/gent-child-direct-approval-probe"
          const userPrompt = "USER: run the guarded command here"
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            const called = promptToolCallIds(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              if (texts.includes(userPrompt)) {
                if (!called.includes("user-bash")) {
                  return Effect.succeed(toolStep("bash", { command: guarded }, "user-bash"))
                }
                return Effect.succeed(reply("CHILD: ran it for the user"))
              }
              if (!called.includes("task-bash")) {
                return Effect.succeed(toolStep("bash", { command: guarded }, "task-bash"))
              }
              return Effect.succeed(reply("CHILD: the command was blocked"))
            }
            if (!called.includes("start-1")) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* harnessWithHome(providerLayer, { dialogs: true })
          yield* sendPrompt(harness, "delegate this task")
          yield* afterCompletion(harness)
          const child = yield* childOf(harness)
          // The task turn, which `delegate.start` opened, declined at once.
          const afterTask = yield* harness.client.session.getSnapshot(child)
          expect(resultsOf("bash", afterTask.messages)[0]).toMatchObject({
            result: { status: "blocked" },
          })
          // The user switches to the child and prompts it: a user watches that turn.
          const presented = yield* harness.client.session.events(child).pipe(
            Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* harness.client.message.send({ ...child, content: userPrompt })
          const dialog = Array.from(yield* Fiber.join(presented))[0]?.event
          if (dialog?._tag !== "InteractionPresented") return yield* Effect.die("no dialog")
          expect(dialog.text).toContain(guarded)
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
            "the child ran the approved command for the user",
          )
          expect(resultsOf("bash", afterUser.messages)[1]).toMatchObject({
            result: { exitCode: 0 },
          })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a top-level session's wake turn that runs a guarded command gets a real approval",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const guarded = "rm -f /tmp/gent-top-level-wake-approval-probe"
          const note = "WAKE: run the guarded command"
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            const called = promptToolCallIds(options.prompt)
            if (texts.some((text) => text.includes(note))) {
              if (!called.includes("wake-bash")) {
                return Effect.succeed(toolStep("bash", { command: guarded }, "wake-bash"))
              }
              return Effect.succeed(reply("ran it on the wake"))
            }
            if (!called.includes("set-wake")) {
              return Effect.succeed(toolStep("wake", { afterSeconds: 0.2, note }, "set-wake"))
            }
            return Effect.succeed(reply("alarm set"))
          })
          const harness = yield* harnessWithHome(providerLayer, { dialogs: true })
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
          expect(dialog.text).toContain(guarded)
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
            "the wake turn ran the approved command",
          )
          expect(resultsOf("bash", after.messages)[0]).toMatchObject({ result: { exitCode: 0 } })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── child completion message ────────────────────────────────────────────────

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

  test("puts the error a failed turn ended on in the header, not in the output", () => {
    const rendered = describeChildCompletion({
      requestId: RequestId.make("child-request"),
      agentName: DELEGATE_AGENT_NAME,
      sessionId: SessionId.make("child-session"),
      branchId: BranchId.make("child-branch"),
      outcome: { streamFailed: true },
      text: "the child output",
      error: "sign-in failed",
    })
    const [header = "", output = ""] = rendered.split("\n\n")
    expect(header).toContain("Error: sign-in failed")
    expect(output).toBe("the child output")
    expect(Option.getOrThrow(readChildCompletionHeadline(rendered)).status).toBe(
      "ended (model stream failed)",
    )
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
    const [source, later, approvals, blank, task] = childTaskText(
      SessionId.make("parent-1"),
      "do it",
    ).split("\n")
    expect(source).toContain("Your final reply in this turn is your result")
    expect(source).toContain("do not also send it with session.send")
    // A question in this turn is the reply too, so the parent is woken once.
    expect(source).toContain("end it with your question as that reply")
    expect(source).not.toContain("Use session.send in this turn")
    // A turn the parent's answer starts returns nothing either.
    expect(later).toContain(
      'Any later turn (a message from your parent, a wake, a monitor, a goal) returns nothing by itself: send its result or question with session.send to "parent"',
    )
    expect(later).not.toContain("send each one")
    // A "go ahead" cannot grant an approval, so the child does not ask again.
    expect(approvals).toContain("no message from your parent can grant it")
    expect(approvals).toContain("the parent runs it or gives you another way")
    expect(blank).toBe("")
    expect(task).toBe("do it")
  })

  test("text that is not an envelope reads as nothing", () => {
    expect(Option.isNone(readChildCompletionHeadline("plain answer"))).toBe(true)
  })
})

// ── parent interrupt ────────────────────────────────────────────────────────

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

  // The live run: an interrupt stopped three children, and the parent's next
  // turn said "Tasks 4–6 are still running". The stop wakes nobody, so the
  // next turn the user starts reads a notice, until a turn answers.
  it.live(
    "tells the parent's next turn which children it stopped, without starting a turn",
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
          const parentRequests: Array<{
            readonly system: string
            readonly notices: string
            readonly last: string
          }> = []
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true)
              return Effect.succeed(stalled("working", childStreaming))
            parentRequests.push({
              system: systemText(options.prompt),
              notices: noticeText(options.prompt),
              last: texts.at(-1) ?? "",
            })
            if (parentRequests.length === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            if (parentRequests.length === 2)
              return Effect.succeed(stalled("planning", parentStreaming))
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
              requestId: RequestId.make("interrupt-parent-for-stop-notice"),
            }),
          })
          yield* waitFor(
            harness.registryOf(branchId),
            (entries) => entries[0]?.delivered === true,
            3_000,
            "the parent's interrupt settled the child's row",
          )
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            3_000,
            "the parent is idle",
          )
          // The stop started no turn: only the two requests of the interrupted turn ran.
          expect(parentRequests).toHaveLength(2)

          yield* sendPrompt(harness, "WHAT-IS-RUNNING")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" && messageTexts(current.messages).includes("ack"),
            3_000,
            "the parent answered the next prompt",
          )
          const next = parentRequests[2]
          expect(next?.last).toBe("WHAT-IS-RUNNING")
          // The notice rides after the conversation; the system prompt is the
          // one the turns before it sent.
          expect(next?.system).toBe(parentRequests[0]?.system)
          expect(next?.notices).toContain("# Stopped children")
          expect(next?.notices).toContain(childTask)
          expect(next?.notices).toContain(child.sessionId)
          // The user's interrupt stopped them: the notice asks for a report, not a restart.
          expect(next?.notices).toContain("Tell the user which children stopped")
          expect(next?.notices).toContain("only when the user asks for it")
          expect(next?.notices).not.toContain("Start a new child")

          // The answered turn read the notice; the one after it does not see it again.
          yield* sendPrompt(harness, "AND-NOW")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).filter((text) => text === "ack").length === 2,
            3_000,
            "the parent answered the prompt after",
          )
          expect(parentRequests).toHaveLength(4)
          expect(parentRequests[3]?.notices).toBe("")
          expect(parentRequests[3]?.system).toBe(parentRequests[0]?.system)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live("keeps the notice through a turn that never answers", () =>
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
        const { branchId } = harness
        yield* harness.writeRegistry(branchId, [stoppedRow(1, 1_000)])
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

  it.live("keeps a notice the turn could not read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const restores: Array<Effect.Effect<void>> = []
        const systems: Array<{ readonly notices: string; readonly last: string }> = []
        const providerLayer = LanguageModelLayers.testStream((options) =>
          Effect.gen(function* () {
            // The projection already ran: the registry reads again from here on.
            yield* Effect.all(restores.splice(0), { discard: true })
            const last = promptTexts(options.prompt).at(-1) ?? ""
            systems.push({ notices: noticeText(options.prompt), last })
            return reply("ack")
          }),
        )
        const harness = yield* harnessWithHome(providerLayer)
        const { branchId } = harness
        const fs = yield* FileSystem.FileSystem
        const file = `${harness.home}/.gent/delegates/${branchId}.json`
        yield* harness.writeRegistry(branchId, [stoppedRow(1, 1_000)])
        const valid = yield* fs.readFileString(file)
        yield* fs.writeFileString(file, "{ unreadable")
        restores.push(fs.writeFileString(file, valid).pipe(Effect.orDie))
        yield* sendPrompt(harness, "UNREAD")
        yield* turnEnd(harness, 1)
        expect(systems[0]?.notices).not.toContain("# Stopped children")

        yield* sendPrompt(harness, "NEXT")
        yield* turnEnd(harness, 2)
        const next = systems.find((request) => request.last === "NEXT")
        expect(next?.notices).toContain(noticeLine(1))
      }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("8 seconds")),
    ),
  )

  it.live("names a bounded number of stopped children, one line each, and clears only those", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const systems: Array<string> = []
        const providerLayer = LanguageModelLayers.testStream((options) => {
          systems.push(noticeText(options.prompt))
          return Effect.succeed(reply("ack"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { branchId } = harness
        // Twelve children; child 12 was stopped twice, so it has two rows.
        const rows = [
          ...Array.from({ length: 12 }, (_, index) => stoppedRow(index + 1, 1_000 + index)),
          { ...stoppedRow(12, 2_000), requestId: RequestId.make("stopped-12-again") },
        ]
        yield* harness.writeRegistry(branchId, rows)
        yield* sendPrompt(harness, "FIRST")
        yield* turnEnd(harness, 1)
        const first = systems[0] ?? ""
        const named = first.split("\n").filter((line) => line.startsWith('- "'))
        // The newest eight, child 12 once, and a count of the rest.
        expect(named).toHaveLength(8)
        expect(named.filter((line) => line.includes("stopped task 12"))).toHaveLength(1)
        expect(first).toContain(noticeLine(12))
        expect(first).toContain(noticeLine(5))
        expect(first).not.toContain(noticeLine(4))
        expect(first).toContain("and 4 more stopped children")

        yield* sendPrompt(harness, "SECOND")
        yield* turnEnd(harness, 2)
        const second = systems.at(-1) ?? ""
        expect(second).toContain(noticeLine(4))
        // The answered turn cleared the notices it named, both of child 12's rows too.
        expect(second).not.toContain("stopped task 12")
        expect(second).not.toContain(noticeLine(5))
        expect(second).not.toContain("more stopped children")
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )
})

/** A child the parent's interrupt stopped, planted with an unread stop notice. */
const stoppedRow = (n: number, stopNoticeAt: number): DelegateEntry => ({
  requestId: RequestId.make(`stopped-${n}`),
  sessionId: SessionId.make(`stopped-session-${n}`),
  branchId: BranchId.make(`stopped-branch-${n}`),
  agentName: DELEGATE_AGENT_NAME,
  prompt: `stopped task ${n}\nsecond line`,
  private: false,
  submitted: true,
  completed: { interrupted: true },
  delivered: true,
  stopNoticeAt,
})

const noticeLine = (n: number) => `- "stopped task ${n}" · session stopped-session-${n}`

/** The receipt of the parent's `count`th turn. */
const turnEnd = (harness: Harness, count: number) =>
  harness.client.session.events({ sessionId: harness.sessionId, branchId: harness.branchId }).pipe(
    Stream.map((envelope) => envelope.event),
    Stream.filter((event) => event._tag === "TurnCompleted"),
    Stream.take(count),
    Stream.runLast,
    Effect.map(Option.getOrUndefined),
  )

// ── background starts ───────────────────────────────────────────────────────

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
          // The completion is sent before its row is written.
          const [entry] = yield* waitFor(
            harness.registryOf(branchId),
            (entries) => entries[0]?.delivered === true,
            3_000,
            "the recovered child's row is written",
          )
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
            parentSessionId: sessionId,
            parentBranchId: branchId,
            admission: { agent: DELEGATE_AGENT_NAME, runSpec },
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

  test("a registry row an older binary wrote, private, claimed and previewed, still decodes", () => {
    // The bytes an older binary wrote: a private extraction child its waiter still claimed,
    // with the preview a deleted client view read.
    const row = Schema.decodeSync(registryCodec)(
      `[{"requestId":"run:old-child","sessionId":"old-child","branchId":"old-child-branch","agentName":"${DELEGATE_AGENT_NAME}","prompt":"a side question","private":true,"submitted":true,"delivered":false,"waiter":"waiter:a-process-that-is-gone","preview":"the child's last words"}]`,
    )
    expect(row[0]?.requestId).toBe(RequestId.make("run:old-child"))
    expect(row[0]?.private).toBe(true)
  })
})

// ── pending cap ─────────────────────────────────────────────────────────────

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

  it.live(
    "delegate.list reads a running child's row and sends its start no second time",
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
            return Effect.succeed(toolStep("delegate.list", {}, "list-1"))
          })
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
          // The parent's loop is open and reconciled in this process.
          yield* sendPrompt(harness, "one")
          yield* idleAfter("first")
          // A child whose start was sent and has no receipt: it runs. Its
          // start is planted as sent with no message, so a re-send shows.
          const child = yield* client.session.create({
            parentSessionId: sessionId,
            parentBranchId: branchId,
          })
          yield* harness.writeRegistry(branchId, [
            {
              requestId: RequestId.make("running-start"),
              sessionId: child.sessionId,
              branchId: child.branchId,
              agentName: DELEGATE_AGENT_NAME,
              prompt: childTask,
              private: false,
              submitted: true,
              delivered: false,
            },
          ])
          yield* sendPrompt(harness, "list them")
          yield* idleAfter("listed")
          // The listing sent the child nothing, and its row still waits for a receipt.
          expect(yield* client.message.list(child)).toHaveLength(0)
          const [entry] = yield* harness.registryOf(branchId)
          expect(entry).toMatchObject({ submitted: true, delivered: false })
          expect(entry?.completed).toBeUndefined()
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
    "a completion recovered on the parent's next turn still names the error its child ended on",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const reason = "CHILD-AUTH-PROBE: recovered after a failed hook"
          const gate = yield* Deferred.make<void>()
          let parentCalls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              return Deferred.await(gate).pipe(
                Effect.andThen(
                  Effect.fail(
                    AiError.make({
                      module: "ChildProvider",
                      method: "streamText",
                      reason: new AiError.AuthenticationError({
                        kind: "Unknown",
                        description: reason,
                      }),
                    }),
                  ),
                ),
              )
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
          // The child's hook cannot write the registry, so reconcile delivers.
          const fs = yield* FileSystem.FileSystem
          const file = `${harness.home}/.gent/delegates/${branchId}.json`
          yield* fs.chmod(file, 0o000)
          yield* Deferred.succeed(gate, void 0)
          yield* waitFor(
            client.session.getSnapshot({ sessionId: row.sessionId, branchId: row.branchId }),
            (child) => child.runtime._tag === "Idle" && child.metrics.turns > 0,
            5_000,
            "the child's turn failed and its delivery failed",
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
          const [completion] = completionMessages(snapshot.messages)
          expect(messageTexts(completionMessages(snapshot.messages)).join("")).toContain(reason)
          expect(completion?.metadata?.details).toMatchObject({
            outcome: { streamFailed: true },
            error: expect.stringContaining(reason),
          })
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

  // The shipped composition: a cell turn, project instructions in the cwd. The
  // child denies session.send, so a section that follows the tool set would
  // differ here if it sat in the shared part.
  it.live(
    "a fresh child's prompt opens with its parent's shared part, byte for byte, whatever tools it denies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const home = yield* makeTempDirectoryScoped("delegate-shared-home-")
          const cwd = yield* makeTempDirectoryScoped("delegate-shared-cwd-")
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
              const code = `await tools.delegate.start({ todo: "${childTask}", overrides: { deniedTools: ["session.send"] } })`
              return Effect.succeed(toolStep("cell", { code }, "cell-start-1"))
            }
            if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* createRpcHarness({
            ...shippedPreset,
            providerLayer,
            cwd,
            extraLayers: [RuntimeEnvironment.Live({ cwd, home })],
          })
          yield* harness.client.message.send({
            sessionId: harness.sessionId,
            branchId: harness.branchId,
            content: "delegate the ping",
          })
          yield* waitFor(
            Effect.sync(() => childBlocks.length),
            (count) => count > 0,
            8_000,
            "the child sent its first request",
          )
          const [parentShared = "", parentOwn = ""] = parentBlocks[0] ?? []
          const [childShared = "", childOwn = ""] = childBlocks[0] ?? []
          // The shared part: persona, project instructions.
          expect(childShared).toBe(parentShared)
          expect(parentShared).toContain("PROJECT-RULE")
          // The agent's own part follows it: the cell guide, the sessions and
          // children guidance, the host tools.
          const own = ["# Working in the cell", "# Sessions", "# Children", "## Host Tools"]
          for (const section of own) {
            expect(parentShared).not.toContain(section)
            expect(parentOwn).toContain(section)
          }
          expect(childOwn).not.toContain("# Sessions")
        }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("14 seconds")),
      ),
    16_000,
  )

  // The tool list, the tool guidelines and the cell guide follow the tool set,
  // so they are the agent's own part.
  it.live(
    "a fresh child with other tools than its parent still opens with its parent's shared part",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const home = yield* makeTempDirectoryScoped("delegate-tools-home-")
          const cwd = yield* makeTempDirectoryScoped("delegate-tools-cwd-")
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
              const input = `{ todo: "${childTask}", overrides: { deniedTools: ["cell"] } }`
              const code = `await tools.delegate.start(${input})`
              return Effect.succeed(toolStep("cell", { code }, "cell-start-1"))
            }
            if (parentCalls === 2) return Effect.succeed(reply("started, ending my turn"))
            return Effect.succeed(reply("read it"))
          })
          const harness = yield* createRpcHarness({
            ...shippedPreset,
            providerLayer,
            cwd,
            extraLayers: [RuntimeEnvironment.Live({ cwd, home })],
          })
          yield* harness.client.message.send({
            sessionId: harness.sessionId,
            branchId: harness.branchId,
            content: "delegate the ping",
          })
          yield* waitFor(
            Effect.sync(() => childBlocks.length),
            (count) => count > 0,
            8_000,
            "the child sent its first request",
          )
          const [parentShared = "", parentOwn = ""] = parentBlocks[0] ?? []
          const [childShared = "", childOwn = ""] = childBlocks[0] ?? []
          expect(childShared).toBe(parentShared)
          expect(parentShared).toContain("PROJECT-RULE")
          // The parent works in the cell; the child, denied it, calls tools natively.
          expect(parentOwn).toContain("# Working in the cell")
          expect(childOwn).not.toContain("# Working in the cell")
          expect(childOwn).toContain("## Available Tools")
          // Every later step of the parent sends the same shared block.
          for (const blocks of parentBlocks) expect(blocks[0]).toBe(parentShared)
        }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("14 seconds")),
      ),
    16_000,
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
  // The child's task names its parent's id, so a model may address it by id.
  const addresses: ReadonlyArray<readonly [string, (parent: string) => string]> = [
    ["parent", () => "parent"],
    ["the parent's id", (parent) => parent],
  ]
  for (const [addressed, address] of addresses)
    it.live(`a child's message to ${addressed} lands on the branch that owns the child`, () =>
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
          const child = yield* client.session.create({
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
          // The sender names its branch: the one whose interrupt stops a turn the message opens.
          from: { sessionId, branchId, relation: "parent" },
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

// ── a parent interrupt and its session.send turns ───────────────────────────

/**
 * A parent's session.send can open a turn in a child whose delegate run has
 * settled, so the delegate registry does not own it. The live run showed one
 * such turn still running after the user's Ctrl-C. The sender owns it: its
 * interrupted turn stops that turn, takes back a message no step has read,
 * and tells its next turn which child it stopped.
 */

/** A stream that opens, says so, and never ends: a turn that is still running. */
const stalledStream = (text: string, opened: Deferred.Deferred<void>) =>
  Stream.make(textDeltaPart(text)).pipe(
    Stream.concat(Stream.fromEffect(Deferred.succeed(opened, void 0)).pipe(Stream.drain)),
    Stream.concat(Stream.never),
  )

/** The branch's turn receipts, from its durable history. */
const turnReceipts = (
  harness: Harness,
  target: { readonly sessionId: SessionId; readonly branchId: BranchId },
) =>
  harness.client.session.events(target).pipe(
    Stream.takeUntil((envelope) => envelope.event._tag === "StreamSynchronized"),
    Stream.flatMap((envelope) => {
      if (envelope.event._tag !== "TurnCompleted") return Stream.empty
      return Stream.make(envelope.event)
    }),
    Stream.runCollect,
    Effect.map((receipts) => Array.from(receipts)),
  )

const interruptParent = (harness: Harness, requestId: string) =>
  harness.client.steer.command({
    command: SteerCommand.make({
      _tag: "Cancel",
      sessionId: harness.sessionId,
      branchId: harness.branchId,
      requestId: RequestId.make(requestId),
    }),
  })

const idle = (
  harness: Harness,
  target: { readonly sessionId: SessionId; readonly branchId: BranchId },
  label: string,
) =>
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

/** One model request's answer, as `LanguageModelLayers.testStream` takes it. */
type ModelReply = ReturnType<Parameters<typeof LanguageModelLayers.testStream>[0]>

/**
 * The parent: start one child, end the turn, and on the child's completion
 * send it the correction, then keep its own turn open. `beforeSend` holds the
 * send until a test has the child where it wants it.
 */
const correctFinishedChild = (options: {
  readonly child: (texts: ReadonlyArray<string>) => ModelReply
  readonly parentStreaming: Deferred.Deferred<void>
  readonly beforeSend?: Effect.Effect<void>
  readonly parentRequests: Array<{ readonly notices: string; readonly last: string }>
}) =>
  LanguageModelLayers.testStream((request) => {
    const texts = promptTexts(request.prompt)
    if (texts[0]?.endsWith(childTask) === true) return options.child(texts)
    const last = texts.at(-1) ?? ""
    options.parentRequests.push({ notices: noticeText(request.prompt), last })
    const ids = promptToolCallIds(request.prompt)
    if (last.startsWith("NEXT-")) return Effect.succeed(reply("ack"))
    if (!ids.includes("start-1")) {
      return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
    }
    if (!texts.some((text) => text.includes("requestId start-1"))) {
      return Effect.succeed(reply("started, ending my turn"))
    }
    if (!ids.includes("send-fix")) {
      const to = Option.getOrThrow(startedSessionId(request.prompt))
      return (options.beforeSend ?? Effect.void).pipe(
        Effect.as(toolStep("session.send", { to, message: correction }, "send-fix")),
      )
    }
    return Effect.succeed(stalledStream("waiting on the child", options.parentStreaming))
  })

describe("a parent interrupt and the turns its session.send opened", () => {
  it.live(
    "stops the turn a correction opened in a finished child, and the next turn names that child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childCorrecting = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const parentRequests: Array<{ readonly notices: string; readonly last: string }> = []
          const providerLayer = correctFinishedChild({
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
          yield* interruptParent(harness, "interrupt-parent-of-corrected-child")

          const receipts = yield* waitFor(
            turnReceipts(harness, child),
            (current) => current.length === 2,
            3_000,
            "the parent's interrupt ended the child's correction turn",
          )
          expect(receipts[1]).toMatchObject({ interrupted: true })
          yield* idle(harness, child, "the child is idle")
          yield* idle(harness, { sessionId, branchId }, "the parent is idle")

          yield* sendPrompt(harness, "NEXT-WHAT-IS-RUNNING")
          yield* waitFor(
            harness.client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" && messageTexts(current.messages).includes("ack"),
            3_000,
            "the parent answered the next prompt",
          )
          const next = parentRequests.find((request) => request.last === "NEXT-WHAT-IS-RUNNING")
          expect(next?.notices).toContain(child.sessionId)
          expect(next?.notices).toContain("session.send")

          // The answered turn read the notice; the turn after it does not see it.
          yield* sendPrompt(harness, "NEXT-AND-NOW")
          yield* waitFor(
            harness.client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).filter((text) => text === "ack").length === 2,
            3_000,
            "the parent answered the prompt after",
          )
          const after = parentRequests.find((request) => request.last === "NEXT-AND-NOW")
          expect(after?.notices ?? "").not.toContain(child.sessionId)
        }).pipe(Effect.timeout("12 seconds")),
      ),
    14_000,
  )

  it.live("a correction that still waits in a running child at the interrupt never runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childStreaming = yield* Deferred.make<void>()
        const parentStreaming = yield* Deferred.make<void>()
        let correctionRuns = 0
        let parentCalls = 0
        const providerLayer = LanguageModelLayers.testStream((request) => {
          const texts = promptTexts(request.prompt)
          if (texts[0]?.endsWith(childTask) === true) {
            if (texts.some((text) => text.includes(correction))) {
              correctionRuns += 1
              return Effect.succeed(reply("corrected"))
            }
            // The child's first turn never reaches a step boundary, so the
            // correction waits in its queue.
            return Effect.succeed(stalledStream("working", childStreaming))
          }
          parentCalls += 1
          if (parentCalls === 1) {
            return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
          }
          if (parentCalls === 2) {
            const to = Option.getOrThrow(startedSessionId(request.prompt))
            return Effect.succeed(toolStep("session.send", { to, message: correction }, "send-fix"))
          }
          return Effect.succeed(stalledStream("waiting on the child", parentStreaming))
        })
        const harness = yield* harnessWithHome(providerLayer)
        yield* sendPrompt(harness, "delegate one task")
        yield* Deferred.await(childStreaming)
        yield* Deferred.await(parentStreaming)
        const child = yield* childOf(harness)
        yield* interruptParent(harness, "interrupt-parent-with-waiting-correction")

        yield* waitFor(
          turnReceipts(harness, child),
          (current) => current.length >= 1,
          3_000,
          "the parent's interrupt ended the child's first turn",
        )
        yield* idle(harness, child, "the child is idle")
        yield* idle(harness, harness, "the parent is idle")
        expect(correctionRuns).toBe(0)
        expect(yield* turnReceipts(harness, child)).toHaveLength(1)
      }).pipe(Effect.timeout("10 seconds")),
    ),
  )

  it.live("a child the interrupt stopped with a correction waiting in it is named once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childStreaming = yield* Deferred.make<void>()
        const parentStreaming = yield* Deferred.make<void>()
        const parentRequests: Array<{ readonly notices: string; readonly last: string }> = []
        let parentCalls = 0
        const providerLayer = LanguageModelLayers.testStream((request) => {
          const texts = promptTexts(request.prompt)
          if (texts[0]?.endsWith(childTask) === true) {
            if (texts.some((text) => text.includes(correction))) {
              return Effect.succeed(reply("corrected"))
            }
            return Effect.succeed(stalledStream("working", childStreaming))
          }
          const last = texts.at(-1) ?? ""
          parentRequests.push({ notices: noticeText(request.prompt), last })
          if (last.startsWith("NEXT-")) return Effect.succeed(reply("ack"))
          parentCalls += 1
          if (parentCalls === 1) {
            return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
          }
          if (parentCalls === 2) {
            const to = Option.getOrThrow(startedSessionId(request.prompt))
            return Effect.succeed(toolStep("session.send", { to, message: correction }, "send-fix"))
          }
          return Effect.succeed(stalledStream("waiting on the child", parentStreaming))
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { sessionId, branchId } = harness
        yield* sendPrompt(harness, "delegate one task")
        yield* Deferred.await(childStreaming)
        yield* Deferred.await(parentStreaming)
        const child = yield* childOf(harness)
        yield* interruptParent(harness, "interrupt-parent-with-waiting-correction-once")
        yield* idle(harness, child, "the child is idle")
        yield* idle(harness, { sessionId, branchId }, "the parent is idle")

        yield* sendPrompt(harness, "NEXT-WHAT-IS-RUNNING")
        yield* waitFor(
          harness.client.session.getSnapshot({ sessionId, branchId }),
          (current) =>
            current.runtime._tag === "Idle" && messageTexts(current.messages).includes("ack"),
          3_000,
          "the parent answered the next prompt",
        )
        const next = parentRequests.find((request) => request.last === "NEXT-WHAT-IS-RUNNING")
        // The delegate stop names the child; the correction went with its turn.
        expect(next?.notices).toContain("# Stopped children")
        expect(next?.notices).not.toContain("# Stopped child turns")
        expect(next?.notices.split(child.sessionId)).toHaveLength(2)
      }).pipe(Effect.timeout("10 seconds")),
    ),
  )

  it.live("a correction turn that ended before the interrupt is not named as stopped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parentStreaming = yield* Deferred.make<void>()
        const parentRequests: Array<{ readonly notices: string; readonly last: string }> = []
        const providerLayer = correctFinishedChild({
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
          "the child answered the correction",
        )
        yield* idle(harness, child, "the child is idle")
        yield* interruptParent(harness, "interrupt-parent-after-correction-ended")
        yield* idle(harness, { sessionId, branchId }, "the parent is idle")

        yield* sendPrompt(harness, "NEXT-WHAT-IS-RUNNING")
        yield* waitFor(
          harness.client.session.getSnapshot({ sessionId, branchId }),
          (current) =>
            current.runtime._tag === "Idle" && messageTexts(current.messages).includes("ack"),
          3_000,
          "the parent answered the next prompt",
        )
        const next = parentRequests.find((request) => request.last === "NEXT-WHAT-IS-RUNNING")
        expect(next?.notices ?? "").not.toContain(child.sessionId)
        expect(yield* turnReceipts(harness, child)).toHaveLength(2)
      }).pipe(Effect.timeout("10 seconds")),
    ),
  )

  it.live(
    "a correction turn the user already stopped is not named as stopped by the parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childCorrecting = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const childEnding = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const held = yield* Ref.make(Option.none<SessionId>())
          const parentRequests: Array<{ readonly notices: string; readonly last: string }> = []
          const providerLayer = correctFinishedChild({
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
          // The user stops the child's correction turn first; its end is held
          // open while the parent is interrupted.
          yield* harness.client.steer.command({
            command: SteerCommand.make({
              _tag: "Cancel",
              ...child,
              requestId: RequestId.make("interrupt-child-before-parent"),
            }),
          })
          yield* Deferred.await(childEnding)
          yield* interruptParent(harness, "interrupt-parent-after-user-stopped-child")
          yield* idle(harness, { sessionId, branchId }, "the parent is idle")
          yield* Deferred.succeed(release, void 0)
          yield* idle(harness, child, "the child is idle")
          const receipts = yield* turnReceipts(harness, child)
          expect(receipts[1]).toMatchObject({ interrupted: true })

          yield* sendPrompt(harness, "NEXT-WHAT-IS-RUNNING")
          yield* waitFor(
            harness.client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" && messageTexts(current.messages).includes("ack"),
            3_000,
            "the parent answered the next prompt",
          )
          const next = parentRequests.find((request) => request.last === "NEXT-WHAT-IS-RUNNING")
          expect(next).toBeDefined()
          expect(next?.notices ?? "").not.toContain(child.sessionId)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a turn a user opened in the child keeps running, and the waiting correction is taken back",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userTurnOpen = yield* Deferred.make<void>()
          const userGate = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const parentRequests: Array<{ readonly notices: string; readonly last: string }> = []
          let correctionRuns = 0
          const providerLayer = correctFinishedChild({
            parentStreaming,
            parentRequests,
            // The parent sends only once the user's turn in the child is open.
            beforeSend: Deferred.await(userTurnOpen),
            child: (texts) => {
              if (texts.some((text) => text.includes(correction))) {
                correctionRuns += 1
                return Effect.succeed(reply("corrected"))
              }
              if (texts.at(-1) === "USER-ASKS-CHILD") {
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
            "the child's delegate run ended",
          )
          yield* idle(harness, child, "the child is idle")
          yield* harness.client.message.send({ ...child, content: "USER-ASKS-CHILD" })
          yield* Deferred.await(parentStreaming)
          yield* interruptParent(harness, "interrupt-parent-while-user-drives-child")
          yield* idle(harness, harness, "the parent is idle")

          const running = yield* harness.client.session.getSnapshot(child)
          expect(running.runtime._tag).toBe("Running")
          expect(yield* turnReceipts(harness, child)).toHaveLength(1)

          yield* Deferred.succeed(userGate, void 0)
          yield* idle(harness, child, "the user's turn in the child ended")
          const receipts = yield* turnReceipts(harness, child)
          expect(receipts).toHaveLength(2)
          expect(receipts[1]?.interrupted).not.toBe(true)
          expect(correctionRuns).toBe(0)
        }).pipe(Effect.timeout("10 seconds")),
      ),
  )

  it.live(
    "a correction taken back from a child turn the user already stops is named to the parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userTurnOpen = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const childEnding = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const held = yield* Ref.make(Option.none<SessionId>())
          const parentRequests: Array<{ readonly notices: string; readonly last: string }> = []
          let correctionRuns = 0
          const providerLayer = correctFinishedChild({
            parentStreaming,
            parentRequests,
            // The parent sends only once the user's turn in the child is open.
            beforeSend: Deferred.await(userTurnOpen),
            child: (texts) => {
              if (texts.some((text) => text.includes(correction))) {
                correctionRuns += 1
                return Effect.succeed(reply("corrected"))
              }
              // The user's turn never reaches a step boundary, so the
              // correction waits in its queue.
              if (texts.at(-1) === "USER-ASKS-CHILD") {
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
            "the child's delegate run ended",
          )
          yield* idle(harness, child, "the child is idle")
          yield* harness.client.message.send({ ...child, content: "USER-ASKS-CHILD" })
          yield* Deferred.await(parentStreaming)
          yield* Ref.set(held, Option.some(child.sessionId))
          // The user stops the child's turn; its end is held open, so the
          // correction still waits to join a turn that is stopping.
          yield* harness.client.steer.command({
            command: SteerCommand.make({
              _tag: "Cancel",
              ...child,
              requestId: RequestId.make("user-stops-child-with-correction-waiting"),
            }),
          })
          yield* Deferred.await(childEnding)
          yield* interruptParent(harness, "interrupt-parent-takes-correction-back")
          yield* idle(harness, { sessionId, branchId }, "the parent is idle")
          yield* Deferred.succeed(release, void 0)
          yield* idle(harness, child, "the child is idle")
          expect(correctionRuns).toBe(0)

          yield* sendPrompt(harness, "NEXT-WHAT-IS-RUNNING")
          yield* waitFor(
            harness.client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" && messageTexts(current.messages).includes("ack"),
            3_000,
            "the parent answered the next prompt",
          )
          const next = parentRequests.find((request) => request.last === "NEXT-WHAT-IS-RUNNING")
          // The user's stop is the child's own news; the lost correction is the parent's.
          expect(next?.notices).toContain("# Stopped child turns")
          expect(next?.notices.split(child.sessionId)).toHaveLength(2)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── a parent interrupt as a child finishes ──────────────────────────────────

describe("a parent interrupt as a child finishes", () => {
  it.live(
    "a child whose turn completed before the stop reached it keeps its completion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childGo = yield* Deferred.make<void>()
          const parentStreaming = yield* Deferred.make<void>()
          const childEnding = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const held = yield* Ref.make(Option.none<SessionId>())
          const parentRequests: Array<{ readonly notices: string; readonly last: string }> = []
          const providerLayer = LanguageModelLayers.testStream((request) => {
            const texts = promptTexts(request.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              return Deferred.await(childGo).pipe(Effect.as(reply("pong")))
            }
            parentRequests.push({ notices: noticeText(request.prompt), last: texts.at(-1) ?? "" })
            if (parentRequests.length === 1) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
            }
            if (parentRequests.length === 2) {
              return Effect.succeed(stalledStream("waiting on the child", parentStreaming))
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
          // The child's turn completed and its receipt is stored; its end is
          // held open before the delegate hook reads it.
          yield* Deferred.await(childEnding)
          yield* interruptParent(harness, "interrupt-parent-as-child-finishes")
          // The parent's interrupt has run its cascade: the parent is idle, or
          // the child's completion already woke it.
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" || completionMessages(current.messages).length > 0,
            3_000,
            "the parent's interrupt ran its cascade",
          )
          yield* Deferred.succeed(release, void 0)
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              completionMessages(current.messages).length === 1 &&
              messageTexts(current.messages).includes("ack"),
            5_000,
            "the child's completion woke the parent and the parent read it",
          )
          // The completion is sent before its row is written.
          const [row] = yield* waitFor(
            harness.registryOf(branchId),
            (entries) => Predicate.isUndefined(entries[0]?.stopNoticeAt),
            3_000,
            "the child's completion row is written",
          )
          expect(row).toMatchObject({ delivered: true, completed: {} })
          expect(row?.stopNoticeAt).toBeUndefined()
          const woken = parentRequests.at(-1)
          expect(woken?.last).toContain("pong")
          expect(woken?.notices ?? "").not.toContain("# Stopped children")
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a session whose parent's registry cannot be read still stops its own children",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const grandchildStreaming = yield* Deferred.make<void>()
          const middleStreaming = yield* Deferred.make<void>()
          const providerLayer = LanguageModelLayers.testStream((request) => {
            const texts = promptTexts(request.prompt)
            if (texts[0]?.endsWith(childTask) === true) {
              return Effect.succeed(stalledStream("working", grandchildStreaming))
            }
            if (!promptToolCallIds(request.prompt).includes("start-g")) {
              return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-g"))
            }
            return Effect.succeed(stalledStream("waiting on the child", middleStreaming))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          // The middle session is a child of the harness session, and its
          // parent's registry is unreadable, so its turn end fails as a child.
          const middle = yield* client.session.create({
            parentSessionId: sessionId,
            parentBranchId: branchId,
          })
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(`${harness.home}/.gent/delegates`, { recursive: true })
          yield* fs.writeFileString(`${harness.home}/.gent/delegates/${branchId}.json`, "not json")
          yield* client.message.send({ ...middle, content: "MIDDLE-PROMPT" })
          yield* Deferred.await(grandchildStreaming)
          yield* Deferred.await(middleStreaming)
          const sessions = yield* client.session.list()
          const grandchild = sessions.find(
            (session) => session.parentSessionId === middle.sessionId,
          )
          if (Predicate.isUndefined(grandchild?.activeBranchId)) {
            return yield* Effect.die("no grandchild session")
          }
          const target = { sessionId: grandchild.id, branchId: grandchild.activeBranchId }
          yield* client.steer.command({
            command: SteerCommand.make({
              _tag: "Cancel",
              ...middle,
              requestId: RequestId.make("interrupt-middle"),
            }),
          })
          const receipts = yield* waitFor(
            turnReceipts(harness, target),
            (current) => current.length === 1,
            3_000,
            "the middle session's interrupt stopped its child",
          )
          expect(receipts[0]).toMatchObject({ interrupted: true })
        }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── child later turns ───────────────────────────────────────────────────────

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
              const told = texts[0].includes("Any later turn (a message from your parent")
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

// ── child start turn ────────────────────────────────────────────────────────

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

// ── a restart mid-child ─────────────────────────────────────────────────────

/**
 * Two processes over one file database and one home: the first stops while
 * its children run, the second is the restarted server. Each process lives
 * in its own scope.
 */
const restartableHome = Effect.gen(function* () {
  const home = yield* makeTempDirectoryScoped("delegate-restart-")
  const cwd = yield* makeTempDirectoryScoped("gent-test-cwd-")
  const fs = yield* FileSystem.FileSystem
  const layerFor = (providerLayer: Parameters<typeof createRpcHarness>[0]["providerLayer"]) =>
    createE2ELayer({
      ...e2ePreset,
      providerLayer,
      storagePath: `${home}/gent.db`,
      extraLayers: [RuntimeEnvironment.Live({ cwd, home })],
    })
  const registryOf = (branchId: BranchId) =>
    storedRegistry(`${home}/.gent/delegates/${branchId}.json`).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    )
  const writeRegistry = (branchId: BranchId, entries: ReadonlyArray<DelegateEntry>) =>
    fs.writeFileString(`${home}/.gent/delegates/${branchId}.json`, encodeRegistry(entries))
  return { layerFor, registryOf, writeRegistry }
}).pipe(Effect.provide(BunFileSystem.layer))

type RestartableHome = Effect.Success<typeof restartableHome>

/**
 * First process: the parent starts one child per todo and ends its turn.
 * Every child's model call hangs, so the process stops with all of them
 * mid-turn. Returns the parent once each child is running and the parent is
 * idle.
 */
const stopWithRunningChildren = (home: RestartableHome, todos: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const running = yield* Deferred.make<void>()
      let childCalls = 0
      let parentCalls = 0
      const providerLayer = LanguageModelLayers.testStream((options) => {
        const texts = promptTexts(options.prompt)
        if (todos.some((todo) => texts[0]?.endsWith(todo) === true)) {
          childCalls += 1
          if (childCalls < todos.length) return Effect.never
          return Deferred.succeed(running, void 0).pipe(Effect.andThen(Effect.never))
        }
        parentCalls += 1
        if (parentCalls > 1) return Effect.succeed(reply("started, ending my turn"))
        return Effect.succeed(
          Stream.fromIterable([
            ...todos.map((todo, index) =>
              toolCallPart(
                "delegate.start",
                { todo },
                { toolCallId: ToolCallId.make(`start-${index + 1}`) },
              ),
            ),
            finishPart({ finishReason: "tool-calls" }),
          ]),
        )
      })
      const { client } = yield* createRpcClient(home.layerFor(providerLayer))
      const created = yield* client.session.create({})
      const parent = { sessionId: created.sessionId, branchId: created.branchId }
      yield* client.message.send({ ...parent, content: "delegate these" })
      yield* Deferred.await(running)
      yield* waitFor(
        client.session.getSnapshot(parent),
        (current) =>
          current.runtime._tag === "Idle" &&
          messageTexts(current.messages).includes("started, ending my turn"),
        5_000,
        "the parent ended its turn with its children running",
      )
      return parent
    }),
  )

describe("a child running when the server stopped", () => {
  it.live(
    "resumes when the parent opens, and its completion wakes the parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          const parent = yield* stopWithRunningChildren(home, [childTask])
          const [stuck] = yield* home.registryOf(parent.branchId)
          expect(stuck).toMatchObject({ submitted: true, delivered: false })
          expect(stuck?.completed).toBeUndefined()

          const providerLayer = LanguageModelLayers.testStream((options) => {
            if (promptTexts(options.prompt)[0]?.endsWith(childTask) === true) {
              return Effect.succeed(reply("pong"))
            }
            return Effect.succeed(reply("read it"))
          })
          const { client } = yield* createRpcClient(home.layerFor(providerLayer))
          const snapshot = yield* waitFor(
            client.session.getSnapshot(parent),
            (current) =>
              completionMessages(current.messages).length === 1 &&
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).includes("read it"),
            8_000,
            "the resumed child's completion woke the parent",
          )
          expect(messageTexts(completionMessages(snapshot.messages)).join("\n")).toContain("pong")
          const [entry] = yield* home.registryOf(parent.branchId)
          expect(entry).toMatchObject({ submitted: true, delivered: true })
          expect(entry?.completed).toEqual({})
        }).pipe(Effect.timeout("20 seconds")),
      ),
    25_000,
  )

  it.live(
    "stops counting toward the cap once it resumes, so a full branch can start another",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          const todos = [1, 2, 3, 4].map((n) => `CHILD-TASK-${n}: reply with pong`)
          const parent = yield* stopWithRunningChildren(home, todos)
          const stuck = yield* home.registryOf(parent.branchId)
          expect(stuck.filter((entry) => Predicate.isUndefined(entry.completed))).toHaveLength(4)

          const fifth = "CHILD-TASK-5: reply with pong"
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if ([...todos, fifth].some((todo) => texts[0]?.endsWith(todo) === true)) {
              return Effect.succeed(reply("pong"))
            }
            const asked = texts.includes("START-FIFTH")
            if (asked && !promptToolCallIds(options.prompt).includes("start-5")) {
              return Effect.succeed(toolStep("delegate.start", { todo: fifth }, "start-5"))
            }
            return Effect.succeed(reply("read it"))
          })
          const { client } = yield* createRpcClient(home.layerFor(providerLayer))
          yield* waitFor(
            client.session.getSnapshot(parent),
            (current) =>
              completionMessages(current.messages).length === 4 && current.runtime._tag === "Idle",
            10_000,
            "all four resumed children completed",
          )
          yield* client.message.send({ ...parent, content: "START-FIFTH" })
          const settled = yield* waitFor(
            client.session.getSnapshot(parent),
            (current) =>
              completionMessages(current.messages).length === 5 && current.runtime._tag === "Idle",
            10_000,
            "the fifth child was admitted and completed",
          )
          expect(cappedResults(settled.messages)).toHaveLength(0)
        }).pipe(Effect.timeout("30 seconds")),
      ),
    35_000,
  )

  it.live(
    "that finished before its start was marked sent still wakes the parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* restartableHome
          // First process: the child finishes, but the process stops before
          // its row was marked submitted and before its completion landed.
          // The row is held out of the file while the child's turn ends, so
          // the child's own hook finds nothing to deliver.
          const parent = yield* Effect.scoped(
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
                return Effect.succeed(toolStep("delegate.start", { todo: childTask }, "start-1"))
              })
              const { client } = yield* createRpcClient(home.layerFor(providerLayer))
              const created = yield* client.session.create({})
              const parent = { sessionId: created.sessionId, branchId: created.branchId }
              yield* client.message.send({ ...parent, content: "delegate this" })
              yield* Deferred.await(childCalled)
              yield* waitFor(
                client.session.getSnapshot(parent),
                (current) =>
                  current.runtime._tag === "Idle" &&
                  messageTexts(current.messages).includes("started, ending my turn"),
                5_000,
                "the parent ended its turn",
              )
              const [row] = yield* home.registryOf(parent.branchId)
              if (Predicate.isUndefined(row)) return yield* Effect.die("no child row")
              yield* home.writeRegistry(parent.branchId, [])
              yield* Deferred.succeed(release, void 0)
              yield* waitFor(
                client.session.getSnapshot({ sessionId: row.sessionId, branchId: row.branchId }),
                (current) =>
                  current.runtime._tag === "Idle" &&
                  messageTexts(current.messages).includes("pong"),
                5_000,
                "the child finished",
              )
              yield* home.writeRegistry(parent.branchId, [
                { ...row, submitted: false, delivered: false },
              ])
              const before = yield* client.session.getSnapshot(parent)
              expect(completionMessages(before.messages)).toHaveLength(0)
              return parent
            }),
          )

          // Second process: opening the parent reads the child's receipt and
          // delivers its completion.
          const providerLayer = LanguageModelLayers.testStream(() =>
            Effect.succeed(reply("read it")),
          )
          const { client } = yield* createRpcClient(home.layerFor(providerLayer))
          const snapshot = yield* waitFor(
            client.session.getSnapshot(parent),
            (current) =>
              completionMessages(current.messages).length === 1 &&
              current.runtime._tag === "Idle" &&
              messageTexts(current.messages).includes("read it"),
            8_000,
            "the finished child's completion woke the parent",
          )
          expect(messageTexts(completionMessages(snapshot.messages)).join("\n")).toContain("pong")
          const [entry] = yield* home.registryOf(parent.branchId)
          expect(entry).toMatchObject({ submitted: true, delivered: true })
        }).pipe(Effect.timeout("20 seconds")),
      ),
    25_000,
  )
})
