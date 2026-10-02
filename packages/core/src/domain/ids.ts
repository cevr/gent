import { Context, Schema } from "effect"

// ── ids ─────────────────────────────────────────────────────────────────────

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const BranchId = Schema.String.pipe(Schema.brand("BranchId"))
export type BranchId = typeof BranchId.Type

export const MessageId = Schema.String.pipe(Schema.brand("MessageId"))
export type MessageId = typeof MessageId.Type

export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type

export const ToolId = Schema.String.pipe(Schema.brand("ToolId"))
export type ToolId = typeof ToolId.Type

export const RpcId = Schema.String.pipe(Schema.brand("RpcId"))
export type RpcId = typeof RpcId.Type

export const ActorCommandId = Schema.String.pipe(Schema.brand("ActorCommandId"))
export type ActorCommandId = typeof ActorCommandId.Type

export const InteractionRequestId = Schema.String.pipe(Schema.brand("InteractionRequestId"))
export type InteractionRequestId = typeof InteractionRequestId.Type

/**
 * Client-generated request ID for end-to-end correlation and transport-retry
 * dedup. Bounded to 128 chars so a malicious/buggy client cannot bloat the
 * in-flight dedup table and the durable operation rows with arbitrary-length
 * keys. Callers in this repo make a UUID through the platform random id,
 * which fits.
 */
export const RequestId = Schema.String.check(Schema.isMaxLength(128))
export type RequestId = typeof RequestId.Type

/**
 * A client's extension request while it runs, as its branch's loop knows it.
 * A message the request sends to its own branch carries the grant, and the
 * loop stamps the client origin only if the grant is still live when it
 * admits the message.
 */
export const ClientRequestGrant = Schema.String.pipe(Schema.brand("ClientRequestGrant"))
export type ClientRequestGrant = typeof ClientRequestGrant.Type

export const ExtensionId = Schema.String.pipe(Schema.brand("ExtensionId"))
export type ExtensionId = typeof ExtensionId.Type

// ── workspace ───────────────────────────────────────────────────────────────

/** A workspace: the sha256 of a resolved working directory (`workspaceIdForCwd`). */
export const WorkspaceId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("WorkspaceId"),
)
export type WorkspaceId = typeof WorkspaceId.Type
export const DefaultWorkspaceId: WorkspaceId = WorkspaceId.make("0".repeat(64))

/** The workspace a request runs in; the workspace middleware sets it per request. */
export const CurrentWorkspaceId = Context.Reference<WorkspaceId>(
  "@gent/core/src/domain/ids/CurrentWorkspaceId",
  { defaultValue: () => DefaultWorkspaceId },
)

// ── process-generation ──────────────────────────────────────────────────────

/**
 * Identity of one live process. A process-local tool binding names the
 * process that recorded it and is never valid after a restart.
 */
export const ProcessGenerationId = Schema.NonEmptyString.pipe(Schema.brand("ProcessGenerationId"))
export type ProcessGenerationId = typeof ProcessGenerationId.Type
