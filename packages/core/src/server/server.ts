import {
  type Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  BranchId,
  MessageId,
  type RequestId,
  SessionId,
  CurrentWorkspaceId,
} from "../domain/ids.js"
import {
  Branch,
  type BranchTreeNode,
  copyMessageToBranch,
  DEFAULT_SESSION_NAME,
  headChars,
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
  type StoredBranchResult,
  type StoredCreateSessionResult,
  type StoredSwitchBranchResult,
} from "../storage/storage.js"
import type { StorageError } from "../domain/errors.js"
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
  type ListAuthMethodsInput,
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
  ExtensionStatusScope,
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
  SessionView,
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
import type { SqlClient } from "effect/sql"
import {
  type AgentEvent,
  BranchCreated,
  BranchSwitched,
  type EventEnvelope,
  EventId,
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
import { workspaceIdForCwd, WorkspaceRpcMiddleware } from "./workspace-rpc.js"
import {
  Auth,
  AuthApi,
  authorizeProvider,
  completeProviderAuth,
  DecisionModelResolver,
  listAuthMethods,
  listAuthProviders,
  removeSignIn,
  storeSignIn,
  ModelCatalogRecord,
  ModelRegistry,
  ModelResolver,
  modelCatalog,
} from "../runtime/provider.js"
import { ProviderAuthError } from "../domain/driver.js"
import { ConfigService, RuntimeEnvironment } from "../runtime/config.js"
import {
  ApprovalService,
  configHealthStatuses,
  ExtensionRegistry,
  type ExtensionRegistryService,
  makeExtensionHostContextProvider,
  makeExtensionHostPlatform,
  type ModelCatalogFailure,
  resolveExistingSessionBranch,
  resolveTurnProfile,
  RunOpener,
  type SessionProfile,
  SessionProfileCache,
} from "../runtime/extension-host.js"
import type { AgentName } from "../domain/agent.js"
import { foldSessionMetrics, type SendUserMessagePayload } from "../domain/agent-loop.js"
import {
  type AgentLoopTurnProfile,
  resolveSessionRoute,
  runAgentLoopTurnProfile,
  turnRegistry,
} from "../runtime/turn.js"
import { WideEvent, WideEventBoundary, withWideEvent } from "effect-wide-event"

import { omitUndefined } from "../domain/guards.js"
import { SingleRunner } from "effect/cluster"
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ChildProcessSpawner as ProcessSpawner } from "effect/process"
import { type BranchToolFeature, CurrentBranchToolFeature, ToolRunner } from "../runtime/tools.js"
import { messagesInCurrentWindow, settledMessages } from "../runtime/model-context.js"
import { RpcSerialization, RpcServer, RpcTest } from "effect/rpc"
import type { Headers } from "effect/http"

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

// ── server-identity ─────────────────────────────────────────────────────────

/**
 * What `/_gent/identity` serves, verbatim. Registry validation compares it
 * field for field, so it holds nothing that varies across a restart.
 */
interface ServerIdentityApi {
  readonly serverId: string
  readonly pid: number
  readonly hostname: string
  readonly dbPath: string
  readonly buildFingerprint: string
}

// ── session reads ───────────────────────────────────────────────────────────

type MutableBranchTreeNode = Omit<BranchTreeNode, "children"> & {
  children: MutableBranchTreeNode[]
}

const buildBranchTree = (
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

const getBranchTree = (
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

// ── session mutations ───────────────────────────────────────────────────────

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

/** How many deleted sessions' `sessionDeleted` hooks run at once. */
const SESSION_DELETED_CONCURRENCY = 8

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
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | RelationshipStorage
  | SessionOperationStorage
  | SessionRuntime
  | AgentLoopSessionGovernance
  | GentPlatform
  | SessionProfileCache
  | RuntimeEnvironment
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
  const eventStore = yield* EventStore
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
      yield* eventStore.deliver(committed.envelope.value)
      return { result: committed.result, fresh: true }
    })
  const platform = yield* GentPlatform
  const sessionRuntime = yield* SessionRuntime
  const governance = yield* AgentLoopSessionGovernance

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
          for (const event of events) envelopes.push(yield* eventStore.append(event))
          return { result, envelopes }
        }),
      )
      for (const envelope of committed.envelopes) yield* eventStore.deliver(envelope)
      return committed.result
    })

  const cleanupSessionRuntimeStateForMutation = (sessionId: SessionId) =>
    sessionRuntime.terminateSession(sessionId).pipe(Effect.orDie)
  const restoreSessionRuntimeStateForMutation = (sessionId: SessionId) =>
    CurrentWorkspaceId.pipe(
      Effect.flatMap((workspaceId) => governance.clearTerminated(workspaceId, sessionId)),
      Effect.orDie,
    )

  // The host context the `sessionDeleted` hooks run under. No loop owns a
  // deleted session, so no session control is wired.
  const deletedSessionHostProvider = yield* makeExtensionHostContextProvider({
    host: yield* makeExtensionHostPlatform,
  })

  /**
   * The profile of a session's cwd, resolved while its rows still exist, for
   * the hooks that run once they are gone. None when the session has no
   * branch (it does not exist). The caller's scope holds the profile's lease.
   */
  const runtimeEnvironment = yield* RuntimeEnvironment
  const deletedSessionProfile = Effect.fn("SessionMutations.deletedSessionProfile")(function* (
    sessionId: SessionId,
  ) {
    const branch = (yield* branchStorage.listBranches(sessionId))[0]
    if (Predicate.isUndefined(branch)) return Option.none()
    const profile = yield* resolveTurnProfile({
      sessionId,
      branchId: branch.id,
      profileCache,
      hostProvider: deletedSessionHostProvider,
      opener: RunOpener.cases.Turn.make({ openedByClient: false }),
    }).pipe(
      Effect.provideService(SessionStorage, sessionStorage),
      Effect.provideService(RuntimeEnvironment, runtimeEnvironment),
    )
    return Option.some(profile)
  })

  const deleteSessionCascade = Effect.fn("SessionMutations.deleteSessionCascade")(function* (
    sessionId: SessionId,
  ) {
    // Pre-collect is the best effort set we can tombstone BEFORE the durable
    // delete — so their runtimes stop accepting work while the tx runs. The
    // durable delete returns the authoritative set (the same rows the cascade
    // touched, collected inside its own tx) which we then use for the final
    // cleanup pass. Any descendant created between pre-collect and the tx is
    // included in the authoritative set and cleaned up here too.
    const preTombstoned = yield* sessionStorage.deletionSet(sessionId)
    // Each session's own profile, resolved while its rows still exist: sessions
    // of one tree can live in different cwds with different extensions.
    const profiles = new Map<SessionId, Option.Option<AgentLoopTurnProfile>>()
    yield* Effect.forEach(
      preTombstoned,
      (id) =>
        deletedSessionProfile(id).pipe(
          Effect.tap((profile) => Effect.sync(() => profiles.set(id, profile))),
        ),
      { discard: true },
    )
    const rootProfile = Option.flatten(Option.fromUndefinedOr(profiles.get(sessionId)))
    yield* Effect.forEach(preTombstoned, cleanupSessionRuntimeStateForMutation, { discard: true })
    const deleted = yield* sessionStorage.deleteSession(sessionId).pipe(
      // On failure we only restore `preTombstoned`: descendants created after pre-collect
      // were never tombstoned here, so there's no runtime state for them to "restore" to.
      Effect.onError(() =>
        Effect.forEach(preTombstoned, restoreSessionRuntimeStateForMutation, { discard: true }),
      ),
    )
    const cascadedIds = deleted.map((entry) => entry.sessionId)
    const preSet = new Set(preTombstoned)
    const postDeleteOnly = cascadedIds.filter((id) => !preSet.has(id))
    yield* Effect.forEach(postDeleteOnly, cleanupSessionRuntimeStateForMutation, { discard: true })
    yield* Effect.forEach(cascadedIds, (sessionId) => eventStore.removeSession(sessionId), {
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
    // Each removed session is heard once, under its own profile. A descendant
    // created after the pre-collect has no profile of its own; it is heard
    // under the deleted session's. Each handler's failure is logged and isolated.
    yield* Effect.forEach(
      deleted,
      (entry) =>
        Option.match(
          Option.orElse(
            Option.flatten(Option.fromUndefinedOr(profiles.get(entry.sessionId))),
            () => rootProfile,
          ),
          {
            onNone: () => Effect.void,
            onSome: (resolved) =>
              turnRegistry(resolved)
                .getResolved()
                .extensionHooks.emitSessionDeleted(entry)
                .pipe(runAgentLoopTurnProfile(resolved)),
          },
        ),
      { concurrency: SESSION_DELETED_CONCURRENCY, discard: true },
    )
  }, Effect.scoped)

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
        return yield* new InvalidStateError({ message: "parentBranchId requires parentSessionId" })
      }
      if (input.continueThread === true) {
        return yield* new InvalidStateError({ message: "continueThread requires parentSessionId" })
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

  const profileCache = yield* SessionProfileCache

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
      Effect.provideService(SessionProfileCache, profileCache),
      Effect.provideService(RuntimeEnvironment, runtimeEnvironment),
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
        const name = input.name ?? DEFAULT_SESSION_NAME
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
        const envelope = yield* eventStore.append(SessionStarted.make({ sessionId, branchId }))
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
        const envelope = yield* eventStore.append(
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
        const envelope = yield* eventStore.append(
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
        const envelope = yield* eventStore.append(
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
  // ambiguous failure converges on one durable outcome. Each body checks the
  // durable operation row, which answers every sequential retry, a restart
  // included.
  //
  // `RpcServer.layerHttp` runs with `concurrency: "unbounded"` and the client
  // has `retryTransientErrors: true`, so the same requestId can land on two
  // fibers in parallel. `makeRequestDeduper` runs the body once for the calls
  // in flight together; the others await its outcome.
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
      // Cut between code points, then trim: a name never ends in half an
      // emoji or a space.
      const trimmed = headChars(input.name.trim(), 80).trimEnd()
      if (trimmed.length === 0) return { renamed: false }
      const unchanged: RenameSessionResult = { renamed: false }
      const expectedName = Option.fromUndefinedOr(input.expectedName)
      return yield* transactWithEvents(
        Effect.gen(function* () {
          // The read and the write share one write transaction (one
          // connection, `BEGIN IMMEDIATE`), so no rename lands between them:
          // the expected name is checked on this read.
          const session = yield* sessionStorage.getSession(input.sessionId)
          if (
            Predicate.isUndefined(session) ||
            session.name === trimmed ||
            Option.exists(expectedName, (expected) => session.name !== expected)
          ) {
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
      // The model-change notice is a branch write; the loop owns it and
      // writes it at the next step boundary (`modelChangeNotice`, written by turn.ts).
      return yield* transactWithEvents(
        Effect.gen(function* () {
          const session = yield* sessionStorage.getSession(input.sessionId)
          if (Predicate.isUndefined(session)) {
            return yield* new NotFoundError({ message: "Session not found" })
          }
          // Merged inside the transaction: a field the change leaves out keeps
          // the stored value, whatever the caller last saw; `Some` sets and
          // `None` clears.
          const settings = {
            modelId: Option.getOrUndefined(
              Option.getOrElse(Option.fromUndefinedOr(input.modelId), () =>
                Option.fromUndefinedOr(session.modelId),
              ),
            ),
            reasoningLevel: Option.getOrUndefined(
              Option.getOrElse(Option.fromUndefinedOr(input.reasoningLevel), () =>
                Option.fromUndefinedOr(session.reasoningLevel),
              ),
            ),
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

// ── rpc handlers ────────────────────────────────────────────────────────────

/**
 * The registry serving a cwd: its profile's, or for no cwd the host cwd's
 * profile as it is now, the profile a turn of that session resolves. The
 * caller's scope holds the profile's lease.
 */
const resolveRegistryForCwd = Effect.fn("SessionQueries.resolveRegistryForCwd")(function* (
  cwd: Option.Option<string>,
) {
  const environment = yield* RuntimeEnvironment
  const profile = yield* (yield* SessionProfileCache).resolve(
    Option.getOrElse(cwd, () => environment.cwd),
  )
  return profile.registryService
})

/**
 * How the session's next turn routes: what the footer shows. Resolving it
 * here keeps the precedence (session > config > agent) in one place with the
 * turn. The agent roster is resolved data; the lease ends with the read.
 */
const readSessionRoute = Effect.fn("SessionQueries.readSessionRoute")(function* (session: Session) {
  const registry = yield* resolveRegistryForCwd(Option.fromUndefinedOr(session.cwd)).pipe(
    Effect.scoped,
  )
  const configService = yield* ConfigService
  const config = yield* configService.get(session.cwd)
  return resolveSessionRoute({
    agents: [...registry.getResolved().agents.values()],
    admission: Option.fromUndefinedOr(session.admission),
    config,
    session,
  })
})

/** The stored session and its route, without the conversation. */
const getSessionView = Effect.fn("SessionQueries.getSessionView")(function* (sessionId: SessionId) {
  const sessionStorage = yield* SessionStorage
  const session = yield* sessionStorage.getSession(sessionId)
  if (Predicate.isUndefined(session)) return Option.none<SessionView>()
  const route = yield* readSessionRoute(session)
  return Option.some(
    new SessionView({
      ...session,
      resolvedModelId: route.modelId,
      resolvedReasoningLevel: Option.getOrUndefined(route.reasoningLevel),
    }),
  )
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

  const snapshotState = yield* storageTransaction(
    Effect.gen(function* () {
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (Predicate.isUndefined(session)) {
        return yield* new NotFoundError({ message: "Session not found" })
      }
      const branch = yield* branchStorage.getBranch(input.branchId)
      if (Predicate.isUndefined(branch) || branch.sessionId !== input.sessionId) {
        return yield* new NotFoundError({ message: "Branch not found" })
      }
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
        session,
        projectedMessages: projectMessagesWithToolInteractions(messages, toolCallReceipts(events)),
        lastEventId,
        // The same read answers the HUD totals: one branch log, folded once.
        metrics: foldSessionMetrics(events),
      }
    }),
  )

  const { session } = snapshotState
  const runtime = yield* sessionRuntime.getState(input).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidStateError({
          message: `Failed to read session runtime state: ${cause.message}`,
        }),
    ),
  )

  const route = yield* readSessionRoute(session)

  // The snapshot carries no extension state: clients call the extension's
  // typed `client.extension.request(...)` on mount and refetch on
  // `ExtensionStateChanged` events.

  return new SessionSnapshot({
    sessionId: input.sessionId,
    branchId: input.branchId,
    name: session.name,
    messages: snapshotState.projectedMessages,
    lastEventId: Option.getOrNull(Option.fromUndefinedOr(snapshotState.lastEventId)),
    modelId: session.modelId,
    reasoningLevel: session.reasoningLevel,
    agent: route.name,
    resolvedModelId: route.modelId,
    resolvedReasoningLevel: Option.getOrUndefined(route.reasoningLevel),
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
  const eventStore = yield* EventStore
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
  // 3. Publish the resolution. The answer is stored and delivered already, so
  //    a failed publish costs only the event; it is logged, not raised.
  yield* eventStore
    .publish(
      InteractionResolved.make({
        sessionId: input.sessionId,
        branchId: input.branchId,
        requestId: input.requestId,
        ...decision,
      }),
    )
    .pipe(
      Effect.catchEager((error) =>
        Effect.logWarning("InteractionResolved publish failed").pipe(
          Effect.annotateLogs({ requestId: input.requestId, error: String(error) }),
        ),
      ),
    )
})

// ── rpc handler helpers ─────────────────────────────────────────────────────

// Each helper yields its Tags; no service bag is threaded through.

type BranchPayload = { readonly branchId: BranchId }
type ExtensionStatusPayload = { readonly scope: ExtensionStatusScope }
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

type WideEventFields = Parameters<typeof WideEvent.set>[0]

/**
 * Run one RPC inside its wide-event boundary. The input's fields are recorded
 * before the call runs, so a failed call still names its session; the fields
 * the result names are recorded after it succeeds.
 */
const rpc = <A, E, R>(
  method: string,
  fields: WideEventFields,
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly requestId?: RequestId
    readonly result?: (result: A) => WideEventFields
  } = {},
) =>
  WideEvent.set(fields).pipe(
    Effect.andThen(effect),
    Effect.tap((result) =>
      Option.match(Option.fromUndefinedOr(options.result), {
        onNone: () => Effect.void,
        onSome: (resultFields) => WideEvent.set(resultFields(result)),
      }),
    ),
    withWideEvent(WideEventBoundary.rpc(method, { requestId: options.requestId })),
  )

// ── rpc handlers layer ──────────────────────────────────────────────────────

/** A login no callback finishes lets its profile go after this. */
const LOGIN_LEASE = Duration.minutes(10)

/** The profile a pending login holds; see "login leases" in `RpcHandlers`. */
interface LoginLease {
  readonly profile: Pick<SessionProfile, "registryService" | "layerContext">
  readonly scope: Scope.Closeable
  /** Callbacks running on the lease. */
  inFlight: number
  /**
   * A callback succeeded or `LOGIN_LEASE` passed. The lease goes when it is
   * done and no callback runs on it: the last one out lets it go.
   */
  done: boolean
}

const RpcHandlers = GentRpcs.toLayer(
  Effect.gen(function* () {
    const mutations = yield* SessionMutations
    const eventStore = yield* EventStore
    const configService = yield* ConfigService
    const sessionRuntime = yield* SessionRuntime
    const authStore = yield* Auth
    const catalogRecord = yield* ModelCatalogRecord
    const platform = yield* GentPlatform
    const profileCache = yield* SessionProfileCache
    const sessionStorage = yield* SessionStorage
    const relationshipStorage = yield* RelationshipStorage
    const branchStorage = yield* BranchStorage
    const messageStorage = yield* MessageStorage
    // Touching these Tags at layer-build keeps their requirements visible on the
    // RpcHandlers layer. RpcGroup.toLayer erases handler-residual R, so Tags only
    // yielded inside returned handler Effects would otherwise become deferred
    // request-time defects instead of layer-build failures.
    const runtimeEnvironment = yield* RuntimeEnvironment
    const pathService = yield* Path.Path

    // `message.send` has no durable operation row: its `requestId` names the
    // user message, and the loop admits a message whose turn is admitted,
    // running or settled as a replay (`LoopInbox.admit`), so a sequential
    // retry runs no second turn. The deduper runs the body once for the
    // calls in flight together (unbounded RPC concurrency + client transport
    // retries).
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

    // The one owner of "a named session must exist". A session id that names
    // no session, or a storage failure, fails the call: an answer from the
    // launch profile would be another profile's models, drivers or commands.
    // Every session-scoped payload names its session (the contract requires
    // `sessionId`), so no call reaches here without one.
    const loadSession = (
      sessionId: SessionId,
    ): Effect.Effect<Session, StorageError | NotFoundError> =>
      sessionStorage
        .getSession(sessionId)
        .pipe(
          Effect.flatMap((session) =>
            Effect.fromOption(Option.fromUndefinedOr(session)).pipe(
              Effect.mapError(() => new NotFoundError({ message: "Session not found" })),
            ),
          ),
        )

    /** The stored cwd of a session; none for a session that stored no cwd,
     *  which runs in the host's cwd, as its loop does. */
    const cwdOf = (session: Session) => Option.fromUndefinedOr(session.cwd)

    const sessionCwd = (sessionId: SessionId) => loadSession(sessionId).pipe(Effect.map(cwdOf))

    // The caller's scope holds the profile's lease while it uses its services.
    const profileForCwd = (cwd: Option.Option<string>) =>
      profileCache.resolve(Option.getOrElse(cwd, () => runtimeEnvironment.cwd))

    const resolveSessionProfile = (sessionId: SessionId) =>
      sessionCwd(sessionId).pipe(Effect.flatMap(profileForCwd))

    const resolveSessionRegistry = (
      sessionId: SessionId,
    ): Effect.Effect<ExtensionRegistryService, StorageError | NotFoundError, Scope.Scope> =>
      resolveSessionProfile(sessionId).pipe(Effect.map((profile) => profile.registryService))

    const underProfile = <A, E>(
      profile: Pick<SessionProfile, "registryService" | "layerContext">,
      effect: Effect.Effect<A, E, ExtensionRegistry | Auth | GentPlatform>,
    ) =>
      effect.pipe(
        Effect.provideService(ExtensionRegistry, profile.registryService),
        Effect.provideService(Auth, authStore),
        Effect.provideService(GentPlatform, platform),
        Effect.provideContext(profile.layerContext),
      )

    /** Provider login runs against the drivers of the session's own profile. */
    const inSessionProfile = <A, E>(
      sessionId: SessionId,
      effect: Effect.Effect<A, E, ExtensionRegistry | Auth | GentPlatform>,
    ) =>
      resolveSessionProfile(sessionId).pipe(
        Effect.flatMap((profile) => underProfile(profile, effect)),
        Effect.scoped,
      )

    // ── login leases ──
    // A login's pending state lives on the driver instance that authorized
    // it. The login holds that instance's profile until its callback
    // succeeds or `LOGIN_LEASE` passes, so a config edit between the two
    // calls, which supersedes the session's profile, cannot retire the
    // instance under the login. A callback in flight keeps the lease past
    // its expiry or past another callback's success; the last one out lets
    // it go.
    const handlersScope = yield* Effect.scope
    const loginLeases = new Map<string, LoginLease>()
    const dropLoginLease = (authorizationId: string, lease: LoginLease) =>
      Effect.suspend(() => {
        if (loginLeases.get(authorizationId) !== lease) return Effect.void
        loginLeases.delete(authorizationId)
        return Scope.close(lease.scope, Exit.void)
      })

    const authorizeLogin = (input: AuthorizeAuthInput) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(handlersScope)
        const authorized = yield* Effect.gen(function* () {
          const profile = yield* resolveSessionProfile(input.sessionId).pipe(Scope.provide(scope))
          const authorization = yield* underProfile(
            profile,
            authorizeProvider(input.sessionId, input.provider, input.method),
          )
          return { profile, authorization }
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
        if (Option.isNone(authorized.authorization)) {
          yield* Scope.close(scope, Exit.void)
          return Option.none()
        }
        const authorizationId = authorized.authorization.value.authorizationId
        const lease: LoginLease = {
          profile: authorized.profile,
          scope,
          inFlight: 0,
          done: false,
        }
        loginLeases.set(authorizationId, lease)
        // The timer lives in the lease's scope: a lease let go stops it.
        yield* Effect.sleep(LOGIN_LEASE).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              lease.done = true
              if (lease.inFlight > 0) return Effect.void
              return dropLoginLease(authorizationId, lease)
            }),
          ),
          Effect.forkIn(scope),
        )
        return authorized.authorization
      })

    const completeLogin = (input: CallbackAuthInput) => {
      const run = completeProviderAuth(
        input.sessionId,
        input.provider,
        input.method,
        input.authorizationId,
        input.code,
      )
      const held = Option.fromNullishOr(loginLeases.get(input.authorizationId))
      if (Option.isNone(held)) return inSessionProfile(input.sessionId, run)
      const lease = held.value
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          lease.inFlight++
        }),
        () =>
          underProfile(lease.profile, run).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                lease.done = true
              }),
            ),
          ),
        () =>
          Effect.suspend(() => {
            lease.inFlight--
            if (!lease.done || lease.inFlight > 0) return Effect.void
            return dropLoginLease(input.authorizationId, lease)
          }),
      )
    }

    return {
      // ----------------------------------------------------------------------
      // Session / branch / message / queue / interaction
      // ----------------------------------------------------------------------
      "session.create": (input: CreateSessionInput) =>
        rpc("session.create", {}, mutations.createSession(input), {
          requestId: input.requestId,
          result: (result) => ({ sessionId: result.sessionId }),
        }),

      "session.list": () => sessionStorage.listSessions,

      "session.thread": ({ sessionId }: SessionIdPayload) =>
        relationshipStorage.getThreadSessions(sessionId),

      "session.get": ({ sessionId }: SessionIdPayload) =>
        rpc(
          "session.get",
          { sessionId },
          getSessionView(sessionId).pipe(Effect.map(Option.getOrNull)),
        ),

      "session.delete": ({ sessionId }: SessionIdPayload) =>
        rpc("session.delete", { sessionId }, mutations.deleteSession(sessionId)),

      "session.getSnapshot": (input: GetSessionSnapshotInput) =>
        rpc("session.getSnapshot", input, getSessionSnapshot(input)),

      "session.updateSettings": (input: UpdateSessionSettingsInput) =>
        rpc(
          "session.updateSettings",
          { sessionId: input.sessionId },
          mutations.updateSettings(input),
          { result: (result) => result },
        ),

      "session.events": ({ sessionId, branchId, after }: SubscribeEventsInput) => {
        const subscription = { sessionId, branchId, synchronize: true }
        if (!Predicate.isUndefined(after))
          Object.assign(subscription, { after: EventId.make(after) })
        return eventStore.subscribe(subscription)
      },

      "session.watchRuntime": (input: QueueTarget) => watchRuntimeStream(input),

      "branch.list": ({ sessionId }: SessionIdPayload) => branchStorage.listBranches(sessionId),

      "branch.create": (input: CreateBranchInput) =>
        rpc("branch.create", { sessionId: input.sessionId }, mutations.createSessionBranch(input), {
          requestId: input.requestId,
          result: (result) => ({ branchId: result.branchId }),
        }),

      "branch.getTree": ({ sessionId }: SessionIdPayload) => getBranchTree(sessionId),

      "branch.switch": (input: SwitchBranchInput) =>
        rpc(
          "branch.switch",
          {
            sessionId: input.sessionId,
            fromBranchId: input.fromBranchId,
            toBranchId: input.toBranchId,
          },
          mutations.switchActiveBranch(input),
          { requestId: input.requestId },
        ),

      "branch.fork": (input: ForkBranchInput) =>
        rpc(
          "branch.fork",
          { sessionId: input.sessionId, fromBranchId: input.fromBranchId },
          mutations.forkSessionBranch(input),
          { requestId: input.requestId, result: (result) => ({ branchId: result.branchId }) },
        ),

      "message.send": (input: SendMessageInput) =>
        rpc(
          "message.send",
          { sessionId: input.sessionId, branchId: input.branchId },
          sendMessage(input),
          { requestId: input.requestId },
        ),

      "message.list": ({ branchId }: BranchPayload) => messageStorage.listMessages(branchId),

      "steer.command": ({ command }: { readonly command: TransportSteerCommand }) =>
        rpc(
          "steer.command",
          { sessionId: command.sessionId, branchId: command.branchId, steerTag: command._tag },
          sessionRuntime.steer(clientSteer(command)),
        ),

      "queue.drain": ({ sessionId, branchId, requestId }: QueueDrainInput) =>
        rpc(
          "queue.drain",
          { sessionId, branchId },
          sessionRuntime
            .drainQueuedMessages({ sessionId, branchId, requestId })
            .pipe(Effect.withSpan("SessionRuntime.drainQueuedMessages")),
          { requestId },
        ),

      "queue.get": (input: QueueTarget) =>
        rpc(
          "queue.get",
          input,
          sessionRuntime
            .getQueuedMessages(input)
            .pipe(Effect.withSpan("SessionQueries.getQueuedMessages")),
        ),

      "interaction.respondInteraction": (input: RespondInteractionInput) =>
        rpc(
          "interaction.respondInteraction",
          {
            sessionId: input.sessionId,
            branchId: input.branchId,
            requestId: input.requestId,
            approved: input.approved,
          },
          respondInteraction(input),
        ),

      // ----------------------------------------------------------------------
      // Config / driver / model / auth
      // ----------------------------------------------------------------------
      // The catalog and the drivers are the requesting session's profile:
      // its project drivers count, its disabled extensions do not.
      "model.list": ({ sessionId }: SessionIdPayload) =>
        inSessionProfile(
          sessionId,
          modelCatalog().pipe(
            Effect.provideService(ModelCatalogRecord, catalogRecord),
            Effect.map((catalog) => catalog.models),
          ),
        ),

      "driver.list": ({ sessionId }: SessionIdPayload) =>
        Effect.gen(function* () {
          const registry = yield* resolveSessionRegistry(sessionId)
          const resolved = registry.getResolved()
          const agents = [...resolved.agents.values()]
          const drivers = [...resolved.modelDrivers.values()].map((driver) =>
            DriverInfo.make({ id: driver.id }),
          )
          return new DriverListResult({ drivers, agents })
        }).pipe(Effect.scoped),

      "driver.set": ({ agentName, driver, sessionId }: SetDriverOverrideInput) =>
        Effect.gen(function* () {
          const registry = yield* resolveSessionRegistry(sessionId)
          const resolved = registry.getResolved()
          if (!resolved.modelDrivers.has(driver.id)) {
            return yield* new NotFoundError({
              message: `Unknown model driver "${driver.id}"`,
            })
          }
          yield* configService.setDriverOverride(agentName, driver)
        }).pipe(Effect.scoped),

      "driver.clear": ({ agentName }: ClearDriverOverrideInput) =>
        configService.clearDriverOverride(agentName),

      "auth.listProviders": ({ agentName, sessionId }: ListAuthProvidersPayload) =>
        Effect.gen(function* () {
          const session = yield* loadSession(sessionId)
          // The models a turn in this session would run: the session's
          // registry and config, then its model override, as the turn does.
          const cwd = cwdOf(session)
          const profile = yield* profileForCwd(cwd)
          const registry = profile.registryService
          const config = yield* configService.get(Option.getOrUndefined(cwd))
          const agents = [...registry.getResolved().agents.values()]
          // The driver a turn routes through: the agent's driver, else the
          // config override, else the model id's provider segment.
          const driverFor = (admission: Option.Option<SessionAdmission>) =>
            resolveSessionRoute({ agents, admission, config, session }).modelDriver.driverId
          // The session's own agent, then an agent the caller asks about.
          const admissions = [Option.fromUndefinedOr(session.admission)]
          if (!Predicate.isUndefined(agentName)) admissions.push(Option.some({ agent: agentName }))
          const driverIds = admissions.flatMap((admission) => Option.toArray(driverFor(admission)))
          return yield* underProfile(
            profile,
            listAuthProviders(driverIds).pipe(
              Effect.mapError((error) => authPersistenceError("read", "*", error)),
            ),
          )
        }).pipe(Effect.scoped),

      // A key typed for a driver that shares a sign-in is the owner's key.
      // Its prompt answers go into the same record, written once.
      "auth.setKey": ({ provider, key, metadata, sessionId }: SetAuthKeyInput) =>
        inSessionProfile(
          sessionId,
          storeSignIn(
            provider,
            AuthApi.make({ type: "api", key, ...omitUndefined({ metadata }) }),
          ).pipe(Effect.mapError((error) => authPersistenceError("set", provider, error))),
        ),

      // A sign-in other drivers share removes every credential it reads.
      "auth.deleteKey": ({ provider, sessionId }: DeleteAuthKeyInput) =>
        inSessionProfile(
          sessionId,
          removeSignIn(provider).pipe(
            Effect.mapError((error) => authPersistenceError("delete", provider, error)),
          ),
        ),

      "auth.listMethods": ({ sessionId }: ListAuthMethodsInput) =>
        inSessionProfile(sessionId, listAuthMethods()),

      "auth.authorize": (input: AuthorizeAuthInput) =>
        authorizeLogin(input).pipe(Effect.map(Option.getOrNull)),

      "auth.callback": (input: CallbackAuthInput) => completeLogin(input),

      // ----------------------------------------------------------------------
      // Extension transport
      // ----------------------------------------------------------------------
      // A session's health is its profile's; `Launch` (the doctor, which has
      // no session) reads the profile the server started in.
      "extension.listStatus": ({ scope }: ExtensionStatusPayload) =>
        Effect.gen(function* () {
          const cwd = yield* ExtensionStatusScope.match(scope, {
            Session: ({ id }) => sessionCwd(id),
            Launch: () => Effect.succeedNone,
          })
          const profile = yield* profileForCwd(cwd)
          const registry = profile.registryService
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
              underProfile(
                profile,
                modelCatalog().pipe(
                  Effect.provideService(ModelCatalogRecord, catalogRecord),
                  Effect.map((catalog) => catalog.failures),
                ),
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
        rpc(
          "extension.request",
          { sessionId, branchId, extensionId, capabilityId },
          sessionRuntime
            .requestExtension({ sessionId, branchId, extensionId, capabilityId, input })
            .pipe(
              Effect.mapError(
                (error) =>
                  new ExtensionProtocolError({
                    extensionId,
                    tag: capabilityId,
                    message: error.message,
                  }),
              ),
            ),
        ),

      "extension.listSlashCommands": ({ sessionId }: SessionIdPayload) =>
        Effect.gen(function* () {
          const registry = yield* resolveSessionRegistry(sessionId)
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

// ── server dependencies ─────────────────────────────────────────────────────

interface DependencyOverrides {
  readonly authLayer?: Layer.Layer<Auth>
  readonly approvalLayer?: Layer.Layer<
    ApprovalService,
    never,
    EventStore | GentPlatform | InteractionStorage
  >
  readonly configServiceLayer?: Layer.Layer<ConfigService>
  readonly modelRegistryLayer?: Layer.Layer<ModelRegistry>
  /** Replaces the auth-backed live resolver (a scripted or fixed model). */
  readonly modelResolverLayer?: Layer.Layer<ModelResolver>
  readonly toolRunnerLayer?: Layer.Layer<ToolRunner>
  readonly sessionProfileCacheLayer?: Layer.Layer<SessionProfileCache>
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
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

interface DependenciesConfig<A = never> {
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
  /** Extensions to load. Composition roots pass this in. */
  extensions: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  /**
   * The branch-tool feature this deployment ships — its migrations, storage,
   * and per-branch factory as one value. Required, not defaulted: a root that
   * ships a stateful tool surface and forgets this would get a tool that
   * fails on first use, and a default would hide that until run time. A
   * deployment whose tools are all stateless passes `noBranchTools`.
   */
  branchTools: BranchToolFeature<A>
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

const makeStorageLayer = <A>(config: DependenciesConfig<A>) => {
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

export const createDependencies = <A = never>(config: DependenciesConfig<A>) => {
  const runtimeEnvironmentLive = RuntimeEnvironment.Live({
    cwd: config.cwd,
    home: config.home,
  })

  const storageLive = makeStorageLayer(config)
  const clusterRunnerLive = makeClusterRunnerLayer(config.state)

  // Auth lives in `~/.gent/auth/` (one URL-encoded file per provider).
  // The composition root owns FileSystem/Path; this dependency graph only
  // describes that Auth needs platform capabilities.
  // It does not follow `GENT_DATA_DIR` on purpose: an isolated run (the
  // gamut, a scratch database) signs in with the owner's credentials instead
  // of asking again. `GENT_AUTH_DIRECTORY` separates it when a run must.
  const authDirectory = Option.getOrElse(
    Option.fromUndefinedOr(config.authDirectory),
    () => `${config.home}/.gent/auth`,
  )
  const authLive = config.overrides?.authLayer ?? Auth.Live(authDirectory)

  const configServiceLive = config.overrides?.configServiceLayer ?? ConfigService.Live

  // SessionProfileCache is the sole live profile owner. Every reader, a
  // session with no stored cwd included, resolves its profile through it when
  // it reads; the server context holds no registry.
  const sessionProfileCacheLive =
    config.overrides?.sessionProfileCacheLayer ??
    SessionProfileCache.Live({
      home: config.home,
      platform: config.platform,
      shell: config.shell,
      osVersion: config.osVersion,
      extensions: config.extensions,
      failOnExtensionFailure: config.failOnExtensionFailure,
    })

  // The launch cwd's profile builds at startup, so an extension that fails
  // to load stops the start, and the first session there finds it built. The
  // warm-up releases its lease: the cache keeps the newest profile of a place,
  // and a later edit retires this one when its last reader ends.
  const launchProfileWarmUp = Layer.effectDiscard(
    Effect.gen(function* () {
      const cache = yield* SessionProfileCache
      // Same derivation the client used for its `x-gent-workspace-id`
      // header; a second one here would split the workspace silently.
      const launchWorkspaceId = workspaceIdForCwd(config.cwd)
      yield* cache
        .resolve(config.cwd)
        .pipe(Effect.scoped, Effect.provideService(CurrentWorkspaceId, launchWorkspaceId))
    }),
  )

  const modelRegistryLive = config.overrides?.modelRegistryLayer ?? ModelRegistry.Live
  const modelResolverLive = config.overrides?.modelResolverLayer ?? ModelResolver.Live
  // ApprovalService — single handler for all interaction types
  const approvalServiceLive = config.overrides?.approvalLayer ?? ApprovalService.Live
  const toolRunnerLive = config.overrides?.toolRunnerLayer ?? ToolRunner.Live

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
                .pipe(
                  // One branch that cannot wake does not stop the others.
                  Effect.catchEager((error) =>
                    Effect.logWarning("Recovered interaction could not wake its branch").pipe(
                      Effect.annotateLogs({ requestId: record.requestId, error: String(error) }),
                    ),
                  ),
                )
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

  // One graph, built bottom up: each level provides every level above it,
  // and each layer appears in it once, so each builds once. Effect memoizes
  // only leaf layers; a composite (`provide`, `merge`) builds once for every
  // path that reaches it, and a graph that names a composite twice in each of
  // several levels builds it a power of that many times.
  const host = Layer.mergeAll(
    // The app names the branch-tool feature it ships. The loop builds its
    // layer without knowing what it is.
    Layer.succeed(CurrentBranchToolFeature, config.branchTools),
    platformServicesLive,
    runtimeEnvironmentLive,
  )
  const stored = Layer.provideMerge(storageLive, host)
  const kernel = Layer.provideMerge(
    Layer.mergeAll(
      clusterRunnerLive,
      // Snapshots and event replay share a cursor, including in-memory SQLite.
      EventStoreLive,
      authLive,
      configServiceLive,
      ModelCatalogRecord.Live,
    ),
    stored,
  )
  const launchProfile = Layer.provideMerge(
    launchProfileWarmUp,
    Layer.provideMerge(sessionProfileCacheLive, kernel),
  )
  // Above the launch profile: a core service wins over an extension resource
  // that provides the same tag.
  const models = Layer.provideMerge(
    Layer.mergeAll(
      modelRegistryLive,
      modelResolverLive,
      DecisionModelResolver.Live,
      FileLockService.layer,
      AgentLoopSessionGovernance.Live,
      ...Option.getOrElse(Option.fromUndefinedOr(config.overrides?.extraLayers), () => []),
      FetchHttpClient.layer,
    ),
    launchProfile,
  )
  const tools = Layer.provideMerge(toolRunnerLive, Layer.provideMerge(approvalServiceLive, models))
  const sessions = Layer.provideMerge(
    SessionMutationsLive,
    Layer.provideMerge(SessionRuntime.Client, tools),
  )
  const actor = Layer.provideMerge(AgentLoopLiveActor, sessions)
  return Layer.provideMerge(interactionRecoveryLive, actor)
}

// ── websocket lifecycle tracing ─────────────────────────────────────────────

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
 */
const wsTracingLayer: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.use((router) =>
  router.addGlobalMiddleware((handler) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const upgradeHeader = request.headers["upgrade"]
      const isUpgrade = upgradeHeader?.toLowerCase() === "websocket"

      if (!isUpgrade) return yield* handler

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
          Effect.logInfo("ws.disconnect").pipe(
            Effect.annotateLogs({
              url: request.url,
              remoteAddress: request.remoteAddress ?? "unknown",
            }),
          ),
        ),
      )
    }),
  ),
)

// ── route assembly ──────────────────────────────────────────────────────────

interface ServerRoutesConfig {
  /** The identity `/_gent/identity` serves, verbatim. */
  readonly identity: ServerIdentityApi
}

/**
 * Build the full HTTP route layer for a gent server; the SDK's owned-server
 * path (`Gent.server`) serves it from its in-process HTTP listener.
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
