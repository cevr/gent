import { Layer } from "effect"
import type { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { EventBus, ToolRegistry, Permission, PermissionHandler, PlanHandler } from "@gent/core"
import { Storage } from "@gent/storage"
import { Provider } from "@gent/providers"
import { AgentLoop, SteerCommand, AgentLoopError, CheckpointService } from "@gent/runtime"
import { AllTools, AskUserHandler } from "@gent/tools"
import {
  GentCore,
  type GentCoreService,
  type GentCoreError,
  type CreateSessionInput,
  type CreateSessionOutput,
  type CreateBranchInput,
  type CreateBranchOutput,
  type SendMessageInput,
  type SessionInfo,
  type BranchInfo,
  type MessageInfo,
  StorageError,
} from "./core.js"

// System prompt
export { DEFAULT_SYSTEM_PROMPT, buildSystemPrompt } from "./system-prompt"

// Re-export from core
export { SteerCommand, AgentLoopError, StorageError }
export {
  GentCore,
  type GentCoreService,
  type GentCoreError,
  type CreateSessionInput,
  type CreateSessionOutput,
  type CreateBranchInput,
  type CreateBranchOutput,
  type SendMessageInput,
  type SessionInfo,
  type BranchInfo,
  type MessageInfo,
}
export { GentRpcError } from "./errors.js"

// Re-export RPC handlers
export { RpcHandlersLive } from "./rpc-handlers"

// Operations (shared schemas)
export {
  CreateSessionPayload,
  CreateSessionSuccess,
  SessionInfo as SessionInfoSchema,
  SendMessagePayload,
  ListMessagesPayload,
  MessageInfo as MessageInfoSchema,
  SteerPayload,
  SubscribeEventsPayload,
  BranchInfo as BranchInfoSchema,
  ListBranchesPayload,
  CreateBranchPayload,
  CreateBranchSuccess,
  RespondPermissionPayload,
  RespondPlanPayload,
} from "./operations.js"

// RPC definitions
export { GentRpcs, type GentRpcsClient } from "./rpcs"

// HTTP API
export {
  GentApi,
  SessionsApi,
  MessagesApi,
  EventsApi,
  SendMessageRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  SteerRequest,
} from "./http-api.js"

// ============================================================================
// Dependencies Layer
// ============================================================================

export interface DependenciesConfig {
  systemPrompt: string
  defaultModel: string
  dbPath?: string
  compactionModel?: string
}

/**
 * Creates the full dependency layer for GentCore
 */
export const createDependencies = (
  config: DependenciesConfig,
): Layer.Layer<
  | Storage
  | Provider
  | ToolRegistry
  | EventBus
  | Permission
  | PermissionHandler
  | AgentLoop
  | CheckpointService
  | AskUserHandler
  | PlanHandler,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> => {
  const StorageLive = Storage.Live(config.dbPath ?? ".gent/data.db")

  const BaseServicesLive = Layer.mergeAll(
    StorageLive,
    Provider.Live,
    ToolRegistry.Live(AllTools),
    EventBus.Live,
    Permission.Live(),
  )

  // AskUserHandler requires EventBus
  const AskUserHandlerLive = Layer.provide(AskUserHandler.Live, BaseServicesLive)

  // PermissionHandler requires EventBus
  const PermissionHandlerLive = Layer.provide(PermissionHandler.Live, BaseServicesLive)

  // PlanHandler requires EventBus
  const PlanHandlerLive = Layer.provide(PlanHandler.Live, BaseServicesLive)

  // CheckpointService requires Storage and Provider
  const CheckpointServiceLive = CheckpointService.Live(
    config.compactionModel ?? "anthropic/claude-haiku-4-5-20251001",
  )
  const CheckpointLayer = Layer.provide(CheckpointServiceLive, BaseServicesLive)

  // AgentLoop requires CheckpointService and FileSystem
  const AgentLoopLive = AgentLoop.Live({
    systemPrompt: config.systemPrompt,
    defaultModel: config.defaultModel,
  })

  // Compose all dependencies - AgentLoop needs BaseServices + CheckpointService + FileSystem
  const AllDeps = Layer.mergeAll(
    BaseServicesLive,
    CheckpointLayer,
    AskUserHandlerLive,
    PermissionHandlerLive,
    PlanHandlerLive,
  )

  return Layer.merge(AllDeps, Layer.provide(AgentLoopLive, AllDeps))
}

// Re-export AskUserHandler for RPC handlers
export { AskUserHandler }
