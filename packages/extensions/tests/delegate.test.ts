import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Fiber, Option, Predicate, Stream, Struct } from "effect"
import { narrowR } from "../../core/tests/helpers/effect"
import { DelegateTool } from "../src/delegate.js"
import {
  AgentDefinition,
  AgentName,
  AgentRunResult,
  DEFAULT_AGENT_NAME,
  type ExtensionContextService,
  ModelId,
} from "@gent/core/extensions/api"
import { AllBuiltinAgents } from "./helpers/builtin-agents.js"
import {
  createRpcHarness,
  runToolWithCtx,
  testToolContext,
} from "@gent/core-internal/test-utils/index"
import {
  finishPart,
  LanguageModelLayers,
  multiToolCallStep,
  textDeltaPart,
  textStep,
  toolCallPart,
  toolCallStep,
  waitFor,
} from "@gent/core-internal/test-utils/language-model"
import { BranchId, RequestId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { e2ePreset } from "./helpers/test-preset"
import { isToolResultFor } from "./helpers/tool-event.js"
import { SteerCommand } from "@gent/core-internal/domain/agent"
import type * as Prompt from "effect/unstable/ai/Prompt"

// ── delegate/delegate-tool.test ─────────────────────────────────────────────

const helperAgent = AgentDefinition.make({
  name: AgentName.make("helper"),
  model: ModelId.make("openai/gpt-5.4-mini"),
})

const makeCtx = (overrides: {
  agentName?: AgentName
  agentRun?: (
    params: Parameters<ExtensionContextService["Agent"]["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
}) =>
  testToolContext({
    agentName: overrides.agentName,
    Agent: {
      run:
        overrides.agentRun ??
        (() =>
          Effect.succeed(
            AgentRunResult.cases.Success.make({
              text: "",
              sessionId: SessionId.make("s1"),
              agentName: AgentName.make("test"),
            }),
          )),
      listAgents: Effect.succeed([...AllBuiltinAgents, helperAgent]),
    },
  })

describe("Delegate Tool", () => {
  it.live("delegates to a child running as the default agent and returns output", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed(
          AgentRunResult.cases.Success.make({
            text: `${params.agent.name}:${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
          }),
        ),
    })

    return narrowR(
      runToolWithCtx(DelegateTool, { todo: "hello" }, ctx).pipe(
        Effect.map((result) => {
          expect("output" in result).toBe(true)
          if (!("output" in result)) return
          expect(result.output).toBe(
            `${DEFAULT_AGENT_NAME}:hello\n\nFull session: session://child-session`,
          )
          const metadata = Option.fromUndefinedOr(result.metadata)
          if (Option.isSome(metadata) && "sessionId" in metadata.value) {
            expect(metadata.value.sessionId).toBe(SessionId.make("child-session"))
          }
        }),
      ),
    )
  })

  it.live("a foreground child cannot delegate further", () => {
    const runs: Array<ReadonlyArray<string>> = []
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.sync(() => {
          runs.push(params.runSpec?.overrides?.deniedTools ?? [])
          return AgentRunResult.cases.Success.make({
            text: "done",
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
          })
        }),
    })
    return narrowR(
      runToolWithCtx(DelegateTool, { todo: "hello" }, ctx).pipe(
        Effect.map(() => {
          expect(runs).toEqual([["delegate", "agent-child", "agent-children"]])
        }),
      ),
    )
  })

  it.live("child inherits the caller's agent from the tool context", () => {
    const ctx = makeCtx({
      agentName: helperAgent.name,
      agentRun: (params) =>
        Effect.succeed(
          AgentRunResult.cases.Success.make({
            text: `${params.agent.name}:${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
          }),
        ),
    })

    return narrowR(
      runToolWithCtx(DelegateTool, { todo: "hello" }, ctx).pipe(
        Effect.map((result) => {
          expect("output" in result).toBe(true)
          if (!("output" in result)) return
          expect(result.output).toBe("helper:hello\n\nFull session: session://child-session")
        }),
      ),
    )
  })

  it.live("foreground delegation ties the child to the calling tool call", () => {
    let capturedRunSpec = Option.none<{ parentToolCallId?: string }>()
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedRunSpec = Option.fromUndefinedOr(params.runSpec)
        return Effect.succeed(
          AgentRunResult.cases.Success.make({
            text: "ok",
            sessionId: SessionId.make("s"),
            agentName: params.agent.name,
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(DelegateTool, { todo: "go" }, ctx).pipe(
        Effect.map(() => {
          expect(
            Option.flatMap(capturedRunSpec, (runSpec) =>
              Option.fromUndefinedOr(runSpec.parentToolCallId),
            ),
          ).toEqual(Option.some(ctx.toolCallId))
        }),
      ),
    )
  })
})

// ── delegate/delegate-rpc.test ──────────────────────────────────────────────

/**
 * Delegate tool RPC acceptance test — exercises the `delegate` tool through
 * a real agent turn (LLM emits the tool call, runtime dispatches it inside
 * the per-request scope). The existing `delegate-tool.test.ts` calls the
 * executor directly via `runToolWithCtx`, which bypasses the scope boundary
 * production uses.
 *
 * Maps W36 C5 (audit L5-P2-1).
 */

describe("DelegateExtension via model turn", () => {
  it.live(
    "delegate tool call routes through per-request scope and returns subagent output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("delegate", { todo: "summarise repo layout" }),
            textStep("delegated"),
          ])
          const subagentRunner = {
            run: (params: { prompt: string; agent: { name: AgentName } }) =>
              Effect.succeed(
                AgentRunResult.cases.Success.make({
                  text: `subagent:${params.agent.name}:${params.prompt}`,
                  sessionId: SessionId.make("delegate-child-session"),
                  agentName: params.agent.name,
                }),
              ),
          }
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner,
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("delegate")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "delegate this task",
          })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).toContain(
              `subagent:${DEFAULT_AGENT_NAME}:summarise repo layout`,
            )
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── delegate/delegate-preview.test ──────────────────────────────────────────

/**
 * `AgentRunSucceeded.preview` has two producers: the in-process runner
 * (foreground delegate) and child-completion delivery (background
 * delegate). The agents pane reads both. One clip policy covers both.
 */

const longReply = "p".repeat(300)

const runSucceededPreview = (params: { readonly background: boolean }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("delegate", {
          todo: "Reply with three hundred characters",
          background: params.background,
        }),
        // The shared step queue serves the child and the parent's continuation
        // in whichever order they call, so every reply is the long one.
        textStep(longReply),
        textStep(longReply),
        textStep(longReply),
      ])
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        subagentRunner: "live",
      })
      const succeededFiber = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.map((envelope) => envelope.event),
        Stream.filter((event) => event._tag === "AgentRunSucceeded"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* client.message.send({ sessionId, branchId, content: "delegate this task" })
      const [succeeded] = Array.from(yield* Fiber.join(succeededFiber))
      expect(succeeded?._tag).toBe("AgentRunSucceeded")
      if (succeeded?._tag !== "AgentRunSucceeded") return Option.none<string>()
      return Option.fromUndefinedOr(succeeded.preview)
    }).pipe(Effect.timeout("8 seconds")),
  )

describe("agent run preview", () => {
  it.live(
    "a foreground child's 300-char reply is clipped with a marker",
    () =>
      Effect.gen(function* () {
        const preview = yield* runSucceededPreview({ background: false })
        expect(preview).toEqual(Option.some("p".repeat(200) + "…"))
      }),
    10_000,
  )
  it.live(
    "a background child's 300-char reply is clipped with the same marker",
    () =>
      Effect.gen(function* () {
        const preview = yield* runSucceededPreview({ background: true })
        expect(preview).toEqual(Option.some("p".repeat(200) + "…"))
      }),
    10_000,
  )
})

// ── delegate/delegate-background.test ───────────────────────────────────────

describe("DelegateTool background mode", () => {
  it.live("admits a durable child under the tool call id and returns its handle", () =>
    Effect.gen(function* () {
      const started: Array<{
        requestId: RequestId
        prompt: string
        deniedTools: ReadonlyArray<string>
      }> = []
      const ctx = testToolContext({
        toolCallId: ToolCallId.make("delegate-call"),
        Agent: {
          listAgents: Effect.succeed(AllBuiltinAgents),
          start: (params) =>
            Effect.sync(() => {
              started.push({
                requestId: params.requestId,
                prompt: params.prompt,
                deniedTools: params.runSpec?.overrides?.deniedTools ?? [],
              })
              return {
                sessionId: SessionId.make("child-session"),
                branchId: BranchId.make("child-branch"),
              }
            }),
        },
      })
      const result = yield* runToolWithCtx(
        DelegateTool,
        { todo: "analyze the codebase", background: true, overrides: { deniedTools: ["bash"] } },
        ctx,
      )
      // The handle returns now. The result arrives later as a message on the parent branch.
      expect(result).toEqual({
        _tag: "Running",
        requestId: RequestId.make("delegate-call"),
        sessionId: SessionId.make("child-session"),
        branchId: BranchId.make("child-branch"),
      })
      // The child keeps the caller's denials and cannot delegate further.
      expect(started).toEqual([
        {
          requestId: RequestId.make("delegate-call"),
          prompt: "analyze the codebase",
          deniedTools: ["delegate", "agent-child", "agent-children", "bash"],
        },
      ])
    }),
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
        _tag: "AgentRunError",
        message: "Background delegation requires a host-owned tool call",
      })
    }),
  )
})

// ── delegate/delegate-background-child.test ─────────────────────────────────

/**
 * Background delegation admits a durable child and returns at once. The
 * child's completion must come back as a message on the parent branch,
 * which wakes the parent for another turn. Nothing else carries the result.
 */

describe("background delegation with a real child", () => {
  it.live(
    "the child's completion lands on the parent branch and wakes it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("delegate", { todo: "Reply with the single word pong", background: true }),
            textStep("child started"),
            textStep("pong"),
            textStep("parent read pong"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner: "live",
          })
          yield* client.message.send({ sessionId, branchId, content: "delegate this task" })
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
          const last = snapshot.messages.at(-1)
          expect(last?.role).toBe("assistant")
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )
})

// ── delegate/delegate-foreground-child.test ─────────────────────────────────

/**
 * Foreground delegation runs a real child session. The child's loop
 * state must land in the child's own storage: a write against the
 * parent database has no matching session row and fails the foreign
 * key, which surfaced live as "Failed to persist loop queue".
 */

describe("foreground delegation with a real child", () => {
  it.live(
    "returns the child's text from a run of the current agent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("delegate", { todo: "Reply with the single word pong" }),
            textStep("pong"),
            textStep("child said pong"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner: "live",
          })

          const toolEventFiber = yield* client.session
            .events({ sessionId, branchId })
            .pipe(
              Stream.filter(isToolResultFor("delegate")),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

          yield* client.message.send({ sessionId, branchId, content: "delegate this task" })

          const events = Array.from(yield* Fiber.join(toolEventFiber))
          const succeeded = events.find((event) => event.event._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded?.event._tag === "ToolCallSucceeded") {
            expect(succeeded.event.output).not.toContain("Failed to persist")
            expect(succeeded.event.output).toContain("pong")
          }
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── delegate/delegate-foreground-interrupt.test ─────────────────────────────

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
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          subagentRunner: "live",
        })
        yield* client.message.send({ sessionId, branchId, content: "delegate one task" })
        const child = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.map((envelope) => envelope.event),
          Stream.filter((event) => event._tag === "AgentRunSpawned"),
          Stream.map((event) =>
            Option.map(Option.fromUndefinedOr(event.childBranchId), (childBranchId) => ({
              sessionId: event.childSessionId,
              branchId: childBranchId,
            })),
          ),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.flatten),
          Effect.flatMap(Effect.fromOption),
        )
        yield* Deferred.await(childStreaming)
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

// ── delegate/delegate-pending-cap.test ──────────────────────────────────────

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
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            subagentRunner: "live",
          })
          yield* client.message.send({ sessionId, branchId, content: "delegate six tasks" })

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

// ── delegate/agent-child-send.test ──────────────────────────────────────────

/**
 * The orchestrator can correct a child that is still working: `agent-child`
 * with `send` puts a message into the child's running turn, and the child's
 * next model step reads it. A finished child takes no more messages.
 */

const childTask = "CHILD-TASK: summarize the ledger"
const correction = "CORRECTION: only look at src/store"

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
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          subagentRunner: "live",
        })
        yield* client.message.send({ sessionId, branchId, content: "split the work" })
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
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          subagentRunner: "live",
        })
        yield* client.message.send({ sessionId, branchId, content: "split the work" })
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
