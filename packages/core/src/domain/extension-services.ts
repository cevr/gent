import { Predicate, Context, Effect, Option, Schema } from "effect"
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
import type { ExtensionHostPlatform, ExtensionTurnContext } from "./extension.js"
import type { ProcessResult, RunProcessOptions } from "../runtime/run-process.js"
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

/** Restates a facet failure as the one error extensions see. */
export const mapExtensionServiceError = <A, E, R>(
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
  /** Message a child that is still running. `sendId` makes a replayed call deliver once. */
  readonly send: (params: {
    readonly requestId: RequestId
    readonly message: string
    readonly sendId: RequestId
  }) => Effect.Effect<void, AgentRunError>
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

export interface ExtensionProcessService {
  readonly randomId: Effect.Effect<string>
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: RunProcessOptions,
  ) => Effect.Effect<ProcessResult, ExtensionServiceError>
  // oxlint-disable-next-line effect/noNullish -- Process environment maps preserve absent variables at the host boundary.
  readonly parentEnv: Record<string, string | undefined>
}

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

interface ExtensionStateServiceApi {
  readonly changed: () => Effect.Effect<void, ExtensionServiceError>
}

/**
 * The run's half of the state facet: it knows the session and branch, and
 * takes the extension id from whichever leaf reports the change.
 */
export type ExtensionStateFacet = (
  extensionId: Option.Option<ExtensionId>,
) => ExtensionStateServiceApi

/**
 * Every facet, built once per run by the provider that owns its inputs.
 * A leaf adds only the two facts a run does not carry: the tool call
 * `Agent.start` charges a child to, and the extension id `State.changed`
 * reports under.
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
  readonly Process: ExtensionProcessService
  readonly Files: ExtensionFilesService
  readonly FileLock: ExtensionFileLockServiceApi
  /** Reports under the leaf's extension id, which a run does not know. */
  readonly State: ExtensionStateFacet
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

/**
 * The per-leaf half of the extension context: the run's facets, plus the two
 * facts only a leaf knows. `Agent.start` charges the child to the leaf's tool
 * call, and `State.changed` reports under the leaf's extension id. Every other
 * facet is forwarded, because the run already built it over the services that
 * own its inputs.
 */
const extensionServicesFromHostContext = (
  ctx: ExtensionHostContext & {
    readonly toolCallId?: ToolCallId
    readonly turn?: ExtensionTurnContext
  },
): Context.Context<ExtensionContext> => {
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
  const extensionIdOption = Option.fromUndefinedOr(ctx.extensionId)
  return Context.empty().pipe(
    Context.add(ExtensionContext, {
      extensionId: Option.getOrElse(extensionIdOption, () => ExtensionId.make("unknown")),
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      agentName: ctx.agentName,
      toolCallId: ctx.toolCallId,
      turn: ctx.turn,
      cwd: ctx.cwd,
      home: ctx.home,
      Session: ctx.Session,
      Agent,
      Interaction: ctx.Interaction,
      Process: ctx.Process,
      Files: ctx.Files,
      FileLock: ctx.FileLock,
      State: ctx.State(extensionIdOption),
    }),
  )
}

export const provideExtensionServices = <A, E, R>(
  ctx: ExtensionHostContext & {
    readonly toolCallId?: ToolCallId
    readonly turn?: ExtensionTurnContext
  },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, ExtensionContext>> =>
  effect.pipe(Effect.provideContext(extensionServicesFromHostContext(ctx)))

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
