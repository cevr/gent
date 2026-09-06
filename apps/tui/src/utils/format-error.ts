import type { GentClientRpcError } from "@gent/sdk"
import { GentRpcError } from "@gent/core-internal/server/errors"
import { GentConnectionError } from "@gent/core-internal/server/transport-contract"
import { Predicate, Schema } from "effect"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"

export interface ClientError {
  readonly _tag: "ClientError"
  readonly message: string
}

export const ClientError = (message: string): ClientError => ({
  _tag: "ClientError",
  message,
})

export type UiError = GentClientRpcError | ClientError

export const formatError = (error: UiError): string => {
  switch (error._tag) {
    case "ClientError":
      return error.message
    case "StorageError":
      return `Storage: ${error.message}`
    case "SessionRuntimeError":
      return `Runtime: ${error.message}`
    case "ProviderError":
      return `${error.model}: ${error.message}`
    case "EventStoreError":
      return `Events: ${error.message}`
    case "NotFoundError":
      return `Not found: ${error.message}`
    case "InvalidStateError":
      return `Invalid: ${error.message}`
    case "PlatformError":
      return `Platform: ${error.message}`
    case "ProviderAuthError":
      return `Auth: ${error.message}`
    case "DriverError":
      return `Driver ${error.driver._tag}: ${error.driver.id}: ${error.reason}`
    case "ExtensionProtocolError":
      return `Extension protocol: ${error.message}`
    case "RpcClientError":
      return `Connection: ${error.message}`
    case "@gent/core/GentConnectionError":
      return `Connection: ${error.message}`
    default:
      return "Unknown error"
  }
}

// eslint-disable-next-line effect/noUnknownParameters -- Connection failures cross framework boundaries; inspect only their message property.
const extractUnknownMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (Predicate.isString(error)) return error
  if (Predicate.isObject(error) && "message" in error) {
    if (Predicate.isString(error["message"])) return error["message"]
  }
  return String(error)
}

const isUiError = Schema.is(
  Schema.Union([
    GentRpcError,
    GentConnectionError,
    RpcClientError,
    Schema.TaggedStruct("ClientError", { message: Schema.String }),
  ]),
)

// eslint-disable-next-line effect/noUnknownParameters -- Validate transport and framework errors before applying domain error formatting.
export const formatConnectionIssue = (error: unknown): string => {
  let message: string
  if (isUiError(error)) message = formatError(error)
  else message = extractUnknownMessage(error)

  const normalized = message.toLowerCase()
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket hang up") ||
    normalized.includes("connection reset") ||
    normalized.includes("fetch failed") ||
    normalized.includes("network")
  ) {
    return "connection lost; retrying"
  }

  return `connection issue: ${message}`
}
