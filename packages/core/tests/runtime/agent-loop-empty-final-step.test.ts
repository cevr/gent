/**
 * A turn whose last model step yields nothing must not report success.
 *
 * Observed in production against a real workspace: a multi-tool turn ran its
 * tools, the model then returned a step with no text and no tool calls, and
 * the loop finalized the turn as Done. No assistant message was ever stored
 * (`persistAssistantParts` skips an empty parts list), so the caller saw an
 * empty answer and exit 0 — a turn that silently produced nothing.
 */

import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { LanguageModelLayers, finishPart } from "../../src/test-utils/language-model"
import { textStep, toolCallStep } from "../../src/test-utils/sequence-steps"
import { dateFromMillis, Message } from "../../src/domain/message"
import { tool } from "@gent/core/extensions/api"
import { MessageStorage } from "../../src/storage/message-storage"
import { BranchId, MessageId, SessionId } from "../../src/domain/ids"
import { AgentEvent } from "../../src/domain/event"
import { SequenceRecorder } from "../../src/test-utils"
import {
  makeAgentLoopService,
  makeLayer,
  makeRecordingLayer,
  runAgentLoop,
} from "./agent-loop/helpers"

describe("empty final step", () => {
  const sessionId = SessionId.make("empty-step-session")
  const branchId = BranchId.make("empty-step-branch")

  const userMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make("empty-step-msg-0"),
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

  /** A model step that finishes with neither text nor tool calls. */
  const emptyStep = () => ({
    parts: [finishPart({ finishReason: "stop", usage: { inputTokens: 10, outputTokens: 0 } })],
  })

  it.live("stores an assistant message even when the last step is empty", () =>
    Effect.gen(function* () {
      // Third step answers the re-prompt the loop should issue after the
      // empty one. Without the fix the loop never asks, and it goes unused.
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "hello" }),
        emptyStep(),
        textStep("Here is the answer."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("do the thing"))

        const messageStorage = yield* MessageStorage
        const stored = yield* messageStorage.listMessages(branchId)
        const assistantTexts = stored
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "text")

        // The turn ran tools and then produced nothing. Reporting Done with no
        // assistant text at all is the failure: the caller cannot tell an empty
        // answer from a successful one.
        expect(assistantTexts.length).toBeGreaterThan(0)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )

  it.live("marks the turn unanswered once every continuation is spent", () =>
    Effect.gen(function* () {
      // Three empty steps: the first two burn both continuations, the third
      // still says nothing. The loop has no move left, so the receipt must
      // record that it gave up rather than reporting an ordinary reply.
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        emptyStep(),
        emptyStep(),
        emptyStep(),
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const recorder = yield* SequenceRecorder
          yield* runAgentLoop(agentLoop, userMessage("do the thing"))

          const calls = yield* recorder.getCalls
          const turnCompleted = calls
            .filter((call) => call.service === "EventStore" && call.method === "append")
            .map((call) => Schema.decodeUnknownOption(AgentEvent)(call.args))
            .filter(Option.isSome)
            .map(({ value }) => value)
            .filter((event) => event._tag === "TurnCompleted")

          expect(turnCompleted.length).toBeGreaterThan(0)
          // Without the flag every field here reads exactly like a successful
          // turn, and the caller cannot tell "gave up" from "replied".
          expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeRecordingLayer(providerLayer))),
      )
    }),
  )

  it.live("spends every continuation before giving up", () =>
    Effect.gen(function* () {
      // `LanguageModelLayers.empty` is the layer `gent --mock-empty` runs on,
      // so this pins the same path the CLI exercises: the loop must re-prompt
      // MAX_CONTINUATIONS_PER_TURN times rather than stopping at the first
      // empty step, and it must stop rather than looping forever.
      const providerLayer = LanguageModelLayers.empty
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const recorder = yield* SequenceRecorder
          yield* runAgentLoop(agentLoop, userMessage("do the thing"))

          const calls = yield* recorder.getCalls
          const events = calls
            .filter((call) => call.service === "EventStore" && call.method === "append")
            .map((call) => Schema.decodeUnknownOption(AgentEvent)(call.args))
            .filter(Option.isSome)
            .map(({ value }) => value)

          const turnCompleted = events.filter((event) => event._tag === "TurnCompleted")
          expect(turnCompleted.length).toBeGreaterThan(0)
          expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeRecordingLayer(providerLayer))),
      )
    }),
  )
})
