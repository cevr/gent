import { describe, expect, it } from "effect-bun-test"
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
import { ConfigService, RuntimeEnvironment, UserConfig } from "@gent/core-internal/runtime/config"
import { DELEGATE_AGENT_NAME, DelegateEntry, DelegateTool } from "../src/delegate.js"
import { DEFAULT_AGENT_NAME } from "@gent/core/extensions/api"
import { AllBuiltinAgents } from "./helpers/builtin-agents.js"
import {
  createRpcHarness,
  runToolWithCtx,
  testToolContext,
} from "@gent/core-internal/test-utils/index"
import {
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  multiToolCallStep,
  textDeltaPart,
  textStep,
  toolCallPart,
  toolCallStep,
  waitFor,
} from "@gent/core-internal/test-utils/language-model"
import { type BranchId, RequestId, ToolCallId } from "@gent/core-internal/domain/ids"
import { e2ePreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"
import { ModelId, SteerCommand } from "@gent/core-internal/domain/agent"
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
      extraLayers: [RuntimeEnvironment.Live({ cwd: "/tmp", home, platform: "darwin" })],
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
      if (Predicate.isUndefined(child)) return Effect.die("no child session")
      return Effect.succeed({ sessionId: child.id, branchId: child.activeBranchId })
    }),
  )

/** The first `delegate` tool result on the parent branch. */
const delegateResult = (harness: Harness) =>
  harness.client.session.events({ sessionId: harness.sessionId, branchId: harness.branchId }).pipe(
    Stream.filter(isToolResultFor("delegate")),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((events) => Array.from(events)[0]?.event),
    Effect.forkScoped,
  )

const reply = (text: string) =>
  Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })])

const toolStep = (name: string, input: Record<string, string | boolean>, id: string) =>
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

const sendPrompt = (harness: Harness, content: string) =>
  harness.client.message.send({
    sessionId: harness.sessionId,
    branchId: harness.branchId,
    content,
  })

// ── delegate/foreground ─────────────────────────────────────────────────────

/**
 * Foreground delegation runs a real child session and awaits it. The child's
 * loop state lands in the child's own storage (a write against the parent's
 * rows surfaced live as "Failed to persist loop queue"), and the parent's
 * registry lists the child under the tool call that owns it.
 */

describe("foreground delegation with a real child", () => {
  it.live(
    "returns the child's text, runs as the delegate agent, and is listed under its tool call",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("delegate", { todo: "Reply with the single word pong" }),
            textStep("pong"),
            textStep("child said pong"),
          ])
          const harness = yield* harnessWithHome(providerLayer)
          const resultFiber = yield* delegateResult(harness)
          yield* sendPrompt(harness, "delegate this task")
          const succeeded = yield* Fiber.join(resultFiber)
          expect(succeeded?._tag).toBe("ToolCallSucceeded")
          if (succeeded?._tag !== "ToolCallSucceeded") return
          expect(succeeded.output).not.toContain("Failed to persist")
          expect(parseJson(succeeded.output)).toMatchObject({
            _tag: "Completed",
            output: expect.stringContaining("pong"),
            metadata: { agentName: DELEGATE_AGENT_NAME },
          })

          const child = yield* childOf(harness)
          const [entry] = yield* harness.registryOf(harness.branchId)
          expect(entry).toMatchObject({
            sessionId: child.sessionId,
            branchId: child.branchId,
            agentName: DELEGATE_AGENT_NAME,
            toolCallId: succeeded.toolCallId,
            background: false,
            completed: { streamFailed: false },
            preview: "pong",
          })
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "the child runs the model paired in config for the delegate agent, not the caller's",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            {
              ...toolCallStep("delegate", { todo: "Reply with the single word pong" }),
              assertRequest: (request) => {
                expect(request.model).toBe("test/parent-model")
              },
            },
            {
              ...textStep("pong"),
              assertRequest: (request) => {
                expect(request.model).toBe("test/child-model")
                expect(request.reasoning).toBe("low")
              },
            },
            textStep("child said pong"),
          ])
          const harness = yield* harnessWithHome(providerLayer, {
            config: new UserConfig({
              agents: {
                [DEFAULT_AGENT_NAME]: { modelId: ModelId.make("test/parent-model") },
                [DELEGATE_AGENT_NAME]: {
                  modelId: ModelId.make("test/child-model"),
                  reasoningEffort: "low",
                },
              },
            }),
          })
          const resultFiber = yield* delegateResult(harness)
          yield* sendPrompt(harness, "delegate this task")
          const succeeded = yield* Fiber.join(resultFiber)
          expect(succeeded?._tag).toBe("ToolCallSucceeded")
          if (succeeded?._tag !== "ToolCallSucceeded") return
          // A child on the wrong model fails its request, which the parent reads as an Error result.
          expect(parseJson(succeeded.output)).toMatchObject({
            _tag: "Completed",
            output: expect.stringContaining("pong"),
          })
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live("a foreground child cannot delegate further", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childTools = yield* Deferred.make<ReadonlyArray<string>>()
        let calls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          calls += 1
          if (calls === 1) {
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart("delegate", { todo: "Try to delegate" }),
                finishPart({ finishReason: "tool-calls" }),
              ]),
            )
          }
          if (calls === 2) {
            return Deferred.succeed(
              childTools,
              options.tools.map((tool) => tool.name),
            ).pipe(Effect.as(reply("could not delegate")))
          }
          return Effect.succeed(reply("child finished"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        yield* sendPrompt(harness, "delegate this task")
        const tools = yield* Deferred.await(childTools)
        expect(tools).toContain("bash")
        expect(tools).not.toContain("delegate")
        expect(tools).not.toContain("agent-child")
        expect(tools).not.toContain("agent-children")
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )

  it.live(
    "a 300-char reply is clipped to one line in the registry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const longReply = "p".repeat(300)
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("delegate", { todo: "Reply with three hundred characters" }),
            textStep(longReply),
            textStep(longReply),
          ])
          const harness = yield* harnessWithHome(providerLayer)
          const resultFiber = yield* delegateResult(harness)
          yield* sendPrompt(harness, "delegate this task")
          yield* Fiber.join(resultFiber)
          const [entry] = yield* harness.registryOf(harness.branchId)
          expect(entry?.preview).toBe("p".repeat(200) + "…")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── delegate/foreground-interrupt ───────────────────────────────────────────

/**
 * A foreground delegation is owned by its tool call. When the parent turn is
 * interrupted the child must stop too: a child that keeps running has no
 * owner, and the parent's next turn can neither await nor cancel it. The
 * gamut testbed showed six such children editing files after an Escape.
 */

describe("foreground delegation under a parent interrupt", () => {
  it.live("interrupting the parent turn ends the child's turn as interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childStreaming = yield* Deferred.make<void>()
        let calls = 0
        const providerLayer = LanguageModelLayers.testStream(() => {
          calls += 1
          if (calls === 1) {
            return Effect.succeed(
              Stream.fromIterable([
                toolCallPart("delegate", { todo: "work that never finishes" }),
                finishPart({ finishReason: "tool-calls" }),
              ]),
            )
          }
          if (calls === 2) {
            // The child's stream opens and stalls: it is mid-turn when the
            // parent is interrupted.
            return Effect.succeed(
              Stream.make(textDeltaPart("working")).pipe(
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(childStreaming, void 0)).pipe(Stream.drain),
                ),
                Stream.concat(Stream.never),
              ),
            )
          }
          return Effect.succeed(
            Stream.fromIterable([textDeltaPart("ack"), finishPart({ finishReason: "stop" })]),
          )
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { client, sessionId, branchId } = harness
        yield* sendPrompt(harness, "delegate one task")
        yield* Deferred.await(childStreaming)
        const child = yield* childOf(harness)
        yield* client.steer.command({
          command: SteerCommand.make({
            _tag: "Interrupt",
            sessionId,
            branchId,
            requestId: RequestId.make("interrupt-parent-of-foreground-child"),
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
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

// ── delegate/background ─────────────────────────────────────────────────────

/**
 * Background delegation admits a durable child and returns at once. The
 * child's completion must come back as a message on the parent branch,
 * which wakes the parent for another turn. Nothing else carries the result.
 */

describe("background delegation with a real child", () => {
  it.live(
    "returns the handle under the tool call id; the completion lands on the parent branch and wakes it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The parent's turns and the child draw from one queue in scheduling
          // order, so route by prompt: the child alone answers its own task.
          const providerLayer = LanguageModelLayers.testStream((options) => {
            const texts = promptTexts(options.prompt)
            if (texts.includes("Reply with the single word pong")) {
              return Effect.succeed(reply("pong"))
            }
            if (texts.some((text) => text.startsWith("delegate this"))) {
              return Effect.succeed(
                toolStep(
                  "delegate",
                  { todo: "Reply with the single word pong", background: true },
                  "bg-child",
                ),
              )
            }
            return Effect.succeed(reply("parent read pong"))
          })
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          const resultFiber = yield* delegateResult(harness)
          yield* sendPrompt(harness, "delegate this task")
          const running = yield* Fiber.join(resultFiber)
          expect(running?._tag).toBe("ToolCallSucceeded")
          if (running?._tag !== "ToolCallSucceeded") return
          // The handle is keyed by the tool call, so a replayed call finds its child.
          expect(parseJson(running.output)).toMatchObject({
            _tag: "Running",
            requestId: "bg-child",
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "user" && message.metadata?.customType === "child-completion",
              ) && current.runtime._tag === "Idle",
            8_000,
            "child completion delivered to the parent",
          )
          const completion = snapshot.messages.find(
            (message) => message.metadata?.customType === "child-completion",
          )
          expect(completion).toBeDefined()
          // The completion woke the parent for a fresh turn.
          expect(snapshot.messages.some((message) => message.role === "assistant")).toBe(true)

          const child = yield* childOf(harness)
          const [entry] = yield* harness.registryOf(branchId)
          expect(entry).toMatchObject({
            requestId: "bg-child",
            ...child,
            background: true,
            submitted: true,
            delivered: true,
            completed: { interrupted: false, streamFailed: false, unanswered: false },
            preview: "pong",
          })
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live("refuses background delegation without a host-owned tool call", () =>
    Effect.gen(function* () {
      const ctx = Struct.omit(
        testToolContext({ Agent: { listAgents: Effect.succeed(AllBuiltinAgents) } }),
        ["toolCallId"],
      )
      const error = yield* runToolWithCtx(
        DelegateTool,
        { todo: "analyze the codebase", background: true, overrides: { deniedTools: ["bash"] } },
        ctx,
      ).pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "DelegateError",
        message: "Background delegation requires a host-owned tool call",
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
              agentName: DEFAULT_AGENT_NAME,
              prompt: "Reply with the single word pong",
              toolCallId: ToolCallId.make("crashed-tool"),
              background: true,
              submitted: false,
              delivered: false,
            },
          ])
          yield* sendPrompt(harness, "hello again")
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.messages.some(
                (message) => message.metadata?.customType === "child-completion",
              ) && current.runtime._tag === "Idle",
            8_000,
            "the recovered child delivered its completion",
          )
          expect(
            snapshot.messages.filter((m) => m.metadata?.customType === "child-completion"),
          ).toHaveLength(1)
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
})

// ── delegate/pending-cap ────────────────────────────────────────────────────

/**
 * The parent branch admits at most four unfinished background children. A
 * fifth and sixth delegation in the same step must fail as ordinary tool
 * results, not as a turn failure: the model reads the rejection and keeps
 * going. This is the shape that broke in the gamut testbed — six `delegate`
 * calls in one `Promise.all`, two over the cap — so the cap must reject the
 * extra children while the four admitted ones still run and deliver.
 */

const backgroundCall = (todo: string) => ({
  toolName: "delegate",
  input: { todo, background: true },
})

/**
 * The failed `delegate` results on the parent branch that name the cap. A
 * failed tool result carries its message in `result`, so the cap rejection is
 * readable model input rather than a dead turn.
 */
const cappedResults = (messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Prompt.Part> }>) =>
  messages
    .flatMap((message) => message.parts)
    .filter((part) => {
      if (part.type !== "tool-result" || part.name !== "delegate" || !part.isFailure) return false
      const result = part.result
      if (!Predicate.isReadonlyObject(result)) return false
      return String(result["error"]).includes("unfinished child starts")
    })

describe("background delegation over the pending-start cap", () => {
  it.live(
    "rejects the children past the cap as tool results and still runs the admitted four",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            multiToolCallStep(
              backgroundCall("Reply with the single word one"),
              backgroundCall("Reply with the single word two"),
              backgroundCall("Reply with the single word three"),
              backgroundCall("Reply with the single word four"),
              backgroundCall("Reply with the single word five"),
              backgroundCall("Reply with the single word six"),
            ),
            // The parent's follow-up turn and the four admitted children all
            // draw from this one queue, in whatever order they reach the model.
            ...Array.from({ length: 8 }, () => textStep("ack")),
          ])
          const harness = yield* harnessWithHome(providerLayer)
          const { client, sessionId, branchId } = harness
          yield* sendPrompt(harness, "delegate six tasks")

          // The two over-cap delegations come back as ordinary tool results on
          // the parent branch. A turn that died on the rejection would never
          // persist them.
          const afterAdmission = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => cappedResults(current.messages).length >= 2,
            10_000,
            "the capped delegations returned as tool results",
          )
          const rejected = cappedResults(afterAdmission.messages)
          // Two of the six are over the cap of four.
          expect(rejected).toHaveLength(2)

          // The four admitted children still deliver; the cap rejected the
          // extras without disturbing them.
          const settled = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.messages.filter(
                (message) => message.metadata?.customType === "child-completion",
              ).length >= 4 && current.runtime._tag === "Idle",
            20_000,
            "the four admitted children delivered their completions",
          )
          expect(
            settled.messages.filter(
              (message) => message.metadata?.customType === "child-completion",
            ),
          ).toHaveLength(4)
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )
})

// ── delegate/agent-child-send ───────────────────────────────────────────────

/**
 * The orchestrator can correct a child that is still working: `agent-child`
 * with `send` puts a message into the child's running turn, and the child's
 * next model step reads it. A finished child takes no more messages.
 */

const childTask = "CHILD-TASK: summarize the ledger"
const correction = "CORRECTION: only look at src/store"

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

const sendResults = (messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Prompt.Part> }>) =>
  messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool-result" && part.name === "agent-child")

describe("agent-child send", () => {
  it.live("a message sent to a running child reaches the child's next model step", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childStarted = yield* Deferred.make<void>()
        const delivered = yield* Deferred.make<void>()
        const childSawCorrection = yield* Deferred.make<void>()
        let parentCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const texts = promptTexts(options.prompt)
          // The child reads the task as its own user message; the parent only
          // carries it inside the delegate call's params.
          if (texts[0] === childTask) {
            if (texts.includes(correction)) {
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
            return Effect.succeed(
              toolStep("delegate", { todo: childTask, background: true }, "bg-child"),
            )
          }
          if (parentCalls === 2) {
            return Deferred.await(childStarted).pipe(
              Effect.as(
                toolStep(
                  "agent-child",
                  { action: "send", requestId: "bg-child", message: correction },
                  "send-1",
                ),
              ),
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
        expect(sendResults(snapshot.messages)[0]).toMatchObject({
          isFailure: false,
          result: { _tag: "Pending" },
        })
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("a finished child refuses the message as a tool result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let parentCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const texts = promptTexts(options.prompt)
          if (texts[0] === childTask) return Effect.succeed(reply("done"))
          parentCalls += 1
          if (parentCalls === 1) {
            return Effect.succeed(
              toolStep("delegate", { todo: childTask, background: true }, "bg-done"),
            )
          }
          // The completion message has arrived once the parent is asked again.
          if (
            texts.some((text) => text.includes("requestId bg-done")) &&
            !promptToolCallIds(options.prompt).includes("send-late")
          ) {
            return Effect.succeed(
              toolStep(
                "agent-child",
                { action: "send", requestId: "bg-done", message: correction },
                "send-late",
              ),
            )
          }
          return Effect.succeed(reply("ack"))
        })
        const harness = yield* harnessWithHome(providerLayer)
        const { client, sessionId, branchId } = harness
        yield* sendPrompt(harness, "split the work")
        const snapshot = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) => sendResults(current.messages).length === 1,
          3_000,
          "the late send returned a result",
        )
        expect(sendResults(snapshot.messages)[0]).toMatchObject({
          isFailure: true,
          result: { error: expect.stringContaining("already finished") },
        })
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})
