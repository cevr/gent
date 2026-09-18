/**
 * A turn that spends the whole step budget must not report success.
 *
 * `runTurn` bounds a turn at `MAX_TURN_STEPS` so a model that asks for tools
 * forever cannot run without end. That exit left `interrupted`, `streamFailed`
 * and `unanswered` all false, so the turn published a `TurnCompleted` that
 * reads exactly like an ordinary reply. `headless-runner.ts:122` picks its exit
 * code from `event.unanswered !== true`, so `gent -H` against a looping model
 * exited 0 having printed no answer at all.
 *
 * Same failure as `agent-loop-empty-final-step.test.ts` guards, at the other
 * exit from the same loop: a turn that gave up must say so.
 */

import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  finishPart,
  LanguageModelLayers,
  textStep,
  toolCallPart,
} from "../../src/test-utils/language-model"
import { dateFromMillis, Message } from "../../src/domain/message"
import { tool } from "@gent/core/extensions/api"
import { AgentName, makeRunSpec } from "../../src/domain/agent"
import { BranchId, MessageId, SessionId } from "../../src/domain/ids"
import type { AgentEvent } from "../../src/domain/event"
import {
  makeAgentLoopService,
  makeLayerWithEvents,
  runAgentLoop,
  steerAgentLoop,
} from "./agent-loop/helpers"

describe("max turn steps", () => {
  const sessionId = SessionId.make("max-steps-session")
  const branchId = BranchId.make("max-steps-branch")

  const userMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make("max-steps-msg-0"),
      sessionId,
      branchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })

  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })

  /**
   * A model that asks for the same tool on every step and never answers. Real
   * providers stop on their own; this one does not, which is the case the step
   * bound exists for.
   */
  const alwaysToolCalls = LanguageModelLayers.testStream(() =>
    Effect.succeed(
      Stream.make(
        toolCallPart("echo", { text: "again" }),
        finishPart({ finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }),
      ),
    ),
  )

  it.live("a turn that spends the whole step budget is marked unanswered", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        // The budget is the agent's to lower; three steps prove the same exit
        // the default two hundred do.
        yield* runAgentLoop(agentLoop, userMessage("loop forever"), {
          runSpec: makeRunSpec({ overrides: { maxSteps: 3 } }),
        })

        const events = yield* Ref.get(eventsRef)
        expect(events.filter((event) => event._tag === "StreamStarted")).toHaveLength(3)
        const turnCompleted = events.filter((event) => event._tag === "TurnCompleted")
        expect(turnCompleted.length).toBeGreaterThan(0)
        // Without the flag this reads as a successful turn with an empty
        // transcript, and headless mode exits 0 on it.
        expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(alwaysToolCalls, eventsRef, [echoTool])))
    }),
  )

  /**
   * Steering joins a turn at a step boundary by leaving the queue. On the last
   * step of the budget there is no next step, so a message delivered there
   * would leave the queue and never reach a prompt.
   */
  it.live("steering that arrives during the last budgeted step opens the next turn", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...textStep("the budget's only answer"), gated: true },
        {
          ...textStep("read the steering"),
          assertOptions: (options) => {
            const texts = Prompt.make(options.prompt).content.flatMap((message) => {
              if (message.role !== "user") return []
              return message.content.flatMap((part) => {
                if (part.type !== "text") return []
                return [part.text]
              })
            })
            expect(texts).toContain("steer late")
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const fiber = yield* Effect.forkChild(
          runAgentLoop(agentLoop, userMessage("answer once"), {
            runSpec: makeRunSpec({ overrides: { maxSteps: 1 } }),
          }),
        )
        yield* controls.waitForCall(0)
        yield* steerAgentLoop({
          _tag: "Interject",
          sessionId,
          branchId,
          requestId: "req-interject-last-step",
          message: "steer late",
        })
        yield* controls.emitAll(0)
        yield* Fiber.join(fiber)
        yield* controls.waitForCall(1)
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  /**
   * The same failure at the loop's other give-up exit.
   *
   * `resolveTurnContext` publishes `ErrorOccurred` and returns undefined for an
   * agent no extension defines (`turn-resolve.ts:134`). `runTurnStep` turned
   * that into a `Stop` with every flag false, so the turn published a
   * `TurnCompleted` indistinguishable from a reply.
   */
  it.live("a turn for an unknown agent is marked unanswered", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("who are you"), {
          agentOverride: AgentName.make("no-such-agent"),
        })

        const events = yield* Ref.get(eventsRef)
        expect(
          events.some(
            (event) =>
              event._tag === "ErrorOccurred" && event.error === "Unknown agent: no-such-agent",
          ),
        ).toBe(true)
        const turnCompleted = events.filter((event) => event._tag === "TurnCompleted")
        expect(turnCompleted).toHaveLength(1)
        expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(alwaysToolCalls, eventsRef, [echoTool])))
    }),
  )
})
