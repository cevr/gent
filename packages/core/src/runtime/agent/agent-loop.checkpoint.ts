import { Clock, Effect, Schema } from "effect"
import { BranchId, SessionId } from "../../domain/ids.js"
import { AgentLoopState, LoopQueueState, type LoopState } from "./agent-loop.state.js"

export const AGENT_LOOP_CHECKPOINT_VERSION = 1

export const AgentLoopCheckpointState = Schema.Struct({
  state: AgentLoopState,
  queue: LoopQueueState,
})
export type AgentLoopCheckpointState = typeof AgentLoopCheckpointState.Type

export const AgentLoopCheckpointJson = Schema.fromJsonString(AgentLoopCheckpointState)
const UnknownJson = Schema.fromJsonString(Schema.Unknown)

export const AgentLoopCheckpointRecord = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  version: Schema.Int,
  stateTag: Schema.String,
  stateJson: Schema.String,
  updatedAt: Schema.Number,
})
export type AgentLoopCheckpointRecord = typeof AgentLoopCheckpointRecord.Type

export const encodeLoopCheckpointState = (state: AgentLoopCheckpointState) =>
  Schema.encodeEffect(AgentLoopCheckpointJson)(state)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isLegacyMessageRecord = (value: Record<string, unknown>): boolean =>
  value["_tag"] === undefined &&
  typeof value["id"] === "string" &&
  typeof value["sessionId"] === "string" &&
  typeof value["branchId"] === "string" &&
  typeof value["role"] === "string" &&
  Array.isArray(value["parts"]) &&
  typeof value["createdAt"] === "number"

const migrateLegacyMessageRecord = (value: Record<string, unknown>): Record<string, unknown> => {
  const { kind, ...fields } = value
  return {
    _tag: kind === "interjection" ? "interjection" : "regular",
    ...fields,
  }
}

const migrateLegacyCheckpointJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => migrateLegacyCheckpointJson(item))
  if (!isRecord(value)) return value
  if (isLegacyMessageRecord(value)) return migrateLegacyMessageRecord(value)

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, migrateLegacyCheckpointJson(entry)]),
  )
}

export const decodeLoopCheckpointState = (stateJson: string) =>
  Schema.decodeUnknownEffect(UnknownJson)(stateJson).pipe(
    Effect.map(migrateLegacyCheckpointJson),
    Effect.flatMap(Schema.decodeUnknownEffect(AgentLoopCheckpointState)),
  )

export const shouldRetainLoopCheckpoint = (state: AgentLoopCheckpointState): boolean =>
  state.state._tag !== "Idle" || state.queue.steering.length > 0 || state.queue.followUp.length > 0

export const buildLoopCheckpointRecord = (params: {
  sessionId: SessionId
  branchId: BranchId
  state: LoopState
  queue: typeof LoopQueueState.Type
}) =>
  Effect.gen(function* () {
    const stateJson = yield* encodeLoopCheckpointState({
      state: params.state,
      queue: params.queue,
    })
    return {
      sessionId: params.sessionId,
      branchId: params.branchId,
      version: AGENT_LOOP_CHECKPOINT_VERSION,
      stateTag: params.state._tag,
      stateJson,
      updatedAt: yield* Clock.currentTimeMillis,
    } satisfies AgentLoopCheckpointRecord
  })
