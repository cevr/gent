import { Schema } from "effect"
import { PlatformError as PlatformErrorSchema, type PlatformError } from "@effect/platform/Error"
import { EventStoreError } from "@gent/core"
import { ProviderError } from "@gent/providers"
import { AgentLoopError } from "@gent/runtime"
import { StorageError } from "@gent/storage"

export type GentRpcError =
  | StorageError
  | AgentLoopError
  | ProviderError
  | PlatformError
  | EventStoreError

export const GentRpcError = Schema.Union(
  StorageError,
  AgentLoopError,
  ProviderError,
  PlatformErrorSchema,
  EventStoreError,
)
