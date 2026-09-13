/**
 * Factory for ExtensionHostContext — the unified capability-shaped boundary
 * that extension code (tools, interceptors) uses to access host services.
 *
 * Single wiring point: ToolRunner and agent-loop both call this.
 */

import { Predicate, Context, Effect, Option, Schema } from "effect"
import { ActorStateRegistry, listStateEntityIds } from "effect-encore"
import {
  ExtensionHostSearchResult,
  type ExtensionServiceError,
  extensionServiceError,
  type ExtensionHostContext,
} from "../domain/extension-services.js"
import { InteractionPendingError } from "../domain/interaction-request.js"
import { AgentRunnerService, type AgentRunner, type AgentName } from "../domain/agent.js"
import { BranchId, SessionId } from "../domain/ids.js"
import { RuntimeEnvironment, type RuntimeEnvironmentApi } from "./runtime-environment.js"
import { ExtensionHostProcessError, type ExtensionHostPlatform } from "../domain/extension.js"
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
import { AgentLoop as AgentLoopActor } from "./agent/agent-loop.protocol.js"
import { listWorkspaceLoops } from "./agent/agent-loop.entity-id.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

interface ExtensionSessionControlService {
  readonly queueFollowUp: (input: {
    readonly sourceId: string
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly content: string
    readonly metadata?: MessageMetadata
    readonly wake?: boolean
  }) => Effect.Effect<void, Error>
  readonly dequeueFollowUp: (input: {
    readonly sourceId: string
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<boolean, Error>
}

/**
 * Live loop enumeration for the host context. Separate from `sessionControl`
 * because the agent-loop behavior provides that one and cannot see
 * `SessionRuntime` without a cycle; this is supplied at server wiring instead.
 */
/** Decoding entity ids is cheap; bound it so a large registry does not stall a host-context build. */
const ACTIVE_LOOP_DECODE_CONCURRENCY = 8

interface ExtensionActiveLoopsService {
  readonly list: Effect.Effect<
    ReadonlyArray<{ readonly sessionId: SessionId; readonly branchId: BranchId }>,
    Error
  >
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
  readonly activeLoops: ExtensionActiveLoopsService
}

interface MakeExtensionHostContextRunInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  /** Session-scoped cwd. Falls back to RuntimeEnvironment.cwd when absent. */
  readonly sessionCwd?: string
}

interface ExtensionHostContextOverrides {
  readonly extensionRegistry?: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
}

interface ExtensionHostContextProviderService {
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
  | "activeLoops"
>

const unavailable = (service: string) => () => Effect.die(`${service} not available`)

const sessionError = (operation: string) => extensionServiceError("ExtensionSession", operation)

/** A pending interaction is the caller's to handle; anything else is a service failure. */
const mapInteraction = <A, E>(
  operation: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, ExtensionServiceError | InteractionPendingError> =>
  effect.pipe(
    Effect.mapError((cause) => {
      if (Schema.is(InteractionPendingError)(cause)) return cause
      return extensionServiceError("ExtensionInteraction", operation)(cause)
    }),
  )

const unavailablePlatform: RuntimeEnvironmentApi = { cwd: "", home: "", platform: "unknown" }

const unavailableExtensionPlatform: ExtensionHostPlatform = {
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
}

/**
 * The one host facet that is injected rather than yielded.
 *
 * `makeExtensionHostPlatform` is an Effect over `GentPlatform`, not a service
 * Tag, so a caller that has already built one hands it in here. Every other
 * facet resolves from its own Tag.
 */
const HostExtensionPlatformRef = Context.Reference<ExtensionHostPlatform>(
  "@gent/core/src/runtime/make-extension-host-context/HostExtensionPlatformRef",
  { defaultValue: () => unavailableExtensionPlatform },
)

const unavailableApprovalService: ApprovalServiceApi = {
  present: unavailable("ApprovalService"),
  pendingRequestId: unavailable("ApprovalService"),
  storeResolution: unavailable("ApprovalService"),
  respond: unavailable("ApprovalService"),
  rehydrate: unavailable("ApprovalService"),
}

const unavailablePromptPresenter: PromptPresenterService = {
  present: unavailable("PromptPresenter"),
  confirm: unavailable("PromptPresenter"),
  review: unavailable("PromptPresenter"),
}

const unavailableSearchStorage: SearchStorageService = {
  searchMessages: () => Effect.succeed([]),
}

const unavailableSessionStorage: SessionStorageService = {
  createSession: unavailable("SessionStorage"),
  getSession: unavailable("SessionStorage"),
  getLastSessionByCwd: unavailable("SessionStorage"),
  listSessions: unavailable("SessionStorage")(),
  updateSession: unavailable("SessionStorage"),
  deleteSession: unavailable("SessionStorage"),
}

const unavailableBranchStorage: BranchStorageService = {
  createBranch: unavailable("BranchStorage"),
  getBranch: unavailable("BranchStorage"),
  listBranches: unavailable("BranchStorage"),
  deleteBranch: unavailable("BranchStorage"),
  updateBranchSummary: unavailable("BranchStorage"),
  countMessages: unavailable("BranchStorage"),
  countMessagesByBranches: unavailable("BranchStorage"),
}

const unavailableMessageStorage: MessageStorageService = {
  createMessage: unavailable("MessageStorage"),
  createMessageIfAbsent: unavailable("MessageStorage"),
  getMessage: unavailable("MessageStorage"),
  listMessages: unavailable("MessageStorage"),
  deleteMessages: unavailable("MessageStorage"),
  updateMessageTurnDuration: unavailable("MessageStorage"),
}

const unavailableRelationshipStorage: RelationshipStorageService = {
  getChildSessions: unavailable("RelationshipStorage"),
  getSessionAncestors: unavailable("RelationshipStorage"),
  getSessionDetail: unavailable("RelationshipStorage"),
}

const unavailableAgentRunner: AgentRunner = {
  start: unavailable("AgentRunnerService"),
  inspect: unavailable("AgentRunnerService"),
  list: unavailable("AgentRunnerService"),
  cancel: unavailable("AgentRunnerService"),
  run: unavailable("AgentRunnerService"),
}
const unavailableSessionControl: ExtensionSessionControlService = {
  queueFollowUp: unavailable("SessionControl"),
  dequeueFollowUp: unavailable("SessionControl"),
}

const unavailableActiveLoops: ExtensionActiveLoopsService = { list: unavailable("ActiveLoops")() }

const unavailableSessionMutations: SessionMutationsService = {
  renameSession: unavailable("SessionMutations"),
  createSessionBranch: unavailable("SessionMutations"),
  forkSessionBranch: unavailable("SessionMutations"),
  switchActiveBranch: unavailable("SessionMutations"),
  deleteSession: unavailable("SessionMutations"),
  updateReasoningLevel: unavailable("SessionMutations"),
}

/** The real service if the ambient context carries one, else the `unavailable` stub. */
const facet = <I, S>(tag: Context.Key<I, S>, absent: S): Effect.Effect<S> =>
  Effect.serviceOption(tag).pipe(Effect.map(Option.getOrElse(() => absent)))

/**
 * Enumerating a workspace's loops needs only the actor state registry, and the
 * registry exists only where an actor layer is in scope. Where it is absent the
 * facet stays `unavailable` rather than failing the whole host context.
 *
 * The registry rather than the actor's own `State` client: depending on the
 * built actor from here would invert the layer graph the loop is built from.
 */
const activeLoopsFacet: Effect.Effect<ExtensionActiveLoopsService> = Effect.serviceOption(
  ActorStateRegistry,
).pipe(
  Effect.map(
    Option.match({
      onNone: () => unavailableActiveLoops,
      onSome: (registry) => ({
        list: Effect.gen(function* () {
          const workspaceId = yield* CurrentWorkspaceId
          const entityIds = yield* listStateEntityIds(AgentLoopActor.name).pipe(
            Effect.provideService(ActorStateRegistry, registry),
          )
          return yield* listWorkspaceLoops({
            workspaceId,
            entityIds,
            concurrency: ACTIVE_LOOP_DECODE_CONCURRENCY,
          })
        }),
      }),
    }),
  ),
)

const resolveAmbientHostContextDefaults: Effect.Effect<AmbientHostContextDefaults> = Effect.all({
  platform: facet(RuntimeEnvironment, unavailablePlatform),
  host: Effect.service(HostExtensionPlatformRef),
  approvalService: facet(ApprovalService, unavailableApprovalService),
  promptPresenter: facet(PromptPresenter, unavailablePromptPresenter),
  sessionStorage: facet(SessionStorage, unavailableSessionStorage),
  branchStorage: facet(BranchStorage, unavailableBranchStorage),
  messageStorage: facet(MessageStorage, unavailableMessageStorage),
  relationshipStorage: facet(RelationshipStorage, unavailableRelationshipStorage),
  searchStorage: facet(SearchStorage, unavailableSearchStorage),
  agentRunner: facet(AgentRunnerService, unavailableAgentRunner),
  sessionMutations: facet(SessionMutations, unavailableSessionMutations),
  sessionControl: Effect.succeed(unavailableSessionControl),
  activeLoops: activeLoopsFacet,
})

interface MakeAmbientExtensionHostContextDepsInput {
  readonly extensionRegistry: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
  readonly overrides?: Partial<AmbientHostContextDefaults>
}

const makeAmbientExtensionHostContextDeps = (
  input: MakeAmbientExtensionHostContextDepsInput,
): Effect.Effect<MakeExtensionHostContextDeps> =>
  Effect.gen(function* () {
    const resolved = yield* resolveAmbientHostContextDefaults
    // A caller that already holds a facet wins over what the ambient context
    // resolves: this is how a test substitutes one storage without building a
    // whole layer graph around it.
    const defaults: AmbientHostContextDefaults = { ...resolved, ...input.overrides }
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
      activeLoops: defaults.activeLoops,
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

    Agent: {
      listAgents: Effect.succeed([...deps.extensionRegistry.getResolved().agents.values()]),
      start: (params) =>
        deps.agentRunner.start({
          ...params,
          parentSessionId: runInfo.sessionId,
          parentBranchId: runInfo.branchId,
          cwd: params.cwd ?? runInfo.sessionCwd ?? deps.platform.cwd,
        }),
      inspect: (params) =>
        deps.agentRunner.inspect({
          requestId: params.requestId,
          parentSessionId: runInfo.sessionId,
          parentBranchId: runInfo.branchId,
        }),
      list: () =>
        deps.agentRunner.list({
          parentSessionId: runInfo.sessionId,
          parentBranchId: runInfo.branchId,
        }),
      cancel: (params) =>
        deps.agentRunner.cancel({
          requestId: params.requestId,
          parentSessionId: runInfo.sessionId,
          parentBranchId: runInfo.branchId,
        }),
      run: (params) =>
        deps.agentRunner
          .run({
            agent: params.agent,
            prompt: params.prompt,
            parentSessionId: runInfo.sessionId,
            parentBranchId: runInfo.branchId,
            cwd: params.cwd ?? runInfo.sessionCwd ?? deps.platform.cwd,
            runSpec: params.runSpec,
            observe: params.observe,
          })
          .pipe(Effect.mapError(extensionServiceError("ExtensionAgent", "run"))),
    },

    Session: {
      listMessages: (branchId) =>
        deps.messageStorage
          .listMessages(branchId ?? runInfo.branchId)
          .pipe(Effect.mapError(sessionError("listMessages"))),
      getSession: (sessionId) =>
        deps.sessionStorage
          .getSession(sessionId ?? runInfo.sessionId)
          .pipe(Effect.mapError(sessionError("getSession"))),
      getDetail: (sessionId) =>
        deps.relationshipStorage
          .getSessionDetail(sessionId)
          .pipe(Effect.mapError(sessionError("getDetail"))),
      renameCurrent: (name) =>
        deps.sessionMutations
          .renameSession({ sessionId: runInfo.sessionId, name })
          .pipe(Effect.mapError(sessionError("renameCurrent"))),
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
          Effect.mapError(sessionError("search")),
        ),
      queueFollowUp: (params) =>
        deps.sessionControl
          .queueFollowUp({
            sourceId: params.sourceId,
            sessionId: runInfo.sessionId,
            branchId: params.branchId ?? runInfo.branchId,
            content: params.content,
            metadata: params.metadata,
            wake: params.wake,
          })
          .pipe(Effect.mapError(sessionError("queueFollowUp"))),
      dequeueFollowUp: (params) =>
        deps.sessionControl
          .dequeueFollowUp({
            sourceId: params.sourceId,
            sessionId: runInfo.sessionId,
            branchId: params.branchId ?? runInfo.branchId,
          })
          .pipe(Effect.mapError(sessionError("dequeueFollowUp"))),
      listBranches: deps.branchStorage
        .listBranches(runInfo.sessionId)
        .pipe(Effect.mapError(sessionError("listBranches"))),
      listSessions: deps.sessionStorage.listSessions.pipe(
        Effect.mapError(sessionError("listSessions")),
      ),
      listActiveLoops: deps.activeLoops.list.pipe(Effect.mapError(sessionError("listActiveLoops"))),
    },

    Interaction: {
      approve: (params) =>
        mapInteraction(
          "approve",
          deps.approvalService.present(params, {
            sessionId: runInfo.sessionId,
            branchId: runInfo.branchId,
          }),
        ),
      present: (params) =>
        mapInteraction(
          "present",
          deps.promptPresenter.present({
            sessionId: runInfo.sessionId,
            branchId: runInfo.branchId,
            ...params,
          }),
        ),
      confirm: (params) =>
        mapInteraction(
          "confirm",
          deps.promptPresenter.confirm({
            sessionId: runInfo.sessionId,
            branchId: runInfo.branchId,
            ...params,
          }),
        ),
      review: (params) =>
        mapInteraction(
          "review",
          deps.promptPresenter.review({
            sessionId: runInfo.sessionId,
            branchId: runInfo.branchId,
            ...params,
          }),
        ),
    },
  }
  return hostCtx
}
