import { Schema } from "effect"

/** Schema.brand helper kept only to standardize branded-id declarations. */
export const branded =
  <B extends string>(brand: B) =>
  <S extends Schema.Top>(schema: S) =>
    schema.pipe(Schema.brand(brand))

export const SessionId = Schema.String.pipe(branded("SessionId"))
export type SessionId = typeof SessionId.Type

export const BranchId = Schema.String.pipe(branded("BranchId"))
export type BranchId = typeof BranchId.Type

export const MessageId = Schema.String.pipe(branded("MessageId"))
export type MessageId = typeof MessageId.Type

export const ToolCallId = Schema.String.pipe(branded("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type

export const ToolId = Schema.String.pipe(branded("ToolId"))
export type ToolId = typeof ToolId.Type

export const RpcId = Schema.String.pipe(branded("RpcId"))
export type RpcId = typeof RpcId.Type

export const ActorCommandId = Schema.String.pipe(branded("ActorCommandId"))
export type ActorCommandId = typeof ActorCommandId.Type

export const InteractionRequestId = Schema.String.pipe(branded("InteractionRequestId"))
export type InteractionRequestId = typeof InteractionRequestId.Type

/**
 * Client-generated request ID for end-to-end correlation and transport-retry
 * dedup. Bounded to 128 chars so a malicious/buggy client cannot bloat the
 * per-server dedup cache with arbitrary-length keys. Callers in this repo
 * use `crypto.randomUUID()` which fits comfortably.
 */
export const RequestId = Schema.String.check(Schema.isMaxLength(128))
export type RequestId = typeof RequestId.Type

export const ExtensionId = Schema.String.pipe(branded("ExtensionId"))
export type ExtensionId = typeof ExtensionId.Type
