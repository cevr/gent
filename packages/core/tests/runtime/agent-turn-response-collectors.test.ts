import { describe, expect, it, test } from "effect-bun-test"
import { Effect, Ref, Stream, type Scope } from "effect"
import * as Response from "effect/unstable/ai/Response"
import {
  collectExternalTurnResponse,
  collectFailedModelTurnResponse,
  collectModelTurnResponse,
  collectNormalizedResponse,
  formatStreamErrorMessage,
  makeActiveStreamHandle,
  signalActiveStreamInterrupt,
  toResponseFinishReason,
  type ActiveStreamHandle,
} from "../../src/runtime/agent/turn-response/collectors"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import type { TurnError } from "@gent/core-internal/domain/driver"
import { ProviderError } from "@gent/core-internal/domain/provider-error"
import { finishPart, textDeltaPart } from "@gent/core-internal/test-utils/language-model"
import type { AgentEvent } from "@gent/core-internal/domain/event"

const sessionId = SessionId.make("collector-session")
const branchId = BranchId.make("collector-branch")

const makeActiveStream = (
  interrupted: boolean,
): Effect.Effect<ActiveStreamHandle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* makeActiveStreamHandle()
    if (interrupted) yield* signalActiveStreamInterrupt(handle)
    return handle
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

  it.scopedLive("model collector retries pre-output provider failures by re-raising them", () =>
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
    }),
  )

  it.scopedLive("failed model collector treats interrupted failures as non-stream failures", () =>
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
    }),
  )

  it.scopedLive("external collector preserves tool names and usage in projected parts", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(false)
      const { events, publish } = yield* captureEvents()
      const toolCallId = ToolCallId.make("collector-tool")

      const collected = yield* collectExternalTurnResponse({
        turnStream: Stream.fromIterable([
          Response.makePart("tool-call", {
            id: toolCallId,
            name: "probe",
            params: { value: "x" },
            providerExecuted: false,
          }),
          Response.makePart("tool-result", {
            id: toolCallId,
            name: "probe",
            result: { ok: true },
            encodedResult: { ok: true },
            isFailure: false,
            providerExecuted: false,
            preliminary: false,
          }),
          finishPart({
            finishReason: "stop",
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
      expect(
        collected.messageProjection.tool.flatMap((part) =>
          part.type === "tool-result" ? [part.name] : [],
        ),
      ).toEqual(["probe"])
      expect(collected.messageProjection.usage).toEqual({ inputTokens: 7, outputTokens: 11 })
      const published = yield* Ref.get(events)
      expect(published.map((event) => event._tag)).toEqual(["ToolCallStarted", "ToolCallSucceeded"])
      const started = published.find((event) => event._tag === "ToolCallStarted")
      expect(started).toEqual(expect.objectContaining({ input: { value: "x" } }))
      const succeeded = published.find((event) => event._tag === "ToolCallSucceeded")
      expect(succeeded).toEqual(
        expect.objectContaining({
          summary: '{"ok":true}',
          output: '{\n  "ok": true\n}',
        }),
      )
    }),
  )

  it.scopedLive(
    "external collector de-duplicates durable tool-start events by response part id",
    () =>
      Effect.gen(function* () {
        const activeStream = yield* makeActiveStream(false)
        const { events, publish } = yield* captureEvents()
        const toolCallId = ToolCallId.make("collector-dup")
        const toolCallPart = Response.makePart("tool-call", {
          id: toolCallId,
          name: "probe",
          params: {},
          providerExecuted: false,
        })

        yield* collectExternalTurnResponse({
          turnStream: Stream.fromIterable([toolCallPart, toolCallPart]),
          publishEvent: publish,
          sessionId,
          branchId,
          activeStream,
          formatStreamError: (error: TurnError) => error.message,
        })

        expect((yield* Ref.get(events)).map((event) => event._tag)).toEqual(["ToolCallStarted"])
      }),
  )

  it.scopedLive(
    "external collector de-duplicates final tool-result events by response part id",
    () =>
      Effect.gen(function* () {
        const activeStream = yield* makeActiveStream(false)
        const { events, publish } = yield* captureEvents()
        const toolCallId = ToolCallId.make("collector-result-dup")
        const toolResultPart = Response.makePart("tool-result", {
          id: toolCallId,
          name: "probe",
          result: { ok: true },
          encodedResult: { ok: true },
          isFailure: false,
          providerExecuted: false,
          preliminary: false,
        })

        yield* collectExternalTurnResponse({
          turnStream: Stream.fromIterable([toolResultPart, toolResultPart]),
          publishEvent: publish,
          sessionId,
          branchId,
          activeStream,
          formatStreamError: (error: TurnError) => error.message,
        })

        expect((yield* Ref.get(events)).map((event) => event._tag)).toEqual(["ToolCallSucceeded"])
      }),
  )

  it.scopedLive("model collector keeps partial output when post-output stream fails", () =>
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
    }),
  )
})
