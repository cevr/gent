import { Context, Effect, Schema, type PlatformError } from "effect"
import type { AgentDefinition, AgentName, AgentRunError, AgentRunResult, RunSpec } from "./agent.js"
import type { EventStoreError } from "./event.js"
import type {
  ExtensionHostRunProcessOptions,
  ExtensionHostProcessResult,
  ExtensionHostSignal,
  ExtensionTurnContext,
} from "./extension.js"
import type { ApprovalDecision, ApprovalRequest } from "./interaction-request.js"
import { InteractionPendingError } from "./interaction-request.js"
import type { BranchId, MessageId, SessionId, ToolCallId } from "./ids.js"
import type { Branch, Message, MessageMetadata, Session } from "./message.js"
import type { ModelId } from "./model.js"
import type { ExtensionHostContext, ExtensionHostSearchResult } from "./extension-host-context.js"

export class ExtensionServiceError extends Schema.TaggedErrorClass<ExtensionServiceError>()(
  "@gent/core/src/domain/extension-services/ExtensionServiceError",
  {
    service: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message
  }
  return String(cause)
}

const serviceError =
  (service: string, operation: string) =>
  (cause: unknown): ExtensionServiceError =>
    new ExtensionServiceError({
      service,
      operation,
      message: errorMessage(cause),
      cause,
    })

const mapError = <A, E, R>(
  service: string,
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ExtensionServiceError, R> =>
  effect.pipe(Effect.mapError(serviceError(service, operation)))

export interface ExtensionSessionService {
  readonly listMessages: (
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Message>, ExtensionServiceError>
  readonly getSession: (
    sessionId?: SessionId,
  ) => Effect.Effect<Session | undefined, ExtensionServiceError>
  readonly getDetail: (sessionId: SessionId) => Effect.Effect<
    {
      readonly session: Session
      readonly branches: ReadonlyArray<{
        readonly branch: Branch
        readonly messages: ReadonlyArray<Message>
      }>
    },
    ExtensionServiceError
  >
  readonly renameCurrent: (
    name: string,
  ) => Effect.Effect<{ readonly renamed: boolean; readonly name?: string }, ExtensionServiceError>
  readonly estimateContextPercent: (options?: {
    readonly modelId?: string
  }) => Effect.Effect<number, ExtensionServiceError>
  readonly search: (
    query: string,
    options?: {
      readonly sessionId?: SessionId
      readonly dateAfter?: number
      readonly dateBefore?: number
      readonly limit?: number
    },
  ) => Effect.Effect<ReadonlyArray<ExtensionHostSearchResult>, ExtensionServiceError>
  readonly queueFollowUp: (params: {
    readonly sourceId: string
    readonly content: string
    readonly metadata?: MessageMetadata
    readonly branchId?: BranchId
  }) => Effect.Effect<void, ExtensionServiceError>
  readonly listBranches: () => Effect.Effect<ReadonlyArray<Branch>, ExtensionServiceError>
  readonly createBranch: (params: {
    readonly name?: string
  }) => Effect.Effect<{ readonly branchId: BranchId }, ExtensionServiceError>
  readonly forkBranch: (params: {
    readonly atMessageId: MessageId
    readonly name?: string
  }) => Effect.Effect<{ readonly branchId: BranchId }, ExtensionServiceError>
  readonly switchBranch: (params: {
    readonly toBranchId: BranchId
  }) => Effect.Effect<void, ExtensionServiceError>
  readonly createChildSession: (params: {
    readonly name?: string
    readonly cwd?: string
  }) => Effect.Effect<
    {
      readonly sessionId: SessionId
      readonly branchId: BranchId
    },
    ExtensionServiceError
  >
  readonly getChildSessions: () => Effect.Effect<ReadonlyArray<Session>, ExtensionServiceError>
  readonly getSessionAncestors: (
    sessionId?: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, ExtensionServiceError>
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, ExtensionServiceError>
  readonly deleteBranch: (branchId: BranchId) => Effect.Effect<void, ExtensionServiceError>
  readonly deleteMessages: (params: {
    readonly afterMessageId?: MessageId
  }) => Effect.Effect<void, ExtensionServiceError>
}

export class ExtensionSession extends Context.Service<ExtensionSession, ExtensionSessionService>()(
  "@gent/core/src/domain/extension-services/ExtensionSession",
) {}

export interface ExtensionAgentService {
  readonly get: (
    name: AgentName,
  ) => Effect.Effect<AgentDefinition | undefined, ExtensionServiceError>
  readonly require: (name: AgentName) => Effect.Effect<AgentDefinition, ExtensionServiceError>
  readonly run: (params: {
    readonly agent: AgentDefinition
    readonly prompt: string
    readonly cwd?: string
    readonly runSpec?: RunSpec
  }) => Effect.Effect<AgentRunResult, AgentRunError | ExtensionServiceError>
  readonly resolveDualModelPair: () => Effect.Effect<
    readonly [ModelId, ModelId],
    ExtensionServiceError
  >
}

export class ExtensionAgent extends Context.Service<ExtensionAgent, ExtensionAgentService>()(
  "@gent/core/src/domain/extension-services/ExtensionAgent",
) {}

export interface ExtensionInteractionService {
  readonly approve: (
    params: ApprovalRequest,
  ) => Effect.Effect<ApprovalDecision, ExtensionServiceError | InteractionPendingError>
  readonly present: (params: {
    readonly content: string
    readonly title?: string
  }) => Effect.Effect<void, ExtensionServiceError | InteractionPendingError>
  readonly confirm: (params: {
    readonly content: string
    readonly title?: string
  }) => Effect.Effect<"yes" | "no", ExtensionServiceError | InteractionPendingError>
  readonly review: (params: {
    readonly content: string
    readonly title?: string
    readonly fileNameSeed: string
  }) => Effect.Effect<
    { readonly decision: "yes" | "no" | "edit"; readonly path: string; readonly content?: string },
    ExtensionServiceError | InteractionPendingError
  >
}

export class ExtensionInteraction extends Context.Service<
  ExtensionInteraction,
  ExtensionInteractionService
>()("@gent/core/src/domain/extension-services/ExtensionInteraction") {}

export interface ExtensionProcessService {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: ExtensionHostRunProcessOptions,
  ) => Effect.Effect<ExtensionHostProcessResult, ExtensionServiceError>
  readonly signalPid: (
    pid: number,
    signal: ExtensionHostSignal,
  ) => Effect.Effect<void, ExtensionServiceError>
  readonly isPortFree: (port: number) => Effect.Effect<boolean, ExtensionServiceError>
  readonly isPidAlive: (pid: number) => Effect.Effect<boolean, ExtensionServiceError>
  readonly commandCandidates: (command: string) => ReadonlyArray<string>
  readonly parentEnv: Record<string, string | undefined>
}

export class ExtensionProcess extends Context.Service<ExtensionProcess, ExtensionProcessService>()(
  "@gent/core/src/domain/extension-services/ExtensionProcess",
) {}

export const extensionProcessFromHostContext = (
  host: ExtensionHostContext["host"],
): ExtensionProcessService => ({
  run: (command, args, options) =>
    mapError("ExtensionProcess", "run", host.runProcess(command, args, options)),
  signalPid: (pid, signal) =>
    mapError("ExtensionProcess", "signalPid", host.signalPid(pid, signal)),
  isPortFree: (port) => mapError("ExtensionProcess", "isPortFree", host.isPortFree(port)),
  isPidAlive: (pid) => mapError("ExtensionProcess", "isPidAlive", host.isPidAlive(pid)),
  commandCandidates: host.commandCandidates,
  parentEnv: host.parentEnv,
})

export interface ExtensionContextService {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly toolCallId?: ToolCallId
  readonly turn?: ExtensionTurnContext
  readonly cwd: string
  readonly home: string
  readonly Session: ExtensionSessionService
  readonly Agent: ExtensionAgentService
  readonly Interaction: ExtensionInteractionService
  readonly Process: ExtensionProcessService
}

export class ExtensionContext extends Context.Service<ExtensionContext, ExtensionContextService>()(
  "@gent/core/src/domain/extension-services/ExtensionContext",
) {}

export const extensionServicesFromHostContext = (
  ctx: ExtensionHostContext & {
    readonly toolCallId?: ToolCallId
    readonly turn?: ExtensionTurnContext
  },
): Context.Context<
  ExtensionContext | ExtensionSession | ExtensionAgent | ExtensionInteraction | ExtensionProcess
> => {
  const Session: ExtensionSessionService = {
    listMessages: (branchId) =>
      mapError("ExtensionSession", "listMessages", ctx.session.listMessages(branchId)),
    getSession: (sessionId) =>
      mapError("ExtensionSession", "getSession", ctx.session.getSession(sessionId)),
    getDetail: (sessionId) =>
      mapError("ExtensionSession", "getDetail", ctx.session.getDetail(sessionId)),
    renameCurrent: (name) =>
      mapError("ExtensionSession", "renameCurrent", ctx.session.renameCurrent(name)),
    estimateContextPercent: (options) =>
      mapError(
        "ExtensionSession",
        "estimateContextPercent",
        ctx.session.estimateContextPercent(options),
      ),
    search: (query, options) =>
      mapError("ExtensionSession", "search", ctx.session.search(query, options)),
    queueFollowUp: (params) =>
      mapError("ExtensionSession", "queueFollowUp", ctx.session.queueFollowUp(params)),
    listBranches: () => mapError("ExtensionSession", "listBranches", ctx.session.listBranches()),
    createBranch: (params) =>
      mapError("ExtensionSession", "createBranch", ctx.session.createBranch(params)),
    forkBranch: (params) =>
      mapError("ExtensionSession", "forkBranch", ctx.session.forkBranch(params)),
    switchBranch: (params) =>
      mapError("ExtensionSession", "switchBranch", ctx.session.switchBranch(params)),
    createChildSession: (params) =>
      mapError("ExtensionSession", "createChildSession", ctx.session.createChildSession(params)),
    getChildSessions: () =>
      mapError("ExtensionSession", "getChildSessions", ctx.session.getChildSessions()),
    getSessionAncestors: (sessionId) =>
      mapError(
        "ExtensionSession",
        "getSessionAncestors",
        ctx.session.getSessionAncestors(sessionId),
      ),
    deleteSession: (sessionId) =>
      mapError("ExtensionSession", "deleteSession", ctx.session.deleteSession(sessionId)),
    deleteBranch: (branchId) =>
      mapError("ExtensionSession", "deleteBranch", ctx.session.deleteBranch(branchId)),
    deleteMessages: (params) =>
      mapError("ExtensionSession", "deleteMessages", ctx.session.deleteMessages(params)),
  }
  const Agent: ExtensionAgentService = {
    get: (name) => mapError("ExtensionAgent", "get", ctx.agent.get(name)),
    require: (name) => mapError("ExtensionAgent", "require", ctx.agent.require(name)),
    run: (params) =>
      ctx.agent.run(params).pipe(
        Effect.mapError((cause) =>
          Schema.is(ExtensionServiceError)(cause)
            ? cause
            : new ExtensionServiceError({
                service: "ExtensionAgent",
                operation: "run",
                message: errorMessage(cause),
                cause,
              }),
        ),
      ),
    resolveDualModelPair: () =>
      mapError("ExtensionAgent", "resolveDualModelPair", ctx.agent.resolveDualModelPair()),
  }
  const Interaction: ExtensionInteractionService = {
    approve: (params) => mapInteraction("approve", ctx.interaction.approve(params)),
    present: (params) => mapInteraction("present", ctx.interaction.present(params)),
    confirm: (params) => mapInteraction("confirm", ctx.interaction.confirm(params)),
    review: (params) => mapInteraction("review", ctx.interaction.review(params)),
  }
  const Process = extensionProcessFromHostContext(ctx.host)

  return Context.empty().pipe(
    Context.add(ExtensionContext, {
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      ...(ctx.agentName !== undefined ? { agentName: ctx.agentName } : {}),
      ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
      ...(ctx.turn !== undefined ? { turn: ctx.turn } : {}),
      cwd: ctx.cwd,
      home: ctx.home,
      Session,
      Agent,
      Interaction,
      Process,
    }),
    Context.add(ExtensionSession, Session),
    Context.add(ExtensionAgent, Agent),
    Context.add(ExtensionInteraction, Interaction),
    Context.add(ExtensionProcess, Process),
  )
}

const mapInteraction = <A>(
  operation: string,
  effect: Effect.Effect<A, EventStoreError | InteractionPendingError | PlatformError.PlatformError>,
): Effect.Effect<A, ExtensionServiceError | InteractionPendingError> =>
  effect.pipe(
    Effect.mapError((cause) =>
      Schema.is(InteractionPendingError)(cause)
        ? cause
        : serviceError("ExtensionInteraction", operation)(cause),
    ),
  )

export const provideExtensionServices = <A, E, R>(
  ctx: ExtensionHostContext & {
    readonly toolCallId?: ToolCallId
    readonly turn?: ExtensionTurnContext
  },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.provideContext(extensionServicesFromHostContext(ctx)))
