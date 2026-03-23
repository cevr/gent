/**
 * Turn Wide Event — one structured event per agent turn.
 *
 * Subscribes to EventStore and accumulates per-branch state, emitting
 * a TurnWideEvent summary when TurnCompleted fires. Logs each wide
 * event via Effect.log so it flows through the custom Logger.
 */

import { ServiceMap, Effect, Filter, Layer, Option, Schema, Stream } from "effect"
import { EventStore, type EventEnvelope, type EventStoreError } from "../domain/event.js"
import type { SessionId } from "../domain/ids.js"

// =============================================================================
// Schema
// =============================================================================

const ToolCallSummary = Schema.Struct({
  toolName: Schema.String,
  toolCallId: Schema.String,
  isError: Schema.Boolean,
  durationMs: Schema.optional(Schema.Number),
})

export class TurnWideEvent extends Schema.Class<TurnWideEvent>("TurnWideEvent")({
  sessionId: Schema.String,
  branchId: Schema.String,
  traceId: Schema.optional(Schema.String),
  agent: Schema.String,
  model: Schema.String,
  bypass: Schema.Boolean,
  startedAt: Schema.Number,
  durationMs: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  toolCalls: Schema.Array(ToolCallSummary),
  streamCount: Schema.Number,
  interrupted: Schema.Boolean,
  error: Schema.optional(Schema.String),
  status: Schema.Literals(["ok", "error", "interrupted"]),
}) {}

// =============================================================================
// Accumulator
// =============================================================================

type ToolCallEntry = {
  toolName: string
  toolCallId: string
  isError: boolean
  startedAt: number
  durationMs?: number
}

type TurnAccumulator = {
  sessionId: string
  branchId: string
  traceId?: string
  agent: string
  model: string
  bypass: boolean
  startedAt: number
  inputTokens: number
  outputTokens: number
  toolCalls: ToolCallEntry[]
  streamCount: number
  interrupted: boolean
  error?: string
}

const makeAccumulator = (sessionId: string, branchId: string): TurnAccumulator => ({
  sessionId,
  branchId,
  agent: "cowork",
  model: "",
  bypass: true,
  startedAt: Date.now(),
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: [],
  streamCount: 0,
  interrupted: false,
})

const finalizeAccumulator = (acc: TurnAccumulator, durationMs: number): TurnWideEvent => {
  let status: "ok" | "error" | "interrupted" = "ok"
  if (acc.error !== undefined) status = "error"
  else if (acc.interrupted) status = "interrupted"

  return new TurnWideEvent({
    sessionId: acc.sessionId,
    branchId: acc.branchId,
    traceId: acc.traceId,
    agent: acc.agent,
    model: acc.model,
    bypass: acc.bypass,
    startedAt: acc.startedAt,
    durationMs,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    toolCalls: acc.toolCalls.map((tc) => ({
      toolName: tc.toolName,
      toolCallId: tc.toolCallId,
      isError: tc.isError,
      durationMs: tc.durationMs,
    })),
    streamCount: acc.streamCount,
    interrupted: acc.interrupted,
    error: acc.error,
    status,
  })
}

const ignoredWideEventTags = new Set([
  "SessionStarted",
  "SessionEnded",
  "StreamChunk",
  "PermissionRequested",
  "PromptPresented",
  "PromptConfirmed",
  "PromptRejected",
  "PromptEdited",
  "HandoffPresented",
  "HandoffConfirmed",
  "HandoffRejected",
  "ProviderRetrying",
  "MachineInspected",
  "MachineTaskSucceeded",
  "MachineTaskFailed",
  "TodoUpdated",
  "QuestionsAsked",
  "QuestionsAnswered",
  "SessionNameUpdated",
  "BranchCreated",
  "BranchSwitched",
  "BranchSummarized",
  "SubagentSpawned",
  "SubagentCompleted",
  "SubagentSucceeded",
  "SubagentFailed",
  "TaskCreated",
  "TaskUpdated",
  "TaskCompleted",
  "TaskFailed",
  "TaskDeleted",
  "AgentRestarted",
  "WorkflowPhaseStarted",
  "WorkflowCompleted",
])

// =============================================================================
// Service
// =============================================================================

export interface WideEventService {
  readonly subscribe: (sessionId: SessionId) => Stream.Stream<TurnWideEvent, EventStoreError>
}

export class WideEvent extends ServiceMap.Service<WideEvent, WideEventService>()(
  "@gent/runtime/WideEvent",
) {
  static Live: Layer.Layer<WideEvent, never, EventStore> = Layer.effect(
    WideEvent,
    Effect.gen(function* () {
      const eventStore = yield* EventStore

      const service: WideEventService = {
        subscribe: (sessionId) => {
          const accumulators = new Map<string, TurnAccumulator>()
          const accKey = (branchId: string) => `${sessionId}:${branchId}`

          const getOrCreate = (branchId: string): TurnAccumulator => {
            const key = accKey(branchId)
            let acc = accumulators.get(key)
            if (acc === undefined) {
              acc = makeAccumulator(sessionId, branchId)
              accumulators.set(key, acc)
            }
            return acc
          }

          const updateToolCall = (
            branchId: string,
            toolCallId: string,
            createdAt: number,
            isError: boolean,
          ) => {
            const acc = getOrCreate(branchId)
            const tc = acc.toolCalls.find((t) => t.toolCallId === toolCallId)
            if (tc === undefined) return
            tc.isError = isError
            tc.durationMs = createdAt - tc.startedAt
          }

          const handleEnvelope = (envelope: EventEnvelope) => {
            const event = envelope.event
            const branchId =
              "branchId" in event ? (event.branchId as string | undefined) : undefined
            if (branchId === undefined) return Option.none<TurnWideEvent>()
            if (ignoredWideEventTags.has(event._tag)) return Option.none<TurnWideEvent>()

            switch (event._tag) {
              case "MessageReceived": {
                if (event.role === "user") {
                  const acc = makeAccumulator(sessionId, branchId)
                  acc.traceId = envelope.traceId
                  acc.startedAt = envelope.createdAt
                  accumulators.set(accKey(branchId), acc)
                }
                return Option.none()
              }

              case "StreamStarted":
                getOrCreate(branchId).streamCount++
                return Option.none()

              case "StreamEnded": {
                const acc = getOrCreate(branchId)
                if (event.usage !== undefined) {
                  acc.inputTokens += event.usage.inputTokens
                  acc.outputTokens += event.usage.outputTokens
                }
                if (event.interrupted === true) acc.interrupted = true
                return Option.none()
              }

              case "AgentSwitched":
                getOrCreate(branchId).agent = event.toAgent
                return Option.none()

              case "ToolCallStarted":
                getOrCreate(branchId).toolCalls.push({
                  toolName: event.toolName,
                  toolCallId: event.toolCallId,
                  isError: false,
                  startedAt: envelope.createdAt,
                })
                return Option.none()

              case "ToolCallCompleted":
                updateToolCall(branchId, event.toolCallId, envelope.createdAt, event.isError)
                return Option.none()

              case "ToolCallSucceeded":
                updateToolCall(branchId, event.toolCallId, envelope.createdAt, false)
                return Option.none()

              case "ToolCallFailed":
                updateToolCall(branchId, event.toolCallId, envelope.createdAt, true)
                return Option.none()

              case "ErrorOccurred":
                getOrCreate(branchId).error = event.error
                return Option.none()

              case "TurnCompleted": {
                const acc = getOrCreate(branchId)
                if (event.interrupted === true) acc.interrupted = true
                const wide = finalizeAccumulator(acc, event.durationMs)
                accumulators.delete(accKey(branchId))
                return Option.some(wide)
              }
            }

            return Option.none()
          }

          return eventStore
            .subscribe({ sessionId })
            .pipe(Stream.filterMap(Filter.fromPredicateOption(handleEnvelope)))
        },
      }

      return service
    }),
  )

  static Test = (): Layer.Layer<WideEvent> =>
    Layer.succeed(WideEvent, {
      subscribe: (_sessionId) => Stream.empty,
    })
}
