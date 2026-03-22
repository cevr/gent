import { Schema } from "effect"
import { EventStoreError } from "../domain/event.js"
import { ProviderError } from "../providers/provider.js"
import { ProviderAuthError } from "../providers/provider-auth.js"
import { ActorProcessError } from "../runtime/actor-process.js"
import { AgentLoopError } from "../runtime/agent/agent-loop.js"
import { StorageError } from "../storage/sqlite-storage.js"

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
  | NotFoundError

export const GentRpcError = Schema.Union([
  StorageError,
  ActorProcessError,
  AgentLoopError,
  ProviderError,
  ProviderAuthError,
  PlatformErrorSchema,
  EventStoreError,
  NotFoundError,
])
