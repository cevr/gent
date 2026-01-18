import { Context, Effect, Layer, Ref, Stream } from "effect"
import { Storage } from "@gent/storage"
import {
  Provider,
  StreamChunk,
  FinishChunk,
  TextChunk,
  ToolCallChunk,
} from "@gent/providers"
import {
  ToolRegistry,
  EventBus,
  Permission,
  AgentEvent,
  type ToolDefinition,
} from "@gent/core"
import { AskUserHandler, AllTools } from "@gent/tools"
import { AgentLoop } from "@gent/runtime"

// Re-export @effect/vitest
export { it, describe, expect } from "@effect/vitest"

// Call Record

export interface CallRecord {
  service: string
  method: string
  args?: unknown
  result?: unknown
  timestamp: number
}

// Sequence Recorder Service

export interface SequenceRecorderService {
  readonly record: (call: Omit<CallRecord, "timestamp">) => Effect.Effect<void>
  readonly getCalls: () => Effect.Effect<ReadonlyArray<CallRecord>>
  readonly clear: () => Effect.Effect<void>
}

export class SequenceRecorder extends Context.Tag("SequenceRecorder")<
  SequenceRecorder,
  SequenceRecorderService
>() {
  static Live: Layer.Layer<SequenceRecorder> = Layer.effect(
    SequenceRecorder,
    Effect.gen(function* () {
      const ref = yield* Ref.make<CallRecord[]>([])
      return {
        record: (call) =>
          Ref.update(ref, (calls) => [
            ...calls,
            { ...call, timestamp: Date.now() },
          ]),
        getCalls: () => Ref.get(ref),
        clear: () => Ref.set(ref, []),
      }
    })
  )
}

// Recording Provider

export const RecordingProvider = (
  responses: ReadonlyArray<ReadonlyArray<StreamChunk>>
): Layer.Layer<Provider, never, SequenceRecorder> =>
  Layer.effect(
    Provider,
    Effect.gen(function* () {
      const recorder = yield* SequenceRecorder
      const indexRef = yield* Ref.make(0)

      return {
        stream: Effect.fn("RecordingProvider.stream")(function* (request) {
          const idx = yield* Ref.getAndUpdate(indexRef, (i) => i + 1)
          yield* recorder.record({
            service: "Provider",
            method: "stream",
            args: { model: request.model, messageCount: request.messages.length },
          })
          const chunks =
            responses[idx] ?? [new FinishChunk({ finishReason: "stop" })]
          return Stream.fromIterable(chunks)
        }),
      }
    })
  )

// Recording EventBus

export const RecordingEventBus: Layer.Layer<
  EventBus,
  never,
  SequenceRecorder
> = Layer.effect(
  EventBus,
  Effect.gen(function* () {
    const recorder = yield* SequenceRecorder
    const events: AgentEvent[] = []

    return {
      publish: Effect.fn("RecordingEventBus.publish")(function* (event) {
        events.push(event)
        yield* recorder.record({
          service: "EventBus",
          method: "publish",
          args: { _tag: event._tag },
        })
      }),
      subscribe: () => Stream.fromIterable(events),
    }
  })
)

// Recording AskUserHandler

export const RecordingAskUserHandler = (
  responses: ReadonlyArray<string>
): Layer.Layer<AskUserHandler, never, SequenceRecorder> =>
  Layer.effect(
    AskUserHandler,
    Effect.gen(function* () {
      const recorder = yield* SequenceRecorder
      const indexRef = yield* Ref.make(0)

      return {
        ask: Effect.fn("RecordingAskUserHandler.ask")(function* (
          question,
          options
        ) {
          const idx = yield* Ref.getAndUpdate(indexRef, (i) => i + 1)
          yield* recorder.record({
            service: "AskUserHandler",
            method: "ask",
            args: { question, options },
          })
          return responses[idx] ?? ""
        }),
      }
    })
  )

// Test Layer Config

export interface TestLayerConfig {
  providerResponses?: ReadonlyArray<ReadonlyArray<StreamChunk>>
  askUserResponses?: ReadonlyArray<string>
  tools?: ReadonlyArray<ToolDefinition>
  recording?: boolean
}

// Create Test Layer (no recording)

export const createTestLayer = (config: TestLayerConfig = {}) => {
  const providerResponses = config.providerResponses ?? [
    [new FinishChunk({ finishReason: "stop" })],
  ]
  const askUserResponses = config.askUserResponses ?? ["yes"]
  const tools = config.tools ?? (AllTools as unknown as ToolDefinition[])

  return Layer.mergeAll(
    Storage.Test(),
    Provider.Test(providerResponses),
    ToolRegistry.Live(tools),
    EventBus.Test(),
    Permission.Test(),
    AskUserHandler.Test(askUserResponses),
    AgentLoop.Test()
  )
}

// Create Recording Test Layer

export const createRecordingTestLayer = (
  config: Omit<TestLayerConfig, "recording"> = {}
) => {
  const providerResponses = config.providerResponses ?? [
    [new FinishChunk({ finishReason: "stop" })],
  ]
  const askUserResponses = config.askUserResponses ?? ["yes"]
  const tools = config.tools ?? (AllTools as unknown as ToolDefinition[])

  return Layer.mergeAll(
    Storage.Test(),
    Permission.Test(),
    ToolRegistry.Live(tools),
    AgentLoop.Test()
  ).pipe(
    Layer.provideMerge(RecordingProvider(providerResponses)),
    Layer.provideMerge(RecordingEventBus),
    Layer.provideMerge(RecordingAskUserHandler(askUserResponses)),
    Layer.provideMerge(SequenceRecorder.Live)
  )
}

// Sequence Assertions

export const assertSequence = (
  actual: ReadonlyArray<CallRecord>,
  expected: ReadonlyArray<{
    service: string
    method: string
    match?: Record<string, unknown>
  }>
) => {
  let actualIdx = 0

  for (const exp of expected) {
    let found = false
    while (actualIdx < actual.length) {
      const call = actual[actualIdx]!
      if (call.service === exp.service && call.method === exp.method) {
        if (exp.match) {
          const argsObj = call.args as Record<string, unknown> | undefined
          if (argsObj) {
            const matches = Object.entries(exp.match).every(
              ([k, v]) => argsObj[k] === v
            )
            if (matches) {
              found = true
              actualIdx++
              break
            }
          }
        } else {
          found = true
          actualIdx++
          break
        }
      }
      actualIdx++
    }

    if (!found) {
      throw new Error(
        `Expected call not found: ${exp.service}.${exp.method}${
          exp.match ? ` with ${JSON.stringify(exp.match)}` : ""
        }`
      )
    }
  }
}

// Mock Helpers

export const mockTextResponse = (text: string): StreamChunk[] => [
  new TextChunk({ text }),
  new FinishChunk({ finishReason: "stop" }),
]

export const mockToolCallResponse = (
  toolCallId: string,
  toolName: string,
  input: unknown
): StreamChunk[] => [
  new ToolCallChunk({ toolCallId, toolName, input }),
  new FinishChunk({ finishReason: "tool_calls" }),
]

// Test Effect Runner

export const runTest = <A, E>(
  effect: Effect.Effect<A, E, never>,
  config: TestLayerConfig = {}
) =>
  effect.pipe(
    Effect.provide(createTestLayer(config)),
    Effect.runPromise
  )

// Run with recording

export const runTestWithRecording = <A, E>(
  effect: Effect.Effect<A, E, SequenceRecorder>,
  config: Omit<TestLayerConfig, "recording"> = {}
) =>
  Effect.runPromise(Effect.provide(effect, createRecordingTestLayer(config)))
