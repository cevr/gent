import { Schema } from "effect"
import { PlatformError as PlatformErrorSchema, type PlatformError } from "@effect/platform/Error"
import { EventStoreError } from "@gent/core"
import { ProviderError, ProviderAuthError } from "@gent/providers"
import { ActorProcessError, AgentLoopError, CheckpointError } from "@gent/runtime"
import { StorageError } from "@gent/storage"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  message: Schema.String,
  entity: Schema.Literal("session", "branch", "message"),
}) {}

export type GentRpcError =
  | StorageError
  | ActorProcessError
  | AgentLoopError
  | ProviderError
  | ProviderAuthError
  | PlatformError
  | EventStoreError
  | CheckpointError
  | NotFoundError

export const GentRpcError = Schema.Union(
  StorageError,
  ActorProcessError,
  AgentLoopError,
  ProviderError,
  ProviderAuthError,
  PlatformErrorSchema,
  EventStoreError,
  CheckpointError,
  NotFoundError,
)
