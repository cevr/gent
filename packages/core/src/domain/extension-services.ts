import { Context, Effect, FileSystem, Option, Path, Schema, type PlatformError } from "effect"
import type { AgentDefinition, AgentName, AgentRunError, AgentRunResult, RunSpec } from "./agent.js"
import type { EventStoreError } from "./event.js"
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
import type { BranchId, ExtensionId, SessionId, ToolCallId } from "./ids.js"
import type { Branch, Message, MessageMetadata, Session } from "./message.js"
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
}

export interface ExtensionAgentService {
  readonly get: (
    name: AgentName,
  ) => Effect.Effect<AgentDefinition | undefined, ExtensionServiceError>
  readonly require: (name: AgentName) => Effect.Effect<AgentDefinition, ExtensionServiceError>
  readonly listAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>, ExtensionServiceError>
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

export interface ExtensionFileLockServiceShape {
  readonly withLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export interface ExtensionStateServiceShape {
  readonly changed: (params: {
    readonly extensionId: ExtensionId
    readonly sessionId?: SessionId
    readonly branchId?: BranchId
  }) => Effect.Effect<void, ExtensionServiceError>
}

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
  readonly Files: ExtensionFilesService
  readonly FileLock: ExtensionFileLockServiceShape
  readonly State: ExtensionStateServiceShape
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
    }
    const Agent: ExtensionAgentService = {
      get: (name) => mapError("ExtensionAgent", "get", ctx.agent.get(name)),
      require: (name) => mapError("ExtensionAgent", "require", ctx.agent.require(name)),
      listAgents: () => mapError("ExtensionAgent", "listAgents", ctx.agent.listAgents()),
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
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path

    const listFiles: ExtensionFilesService["listFiles"] =
      fileIndexOption._tag === "Some"
        ? (params) =>
            mapError("ExtensionFiles", "listFiles", fileIndexOption.value.listFiles(params))
        : () =>
            Effect.fail(
              serviceError(
                "ExtensionFiles",
                "listFiles",
              )(new Error("File index service unavailable")),
            )

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

    const FileLock: ExtensionFileLockServiceShape =
      fileLockOption._tag === "Some"
        ? {
            withLock: (path, effect) => fileLockOption.value.withLock(path, effect),
          }
        : {
            withLock: (_path, effect) => effect,
          }

    const State: ExtensionStateServiceShape =
      statePublisherOption._tag === "Some"
        ? {
            changed: (params) =>
              mapError(
                "ExtensionState",
                "changed",
                statePublisherOption.value.changed({
                  extensionId: params.extensionId,
                  sessionId: params.sessionId ?? ctx.sessionId,
                  branchId: params.branchId ?? ctx.branchId,
                }),
              ),
          }
        : {
            changed: () => Effect.void,
          }

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
        Files,
        FileLock,
        State,
      }),
    )
  })

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
): Effect.Effect<A, E, Exclude<R, ExtensionContext> | FileSystem.FileSystem | Path.Path> =>
  Effect.flatMap(extensionServicesFromHostContext(ctx), (services) =>
    effect.pipe(Effect.provideContext(services)),
  )
