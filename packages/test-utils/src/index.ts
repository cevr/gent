import { ServiceMap, Effect, Layer, Ref, Stream } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage.js"
import {
  Provider,
  FinishChunk,
  TextChunk,
  ToolCallChunk,
  type StreamChunk,
} from "@gent/core/providers/provider.js"
import { ToolRegistry, type AnyToolDefinition } from "@gent/core/domain/tool.js"
import { EventStore, EventEnvelope, matchesEventFilter } from "@gent/core/domain/event.js"
import { Permission, type PermissionDecision } from "@gent/core/domain/permission.js"
import {
  PermissionHandler,
  PlanHandler,
  HandoffHandler,
} from "@gent/core/domain/interaction-handlers.js"
import type { PlanDecision, HandoffDecision } from "@gent/core/domain/event.js"
import { PlanCheckpoint, type Checkpoint } from "@gent/core/domain/message.js"
import type { BranchId } from "@gent/core/domain/ids.js"
import { AskUserHandler } from "@gent/core/tools/ask-user.js"
import { AllTools } from "@gent/core/tools/index.js"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop.js"
import { CheckpointService } from "@gent/core/runtime/checkpoint.js"

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
>()("@gent/test-utils/src/index/SequenceRecorder") {
  static Live: Layer.Layer<SequenceRecorder> = Layer.effect(
    SequenceRecorder,
    Effect.gen(function* () {
      const ref = yield* Ref.make<CallRecord[]>([])
      return {
        record: (call) =>
          Ref.update(ref, (calls) => [...calls, { ...call, timestamp: Date.now() }]),
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

export const RecordingEventStore: Layer.Layer<EventStore, never, SequenceRecorder> = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const recorder = yield* SequenceRecorder
    const events: EventEnvelope[] = []
    let nextId = 0

    return {
      publish: Effect.fn("RecordingEventStore.publish")(function* (event) {
        nextId += 1
        events.push(
          new EventEnvelope({
            id: nextId as EventEnvelope["id"],
            event,
            createdAt: Date.now(),
          }),
        )
        yield* recorder.record({
          service: "EventStore",
          method: "publish",
          args: { _tag: event._tag },
        })
      }),
      subscribe: ({ sessionId, branchId, after }) =>
        Stream.fromIterable(
          events.filter(
            (env) => matchesEventFilter(env, sessionId, branchId) && env.id > (after ?? 0),
          ),
        ),
    }
  }),
)

// Recording AskUserHandler

export const RecordingAskUserHandler = (
  responses: ReadonlyArray<string>,
): Layer.Layer<AskUserHandler, never, SequenceRecorder> =>
  Layer.effect(
    AskUserHandler,
    Effect.gen(function* () {
      const recorder = yield* SequenceRecorder
      const indexRef = yield* Ref.make(0)

      return {
        ask: Effect.fn("RecordingAskUserHandler.ask")(function* (question, ctx) {
          const idx = yield* Ref.getAndUpdate(indexRef, (i) => i + 1)
          yield* recorder.record({
            service: "AskUserHandler",
            method: "ask",
            args: { question, ctx },
          })
          return responses[idx] ?? ""
        }),
        askMany: Effect.fn("RecordingAskUserHandler.askMany")(function* (questions, ctx) {
          yield* recorder.record({
            service: "AskUserHandler",
            method: "askMany",
            args: { questions, ctx },
          })
          const idx = yield* Ref.getAndUpdate(indexRef, (i) => i + 1)
          const response = responses[idx] ?? ""
          return [[response]]
        }),
        respond: Effect.fn("RecordingAskUserHandler.respond")(function* (requestId, answers) {
          yield* recorder.record({
            service: "AskUserHandler",
            method: "respond",
            args: { requestId, answers },
          })
        }),
      }
    }),
  )

// Recording CheckpointService

export interface CheckpointServiceTestConfig {
  latestCheckpoint?: Checkpoint
}

export const RecordingCheckpointService = (
  config: CheckpointServiceTestConfig = {},
): Layer.Layer<CheckpointService, never, SequenceRecorder | Storage> =>
  Layer.effect(
    CheckpointService,
    Effect.gen(function* () {
      const recorder = yield* SequenceRecorder
      const storage = yield* Storage
      const checkpointRef = yield* Ref.make<Checkpoint | undefined>(config.latestCheckpoint)

      return {
        createPlanCheckpoint: Effect.fn("CheckpointService.createPlanCheckpoint")(function* (
          branchId: BranchId,
          planPath: string,
        ) {
          const checkpoint = new PlanCheckpoint({
            id: Bun.randomUUIDv7(),
            branchId,
            planPath,
            messageCount: 10,
            tokenCount: 5000,
            createdAt: new Date(),
          })
          yield* recorder.record({
            service: "CheckpointService",
            method: "createPlanCheckpoint",
            args: { branchId, planPath },
            result: checkpoint,
          })
          yield* storage.createCheckpoint(checkpoint)
          yield* Ref.set(checkpointRef, checkpoint)
          return checkpoint
        }),

        getLatestCheckpoint: Effect.fn("CheckpointService.getLatestCheckpoint")(function* (
          branchId: BranchId,
        ) {
          yield* recorder.record({
            service: "CheckpointService",
            method: "getLatestCheckpoint",
            args: { branchId },
          })
          return yield* Ref.get(checkpointRef)
        }),

        estimateTokens: (messages) => {
          let chars = 0
          for (const msg of messages) {
            for (const part of msg.parts) {
              if (part.type === "text") {
                chars += (part as { text: string }).text.length
              }
            }
          }
          return Effect.succeed(Math.ceil(chars / 4))
        },

        estimateContextPercent: (messages, _modelId) => {
          let chars = 0
          for (const msg of messages) {
            for (const part of msg.parts) {
              if (part.type === "text") {
                chars += (part as { text: string }).text.length
              }
            }
          }
          return Effect.succeed(Math.round((Math.ceil(chars / 4) / 200_000) * 100))
        },
      }
    }),
  )

// Test Layer Config

export interface TestLayerConfig {
  providerResponses?: ReadonlyArray<ReadonlyArray<StreamChunk>>
  askUserResponses?: ReadonlyArray<string>
  tools?: ReadonlyArray<AnyToolDefinition>
  recording?: boolean
  checkpoint?: CheckpointServiceTestConfig
  permissionDecisions?: ReadonlyArray<PermissionDecision>
  planDecisions?: ReadonlyArray<PlanDecision>
  handoffDecisions?: ReadonlyArray<HandoffDecision>
}

// Create Test Layer (no recording)

export const createTestLayer = (config: TestLayerConfig = {}) => {
  const providerResponses = config.providerResponses ?? [
    [new FinishChunk({ finishReason: "stop" })],
  ]
  const askUserResponses = config.askUserResponses ?? ["yes"]
  const permissionDecisions = config.permissionDecisions ?? ["allow"]
  const planDecisions = config.planDecisions ?? ["confirm"]
  const handoffDecisions = config.handoffDecisions ?? ["confirm"]
  const tools = config.tools ?? AllTools

  return Layer.mergeAll(
    Storage.Test(),
    Provider.Test(providerResponses),
    ToolRegistry.Live(tools),
    EventStore.Test(),
    Permission.Test(),
    PermissionHandler.Test(permissionDecisions),
    AskUserHandler.Test(askUserResponses),
    PlanHandler.Test(planDecisions),
    HandoffHandler.Test(handoffDecisions),
    AgentLoop.Test(),
    CheckpointService.Test(),
  )
}

// Create Recording Test Layer

export const createRecordingTestLayer = (config: Omit<TestLayerConfig, "recording"> = {}) => {
  const providerResponses = config.providerResponses ?? [
    [new FinishChunk({ finishReason: "stop" })],
  ]
  const askUserResponses = config.askUserResponses ?? ["yes"]
  const permissionDecisions = config.permissionDecisions ?? ["allow"]
  const planDecisions = config.planDecisions ?? ["confirm"]
  const handoffDecisions = config.handoffDecisions ?? ["confirm"]
  const tools = config.tools ?? AllTools
  const checkpointConfig = config.checkpoint ?? {}

  const StorageLayer = Storage.Test()

  return Layer.mergeAll(
    StorageLayer,
    Permission.Test(),
    PermissionHandler.Test(permissionDecisions),
    ToolRegistry.Live(tools),
    PlanHandler.Test(planDecisions),
    HandoffHandler.Test(handoffDecisions),
    AgentLoop.Test(),
  ).pipe(
    Layer.provideMerge(RecordingProvider(providerResponses)),
    Layer.provideMerge(RecordingEventStore),
    Layer.provideMerge(RecordingAskUserHandler(askUserResponses)),
    Layer.provideMerge(Layer.provide(RecordingCheckpointService(checkpointConfig), StorageLayer)),
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
  toolCallId: string,
  toolName: string,
  input: unknown,
): StreamChunk[] => [
  new ToolCallChunk({ toolCallId, toolName, input }),
  new FinishChunk({ finishReason: "tool_calls" }),
]

// Test Effect Runner

export const runTest = <A, E>(effect: Effect.Effect<A, E, never>, config: TestLayerConfig = {}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(createTestLayer(config))
        return yield* effect.pipe(Effect.provide(context))
      }),
    ),
  )

// Run with recording

export const runTestWithRecording = <A, E>(
  effect: Effect.Effect<A, E, SequenceRecorder>,
  config: Omit<TestLayerConfig, "recording"> = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(createRecordingTestLayer(config))
        return yield* effect.pipe(Effect.provide(context))
      }),
    ),
  )
