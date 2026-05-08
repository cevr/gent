import { Schema } from "effect"
import { AgentName, RunSpecSchema } from "./agent.js"
import { Message } from "./message.js"

export const QueuedTurnItemSchema = Schema.Struct({
  message: Message,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
})
export type QueuedTurnItem = typeof QueuedTurnItemSchema.Type

export const LoopQueueState = Schema.Struct({
  steering: Schema.Array(QueuedTurnItemSchema),
  followUp: Schema.Array(QueuedTurnItemSchema),
  inFlight: Schema.optional(QueuedTurnItemSchema),
})
export type LoopQueueState = typeof LoopQueueState.Type
