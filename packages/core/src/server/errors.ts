import { Schema } from "effect"
import { InvalidStateError, NotFoundError } from "../domain/business-errors.js"
import { ExtensionProtocolError } from "../domain/extension-protocol.js"
import { EventStoreError } from "../domain/event.js"
import { InteractionRequestMismatchError } from "../domain/interaction-request.js"
import { DriverError, ProviderAuthError } from "../domain/driver.js"
import { ProviderError } from "../providers/provider.js"
import { SessionRuntimeErrorSchema, type SessionRuntimeError } from "../runtime/session-runtime.js"
import { StorageError } from "../storage/sqlite-storage.js"

export { InvalidStateError, NotFoundError } from "../domain/business-errors.js"

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
  | DriverError
  | ExtensionProtocolError
  | PlatformErrorSchema
  | EventStoreError
  | InteractionRequestMismatchError
  | NotFoundError
  | InvalidStateError

export type AppServiceError = GentRpcError

export const GentRpcError = Schema.Union([
  StorageError,
  SessionRuntimeErrorSchema,
  ProviderError,
  ProviderAuthError,
  DriverError,
  ExtensionProtocolError,
  PlatformErrorSchema,
  EventStoreError,
  InteractionRequestMismatchError,
  NotFoundError,
  InvalidStateError,
])
