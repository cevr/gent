import { Clock, Context, Effect, FileSystem, Layer, Path, Ref, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { BunServices } from "@effect/platform-bun"
import * as Prompt from "effect/unstable/ai/Prompt"
import type { ExtensionSetupContext } from "../domain/extension.js"
import type { ToolCallId } from "../domain/ids.js"
import { Provider } from "../providers/provider.js"
import {
  finishPart,
  textDeltaPart,
  toolCallPart,
  type ProviderStreamPart,
} from "../debug/provider.js"
import {
  EventStore,
  EventEnvelope,
  matchesEventFilter,
  type EventStoreService,
} from "../domain/event.js"

// Re-export effect-bun-test
export { it, describe, expect } from "effect-bun-test"

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

export class SequenceRecorder extends Context.Service<SequenceRecorder, SequenceRecorderService>()(
  "@gent/core/src/test-utils/index/SequenceRecorder",
) {
  static Live: Layer.Layer<SequenceRecorder> = Layer.effect(
    SequenceRecorder,
    Effect.gen(function* () {
      const ref = yield* Ref.make<CallRecord[]>([])
      return {
        record: (call) =>
          Effect.gen(function* () {
            const timestamp = yield* Clock.currentTimeMillis
            yield* Ref.update(ref, (calls) => [...calls, { ...call, timestamp }])
          }),
        getCalls: () => Ref.get(ref),
        clear: () => Ref.set(ref, []),
      }
    }),
  )
}

// Recording Provider

export const RecordingProvider = (
  responses: ReadonlyArray<ReadonlyArray<ProviderStreamPart>>,
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
            args: {
              model: request.model,
              messageCount: Prompt.make(request.prompt).content.length,
            },
          })
          const parts = responses[idx] ?? [finishPart({ finishReason: "stop" })]
          return Stream.fromIterable(parts)
        }),
        generate: Effect.fn("RecordingProvider.generate")(function* (request) {
          yield* recorder.record({
            service: "Provider",
            method: "generate",
            args: { model: request.model },
          })
          return "test response"
        }),
      }
    }),
  )

// Recording EventStore

export const RecordingEventStore: Layer.Layer<EventStore, never, SequenceRecorder> = Layer.unwrap(
  Effect.gen(function* () {
    const recorder = yield* SequenceRecorder
    const events: EventEnvelope[] = []
    let nextId = 0

    const service: EventStoreService = {
      publish: Effect.fn("RecordingEventStore.publish")(function* (event) {
        nextId += 1
        const createdAt = yield* Clock.currentTimeMillis
        events.push(
          EventEnvelope.make({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            id: nextId as EventEnvelope["id"],
            event,
            createdAt,
          }),
        )
        yield* recorder.record({
          service: "EventStore",
          method: "publish",
          args: event,
        })
      }),
      subscribe: ({ sessionId, branchId, after }) =>
        Stream.fromIterable(
          events.filter(
            (env) => matchesEventFilter(env, sessionId, branchId) && env.id > (after ?? 0),
          ),
        ),
      removeSession: () => Effect.void,
    }

    return Layer.succeed(EventStore, service)
  }),
)

// Sequence Assertions

export const assertSequence = (
  actual: ReadonlyArray<CallRecord>,
  expected: ReadonlyArray<{
    service: string
    method: string
    match?: Record<string, unknown>
  }>,
) => {
  let actualIdx = 0

  for (const exp of expected) {
    let found = false
    while (actualIdx < actual.length) {
      const call = actual[actualIdx]
      if (call !== undefined && call.service === exp.service && call.method === exp.method) {
        if (exp.match !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const argsObj = call.args as Record<string, unknown> | undefined
          if (argsObj !== undefined) {
            const matches = Object.entries(exp.match).every(([k, v]) => argsObj[k] === v)
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
          exp.match !== undefined ? ` with ${JSON.stringify(exp.match)}` : ""
        }`,
      )
    }
  }
}

// ── Test Extension Setup Context ──

const _platformServices = Effect.runSync(Effect.scoped(Layer.build(BunServices.layer)))
const _testFs = Context.get(_platformServices, FileSystem.FileSystem)
const _testPath = Context.get(_platformServices, Path.Path)
const _testSpawner = Context.get(_platformServices, ChildProcessSpawner)

/** Pre-built ExtensionSetupContext for tests. Platform services are captured once at module load. */
export const testSetupCtx = (
  overrides?: Partial<Pick<ExtensionSetupContext, "cwd" | "source" | "home">>,
): ExtensionSetupContext => ({
  cwd: overrides?.cwd ?? "/tmp",
  source: overrides?.source ?? "test",
  home: overrides?.home ?? "/tmp",
  fs: _testFs,
  path: _testPath,
  spawner: _testSpawner,
})

// Mock Helpers

export const mockTextResponse = (text: string): ProviderStreamPart[] => [
  textDeltaPart(text),
  finishPart({ finishReason: "stop" }),
]

export const mockToolCallResponse = (
  toolCallId: ToolCallId,
  toolName: string,
  input: unknown,
): ProviderStreamPart[] => [
  toolCallPart(toolName, input, { toolCallId }),
  finishPart({ finishReason: "tool-calls" }),
]

// E2E test layer
export {
  createE2ELayer,
  type E2ELayerConfig,
  withTinyContextWindow,
  trackingApprovalService,
} from "./e2e-layer.js"

// Extension test harnesses
export {
  createActorHarness,
  createToolTestLayer,
  testToolContext,
  type ActorHarnessOptions,
  type ActorHarnessConfig,
  type ActorHarnessResult,
  type ToolTestLayerConfig,
} from "./extension-harness.js"
