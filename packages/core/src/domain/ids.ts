import { Schema } from "effect"

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const BranchId = Schema.String.pipe(Schema.brand("BranchId"))
export type BranchId = typeof BranchId.Type

export const MessageId = Schema.String.pipe(Schema.brand("MessageId"))
export type MessageId = typeof MessageId.Type

export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type

export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type

export const ActorCommandId = Schema.String.pipe(Schema.brand("ActorCommandId"))
export type ActorCommandId = typeof ActorCommandId.Type

export const ArtifactId = Schema.String.pipe(Schema.brand("ArtifactId"))
export type ArtifactId = typeof ArtifactId.Type
