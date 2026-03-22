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
    case "AgentLoopError":
      return `Agent: ${error.message}`
    case "ProviderError":
      return `${error.model}: ${error.message}`
    case "EventStoreError":
      return `Events: ${error.message}`
    case "NotFoundError":
      return `Not found: ${error.message}`
    case "ActorProcessError":
      return `Actor: ${error.message}`
    case "PlatformError":
      return `Platform: ${error.message}`
    case "ProviderAuthError":
      return `Auth: ${error.message}`
    default:
      return "Unknown error"
  }
}
