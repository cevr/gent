import type { PlatformError } from "effect"
import { Config, Effect, Layer, Option, FileSystem, Path } from "effect"
import { ToolRegistry } from "../domain/tool.js"
import { Permission } from "../domain/permission.js"
import { PermissionHandler, PromptHandler, HandoffHandler } from "../domain/interaction-handlers.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { Skills } from "../domain/skills.js"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthStorage } from "../domain/auth-storage.js"
import { AuthStore } from "../domain/auth-store.js"
import { AgentRegistry } from "../domain/agent.js"
import type { SubagentRunnerService } from "../domain/agent.js"
import { FileLockService } from "../domain/file-lock.js"
import type { EventStore } from "../domain/event.js"
import { Storage } from "../storage/sqlite-storage.js"
import { Provider } from "../providers/provider.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { ProviderFactory } from "../providers/provider-factory.js"
import { AgentLoop, SteerCommand, AgentLoopError, AgentActor } from "../runtime/agent/agent-loop.js"
import {
  InProcessRunner,
  SubprocessRunner,
  SubagentRunnerConfig,
} from "../runtime/agent/subagent-runner.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { LocalActorProcessLive, type ActorProcess } from "../runtime/actor-process.js"
import { ConfigService } from "../runtime/config-service.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { TaskService } from "../runtime/task-service.js"
import { AllTools } from "../tools/index.js"
import { BuiltinExtensions } from "../extensions/index.js"
import type { LoadedExtension } from "../domain/extension.js"
import { AskUserHandler } from "../tools/ask-user.js"
import { EventStoreLive } from "./event-store.js"
import { buildSystemPrompt } from "./system-prompt.js"
import * as nodePath from "node:path"
import * as os from "node:os"
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
export { GentRpcError, NotFoundError } from "./errors.js"

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
  SessionTreeNodeSchema,
  type SessionTreeNodeType,
  GetChildSessionsPayload,
  GetSessionTreePayload,
  SwitchBranchPayload,
  ForkBranchPayload,
  ForkBranchSuccess,
  RespondPermissionPayload,
  RespondPromptPayload,
  RespondHandoffPayload,
  RespondHandoffSuccess,
  UpdateSessionBypassPayload,
  UpdateSessionBypassSuccess,
  AuthProviderInfo,
  SetAuthKeyPayload,
  DeleteAuthKeyPayload,
  ListAuthMethodsSuccess,
  AuthorizeAuthPayload,
  AuthorizeAuthSuccess,
  CallbackAuthPayload,
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
  authFilePath?: string
  authKeyPath?: string
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
  | ExtensionRegistry
  | SubagentRunnerService
  | EventStore
  | Permission
  | Skills
  | ConfigService
  | ModelRegistry
  | PermissionHandler
  | AgentLoop
  | ActorProcess
  | AskUserHandler
  | PromptHandler
  | PromptPresenter
  | HandoffHandler
  | AuthStorage
  | AuthStore
  | AuthGuard
  | ProviderAuth
  | FileLockService,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> => {
  // Build ExtensionRegistry from builtins (loaded synchronously)
  const builtinLoaded: LoadedExtension[] = BuiltinExtensions.map((ext) => ({
    manifest: ext.manifest,
    kind: "builtin" as const,
    sourcePath: "builtin",
    setup: Effect.runSync(
      ext.setup({ cwd: config.cwd, config: undefined as never, source: "builtin" }),
    ),
  }))
  const ExtensionRegistryLive = ExtensionRegistry.Live(builtinLoaded)

  const StorageLive = Storage.Live(config.dbPath ?? ".gent/data.db")

  const EventStoreLayer = Layer.provide(EventStoreLive, StorageLive)

  const ConfigServiceLive = ConfigService.Live
  const home = Effect.runSync(
    Effect.gen(function* () {
      const maybeHome = yield* Config.option(Config.string("HOME"))
      return Option.getOrElse(maybeHome, () => os.homedir())
    }).pipe(Effect.catchEager(() => Effect.succeed(os.homedir()))),
  )
  const globalSkillsDir = nodePath.join(home, ".gent", "skills")
  const claudeSkillsDir = nodePath.join(home, ".claude", "skills")

  const SkillsLive = Skills.Live({
    cwd: config.cwd,
    globalDir: globalSkillsDir,
    claudeSkillsDir,
    extraDirs: config.skillsDirs,
  })

  const PermissionLive = Layer.unwrap(
    Effect.gen(function* () {
      const configService = yield* ConfigService
      const rules = yield* configService.getPermissionRules()
      return Permission.Live(rules, "ask")
    }),
  )

  const AuthStorageLive = AuthStorage.LiveSystem({
    serviceName: "gent",
    ...(config.authFilePath !== undefined ? { filePath: config.authFilePath } : {}),
    ...(config.authKeyPath !== undefined ? { keyPath: config.authKeyPath } : {}),
  })
  const AuthStoreLive = Layer.provide(AuthStore.Live, AuthStorageLive)
  const AuthGuardLive = Layer.provide(AuthGuard.Live, AuthStoreLive)
  const ProviderAuthLive = Layer.provide(ProviderAuth.Live, AuthStoreLive)

  // Base services that don't depend on ConfigService
  const CoreServicesLive = Layer.mergeAll(
    StorageLive,
    AuthStorageLive,
    AuthStoreLive,
    AuthGuardLive,
    ProviderAuthLive,
    ToolRegistry.Live(AllTools),
    AgentRegistry.Live,
    ExtensionRegistryLive,
    EventStoreLayer,
    ConfigServiceLive,
    ModelRegistry.Live,
    SkillsLive,
    FileLockService.layer,
  )

  // ProviderFactory uses built-in providers only
  const ProviderFactoryLive = Layer.provide(ProviderFactory.Live, AuthStoreLive)

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
  // PermissionHandler requires EventStore
  const PermissionHandlerLive = Layer.provide(PermissionHandler.Live, BaseWithPermission)

  const ToolRunnerLive = Layer.provide(
    ToolRunner.Live,
    Layer.merge(BaseWithPermission, PermissionHandlerLive),
  )

  // PromptHandler requires EventStore
  const PromptHandlerLive = Layer.provide(PromptHandler.Live, BaseWithPermission)

  // PromptPresenter requires PromptHandler + FileSystem + Path (from BunServices)
  const PromptPresenterLive = Layer.provide(
    PromptPresenter.Live,
    Layer.merge(PromptHandlerLive, BaseWithPermission),
  )

  // HandoffHandler requires EventStore
  const HandoffHandlerLive = Layer.provide(HandoffHandler.Live, BaseWithPermission)

  // AgentLoop requires Storage, Provider, EventStore, etc.
  const AgentRuntimeLive = Layer.unwrap(
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

  // Compose all dependencies
  const AllDeps = Layer.mergeAll(
    BaseWithPermission,
    AskUserHandlerLive,
    PermissionHandlerLive,
    ToolRunnerLive,
    PromptHandlerLive,
    PromptPresenterLive,
    HandoffHandlerLive,
  )

  const AgentRuntimeDeps = Layer.provide(AgentRuntimeLive, AllDeps)

  // TaskService requires SubagentRunnerService (from AgentRuntime) + Storage + EventStore + AgentRegistry
  const TaskServiceDeps = Layer.merge(AllDeps, AgentRuntimeDeps)
  const TaskServiceLive = Layer.provide(TaskService.Live, TaskServiceDeps)

  const AllWithRuntime = Layer.mergeAll(AllDeps, AgentRuntimeDeps, TaskServiceLive)

  const ActorProcessLive = Layer.provide(LocalActorProcessLive, AllWithRuntime)

  return Layer.mergeAll(AllWithRuntime, ActorProcessLive)
}

// Re-export AskUserHandler for RPC handlers
export { AskUserHandler }
