import { describe, expect, test } from "effect-bun-test"
import { Deferred, Effect, Ref, Stream } from "effect"
import * as Response from "effect/unstable/ai/Response"
import {
  collectExternalTurnResponse,
  collectFailedModelTurnResponse,
  collectModelTurnResponse,
  collectNormalizedResponse,
  formatStreamErrorMessage,
  toResponseFinishReason,
  type ActiveStreamHandle,
} from "../../src/runtime/agent/turn-response/collectors"
import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { Finished, ToolCompleted, ToolStarted, type TurnError } from "@gent/core/domain/driver"
import { ProviderError, finishPart, textDeltaPart } from "@gent/core/providers/provider"
import type { AgentEvent } from "@gent/core/domain/event"

const sessionId = SessionId.make("collector-session")
const branchId = BranchId.make("collector-branch")

const makeActiveStream = (interrupted: boolean): Effect.Effect<ActiveStreamHandle> =>
  Effect.gen(function* () {
    return {
      abortController: new AbortController(),
      interruptDeferred: yield* Deferred.make<void>(),
      interruptedRef: yield* Ref.make(interrupted),
    }
  })

const captureEvents = () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<AgentEvent>>([])
    const publish = (event: AgentEvent) => Ref.update(events, (items) => [...items, event])
    return { events, publish }
  })

describe("agent turn response collectors", () => {
  test("normalized response projects finish usage into message usage", () => {
    const collected = collectNormalizedResponse({
      responseParts: [
        Response.makePart("text", { text: "done" }),
        finishPart({ finishReason: "stop", usage: { inputTokens: 3, outputTokens: 5 } }),
      ],
      streamFailed: false,
      interrupted: false,
      driverKind: "model",
    })

    expect(collected.messageProjection.assistant.map((part) => part.type)).toEqual(["text"])
    expect(collected.messageProjection.usage).toEqual({ inputTokens: 3, outputTokens: 5 })
  })

  test("stream error formatting accepts errors message objects and primitives", () => {
    expect(formatStreamErrorMessage(new Error("native boom"))).toBe("native boom")
    expect(formatStreamErrorMessage({ message: "structured boom" })).toBe("structured boom")
    expect(formatStreamErrorMessage("plain boom")).toBe("plain boom")
  })

  test("unknown finish reasons collapse to unknown", () => {
    expect(toResponseFinishReason("stop")).toBe("stop")
    expect(toResponseFinishReason("made-up")).toBe("unknown")
  })

  test("model collector retries pre-output provider failures by re-raising them", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(false)
      const { publish } = yield* captureEvents()
      const error = yield* collectModelTurnResponse({
        turnStream: Stream.fail(new ProviderError({ message: "boom", model: "test/model" })),
        publishEvent: publish,
        sessionId,
        branchId,
        modelId: "test/model",
        activeStream,
        formatStreamError: (error) => error.message,
        retryPreOutputFailures: true,
      }).pipe(Effect.flip)

      expect(error._tag).toBe("ProviderError")
      expect(error.message).toBe("boom")
    }).pipe(Effect.runPromise))

  test("failed model collector treats interrupted failures as non-stream failures", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(true)
      const { events, publish } = yield* captureEvents()
      const collected = yield* collectFailedModelTurnResponse({
        streamError: new ProviderError({ message: "interrupted boom", model: "test/model" }),
        publishEvent: publish,
        sessionId,
        branchId,
        activeStream,
        formatStreamError: (error) => error.message,
      })

      expect(collected.interrupted).toBe(true)
      expect(collected.streamFailed).toBe(false)
      expect(yield* Ref.get(events)).toEqual([])
    }).pipe(Effect.runPromise))

  test("external collector preserves tool names and usage in projected parts", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(false)
      const { events, publish } = yield* captureEvents()
      const toolCallId = ToolCallId.make("collector-tool")

      const collected = yield* collectExternalTurnResponse({
        turnStream: Stream.fromIterable([
          new ToolStarted({ toolCallId, toolName: "probe", input: { value: "x" } }),
          new ToolCompleted({ toolCallId, output: { ok: true } }),
          new Finished({
            stopReason: "stop",
            usage: { inputTokens: 7, outputTokens: 11 },
          }),
        ]),
        publishEvent: publish,
        sessionId,
        branchId,
        activeStream,
        formatStreamError: (error: TurnError) => error.message,
      })

      expect(collected.messageProjection.assistant.map((part) => part.type)).toEqual(["tool-call"])
      expect(collected.messageProjection.tool.map((part) => part.toolName)).toEqual(["probe"])
      expect(collected.messageProjection.usage).toEqual({ inputTokens: 7, outputTokens: 11 })
      expect((yield* Ref.get(events)).map((event) => event._tag)).toEqual([
        "ToolCallStarted",
        "ToolCallSucceeded",
      ])
    }).pipe(Effect.runPromise))

  test("model collector keeps partial output when post-output stream fails", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(false)
      const { events, publish } = yield* captureEvents()

      const collected = yield* collectModelTurnResponse({
        turnStream: Stream.concat(
          Stream.fromIterable([textDeltaPart("partial")]),
          Stream.fail(new ProviderError({ message: "late boom", model: "test/model" })),
        ),
        publishEvent: publish,
        sessionId,
        branchId,
        modelId: "test/model",
        activeStream,
        formatStreamError: (error) => error.message,
        retryPreOutputFailures: true,
      })

      expect(collected.streamFailed).toBe(true)
      expect(collected.messageProjection.assistant.map((part) => part.type)).toEqual(["text"])
      expect((yield* Ref.get(events)).map((event) => event._tag)).toContain("ErrorOccurred")
    }).pipe(Effect.runPromise))
})
