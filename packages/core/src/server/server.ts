import {
  Clock,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect"
import { BranchId, MessageId, type RequestId, SessionId } from "../domain/ids.js"
import {
  Branch,
  type BranchTreeNode,
  copyMessageToBranch,
  Message,
  projectMessagesWithToolInteractions,
  type RuntimeUserMessageType,
  Session,
  toolCallDurations,
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
} from "./rpc.js"
import * as Prompt from "effect/unstable/ai/Prompt"
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
  MessageReceived,
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
import type { DriverRef } from "../domain/agent.js"
import {
  Auth,
  AuthApi,
  AuthGuard,
  ModelRegistry,
  ModelResolver,
  ProviderAuth,
} from "../runtime/provider.js"
import { ProviderAuthError } from "../domain/driver.js"
import { ConfigService, RuntimeEnvironment } from "../runtime/config.js"
import {
  ApprovalService,
  DriverRegistry,
  ExtensionRegistry,
  type ExtensionRegistryService,
  resolveExistingSessionBranch,
  SessionProfileCache,
} from "../runtime/extension-host.js"
import { foldSessionMetrics, type SendUserMessagePayload } from "../domain/agent-loop.js"
import { applyAgentOverrides, resolveSessionSettings } from "../runtime/turn.js"
import { WideEvent, WideEventBoundary, withWideEvent } from "../runtime/wide-event-boundary.js"
import {
  type ApprovalDecision,
  decodeInteractionDecision,
  decodeInteractionParams,
  InteractionRequestMismatchError,
} from "../domain/interaction.js"
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
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"

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

export const buildExtensionHealthSnapshot = (
  activationStatuses: ReadonlyArray<ExtensionStatusInfo>,
): ExtensionHealthSnapshot => {
  const extensions = activationStatuses.map((status) => {
    let activationFailure = Option.none<ExtensionHealthIssue>()
    if (status.status === "failed") {
      activationFailure = Option.some(
        ExtensionHealthIssue.cases.ActivationFailed.make({
          phase: status.phase,
          error: status.error,
        }),
      )
    }
    const issues = Option.match(activationFailure, {
      onNone: (): ReadonlyArray<ExtensionHealthIssue> => [],
      onSome: (issue) => [issue],
    })

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
   * inside it so two concurrent retries cannot both do the work.
   */
  const eventPublisher = yield* EventPublisher
  const once = <A, E, R>(
    operation: DurableOperation<A>,
    { requestId }: { readonly requestId?: RequestId },
    subject: (result: A) => { readonly sessionId: SessionId; readonly branchId: BranchId },
    work: Effect.Effect<{ readonly envelope: EventEnvelope; readonly result: A }, E, R>,
  ): Effect.Effect<{ readonly result: A; readonly fresh: boolean }, E | StorageError, R> =>
    Effect.gen(function* () {
      if (!Predicate.isUndefined(requestId)) {
        const existing = yield* sessionOperationStorage.getReceipt(operation, requestId)
        if (!Predicate.isUndefined(existing)) return { result: existing, fresh: false }
      }
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

  const transactWithEvent = <A, E, R>(
    mutation: Effect.Effect<A, E, R>,
    ...events: ReadonlyArray<AgentEvent>
  ): Effect.Effect<A, E | EventStoreError | StorageError, R> =>
    Effect.gen(function* () {
      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          const result = yield* mutation
          const envelopes: Array<EventEnvelope> = []
          for (const event of events) envelopes.push(yield* eventPublisher.append(event))
          return { result, envelopes }
        }),
      )
      for (const envelope of committed.envelopes) yield* eventPublisher.deliver(envelope)
      return committed.result
    })

  const MODEL_CHANGE_MESSAGE_TYPE: RuntimeUserMessageType = "model-change"

  /**
   * A durable user-role line the model reads on its next turn when the
   * session's model changes, so attribution of the turns above stays honest.
   * An effort-only change writes nothing; the TUI keeps the line out of the
   * feed by its `customType`.
   */
  const modelChangeNotice = Effect.fn("SessionMutations.modelChangeNotice")(function* (
    session: Session,
    nextModelId: Option.Option<string>,
  ) {
    const previous = Option.fromUndefinedOr(session.modelId)
    if (Option.getOrUndefined(previous) === Option.getOrUndefined(nextModelId)) {
      return Option.none<Message>()
    }
    if (Predicate.isUndefined(session.activeBranchId)) return Option.none<Message>()
    const name = (model: Option.Option<string>) =>
      Option.getOrElse(model, () => "the default model")
    return Option.some(
      Message.cases.regular.make({
        id: MessageId.make(yield* platform.randomId),
        sessionId: session.id,
        branchId: session.activeBranchId,
        role: "user",
        parts: [
          Prompt.textPart({
            text: `[model changed: the turns above were generated by ${name(previous)}; the session continues with ${name(nextModelId)}]`,
          }),
        ],
        createdAt: yield* DateTime.nowAsDate,
        metadata: { customType: MODEL_CHANGE_MESSAGE_TYPE },
      }),
    )
  })

  const collectSessionTreeIds = Effect.fn("SessionMutations.collectSessionTreeIds")(function* (
    rootSessionId: SessionId,
  ) {
    const sessionIds: SessionId[] = []
    const queue: SessionId[] = [rootSessionId]
    const seen = new Set<SessionId>()
    let index = 0

    while (index < queue.length) {
      const sessionId = queue[index]
      index += 1
      if (Predicate.isUndefined(sessionId) || seen.has(sessionId)) continue
      seen.add(sessionId)
      sessionIds.push(sessionId)
      const children = yield* relationshipStorage.getChildSessions(sessionId)
      for (const child of children) {
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
    }
    if (Option.isSome(requestId)) {
      message = { ...message, requestId: `session.create:${requestId.value}:initial` }
    }
    yield* sessionRuntime.sendUserMessage(message)
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
        if (
          !Predicate.isUndefined(input.parentBranchId) &&
          Predicate.isUndefined(input.parentSessionId)
        ) {
          return yield* new NotFoundError({
            message: "parentBranchId requires parentSessionId",
          })
        }
        let parentThread = Option.none<SessionId>()
        if (!Predicate.isUndefined(input.parentSessionId)) {
          const parent = yield* sessionStorage.getSession(input.parentSessionId)
          if (Predicate.isUndefined(parent)) {
            return yield* new NotFoundError({
              message: `Parent session not found: ${input.parentSessionId}`,
            })
          }
          parentThread = Option.fromNullishOr(parent.threadId)
          yield* admitChildSessionDepth(input.parentSessionId).pipe(
            Effect.provideService(RelationshipStorage, relationshipStorage),
          )
        }
        if (
          !Predicate.isUndefined(input.parentBranchId) &&
          !Predicate.isUndefined(input.parentSessionId)
        ) {
          const parentBranch = yield* branchStorage.getBranch(input.parentBranchId)
          if (
            Predicate.isUndefined(parentBranch) ||
            parentBranch.sessionId !== input.parentSessionId
          ) {
            return yield* new NotFoundError({
              message: `Parent branch not found in parent session: ${input.parentBranchId}`,
            })
          }
        }

        const branchId = BranchId.make(yield* platform.randomId)
        const now = yield* DateTime.nowAsDate
        const name = input.name ?? "New Chat"
        // A handoff continues the parent's work, so it stays in the parent's
        // thread. Every other create — including a spawn — starts its own,
        // which storage supplies by defaulting the thread to the session id.
        const session = new Session({
          id: sessionId,
          name,
          cwd: input.cwd,
          activeBranchId: branchId,
          parentSessionId: input.parentSessionId,
          parentBranchId: input.parentBranchId,
          threadId: Option.getOrUndefined(parentThread),
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
        for (const message of messages.slice(0, targetIndex + 1)) {
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
        yield* sessionStorage.updateSession(
          new Session({
            ...session,
            activeBranchId: input.toBranchId,
            updatedAt: yield* DateTime.nowAsDate,
          }),
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
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (Predicate.isUndefined(session)) return { renamed: false }
      if (session.name === trimmed) return { renamed: false }
      yield* transactWithEvent(
        sessionStorage.updateSession(
          new Session({
            ...session,
            name: trimmed,
            updatedAt: yield* DateTime.nowAsDate,
          }),
        ),
        SessionNameUpdated.make({ sessionId: input.sessionId, name: trimmed }),
      )
      return { renamed: true, name: trimmed }
    }),

    deleteSession: Effect.fn("SessionMutations.deleteSession")(function* (sessionId) {
      yield* deleteSessionCascade(sessionId)
    }),

    updateSettings: Effect.fn("SessionMutations.updateSettings")(function* (input) {
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (Predicate.isUndefined(session)) {
        return yield* new NotFoundError({ message: "Session not found" })
      }
      const settings = { modelId: input.modelId, reasoningLevel: input.reasoningLevel }
      const notice = yield* modelChangeNotice(session, Option.fromUndefinedOr(input.modelId))
      const updated = new Session({ ...session, ...settings, updatedAt: yield* DateTime.nowAsDate })
      yield* transactWithEvent(
        Effect.gen(function* () {
          yield* sessionStorage.updateSession(updated)
          if (Option.isSome(notice)) yield* messageStorage.createMessage(notice.value)
        }),
        SessionSettingsUpdated.make({ sessionId: input.sessionId, ...settings }),
        ...Option.match(notice, {
          onNone: () => [],
          onSome: (message) => [MessageReceived.make({ message })],
        }),
      )
      return settings
    }),
  } satisfies SessionMutationsService
})

export const SessionMutationsLive = Layer.effect(SessionMutations, makeSessionMutationsService)

// ── rpc-handlers ────────────────────────────────────────────────────────────

/** The registry serving a cwd: its profile's when a profile cache is wired, else the launch registry. */
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
        projectedMessages: projectMessagesWithToolInteractions(messages, toolCallDurations(events)),
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
  const registry = yield* resolveRegistryForCwd(Option.fromUndefinedOr(session.cwd))
  const configService = yield* ConfigService
  const config = yield* configService.get(session.cwd)
  const agent = Option.fromUndefinedOr(
    [...registry.getResolved().agents.values()].find((entry) => entry.name === runtime.agent),
  )
  const settings = resolveSessionSettings(
    Option.map(agent, (definition) =>
      applyAgentOverrides(definition, Option.fromUndefinedOr(config.agents?.[definition.name])),
    ),
    session,
  )

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

  const pendingRequestId = yield* approvalService.pendingRequestId(input)
  if (pendingRequestId !== input.requestId) {
    let message = "Interaction response requestId does not match the pending request"
    if (Predicate.isUndefined(pendingRequestId)) {
      message = "No pending interaction request exists for this session branch"
    }
    return yield* new InteractionRequestMismatchError({
      message,
      expectedRequestId: pendingRequestId,
      actualRequestId: input.requestId,
      sessionId: input.sessionId,
      branchId: input.branchId,
    })
  }

  const decision = {
    approved: input.approved,
    notes: input.notes,
    ...omitUndefined({ editedContent: input.editedContent }),
  }
  // 1. Store resolution durably so re-entering present() finds it
  yield* approvalService.storeResolution(input.requestId, decision)
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

const invalidateExternalDriversFor = (
  prev: Option.Option<DriverRef>,
  next: Option.Option<DriverRef>,
) =>
  Effect.gen(function* () {
    const registry = yield* DriverRegistry
    const ids = new Set<string>()
    if (Option.isSome(prev) && prev.value._tag === "External") ids.add(prev.value.id)
    if (Option.isSome(next) && next.value._tag === "External") ids.add(next.value.id)
    for (const id of ids) {
      const driver = yield* registry.getExternal(id)
      if (!Predicate.isUndefined(driver)) yield* driver.invalidate
    }
  })

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
    const modelRegistry = yield* ModelRegistry
    const authStore = yield* Auth
    const authGuard = yield* AuthGuard
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
    yield* RuntimeEnvironment
    yield* DriverRegistry

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
            agentOverride: input.agentOverride,
            runSpec: input.runSpec,
            requestId: input.requestId,
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

    const resolveSessionRegistry = (
      sessionId: Option.Option<string>,
    ): Effect.Effect<ExtensionRegistryService> =>
      Effect.gen(function* () {
        if (Option.isNone(sessionId)) return yield* resolveRegistryForCwd(Option.none())
        const session = yield* loadSession(sessionId.value)
        const cwd = Option.flatMap(session, (value) => Option.fromUndefinedOr(value.cwd))
        return yield* resolveRegistryForCwd(cwd)
      }).pipe(Effect.provideService(ExtensionRegistry, extensionRegistry))

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
        rpc("steer.command", sessionRuntime.steer(command), () => ({
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
      "model.list": () => modelRegistry.list,

      "driver.list": () =>
        Effect.gen(function* () {
          const config = yield* configService.get()
          const driverRegistry = yield* DriverRegistry
          const models = yield* driverRegistry.listModels
          const externals = yield* driverRegistry.listExternal
          const agents = [...extensionRegistry.getResolved().agents.values()]
          const drivers = [
            ...models.map((driver) =>
              DriverInfo.cases.Model.make({
                id: driver.id,
              }),
            ),
            ...externals.map((driver) =>
              DriverInfo.cases.External.make({
                id: driver.id,
              }),
            ),
          ]
          const overrides = Option.getOrElse(
            Option.fromUndefinedOr(config.driverOverrides),
            () => ({}),
          )
          return new DriverListResult({
            drivers,
            overrides,
            agents,
          })
        }),

      "driver.set": ({ agentName, driver }: SetDriverOverrideInput) =>
        Effect.gen(function* () {
          const driverRegistry = yield* DriverRegistry
          if (driver._tag === "Model" && !Predicate.isUndefined(driver.id)) {
            const found = yield* driverRegistry.getModel(driver.id)
            if (Predicate.isUndefined(found)) {
              return yield* new NotFoundError({
                message: `Unknown model driver "${driver.id}"`,
              })
            }
          }
          if (driver._tag === "External") {
            const found = yield* driverRegistry.getExternal(driver.id)
            if (Predicate.isUndefined(found)) {
              return yield* new NotFoundError({
                message: `Unknown external driver "${driver.id}"`,
              })
            }
          }

          const prevConfig = yield* configService.get()
          const prevOverride = prevConfig.driverOverrides?.[agentName]
          yield* configService.setDriverOverride(agentName, driver)
          yield* invalidateExternalDriversFor(
            Option.fromUndefinedOr(prevOverride),
            Option.some(driver),
          )
        }),

      "driver.clear": ({ agentName }: ClearDriverOverrideInput) =>
        Effect.gen(function* () {
          const prevConfig = yield* configService.get()
          const prevOverride = prevConfig.driverOverrides?.[agentName]
          yield* configService.clearDriverOverride(agentName)
          yield* invalidateExternalDriversFor(Option.fromUndefinedOr(prevOverride), Option.none())
        }),

      "auth.listProviders": ({ agentName, sessionId }: ListAuthProvidersPayload) =>
        Effect.gen(function* () {
          let cwd = Option.none<string>()
          if (!Predicate.isUndefined(sessionId)) {
            const session = yield* sessionStorage.getSession(SessionId.make(sessionId))
            if (Predicate.isUndefined(session)) {
              return yield* new NotFoundError({
                message: "Session not found",
              })
            }
            cwd = Option.fromUndefinedOr(session.cwd)
          }
          const config = yield* configService.get(Option.getOrUndefined(cwd))
          const providerScope = {
            agentName,
            sessionId,
            driverOverrides: config.driverOverrides,
          }
          return yield* authGuard
            .listProviders(providerScope)
            .pipe(Effect.mapError((error) => authPersistenceError("read", "*", error)))
        }),

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
          const registry = yield* resolveSessionRegistry(Option.fromUndefinedOr(sessionId))
          const activationStatuses = registry.getResolved().extensionStatuses
          return buildExtensionHealthSnapshot(activationStatuses)
        }),

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
        }),

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
  disabledExtensions?: ReadonlyArray<string>
  /** A failed extension fails the profile build. Test roots set it; production leaves one broken extension out and runs. */
  failOnExtensionFailure?: boolean
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

const platformServicesLive = Layer.provideMerge(
  Layer.mergeAll(
    Layer.effect(FileSystem.FileSystem, Effect.service(FileSystem.FileSystem)),
    Layer.effect(Path.Path, Effect.service(Path.Path)),
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
    platform: config.platform,
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
        disabledExtensions: config.disabledExtensions,
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
          Layer.succeed(DriverRegistry, profile.driverRegistryService),
          Layer.succeedContext(profile.layerContext),
        )
      }),
    ),
    Layer.merge(storageLive, Layer.merge(sessionProfileCacheLive, platformServicesLive)),
  )
  const modelRegistryLive =
    config.overrides?.modelRegistryLayer ??
    Layer.provide(ModelRegistry.Live, Layer.mergeAll(extensionRegistryLive, authLive))
  const authDeps = Layer.mergeAll(authLive, extensionRegistryLive)
  const authGuardLive = Layer.provide(AuthGuard.Live, authDeps)
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
      authGuardLive,
      providerAuthLive,
      configServiceLive,
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

      const workspaces = yield* interactionStore.listPendingWorkspaces
      for (const workspaceId of workspaces) {
        yield* Effect.gen(function* () {
          const pending = yield* interactionStore.listPending()
          if (pending.length === 0) return

          let recovered = 0
          for (const record of pending) {
            const params = yield* decodeInteractionParams(record.paramsJson).pipe(Effect.option)
            if (Option.isNone(params)) continue
            let decision = Option.none<ApprovalDecision>()
            if (!Predicate.isUndefined(record.decisionJson)) {
              decision = yield* decodeInteractionDecision(record.decisionJson).pipe(Effect.option)
            }
            yield* approvalService
              .rehydrate(
                record.requestId,
                params.value,
                {
                  sessionId: record.sessionId,
                  branchId: record.branchId,
                },
                Option.getOrUndefined(decision),
              )
              .pipe(Effect.catchEager(() => Effect.void))
            if (Option.isSome(decision)) {
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
