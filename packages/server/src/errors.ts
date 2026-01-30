import { Schema } from "effect"
import { PlatformError as PlatformErrorSchema, type PlatformError } from "@effect/platform/Error"
import { EventStoreError } from "@gent/core"
import { ProviderError } from "@gent/providers"
import { ActorProcessError, AgentLoopError, CheckpointError } from "@gent/runtime"
import { StorageError } from "@gent/storage"

export type GentRpcError =
  | StorageError
  | ActorProcessError
  | AgentLoopError
  | ProviderError
  | PlatformError
  | EventStoreError
  | CheckpointError

export const GentRpcError = Schema.Union(
  StorageError,
  ActorProcessError,
  AgentLoopError,
  ProviderError,
  PlatformErrorSchema,
  EventStoreError,
  CheckpointError,
)
