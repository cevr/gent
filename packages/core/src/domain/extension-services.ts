import {
  Predicate,
  Context,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  type PlatformError,
} from "effect"
import type { AgentDefinition, AgentName, AgentRunError, AgentRunResult, RunSpec } from "./agent.js"
import { DEFAULT_MODEL_ID } from "./agent.js"
import { estimateContextPercent as pureEstimateContextPercent } from "../runtime/context-estimation.js"
import type { EventStoreError } from "./event.js"
import { hasMessage } from "./guards.js"
import type {
  ExtensionHostRunProcessOptions,
  ExtensionHostProcessResult,
  ExtensionHostSignal,
  ExtensionTurnContext,
} from "./extension.js"
import { FileIndex, type IndexedFile } from "./file-index.js"
import { FileLockService } from "./file-lock.js"
import { ExtensionStatePublisher } from "./event-publisher.js"
import type { ApprovalDecision, ApprovalRequest } from "./interaction-request.js"
import { InteractionPendingError } from "./interaction-request.js"
import { ExtensionId, type BranchId, type SessionId, type ToolCallId } from "./ids.js"
import type { Branch, Message, MessageMetadata, Session } from "./message.js"
import type { ExtensionHostContext, ExtensionHostSearchResult } from "./extension-host-context.js"
import type { RequestCapability } from "./capability/request.js"
import type { ToolCapability } from "./capability/tool.js"
import {
  DynamicExtensionRegistry,
  type DynamicRegistrationScope,
} from "./dynamic-extension-registry.js"

export class ExtensionServiceError extends Schema.TaggedError<ExtensionServiceError>()(
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
  if (hasMessage(cause)) {
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
  ) => // oxlint-disable-next-line effect/noNullish -- The public extension facade preserves undefined for an absent session.
  Effect.Effect<Session | undefined, ExtensionServiceError>
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
  readonly listBranches: Effect.Effect<ReadonlyArray<Branch>, ExtensionServiceError>
}

export interface ExtensionAgentService extends Pick<
  ExtensionHostContext.Agent,
  "inspect" | "list" | "cancel"
> {
  readonly listAgents: Effect.Effect<ReadonlyArray<AgentDefinition>, ExtensionServiceError>
  /** Start from a host-owned tool call. The host supplies parent and tool identity. */
  readonly start: (
    params: Omit<Parameters<ExtensionHostContext.Agent["start"]>[0], "toolCallId">,
  ) => Effect.Effect<
    Effect.Success<ReturnType<ExtensionHostContext.Agent["start"]>>,
    AgentRunError | ExtensionServiceError
  >
  readonly run: (params: {
    readonly agent: AgentDefinition
    readonly prompt: string
    readonly cwd?: string
    readonly runSpec?: RunSpec
  }) => Effect.Effect<AgentRunResult, AgentRunError | ExtensionServiceError>
}

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

export interface ExtensionProcessService {
  readonly randomId: Effect.Effect<string>
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
  // oxlint-disable-next-line effect/noNullish -- Process environment maps preserve absent variables at the host boundary.
  readonly parentEnv: Record<string, string | undefined>
}

export const extensionProcessFromHostContext = (
  host: ExtensionHostContext["host"],
): ExtensionProcessService => ({
  randomId: host.randomId,
  run: (command, args, options) =>
    mapError("ExtensionProcess", "run", host.runProcess(command, args, options)),
  signalPid: (pid, signal) =>
    mapError("ExtensionProcess", "signalPid", host.signalPid(pid, signal)),
  isPortFree: (port) => mapError("ExtensionProcess", "isPortFree", host.isPortFree(port)),
  isPidAlive: (pid) => mapError("ExtensionProcess", "isPidAlive", host.isPidAlive(pid)),
  commandCandidates: host.commandCandidates,
  parentEnv: host.parentEnv,
})

export interface ExtensionFileStat {
  readonly type:
    | "File"
    | "Directory"
    | "SymbolicLink"
    | "BlockDevice"
    | "CharacterDevice"
    | "FIFO"
    | "Socket"
    | "Unknown"
  readonly size: bigint
  // oxlint-disable-next-line effect/noNullish -- File stat preserves the platform's absent modification time.
  readonly mtime: Date | undefined
}

export interface ExtensionFilesService {
  readonly listFiles: (params: {
    readonly cwd: string
    readonly waitForScanMs?: number
  }) => Effect.Effect<ReadonlyArray<IndexedFile>, ExtensionServiceError>
  readonly read: (path: string) => Effect.Effect<string, ExtensionServiceError>
  readonly write: (path: string, content: string) => Effect.Effect<void, ExtensionServiceError>
  readonly exists: (path: string) => Effect.Effect<boolean, ExtensionServiceError>
  readonly stat: (path: string) => Effect.Effect<ExtensionFileStat, ExtensionServiceError>
  readonly readDirectory: (
    path: string,
    options?: { readonly recursive?: boolean },
  ) => Effect.Effect<ReadonlyArray<string>, ExtensionServiceError>
  readonly makeDirectory: (
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ) => Effect.Effect<void, ExtensionServiceError>
  readonly resolve: (...paths: ReadonlyArray<string>) => string
  readonly join: (...paths: ReadonlyArray<string>) => string
  readonly dirname: (path: string) => string
}

export interface ExtensionFileLockServiceApi {
  readonly withLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export interface ExtensionStateServiceApi {
  readonly changed: (params: {
    readonly sessionId?: SessionId
    readonly branchId?: BranchId
  }) => Effect.Effect<void, ExtensionServiceError>
}

export interface ExtensionDynamicRegistrationServiceApi {
  readonly registerTool: (
    capability: ToolCapability,
    options?: { readonly scope?: DynamicRegistrationScope },
  ) => Effect.Effect<Effect.Effect<void>, ExtensionServiceError>
  readonly registerRequest: (
    capability: RequestCapability,
    options?: { readonly scope?: DynamicRegistrationScope },
  ) => Effect.Effect<Effect.Effect<void>, ExtensionServiceError>
}

export interface ExtensionContextService {
  readonly extensionId: ExtensionId
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
  readonly Files: ExtensionFilesService
  readonly FileLock: ExtensionFileLockServiceApi
  readonly State: ExtensionStateServiceApi
  readonly Dynamic: ExtensionDynamicRegistrationServiceApi
}

export class ExtensionContext extends Context.Service<ExtensionContext, ExtensionContextService>()(
  "@gent/core/src/domain/extension-services/ExtensionContext",
) {}

export const extensionServicesFromHostContext = (
  ctx: ExtensionHostContext & {
    readonly toolCallId?: ToolCallId
    readonly turn?: ExtensionTurnContext
  },
): Effect.Effect<Context.Context<ExtensionContext>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const Session: ExtensionSessionService = {
      listMessages: (branchId) =>
        mapError("ExtensionSession", "listMessages", ctx.session.listMessages(branchId)),
      getSession: (sessionId) =>
        mapError("ExtensionSession", "getSession", ctx.session.getSession(sessionId)),
      getDetail: (sessionId) =>
        mapError("ExtensionSession", "getDetail", ctx.session.getDetail(sessionId)),
      renameCurrent: (name) =>
        mapError("ExtensionSession", "renameCurrent", ctx.session.renameCurrent(name)),
      search: (query, options) =>
        mapError("ExtensionSession", "search", ctx.session.search(query, options)),
      queueFollowUp: (params) =>
        mapError("ExtensionSession", "queueFollowUp", ctx.session.queueFollowUp(params)),
      listBranches: mapError("ExtensionSession", "listBranches", ctx.session.listBranches()),
    }
    const Agent: ExtensionAgentService = {
      listAgents: mapError("ExtensionAgent", "listAgents", ctx.agent.listAgents()),
      start: Effect.fn("ExtensionAgent.start")(function* (params) {
        if (Predicate.isUndefined(ctx.toolCallId)) {
          return yield* new ExtensionServiceError({
            service: "ExtensionAgent",
            operation: "start",
            message: "Child start requires a host-owned tool call",
          })
        }
        return yield* ctx.agent.start({ ...params, toolCallId: ctx.toolCallId })
      }),
      inspect: ctx.agent.inspect,
      list: ctx.agent.list,
      cancel: ctx.agent.cancel,
      run: (params) =>
        ctx.agent.run(params).pipe(
          Effect.mapError((cause) => {
            if (Schema.is(ExtensionServiceError)(cause)) return cause
            return new ExtensionServiceError({
              service: "ExtensionAgent",
              operation: "run",
              message: errorMessage(cause),
              cause,
            })
          }),
        ),
    }
    const Interaction: ExtensionInteractionService = {
      approve: (params) => mapInteraction("approve", ctx.interaction.approve(params)),
      present: (params) => mapInteraction("present", ctx.interaction.present(params)),
      confirm: (params) => mapInteraction("confirm", ctx.interaction.confirm(params)),
      review: (params) => mapInteraction("review", ctx.interaction.review(params)),
    }
    const Process = extensionProcessFromHostContext(ctx.host)

    const fileIndexOption = yield* Effect.serviceOption(FileIndex)
    const fileLockOption = yield* Effect.serviceOption(FileLockService)
    const statePublisherOption = yield* Effect.serviceOption(ExtensionStatePublisher)
    const dynamicRegistryOption = yield* Effect.serviceOption(DynamicExtensionRegistry)
    const currentExtensionId = ctx.extensionId
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path

    const listFiles: ExtensionFilesService["listFiles"] = Option.match(fileIndexOption, {
      onNone: () => () =>
        Effect.fail(
          new ExtensionServiceError({
            service: "ExtensionFiles",
            operation: "listFiles",
            message: "File index service unavailable",
          }),
        ),
      onSome: (fileIndex) => (params) =>
        mapError("ExtensionFiles", "listFiles", fileIndex.listFiles(params)),
    })

    const Files: ExtensionFilesService = {
      listFiles,
      read: (path) => mapError("ExtensionFiles", "read", fs.readFileString(path)),
      write: (path, content) =>
        mapError("ExtensionFiles", "write", fs.writeFileString(path, content)),
      exists: (path) => mapError("ExtensionFiles", "exists", fs.exists(path)),
      stat: (path) =>
        mapError(
          "ExtensionFiles",
          "stat",
          fs.stat(path).pipe(
            Effect.map((info) => ({
              type: info.type,
              size: info.size,
              mtime: Option.getOrUndefined(info.mtime),
            })),
          ),
        ),
      readDirectory: (path, options) =>
        mapError("ExtensionFiles", "readDirectory", fs.readDirectory(path, options)),
      makeDirectory: (path, options) =>
        mapError("ExtensionFiles", "makeDirectory", fs.makeDirectory(path, options)),
      resolve: (...paths) => pathSvc.resolve(...paths),
      join: (...paths) => pathSvc.join(...paths),
      dirname: (path) => pathSvc.dirname(path),
    }

    const FileLock: ExtensionFileLockServiceApi = Option.match(fileLockOption, {
      onNone: () => ({ withLock: (_path, effect) => effect }),
      onSome: (fileLock) => ({
        withLock: (path, effect) => fileLock.withLock(path, effect),
      }),
    })

    const State: ExtensionStateServiceApi = Option.match(statePublisherOption, {
      onNone: () => ({ changed: () => Effect.void }),
      onSome: (statePublisher) => {
        if (Predicate.isUndefined(currentExtensionId)) {
          return {
            changed: () =>
              Effect.fail(
                new ExtensionServiceError({
                  service: "ExtensionState",
                  operation: "changed",
                  message: "Extension id unavailable for state change notification",
                }),
              ),
          }
        }
        return {
          changed: (params: { readonly sessionId?: SessionId; readonly branchId?: BranchId }) => {
            const sessionId = Option.getOrElse(
              Option.fromUndefinedOr(params.sessionId),
              () => ctx.sessionId,
            )
            const branchId = Option.getOrElse(
              Option.fromUndefinedOr(params.branchId),
              () => ctx.branchId,
            )
            return mapError(
              "ExtensionState",
              "changed",
              statePublisher.changed({
                extensionId: currentExtensionId,
                sessionId,
                branchId,
              }),
            )
          },
        }
      },
    })

    const currentExtensionIdOption = Option.fromUndefinedOr(currentExtensionId)
    const defaultDynamicScope: DynamicRegistrationScope = {
      _tag: "session",
      sessionId: ctx.sessionId,
    }
    const dynamicScope = (options?: {
      readonly scope?: DynamicRegistrationScope
    }): DynamicRegistrationScope =>
      Option.match(Option.fromUndefinedOr(options), {
        onNone: () => defaultDynamicScope,
        onSome: (value) =>
          Option.getOrElse(Option.fromUndefinedOr(value.scope), () => defaultDynamicScope),
      })
    let unavailableDynamicMessage = "Dynamic extension registry unavailable"
    if (Option.isNone(currentExtensionIdOption)) {
      unavailableDynamicMessage = "Extension id unavailable for dynamic registration"
    }
    const unavailableDynamic: ExtensionDynamicRegistrationServiceApi = {
      registerTool: () =>
        Effect.fail(
          new ExtensionServiceError({
            service: "ExtensionDynamic",
            operation: "registerTool",
            message: unavailableDynamicMessage,
          }),
        ),
      registerRequest: () =>
        Effect.fail(
          new ExtensionServiceError({
            service: "ExtensionDynamic",
            operation: "registerRequest",
            message: unavailableDynamicMessage,
          }),
        ),
    }
    const Dynamic: ExtensionDynamicRegistrationServiceApi = Option.match(dynamicRegistryOption, {
      onNone: () => unavailableDynamic,
      onSome: (dynamicRegistry) =>
        Option.match(currentExtensionIdOption, {
          onNone: () => unavailableDynamic,
          onSome: (extensionId) => ({
            registerTool: (capability, options) =>
              mapError(
                "ExtensionDynamic",
                "registerTool",
                dynamicRegistry.registerTool({
                  extensionId,
                  scope: dynamicScope(options),
                  capability,
                }),
              ),
            registerRequest: (capability, options) =>
              mapError(
                "ExtensionDynamic",
                "registerRequest",
                dynamicRegistry.registerRequest({
                  extensionId,
                  scope: dynamicScope(options),
                  capability,
                }),
              ),
          }),
        }),
    })

    return Context.empty().pipe(
      Context.add(ExtensionContext, {
        extensionId: Option.getOrElse(currentExtensionIdOption, () => ExtensionId.make("unknown")),
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        agentName: ctx.agentName,
        toolCallId: ctx.toolCallId,
        turn: ctx.turn,
        cwd: ctx.cwd,
        home: ctx.home,
        Session,
        Agent,
        Interaction,
        Process,
        Files,
        FileLock,
        State,
        Dynamic,
      }),
    )
  })

const mapInteraction = <A>(
  operation: string,
  effect: Effect.Effect<A, EventStoreError | InteractionPendingError | PlatformError.PlatformError>,
): Effect.Effect<A, ExtensionServiceError | InteractionPendingError> =>
  effect.pipe(
    Effect.mapError((cause) => {
      if (Schema.is(InteractionPendingError)(cause)) {
        return cause
      }
      return serviceError("ExtensionInteraction", operation)(cause)
    }),
  )

export const provideExtensionServices = <A, E, R>(
  ctx: ExtensionHostContext & {
    readonly toolCallId?: ToolCallId
    readonly turn?: ExtensionTurnContext
  },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, ExtensionContext> | FileSystem.FileSystem | Path.Path> =>
  Effect.flatMap(extensionServicesFromHostContext(ctx), (services) =>
    effect.pipe(Effect.provideContext(services)),
  )

export const requireAgent = (
  name: AgentName,
): Effect.Effect<AgentDefinition, ExtensionServiceError, ExtensionContext> =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const agents = yield* ctx.Agent.listAgents
    const agent = agents.find((a) => a.name === name)
    if (!Predicate.isUndefined(agent)) return agent
    return yield* new ExtensionServiceError({
      service: "ExtensionAgent",
      operation: "require",
      message: `Agent "${name}" not found in registry`,
    })
  })

export const estimateContextPercent = (options?: {
  readonly modelId?: string
}): Effect.Effect<number, ExtensionServiceError, ExtensionContext> =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const messages = yield* ctx.Session.listMessages()
    const modelId = options?.modelId ?? DEFAULT_MODEL_ID
    return pureEstimateContextPercent(messages, modelId)
  })
