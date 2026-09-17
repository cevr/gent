import { Schema } from "effect"
import { AgentName } from "./agent.js"
import { MessageId } from "./ids.js"

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
