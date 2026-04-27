/**
 * Factory for ExtensionHostContext — the unified capability-shaped boundary
 * that extension code (tools, interceptors) uses to access host services.
 *
 * Single wiring point: ToolRunner and agent-loop both call this.
 */

import { Context, Effect, Stream } from "effect"
import type {
  CapabilityError,
  CapabilityNotFoundError,
  CapabilityRef,
} from "../domain/capability.js"
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
import type { ActorEngineService } from "./extensions/actor-engine.js"
import type { ReceptionistService } from "./extensions/receptionist.js"
import type { MachineEngineService } from "./extensions/resource-host/machine-engine.js"
import {
  ExtensionTurnControl,
  type ExtensionTurnControlService,
} from "./extensions/turn-control.js"
import { RuntimePlatform, type RuntimePlatformShape } from "./runtime-platform.js"
import { ApprovalService, type ApprovalServiceShape } from "./approval-service.js"
import { PromptPresenter, type PromptPresenterService } from "../domain/prompt-presenter.js"
import type { ExtensionRegistryService } from "./extensions/registry.js"
import type { StorageService } from "../storage/sqlite-storage.js"
import { SearchStorage, type SearchStorageService } from "../storage/search-storage.js"
import type { Message } from "../domain/message.js"
import { SessionMutations, type SessionMutationsService } from "../domain/session-mutations.js"
import { estimateContextPercent } from "./context-estimation.js"

export interface MakeExtensionHostContextDeps {
  readonly platform: RuntimePlatformShape
  readonly extensionStateRuntime: MachineEngineService
  readonly approvalService: ApprovalServiceShape
  readonly promptPresenter: PromptPresenterService
  readonly extensionRegistry: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
  readonly storage: StorageService
  readonly searchStorage: SearchStorageService
  readonly agentRunner: AgentRunner
  readonly sessionMutations: SessionMutationsService
  /**
   * Actor primitive surface. Threaded into the `actors` facet so non-
   * actor callers (slot handlers, capability handlers) can resolve
   * `ServiceKey`s into `ActorRef`s and tell/ask through the engine.
   */
  readonly actorEngine: ActorEngineService
  readonly receptionist: ReceptionistService
  /**
   * Turn-control surface. Threaded into the `session.queueFollowUp`
   * facet so slot handlers (and any non-FSM caller) can enqueue
   * follow-ups without going through the legacy FSM
   * `afterTransition` runEffects pipeline.
   */
  readonly turnControl: ExtensionTurnControlService
}

export interface MakeExtensionHostContextRunInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  /** Session-scoped cwd. Falls back to RuntimePlatform.cwd when absent. */
  readonly sessionCwd?: string
}

type AmbientHostContextDefaults = Pick<
  MakeExtensionHostContextDeps,
  | "platform"
  | "approvalService"
  | "promptPresenter"
  | "searchStorage"
  | "agentRunner"
  | "sessionMutations"
  | "turnControl"
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

export const HostPlatformRef = Context.Reference<RuntimePlatformShape>(
  "@gent/core/src/runtime/make-extension-host-context/HostPlatformRef",
  {
    defaultValue: () => ({ cwd: "", home: "", platform: "unknown" }),
  },
)

export const HostApprovalServiceRef = Context.Reference<ApprovalServiceShape>(
  "@gent/core/src/runtime/make-extension-host-context/HostApprovalServiceRef",
  {
    defaultValue: () => ({
      present: unavailable("ApprovalService"),
      storeResolution: () => {},
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

export const HostAgentRunnerRef = Context.Reference<AgentRunner>(
  "@gent/core/src/runtime/make-extension-host-context/HostAgentRunnerRef",
  {
    defaultValue: () => ({
      run: unavailable("AgentRunnerService"),
    }),
  },
)
export const HostTurnControlRef = Context.Reference<ExtensionTurnControlService>(
  "@gent/core/src/runtime/make-extension-host-context/HostTurnControlRef",
  {
    defaultValue: () => ({
      queueFollowUp: unavailable("ExtensionTurnControl"),
      interject: unavailable("ExtensionTurnControl"),
      commands: Stream.empty,
      withOwner: (_owner, effect) => effect,
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
  approvalService: Effect.service(HostApprovalServiceRef),
  promptPresenter: Effect.service(HostPromptPresenterRef),
  searchStorage: Effect.service(HostSearchStorageRef),
  agentRunner: Effect.service(HostAgentRunnerRef),
  sessionMutations: Effect.service(HostSessionMutationsRef),
  turnControl: Effect.service(HostTurnControlRef),
})
type AmbientHostContextOverrides = Partial<AmbientHostContextDefaults>

const availableAmbientHostContextOverrides: Effect.Effect<AmbientHostContextOverrides> = Effect.gen(
  function* () {
    const available = yield* Effect.all({
      platform: Effect.serviceOption(RuntimePlatform),
      approvalService: Effect.serviceOption(ApprovalService),
      promptPresenter: Effect.serviceOption(PromptPresenter),
      searchStorage: Effect.serviceOption(SearchStorage),
      agentRunner: Effect.serviceOption(AgentRunnerService),
      sessionMutations: Effect.serviceOption(SessionMutations),
      turnControl: Effect.serviceOption(ExtensionTurnControl),
    })

    return {
      ...(available.platform._tag === "Some" ? { platform: available.platform.value } : {}),
      ...(available.approvalService._tag === "Some"
        ? { approvalService: available.approvalService.value }
        : {}),
      ...(available.promptPresenter._tag === "Some"
        ? { promptPresenter: available.promptPresenter.value }
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
      ...(available.turnControl._tag === "Some"
        ? { turnControl: available.turnControl.value }
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
  if (overrides.approvalService !== undefined) {
    next = next.pipe(Effect.provideService(HostApprovalServiceRef, overrides.approvalService))
  }
  if (overrides.promptPresenter !== undefined) {
    next = next.pipe(Effect.provideService(HostPromptPresenterRef, overrides.promptPresenter))
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
  if (overrides.turnControl !== undefined) {
    next = next.pipe(Effect.provideService(HostTurnControlRef, overrides.turnControl))
  }
  return next
}

export interface MakeAmbientExtensionHostContextDepsInput {
  readonly extensionStateRuntime: MachineEngineService
  readonly extensionRegistry: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
  readonly storage: StorageService
  readonly actorEngine: ActorEngineService
  readonly receptionist: ReceptionistService
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
      extensionStateRuntime: input.extensionStateRuntime,
      approvalService: defaults.approvalService,
      promptPresenter: defaults.promptPresenter,
      extensionRegistry: input.extensionRegistry,
      ...(input.capabilityContext !== undefined
        ? { capabilityContext: input.capabilityContext }
        : {}),
      storage: input.storage,
      searchStorage: defaults.searchStorage,
      agentRunner: defaults.agentRunner,
      sessionMutations: defaults.sessionMutations,
      actorEngine: input.actorEngine,
      receptionist: input.receptionist,
      turnControl: defaults.turnControl,
    }
  })

export const makeExtensionHostContext = (
  runInfo: MakeExtensionHostContextRunInfo,
  deps: MakeExtensionHostContextDeps,
): ExtensionHostContext => ({
  sessionId: runInfo.sessionId,
  branchId: runInfo.branchId,
  agentName: runInfo.agentName,
  cwd: runInfo.sessionCwd ?? deps.platform.cwd,
  home: deps.platform.home,

  extension: {
    send: (message, branchId) =>
      deps.extensionStateRuntime.send(runInfo.sessionId, message, branchId ?? runInfo.branchId),
    ask: (message, branchId) =>
      deps.extensionStateRuntime.execute(runInfo.sessionId, message, branchId ?? runInfo.branchId),
    request: <I, O>(ref: CapabilityRef<I, O>, input: I) => {
      const capabilities = deps.extensionRegistry.getResolved().capabilities
      const ctx = {
        sessionId: runInfo.sessionId,
        branchId: runInfo.branchId,
        cwd: runInfo.sessionCwd ?? deps.platform.cwd,
        home: deps.platform.home,
      }
      const e = capabilities.run(ref.extensionId, ref.capabilityId, "agent-protocol", input, ctx, {
        intent: ref.intent,
      })
      const provided =
        deps.capabilityContext !== undefined
          ? e.pipe(Effect.provideContext(deps.capabilityContext))
          : e
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
      return provided as Effect.Effect<O, CapabilityError | CapabilityNotFoundError>
    },
  },

  actors: {
    find: (key) => deps.receptionist.find(key),
    tell: (ref, msg) => deps.actorEngine.tell(ref, msg),
    ask: (ref, msg, replyKey) => deps.actorEngine.ask(ref, msg, replyKey),
  },

  agent: {
    get: (name) => deps.extensionRegistry.getAgent(name),
    require: (name) =>
      deps.extensionRegistry
        .getAgent(name)
        .pipe(
          Effect.flatMap((agent) =>
            agent !== undefined
              ? Effect.succeed(agent)
              : Effect.die(`Agent "${name}" not found in registry`),
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
    resolveDualModelPair: () => deps.extensionRegistry.resolveDualModelPair(),
  },

  session: {
    listMessages: (branchId) =>
      deps.storage
        .listMessages(branchId ?? runInfo.branchId)
        .pipe(Effect.mapError(toHostError("session.listMessages"))),
    getSession: (sessionId) =>
      deps.storage
        .getSession(sessionId ?? runInfo.sessionId)
        .pipe(Effect.mapError(toHostError("session.getSession"))),
    getDetail: (sessionId) =>
      deps.storage
        .getSessionDetail(sessionId)
        .pipe(Effect.mapError(toHostError("session.getDetail"))),
    renameCurrent: (name) =>
      deps.sessionMutations
        .renameSession({ sessionId: runInfo.sessionId, name })
        .pipe(Effect.mapError(toHostError("session.renameCurrent"))),
    estimateContextPercent: (options) =>
      Effect.gen(function* () {
        const messages: ReadonlyArray<Message> = yield* deps.storage.listMessages(runInfo.branchId)
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
      deps.turnControl
        .queueFollowUp({
          sessionId: runInfo.sessionId,
          branchId: params.branchId ?? runInfo.branchId,
          content: params.content,
          ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
        })
        .pipe(Effect.mapError(toHostError("session.queueFollowUp"))),

    listBranches: () =>
      deps.storage
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
      deps.storage
        .getChildSessions(runInfo.sessionId)
        .pipe(Effect.mapError(toHostError("session.getChildSessions"))),

    getSessionAncestors: (sessionId) =>
      deps.storage
        .getSessionAncestors(sessionId ?? runInfo.sessionId)
        .pipe(Effect.mapError(toHostError("session.getSessionAncestors"))),

    deleteSession: (sessionId) =>
      Effect.gen(function* () {
        if (sessionId === runInfo.sessionId) {
          return yield* Effect.die("Cannot delete the current session from within it")
        }
        yield* deps.sessionMutations.deleteSession(sessionId)
      }).pipe(Effect.mapError(toHostError("session.deleteSession"))),

    deleteBranch: (branchId) =>
      Effect.gen(function* () {
        if (branchId === runInfo.branchId) {
          return yield* Effect.die("Cannot delete the current branch")
        }
        yield* deps.sessionMutations.deleteBranch({
          sessionId: runInfo.sessionId,
          currentBranchId: runInfo.branchId,
          branchId,
        })
      }).pipe(Effect.mapError(toHostError("session.deleteBranch"))),

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
})
