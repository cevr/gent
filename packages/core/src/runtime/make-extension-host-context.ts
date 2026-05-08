/**
 * Factory for ExtensionHostContext — the unified capability-shaped boundary
 * that extension code (tools, interceptors) uses to access host services.
 *
 * Single wiring point: ToolRunner and agent-loop both call this.
 */

import { Context, Effect } from "effect"
import {
  ExtensionHostError,
  ExtensionHostSearchResult,
  type ExtensionHostContext,
} from "../domain/extension-host-context.js"
import {
  AgentRunnerService,
  DEFAULT_MODEL_ID,
  type AgentRunner,
  type AgentName,
} from "../domain/agent.js"
import { BranchId, SessionId } from "../domain/ids.js"
import { RuntimeEnvironment, type RuntimeEnvironmentShape } from "./runtime-environment.js"
import {
  ExtensionHostProcessError,
  type ExtensionHostFacts,
  type ExtensionHostPlatform,
} from "../domain/extension.js"
import { ApprovalService, type ApprovalServiceShape } from "./approval-service.js"
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
import type { Message, MessageMetadata } from "../domain/message.js"
import { SessionMutations, type SessionMutationsService } from "../domain/session-mutations.js"
import { estimateContextPercent } from "./context-estimation.js"

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
  readonly platform: RuntimeEnvironmentShape
  readonly host: ExtensionHostPlatform
  readonly approvalService: ApprovalServiceShape
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

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message
  }
  return String(error)
}

const toHostError =
  (operation: string) =>
  (error: unknown): ExtensionHostError =>
    new ExtensionHostError({
      operation,
      message: errorMessage(error),
      cause: error,
    })

const hostFailure = (operation: string, message: string): ExtensionHostError =>
  new ExtensionHostError({ operation, message })

export const extensionHostFacts = (host: ExtensionHostPlatform): ExtensionHostFacts => ({
  osInfo: host.osInfo,
  execPath: host.execPath,
  homeDirectory: host.homeDirectory,
  pathListSeparator: host.pathListSeparator,
  commandCandidates: host.commandCandidates,
  isPortFree: host.isPortFree,
  isPidAlive: host.isPidAlive,
})

export const HostPlatformRef = Context.Reference<RuntimeEnvironmentShape>(
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

export const HostApprovalServiceRef = Context.Reference<ApprovalServiceShape>(
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
      listSessions: unavailable("SessionStorage"),
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

    return {
      ...(available.platform._tag === "Some" ? { platform: available.platform.value } : {}),
      ...(available.host._tag === "Some" ? { host: available.host.value } : {}),
      ...(available.approvalService._tag === "Some"
        ? { approvalService: available.approvalService.value }
        : {}),
      ...(available.promptPresenter._tag === "Some"
        ? { promptPresenter: available.promptPresenter.value }
        : {}),
      ...(available.sessionStorage._tag === "Some"
        ? { sessionStorage: available.sessionStorage.value }
        : {}),
      ...(available.branchStorage._tag === "Some"
        ? { branchStorage: available.branchStorage.value }
        : {}),
      ...(available.messageStorage._tag === "Some"
        ? { messageStorage: available.messageStorage.value }
        : {}),
      ...(available.relationshipStorage._tag === "Some"
        ? { relationshipStorage: available.relationshipStorage.value }
        : {}),
      ...(available.searchStorage._tag === "Some"
        ? { searchStorage: available.searchStorage.value }
        : {}),
      ...(available.agentRunner._tag === "Some"
        ? { agentRunner: available.agentRunner.value }
        : {}),
      ...(available.sessionMutations._tag === "Some"
        ? { sessionMutations: available.sessionMutations.value }
        : {}),
    }
  },
)

const withAmbientHostContextOverrides = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  overrides: AmbientHostContextOverrides,
): Effect.Effect<A, E, R> => {
  let next = effect
  if (overrides.platform !== undefined) {
    next = next.pipe(Effect.provideService(HostPlatformRef, overrides.platform))
  }
  if (overrides.host !== undefined) {
    next = next.pipe(Effect.provideService(HostExtensionPlatformRef, overrides.host))
  }
  if (overrides.approvalService !== undefined) {
    next = next.pipe(Effect.provideService(HostApprovalServiceRef, overrides.approvalService))
  }
  if (overrides.promptPresenter !== undefined) {
    next = next.pipe(Effect.provideService(HostPromptPresenterRef, overrides.promptPresenter))
  }
  if (overrides.sessionStorage !== undefined) {
    next = next.pipe(Effect.provideService(HostSessionStorageRef, overrides.sessionStorage))
  }
  if (overrides.branchStorage !== undefined) {
    next = next.pipe(Effect.provideService(HostBranchStorageRef, overrides.branchStorage))
  }
  if (overrides.messageStorage !== undefined) {
    next = next.pipe(Effect.provideService(HostMessageStorageRef, overrides.messageStorage))
  }
  if (overrides.relationshipStorage !== undefined) {
    next = next.pipe(
      Effect.provideService(HostRelationshipStorageRef, overrides.relationshipStorage),
    )
  }
  if (overrides.searchStorage !== undefined) {
    next = next.pipe(Effect.provideService(HostSearchStorageRef, overrides.searchStorage))
  }
  if (overrides.agentRunner !== undefined) {
    next = next.pipe(Effect.provideService(HostAgentRunnerRef, overrides.agentRunner))
  }
  if (overrides.sessionMutations !== undefined) {
    next = next.pipe(Effect.provideService(HostSessionMutationsRef, overrides.sessionMutations))
  }
  if (overrides.sessionControl !== undefined) {
    next = next.pipe(Effect.provideService(HostSessionControlRef, overrides.sessionControl))
  }
  return next
}

export interface MakeAmbientExtensionHostContextDepsInput {
  readonly extensionRegistry: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
  readonly overrides?: Partial<AmbientHostContextDefaults>
}

export const makeAmbientExtensionHostContextDeps = (
  input: MakeAmbientExtensionHostContextDepsInput,
): Effect.Effect<MakeExtensionHostContextDeps> =>
  Effect.gen(function* () {
    const defaults = yield* withAmbientHostContextOverrides(loadAmbientHostContextDefaults, {
      ...(yield* availableAmbientHostContextOverrides),
      ...input.overrides,
    })
    return {
      platform: defaults.platform,
      host: defaults.host,
      approvalService: defaults.approvalService,
      promptPresenter: defaults.promptPresenter,
      extensionRegistry: input.extensionRegistry,
      ...(input.capabilityContext !== undefined
        ? { capabilityContext: input.capabilityContext }
        : {}),
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

export const makeExtensionHostContext = (
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
    ...(deps.capabilityContext !== undefined ? { capabilityContext: deps.capabilityContext } : {}),

    agent: {
      get: (name) => deps.extensionRegistry.getAgent(name),
      require: (name) =>
        deps.extensionRegistry
          .getAgent(name)
          .pipe(
            Effect.flatMap((agent) =>
              agent !== undefined
                ? Effect.succeed(agent)
                : Effect.fail(
                    hostFailure("agent.require", `Agent "${name}" not found in registry`),
                  ),
            ),
          ),
      run: (params) =>
        deps.agentRunner.run({
          agent: params.agent,
          prompt: params.prompt,
          parentSessionId: runInfo.sessionId,
          parentBranchId: runInfo.branchId,
          cwd: params.cwd ?? runInfo.sessionCwd ?? deps.platform.cwd,
          ...(params.runSpec !== undefined ? { runSpec: params.runSpec } : {}),
        }),
      resolveDualModelPair: () =>
        deps.extensionRegistry
          .resolveDualModelPair()
          .pipe(Effect.mapError(toHostError("agent.resolveDualModelPair"))),
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
      estimateContextPercent: (options) =>
        Effect.gen(function* () {
          const messages: ReadonlyArray<Message> = yield* deps.messageStorage.listMessages(
            runInfo.branchId,
          )
          const modelId = options?.modelId ?? DEFAULT_MODEL_ID
          return estimateContextPercent(messages, modelId)
        }).pipe(Effect.mapError(toHostError("session.estimateContextPercent"))),
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
            ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
          })
          .pipe(Effect.mapError(toHostError("session.queueFollowUp"))),

      listBranches: () =>
        deps.branchStorage
          .listBranches(runInfo.sessionId)
          .pipe(Effect.mapError(toHostError("session.listBranches"))),

      createBranch: (params) =>
        deps.sessionMutations
          .createSessionBranch({
            sessionId: runInfo.sessionId,
            parentBranchId: runInfo.branchId,
            name: params.name,
          })
          .pipe(Effect.mapError(toHostError("session.createBranch"))),

      forkBranch: (params) =>
        deps.sessionMutations
          .forkSessionBranch({
            sessionId: runInfo.sessionId,
            fromBranchId: runInfo.branchId,
            atMessageId: params.atMessageId,
            name: params.name,
          })
          .pipe(Effect.mapError(toHostError("session.forkBranch"))),

      switchBranch: (params) =>
        deps.sessionMutations
          .switchActiveBranch({
            sessionId: runInfo.sessionId,
            fromBranchId: runInfo.branchId,
            toBranchId: params.toBranchId,
          })
          .pipe(Effect.mapError(toHostError("session.switchBranch"))),

      createChildSession: (params) =>
        deps.sessionMutations
          .createChildSession({
            parentSessionId: runInfo.sessionId,
            parentBranchId: runInfo.branchId,
            name: params.name,
            cwd: params.cwd ?? runInfo.sessionCwd ?? deps.platform.cwd,
          })
          .pipe(Effect.mapError(toHostError("session.createChildSession"))),

      getChildSessions: () =>
        deps.relationshipStorage
          .getChildSessions(runInfo.sessionId)
          .pipe(Effect.mapError(toHostError("session.getChildSessions"))),

      getSessionAncestors: (sessionId) =>
        deps.relationshipStorage
          .getSessionAncestors(sessionId ?? runInfo.sessionId)
          .pipe(Effect.mapError(toHostError("session.getSessionAncestors"))),

      deleteSession: (sessionId) =>
        sessionId === runInfo.sessionId
          ? Effect.fail(
              hostFailure(
                "session.deleteSession",
                "Cannot delete the current session from within it",
              ),
            )
          : deps.sessionMutations
              .deleteSession(sessionId)
              .pipe(Effect.mapError(toHostError("session.deleteSession"))),

      deleteBranch: (branchId) =>
        branchId === runInfo.branchId
          ? Effect.fail(hostFailure("session.deleteBranch", "Cannot delete the current branch"))
          : deps.sessionMutations
              .deleteBranch({
                sessionId: runInfo.sessionId,
                currentBranchId: runInfo.branchId,
                branchId,
              })
              .pipe(Effect.mapError(toHostError("session.deleteBranch"))),

      deleteMessages: (params) =>
        deps.sessionMutations
          .deleteMessages({
            sessionId: runInfo.sessionId,
            branchId: runInfo.branchId,
            afterMessageId: params.afterMessageId,
          })
          .pipe(Effect.mapError(toHostError("session.deleteMessages"))),
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
