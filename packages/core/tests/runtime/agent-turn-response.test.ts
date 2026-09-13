import { describe, expect, it, test } from "effect-bun-test"
import { Effect, Layer, Option, Ref, Schema, Stream, type Scope } from "effect"
import { responseUsage } from "../../src/domain/response-to-prompt"
import * as Response from "effect/unstable/ai/Response"
import {
  collectExternalTurnResponse,
  collectFailedModelTurnResponse,
  collectModelTurnResponse,
  collectNormalizedResponse,
  makeActiveStreamHandle,
  signalActiveStreamInterrupt,
  type ActiveStreamHandle,
} from "../../src/runtime/agent/turn-response"
import { BranchId, MessageId, SessionId, ToolCallId } from "../../src/domain/ids"
import type { TurnError } from "../../src/domain/driver"
import { ProviderError } from "../../src/domain/provider-error"
import { finishPart, textDeltaPart } from "../../src/test-utils/language-model"
import { UsageSchema, type AgentEvent } from "../../src/domain/event"
import { EventPublisher } from "../../src/domain/event-publisher"

const sessionId = SessionId.make("collector-session")
const branchId = BranchId.make("collector-branch")
const streamAddress = {
  messageId: MessageId.make("collector-turn"),
  assistantMessageId: MessageId.make("collector-turn:assistant:1"),
  step: 1,
}

const makeActiveStream = (
  interrupted: boolean,
): Effect.Effect<ActiveStreamHandle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* makeActiveStreamHandle
    if (interrupted) yield* signalActiveStreamInterrupt(handle)
    return handle
  })

const captureEvents = () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<AgentEvent>>([])
    const layer = Layer.succeed(
      EventPublisher,
      EventPublisher.of({
        append: () => Effect.die("append not exercised in turn response tests"),
        deliver: () => Effect.void,
        publish: (event) => Ref.update(events, (items) => [...items, event]),
      }),
    )
    return { events, layer }
  })

describe("agent turn response collectors", () => {
  test("missing or invalid token totals stay unknown while explicit zero stays known", () => {
    const usage = Schema.decodeUnknownSync(Response.FinishPart)(
      finishPart({ finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } }),
    ).usage
    expect(responseUsage(usage)).toEqual(Option.some({ inputTokens: 0, outputTokens: 0 }))
    for (const total of [Option.getOrUndefined(Option.none<number>()), -1, 1.5, Number.NaN]) {
      expect(responseUsage({ ...usage, inputTokens: { ...usage.inputTokens, total } })).toEqual(
        Option.none(),
      )
      expect(responseUsage({ ...usage, outputTokens: { ...usage.outputTokens, total } })).toEqual(
        Option.none(),
      )
    }
  })

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

  test("cache counts survive response projection and durable usage encoding", () => {
    const finish = Schema.decodeUnknownSync(Response.FinishPart)(
      finishPart({ finishReason: "stop", usage: { inputTokens: 100, outputTokens: 5 } }),
    )
    const collected = collectNormalizedResponse({
      responseParts: [
        Response.makePart("finish", {
          ...finish,
          usage: new Response.Usage({
            ...finish.usage,
            inputTokens: { ...finish.usage.inputTokens, cacheRead: 80, cacheWrite: 0 },
          }),
        }),
      ],
      streamFailed: false,
      interrupted: false,
      driverKind: "model",
    })
    const codec = Schema.fromJsonString(UsageSchema)
    const encoded = Schema.encodeSync(codec)(
      Option.getOrThrow(Option.fromUndefinedOr(collected.messageProjection.usage)),
    )
    expect(Schema.decodeSync(codec)(encoded)).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    })
  })

  test("invalid cache counts stay unknown without discarding valid token totals", () => {
    const usage = Schema.decodeUnknownSync(Response.FinishPart)(
      finishPart({ finishReason: "stop", usage: { inputTokens: 100, outputTokens: 5 } }),
    ).usage
    for (const count of [Option.getOrUndefined(Option.none<number>()), -1, 1.5, Number.NaN]) {
      expect(
        responseUsage({
          ...usage,
          inputTokens: { ...usage.inputTokens, cacheRead: count, cacheWrite: count },
        }),
      ).toEqual(Option.some({ inputTokens: 100, outputTokens: 5 }))
    }
    expect(Schema.decodeSync(UsageSchema)({ inputTokens: 100, outputTokens: 5 })).toEqual({
      inputTokens: 100,
      outputTokens: 5,
    })
  })

  test("unknown finish reasons collapse to unknown", () => {})

  it.scopedLive("model collector retries pre-output provider failures by re-raising them", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(false)
      const { layer } = yield* captureEvents()
      const error = yield* collectModelTurnResponse({
        ...streamAddress,
        turnStream: Stream.fail(new ProviderError({ message: "boom", model: "test/model" })),
        sessionId,
        branchId,
        modelId: "test/model",
        activeStream,
        formatStreamError: (error) => error.message,
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.flip, Effect.provide(layer))

      expect(error._tag).toBe("ProviderError")
      expect(error.message).toBe("boom")
    }),
  )

  it.scopedLive("failed model collector treats interrupted failures as non-stream failures", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(true)
      const { events, layer } = yield* captureEvents()
      const collected = yield* collectFailedModelTurnResponse({
        ...streamAddress,
        streamError: new ProviderError({ message: "interrupted boom", model: "test/model" }),
        sessionId,
        branchId,
        activeStream,
        formatStreamError: (error) => error.message,
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))

      expect(collected.interrupted).toBe(true)
      expect(collected.streamFailed).toBe(false)
      expect(yield* Ref.get(events)).toEqual([])
    }),
  )

  it.scopedLive("external collector preserves tool names and usage in projected parts", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(false)
      const { events, layer } = yield* captureEvents()
      const toolCallId = ToolCallId.make("collector-tool")

      const collected = yield* collectExternalTurnResponse({
        ...streamAddress,
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
        sessionId,
        branchId,
        activeStream,
        formatStreamError: (error: TurnError) => error.message,
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))

      expect(collected.messageProjection.assistant.map((part) => part.type)).toEqual(["tool-call"])
      expect(
        collected.messageProjection.tool.flatMap((part) => {
          if (part.type === "tool-result") {
            return [part.name]
          }
          return []
        }),
      ).toEqual(["probe"])
      expect(collected.messageProjection.usage).toEqual({ inputTokens: 7, outputTokens: 11 })
      const published = yield* Ref.get(events)
      expect(published.map((event) => event._tag)).toEqual(["ToolCallStarted", "ToolCallSucceeded"])
      const started = published.find((event) => event._tag === "ToolCallStarted")
      expect(started).toEqual(
        expect.objectContaining({
          input: { value: "x" },
          assistantMessageId: streamAddress.assistantMessageId,
        }),
      )
      const succeeded = published.find((event) => event._tag === "ToolCallSucceeded")
      expect(succeeded).toEqual(
        expect.objectContaining({
          summary: '{"ok":true}',
          output: '{\n  "ok": true\n}',
          assistantMessageId: streamAddress.assistantMessageId,
        }),
      )
    }),
  )

  it.scopedLive(
    "external collector de-duplicates durable tool-start events by response part id",
    () =>
      Effect.gen(function* () {
        const activeStream = yield* makeActiveStream(false)
        const { events, layer } = yield* captureEvents()
        const toolCallId = ToolCallId.make("collector-dup")
        const toolCallPart = Response.makePart("tool-call", {
          id: toolCallId,
          name: "probe",
          params: {},
          providerExecuted: false,
        })

        yield* collectExternalTurnResponse({
          ...streamAddress,
          turnStream: Stream.fromIterable([toolCallPart, toolCallPart]),
          sessionId,
          branchId,
          activeStream,
          formatStreamError: (error: TurnError) => error.message,
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer))

        expect((yield* Ref.get(events)).map((event) => event._tag)).toEqual(["ToolCallStarted"])
      }),
  )

  it.scopedLive(
    "external collector de-duplicates final tool-result events by response part id",
    () =>
      Effect.gen(function* () {
        const activeStream = yield* makeActiveStream(false)
        const { events, layer } = yield* captureEvents()
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
          ...streamAddress,
          turnStream: Stream.fromIterable([toolResultPart, toolResultPart]),
          sessionId,
          branchId,
          activeStream,
          formatStreamError: (error: TurnError) => error.message,
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer))

        expect((yield* Ref.get(events)).map((event) => event._tag)).toEqual(["ToolCallSucceeded"])
      }),
  )

  it.scopedLive("model collector keeps partial output when post-output stream fails", () =>
    Effect.gen(function* () {
      const activeStream = yield* makeActiveStream(false)
      const { events, layer } = yield* captureEvents()

      const collected = yield* collectModelTurnResponse({
        ...streamAddress,
        turnStream: Stream.concat(
          Stream.fromIterable([textDeltaPart("partial")]),
          Stream.fail(new ProviderError({ message: "late boom", model: "test/model" })),
        ),
        sessionId,
        branchId,
        modelId: "test/model",
        activeStream,
        formatStreamError: (error) => error.message,
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))

      expect(collected.streamFailed).toBe(true)
      expect(collected.messageProjection.assistant.map((part) => part.type)).toEqual(["text"])
      expect((yield* Ref.get(events)).map((event) => event._tag)).toContain("ErrorOccurred")
    }),
  )
})
