import { Effect, Layer } from "effect"
import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import {
  ToolRegistry,
  Permission,
  PermissionHandler,
  PlanHandler,
  Skills,
  AuthStorage,
  type EventStore,
} from "@gent/core"
import { Storage } from "@gent/storage"
import { Provider } from "@gent/providers"
import {
  AgentLoop,
  SteerCommand,
  AgentLoopError,
  CheckpointService,
  ConfigService,
  InstructionsLoader,
} from "@gent/runtime"
import { AllTools, AskUserHandler, QuestionHandler } from "@gent/tools"
import { EventStoreLive } from "./event-store.js"
import { buildSystemPrompt } from "./system-prompt.js"
import * as nodePath from "node:path"
import {
  GentCore,
  type GentCoreService,
  type GentCoreError,
  type CreateSessionInput,
  type CreateSessionOutput,
  type CreateBranchInput,
  type CreateBranchOutput,
  type SendMessageInput,
  type SubscribeEventsInput,
  type GetSessionStateInput,
  type SessionState,
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
  type SubscribeEventsInput,
  type GetSessionStateInput,
  type SessionState,
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
  GetSessionStatePayload,
  SessionState as SessionStateSchema,
  SteerPayload,
  SubscribeEventsPayload,
  BranchInfo as BranchInfoSchema,
  ListBranchesPayload,
  CreateBranchPayload,
  CreateBranchSuccess,
  BranchTreeNodeSchema,
  GetBranchTreePayload,
  SwitchBranchPayload,
  ForkBranchPayload,
  ForkBranchSuccess,
  RespondPermissionPayload,
  RespondPlanPayload,
  CompactBranchPayload,
  UpdateSessionBypassPayload,
  UpdateSessionBypassSuccess,
  AuthProviderInfo,
  SetAuthKeyPayload,
  DeleteAuthKeyPayload,
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
  cwd: string
  defaultModel: string
  dbPath?: string
  compactionModel?: string
  skillsDirs?: ReadonlyArray<string>
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
  | EventStore
  | Permission
  | Skills
  | ConfigService
  | InstructionsLoader
  | PermissionHandler
  | AgentLoop
  | CheckpointService
  | AskUserHandler
  | QuestionHandler
  | PlanHandler
  | AuthStorage,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> => {
  const StorageLive = Storage.Live(config.dbPath ?? ".gent/data.db")

  const EventStoreLayer = Layer.provide(EventStoreLive, StorageLive)

  const ConfigServiceLive = ConfigService.Live
  const InstructionsLoaderLive = InstructionsLoader.Live

  const home = process.env["HOME"] ?? "~"
  const globalSkillsDir = nodePath.join(home, ".gent", "skills")
  const claudeSkillsDir = nodePath.join(home, ".claude", "skills")

  const SkillsLive = Skills.Live({
    cwd: config.cwd,
    globalDir: globalSkillsDir,
    claudeSkillsDir,
    extraDirs: config.skillsDirs,
  })

  const PermissionLive = Layer.unwrapEffect(
    Effect.gen(function* () {
      const configService = yield* ConfigService
      const rules = yield* configService.getPermissionRules()
      return Permission.Live(rules, "ask")
    }),
  )

  const AuthStorageLive = AuthStorage.LiveKeychain("gent")

  const ProviderLive = Layer.provide(Provider.Live, AuthStorageLive)

  const BaseServicesLive = Layer.mergeAll(
    StorageLive,
    ProviderLive,
    AuthStorageLive,
    ToolRegistry.Live(AllTools),
    EventStoreLayer,
    ConfigServiceLive,
    InstructionsLoaderLive,
    SkillsLive,
  )

  const PermissionLayer = Layer.provide(PermissionLive, BaseServicesLive)
  const BaseWithPermission = Layer.merge(BaseServicesLive, PermissionLayer)

  // AskUserHandler requires EventStore
  const AskUserHandlerLive = Layer.provide(AskUserHandler.Live, BaseWithPermission)
  const QuestionHandlerLive = Layer.provide(QuestionHandler.Live, AskUserHandlerLive)

  // PermissionHandler requires EventStore
  const PermissionHandlerLive = Layer.provide(PermissionHandler.Live, BaseWithPermission)

  // PlanHandler requires EventStore
  const PlanHandlerLive = Layer.provide(PlanHandler.Live, BaseWithPermission)

  // CheckpointService requires Storage and Provider
  const CheckpointServiceLive = CheckpointService.Live(
    config.compactionModel ?? "anthropic/claude-haiku-4-5-20251001",
  )
  const CheckpointLayer = Layer.provide(CheckpointServiceLive, BaseWithPermission)

  // AgentLoop requires CheckpointService and FileSystem
  const AgentLoopLive = Layer.unwrapEffect(
    Effect.gen(function* () {
      const instructions = yield* InstructionsLoader
      const skills = yield* Skills
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const customInstructions = yield* instructions.load(config.cwd)
      const skillsList = yield* skills.list()
      const isGitRepo = yield* fs.exists(path.join(config.cwd, ".git"))

      const systemPrompt = buildSystemPrompt({
        cwd: config.cwd,
        platform: process.platform,
        isGitRepo,
        customInstructions,
        skills: skillsList,
      })

      return AgentLoop.Live({
        systemPrompt,
        defaultModel: config.defaultModel,
      })
    }),
  )

  // Compose all dependencies - AgentLoop needs BaseServices + CheckpointService + FileSystem
  const AllDeps = Layer.mergeAll(
    BaseWithPermission,
    CheckpointLayer,
    AskUserHandlerLive,
    QuestionHandlerLive,
    PermissionHandlerLive,
    PlanHandlerLive,
  )

  return Layer.merge(AllDeps, Layer.provide(AgentLoopLive, AllDeps))
}

// Re-export AskUserHandler for RPC handlers
export { AskUserHandler }
