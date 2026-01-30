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
  AgentRegistry,
  resolveAgentModelId,
} from "@gent/core"
import type { SubagentRunnerService, EventStore } from "@gent/core"
import { Storage } from "@gent/storage"
import { Provider, ProviderFactory } from "@gent/providers"
import {
  AgentLoop,
  SteerCommand,
  AgentLoopError,
  LocalActorProcessLive,
  CheckpointService,
  ConfigService,
  ModelRegistry,
  AgentActor,
  ActorSystemDefault,
  InProcessRunner,
  SubprocessRunner,
  SubagentRunnerConfig,
  ToolRunner,
} from "@gent/runtime"
import type { ActorProcess } from "@gent/runtime"
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
} from "./rpcs"

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
  subprocessBinaryPath?: string
  dbPath?: string
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
  | ProviderFactory
  | ToolRegistry
  | AgentRegistry
  | SubagentRunnerService
  | EventStore
  | Permission
  | Skills
  | ConfigService
  | ModelRegistry
  | PermissionHandler
  | AgentLoop
  | ActorProcess
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

  // Base services that don't depend on ConfigService
  const CoreServicesLive = Layer.mergeAll(
    StorageLive,
    AuthStorageLive,
    ToolRegistry.Live(AllTools),
    AgentRegistry.Live,
    EventStoreLayer,
    ActorSystemDefault,
    ConfigServiceLive,
    ModelRegistry.Live,
    SkillsLive,
  )

  // ProviderFactory uses built-in providers only
  const ProviderFactoryLive = Layer.provide(ProviderFactory.Live, AuthStorageLive)

  // Provider depends on ProviderFactory
  const ProviderLive = Layer.provide(Provider.Live, ProviderFactoryLive)

  // Build base services with provider layers on top
  const BaseServicesLive = Layer.merge(
    CoreServicesLive,
    Layer.provideMerge(Layer.merge(ProviderLive, ProviderFactoryLive), CoreServicesLive),
  )

  const PermissionLayer = Layer.provide(PermissionLive, BaseServicesLive)
  const BaseWithPermission = Layer.merge(BaseServicesLive, PermissionLayer)

  // AskUserHandler requires EventStore
  const AskUserHandlerLive = Layer.provide(AskUserHandler.Live, BaseWithPermission)
  const QuestionHandlerLive = Layer.provide(QuestionHandler.Live, AskUserHandlerLive)

  // PermissionHandler requires EventStore
  const PermissionHandlerLive = Layer.provide(PermissionHandler.Live, BaseWithPermission)

  const ToolRunnerLive = Layer.provide(
    ToolRunner.Live,
    Layer.merge(BaseWithPermission, PermissionHandlerLive),
  )

  // PlanHandler requires EventStore
  const PlanHandlerLive = Layer.provide(PlanHandler.Live, BaseWithPermission)

  // CheckpointService requires Storage and Provider
  const CheckpointServiceLive = CheckpointService.Live(resolveAgentModelId("compaction"))
  const CheckpointLayer = Layer.provide(CheckpointServiceLive, BaseWithPermission)

  // AgentLoop requires CheckpointService and FileSystem
  const AgentRuntimeLive = Layer.unwrapEffect(
    Effect.gen(function* () {
      const skills = yield* Skills
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const configService = yield* ConfigService

      const customInstructions = yield* configService.loadInstructions(config.cwd)
      const skillsList = yield* skills.list()
      const isGitRepo = yield* fs.exists(path.join(config.cwd, ".git"))

      const systemPrompt = buildSystemPrompt({
        cwd: config.cwd,
        platform: process.platform,
        isGitRepo,
        customInstructions,
        skills: skillsList,
      })

      const subprocessBinaryPath = config.subprocessBinaryPath
      const dbPath = config.dbPath

      const agentActorLive = AgentActor.Live
      const subagentRunnerConfigLive = SubagentRunnerConfig.Live({
        systemPrompt,
        ...(subprocessBinaryPath !== undefined && subprocessBinaryPath !== ""
          ? { subprocessBinaryPath }
          : {}),
        ...(dbPath !== undefined && dbPath !== "" ? { dbPath } : {}),
      })
      const subagentRunnerLive =
        subprocessBinaryPath !== undefined && subprocessBinaryPath !== ""
          ? SubprocessRunner.pipe(Layer.provideMerge(subagentRunnerConfigLive))
          : InProcessRunner.pipe(
              Layer.provideMerge(agentActorLive),
              Layer.provideMerge(subagentRunnerConfigLive),
            )

      return Layer.mergeAll(
        AgentLoop.Live({ systemPrompt }),
        agentActorLive,
        subagentRunnerConfigLive,
        subagentRunnerLive,
      )
    }),
  )

  // Compose all dependencies - AgentLoop needs BaseServices + CheckpointService + FileSystem
  const AllDeps = Layer.mergeAll(
    BaseWithPermission,
    CheckpointLayer,
    AskUserHandlerLive,
    QuestionHandlerLive,
    PermissionHandlerLive,
    ToolRunnerLive,
    PlanHandlerLive,
  )

  const AgentRuntimeDeps = Layer.provide(AgentRuntimeLive, AllDeps)
  const ActorProcessLive = Layer.provide(
    LocalActorProcessLive,
    Layer.merge(AllDeps, AgentRuntimeDeps),
  )

  return Layer.mergeAll(AllDeps, AgentRuntimeDeps, ActorProcessLive)
}

// Re-export AskUserHandler for RPC handlers
export { AskUserHandler }
