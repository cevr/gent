import { Context, Effect, Layer, Stream } from "effect"
import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import {
  EventBus,
  ToolRegistry,
  Permission,
  type AgentEvent,
} from "@gent/core"
import { Storage } from "@gent/storage"
import { Provider } from "@gent/providers"
import { AgentLoop, SteerCommand, AgentLoopError } from "@gent/runtime"
import { AllTools } from "@gent/tools"
import {
  GentCore,
  type GentCoreService,
  type GentCoreError,
  type CreateSessionInput,
  type CreateSessionOutput,
  type SendMessageInput,
  type SessionInfo,
  type BranchInfo,
  type MessageInfo,
  StorageError,
} from "./core.js"

// Re-export from core
export { SteerCommand, AgentLoopError, StorageError }
export {
  GentCore,
  type GentCoreService,
  type GentCoreError,
  type CreateSessionInput,
  type CreateSessionOutput,
  type SendMessageInput,
  type SessionInfo,
  type BranchInfo,
  type MessageInfo,
}

// Re-export RPC handlers
export { RpcHandlersLive } from "./rpc-handlers.js"

// Legacy types for backward compatibility
export type GentServerError = GentCoreError

export interface GentServerService {
  readonly createSession: (
    input: CreateSessionInput
  ) => Effect.Effect<CreateSessionOutput, GentServerError>

  readonly listSessions: () => Effect.Effect<SessionInfo[], GentServerError>

  readonly getSession: (
    sessionId: string
  ) => Effect.Effect<SessionInfo | null, GentServerError>

  readonly deleteSession: (
    sessionId: string
  ) => Effect.Effect<void, GentServerError>

  readonly sendMessage: (
    input: SendMessageInput
  ) => Effect.Effect<void, GentServerError>

  readonly listMessages: (
    branchId: string
  ) => Effect.Effect<MessageInfo[], GentServerError>

  readonly steer: (command: SteerCommand) => Effect.Effect<void, GentServerError>

  readonly subscribeEvents: (
    sessionId: string
  ) => Stream.Stream<AgentEvent, never, never>
}

/**
 * Legacy GentServer - delegates to GentCore
 * @deprecated Use GentCore + RpcHandlersLive instead
 */
export class GentServer extends Context.Tag("GentServer")<
  GentServer,
  GentServerService
>() {
  static Live = (config: {
    systemPrompt: string
    defaultModel: string
    dbPath?: string
  }): Layer.Layer<GentServer, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      GentServer,
      Effect.gen(function* () {
        // GentServer now just delegates to GentCore
        const core = yield* GentCore
        return core
      })
    ).pipe(
      Layer.provide(GentCore.Live),
      Layer.provide(GentServer.Dependencies(config))
    )

  static Dependencies = (config: {
    systemPrompt: string
    defaultModel: string
    dbPath?: string
  }): Layer.Layer<
    Storage | Provider | ToolRegistry | EventBus | Permission | AgentLoop,
    PlatformError,
    FileSystem.FileSystem | Path.Path
  > => {
    const StorageLive = Storage.Live(config.dbPath ?? ".gent/data.db")

    const BaseServicesLive = Layer.mergeAll(
      StorageLive,
      Provider.Live,
      ToolRegistry.Live(AllTools),
      EventBus.Live,
      Permission.Live()
    )

    const AgentLoopLive = AgentLoop.Live({
      systemPrompt: config.systemPrompt,
      defaultModel: config.defaultModel,
    })

    return Layer.merge(
      BaseServicesLive,
      Layer.provide(AgentLoopLive, BaseServicesLive)
    )
  }
}
