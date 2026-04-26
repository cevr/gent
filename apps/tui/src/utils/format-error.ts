import type { GentRpcError } from "@gent/sdk"

export interface ClientError {
  readonly _tag: "ClientError"
  readonly message: string
}

export const ClientError = (message: string): ClientError => ({
  _tag: "ClientError",
  message,
})

export type UiError = GentRpcError | ClientError

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

const extractUnknownMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === "string") return message
  }
  return String(error)
}

export const formatConnectionIssue = (error: unknown): string => {
  const message =
    error !== null && typeof error === "object" && "_tag" in error
      ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TUI adapter narrows heterogeneous framework value shape
        formatError(error as UiError)
      : extractUnknownMessage(error)

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
