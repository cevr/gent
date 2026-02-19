import { Schema } from "effect"
import { EventStoreError } from "@gent/core"
import { ProviderError, ProviderAuthError } from "@gent/providers"
import { ActorProcessError, AgentLoopError, CheckpointError } from "@gent/runtime"
import { StorageError } from "@gent/storage"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  message: Schema.String,
  entity: Schema.Literals(["session", "branch", "message"]),
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
  | ActorProcessError
  | AgentLoopError
  | ProviderError
  | ProviderAuthError
  | PlatformErrorSchema
  | EventStoreError
  | CheckpointError
  | NotFoundError

export const GentRpcError = Schema.Union([
  StorageError,
  ActorProcessError,
  AgentLoopError,
  ProviderError,
  ProviderAuthError,
  PlatformErrorSchema,
  EventStoreError,
  CheckpointError,
  NotFoundError,
])
