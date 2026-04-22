import { Schema } from "effect"
import { ExtensionProtocolError } from "../domain/extension-protocol.js"
import { EventStoreError } from "../domain/event.js"
import { ProviderError } from "../providers/provider.js"
import { ProviderAuthError } from "../providers/provider-auth.js"
import { SessionRuntimeErrorSchema, type SessionRuntimeError } from "../runtime/session-runtime.js"
import { StorageError } from "../storage/sqlite-storage.js"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  message: Schema.String,
  entity: Schema.Literals(["session", "branch", "message", "driver"]),
}) {}

// Schema-compatible wrapper for PlatformError (Data.TaggedError, not Schema-based)
export class PlatformErrorSchema extends Schema.TaggedErrorClass<PlatformErrorSchema>()(
  "PlatformError",
  {
    message: Schema.String,
    reason: Schema.String,
  },
) {}

export type GentRpcError =
  | StorageError
  | SessionRuntimeError
  | ProviderError
  | ProviderAuthError
  | ExtensionProtocolError
  | PlatformErrorSchema
  | EventStoreError
  | NotFoundError

export type AppServiceError = GentRpcError

export const GentRpcError = Schema.Union([
  StorageError,
  SessionRuntimeErrorSchema,
  ProviderError,
  ProviderAuthError,
  ExtensionProtocolError,
  PlatformErrorSchema,
  EventStoreError,
  NotFoundError,
])
