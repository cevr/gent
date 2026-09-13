import { Predicate, Context, Effect, FileSystem, Option, Path, Schema } from "effect"
import type {
  AgentDefinition,
  AgentName,
  AgentRunError,
  AgentRunResult,
  ChildAgentRegistryEntry,
  RunSpec,
} from "./agent.js"
import { DEFAULT_AGENT_NAME } from "./agent.js"
import type { AgentEvent, TurnCompleted } from "./event.js"
import { causeMessage } from "./guards.js"
import type {
  ExtensionHostPlatform,
  ExtensionHostProcessResult,
  ExtensionTurnContext,
} from "./extension.js"
import { makeFileWriter } from "./file-writer.js"
import type { RunProcessOptions } from "../runtime/run-process.js"
import { FileLockService } from "./file-lock.js"
import { ExtensionStatePublisher } from "./event-publisher.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"
import type {
  ApprovalDecision,
  ApprovalRequest,
  InteractionPendingError,
} from "./interaction-request.js"
import {
  ExtensionId,
  type BranchId,
  type RequestId,
  type SessionId,
  type ToolCallId,
} from "./ids.js"
import type { MessageSearchResult } from "../storage/message-storage.js"
import type { Branch, Message, MessageMetadata, Session } from "./message.js"

export class ExtensionServiceError extends Schema.TaggedError<ExtensionServiceError>()(
  "@gent/core/src/domain/extension-services/ExtensionServiceError",
  {
    service: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const extensionServiceError =
  (service: string, operation: string) =>
  (cause: unknown): ExtensionServiceError =>
    new ExtensionServiceError({
      service,
      operation,
      message: causeMessage(cause),
      cause,
    })

const mapError = <A, E, R>(
  service: string,
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ExtensionServiceError, R> =>
  effect.pipe(Effect.mapError(extensionServiceError(service, operation)))

export interface ExtensionSessionService {
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
  ) => Effect.Effect<ReadonlyArray<MessageSearchResult>, ExtensionServiceError>
  readonly queueFollowUp: (params: {
    readonly sourceId: string
    readonly content: string
    readonly metadata?: MessageMetadata
    readonly branchId?: BranchId
    readonly wake?: boolean
  }) => Effect.Effect<void, ExtensionServiceError>
  /** Removes a queued follow-up by source. False when absent or already running. */
  readonly dequeueFollowUp: (params: {
    readonly sourceId: string
    readonly branchId?: BranchId
  }) => Effect.Effect<boolean, ExtensionServiceError>
  readonly listBranches: Effect.Effect<ReadonlyArray<Branch>, ExtensionServiceError>
  /**
   * Every session in the workspace. The durable half of an agent catalog:
   * survives restarts, but says nothing about what is running now.
   */
  readonly listSessions: Effect.Effect<ReadonlyArray<Session>, ExtensionServiceError>
  /**
   * Loops materialized right now. The live half of an agent catalog: carries
   * status, but is empty after a restart and omits idle or evicted branches.
   * Merge against `listSessions` to see every agent rather than only the
   * running ones.
   */
  readonly listActiveLoops: Effect.Effect<
    ReadonlyArray<{
      readonly sessionId: SessionId
      readonly branchId: BranchId
      /** Runtime state tag such as `Idle` or `Running`; `None` when the read failed. */
      readonly status: Option.Option<string>
    }>,
    ExtensionServiceError
  >
}

interface ExtensionAgentStartParams {
  readonly agent: AgentDefinition
  readonly prompt: string
  readonly requestId: RequestId
  readonly cwd?: string
  readonly runSpec?: RunSpec
}

interface ExtensionAgentRunParams {
  readonly agent: AgentDefinition
  readonly prompt: string
  readonly cwd?: string
  readonly runSpec?: RunSpec
  /** Sees child events in order as they happen, private runs included. Best effort: the run result can return before trailing events are observed, so read the answer from the result. Ephemeral runs only. */
  readonly observe?: (event: AgentEvent) => Effect.Effect<void>
}

interface ExtensionAgentService {
  readonly listAgents: Effect.Effect<ReadonlyArray<AgentDefinition>, ExtensionServiceError>
  /** Start from a host-owned tool call. The host supplies parent and tool identity. */
  readonly start: (
    params: ExtensionAgentStartParams,
  ) => Effect.Effect<
    { readonly sessionId: SessionId; readonly branchId: BranchId },
    AgentRunError | ExtensionServiceError
  >
  readonly inspect: (params: { readonly requestId: RequestId }) => Effect.Effect<
    {
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly completion: Option.Option<TurnCompleted>
    },
    AgentRunError
  >
  readonly list: () => Effect.Effect<ReadonlyArray<ChildAgentRegistryEntry>, AgentRunError>
  readonly cancel: (params: { readonly requestId: RequestId }) => Effect.Effect<void, AgentRunError>
  readonly run: (
    params: ExtensionAgentRunParams,
  ) => Effect.Effect<AgentRunResult, AgentRunError | ExtensionServiceError>
}

/** The host's agent facet. `start` still needs the tool call the child is owned by. */
export interface ExtensionHostAgentService extends Omit<ExtensionAgentService, "start"> {
  readonly start: (
    params: ExtensionAgentStartParams & { readonly toolCallId: ToolCallId },
  ) => Effect.Effect<
    { readonly sessionId: SessionId; readonly branchId: BranchId },
    AgentRunError | ExtensionServiceError
  >
}

export interface ExtensionInteractionService {
  readonly approve: (
    params: ApprovalRequest,
  ) => Effect.Effect<ApprovalDecision, ExtensionServiceError | InteractionPendingError>
  readonly present: (params: {
    readonly content: string
    readonly title?: string
  }) => Effect.Effect<void, ExtensionServiceError | InteractionPendingError>
}

interface ExtensionProcessService {
  readonly randomId: Effect.Effect<string>
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: RunProcessOptions,
  ) => Effect.Effect<ExtensionHostProcessResult, ExtensionServiceError>
  // oxlint-disable-next-line effect/noNullish -- Process environment maps preserve absent variables at the host boundary.
  readonly parentEnv: Record<string, string | undefined>
}

const extensionProcessFromHostContext = (host: ExtensionHostPlatform): ExtensionProcessService => ({
  randomId: host.randomId,
  run: (command, args, options) =>
    mapError("ExtensionProcess", "run", host.runProcess(command, args, options)),
  parentEnv: host.parentEnv,
})

interface ExtensionFileStat {
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
  readonly read: (path: string) => Effect.Effect<string, ExtensionServiceError>
  readonly write: (
    path: string,
    content: string,
    options?: { readonly atomic?: boolean },
  ) => Effect.Effect<void, ExtensionServiceError>
  readonly exists: (path: string) => Effect.Effect<boolean, ExtensionServiceError>
  readonly stat: (path: string) => Effect.Effect<ExtensionFileStat, ExtensionServiceError>
  readonly makeDirectory: (
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ) => Effect.Effect<void, ExtensionServiceError>
  /** Atomic replace on one file system: write a sibling, then rename over the target. */
  readonly rename: (from: string, to: string) => Effect.Effect<void, ExtensionServiceError>
  readonly resolve: (...paths: ReadonlyArray<string>) => string
  readonly join: (...paths: ReadonlyArray<string>) => string
  readonly dirname: (path: string) => string
}

interface ExtensionFileLockServiceApi {
  readonly withLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

interface ExtensionStateServiceApi {
  readonly changed: () => Effect.Effect<void, ExtensionServiceError>
}

/**
 * What the host builds once per run. The per-call context adds tool identity
 * and the ambient file, lock and state services on top of it.
 */
export interface ExtensionHostContext {
  readonly extensionId?: ExtensionId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly cwd: string
  readonly home: string
  readonly host: ExtensionHostPlatform
  readonly Agent: ExtensionHostAgentService
  readonly Session: ExtensionSessionService
  readonly Interaction: ExtensionInteractionService
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
}

export class ExtensionContext extends Context.Service<ExtensionContext, ExtensionContextService>()(
  "@gent/core/src/domain/extension-services/ExtensionContext",
) {}

const extensionServicesFromHostContext = (
  ctx: ExtensionHostContext & {
    readonly toolCallId?: ToolCallId
    readonly turn?: ExtensionTurnContext
  },
): Effect.Effect<Context.Context<ExtensionContext>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    // A session call made later from a background fiber, after the turn that
    // built this context, must still land in the workspace it was made from.
    const workspaceId = yield* CurrentWorkspaceId
    const inWorkspace = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      effect.pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
    const Session: ExtensionSessionService = {
      getSession: (sessionId) => inWorkspace(ctx.Session.getSession(sessionId)),
      getDetail: (sessionId) => inWorkspace(ctx.Session.getDetail(sessionId)),
      renameCurrent: (name) => inWorkspace(ctx.Session.renameCurrent(name)),
      search: (query, options) => inWorkspace(ctx.Session.search(query, options)),
      queueFollowUp: (params) => inWorkspace(ctx.Session.queueFollowUp(params)),
      dequeueFollowUp: (params) => inWorkspace(ctx.Session.dequeueFollowUp(params)),
      listBranches: inWorkspace(ctx.Session.listBranches),
      listSessions: inWorkspace(ctx.Session.listSessions),
      listActiveLoops: inWorkspace(ctx.Session.listActiveLoops),
    }
    const Agent: ExtensionAgentService = {
      ...ctx.Agent,
      start: Effect.fn("ExtensionAgent.start")(function* (params) {
        if (Predicate.isUndefined(ctx.toolCallId)) {
          return yield* new ExtensionServiceError({
            service: "ExtensionAgent",
            operation: "start",
            message: "Child start requires a host-owned tool call",
          })
        }
        return yield* ctx.Agent.start({ ...params, toolCallId: ctx.toolCallId })
      }),
    }
    const Process = extensionProcessFromHostContext(ctx.host)

    const fileLockOption = yield* Effect.serviceOption(FileLockService)
    const statePublisherOption = yield* Effect.serviceOption(ExtensionStatePublisher)
    const currentExtensionId = ctx.extensionId
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path

    const writeFile = makeFileWriter(fs, pathSvc.dirname)
    const Files: ExtensionFilesService = {
      read: (path) => mapError("ExtensionFiles", "read", fs.readFileString(path)),
      write: (path, content, options) =>
        mapError("ExtensionFiles", "write", writeFile(path, content, options)),
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
      makeDirectory: (path, options) =>
        mapError("ExtensionFiles", "makeDirectory", fs.makeDirectory(path, options)),
      rename: (from, to) => mapError("ExtensionFiles", "rename", fs.rename(from, to)),
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
          changed: () =>
            mapError(
              "ExtensionState",
              "changed",
              statePublisher.changed({
                extensionId: currentExtensionId,
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
              }),
            ),
        }
      },
    })

    const currentExtensionIdOption = Option.fromUndefinedOr(currentExtensionId)
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
        Interaction: ctx.Interaction,
        Process,
        Files,
        FileLock,
        State,
      }),
    )
  })

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

/**
 * The agent running the current turn. Children spawned from a cell inherit
 * it, so delegation never needs a roster of named agents.
 */
export const requireCurrentAgent: Effect.Effect<
  AgentDefinition,
  ExtensionServiceError,
  ExtensionContext
> = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const name = Option.getOrElse(Option.fromUndefinedOr(ctx.agentName), () => DEFAULT_AGENT_NAME)
  const agents = yield* ctx.Agent.listAgents
  const agent = agents.find((a) => a.name === name)
  if (!Predicate.isUndefined(agent)) return agent
  return yield* new ExtensionServiceError({
    service: "ExtensionAgent",
    operation: "require",
    message: `Agent "${name}" not found in registry`,
  })
})
