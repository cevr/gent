/**
 * The orchestrator can correct a child that is still working: `agent-child`
 * with `send` puts a message into the child's running turn, and the child's
 * next model step reads it. A finished child takes no more messages.
 */
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Stream } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { ToolCallId } from "@gent/core-internal/domain/ids"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  toolCallPart,
  waitFor,
} from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/index"
import { e2ePreset } from "../helpers/test-preset"

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
