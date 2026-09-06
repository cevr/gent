/**
 * Factory for ExtensionHostContext — the unified capability-shaped boundary
 * that extension code (tools, interceptors) uses to access host services.
 *
 * Single wiring point: ToolRunner and agent-loop both call this.
 */

import { Predicate, Context, Effect } from "effect"
import {
  ExtensionHostError,
  ExtensionHostSearchResult,
  type ExtensionHostContext,
} from "../domain/extension-host-context.js"
import { AgentRunnerService, type AgentRunner, type AgentName } from "../domain/agent.js"
import { BranchId, SessionId } from "../domain/ids.js"
import { RuntimeEnvironment, type RuntimeEnvironmentApi } from "./runtime-environment.js"
import {
  ExtensionHostProcessError,
  type ExtensionHostFacts,
  type ExtensionHostPlatform,
} from "../domain/extension.js"
import { ApprovalService, type ApprovalServiceApi } from "./approval-service.js"
import { PromptPresenter, type PromptPresenterService } from "../domain/prompt-presenter.js"
import type { ExtensionRegistryService } from "./extensions/registry.js"
import { BranchStorage, type BranchStorageService } from "../storage/branch-storage.js"
import { MessageStorage, type MessageStorageService } from "../storage/message-storage.js"
import {
  RelationshipStorage,
  type RelationshipStorageService,
} from "../storage/relationship-storage.js"
import { SearchStorage, type SearchStorageService } from "../storage/search-storage.js"
import { SessionStorage, type SessionStorageService } from "../storage/session-storage.js"
import type { MessageMetadata } from "../domain/message.js"
import { SessionMutations, type SessionMutationsService } from "../domain/session-mutations.js"
import { hasMessage } from "../domain/guards.js"

export interface ExtensionSessionControlService {
  readonly queueFollowUp: (input: {
    readonly sourceId: string
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly content: string
    readonly metadata?: MessageMetadata
  }) => Effect.Effect<void, Error>
}

export interface MakeExtensionHostContextDeps {
  readonly platform: RuntimeEnvironmentApi
  readonly host: ExtensionHostPlatform
  readonly approvalService: ApprovalServiceApi
  readonly promptPresenter: PromptPresenterService
  readonly extensionRegistry: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
  readonly sessionStorage: SessionStorageService
  readonly branchStorage: BranchStorageService
  readonly messageStorage: MessageStorageService
  readonly relationshipStorage: RelationshipStorageService
  readonly searchStorage: SearchStorageService
  readonly agentRunner: AgentRunner
  readonly sessionMutations: SessionMutationsService
  readonly sessionControl: ExtensionSessionControlService
}

export interface MakeExtensionHostContextRunInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  /** Session-scoped cwd. Falls back to RuntimeEnvironment.cwd when absent. */
  readonly sessionCwd?: string
}

export interface ExtensionHostContextOverrides {
  readonly extensionRegistry?: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
}

export interface ExtensionHostContextProviderService {
  readonly defaultExtensionRegistry: ExtensionRegistryService
  readonly defaultCapabilityContext?: Context.Context<never>
  readonly forRun: (
    runInfo: MakeExtensionHostContextRunInfo,
    overrides?: ExtensionHostContextOverrides,
  ) => ExtensionHostContext
}

export class ExtensionHostContextProvider extends Context.Service<
  ExtensionHostContextProvider,
  ExtensionHostContextProviderService
>()("@gent/core/src/runtime/make-extension-host-context/ExtensionHostContextProvider") {}

type AmbientHostContextDefaults = Pick<
  MakeExtensionHostContextDeps,
  | "platform"
  | "host"
  | "approvalService"
  | "promptPresenter"
  | "sessionStorage"
  | "branchStorage"
  | "messageStorage"
  | "relationshipStorage"
  | "searchStorage"
  | "agentRunner"
  | "sessionMutations"
  | "sessionControl"
>

const unavailable = (service: string) => () => Effect.die(`${service} not available`)

const errorMessage = (error: Parameters<typeof hasMessage>[0]): string => {
  if (Predicate.isError(error)) return error.message
  if (hasMessage(error)) return error.message
  return String(error)
}

const toHostError =
  (operation: string) =>
  (error: Parameters<typeof hasMessage>[0]): ExtensionHostError =>
    new ExtensionHostError({
      operation,
      message: errorMessage(error),
      cause: error,
    })

export const extensionHostFacts = (host: ExtensionHostPlatform): ExtensionHostFacts => ({
  osInfo: host.osInfo,
  execPath: host.execPath,
  homeDirectory: host.homeDirectory,
  pathListSeparator: host.pathListSeparator,
  commandCandidates: host.commandCandidates,
  isPortFree: host.isPortFree,
  isPidAlive: host.isPidAlive,
})

export const HostPlatformRef = Context.Reference<RuntimeEnvironmentApi>(
  "@gent/core/src/runtime/make-extension-host-context/HostPlatformRef",
  {
    defaultValue: () => ({ cwd: "", home: "", platform: "unknown" }),
  },
)

export const HostExtensionPlatformRef = Context.Reference<ExtensionHostPlatform>(
  "@gent/core/src/runtime/make-extension-host-context/HostExtensionPlatformRef",
  {
    defaultValue: () => ({
      osInfo: {
        platform: "unknown",
        arch: "unknown",
        release: "unknown",
        hostname: "unknown",
        type: "unknown",
      },
      execPath: "",
      homeDirectory: "",
      parentEnv: {},
      randomId: Effect.succeed("00000000-0000-4000-8000-000000000000"),
      pathListSeparator: ":",
      commandCandidates: (command) => [command],
      isPortFree: () => Effect.succeed(false),
      isPidAlive: () => Effect.succeed(false),
      signalPid: () => Effect.void,
      runProcess: (command) =>
        Effect.fail(
          new ExtensionHostProcessError({
            command,
            message: "host.runProcess unavailable",
          }),
        ),
    }),
  },
)

export const HostApprovalServiceRef = Context.Reference<ApprovalServiceApi>(
  "@gent/core/src/runtime/make-extension-host-context/HostApprovalServiceRef",
  {
    defaultValue: () => ({
      present: unavailable("ApprovalService"),
      pendingRequestId: unavailable("ApprovalService"),
      storeResolution: unavailable("ApprovalService"),
      respond: unavailable("ApprovalService"),
      rehydrate: unavailable("ApprovalService"),
    }),
  },
)

export const HostPromptPresenterRef = Context.Reference<PromptPresenterService>(
  "@gent/core/src/runtime/make-extension-host-context/HostPromptPresenterRef",
  {
    defaultValue: () => ({
      present: unavailable("PromptPresenter"),
      confirm: unavailable("PromptPresenter"),
      review: unavailable("PromptPresenter"),
    }),
  },
)

export const HostSearchStorageRef = Context.Reference<SearchStorageService>(
  "@gent/core/src/runtime/make-extension-host-context/HostSearchStorageRef",
  {
    defaultValue: () => ({
      searchMessages: () => Effect.succeed([]),
    }),
  },
)

export const HostSessionStorageRef = Context.Reference<SessionStorageService>(
  "@gent/core/src/runtime/make-extension-host-context/HostSessionStorageRef",
  {
    defaultValue: () => ({
      createSession: unavailable("SessionStorage"),
      getSession: unavailable("SessionStorage"),
      getLastSessionByCwd: unavailable("SessionStorage"),
      listSessions: unavailable("SessionStorage")(),
      updateSession: unavailable("SessionStorage"),
      deleteSession: unavailable("SessionStorage"),
    }),
  },
)

export const HostBranchStorageRef = Context.Reference<BranchStorageService>(
  "@gent/core/src/runtime/make-extension-host-context/HostBranchStorageRef",
  {
    defaultValue: () => ({
      createBranch: unavailable("BranchStorage"),
      getBranch: unavailable("BranchStorage"),
      listBranches: unavailable("BranchStorage"),
      deleteBranch: unavailable("BranchStorage"),
      updateBranchSummary: unavailable("BranchStorage"),
      countMessages: unavailable("BranchStorage"),
      countMessagesByBranches: unavailable("BranchStorage"),
    }),
  },
)

export const HostMessageStorageRef = Context.Reference<MessageStorageService>(
  "@gent/core/src/runtime/make-extension-host-context/HostMessageStorageRef",
  {
    defaultValue: () => ({
      createMessage: unavailable("MessageStorage"),
      createMessageIfAbsent: unavailable("MessageStorage"),
      getMessage: unavailable("MessageStorage"),
      listMessages: unavailable("MessageStorage"),
      deleteMessages: unavailable("MessageStorage"),
      updateMessageTurnDuration: unavailable("MessageStorage"),
    }),
  },
)

export const HostRelationshipStorageRef = Context.Reference<RelationshipStorageService>(
  "@gent/core/src/runtime/make-extension-host-context/HostRelationshipStorageRef",
  {
    defaultValue: () => ({
      getChildSessions: unavailable("RelationshipStorage"),
      getSessionAncestors: unavailable("RelationshipStorage"),
      getSessionDetail: unavailable("RelationshipStorage"),
    }),
  },
)

export const HostAgentRunnerRef = Context.Reference<AgentRunner>(
  "@gent/core/src/runtime/make-extension-host-context/HostAgentRunnerRef",
  {
    defaultValue: () => ({
      run: unavailable("AgentRunnerService"),
    }),
  },
)
export const HostSessionControlRef = Context.Reference<ExtensionSessionControlService>(
  "@gent/core/src/runtime/make-extension-host-context/HostSessionControlRef",
  {
    defaultValue: () => ({
      queueFollowUp: unavailable("SessionControl"),
    }),
  },
)

export const HostSessionMutationsRef = Context.Reference<SessionMutationsService>(
  "@gent/core/src/runtime/make-extension-host-context/HostSessionMutationsRef",
  {
    defaultValue: () => ({
      renameSession: unavailable("SessionMutations"),
      createSessionBranch: unavailable("SessionMutations"),
      forkSessionBranch: unavailable("SessionMutations"),
      switchActiveBranch: unavailable("SessionMutations"),
      createChildSession: unavailable("SessionMutations"),
      deleteSession: unavailable("SessionMutations"),
      deleteBranch: unavailable("SessionMutations"),
      deleteMessages: unavailable("SessionMutations"),
      updateReasoningLevel: unavailable("SessionMutations"),
    }),
  },
)

const loadAmbientHostContextDefaults: Effect.Effect<AmbientHostContextDefaults> = Effect.all({
  platform: Effect.service(HostPlatformRef),
  host: Effect.service(HostExtensionPlatformRef),
  approvalService: Effect.service(HostApprovalServiceRef),
  promptPresenter: Effect.service(HostPromptPresenterRef),
  sessionStorage: Effect.service(HostSessionStorageRef),
  branchStorage: Effect.service(HostBranchStorageRef),
  messageStorage: Effect.service(HostMessageStorageRef),
  relationshipStorage: Effect.service(HostRelationshipStorageRef),
  searchStorage: Effect.service(HostSearchStorageRef),
  agentRunner: Effect.service(HostAgentRunnerRef),
  sessionMutations: Effect.service(HostSessionMutationsRef),
  sessionControl: Effect.service(HostSessionControlRef),
})
type AmbientHostContextOverrides = Partial<AmbientHostContextDefaults>

const availableAmbientHostContextOverrides: Effect.Effect<AmbientHostContextOverrides> = Effect.gen(
  function* () {
    const available = yield* Effect.all({
      platform: Effect.serviceOption(RuntimeEnvironment),
      host: Effect.serviceOption(HostExtensionPlatformRef),
      approvalService: Effect.serviceOption(ApprovalService),
      promptPresenter: Effect.serviceOption(PromptPresenter),
      sessionStorage: Effect.serviceOption(SessionStorage),
      branchStorage: Effect.serviceOption(BranchStorage),
      messageStorage: Effect.serviceOption(MessageStorage),
      relationshipStorage: Effect.serviceOption(RelationshipStorage),
      searchStorage: Effect.serviceOption(SearchStorage),
      agentRunner: Effect.serviceOption(AgentRunnerService),
      sessionMutations: Effect.serviceOption(SessionMutations),
    })

    const overrides: AmbientHostContextOverrides = {}
    if (available.platform._tag === "Some") {
      Object.assign(overrides, { platform: available.platform.value })
    }
    if (available.host._tag === "Some") {
      Object.assign(overrides, { host: available.host.value })
    }
    if (available.approvalService._tag === "Some") {
      Object.assign(overrides, { approvalService: available.approvalService.value })
    }
    if (available.promptPresenter._tag === "Some") {
      Object.assign(overrides, { promptPresenter: available.promptPresenter.value })
    }
    if (available.sessionStorage._tag === "Some") {
      Object.assign(overrides, { sessionStorage: available.sessionStorage.value })
    }
    if (available.branchStorage._tag === "Some") {
      Object.assign(overrides, { branchStorage: available.branchStorage.value })
    }
    if (available.messageStorage._tag === "Some") {
      Object.assign(overrides, { messageStorage: available.messageStorage.value })
    }
    if (available.relationshipStorage._tag === "Some") {
      Object.assign(overrides, { relationshipStorage: available.relationshipStorage.value })
    }
    if (available.searchStorage._tag === "Some") {
      Object.assign(overrides, { searchStorage: available.searchStorage.value })
    }
    if (available.agentRunner._tag === "Some") {
      Object.assign(overrides, { agentRunner: available.agentRunner.value })
    }
    if (available.sessionMutations._tag === "Some") {
      Object.assign(overrides, { sessionMutations: available.sessionMutations.value })
    }
    return overrides
  },
)

const provideAmbientHostContextOverrides =
  (overrides: AmbientHostContextOverrides) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    let next = effect
    if (!Predicate.isUndefined(overrides.platform)) {
      next = next.pipe(Effect.provideService(HostPlatformRef, overrides.platform))
    }
    if (!Predicate.isUndefined(overrides.host)) {
      next = next.pipe(Effect.provideService(HostExtensionPlatformRef, overrides.host))
    }
    if (!Predicate.isUndefined(overrides.approvalService)) {
      next = next.pipe(Effect.provideService(HostApprovalServiceRef, overrides.approvalService))
    }
    if (!Predicate.isUndefined(overrides.promptPresenter)) {
      next = next.pipe(Effect.provideService(HostPromptPresenterRef, overrides.promptPresenter))
    }
    if (!Predicate.isUndefined(overrides.sessionStorage)) {
      next = next.pipe(Effect.provideService(HostSessionStorageRef, overrides.sessionStorage))
    }
    if (!Predicate.isUndefined(overrides.branchStorage)) {
      next = next.pipe(Effect.provideService(HostBranchStorageRef, overrides.branchStorage))
    }
    if (!Predicate.isUndefined(overrides.messageStorage)) {
      next = next.pipe(Effect.provideService(HostMessageStorageRef, overrides.messageStorage))
    }
    if (!Predicate.isUndefined(overrides.relationshipStorage)) {
      next = next.pipe(
        Effect.provideService(HostRelationshipStorageRef, overrides.relationshipStorage),
      )
    }
    if (!Predicate.isUndefined(overrides.searchStorage)) {
      next = next.pipe(Effect.provideService(HostSearchStorageRef, overrides.searchStorage))
    }
    if (!Predicate.isUndefined(overrides.agentRunner)) {
      next = next.pipe(Effect.provideService(HostAgentRunnerRef, overrides.agentRunner))
    }
    if (!Predicate.isUndefined(overrides.sessionMutations)) {
      next = next.pipe(Effect.provideService(HostSessionMutationsRef, overrides.sessionMutations))
    }
    if (!Predicate.isUndefined(overrides.sessionControl)) {
      next = next.pipe(Effect.provideService(HostSessionControlRef, overrides.sessionControl))
    }
    return next
  }

export interface MakeAmbientExtensionHostContextDepsInput {
  readonly extensionRegistry: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
  readonly overrides?: Partial<AmbientHostContextDefaults>
}

const makeAmbientExtensionHostContextDeps = (
  input: MakeAmbientExtensionHostContextDepsInput,
): Effect.Effect<MakeExtensionHostContextDeps> =>
  Effect.gen(function* () {
    const defaults = yield* loadAmbientHostContextDefaults.pipe(
      provideAmbientHostContextOverrides({
        ...(yield* availableAmbientHostContextOverrides),
        ...input.overrides,
      }),
    )
    return {
      platform: defaults.platform,
      host: defaults.host,
      approvalService: defaults.approvalService,
      promptPresenter: defaults.promptPresenter,
      extensionRegistry: input.extensionRegistry,
      capabilityContext: input.capabilityContext,
      sessionStorage: defaults.sessionStorage,
      branchStorage: defaults.branchStorage,
      messageStorage: defaults.messageStorage,
      relationshipStorage: defaults.relationshipStorage,
      searchStorage: defaults.searchStorage,
      agentRunner: defaults.agentRunner,
      sessionMutations: defaults.sessionMutations,
      sessionControl: defaults.sessionControl,
    }
  })

export const makeExtensionHostContextProvider = (
  deps: MakeExtensionHostContextDeps,
): ExtensionHostContextProviderService => ({
  defaultExtensionRegistry: deps.extensionRegistry,
  defaultCapabilityContext: deps.capabilityContext,
  forRun: (runInfo, overrides) => {
    const nextDeps: MakeExtensionHostContextDeps = { ...deps }
    if (!Predicate.isUndefined(overrides?.extensionRegistry)) {
      Object.assign(nextDeps, { extensionRegistry: overrides.extensionRegistry })
    }
    if (!Predicate.isUndefined(overrides?.capabilityContext)) {
      Object.assign(nextDeps, { capabilityContext: overrides.capabilityContext })
    }
    return makeExtensionHostContext(runInfo, nextDeps)
  },
})

export const makeAmbientExtensionHostContextProvider = (
  input: MakeAmbientExtensionHostContextDepsInput,
): Effect.Effect<ExtensionHostContextProviderService> =>
  makeAmbientExtensionHostContextDeps(input).pipe(Effect.map(makeExtensionHostContextProvider))

const makeExtensionHostContext = (
  runInfo: MakeExtensionHostContextRunInfo,
  deps: MakeExtensionHostContextDeps,
): ExtensionHostContext => {
  const hostCtx: ExtensionHostContext = {
    sessionId: runInfo.sessionId,
    branchId: runInfo.branchId,
    agentName: runInfo.agentName,
    cwd: runInfo.sessionCwd ?? deps.platform.cwd,
    home: deps.platform.home,
    host: deps.host,

    agent: {
      listAgents: () => Effect.succeed([...deps.extensionRegistry.getResolved().agents.values()]),
      run: (params) =>
        deps.agentRunner.run({
          agent: params.agent,
          prompt: params.prompt,
          parentSessionId: runInfo.sessionId,
          parentBranchId: runInfo.branchId,
          cwd: params.cwd ?? runInfo.sessionCwd ?? deps.platform.cwd,
          runSpec: params.runSpec,
        }),
    },

    session: {
      listMessages: (branchId) =>
        deps.messageStorage
          .listMessages(branchId ?? runInfo.branchId)
          .pipe(Effect.mapError(toHostError("session.listMessages"))),
      getSession: (sessionId) =>
        deps.sessionStorage
          .getSession(sessionId ?? runInfo.sessionId)
          .pipe(Effect.mapError(toHostError("session.getSession"))),
      getDetail: (sessionId) =>
        deps.relationshipStorage
          .getSessionDetail(sessionId)
          .pipe(Effect.mapError(toHostError("session.getDetail"))),
      renameCurrent: (name) =>
        deps.sessionMutations
          .renameSession({ sessionId: runInfo.sessionId, name })
          .pipe(Effect.mapError(toHostError("session.renameCurrent"))),
      search: (query, options) =>
        deps.searchStorage.searchMessages(query, options).pipe(
          Effect.map((results) =>
            results.map((result) =>
              ExtensionHostSearchResult.make({
                sessionId: SessionId.make(result.sessionId),
                sessionName: result.sessionName,
                branchId: BranchId.make(result.branchId),
                snippet: result.snippet,
                createdAt: result.createdAt,
              }),
            ),
          ),
          Effect.mapError(toHostError("session.search")),
        ),

      queueFollowUp: (params) =>
        deps.sessionControl
          .queueFollowUp({
            sourceId: params.sourceId,
            sessionId: runInfo.sessionId,
            branchId: params.branchId ?? runInfo.branchId,
            content: params.content,
            metadata: params.metadata,
          })
          .pipe(Effect.mapError(toHostError("session.queueFollowUp"))),

      listBranches: () =>
        deps.branchStorage
          .listBranches(runInfo.sessionId)
          .pipe(Effect.mapError(toHostError("session.listBranches"))),
    },

    interaction: {
      approve: (params) =>
        deps.approvalService.present(params, {
          sessionId: runInfo.sessionId,
          branchId: runInfo.branchId,
        }),
      present: (params) =>
        deps.promptPresenter.present({
          sessionId: runInfo.sessionId,
          branchId: runInfo.branchId,
          ...params,
        }),
      confirm: (params) =>
        deps.promptPresenter.confirm({
          sessionId: runInfo.sessionId,
          branchId: runInfo.branchId,
          ...params,
        }),
      review: (params) =>
        deps.promptPresenter.review({
          sessionId: runInfo.sessionId,
          branchId: runInfo.branchId,
          ...params,
        }),
    },
  }
  return hostCtx
}
