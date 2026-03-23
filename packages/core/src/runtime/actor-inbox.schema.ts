import { Schema } from "effect"
import { BranchId, SessionId, ActorCommandId } from "../domain/ids.js"

export const ActorCommandKind = Schema.Literals([
  "send-user-message",
  "send-tool-result",
  "invoke-tool",
  "interrupt",
  "steer-agent",
])
export type ActorCommandKind = typeof ActorCommandKind.Type

export const ActorCommandStatus = Schema.Literals(["pending", "running", "completed", "failed"])
export type ActorCommandStatus = typeof ActorCommandStatus.Type

export const ActorInboxRecord = Schema.Struct({
  commandId: ActorCommandId,
  sessionId: SessionId,
  branchId: BranchId,
  kind: ActorCommandKind,
  payloadJson: Schema.String,
  status: ActorCommandStatus,
  attempts: Schema.Int,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  startedAt: Schema.optional(Schema.Number),
  completedAt: Schema.optional(Schema.Number),
  lastError: Schema.optional(Schema.String),
})
export type ActorInboxRecord = typeof ActorInboxRecord.Type
