import { Schema } from "effect"
import { AgentName } from "./agent.js"
import { MessageId } from "./ids.js"

const QueueEntryFields = {
  id: MessageId,
  content: Schema.String,
  createdAt: Schema.Number,
  agentOverride: Schema.optional(AgentName),
} as const

const SteeringEntry = Schema.TaggedStruct("steering", QueueEntryFields)
const FollowUpEntry = Schema.TaggedStruct("follow-up", QueueEntryFields)

export const QueueEntryInfo = Schema.Union([SteeringEntry, FollowUpEntry]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type QueueEntryInfo = typeof QueueEntryInfo.Type

export const SteeringQueueEntryInfo = QueueEntryInfo.cases.steering
export type SteeringQueueEntryInfo = typeof QueueEntryInfo.cases.steering.Type
export const FollowUpQueueEntryInfo = QueueEntryInfo.cases["follow-up"]
export type FollowUpQueueEntryInfo = (typeof QueueEntryInfo.cases)["follow-up"]["Type"]

export class QueueSnapshot extends Schema.Class<QueueSnapshot>("QueueSnapshot")({
  steering: Schema.Array(QueueEntryInfo),
  followUp: Schema.Array(QueueEntryInfo),
}) {}

export const emptyQueueSnapshot = (): QueueSnapshot =>
  new QueueSnapshot({ steering: [], followUp: [] })
