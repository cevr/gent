/**
 * `AgentLoop` as `Actor.fromEntity`.
 *
 * Replaces the per-(sessionId, branchId) hand-rolled fiber map +
 * `LoopState` `TaggedEnumClass` + actor mailbox persistence
 * (C5.4 moves the loop body, C5.5 replaces `runTurnFiber` with
 * `LanguageModel.streamText`).
 *
 * **Op surface (C5.1-followup counsel):** request/reply only.
 * `Subscribe` and `Snapshot` are NOT actor ops:
 * - `Actor.fromEntity` is request/reply; `OperationHandle.watch` is
 *   polling status, not a live state stream.
 * - State subscription stays as the existing `TxSubscriptionRef` exposed
 *   via `SessionRuntime` (or `Actor.withProtocol` later if encore grows
 *   streaming-RPC support).
 *
 * **Entity ID** keys per `(sessionId, branchId)` so all ops for one
 * branch land in the same FIFO mailbox (preserves serialization).
 *
 * **Single source of truth for routing** (C5.2 counsel): for ops that
 * carry a domain payload owning its own `(sessionId, branchId)`,
 * top-level routing fields are dropped — the embedded payload IS the
 * authority. Only `Interrupt` (no embedded payload) carries explicit
 * target fields.
 *
 * **Primary key (dedup)** per op:
 * - `Submit` / `QueueFollowUp` — `message.id`
 * - `Steer` — `commandId`
 * - `Interrupt` — `commandId`
 *
 * Schemas reuse gent's existing domain (`Message`, `RunSpec`,
 * `SteerCommand`) rather than introducing a parallel envelope shape.
 *
 * @module
 */

import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
  TxSubscriptionRef,
  Layer,
  Option,
} from "effect"
import { ShardingConfig } from "effect/unstable/cluster"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Actor } from "effect-encore"
import { AgentName, RunSpecSchema } from "../../domain/agent.js"
import { DEFAULTS } from "../../domain/defaults.js"
import { Message, type MessageMetadata } from "../../domain/message.js"
import { QueueSnapshot } from "../../domain/queue.js"
import {
  ActorCommandId,
  BranchId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "../../domain/ids.js"
import { SteerCommand } from "../../domain/steer.js"
import { GentPlatform } from "../gent-platform.js"
import { CurrentWorkspaceId } from "../../server/workspace-rpc.js"
import {
  AgentLoopError,
  assistantMessageIdForCommand,
  interjectionMessageIdForCommand,
  toolCallIdForCommand,
  toolResultMessageIdForCommand,
  toolResultMessageIdForToolCall,
} from "./agent-loop.commands.js"
import {
  appendFollowUpQueueState,
  appendSteeringItem,
  buildRunningState,
  countQueuedFollowUps,
  emptyLoopQueueState,
  projectRuntimeState,
  queueSnapshotFromQueueState,
  SessionRuntimeStateSchema,
  takeNextQueuedTurn,
  type AgentLoopState,
  type QueuedTurnItem,
} from "./agent-loop.state.js"
import {
  type AgentLoopBehavior,
  causeToAgentLoopError,
  interruptActiveStream,
  makeAgentLoopBehavior,
} from "./agent-loop.behavior.js"
import { AgentLoopBehaviorDeps } from "./agent-loop.behavior-deps.js"
import { entityIdOf, parseEntityId } from "./agent-loop.entity-id.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import { invokeTool, recordToolResult } from "./turn-helpers.js"

const WorkspaceFields = {
  workspaceId: Schema.String,
}

const TurnSubmissionFields = {
  ...WorkspaceFields,
  message: Message,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
}

const SteerFields = {
  ...WorkspaceFields,
  commandId: ActorCommandId,
  command: SteerCommand,
}

const InterruptFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const RespondInteractionFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  requestId: InteractionRequestId,
}

const DrainQueueFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const GetQueueFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
}

const GetStateFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
}

const RecordToolResultFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: Schema.optional(ActorCommandId),
  toolCallId: ToolCallId,
  toolName: Schema.String,
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
}

const InvokeToolFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
  toolName: Schema.String,
  input: Schema.Unknown,
}

/**
 * `EnsureStarted` materializes the entity and registers state without
 * performing any other work. Cold `watchState` callers send this before
 * subscribing to the registry's TxSubscriptionRef so the entity exists when
 * their watcher attaches.
 */
const EnsureStartedFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
}

/**
 * `TerminateBranch` shuts down a single branch's loop. Distinct from
 * generic `Interrupt` (which only flushes pending mailbox items) because
 * session termination semantically closes branch resources and must run
 * inside the entity's own scope. Used by `AgentLoopSessionGovernance`-driven
 * `terminateSession` sweeps.
 */
const TerminateBranchFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
}

type MessageType = Schema.Schema.Type<typeof Message>
type SteerCommandType = Schema.Schema.Type<typeof SteerCommand>

type WorkspaceInput = {
  readonly workspaceId: string
}
type TurnSubmissionInput = WorkspaceInput & { readonly message: MessageType }
type SteerInput = WorkspaceInput & {
  readonly commandId: ActorCommandId
  readonly command: SteerCommandType
}
type InterruptInput = {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type RespondInteractionInput = {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly requestId: InteractionRequestId
}
type DrainQueueInput = {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type GetQueueInput = {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
}
type GetStateInput = {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
}
type RecordToolResultInput = {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId?: ActorCommandId
  readonly toolCallId: ToolCallId
  readonly toolName: string
  readonly output: unknown
  readonly isError?: boolean
}
type InvokeToolInput = {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
  readonly toolName: string
  readonly input: unknown
}
type EnsureStartedInput = {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
}
type TerminateBranchInput = {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
}
type HandlerRequest<Operation> = {
  readonly operation: Operation & { readonly _tag: string }
}

export const AgentLoop = Actor.fromEntity("AgentLoop", {
  Submit: {
    payload: TurnSubmissionFields,
    success: Schema.Void,
    error: AgentLoopError,
    persisted: true,
    id: (p: TurnSubmissionInput) => ({
      entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
      primaryKey: p.message.id,
    }),
  },
  Run: {
    payload: TurnSubmissionFields,
    success: Schema.Void,
    error: AgentLoopError,
    id: (p: TurnSubmissionInput) => ({
      entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
      primaryKey: p.message.id,
    }),
  },
  QueueFollowUp: {
    payload: TurnSubmissionFields,
    success: Schema.Void,
    error: AgentLoopError,
    persisted: true,
    id: (p: TurnSubmissionInput) => ({
      entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
      primaryKey: p.message.id,
    }),
  },
  Steer: {
    payload: SteerFields,
    success: Schema.Void,
    error: AgentLoopError,
    persisted: true,
    id: (p: SteerInput) => ({
      entityId: entityIdOf(p.workspaceId, p.command.sessionId, p.command.branchId),
      primaryKey: p.commandId,
    }),
  },
  Interrupt: {
    payload: InterruptFields,
    success: Schema.Void,
    error: AgentLoopError,
    persisted: true,
    id: (p: InterruptInput) => ({
      entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
      primaryKey: p.commandId,
    }),
  },
  RespondInteraction: {
    payload: RespondInteractionFields,
    success: Schema.Void,
    error: AgentLoopError,
    persisted: true,
    id: (p: RespondInteractionInput) => ({
      entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
      primaryKey: p.requestId,
    }),
  },
  // Queue drain is a mutating state transition; route it through the
  // branch-local actor so it serializes with the actor-owned queue.
  DrainQueue: {
    payload: DrainQueueFields,
    success: QueueSnapshot,
    error: AgentLoopError,
    id: (p: DrainQueueInput) => ({
      entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
      primaryKey: p.commandId,
    }),
  },
  GetQueue: {
    payload: GetQueueFields,
    success: QueueSnapshot,
    error: AgentLoopError,
    id: (p: GetQueueInput) => ({
      entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
      primaryKey: "get-queue",
    }),
  },
  GetState: {
    payload: GetStateFields,
    success: SessionRuntimeStateSchema,
    error: AgentLoopError,
    id: (p: GetStateInput) => ({
      entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
      primaryKey: "get-state",
    }),
  },
  // Mid-turn tool result. Dedup by toolCallId — replays of the same tool
  // call must collapse to one effect.
  RecordToolResult: {
    payload: RecordToolResultFields,
    success: Schema.Void,
    error: AgentLoopError,
    id: (p: RecordToolResultInput) => ({
      entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
      primaryKey: p.toolCallId,
    }),
  },
  // Programmatic tool invocation (server-driven). commandId is required
  // here (vs optional in the legacy command schema) because actor dedup
  // needs a deterministic primary key — callers that previously elided
  // commandId now generate one before sending.
  InvokeTool: {
    payload: InvokeToolFields,
    success: Schema.Void,
    error: AgentLoopError,
    id: (p: InvokeToolInput) => ({
      entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
      primaryKey: p.commandId,
    }),
  },
  // No-op materialization. Cold `watchState` callers send this before
  // subscribing to the registry's TxSubscriptionRef so the entity exists
  // (build runs, recovery completes, state is registered) when their
  // watcher attaches. Constant primaryKey collapses redundant calls.
  EnsureStarted: {
    payload: EnsureStartedFields,
    success: Schema.Void,
    error: AgentLoopError,
    id: (p: EnsureStartedInput) => ({
      entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
      primaryKey: "ensure-started",
    }),
  },
  // Branch-local shutdown. Used by session terminate sweeps to close a
  // single branch's loop resources from inside the entity's own scope.
  TerminateBranch: {
    payload: TerminateBranchFields,
    success: Schema.Void,
    error: AgentLoopError,
    id: (p: TerminateBranchInput) => ({
      entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
      primaryKey: "terminate-branch",
    }),
  },
})

const buildQueuedTurnItem = (operation: {
  readonly message: MessageType
  readonly agentOverride?: typeof AgentName.Type
  readonly runSpec?: typeof RunSpecSchema.Type
  readonly interactive?: boolean
}): QueuedTurnItem => ({
  message: operation.message,
  ...(operation.agentOverride !== undefined ? { agentOverride: operation.agentOverride } : {}),
  ...(operation.runSpec !== undefined ? { runSpec: operation.runSpec } : {}),
  ...(operation.interactive !== undefined ? { interactive: operation.interactive } : {}),
})

const waitForIdleAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* TxSubscriptionRef.get(behavior.loopRef)
    if (current.stateEpoch > baseline && current.state._tag === "Idle") return
    yield* TxSubscriptionRef.changesStream(behavior.loopRef).pipe(
      Stream.filter((state) => state.stateEpoch > baseline && state.state._tag === "Idle"),
      Stream.runHead,
    )
  })

const failTurnFailureState = (failure: { readonly error: unknown }) =>
  Effect.fail(
    Schema.is(AgentLoopError)(failure.error)
      ? failure.error
      : new AgentLoopError({
          message: "Agent loop turn failed",
          cause: failure.error,
        }),
  )

const waitForTurnFailureAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* TxSubscriptionRef.get(behavior.loopRef)
    if (current.turnFailure !== undefined && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
    const hasNewTurnFailure = (
      state: AgentLoopState,
    ): state is AgentLoopState & {
      readonly turnFailure: NonNullable<AgentLoopState["turnFailure"]>
    } => state.turnFailure !== undefined && state.turnFailure.epoch > baseline
    const next = yield* TxSubscriptionRef.changesStream(behavior.loopRef).pipe(
      Stream.filter(hasNewTurnFailure),
      Stream.runHead,
    )
    if (Option.isSome(next)) return yield* failTurnFailureState(next.value.turnFailure)
    return yield* new AgentLoopError({
      message: "Agent loop turn failure stream ended",
    })
  })

const failIfTurnFailedAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* TxSubscriptionRef.get(behavior.loopRef)
    if (current.turnFailure !== undefined && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
  })

/**
 * `Actor.toLayer` handler layer for `AgentLoop`.
 *
 * Per-(sessionId, branchId) loop ownership lives in the actor entity instance.
 * Encore exposes `CurrentAddress` while keeping that entity-provided service
 * out of the resulting layer requirements.
 */
const buildAgentLoopActorHandlers = Effect.gen(function* () {
  const rawDeps = yield* AgentLoopBehaviorDeps
  const sessionGovernance = yield* AgentLoopSessionGovernance
  const platform = yield* GentPlatform
  const addr = yield* Actor.CurrentAddress
  const { workspaceId, sessionId, branchId } = yield* parseEntityId(addr.entityId).pipe(
    Effect.orDie,
  )
  const withWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
  const workspaceEventStorage = {
    appendEvent: (event, options) =>
      withWorkspace(rawDeps.turnStorage.events.appendEvent(event, options)),
    listEvents: (input) => withWorkspace(rawDeps.turnStorage.events.listEvents(input)),
    getLatestEventId: (input) => withWorkspace(rawDeps.turnStorage.events.getLatestEventId(input)),
    getLatestEvent: (input) => withWorkspace(rawDeps.turnStorage.events.getLatestEvent(input)),
  } satisfies typeof rawDeps.turnStorage.events
  const workspaceMessageStorage = {
    createMessage: (message) => withWorkspace(rawDeps.messageStorage.createMessage(message)),
    createMessageIfAbsent: (message) =>
      withWorkspace(rawDeps.messageStorage.createMessageIfAbsent(message)),
    getMessage: (id) => withWorkspace(rawDeps.messageStorage.getMessage(id)),
    listMessages: (id) => withWorkspace(rawDeps.messageStorage.listMessages(id)),
    deleteMessages: (id, after) => withWorkspace(rawDeps.messageStorage.deleteMessages(id, after)),
    updateMessageTurnDuration: (id, duration) =>
      withWorkspace(rawDeps.messageStorage.updateMessageTurnDuration(id, duration)),
  } satisfies typeof rawDeps.messageStorage
  const workspaceQueueStorage = {
    getQueueState: (sessionId, branchId) =>
      withWorkspace(rawDeps.queueStorage.getQueueState(sessionId, branchId)),
    putQueueState: (sessionId, branchId, queue) =>
      withWorkspace(rawDeps.queueStorage.putQueueState(sessionId, branchId, queue)),
    clearQueueState: (sessionId, branchId) =>
      withWorkspace(rawDeps.queueStorage.clearQueueState(sessionId, branchId)),
  } satisfies typeof rawDeps.queueStorage
  const workspaceSessionStorage = {
    createSession: (session) => withWorkspace(rawDeps.sessionStorage.createSession(session)),
    getSession: (id) => withWorkspace(rawDeps.sessionStorage.getSession(id)),
    getLastSessionByCwd: (cwd) => withWorkspace(rawDeps.sessionStorage.getLastSessionByCwd(cwd)),
    listSessions: () => withWorkspace(rawDeps.sessionStorage.listSessions()),
    updateSession: (session) => withWorkspace(rawDeps.sessionStorage.updateSession(session)),
    deleteSession: (id) => withWorkspace(rawDeps.sessionStorage.deleteSession(id)),
  } satisfies typeof rawDeps.sessionStorage
  const workspaceEventPublisher = {
    append: (event) => withWorkspace(rawDeps.eventPublisher.append(event)),
    deliver: (envelope) => rawDeps.eventPublisher.deliver(envelope),
    publish: (event) => withWorkspace(rawDeps.eventPublisher.publish(event)),
  } satisfies typeof rawDeps.eventPublisher
  const workspaceTransaction = {
    withTransaction: (effect) =>
      rawDeps.turnStorage.transaction.withTransaction(withWorkspace(effect)),
  } satisfies typeof rawDeps.turnStorage.transaction
  const deps = {
    ...rawDeps,
    turnStorage: {
      transaction: workspaceTransaction,
      events: workspaceEventStorage,
      messages: workspaceMessageStorage,
      sessions: workspaceSessionStorage,
    },
    eventPublisher: workspaceEventPublisher,
    messageStorage: workspaceMessageStorage,
    queueStorage: workspaceQueueStorage,
    sessionStorage: workspaceSessionStorage,
  } satisfies typeof rawDeps
  const sideMutationSemaphore = yield* Semaphore.make(1)
  const closed = yield* Ref.make(false)
  const operationSeen = yield* Ref.make(false)

  let handle: AgentLoopBehavior
  let startupExit: Exit.Exit<void, AgentLoopError>

  const closeBehavior = (loop: AgentLoopBehavior) =>
    Effect.gen(function* () {
      if (yield* Ref.get(closed)) return
      yield* Ref.set(closed, true)
      yield* interruptActiveStream(loop.activeStreamRef)
      yield* Deferred.succeed(loop.closed, undefined).pipe(Effect.ignore)
      yield* Scope.close(loop.scope, Exit.void)
    }).pipe(Effect.ignore)

  const cleanupLoop = (loop: AgentLoopBehavior) => closeBehavior(loop)

  const currentRuntimeState = (loop: AgentLoopBehavior) =>
    TxSubscriptionRef.get(loop.loopRef).pipe(Effect.map(projectRuntimeState))

  const hasPriorMessageHistory = Effect.gen(function* () {
    const messages = yield* deps.messageStorage
      .listMessages(branchId)
      .pipe(Effect.catchEager(() => Effect.succeed([])))
    return messages.some((message) => message.sessionId === sessionId)
  })

  const latestIncompleteUserTurn = Effect.gen(function* () {
    const envelopes = yield* deps.turnStorage.events
      .listEvents({ sessionId, branchId })
      .pipe(Effect.catchEager(() => Effect.succeed([])))
    const completed = new Set(
      envelopes.flatMap((envelope) =>
        envelope.event._tag === "TurnCompleted" && envelope.event.messageId !== undefined
          ? [envelope.event.messageId]
          : [],
      ),
    )
    const incomplete = envelopes.filter(
      (envelope) =>
        envelope.event._tag === "MessageReceived" &&
        envelope.event.message.role === "user" &&
        !completed.has(envelope.event.message.id),
    )
    const latest = incomplete[incomplete.length - 1]?.event
    return latest?._tag === "MessageReceived" ? latest.message : undefined
  })

  const hasIncompleteUserTurn = latestIncompleteUserTurn.pipe(
    Effect.map((message) => message !== undefined),
  )

  const startNextQueuedTurnIfIdle = Effect.gen(function* () {
    const start = yield* handle.queueMutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* TxSubscriptionRef.get(handle.loopRef)
        if (current.state._tag !== "Idle") return
        const queuedCreatedAt = yield* DateTime.nowAsDate
        const { queue, nextItem } = takeNextQueuedTurn(current.queue, queuedCreatedAt)
        yield* handle.persistQueueCurrentState(queue)
        return nextItem
      }),
    )
    if (start !== undefined) {
      yield* handle
        .startTurn(start)
        .pipe(
          Effect.catchEager((error) =>
            cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
          ),
        )
    }
  })

  const markWrite = Effect.gen(function* () {
    if (yield* sessionGovernance.isTerminated(workspaceId, sessionId)) {
      return yield* new AgentLoopError({
        message: `Session runtime terminated: ${sessionId}`,
      })
    }
    return yield* Ref.modify(operationSeen, (seen) => [seen, true] as const)
  })

  const rejectIfTerminated = Effect.gen(function* () {
    if (yield* sessionGovernance.isTerminated(workspaceId, sessionId)) {
      return yield* new AgentLoopError({
        message: `Session terminated: ${sessionId}`,
      })
    }
  })

  const ensureTarget = (target: { readonly sessionId: SessionId; readonly branchId: BranchId }) =>
    target.sessionId === sessionId && target.branchId === branchId
      ? Effect.void
      : Effect.fail(
          new AgentLoopError({
            message: `AgentLoop op target mismatch: entity=${sessionId}/${branchId} payload=${target.sessionId}/${target.branchId}`,
          }),
        )

  const enqueueMessage = Effect.fn("AgentLoopActor.enqueueMessage")(function* (input: {
    readonly message?: MessageType
    readonly content?: string
    readonly metadata?: MessageMetadata
  }) {
    const wasAlreadyWarm = yield* markWrite
    const message =
      input.message ??
      Message.Regular.make({
        id: MessageId.make(yield* platform.randomId),
        sessionId,
        branchId,
        role: "user",
        parts: [Prompt.textPart({ text: input.content ?? "" })],
        createdAt: yield* DateTime.nowAsDate,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      })

    yield* ensureTarget(message)
    const item = { message }
    const reservedStart = yield* handle.queueMutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentQueue = yield* TxSubscriptionRef.get(handle.loopRef).pipe(
          Effect.map((s) => s.queue),
        )
        if (countQueuedFollowUps(currentQueue) >= DEFAULTS.followUpQueueMax) {
          return yield* new AgentLoopError({
            message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
          })
        }
        if (!wasAlreadyWarm) {
          yield* handle.persistQueueState(appendFollowUpQueueState(currentQueue, item))
          return
        }
        const projectedState = yield* currentRuntimeState(handle)
        const startingState = yield* TxSubscriptionRef.get(handle.loopRef).pipe(
          Effect.map((s) => s.startingState),
        )
        if (startingState !== undefined) {
          yield* handle.persistQueueSnapshot(
            startingState,
            appendFollowUpQueueState(currentQueue, item),
          )
          return
        }
        if (projectedState._tag !== "Idle") {
          yield* handle.persistQueueCurrentState(appendFollowUpQueueState(currentQueue, item))
          return
        }
        const loopState = yield* TxSubscriptionRef.get(handle.loopRef).pipe(
          Effect.map((s) => s.state),
        )
        if (loopState._tag !== "Idle") {
          yield* handle.persistQueueCurrentState(appendFollowUpQueueState(currentQueue, item))
          return
        }
        const startedAtMs = yield* Clock.currentTimeMillis
        const reservedRunningState = buildRunningState(loopState, item, { startedAtMs })
        yield* TxSubscriptionRef.update(handle.loopRef, (s) => ({
          ...s,
          startingState: reservedRunningState,
        }))
        return reservedRunningState
      }),
    )
    if (reservedStart !== undefined) {
      yield* handle
        .startTurn(item)
        .pipe(
          Effect.catchEager((error) =>
            cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
          ),
        )
    }
    if (!wasAlreadyWarm) {
      if ((yield* hasIncompleteUserTurn) || (yield* hasPriorMessageHistory)) {
        yield* startNextQueuedTurnIfIdle
      }
      return
    }
  })

  const openLoop = Effect.gen(function* () {
    yield* Ref.set(closed, false)
    const initialQueueExit = yield* Effect.exit(
      deps.queueStorage.getQueueState(sessionId, branchId).pipe(
        Effect.mapError(
          (cause) =>
            new AgentLoopError({
              message: `Failed to load loop queue for ${sessionId}/${branchId}`,
              cause,
            }),
        ),
      ),
    )
    const initialQueue = Exit.isSuccess(initialQueueExit)
      ? initialQueueExit.value
      : emptyLoopQueueState()
    const initialQueueFailure = Exit.isFailure(initialQueueExit)
      ? new AgentLoopError({
          message: `Failed to load loop queue for ${sessionId}/${branchId}`,
          cause: initialQueueExit.cause,
        })
      : undefined
    if (initialQueueFailure !== undefined) {
      yield* Effect.logWarning("failed to load loop queue").pipe(
        Effect.annotateLogs({
          sessionId,
          branchId,
          error: initialQueueFailure.message,
        }),
      )
    }
    handle = yield* makeAgentLoopBehavior(
      {
        ...deps,
        enqueueFollowUp: (input) => enqueueMessage(input),
      },
      sessionId,
      branchId,
      sideMutationSemaphore,
      initialQueue,
    )
    if (initialQueueFailure !== undefined) {
      startupExit = Exit.fail(initialQueueFailure)
      return
    }

    startupExit = yield* Effect.exit(
      handle.start.pipe(
        Effect.andThen(handle.refreshRuntimeState),
        Effect.andThen(
          Effect.gen(function* () {
            const hasRecoveredQueue =
              initialQueue.steering.length > 0 || initialQueue.followUp.length > 0
            if (!hasRecoveredQueue) return
            if ((yield* hasIncompleteUserTurn) || (yield* hasPriorMessageHistory)) {
              yield* startNextQueuedTurnIfIdle
            }
          }),
        ),
      ),
    )
  })

  yield* withWorkspace(openLoop)
  yield* Effect.addFinalizer(() => cleanupLoop(handle))

  const ensureStarted = Effect.gen(function* () {
    if (yield* Ref.get(closed)) {
      yield* openLoop
    }
    if (Exit.isSuccess(startupExit)) return
    return yield* causeToAgentLoopError(startupExit.cause)
  })

  const currentRegisteredState = Effect.gen(function* () {
    yield* rejectIfTerminated
    yield* ensureStarted
    return yield* handle.queueMutationSemaphore.withPermits(1)(currentRuntimeState(handle))
  })

  const registeredStateChanges = Stream.unwrap(
    Effect.gen(function* () {
      yield* rejectIfTerminated
      yield* ensureStarted
      return TxSubscriptionRef.changesStream(handle.loopRef).pipe(
        Stream.map(projectRuntimeState),
        Stream.interruptWhen(Deferred.await(handle.closed)),
      )
    }),
  )

  yield* Actor.registerState({
    get: withWorkspace(currentRegisteredState),
    watch: registeredStateChanges.pipe(Stream.provideService(CurrentWorkspaceId, workspaceId)),
  })

  const submitTurn = Effect.fn("AgentLoopActor.submitTurn")(function* (
    operation: typeof AgentLoop.Submit.make extends (payload: infer P) => unknown ? P : never,
  ) {
    yield* ensureStarted
    yield* ensureTarget(operation.message)
    yield* markWrite
    const item = buildQueuedTurnItem(operation)
    const reservedStart = yield* handle.queueMutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const startingState = yield* TxSubscriptionRef.get(handle.loopRef).pipe(
          Effect.map((s) => s.startingState),
        )
        if (startingState !== undefined) {
          yield* handle.persistQueueSnapshot(
            startingState,
            appendFollowUpQueueState(
              yield* TxSubscriptionRef.get(handle.loopRef).pipe(Effect.map((s) => s.queue)),
              item,
            ),
          )
          return
        }
        const projectedState = yield* currentRuntimeState(handle)
        if (projectedState._tag !== "Idle") {
          const nextQueue = appendFollowUpQueueState(
            yield* TxSubscriptionRef.get(handle.loopRef).pipe(Effect.map((s) => s.queue)),
            item,
          )
          yield* handle.persistQueueCurrentState(nextQueue)
          return
        }
        const loopState = yield* TxSubscriptionRef.get(handle.loopRef).pipe(
          Effect.map((s) => s.state),
        )
        if (loopState._tag !== "Idle") {
          const nextQueue = appendFollowUpQueueState(
            yield* TxSubscriptionRef.get(handle.loopRef).pipe(Effect.map((s) => s.queue)),
            item,
          )
          yield* handle.persistQueueCurrentState(nextQueue)
          return
        }

        const startedAtMs = yield* Clock.currentTimeMillis
        const reservedRunningState = buildRunningState(loopState, item, { startedAtMs })
        yield* TxSubscriptionRef.update(handle.loopRef, (s) => ({
          ...s,
          startingState: reservedRunningState,
        }))
        return reservedRunningState
      }),
    )
    if (reservedStart !== undefined) {
      yield* handle
        .startTurn(item)
        .pipe(
          Effect.catchEager((error) =>
            cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
          ),
        )
    }
  })

  const runTurn = Effect.fn("AgentLoopActor.runTurn")(function* (
    operation: typeof AgentLoop.Run.make extends (payload: infer P) => unknown ? P : never,
  ) {
    yield* ensureStarted
    yield* ensureTarget(operation.message)
    yield* markWrite
    const item = buildQueuedTurnItem(operation)
    const start = yield* handle.queueMutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const initialState = yield* handle.snapshot
        if (initialState._tag !== "Idle") {
          const nextQueue = appendFollowUpQueueState(
            yield* TxSubscriptionRef.get(handle.loopRef).pipe(Effect.map((s) => s.queue)),
            item,
          )
          yield* handle.persistQueueState(nextQueue)
          return undefined
        }
        const current = yield* TxSubscriptionRef.get(handle.loopRef)
        return {
          stateEpochBaseline: current.stateEpoch,
          turnFailureBaseline: current.turnFailure?.epoch ?? 0,
        }
      }),
    )
    if (start === undefined) return

    yield* handle
      .startTurn(item)
      .pipe(
        Effect.catchEager((error) => cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error)))),
      )

    yield* Effect.raceFirst(
      Effect.raceFirst(
        waitForIdleAfterEpoch(handle, start.stateEpochBaseline),
        waitForTurnFailureAfterEpoch(handle, start.turnFailureBaseline),
      ),
      handle.persistenceFailure,
    ).pipe(
      Effect.catchEager((error) => cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error)))),
    )
    yield* failIfTurnFailedAfterEpoch(handle, start.turnFailureBaseline)
  })

  const applySteer = Effect.fn("AgentLoopActor.applySteer")(function* (
    commandId: ActorCommandId,
    command: SteerCommandType,
  ) {
    yield* ensureStarted
    yield* ensureTarget(command)
    yield* markWrite
    const projectedState = yield* currentRuntimeState(handle)

    switch (command._tag) {
      case "SwitchAgent":
        yield* handle
          .switchAgent(command.agent)
          .pipe(
            Effect.catchEager((error) =>
              cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
            ),
          )
        return

      case "Cancel":
      case "Interrupt":
        if (projectedState._tag === "Running" || projectedState._tag === "WaitingForInteraction") {
          yield* handle.interrupt.pipe(
            Effect.catchEager((error) =>
              cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
            ),
          )
          return
        }
        const loopState = yield* handle.snapshot
        if (loopState._tag === "Running" || loopState._tag === "WaitingForInteraction") {
          yield* handle.interrupt.pipe(
            Effect.catchEager((error) =>
              cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
            ),
          )
        }
        return

      case "Interject": {
        const interjectMessage = Message.Interjection.make({
          id: interjectionMessageIdForCommand(commandId),
          sessionId: command.sessionId,
          branchId: command.branchId,
          role: "user",
          parts: [Prompt.textPart({ text: command.message })],
          createdAt: yield* DateTime.nowAsDate,
        })
        const item: QueuedTurnItem = {
          message: interjectMessage,
          ...(command.agent !== undefined ? { agentOverride: command.agent } : {}),
        }
        const shouldInterrupt = yield* handle.queueMutationSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const nextQueue = appendSteeringItem(
              yield* TxSubscriptionRef.get(handle.loopRef).pipe(Effect.map((s) => s.queue)),
              item,
            )
            yield* handle.persistQueueState(nextQueue)
            const loopState = yield* handle.snapshot
            return projectedState._tag === "Running" || loopState._tag === "Running"
          }),
        )
        if (shouldInterrupt) {
          yield* interruptActiveStream(handle.activeStreamRef)
        }
        return
      }
    }
  })

  return {
    Submit: ({ operation }: HandlerRequest<Parameters<typeof submitTurn>[0]>) =>
      withWorkspace(submitTurn(operation)),
    Run: ({ operation }: HandlerRequest<Parameters<typeof runTurn>[0]>) =>
      withWorkspace(runTurn(operation)),
    QueueFollowUp: ({ operation }: HandlerRequest<TurnSubmissionInput>) =>
      withWorkspace(
        ensureStarted.pipe(Effect.andThen(enqueueMessage({ message: operation.message }))),
      ),
    Steer: ({ operation }: HandlerRequest<SteerInput>) =>
      withWorkspace(applySteer(operation.commandId, operation.command)),
    Interrupt: ({ operation }: HandlerRequest<InterruptInput>) =>
      withWorkspace(
        applySteer(
          operation.commandId,
          Schema.decodeSync(SteerCommand)({
            _tag: "Cancel",
            sessionId: operation.sessionId,
            branchId: operation.branchId,
          }),
        ),
      ),
    RespondInteraction: ({ operation }: HandlerRequest<RespondInteractionInput>) =>
      withWorkspace(
        ensureTarget(operation).pipe(
          Effect.andThen(markWrite),
          Effect.andThen(
            Effect.gen(function* () {
              const projectedState = yield* currentRuntimeState(handle)
              if (projectedState._tag !== "WaitingForInteraction") {
                const state = yield* handle.snapshot
                if (state._tag !== "WaitingForInteraction") {
                  if (state._tag !== "Idle") return
                  const message = yield* latestIncompleteUserTurn
                  if (message === undefined) return
                  const baseline = (yield* TxSubscriptionRef.get(handle.loopRef)).stateEpoch
                  yield* handle
                    .startTurn({ message })
                    .pipe(
                      Effect.catchEager((error) =>
                        cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
                      ),
                    )
                  yield* Effect.raceFirst(
                    waitForIdleAfterEpoch(handle, baseline),
                    waitForTurnFailureAfterEpoch(handle, baseline),
                  )
                  return
                }
              }
              yield* handle
                .respondInteraction(operation.requestId)
                .pipe(
                  Effect.catchEager((error) =>
                    cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
                  ),
                )
            }),
          ),
        ),
      ),
    DrainQueue: ({ operation }: HandlerRequest<DrainQueueInput>) =>
      withWorkspace(
        ensureTarget(operation).pipe(
          Effect.andThen(markWrite),
          Effect.andThen(ensureStarted),
          Effect.andThen(
            handle.queueMutationSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const queue = yield* TxSubscriptionRef.get(handle.loopRef).pipe(
                  Effect.map((s) => s.queue),
                )
                const snapshot = queueSnapshotFromQueueState(queue)
                yield* handle.persistQueueState(emptyLoopQueueState())
                return snapshot
              }),
            ),
          ),
        ),
      ),
    GetQueue: ({ operation }: HandlerRequest<GetQueueInput>) =>
      withWorkspace(
        ensureTarget(operation).pipe(
          Effect.andThen(rejectIfTerminated),
          Effect.andThen(ensureStarted),
          Effect.andThen(
            handle.queueMutationSemaphore.withPermits(1)(
              TxSubscriptionRef.get(handle.loopRef).pipe(
                Effect.map((s) => queueSnapshotFromQueueState(s.queue)),
              ),
            ),
          ),
        ),
      ),
    GetState: ({ operation }: HandlerRequest<GetStateInput>) =>
      withWorkspace(
        ensureTarget(operation).pipe(
          Effect.andThen(rejectIfTerminated),
          Effect.andThen(ensureStarted),
          Effect.andThen(
            handle.queueMutationSemaphore.withPermits(1)(
              TxSubscriptionRef.get(handle.loopRef).pipe(Effect.map(projectRuntimeState)),
            ),
          ),
        ),
      ),
    RecordToolResult: ({ operation }: HandlerRequest<RecordToolResultInput>) =>
      withWorkspace(
        ensureTarget(operation).pipe(
          Effect.andThen(markWrite),
          Effect.andThen(
            handle.sideMutationSemaphore.withPermits(1)(
              recordToolResult({
                storage: deps.turnStorage,
                eventPublisher: deps.eventPublisher,
                toolResultMessageId:
                  operation.commandId !== undefined
                    ? toolResultMessageIdForCommand(operation.commandId)
                    : toolResultMessageIdForToolCall(operation.toolCallId),
                sessionId: operation.sessionId,
                branchId: operation.branchId,
                toolCallId: operation.toolCallId,
                toolName: operation.toolName,
                output: operation.output,
                ...(operation.isError !== undefined ? { isError: operation.isError } : {}),
              }),
            ),
          ),
          Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))),
        ),
      ),
    InvokeTool: ({ operation }: HandlerRequest<InvokeToolInput>) =>
      withWorkspace(
        ensureTarget(operation).pipe(
          Effect.andThen(markWrite),
          Effect.andThen(
            handle.sideMutationSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const currentTurnAgent = (yield* currentRuntimeState(handle)).agent
                const environment = yield* handle.resolveTurnProfile
                yield* invokeTool({
                  assistantMessageId: assistantMessageIdForCommand(operation.commandId),
                  toolResultMessageId: toolResultMessageIdForCommand(operation.commandId),
                  toolCallId: toolCallIdForCommand(operation.commandId),
                  toolName: operation.toolName,
                  input: operation.input,
                  publishEvent: (event) =>
                    deps.eventPublisher.publish(event).pipe(Effect.catchEager(() => Effect.void)),
                  eventPublisher: deps.eventPublisher,
                  sessionId: operation.sessionId,
                  branchId: operation.branchId,
                  currentTurnAgent,
                  toolRunner: deps.toolRunner,
                  extensionRegistry: environment.turnExtensionRegistry,
                  permission: environment.turnPermission,
                  hostCtx: environment.turnHostCtx,
                  resourceManager: deps.resourceManager,
                  storage: deps.turnStorage,
                })
              }),
            ),
          ),
          Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))),
        ),
      ),
    EnsureStarted: ({ operation }: HandlerRequest<EnsureStartedInput>) =>
      withWorkspace(ensureTarget(operation).pipe(Effect.andThen(ensureStarted))),
    TerminateBranch: ({ operation }: HandlerRequest<TerminateBranchInput>) =>
      withWorkspace(
        ensureTarget(operation).pipe(
          Effect.andThen(sessionGovernance.markTerminated(workspaceId, sessionId)),
          Effect.andThen(cleanupLoop(handle)),
        ),
      ),
  }
})

export const AgentLoopLiveActor = Actor.toLayer(AgentLoop, buildAgentLoopActorHandlers, {
  // Long-lived ops (Submit/RunTurn) park inside the loop body via
  // actor-owned queue/side mutation gates. `concurrency: "unbounded"` keeps short ops
  // (RecordToolResult, RespondInteraction, Steer) from blocking the
  // mailbox behind a slow Submit.
  concurrency: "unbounded",
})

export const AgentLoopTestActor = Actor.toTestLayer(AgentLoop, buildAgentLoopActorHandlers, {
  // Match the production mailbox behavior used by AgentLoopLiveActor.
  concurrency: "unbounded",
}).pipe(Layer.provide(ShardingConfig.layerDefaults))
