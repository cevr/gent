import { Schema } from "effect"
import { AgentName, RunSpecSchema } from "./agent.js"
import { MessageId } from "./ids.js"
import { Message } from "./message.js"

const QueueEntryFields = {
  id: MessageId,
  content: Schema.String,
  createdAt: Schema.Finite,
  agentOverride: Schema.optional(AgentName),
}

const SteeringEntry = Schema.TaggedStruct("Steering", QueueEntryFields)
const FollowUpEntry = Schema.TaggedStruct("FollowUp", QueueEntryFields)

export const QueueEntryInfo = Schema.Union([SteeringEntry, FollowUpEntry]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type QueueEntryInfo = typeof QueueEntryInfo.Type

export const SteeringQueueEntryInfo = QueueEntryInfo.cases.Steering
export type SteeringQueueEntryInfo = typeof QueueEntryInfo.cases.Steering.Type
export const FollowUpQueueEntryInfo = QueueEntryInfo.cases.FollowUp
export type FollowUpQueueEntryInfo = typeof QueueEntryInfo.cases.FollowUp.Type

export class QueueSnapshot extends Schema.Class<QueueSnapshot>("QueueSnapshot")({
  steering: Schema.Array(QueueEntryInfo),
  followUp: Schema.Array(QueueEntryInfo),
}) {}

export const emptyQueueSnapshot = (): QueueSnapshot =>
  new QueueSnapshot({ steering: [], followUp: [] })

// ── Persisted queue ──
//
// The on-disk format of `agent_loop_queues.queue_json`. A row written by any
// shipped build must still decode, so no field here is renamed, re-shaped, or
// promoted from optional to required. `runtime/agent/loop-inbox.ts` is the
// only module that interprets these values; this file declares their shape.

export const QueuedTurnItem = Schema.Struct({
  message: Message,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  /**
   * `false` withholds the tools that ask the user, which a child turn has no
   * one to answer. Only `false` is read, so absent and `true` mean the same
   * thing, and only `agent-runner.ts` writes it.
   *
   * It stays optional under this name because a queue row on disk may predate
   * any change: a required field rejects a row whose key is absent, and a
   * renamed one drops a stored `false` and hands the child the tools it was
   * denied. Both were measured, not assumed.
   */
  interactive: Schema.optional(Schema.Boolean),
  /** The admitter asked for a turn even when the branch has no prior history. */
  wake: Schema.optional(Schema.Boolean),
  /**
   * The message id is a durable source key (`followUpMessageIdForSource`), so
   * re-admission replaces this item by id and it is never merged into a
   * neighbour; merging would lose the identity the key exists for.
   */
  keyed: Schema.optional(Schema.Boolean),
})
export type QueuedTurnItem = typeof QueuedTurnItem.Type

export const LoopQueueState = Schema.Struct({
  steering: Schema.Array(QueuedTurnItem),
  followUp: Schema.Array(QueuedTurnItem),
  inFlight: Schema.optional(QueuedTurnItem),
})
export type LoopQueueState = typeof LoopQueueState.Type

export const emptyLoopQueueState = (): LoopQueueState => ({
  steering: [],
  followUp: [],
})
