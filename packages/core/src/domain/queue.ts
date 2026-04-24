import { Schema } from "effect"
import { AgentName } from "./agent.js"
import { MessageId } from "./ids.js"
import { TaggedEnumClass } from "./schema-tagged-enum-class.js"

const QueueEntryFields = {
  id: MessageId,
  content: Schema.String,
  createdAt: Schema.Number,
  agentOverride: Schema.optional(AgentName),
} as const

export const QueueEntryInfo = TaggedEnumClass("QueueEntryInfo", {
  Steering: TaggedEnumClass.variant("steering", QueueEntryFields),
  FollowUp: TaggedEnumClass.variant("follow-up", QueueEntryFields),
})
export type QueueEntryInfo = typeof QueueEntryInfo.Type

export const SteeringQueueEntryInfo = QueueEntryInfo.Steering
export type SteeringQueueEntryInfo = typeof QueueEntryInfo.Steering.Type
export const FollowUpQueueEntryInfo = QueueEntryInfo.FollowUp
export type FollowUpQueueEntryInfo = typeof QueueEntryInfo.FollowUp.Type

export class QueueSnapshot extends Schema.Class<QueueSnapshot>("QueueSnapshot")({
  steering: Schema.Array(QueueEntryInfo),
  followUp: Schema.Array(QueueEntryInfo),
}) {}

export const emptyQueueSnapshot = (): QueueSnapshot =>
  new QueueSnapshot({ steering: [], followUp: [] })
