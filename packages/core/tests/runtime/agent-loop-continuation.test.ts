import { describe, expect, test } from "effect-bun-test"
import { Effect, Fiber, Ref, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { LanguageModelLayers } from "@gent/core/test-utils/language-model"
import { textStep, toolCallStep } from "@gent/core/debug/provider"
import { dateFromMillis, Message } from "@gent/core/domain/message"
import { tool } from "@gent/core/extensions/api"
import type { AgentEvent } from "@gent/core/domain/event"
import { MessageStorage } from "@gent/core/storage/message-storage"
import { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import {
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "../../src/runtime/agent/agent-loop.utils"
import {
  makeAgentLoopService,
  makeLayer,
  makeLayerWithEvents,
  runAgentLoop,
  steerAgentLoop,
  waitForPhase,
} from "./agent-loop/helpers"

describe("continuation", () => {
  const contSessionId = SessionId.make("cont-test-session")
  const contBranchId = BranchId.make("cont-test-branch")
  let messageSequence = 0
  const makeContMessage = (text: string) =>
    Message.Regular.make({
      id: MessageId.make(`msg-${messageSequence++}`),
      sessionId: contSessionId,
      branchId: contBranchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })
  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (_params) => Effect.succeed({ text: _params.text }),
  })
  test("tool call auto-continues to next LLM call", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "hello" }),
        textStep("Done with tools."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("test auto-continue"))
        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))
  test("text-only response does not trigger continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("Just text, no tools."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("text only"))
        expect(yield* controls.callCount).toBe(1)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))
  test("multi-hop tool calls chain until text response", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        toolCallStep("echo", { text: "step 3" }),
        textStep("Finally done."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("multi-hop"))
        expect(yield* controls.callCount).toBe(4)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))
  test("TurnCompleted fires once per turn, not per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Done."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("turn-events"))
        expect(yield* controls.callCount).toBe(3)
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        expect(turnCompleted.length).toBe(1)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))
  test("interrupt during tool execution stops continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("Continuation response."), gated: true },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const fiber = yield* Effect.forkChild(
          runAgentLoop(agentLoop, makeContMessage("interrupt test")),
        )
        yield* controls.waitForCall(1)
        yield* steerAgentLoop({
          _tag: "Interrupt",
          sessionId: contSessionId,
          branchId: contBranchId,
        })
        yield* controls.emitAll(1)
        yield* Fiber.join(fiber)
        expect(yield* controls.callCount).toBe(2)
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        expect(turnCompleted.length).toBe(1)
        const tc = turnCompleted[0] as {
          interrupted?: boolean
        }
        expect(tc.interrupted).toBe(true)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))
  test("GUARD: ToolsFinished without interrupt routes to Resolving", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "tool" }),
        textStep("Continuation reached."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("structural guard"))
        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone()
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((e) => e._tag === "TurnCompleted").length).toBe(1)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))
  test("GUARD: multi-hop persists distinct messages per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Final answer."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const msg = makeContMessage("multi-hop persistence")
        yield* runAgentLoop(agentLoop, msg)
        const a1 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 1))
        const t1 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 1))
        expect(a1).toBeDefined()
        expect(t1).toBeDefined()
        expect(a1!.role).toBe("assistant")
        expect(t1!.role).toBe("tool")
        const a2 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 2))
        const t2 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 2))
        expect(a2).toBeDefined()
        expect(t2).toBeDefined()
        expect(a2!.role).toBe("assistant")
        expect(t2!.role).toBe("tool")
        const a3 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 3))
        const t3 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 3))
        expect(a3).toBeDefined()
        expect(a3!.role).toBe("assistant")
        expect(t3).toBeUndefined()
        expect(new Set([a1!.id, a2!.id, a3!.id]).size).toBe(3)
        expect(new Set([t1!.id, t2!.id]).size).toBe(2)
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))
  test("queued follow-up executes normally after interrupt", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("gated response"), gated: true },
        textStep("follow-up response"),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const first = makeContMessage("first message")
        const followUp = makeContMessage("follow-up after interrupt")
        // Start first turn — tool call auto-continues to gated step
        yield* Effect.forkChild(runAgentLoop(agentLoop, first))
        // Wait for the gated step (second stream call) to start
        yield* controls.waitForCall(1)
        // Queue a follow-up while step 1 is gated
        yield* runAgentLoop(agentLoop, followUp)
        // Interrupt the current turn. `agentLoop.steer` issues
        // `actor.call(Interrupt)` which is serialized request-reply — by the
        // time it returns, the actor has already set `interruptedRef = true`
        // and signalled the active stream. No additional wait needed.
        yield* steerAgentLoop({
          _tag: "Interrupt",
          sessionId: contSessionId,
          branchId: contBranchId,
        })
        // Release the gated step so the interrupted turn can finalize
        yield* controls.emitAll(1)
        // Wait for the follow-up to complete
        yield* waitForPhase(
          agentLoop,
          { sessionId: contSessionId, branchId: contBranchId },
          "Idle",
          200,
        )
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        // Both turns should have completed
        expect(turnCompleted.length).toBe(2)
        const interruptedTurns = turnCompleted.filter(
          (e) =>
            (
              e as {
                interrupted?: boolean
              }
            ).interrupted === true,
        )
        // First turn was interrupted, second (follow-up) was not
        expect(interruptedTurns.length).toBe(1)
        // Follow-up used the third provider step
        expect(yield* controls.callCount).toBe(3)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))
})
