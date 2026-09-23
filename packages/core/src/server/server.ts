import {
  Clock,
  Context,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { BranchId, MessageId, type RequestId, SessionId } from "../domain/ids.js"
import {
  Branch,
  type BranchTreeNode,
  copyMessageToBranch,
  projectMessagesWithToolInteractions,
  Session,
  type SessionAdmission,
  toolCallReceipts,
  clientMetadata,
  sessionThread,
} from "../domain/message.js"
import {
  BranchStorage,
  type DurableOperation,
  DurableOperations,
  EventStorage,
  InteractionStorage,
  makeStorageTransaction,
  MessageStorage,
  RelationshipStorage,
  SessionOperationStorage,
  SessionStorage,
  SqliteStorage,
  type StorageError,
  type StoredBranchResult,
  type StoredCreateSessionResult,
  type StoredSwitchBranchResult,
} from "../storage/storage.js"
import {
  type ExtensionSetupServices,
  type ExtensionStatusInfo,
  FileLockService,
  type GentExtension,
  SessionMutations,
  type SessionMutationsService,
} from "../domain/extension.js"
import {
  type AuthorizeAuthInput,
  type CallbackAuthInput,
  type ClearDriverOverrideInput,
  type CreateBranchInput,
  type CreateSessionInput,
  type DeleteAuthKeyInput,
  DriverInfo,
  DriverListResult,
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
  ExtensionProtocolError,
  type ExtensionRpcRequestInput,
  type ForkBranchInput,
  GentRpcs,
  type GetSessionSnapshotInput,
  InvalidStateError,
  type ListAuthProvidersPayload,
  NotFoundError,
  type QueueDrainInput,
  type QueueTarget,
  type RespondInteractionInput,
  type SendMessageInput,
  SessionSnapshot,
  type SetAuthKeyInput,
  type SetDriverOverrideInput,
  SlashCommandInfo,
  type SubscribeEventsInput,
  type SwitchBranchInput,
  type SteerCommand as TransportSteerCommand,
  type UpdateSessionSettingsInput,
  type GentNamespacedClient,
  makeNamespacedClient,
} from "./rpc.js"
import type { SqlClient } from "effect/unstable/sql"
import {
  type AgentEvent,
  BranchCreated,
  BranchSwitched,
  type EventEnvelope,
  EventId,
  EventPublisher,
  EventPublisherLive,
  EventStore,
  type EventStoreError,
  InteractionResolved,
  SessionNameUpdated,
  SessionSettingsUpdated,
  SessionStarted,
} from "../domain/event.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { AgentLoopLiveActor, AgentLoopSessionGovernance } from "../runtime/agent-loop.js"
import {
  admitChildSessionDepth,
  EventStoreLive,
  makeRequestDeduper,
  SessionRuntime,
  type SessionRuntimeError,
} from "../runtime/session.js"
import { CurrentWorkspaceId, workspaceIdForCwd, WorkspaceRpcMiddleware } from "./workspace-rpc.js"
import {
  Auth,
  AuthApi,
  listAuthProviders,
  ModelCatalogRecord,
  ModelRegistry,
  ModelResolver,
  modelCatalog,
  ProviderAuth,
} from "../runtime/provider.js"
import { ProviderAuthError } from "../domain/driver.js"
import { ConfigService, RuntimeEnvironment } from "../runtime/config.js"
import {
  ApprovalService,
  configHealthStatuses,
  ExtensionRegistry,
  type ExtensionRegistryService,
  type ModelCatalogFailure,
  resolveExistingSessionBranch,
  SessionProfileCache,
} from "../runtime/extension-host.js"
import type { AgentName } from "../domain/agent.js"
import { foldSessionMetrics, type SendUserMessagePayload } from "../domain/agent-loop.js"
import { resolveSessionSettings, sessionAgentDefinition } from "../runtime/turn.js"
import { WideEvent, WideEventBoundary, withWideEvent } from "effect-wide-event"

import { omitUndefined } from "../domain/guards.js"
import { SingleRunner } from "effect/unstable/cluster"
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import type { LanguageModel } from "effect/unstable/ai"
import { ChildProcessSpawner as ProcessSpawner } from "effect/unstable/process"
import type { PromptSection } from "../domain/capability.js"
import { type BranchToolFeature, CurrentBranchToolFeature, ToolRunner } from "../runtime/tools.js"
import { messagesInCurrentWindow, settledMessages } from "../runtime/model-context.js"
import { RpcSerialization, RpcServer, RpcTest } from "effect/unstable/rpc"
import type { Headers } from "effect/unstable/http"

// ── client origin ───────────────────────────────────────────────────────────

/**
 * A client's steer as the loop receives it: an interjection carries the
 * server's client origin over whatever the client set (`clientMetadata`), so
 * no client can claim an extension author or drop its own origin. A client
 * request's grant is not part of the command at all: only the loop's own
 * facade passes one.
 */
const clientSteer = (command: TransportSteerCommand): TransportSteerCommand => {
  if (command._tag !== "Interject") return command
  return { ...command, metadata: clientMetadata(command.metadata) }
}

// ── connection-tracker ──────────────────────────────────────────────────────

/**
 * ConnectionTracker — tracks active WebSocket connections for idle shutdown.
 */

export interface ConnectionTrackerService {
  readonly increment: Effect.Effect<void>
  readonly decrement: Effect.Effect<void>
  readonly count: Effect.Effect<number>
}

export class ConnectionTracker extends Context.Service<
  ConnectionTracker,
  ConnectionTrackerService
>()("@gent/core/src/server/server/ConnectionTracker") {
  static Live: Layer.Layer<ConnectionTracker> = Layer.effect(
    ConnectionTracker,
    Effect.gen(function* () {
      const ref = yield* Ref.make(0)
      return ConnectionTracker.of({
        increment: Ref.update(ref, (n) => n + 1),
        decrement: Ref.update(ref, (n) => Math.max(0, n - 1)),
        count: Ref.get(ref),
      })
    }),
  )
}

// ── server-identity ─────────────────────────────────────────────────────────

/**
 * ServerIdentity — provides server identity info for status/identity routes.
 * Populated by the server app at startup.
 */

export interface ServerIdentityApi {
  readonly serverId: string
  readonly pid: number
  readonly hostname: string
  readonly dbPath: string
  readonly buildFingerprint: string
  readonly startedAt: number
}

export class ServerIdentity extends Context.Service<ServerIdentity, ServerIdentityApi>()(
  "@gent/core/src/server/server/ServerIdentity",
) {
  static Live = (config: ServerIdentityApi): Layer.Layer<ServerIdentity> =>
    Layer.succeed(ServerIdentity, ServerIdentity.of(config))
}

// ── session-utils ───────────────────────────────────────────────────────────

type MutableBranchTreeNode = Omit<BranchTreeNode, "children"> & {
  children: MutableBranchTreeNode[]
}

export const buildBranchTree = (
  branches: ReadonlyArray<Branch>,
  messageCounts: ReadonlyMap<BranchId, number>,
): BranchTreeNode[] => {
  const nodes = new Map<BranchId, MutableBranchTreeNode>()

  for (const branch of branches) {
    nodes.set(branch.id, {
      branch,
      messageCount: messageCounts.get(branch.id) ?? 0,
      children: [],
    })
  }

  const roots: MutableBranchTreeNode[] = []
  for (const branch of branches) {
    const node = nodes.get(branch.id)
    if (Predicate.isUndefined(node)) continue
    if (
      !Predicate.isUndefined(branch.parentBranchId) &&
      branch.parentBranchId !== "" &&
      nodes.has(branch.parentBranchId)
    ) {
      const parent = nodes.get(branch.parentBranchId)
      if (!Predicate.isUndefined(parent)) parent.children.push(node)
      continue
    }
    roots.push(node)
  }

  const sortNodes = (list: MutableBranchTreeNode[]) => {
    list.sort((a, b) => a.branch.createdAt.getTime() - b.branch.createdAt.getTime())
    for (const node of list) {
      if (node.children.length > 0) sortNodes(node.children)
    }
  }

  sortNodes(roots)
  return roots
}

export const getBranchTree = (
  sessionId: SessionId,
): Effect.Effect<ReadonlyArray<BranchTreeNode>, StorageError, BranchStorage> =>
  Effect.gen(function* () {
    const branchStorage = yield* BranchStorage
    const branches = yield* branchStorage.listBranches(sessionId)
    const messageCounts = yield* branchStorage.countMessagesByBranches(
      branches.map((branch) => branch.id),
    )
    return buildBranchTree(branches, messageCounts)
  })

// ── extension-health ────────────────────────────────────────────────────────

/** Each failed catalog under the extension that contributes its driver. */
const catalogFailuresByExtension = (
  resolved: ReturnType<ExtensionRegistryService["getResolved"]>,
  failures: ReadonlyArray<ModelCatalogFailure>,
): ReadonlyMap<string, ReadonlyArray<ExtensionHealthIssue>> => {
  const byExtension = new Map<string, Array<ExtensionHealthIssue>>()
  for (const failure of failures) {
    const driver = resolved.modelDrivers.get(failure.driverId)
    const owner = resolved.extensions.find((extension) =>
      (extension.contributions.modelDrivers ?? []).some((candidate) => candidate === driver),
    )
    if (Predicate.isUndefined(owner)) continue
    const issues = byExtension.get(owner.manifest.id) ?? []
    issues.push(
      ExtensionHealthIssue.cases.ModelCatalogFailed.make({
        driverId: failure.driverId,
        error: failure.error,
      }),
    )
    byExtension.set(owner.manifest.id, issues)
  }
  return byExtension
}

export const buildExtensionHealthSnapshot = (
  activationStatuses: ReadonlyArray<ExtensionStatusInfo>,
  runtimeIssues: ReadonlyMap<string, ReadonlyArray<ExtensionHealthIssue>> = new Map(),
): ExtensionHealthSnapshot => {
  const extensions = activationStatuses.map((status) => {
    const issues: Array<ExtensionHealthIssue> = []
    if (status.status === "failed") {
      issues.push(
        ExtensionHealthIssue.cases.ActivationFailed.make({
          phase: status.phase,
          error: status.error,
        }),
      )
    } else {
      issues.push(...(runtimeIssues.get(status.manifest.id) ?? []))
    }

    const payload = {
      manifest: status.manifest,
      scope: status.scope,
      sourcePath: status.sourcePath,
    }

    const [firstIssue, ...remainingIssues] = issues
    if (Predicate.isUndefined(firstIssue)) {
      return ExtensionHealth.cases.Healthy.make(payload)
    }
    return ExtensionHealth.cases.Degraded.make({
      ...payload,
      issues: [firstIssue, ...remainingIssues],
    })
  })

  const healthyExtensions = extensions.filter(ExtensionHealth.guards.Healthy)
  const degradedExtensions = extensions.filter(ExtensionHealth.guards.Degraded)
  const [firstDegraded, ...remainingDegraded] = degradedExtensions

  if (Predicate.isUndefined(firstDegraded)) {
    return ExtensionHealthSnapshot.cases.Healthy.make({ extensions: healthyExtensions })
  }
  return ExtensionHealthSnapshot.cases.Degraded.make({
    healthyExtensions,
    degradedExtensions: [firstDegraded, ...remainingDegraded],
  })
}

// ── session-mutations-live ──────────────────────────────────────────────────

interface CreateSessionResult {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
}

type CreateBranchParams = Parameters<SessionMutationsService["createSessionBranch"]>[0]
type ForkBranchParams = Parameters<SessionMutationsService["forkSessionBranch"]>[0]
type SwitchBranchParams = Parameters<SessionMutationsService["switchActiveBranch"]>[0]
type SessionMutationError = Effect.Error<ReturnType<SessionMutationsService["switchActiveBranch"]>>
type RenameSessionResult = Effect.Success<ReturnType<SessionMutationsService["renameSession"]>>

const createSessionResult = (operation: StoredCreateSessionResult): CreateSessionResult => ({
  sessionId: operation.sessionId,
  branchId: operation.branchId,
  name: operation.name,
})

const makeSessionMutationsService: Effect.Effect<
  SessionMutationsService,
  never,
  | SqlClient.SqlClient
  | EventStore
  | EventPublisher
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | RelationshipStorage
  | SessionOperationStorage
  | SessionRuntime
  | AgentLoopSessionGovernance
  | GentPlatform
  | ExtensionRegistry
> = Effect.gen(function* () {
  const storageTransaction = yield* makeStorageTransaction
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const messageStorage = yield* MessageStorage
  const relationshipStorage = yield* RelationshipStorage
  const sessionOperationStorage = yield* SessionOperationStorage

  /**
   * Run one mutation once per request id. A retry replays the receipt; the
   * receipt is written in the same transaction as the work, and checked again
   * inside it so two concurrent retries cannot both do the work. `admit`
   * runs before the transaction and only when no receipt exists: a check
   * that must not hold the write lock, and that a replay must not repeat,
   * because the receipt already answers the retry.
   */
  const eventPublisher = yield* EventPublisher
  const once = <A, E, R>(
    operation: DurableOperation<A>,
    { requestId }: { readonly requestId?: RequestId },
    subject: (result: A) => { readonly sessionId: SessionId; readonly branchId: BranchId },
    work: Effect.Effect<{ readonly envelope: EventEnvelope; readonly result: A }, E, R>,
    admit: Effect.Effect<void, E, R> = Effect.void,
  ): Effect.Effect<{ readonly result: A; readonly fresh: boolean }, E | StorageError, R> =>
    Effect.gen(function* () {
      if (!Predicate.isUndefined(requestId)) {
        const existing = yield* sessionOperationStorage.getReceipt(operation, requestId)
        if (!Predicate.isUndefined(existing)) return { result: existing, fresh: false }
      }
      yield* admit
      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          if (!Predicate.isUndefined(requestId)) {
            const existing = yield* sessionOperationStorage.getReceipt(operation, requestId)
            if (!Predicate.isUndefined(existing)) {
              return { result: existing, envelope: Option.none<EventEnvelope>() }
            }
          }
          const committed = yield* work
          if (!Predicate.isUndefined(requestId)) {
            yield* sessionOperationStorage.saveReceipt(
              operation,
              requestId,
              committed.result,
              subject(committed.result),
            )
          }
          return { result: committed.result, envelope: Option.some(committed.envelope) }
        }),
      )
      if (Option.isNone(committed.envelope)) return { result: committed.result, fresh: false }
      yield* eventPublisher.deliver(committed.envelope.value)
      return { result: committed.result, fresh: true }
    })
  const platform = yield* GentPlatform
  const sessionRuntime = yield* SessionRuntime
  const governance = yield* AgentLoopSessionGovernance
  const eventStore = yield* EventStore

  /**
   * Run `mutation` (its reads and its writes) in one storage transaction and
   * append the events it returns there; deliver them after commit.
   */
  const transactWithEvents = <A, E, R>(
    mutation: Effect.Effect<
      { readonly result: A; readonly events: ReadonlyArray<AgentEvent> },
      E,
      R
    >,
  ): Effect.Effect<A, E | EventStoreError | StorageError, R> =>
    Effect.gen(function* () {
      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          const { result, events } = yield* mutation
          const envelopes: Array<EventEnvelope> = []
          for (const event of events) envelopes.push(yield* eventPublisher.append(event))
          return { result, envelopes }
        }),
      )
      for (const envelope of committed.envelopes) yield* eventPublisher.deliver(envelope)
      return committed.result
    })

  const collectSessionTreeIds = Effect.fn("SessionMutations.collectSessionTreeIds")(function* (
    rootSessionId: SessionId,
  ) {
    const sessionIds: SessionId[] = []
    const queue: SessionId[] = [rootSessionId]
    const seen = new Set<SessionId>()
    let index = 0
    // Same rule as the durable delete: a handoff that continues the deleted
    // session's thread survives, so its runtime is not stopped.
    const rootThread = (yield* sessionStorage.getSession(rootSessionId))?.threadId

    while (index < queue.length) {
      const sessionId = queue[index]
      index += 1
      if (Predicate.isUndefined(sessionId) || seen.has(sessionId)) continue
      seen.add(sessionId)
      sessionIds.push(sessionId)
      const children = yield* relationshipStorage.getChildSessions(sessionId)
      for (const child of children) {
        if (Predicate.isNotUndefined(rootThread) && child.threadId === rootThread) continue
        queue.push(child.id)
      }
    }

    return sessionIds
  })

  const cleanupSessionRuntimeStateForMutation = (sessionId: SessionId) =>
    sessionRuntime.terminateSession(sessionId).pipe(Effect.orDie)
  const restoreSessionRuntimeStateForMutation = (sessionId: SessionId) =>
    CurrentWorkspaceId.pipe(
      Effect.flatMap((workspaceId) => governance.clearTerminated(workspaceId, sessionId)),
      Effect.orDie,
    )
  const forgetDeletedSessionRuntimeStateForMutation = (sessionId: SessionId) =>
    eventStore.removeSession(sessionId)

  const deleteSessionCascade = Effect.fn("SessionMutations.deleteSessionCascade")(function* (
    sessionId: SessionId,
  ) {
    // Pre-collect is the best effort set we can tombstone BEFORE the durable
    // delete — so their runtimes stop accepting work while the tx runs. The
    // durable delete returns the authoritative set (the same rows the cascade
    // touched, collected inside its own tx) which we then use for the final
    // cleanup pass. Any descendant created between pre-collect and the tx is
    // included in the authoritative set and cleaned up here too.
    const preTombstoned = yield* collectSessionTreeIds(sessionId)
    yield* Effect.forEach(preTombstoned, cleanupSessionRuntimeStateForMutation, { discard: true })
    const cascadedIds = yield* sessionStorage.deleteSession(sessionId).pipe(
      // On failure we only restore `preTombstoned`: descendants created after pre-collect
      // were never tombstoned here, so there's no runtime state for them to "restore" to.
      Effect.onError(() =>
        Effect.forEach(preTombstoned, restoreSessionRuntimeStateForMutation, { discard: true }),
      ),
    )
    const preSet = new Set(preTombstoned)
    const postDeleteOnly = cascadedIds.filter((id) => !preSet.has(id))
    yield* Effect.forEach(postDeleteOnly, cleanupSessionRuntimeStateForMutation, { discard: true })
    yield* Effect.forEach(cascadedIds, forgetDeletedSessionRuntimeStateForMutation, {
      discard: true,
    })
    yield* Effect.forEach(
      cascadedIds,
      (deletedSessionId) =>
        Effect.logInfo("session.deleted").pipe(
          Effect.annotateLogs({ sessionId: deletedSessionId }),
        ),
      { discard: true },
    )
  })

  const sendInitialPrompt = Effect.fn("SessionMutations.sendInitialPrompt")(function* (
    operation: StoredCreateSessionResult,
    requestId: Option.Option<string>,
  ) {
    if (Predicate.isUndefined(operation.initialPrompt) || operation.initialPrompt.length === 0)
      return
    let message: SendUserMessagePayload = {
      sessionId: operation.sessionId,
      branchId: operation.branchId,
      content: operation.initialPrompt,
      metadata: clientMetadata(),
    }
    if (Option.isSome(requestId)) {
      message = { ...message, requestId: `session.create:${requestId.value}:initial` }
    }
    yield* sessionRuntime.sendUserMessage(message)
  })

  /**
   * An admission that names nothing is no admission. Stored as `{}`, it would
   * also stop a handoff from inheriting its parent's.
   */
  const requestedAdmission = (
    admission: CreateSessionInput["admission"],
  ): CreateSessionInput["admission"] =>
    Option.fromUndefinedOr(admission).pipe(
      Option.filter((value) => !Object.values(value).every(Predicate.isUndefined)),
      Option.getOrUndefined,
    )

  /**
   * Check the parent a create names and admit the child's depth. Returns the
   * thread the new session joins: the parent's for a handoff
   * (`continueThread`), none otherwise, so storage starts a new one. A handoff
   * also keeps the parent's admission unless the create names its own: it
   * continues the same work as the same agent.
   */
  const admitParent = Effect.fn("SessionMutations.admitParent")(function* (
    input: CreateSessionInput,
  ) {
    const admission = requestedAdmission(input.admission)
    if (Predicate.isUndefined(input.parentSessionId)) {
      if (!Predicate.isUndefined(input.parentBranchId)) {
        return yield* new NotFoundError({ message: "parentBranchId requires parentSessionId" })
      }
      if (input.continueThread === true) {
        return yield* new NotFoundError({ message: "continueThread requires parentSessionId" })
      }
      return { threadId: Option.none<SessionId>(), admission }
    }
    const parentSessionId = input.parentSessionId
    const parent = yield* sessionStorage.getSession(parentSessionId)
    if (Predicate.isUndefined(parent)) {
      return yield* new NotFoundError({
        message: `Parent session not found: ${parentSessionId}`,
      })
    }
    // A handoff continues the parent's thread at the parent's spawn depth;
    // only a spawn adds a level.
    if (input.continueThread !== true) {
      yield* admitChildSessionDepth(parentSessionId).pipe(
        Effect.provideService(RelationshipStorage, relationshipStorage),
      )
    }
    if (!Predicate.isUndefined(input.parentBranchId)) {
      const parentBranch = yield* branchStorage.getBranch(input.parentBranchId)
      if (Predicate.isUndefined(parentBranch) || parentBranch.sessionId !== parentSessionId) {
        return yield* new NotFoundError({
          message: `Parent branch not found in parent session: ${input.parentBranchId}`,
        })
      }
    }
    if (input.continueThread !== true) {
      return { threadId: Option.none<SessionId>(), admission }
    }
    return {
      threadId: Option.some(sessionThread(parent)),
      admission: admission ?? parent.admission,
    }
  })

  const launchRegistry = yield* ExtensionRegistry
  const profileCache = yield* Effect.serviceOption(SessionProfileCache)

  /**
   * A session's agent names every turn it runs, and no verb changes it, so
   * the agent the session will store must be one its own cwd's profile
   * knows. That is the named agent, or for a handoff the parent's agent,
   * which it inherits: a handoff can move to a project that has no such
   * agent. The check resolves a profile, so it runs outside the storage
   * transaction; `admitParent` checks the parent again inside it.
   */
  const admitAgent = Effect.fn("SessionMutations.admitAgent")(function* (
    input: CreateSessionInput,
  ) {
    const inherited = Effect.gen(function* () {
      if (input.continueThread !== true || Predicate.isUndefined(input.parentSessionId)) {
        return Option.none<AgentName>()
      }
      const parent = yield* sessionStorage.getSession(input.parentSessionId)
      return Option.fromUndefinedOr(parent?.admission?.agent)
    })
    // A create that names an admission stores it, so its agent is the one.
    const effective = yield* Option.match(
      Option.fromUndefinedOr(requestedAdmission(input.admission)),
      {
        onNone: () => inherited,
        onSome: (admission) => Effect.succeed(Option.fromUndefinedOr(admission.agent)),
      },
    )
    if (Option.isNone(effective)) return
    const agent = effective.value
    const registry = yield* resolveRegistryForCwd(Option.fromUndefinedOr(input.cwd)).pipe(
      // The agent roster is resolved data; the lease ends with the read.
      Effect.scoped,
      Effect.provideService(ExtensionRegistry, launchRegistry),
      // The profile cache joins the context only when the server wired one.
      Effect.updateContext((context: Context.Context<never>) =>
        Option.match(profileCache, {
          onNone: () => context,
          onSome: (cache) => Context.add(context, SessionProfileCache, cache),
        }),
      ),
    )
    if (registry.getResolved().agents.has(agent)) return
    return yield* new NotFoundError({ message: `Unknown agent: ${agent}` })
  })

  const createSession = Effect.fn("SessionMutations.createSession")(function* (
    input: CreateSessionInput,
  ) {
    const committed = yield* once(
      DurableOperations.createSession,
      input,
      (result) => result,
      Effect.gen(function* () {
        const sessionId = SessionId.make(yield* platform.randomId)
        const { threadId, admission } = yield* admitParent(input)

        const branchId = BranchId.make(yield* platform.randomId)
        const now = yield* DateTime.nowAsDate
        const name = input.name ?? "New Chat"
        // A handoff joins its parent's thread. Every other create, a spawned
        // child included, starts its own: storage defaults the thread to the
        // session id.
        const session = new Session({
          id: sessionId,
          name,
          cwd: input.cwd,
          activeBranchId: branchId,
          parentSessionId: input.parentSessionId,
          parentBranchId: input.parentBranchId,
          threadId: Option.getOrUndefined(threadId),
          admission,
          modelId: input.modelId,
          reasoningLevel: input.reasoningLevel,
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: branchId,
          sessionId,
          createdAt: now,
        })

        yield* sessionStorage.createSession(session)
        yield* branchStorage.createBranch(branch)
        // An inheriting session starts from what the source's model sees now:
        // the current context window, with hidden rows out, as in that
        // branch's own turn. A tool call still running in the source (a fork
        // made from inside `delegate.start`) is left out with its step. The
        // rows get fresh ids, so a copied window marker's anchor never
        // resolves; that is harmless, because the copy already is the window.
        if (!Predicate.isUndefined(input.historyBranchId)) {
          const source = yield* branchStorage.getBranch(input.historyBranchId)
          if (Predicate.isUndefined(source)) {
            return yield* new NotFoundError({
              message: `History branch not found: ${input.historyBranchId}`,
            })
          }
          const history = settledMessages(
            messagesInCurrentWindow(yield* messageStorage.listMessages(input.historyBranchId)),
          )
          for (const message of history) {
            if (message.metadata?.hidden === true) continue
            yield* messageStorage.createMessage(
              copyMessageToBranch(message, {
                id: MessageId.make(yield* platform.randomId),
                sessionId,
                branchId,
              }),
            )
          }
        }
        const envelope = yield* eventPublisher.append(SessionStarted.make({ sessionId, branchId }))
        const result: StoredCreateSessionResult = {
          sessionId,
          branchId,
          name,
          initialPrompt: input.initialPrompt,
        }
        return { envelope, result }
      }),
      admitAgent(input),
    )
    if (committed.fresh) {
      yield* Effect.logInfo("session.created").pipe(
        Effect.annotateLogs({
          sessionId: committed.result.sessionId,
          branchId: committed.result.branchId,
          requestId: input.requestId,
        }),
      )
    }

    yield* sendInitialPrompt(committed.result, Option.fromUndefinedOr(input.requestId))
    return createSessionResult(committed.result)
  })

  const createSessionBranch = Effect.fn("SessionMutations.createSessionBranch")(function* (
    input: CreateBranchParams,
  ) {
    const committed = yield* once(
      DurableOperations.createBranch,
      input,
      (result) => ({ sessionId: input.sessionId, branchId: result.branchId }),
      Effect.gen(function* () {
        const branch = new Branch({
          id: BranchId.make(yield* platform.randomId),
          sessionId: input.sessionId,
          name: input.name,
          createdAt: yield* DateTime.nowAsDate,
        })
        yield* branchStorage.createBranch(branch)
        const envelope = yield* eventPublisher.append(
          BranchCreated.make({
            sessionId: branch.sessionId,
            branchId: branch.id,
            parentBranchId: branch.parentBranchId,
          }),
        )
        const result: StoredBranchResult = { branchId: branch.id }
        return { envelope, result }
      }),
    )
    return committed.result
  })

  const forkSessionBranch = Effect.fn("SessionMutations.forkSessionBranch")(function* (
    input: ForkBranchParams,
  ) {
    const committed = yield* once(
      DurableOperations.forkBranch,
      input,
      (result) => ({ sessionId: input.sessionId, branchId: result.branchId }),
      Effect.gen(function* () {
        const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
        if (Predicate.isUndefined(fromBranch) || fromBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "Branch not found" })
        }

        const messages = yield* messageStorage.listMessages(input.fromBranchId)
        const targetIndex = messages.findIndex((message) => message.id === input.atMessageId)
        if (targetIndex === -1) {
          return yield* new NotFoundError({
            message: "Message not found in branch",
          })
        }

        const branch = new Branch({
          id: BranchId.make(yield* platform.randomId),
          sessionId: input.sessionId,
          parentBranchId: input.fromBranchId,
          parentMessageId: input.atMessageId,
          name: input.name,
          createdAt: yield* DateTime.nowAsDate,
        })
        yield* branchStorage.createBranch(branch)
        // A fork point inside a tool step would copy a call without its
        // result, and the new branch could never project a turn.
        for (const message of settledMessages(messages.slice(0, targetIndex + 1))) {
          yield* messageStorage.createMessage(
            copyMessageToBranch(message, {
              id: MessageId.make(yield* platform.randomId),
              branchId: branch.id,
            }),
          )
        }
        const envelope = yield* eventPublisher.append(
          BranchCreated.make({
            sessionId: branch.sessionId,
            branchId: branch.id,
            parentBranchId: branch.parentBranchId,
            parentMessageId: branch.parentMessageId,
          }),
        )
        const result: StoredBranchResult = { branchId: branch.id }
        return { envelope, result }
      }),
    )
    return committed.result
  })

  const switchActiveBranch = Effect.fn("SessionMutations.switchActiveBranch")(function* (
    input: SwitchBranchParams,
  ) {
    yield* once(
      DurableOperations.switchBranch,
      input,
      (result) => ({ sessionId: result.sessionId, branchId: result.toBranchId }),
      Effect.gen(function* () {
        const session = yield* sessionStorage.getSession(input.sessionId)
        if (Predicate.isUndefined(session)) {
          return yield* new NotFoundError({
            message: "Current session not found",
          })
        }
        const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
        if (Predicate.isUndefined(fromBranch) || fromBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({
            message: `Branch "${input.fromBranchId}" not found in current session`,
          })
        }
        const toBranch = yield* branchStorage.getBranch(input.toBranchId)
        if (Predicate.isUndefined(toBranch) || toBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({
            message: `Branch "${input.toBranchId}" not found in current session`,
          })
        }
        yield* sessionStorage.setActiveBranch(
          input.sessionId,
          input.toBranchId,
          yield* DateTime.nowAsDate,
        )
        const envelope = yield* eventPublisher.append(
          BranchSwitched.make({
            sessionId: input.sessionId,
            fromBranchId: input.fromBranchId,
            toBranchId: input.toBranchId,
          }),
        )
        const result: StoredSwitchBranchResult = {
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          toBranchId: input.toBranchId,
        }
        return { envelope, result }
      }),
    )
  })

  // ── requestId dedup ──
  //
  // Clients generate a `requestId` per mutation so a WS-level retry after an
  // ambiguous failure converges on one durable outcome. Each body also checks
  // the durable operation row, which owns restart/retry correctness; the
  // in-memory cache only collapses concurrent same-process fibers.
  //
  // Dedup is *concurrency-safe*: `RpcServer.layerHttp` runs with
  // `concurrency: "unbounded"` and the client has `retryTransientErrors: true`,
  // so the same requestId can land on two fibers in parallel. `Cache`
  // collapses concurrent same-key lookups via an internal Deferred so the
  // second fiber awaits the first's outcome.
  const keyOf = (input: { readonly requestId?: string }) => Option.fromUndefinedOr(input.requestId)
  const dedupCreateSession = yield* makeRequestDeduper<
    CreateSessionInput,
    CreateSessionResult,
    SessionMutationError | SessionRuntimeError
  >({ body: createSession, keyOf })
  const dedupCreateSessionBranch = yield* makeRequestDeduper<
    CreateBranchParams,
    StoredBranchResult,
    SessionMutationError
  >({ body: createSessionBranch, keyOf })
  const dedupForkSessionBranch = yield* makeRequestDeduper<
    ForkBranchParams,
    StoredBranchResult,
    SessionMutationError
  >({ body: forkSessionBranch, keyOf })
  const dedupSwitchActiveBranch = yield* makeRequestDeduper<
    SwitchBranchParams,
    void,
    SessionMutationError
  >({ body: switchActiveBranch, keyOf })

  return {
    createSession: dedupCreateSession,
    createSessionBranch: dedupCreateSessionBranch,
    forkSessionBranch: dedupForkSessionBranch,
    switchActiveBranch: dedupSwitchActiveBranch,

    renameSession: Effect.fn("SessionMutations.renameSession")(function* (input) {
      const trimmed = input.name.trim().slice(0, 80)
      if (trimmed.length === 0) return { renamed: false }
      const unchanged: RenameSessionResult = { renamed: false }
      return yield* transactWithEvents(
        Effect.gen(function* () {
          const session = yield* sessionStorage.getSession(input.sessionId)
          if (Predicate.isUndefined(session) || session.name === trimmed) {
            return { result: unchanged, events: [] }
          }
          yield* sessionStorage.renameSession(input.sessionId, trimmed, yield* DateTime.nowAsDate)
          return {
            result: { renamed: true, name: trimmed },
            events: [SessionNameUpdated.make({ sessionId: input.sessionId, name: trimmed })],
          }
        }),
      )
    }),

    deleteSession: Effect.fn("SessionMutations.deleteSession")(function* (sessionId) {
      yield* deleteSessionCascade(sessionId)
    }),

    updateSettings: Effect.fn("SessionMutations.updateSettings")(function* (input) {
      const settings = { modelId: input.modelId, reasoningLevel: input.reasoningLevel }
      // The model-change notice is a branch write; the loop owns it and
      // writes it at the next step boundary (turn.ts `noticeModelChange`).
      return yield* transactWithEvents(
        Effect.gen(function* () {
          const session = yield* sessionStorage.getSession(input.sessionId)
          if (Predicate.isUndefined(session)) {
            return yield* new NotFoundError({ message: "Session not found" })
          }
          yield* sessionStorage.updateSessionSettings(
            input.sessionId,
            settings,
            yield* DateTime.nowAsDate,
          )
          return {
            result: settings,
            events: [SessionSettingsUpdated.make({ sessionId: input.sessionId, ...settings })],
          }
        }),
      )
    }),
  } satisfies SessionMutationsService
})

export const SessionMutationsLive = Layer.effect(SessionMutations, makeSessionMutationsService)

// ── rpc-handlers ────────────────────────────────────────────────────────────

/**
 * The registry serving a cwd: its profile's when a profile cache is wired, else
 * the launch registry. The caller's scope holds the profile's lease.
 */
const resolveRegistryForCwd = Effect.fn("SessionQueries.resolveRegistryForCwd")(function* (
  cwd: Option.Option<string>,
) {
  const extensionRegistry = yield* ExtensionRegistry
  const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
  if (Option.isNone(cwd) || Option.isNone(profileCacheOpt)) return extensionRegistry
  const profile = yield* profileCacheOpt.value.resolve(cwd.value)
  return profile.registryService
})

/** The one read the client hydrates from: persisted conversation plus live runtime state. */
export const getSessionSnapshot = Effect.fn("SessionQueries.getSessionSnapshot")(function* (
  input: GetSessionSnapshotInput,
) {
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const messageStorage = yield* MessageStorage
  const eventStorage = yield* EventStorage
  const storageTransaction = yield* makeStorageTransaction
  const sessionRuntime = yield* SessionRuntime
  const session = yield* sessionStorage.getSession(input.sessionId)
  if (Predicate.isUndefined(session)) {
    return yield* new NotFoundError({ message: "Session not found" })
  }
  const branch = yield* branchStorage.getBranch(input.branchId)
  if (Predicate.isUndefined(branch) || branch.sessionId !== input.sessionId) {
    return yield* new NotFoundError({ message: "Branch not found" })
  }

  const snapshotState = yield* storageTransaction(
    Effect.gen(function* () {
      const messages = yield* messageStorage.listMessages(input.branchId)
      const events = yield* eventStorage
        .listEvents({ sessionId: input.sessionId, branchId: input.branchId })
        .pipe(
          Effect.catchTag(
            "EventDecodeError",
            (cause) =>
              new InvalidStateError({ message: `Failed to read session events: ${cause.message}` }),
          ),
        )
      const lastEventId = yield* eventStorage.getLatestEventId({
        sessionId: input.sessionId,
        branchId: input.branchId,
      })
      return {
        projectedMessages: projectMessagesWithToolInteractions(messages, toolCallReceipts(events)),
        lastEventId,
        // The same read answers the HUD totals: one branch log, folded once.
        metrics: foldSessionMetrics(events),
      }
    }),
  )

  const runtime = yield* sessionRuntime.getState(input).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidStateError({
          message: `Failed to read session runtime state: ${cause.message}`,
        }),
    ),
  )

  // The footer shows what the next turn would use; resolving it here keeps
  // the precedence (session > config > agent) in one place with the turn.
  // The agent roster is resolved data; the lease ends with the read.
  const registry = yield* resolveRegistryForCwd(Option.fromUndefinedOr(session.cwd)).pipe(
    Effect.scoped,
  )
  const configService = yield* ConfigService
  const config = yield* configService.get(session.cwd)
  const agent = sessionAgentDefinition({
    agents: [...registry.getResolved().agents.values()],
    admission: Option.fromUndefinedOr(session.admission),
    configAgents: Option.fromUndefinedOr(config.agents),
  })
  const settings = resolveSessionSettings(agent.definition, session)

  // Extension state is no longer hydrated through the session snapshot —
  // clients call the extension's typed `client.extension.request(...)` on
  // mount and subscribe to `ExtensionStateChanged` events for refetch
  // signals. The privileged out-of-band UI snapshot channel is gone.

  return new SessionSnapshot({
    sessionId: input.sessionId,
    branchId: input.branchId,
    name: session.name,
    messages: snapshotState.projectedMessages,
    lastEventId: Option.getOrNull(Option.fromUndefinedOr(snapshotState.lastEventId)),
    modelId: session.modelId,
    reasoningLevel: session.reasoningLevel,
    agent: agent.name,
    resolvedModelId: settings.modelId,
    resolvedReasoningLevel: Option.getOrUndefined(settings.reasoningLevel),
    runtime,
    metrics: snapshotState.metrics,
  })
})

/** Resolve the pending interaction on a branch and wake its loop. */
const respondInteraction = Effect.fn("InteractionCommands.respond")(function* (
  input: RespondInteractionInput,
) {
  const approvalService = yield* ApprovalService
  const sessionRuntime = yield* SessionRuntime
  const eventPublisher = yield* EventPublisher
  yield* resolveExistingSessionBranch({
    sessionId: input.sessionId,
    branchId: input.branchId,
  })

  const decision = {
    approved: input.approved,
    notes: input.notes,
    ...omitUndefined({ editedContent: input.editedContent }),
  }
  // 1. Store resolution durably so re-entering present() finds it. The first
  //    answer wins: the same answer again is a retried reply; a different one
  //    fails with a conflict. A request the branch does not show and that
  //    keeps no answer is a mismatch.
  const first = yield* approvalService.storeResolution(input, input.requestId, decision)
  // A retried reply whose answer is still stored and not taken may follow a
  // first attempt that failed after the store, so it wakes the loop and
  // publishes again: the wake is idempotent by request id. Once the call
  // took the answer, a retry has nothing left to do.
  if (!first && !(yield* approvalService.answered(input.requestId))) return
  // 2. Wake the machine. present() marks the row resolved only when the
  //    tool consumes the durable decision.
  yield* sessionRuntime.respondInteraction({
    sessionId: input.sessionId,
    branchId: input.branchId,
    requestId: input.requestId,
  })
  // 3. Publish resolution event
  yield* eventPublisher
    .publish(
      InteractionResolved.make({
        sessionId: input.sessionId,
        branchId: input.branchId,
        requestId: input.requestId,
        ...decision,
      }),
    )
    .pipe(Effect.catchEager(() => Effect.void))
})

// ============================================================================
// Handler helpers (yield Tags inside; no service-bag threading)
// ============================================================================

type BranchPayload = { readonly branchId: BranchId }
type OptionalSessionPayload = { readonly sessionId?: SessionId }
type SessionIdPayload = { readonly sessionId: SessionId }

const watchRuntimeStream = ({ sessionId, branchId }: QueueTarget) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sessionRuntime = yield* SessionRuntime
      const stateStream = yield* sessionRuntime.watchState({ sessionId, branchId })
      yield* Effect.logInfo("watchRuntime.open").pipe(Effect.annotateLogs({ sessionId, branchId }))
      return stateStream.pipe(
        Stream.ensuring(
          Effect.logInfo("watchRuntime.close").pipe(Effect.annotateLogs({ sessionId, branchId })),
        ),
      )
    }),
  )

const authPersistenceError = (
  action: "read" | "set" | "delete",
  provider: string,
  cause: unknown,
): ProviderAuthError =>
  new ProviderAuthError({
    message: `Failed to ${action} auth for provider "${provider}"`,
    cause,
  })

/** Run one RPC inside its wide-event boundary and record the fields its result names. */
const rpc = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  fields: (result: A) => Parameters<typeof WideEvent.set>[0],
  requestId?: RequestId,
) =>
  effect.pipe(
    Effect.tap((result) => WideEvent.set(fields(result))),
    withWideEvent(WideEventBoundary.rpc(method, { requestId })),
  )

// ============================================================================
// RPC Handlers Layer
// ============================================================================

const RpcHandlers = GentRpcs.toLayer(
  Effect.gen(function* () {
    const mutations = yield* SessionMutations
    const eventStore = yield* EventStore
    const configService = yield* ConfigService
    const sessionRuntime = yield* SessionRuntime
    const authStore = yield* Auth
    const catalogRecord = yield* ModelCatalogRecord
    const providerAuth = yield* ProviderAuth
    const extensionRegistry = yield* ExtensionRegistry
    const sessionStorage = yield* SessionStorage
    const relationshipStorage = yield* RelationshipStorage
    const branchStorage = yield* BranchStorage
    const messageStorage = yield* MessageStorage
    const connectionTrackerOpt = yield* Effect.serviceOption(ConnectionTracker)
    const serverIdentity = yield* ServerIdentity
    // Touching these Tags at layer-build keeps their requirements visible on the
    // RpcHandlers layer. RpcGroup.toLayer erases handler-residual R, so Tags only
    // yielded inside returned handler Effects would otherwise become deferred
    // request-time defects instead of layer-build failures.
    const runtimeEnvironment = yield* RuntimeEnvironment
    const pathService = yield* Path.Path

    // `message.send` has no durable operation row; the runtime keys its actor
    // command on `requestId`. This cache collapses concurrent same-requestId
    // fibers (unbounded RPC concurrency + client transport retries) so the
    // runtime sees one dispatch per request id.
    const sendMessage = yield* makeRequestDeduper<SendMessageInput, void, SessionRuntimeError>({
      body: (input) =>
        sessionRuntime
          .sendUserMessage({
            sessionId: input.sessionId,
            branchId: input.branchId,
            content: input.content,
            requestId: input.requestId,
            metadata: clientMetadata(),
          })
          .pipe(
            Effect.tap(() =>
              Effect.logInfo("session.messageSent").pipe(
                Effect.annotateLogs({
                  sessionId: input.sessionId,
                  branchId: input.branchId,
                  requestId: input.requestId,
                }),
              ),
            ),
          ),
      keyOf: (input) => Option.fromUndefinedOr(input.requestId),
    })

    const loadSession = (sessionId: string) =>
      sessionStorage.getSession(SessionId.make(sessionId)).pipe(
        Effect.map(Option.fromUndefinedOr),
        Effect.orElseSucceed(() => Option.none()),
      )

    /** The stored cwd of a session; none without a session or a stored cwd. */
    const sessionCwd = (sessionId: Option.Option<string>): Effect.Effect<Option.Option<string>> =>
      Option.match(sessionId, {
        onNone: () => Effect.succeedNone,
        onSome: (id) =>
          loadSession(id).pipe(
            Effect.map((session) =>
              Option.flatMap(session, (value) => Option.fromUndefinedOr(value.cwd)),
            ),
          ),
      })

    // The caller's scope holds the profile's lease while it reads the registry.
    const resolveSessionRegistry = (
      sessionId: Option.Option<string>,
    ): Effect.Effect<ExtensionRegistryService, never, Scope.Scope> =>
      sessionCwd(sessionId).pipe(
        Effect.flatMap(resolveRegistryForCwd),
        Effect.provideService(ExtensionRegistry, extensionRegistry),
      )

    return {
      // ----------------------------------------------------------------------
      // Session / branch / message / queue / interaction
      // ----------------------------------------------------------------------
      "session.create": (input: CreateSessionInput) =>
        rpc(
          "session.create",
          mutations.createSession(input),
          (result) => ({ sessionId: result.sessionId }),
          input.requestId,
        ),

      "session.list": () => sessionStorage.listSessions,

      "session.thread": ({ sessionId }: SessionIdPayload) =>
        relationshipStorage.getThreadSessions(sessionId),

      "session.get": ({ sessionId }: SessionIdPayload) =>
        sessionStorage
          .getSession(sessionId)
          .pipe(Effect.map(Option.fromUndefinedOr), Effect.map(Option.getOrNull)),

      "session.delete": ({ sessionId }: SessionIdPayload) =>
        rpc("session.delete", mutations.deleteSession(sessionId), () => ({ sessionId })),

      "session.getSnapshot": (input: GetSessionSnapshotInput) =>
        rpc("session.getSnapshot", getSessionSnapshot(input), () => input),

      "session.updateSettings": (input: UpdateSessionSettingsInput) =>
        rpc("session.updateSettings", mutations.updateSettings(input), () => input),

      "session.events": ({ sessionId, branchId, after }: SubscribeEventsInput) => {
        const subscription = { sessionId, branchId, synchronize: true }
        if (!Predicate.isUndefined(after))
          Object.assign(subscription, { after: EventId.make(after) })
        return eventStore.subscribe(subscription)
      },

      "session.watchRuntime": (input: QueueTarget) => watchRuntimeStream(input),

      "branch.list": ({ sessionId }: SessionIdPayload) => branchStorage.listBranches(sessionId),

      "branch.create": (input: CreateBranchInput) =>
        rpc(
          "branch.create",
          mutations.createSessionBranch(input),
          (result) => ({ sessionId: input.sessionId, branchId: result.branchId }),
          input.requestId,
        ),

      "branch.getTree": ({ sessionId }: SessionIdPayload) => getBranchTree(sessionId),

      "branch.switch": (input: SwitchBranchInput) =>
        rpc(
          "branch.switch",
          mutations.switchActiveBranch(input),
          () => ({
            sessionId: input.sessionId,
            fromBranchId: input.fromBranchId,
            toBranchId: input.toBranchId,
          }),
          input.requestId,
        ),

      "branch.fork": (input: ForkBranchInput) =>
        rpc(
          "branch.fork",
          mutations.forkSessionBranch(input),
          (result) => ({
            sessionId: input.sessionId,
            fromBranchId: input.fromBranchId,
            branchId: result.branchId,
          }),
          input.requestId,
        ),

      "message.send": (input: SendMessageInput) =>
        rpc(
          "message.send",
          sendMessage(input),
          () => ({ sessionId: input.sessionId, branchId: input.branchId }),
          input.requestId,
        ),

      "message.list": ({ branchId }: BranchPayload) => messageStorage.listMessages(branchId),

      "steer.command": ({ command }: { readonly command: TransportSteerCommand }) =>
        rpc("steer.command", sessionRuntime.steer(clientSteer(command)), () => ({
          sessionId: command.sessionId,
          branchId: command.branchId,
          steerTag: command._tag,
        })),

      "queue.drain": ({ sessionId, branchId, requestId }: QueueDrainInput) =>
        rpc(
          "queue.drain",
          sessionRuntime
            .drainQueuedMessages({ sessionId, branchId, requestId })
            .pipe(Effect.withSpan("SessionRuntime.drainQueuedMessages")),
          () => ({ sessionId, branchId }),
          requestId,
        ),

      "queue.get": (input: QueueTarget) =>
        rpc(
          "queue.get",
          sessionRuntime
            .getQueuedMessages(input)
            .pipe(Effect.withSpan("SessionQueries.getQueuedMessages")),
          () => input,
        ),

      "interaction.respondInteraction": (input: RespondInteractionInput) =>
        rpc("interaction.respondInteraction", respondInteraction(input), () => ({
          sessionId: input.sessionId,
          branchId: input.branchId,
          requestId: input.requestId,
          approved: input.approved,
        })),

      // ----------------------------------------------------------------------
      // Config / driver / model / auth
      // ----------------------------------------------------------------------
      // The catalog and the drivers are the requesting session's profile:
      // its project drivers count, its disabled extensions do not.
      "model.list": ({ sessionId }: OptionalSessionPayload) =>
        Effect.gen(function* () {
          const registry = yield* resolveSessionRegistry(Option.fromUndefinedOr(sessionId))
          const catalog = yield* modelCatalog().pipe(
            Effect.provideService(ExtensionRegistry, registry),
            Effect.provideService(Auth, authStore),
            Effect.provideService(ModelCatalogRecord, catalogRecord),
          )
          return catalog.models
        }).pipe(Effect.scoped),

      "driver.list": ({ sessionId }: OptionalSessionPayload) =>
        Effect.gen(function* () {
          const registry = yield* resolveSessionRegistry(Option.fromUndefinedOr(sessionId))
          const resolved = registry.getResolved()
          const agents = [...resolved.agents.values()]
          const drivers = [...resolved.modelDrivers.values()].map((driver) =>
            DriverInfo.make({ id: driver.id }),
          )
          return new DriverListResult({ drivers, agents })
        }).pipe(Effect.scoped),

      "driver.set": ({ agentName, driver, sessionId }: SetDriverOverrideInput) =>
        Effect.gen(function* () {
          const registry = yield* resolveSessionRegistry(Option.fromUndefinedOr(sessionId))
          const resolved = registry.getResolved()
          if (!Predicate.isUndefined(driver.id)) {
            const found = resolved.modelDrivers.get(driver.id)
            if (Predicate.isUndefined(found)) {
              return yield* new NotFoundError({
                message: `Unknown model driver "${driver.id}"`,
              })
            }
          }
          yield* configService.setDriverOverride(agentName, driver)
        }).pipe(Effect.scoped),

      "driver.clear": ({ agentName }: ClearDriverOverrideInput) =>
        configService.clearDriverOverride(agentName),

      "auth.listProviders": ({ agentName, sessionId }: ListAuthProvidersPayload) =>
        Effect.gen(function* () {
          const session = yield* Option.match(Option.fromUndefinedOr(sessionId), {
            onNone: () => Effect.succeedNone,
            onSome: (id) =>
              sessionStorage.getSession(SessionId.make(id)).pipe(
                Effect.flatMap((found) => {
                  if (Predicate.isUndefined(found)) {
                    return Effect.fail(new NotFoundError({ message: "Session not found" }))
                  }
                  return Effect.succeedSome(found)
                }),
              ),
          })
          // The models a turn in this session would run: the session's
          // registry and config, then its model override, as the turn does.
          const registry = yield* resolveSessionRegistry(Option.fromUndefinedOr(sessionId))
          const config = yield* configService.get(
            Option.getOrUndefined(
              Option.flatMap(session, (found) => Option.fromUndefinedOr(found.cwd)),
            ),
          )
          const agents = [...registry.getResolved().agents.values()]
          const modelFor = (admission: Option.Option<SessionAdmission>) =>
            resolveSessionSettings(
              sessionAgentDefinition({
                agents,
                admission,
                configAgents: Option.fromUndefinedOr(config.agents),
              }).definition,
              Option.getOrElse(session, () => ({})),
            ).modelId
          // The session's own agent, then an agent the caller asks about.
          const modelIds = [
            modelFor(Option.flatMap(session, (found) => Option.fromUndefinedOr(found.admission))),
          ]
          if (!Predicate.isUndefined(agentName))
            modelIds.push(modelFor(Option.some({ agent: agentName })))
          return yield* listAuthProviders(modelIds).pipe(
            Effect.provideService(ExtensionRegistry, registry),
            Effect.provideService(Auth, authStore),
            Effect.mapError((error) => authPersistenceError("read", "*", error)),
          )
        }).pipe(Effect.scoped),

      "auth.setKey": ({ provider, key }: SetAuthKeyInput) =>
        authStore
          .set(provider, AuthApi.make({ type: "api", key }))
          .pipe(Effect.mapError((error) => authPersistenceError("set", provider, error))),

      "auth.deleteKey": ({ provider }: DeleteAuthKeyInput) =>
        authStore
          .remove(provider)
          .pipe(Effect.mapError((error) => authPersistenceError("delete", provider, error))),

      "auth.listMethods": () => providerAuth.listMethods,

      "auth.authorize": ({ sessionId, provider, method }: AuthorizeAuthInput) =>
        providerAuth.authorize(sessionId, provider, method).pipe(Effect.map(Option.getOrNull)),

      "auth.callback": ({
        sessionId,
        provider,
        method,
        authorizationId,
        code,
      }: CallbackAuthInput) =>
        providerAuth.callback(sessionId, provider, method, authorizationId, code),

      // ----------------------------------------------------------------------
      // Extension transport
      // ----------------------------------------------------------------------
      "extension.listStatus": ({ sessionId }: OptionalSessionPayload) =>
        Effect.gen(function* () {
          const cwd = yield* sessionCwd(Option.fromUndefinedOr(sessionId))
          const registry = yield* resolveRegistryForCwd(cwd).pipe(
            Effect.provideService(ExtensionRegistry, extensionRegistry),
          )
          const resolved = registry.getResolved()
          // Config files are read on each call, so a fixed file clears here
          // without a restart.
          const configStatuses = yield* configHealthStatuses(
            Option.getOrElse(cwd, () => runtimeEnvironment.cwd),
          ).pipe(
            Effect.provideService(ConfigService, configService),
            Effect.provideService(Path.Path, pathService),
            Effect.provideService(RuntimeEnvironment, runtimeEnvironment),
          )
          // Health reads what the last catalog run recorded. Only a profile
          // whose catalog never ran is listed here, once.
          const recorded = yield* catalogRecord.lastFailures(resolved)
          const failures = yield* Option.match(recorded, {
            onSome: Effect.succeed,
            onNone: () =>
              modelCatalog().pipe(
                Effect.provideService(ExtensionRegistry, registry),
                Effect.provideService(Auth, authStore),
                Effect.provideService(ModelCatalogRecord, catalogRecord),
                Effect.map((catalog) => catalog.failures),
              ),
          })
          return buildExtensionHealthSnapshot(
            [...resolved.extensionStatuses, ...configStatuses],
            catalogFailuresByExtension(resolved, failures),
          )
        }).pipe(Effect.scoped),

      "extension.request": ({
        sessionId,
        extensionId,
        capabilityId,
        input,
        branchId,
      }: ExtensionRpcRequestInput) =>
        Effect.gen(function* () {
          yield* WideEvent.set({
            sessionId,
            branchId,
            extensionId,
            capabilityId,
          })
          return yield* sessionRuntime
            .requestExtension({
              sessionId,
              branchId,
              extensionId,
              capabilityId,
              input,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new ExtensionProtocolError({
                    extensionId,
                    tag: capabilityId,
                    message: error.message,
                  }),
              ),
            )
        }).pipe(withWideEvent(WideEventBoundary.rpc("extension.request"))),

      "extension.listSlashCommands": ({ sessionId }: SessionIdPayload) =>
        Effect.gen(function* () {
          const registry = yield* resolveSessionRegistry(Option.fromUndefinedOr(sessionId))
          return registry.getResolved().slashCommands.map(
            (command) =>
              new SlashCommandInfo({
                name: command.name,
                displayName: command.displayName,
                description: command.description,
                category: command.category,
                keybind: command.keybind,
                extensionId: command.extensionId,
                capabilityId: command.capabilityId,
              }),
          )
        }).pipe(Effect.scoped),

      // ----------------------------------------------------------------------
      // Runtime status
      // ----------------------------------------------------------------------
      "runtime.status": () =>
        Effect.gen(function* () {
          let connectionCount = 0
          if (Option.isSome(connectionTrackerOpt)) {
            connectionCount = yield* connectionTrackerOpt.value.count
          }
          return {
            serverId: serverIdentity.serverId,
            pid: serverIdentity.pid,
            hostname: serverIdentity.hostname,
            uptime: (yield* Clock.currentTimeMillis) - serverIdentity.startedAt,
            connectionCount,
            dbPath: serverIdentity.dbPath,
            buildFingerprint: serverIdentity.buildFingerprint,
          }
        }),
    }
  }),
)

export const RpcHandlersLive = Layer.merge(RpcHandlers, WorkspaceRpcMiddleware.Live)

/**
 * A client that calls built handlers directly, with no socket in between.
 * The SDK's in-process client and the test harness both use it.
 */
export const makeInProcessClient = (
  handlerContext: Context.Context<Layer.Success<typeof RpcHandlersLive>>,
  headers: Headers.Input,
): Effect.Effect<GentNamespacedClient, never, Scope.Scope> =>
  RpcTest.makeClient(GentRpcs).pipe(
    Effect.provide(handlerContext),
    Effect.map((flat) => makeNamespacedClient(flat, headers)),
  )

// ── dependencies ────────────────────────────────────────────────────────────

interface DependencyOverrides {
  readonly authLayer?: Layer.Layer<Auth>
  readonly approvalLayer?: Layer.Layer<
    ApprovalService,
    never,
    EventPublisher | GentPlatform | InteractionStorage
  >
  readonly configServiceLayer?: Layer.Layer<ConfigService>
  readonly modelRegistryLayer?: Layer.Layer<ModelRegistry>
  readonly toolRunnerLayer?: Layer.Layer<ToolRunner>
  readonly sessionProfileCacheLayer?: Layer.Layer<SessionProfileCache>
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

/**
 * Wiring contract failure — fires only when a Layer that depends on the
 * pre-resolved base prompt sections is materialized before the resolver
 * Layer that populates that seed.
 *
 * In a correctly wired composition this is unreachable; surfacing it as
 * a typed error means the failure channel of the bootstrap layer carries
 * an explicit `BootstrapError` instead of an opaque defect.
 */
class BootstrapError extends Schema.TaggedError<BootstrapError>()("BootstrapError", {
  seed: Schema.Literals(["baseSections"]),
}) {
  override get message(): string {
    return "Base prompt sections were not initialized"
  }
}

/**
 * Where a composition root keeps its state. `Disk` names the SQLite file it
 * writes, so choosing disk persistence and naming the file are one decision.
 */
export const StateLocation = Schema.TaggedUnion({
  Disk: { dbPath: Schema.String },
  Memory: {},
})
export type StateLocation = typeof StateLocation.Type

export interface DependenciesConfig {
  cwd: string
  home: string
  platform: string
  shell?: string
  osVersion?: string
  /**
   * Directory for the on-disk auth store. One URL-encoded file per
   * provider. Defaults to `${home}/.gent/auth`.
   */
  authDirectory?: string
  /**
   * Where this deployment keeps its state. `Disk` carries the database file
   * it writes; the path travels with the mode so no root can pick disk
   * persistence and leave the location to a default.
   */
  state: StateLocation
  /** A failed extension fails the profile build. Test roots set it; production leaves one broken extension out and runs. */
  failOnExtensionFailure: boolean
  /** Language model layer override. When set, replaces the auth-backed live resolver.
   *  Must be a fully-provided layer (no requirements, no errors). */
  languageModelLayerOverride?: Layer.Layer<LanguageModel.LanguageModel, never, never>
  /** Extensions to load. Composition roots pass this in. */
  extensions: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  /**
   * The branch-tool feature this deployment ships — its migrations, storage,
   * and per-branch factory as one value. Required, not defaulted: a root that
   * ships a stateful tool surface and forgets this would get a tool that
   * fails on first use, and a default would hide that until run time. A
   * deployment whose tools are all stateless passes `noBranchTools`.
   */
  branchTools: BranchToolFeature<never>
  /** Internal composition-root knobs used by tests to preset the production root. */
  overrides?: DependencyOverrides
}

const childProcessSpawnerLive = Layer.effect(
  ProcessSpawner.ChildProcessSpawner,
  Effect.service(ProcessSpawner.ChildProcessSpawner),
)

// The platform services extension leaves yield directly: files, paths,
// processes, and ids. Re-provided here so every root must supply them.
const platformServicesLive = Layer.provideMerge(
  Layer.mergeAll(
    Layer.effect(FileSystem.FileSystem, Effect.service(FileSystem.FileSystem)),
    Layer.effect(Path.Path, Effect.service(Path.Path)),
    Layer.effect(Crypto.Crypto, Effect.service(Crypto.Crypto)),
    Layer.effect(GentPlatform, Effect.service(GentPlatform)),
  ),
  childProcessSpawnerLive,
)

const makeStorageLayer = (config: DependenciesConfig) => {
  const branchTools = config.branchTools
  if (config.state._tag === "Memory")
    return SqliteStorage.MemoryWithSql(branchTools.storage, branchTools.migrations)
  return SqliteStorage.LiveWithSql(config.state.dbPath, branchTools.storage, branchTools.migrations)
}

const makeClusterRunnerLayer = (state: StateLocation) => {
  let runnerStorage: "memory" | "sql" = "sql"
  if (state._tag === "Memory") runnerStorage = "memory"
  return SingleRunner.layer({ runnerStorage })
}

const makeModelResolverLayer = <A, E, R>(
  config: DependenciesConfig,
  authDeps: Layer.Layer<A, E, R>,
) =>
  Option.match(Option.fromUndefinedOr(config.languageModelLayerOverride), {
    onNone: () => Layer.provide(ModelResolver.Live, authDeps),
    onSome: ModelResolver.fromLanguageModel,
  })

export const createDependencies = (config: DependenciesConfig) => {
  let baseSectionsSeed = Option.none<ReadonlyArray<PromptSection>>()
  const runtimeEnvironmentLive = RuntimeEnvironment.Live({
    cwd: config.cwd,
    home: config.home,
  })

  const storageLive = makeStorageLayer(config)
  const clusterRunnerLive = makeClusterRunnerLayer(config.state)
  // Snapshots and event replay must share a cursor, including in-memory SQLite.
  const baseEventStoreLive = EventStoreLive

  // Auth lives in `~/.gent/auth/` (one URL-encoded file per provider).
  // The composition root owns FileSystem/Path; this dependency graph only
  // describes that Auth needs platform capabilities.
  const authDirectory = Option.getOrElse(
    Option.fromUndefinedOr(config.authDirectory),
    () => `${config.home}/.gent/auth`,
  )
  const authLive = config.overrides?.authLayer ?? Auth.Live(authDirectory)

  const configServiceLive =
    config.overrides?.configServiceLayer ??
    Layer.provide(ConfigService.Live, runtimeEnvironmentLive)

  // SessionProfileCache is the sole live profile owner. The launch registry
  // resolves its profile through that same cache entry instead of building a
  // startup-only resource layer beside the cache.
  const sessionProfileCacheLive =
    config.overrides?.sessionProfileCacheLayer ??
    Layer.provide(
      SessionProfileCache.Live({
        home: config.home,
        platform: config.platform,
        shell: config.shell,
        osVersion: config.osVersion,
        extensions: config.extensions,
        failOnExtensionFailure: config.failOnExtensionFailure,
      }),
      Layer.mergeAll(configServiceLive, runtimeEnvironmentLive, platformServicesLive),
    )

  const extensionRegistryLive = Layer.provideMerge(
    Layer.unwrap(
      Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        // Same derivation the client used for its `x-gent-workspace-id`
        // header; a second one here would split the workspace silently.
        const launchWorkspaceId = workspaceIdForCwd(config.cwd)
        const profile = yield* cache
          .resolve(config.cwd)
          .pipe(Effect.provideService(CurrentWorkspaceId, launchWorkspaceId))
        baseSectionsSeed = Option.some(profile.baseSections)
        // `SessionProfile.layerContext` carries dynamically acquired resource
        // services, so its type intentionally cannot enumerate every service
        // contributed by an extension. Keep the stable registry services
        // explicit at this package boundary while retaining that context at
        // runtime for extension consumers.
        return Layer.mergeAll(
          Layer.succeed(ExtensionRegistry, profile.registryService),
          Layer.succeedContext(profile.layerContext),
        )
      }),
    ),
    Layer.merge(storageLive, Layer.merge(sessionProfileCacheLive, platformServicesLive)),
  )
  const modelCatalogRecordLive = ModelCatalogRecord.Live
  const modelRegistryLive =
    config.overrides?.modelRegistryLayer ??
    Layer.provide(
      ModelRegistry.Live,
      Layer.mergeAll(extensionRegistryLive, authLive, modelCatalogRecordLive),
    )
  const authDeps = Layer.mergeAll(authLive, extensionRegistryLive)
  const providerAuthLive = Layer.provide(ProviderAuth.Live, authDeps)
  const fileLockServiceLive = FileLockService.layer

  const modelResolverLive = makeModelResolverLayer(config, authDeps)

  const eventPublisherLive = EventPublisherLive
  const eventServicesLive = Layer.provideMerge(eventPublisherLive, baseEventStoreLive)

  const baseServicesLive = Layer.provideMerge(
    Layer.mergeAll(
      // The app names the branch-tool feature it ships. The loop builds its
      // layer without knowing what it is.
      Layer.succeed(CurrentBranchToolFeature, config.branchTools),
      platformServicesLive,
      runtimeEnvironmentLive,
      clusterRunnerLive,
      eventServicesLive,
      authLive,
      providerAuthLive,
      configServiceLive,
      modelCatalogRecordLive,
      modelRegistryLive,
      extensionRegistryLive,
      fileLockServiceLive,
      AgentLoopSessionGovernance.Live,
      modelResolverLive,
      ...Option.getOrElse(Option.fromUndefinedOr(config.overrides?.extraLayers), () => []),
      FetchHttpClient.layer,
    ),
    storageLive,
  )

  // ApprovalService — single handler for all interaction types
  const approvalServiceLive = Layer.provide(
    config.overrides?.approvalLayer ?? ApprovalService.Live,
    baseServicesLive,
  )

  const toolRunnerLive =
    config.overrides?.toolRunnerLayer ??
    Layer.provide(ToolRunner.Live, Layer.merge(baseServicesLive, approvalServiceLive))

  const allDeps = Layer.mergeAll(baseServicesLive, approvalServiceLive, toolRunnerLive)

  // Recover pending interaction requests from storage by rehydrating the
  // approval presenter state. The actor mailbox owns cold turn replay; this
  // startup pass only restores the transport-facing prompt surface.
  const interactionRecoveryLive = Layer.effectDiscard(
    Effect.gen(function* () {
      const interactionStore = yield* InteractionStorage
      const approvalService = yield* ApprovalService
      const sessionRuntime = yield* SessionRuntime

      const workspaces = yield* interactionStore.listOpenWorkspaces
      for (const workspaceId of workspaces) {
        yield* Effect.gen(function* () {
          const pending = yield* interactionStore.listOpen()
          if (pending.length === 0) return

          let recovered = 0
          for (const record of pending) {
            // A row that no longer decodes stays in storage and is skipped.
            const answered = yield* approvalService.rehydrate(record).pipe(Effect.option)
            if (Option.isNone(answered)) continue
            if (answered.value) {
              yield* sessionRuntime
                .respondInteraction({
                  sessionId: record.sessionId,
                  branchId: record.branchId,
                  requestId: record.requestId,
                })
                .pipe(Effect.catchEager(() => Effect.void))
            }
            recovered++
          }

          if (recovered > 0) {
            yield* Effect.log(`Recovered ${recovered} pending interaction request(s)`)
          }
        }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
      }
    }),
  )

  const sessionRuntimeLive = Layer.provide(SessionRuntime.Client, allDeps)

  const sessionMutationsLive = Layer.provide(
    SessionMutationsLive,
    Layer.merge(allDeps, sessionRuntimeLive),
  )

  const allWithRuntime = Layer.mergeAll(allDeps, sessionMutationsLive, sessionRuntimeLive)

  const runtimeWithHandlers = Layer.provideMerge(
    Layer.unwrap(
      Effect.gen(function* () {
        if (Option.isNone(baseSectionsSeed))
          return yield* new BootstrapError({ seed: "baseSections" })
        return AgentLoopLiveActor({ baseSections: baseSectionsSeed.value })
      }),
    ),
    allWithRuntime,
  )
  return Layer.merge(
    runtimeWithHandlers,
    Layer.provide(interactionRecoveryLive, runtimeWithHandlers),
  )
}

// ── server-routes ───────────────────────────────────────────────────────────

/**
 * Reusable HTTP route assembly for gent servers.
 *
 * Used by both the standalone server (apps/server/src/main.ts) and
 * the SDK's owned-server path (Gent.server with in-process HTTP listener).
 */

// ── WebSocket lifecycle tracing ──

/**
 * Layer that registers WebSocket lifecycle tracing on the HttpRouter.
 *
 * Detects upgrade requests by the `Upgrade: websocket` header and wraps
 * them with a span + structured logs. Non-upgrade requests pass through.
 *
 * Emits:
 *   - `ws.connect` log with url + remoteAddress on open
 *   - `ws.session` span wrapping the connection lifetime
 *   - `ws.disconnect` log on close
 *
 * Also increments/decrements `ConnectionTracker` when present, so the
 * server can shut down on idle.
 */
const wsTracingLayer: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.use((router) =>
  router.addGlobalMiddleware((handler) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const upgradeHeader = request.headers["upgrade"]
      const isUpgrade = upgradeHeader?.toLowerCase() === "websocket"

      if (!isUpgrade) return yield* handler

      const trackerOpt = yield* Effect.serviceOption(ConnectionTracker)
      if (Option.isSome(trackerOpt)) yield* trackerOpt.value.increment

      yield* Effect.logInfo("ws.connect").pipe(
        Effect.annotateLogs({
          url: request.url,
          remoteAddress: request.remoteAddress ?? "unknown",
        }),
      )

      return yield* handler.pipe(
        Effect.withSpan("ws.session", {
          attributes: {
            "ws.url": request.url,
            "ws.remoteAddress": request.remoteAddress ?? "unknown",
          },
        }),
        Effect.ensuring(
          Effect.gen(function* () {
            if (Option.isSome(trackerOpt)) yield* trackerOpt.value.decrement
            yield* Effect.logInfo("ws.disconnect").pipe(
              Effect.annotateLogs({
                url: request.url,
                remoteAddress: request.remoteAddress ?? "unknown",
              }),
            )
          }),
        ),
      )
    }),
  ),
)

// ── Route Assembly ──

interface ServerRoutesConfig {
  /**
   * The identity `/_gent/identity` serves, verbatim. `startedAt` is excluded:
   * registry validation compares a stable identity, and a restart-varying
   * field would make every comparison a mismatch.
   */
  readonly identity: Omit<ServerIdentityApi, "startedAt">
}

/**
 * Build the full HTTP route layer for a gent server.
 *
 * Includes: RPC-over-WS, identity route, CORS.
 * Caller provides `coreServicesLive` containing all service dependencies.
 */
export const buildServerRoutes = <A>(
  coreServicesLive: Layer.Layer<A>,
  config: ServerRoutesConfig,
) => {
  // RPC-over-WebSocket route
  const RpcRoutes = RpcServer.layerHttp({
    group: GentRpcs,
    path: "/rpc",
  }).pipe(
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(RpcHandlersLive),
    Layer.provide(coreServicesLive),
  )

  // Identity route — used by registry validation
  const IdentityRoute = HttpRouter.add(
    "GET",
    "/_gent/identity",
    HttpServerResponse.json(config.identity),
  )

  return Layer.mergeAll(RpcRoutes, IdentityRoute).pipe(
    Layer.provide(wsTracingLayer.pipe(Layer.provide(coreServicesLive))),
    Layer.provide(HttpRouter.cors()),
  )
}
