import { Clock, ServiceMap, Effect, Layer, Ref, Stream } from "effect"
import { Storage } from "../storage/sqlite-storage.js"
import {
  Provider,
  FinishChunk,
  TextChunk,
  ToolCallChunk,
  type StreamChunk,
} from "../providers/provider.js"
import type { AnyToolDefinition } from "../domain/tool.js"
import { Agents } from "../domain/agent.js"
import {
  BaseEventStore,
  EventStore,
  EventEnvelope,
  matchesEventFilter,
  type EventStoreService,
} from "../domain/event.js"
import { Permission } from "../domain/permission.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { testExtensionRegistryLayer } from "./reconciled-extensions.js"

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

export class SequenceRecorder extends ServiceMap.Service<
  SequenceRecorder,
  SequenceRecorderService
>()("@gent/core/src/test-utils/index/SequenceRecorder") {
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
  responses: ReadonlyArray<ReadonlyArray<StreamChunk>>,
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
          const chunks = responses[idx] ?? [new FinishChunk({ finishReason: "stop" })]
          return Stream.fromIterable(chunks)
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

export const RecordingEventStore: Layer.Layer<
  EventStore | BaseEventStore,
  never,
  SequenceRecorder
> = Layer.unwrap(
  Effect.gen(function* () {
    const recorder = yield* SequenceRecorder
    const events: EventEnvelope[] = []
    let nextId = 0

    const service: EventStoreService = {
      publish: Effect.fn("RecordingEventStore.publish")(function* (event) {
        nextId += 1
        const createdAt = yield* Clock.currentTimeMillis
        events.push(
          new EventEnvelope({
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

    return Layer.merge(Layer.succeed(EventStore, service), Layer.succeed(BaseEventStore, service))
  }),
)

// Test Layer Config

export interface TestLayerConfig {
  providerResponses?: ReadonlyArray<ReadonlyArray<StreamChunk>>
  tools?: ReadonlyArray<AnyToolDefinition>
  recording?: boolean
  approvalDecisions?: ReadonlyArray<{ approved: boolean; notes?: string }>
}

// Create Test Layer (no recording)

export const createTestLayer = (config: TestLayerConfig = {}) => {
  const providerResponses = config.providerResponses ?? [
    [new FinishChunk({ finishReason: "stop" })],
  ]
  const approvalDecisions = config.approvalDecisions ?? [{ approved: true }]
  const tools = config.tools ?? []

  return Layer.mergeAll(
    Storage.Test(),
    Provider.Test(providerResponses),
    testExtensionRegistryLayer([
      {
        manifest: { id: "test-agents" },
        kind: "builtin",
        sourcePath: "test",
        setup: { agents: Object.values(Agents), tools: [...tools] },
      },
    ]),
    EventStore.Test(),
    Permission.Test(),
    ApprovalService.Test(approvalDecisions),
    ExtensionTurnControl.Test(),
    AgentLoop.Test(),
    RuntimePlatform.Test({ cwd: process.cwd(), home: "/tmp/test-home", platform: "test" }),
  )
}

// Create Recording Test Layer

export const createRecordingTestLayer = (config: Omit<TestLayerConfig, "recording"> = {}) => {
  const providerResponses = config.providerResponses ?? [
    [new FinishChunk({ finishReason: "stop" })],
  ]
  const approvalDecisions = config.approvalDecisions ?? [{ approved: true }]
  const tools = config.tools ?? []

  return Layer.mergeAll(
    Storage.Test(),
    Permission.Test(),
    testExtensionRegistryLayer([
      {
        manifest: { id: "test-agents" },
        kind: "builtin",
        sourcePath: "test",
        setup: { agents: Object.values(Agents), tools: [...tools] },
      },
    ]),
    ApprovalService.Test(approvalDecisions),
    ExtensionTurnControl.Test(),
    AgentLoop.Test(),
    RuntimePlatform.Test({ cwd: process.cwd(), home: "/tmp/test-home", platform: "test" }),
  ).pipe(
    Layer.provideMerge(RecordingProvider(providerResponses)),
    Layer.provideMerge(RecordingEventStore),
    Layer.provideMerge(SequenceRecorder.Live),
  )
}

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

// Mock Helpers

export const mockTextResponse = (text: string): StreamChunk[] => [
  new TextChunk({ text }),
  new FinishChunk({ finishReason: "stop" }),
]

export const mockToolCallResponse = (
  toolCallId: ToolCallId,
  toolName: string,
  input: unknown,
): StreamChunk[] => [
  new ToolCallChunk({ toolCallId, toolName, input }),
  new FinishChunk({ finishReason: "tool_calls" }),
]

import type { ToolCallId } from "../domain/ids.js"

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
