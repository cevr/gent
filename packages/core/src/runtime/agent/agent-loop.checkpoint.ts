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

export const decodeLoopCheckpointState = (stateJson: string) =>
  Schema.decodeUnknownEffect(AgentLoopCheckpointJson)(stateJson)

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
