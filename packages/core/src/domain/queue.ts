import { Schema } from "effect"
import { AgentName } from "./agent.js"
import { MessageId } from "./ids.js"

export const QueueEntryKind = Schema.Literals(["steering", "follow-up"])
export type QueueEntryKind = typeof QueueEntryKind.Type

export class QueueEntryInfo extends Schema.Class<QueueEntryInfo>("QueueEntryInfo")({
  id: MessageId,
  kind: QueueEntryKind,
  content: Schema.String,
  createdAt: Schema.Number,
  agentOverride: Schema.optional(AgentName),
}) {}

export class QueueSnapshot extends Schema.Class<QueueSnapshot>("QueueSnapshot")({
  steering: Schema.Array(QueueEntryInfo),
  followUp: Schema.Array(QueueEntryInfo),
}) {}
