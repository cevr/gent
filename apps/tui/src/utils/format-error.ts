import type { GentRpcError } from "@gent/server"

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
    case "CheckpointError":
      return `Checkpoint: ${error.message}`
    case "BadArgument":
      return `${error.module}.${error.method}: ${error.description ?? "bad argument"}`
    case "SystemError":
      return `${error.module}.${error.method}: ${error.reason}${
        error.pathOrDescriptor !== undefined && error.pathOrDescriptor !== null
          ? ` (${error.pathOrDescriptor})`
          : ""
      }`
  }
}
