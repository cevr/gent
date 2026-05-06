/**
 * `AgentLoop` as `Actor.fromEntity`.
 *
 * Replaces the per-(sessionId, branchId) hand-rolled fiber map +
 * `LoopState` `TaggedEnumClass` + `agent_loop_checkpoints` table
 * (C5.3 migrates persistence, C5.4 moves the loop body, C5.5
 * replaces `runTurnFiber` with `LanguageModel.streamText`).
 *
 * **Op surface (C5.1-followup counsel):** request/reply only.
 * `Subscribe` and `Snapshot` are NOT actor ops:
 * - `Actor.fromEntity` is request/reply; `OperationHandle.watch` is
 *   polling status, not a live state stream.
 * - State subscription stays as the existing `SubscriptionRef` exposed
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
  SubscriptionRef,
  type Layer,
} from "effect"
import { CurrentAddress } from "effect/unstable/cluster/Entity"
import { Actor } from "effect-encore"
import { AgentName, RunSpecSchema } from "../../domain/agent.js"
import { DEFAULTS } from "../../domain/defaults.js"
import { Message, TextPart, type MessageMetadata } from "../../domain/message.js"
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
import {
  AgentLoopError,
  assistantMessageIdForCommand,
  commandIdForToolCall,
  toolCallIdForCommand,
  toolResultMessageIdForCommand,
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
  type QueuedTurnItem,
} from "./agent-loop.state.js"
import {
  LoopDriverEvent,
  type LoopHandle,
  awaitIdleStateSince,
  awaitTurnFailure,
  causeToAgentLoopError,
  failIfTurnFailedSince,
  interruptActiveStream,
  makeAgentLoopBehavior,
} from "./agent-loop.behavior.js"
import { AgentLoopBehaviorDeps } from "./agent-loop.behavior-deps.js"
import { entityIdOf, parseEntityId } from "./agent-loop.entity-id.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import { AgentLoopStateRegistry } from "./agent-loop.state-registry.js"
import { invokeToolPhase, recordToolResultPhase } from "./phases/turn.js"

const TurnSubmissionFields = {
  message: Message,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
}

const SteerFields = {
  commandId: ActorCommandId,
  command: SteerCommand,
}

const InterruptFields = {
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const RespondInteractionFields = {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: InteractionRequestId,
}

const DrainQueueFields = {
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const GetQueueFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

const GetStateFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

const RecordToolResultFields = {
  sessionId: SessionId,
  branchId: BranchId,
  commandId: Schema.optional(ActorCommandId),
  toolCallId: ToolCallId,
  toolName: Schema.String,
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
}

const InvokeToolFields = {
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
  toolName: Schema.String,
  input: Schema.Unknown,
}

/**
 * `EnsureStarted` materializes the entity (runs build, recovers checkpoint,
 * registers state) without performing any other work. Cold `watchState`
 * callers send this before subscribing to the registry's SubscriptionRef so
 * the entity exists when their watcher attaches.
 */
const EnsureStartedFields = {
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
  sessionId: SessionId,
  branchId: BranchId,
}

type MessageType = Schema.Schema.Type<typeof Message>
type SteerCommandType = Schema.Schema.Type<typeof SteerCommand>

type TurnSubmissionInput = { readonly message: MessageType }
type SteerInput = { readonly commandId: ActorCommandId; readonly command: SteerCommandType }
type InterruptInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type RespondInteractionInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly requestId: InteractionRequestId
}
type DrainQueueInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type GetQueueInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}
type GetStateInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}
type RecordToolResultInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly toolCallId: ToolCallId
}
type InvokeToolInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type EnsureStartedInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}
type TerminateBranchInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

export const AgentLoop = Actor.fromEntity("AgentLoop", {
  Submit: {
    payload: TurnSubmissionFields,
    error: AgentLoopError,
    id: (p: TurnSubmissionInput) => ({
      entityId: entityIdOf(p.message.sessionId, p.message.branchId),
      primaryKey: p.message.id,
    }),
  },
  Run: {
    payload: TurnSubmissionFields,
    error: AgentLoopError,
    id: (p: TurnSubmissionInput) => ({
      entityId: entityIdOf(p.message.sessionId, p.message.branchId),
      primaryKey: p.message.id,
    }),
  },
  QueueFollowUp: {
    payload: TurnSubmissionFields,
    error: AgentLoopError,
    id: (p: TurnSubmissionInput) => ({
      entityId: entityIdOf(p.message.sessionId, p.message.branchId),
      primaryKey: p.message.id,
    }),
  },
  Steer: {
    payload: SteerFields,
    error: AgentLoopError,
    id: (p: SteerInput) => ({
      entityId: entityIdOf(p.command.sessionId, p.command.branchId),
      primaryKey: p.commandId,
    }),
  },
  Interrupt: {
    payload: InterruptFields,
    error: AgentLoopError,
    id: (p: InterruptInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: p.commandId,
    }),
  },
  RespondInteraction: {
    payload: RespondInteractionFields,
    error: AgentLoopError,
    id: (p: RespondInteractionInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
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
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: p.commandId,
    }),
  },
  GetQueue: {
    payload: GetQueueFields,
    success: QueueSnapshot,
    error: AgentLoopError,
    id: (p: GetQueueInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: "get-queue",
    }),
  },
  GetState: {
    payload: GetStateFields,
    success: SessionRuntimeStateSchema,
    error: AgentLoopError,
    id: (p: GetStateInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: "get-state",
    }),
  },
  // Mid-turn tool result. Dedup by toolCallId — replays of the same tool
  // call must collapse to one effect.
  RecordToolResult: {
    payload: RecordToolResultFields,
    error: AgentLoopError,
    id: (p: RecordToolResultInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: p.toolCallId,
    }),
  },
  // Programmatic tool invocation (server-driven). commandId is required
  // here (vs optional in the legacy command schema) because actor dedup
  // needs a deterministic primary key — callers that previously elided
  // commandId now generate one before sending.
  InvokeTool: {
    payload: InvokeToolFields,
    error: AgentLoopError,
    id: (p: InvokeToolInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: p.commandId,
    }),
  },
  // No-op materialization. Cold `watchState` callers send this before
  // subscribing to the registry's SubscriptionRef so the entity exists
  // (build runs, recovery completes, state is registered) when their
  // watcher attaches. Constant primaryKey collapses redundant calls.
  EnsureStarted: {
    payload: EnsureStartedFields,
    error: AgentLoopError,
    id: (p: EnsureStartedInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: "ensure-started",
    }),
  },
  // Branch-local shutdown. Used by session terminate sweeps to close a
  // single branch's loop resources from inside the entity's own scope.
  TerminateBranch: {
    payload: TerminateBranchFields,
    error: AgentLoopError,
    id: (p: TerminateBranchInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: "terminate-branch",
    }),
  },
})

type WithoutCurrentAddress<L> =
  L extends Layer.Layer<infer ROut, infer E, infer RIn>
    ? Layer.Layer<ROut, E, Exclude<RIn, CurrentAddress>>
    : never

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

/**
 * `Actor.toLayer` handler layer for `AgentLoop`.
 *
 * C5.4.4.c.1.b transfers per-(sessionId, branchId) loop ownership from the
 * legacy `AgentLoop.Live` map into the actor entity instance. Upstream
 * `Entity.CurrentAddress` is available inside the underlying cluster entity
 * build; effect-encore does not re-export it, so import from Effect directly.
 */
const AgentLoopLiveActorLayer = Actor.toLayer(
  AgentLoop,
  Effect.gen(function* () {
    const deps = yield* AgentLoopBehaviorDeps
    const stateRegistry = yield* AgentLoopStateRegistry
    const sessionGovernance = yield* AgentLoopSessionGovernance
    const platform = yield* GentPlatform
    const addr = yield* CurrentAddress
    const { sessionId, branchId } = yield* parseEntityId(addr.entityId).pipe(Effect.orDie)
    const sideMutationSemaphore = yield* Semaphore.make(1)
    const closed = yield* Ref.make(false)
    const operationSeen = yield* Ref.make(false)

    let handle: LoopHandle

    const closeLoopHandle = (loop: LoopHandle) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return
        yield* Ref.set(closed, true)
        yield* interruptActiveStream(loop.activeStreamRef)
        yield* Deferred.succeed(loop.closed, undefined).pipe(Effect.ignore)
        yield* Scope.close(loop.scope, Exit.void)
      }).pipe(Effect.ignore)

    const cleanupLoop = (loop: LoopHandle) =>
      stateRegistry
        .deregister(sessionId, branchId, loop.loopRef)
        .pipe(Effect.andThen(closeLoopHandle(loop)), Effect.ignore)

    const currentRuntimeState = (loop: LoopHandle) =>
      SubscriptionRef.get(loop.loopRef).pipe(Effect.map(projectRuntimeState))

    const markWrite = Effect.gen(function* () {
      if (yield* sessionGovernance.isTerminated(sessionId)) {
        return yield* new AgentLoopError({
          message: `Session runtime terminated: ${sessionId}`,
        })
      }
      return yield* Ref.modify(operationSeen, (seen) => [seen, true] as const)
    })

    const rejectIfTerminated = Effect.gen(function* () {
      if (yield* sessionGovernance.isTerminated(sessionId)) {
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
          parts: [new TextPart({ type: "text", text: input.content ?? "" })],
          createdAt: yield* DateTime.nowAsDate,
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        })

      yield* ensureTarget(message)
      const item = { message }
      const reservedStart = yield* handle.queueMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const currentQueue = yield* SubscriptionRef.get(handle.loopRef).pipe(
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
          const startingState = yield* SubscriptionRef.get(handle.loopRef).pipe(
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
          const loopState = yield* SubscriptionRef.get(handle.loopRef).pipe(
            Effect.map((s) => s.state),
          )
          if (loopState._tag !== "Idle") {
            yield* handle.persistQueueCurrentState(appendFollowUpQueueState(currentQueue, item))
            return
          }
          const startedAtMs = yield* Clock.currentTimeMillis
          const reservedRunningState = buildRunningState(loopState, item, { startedAtMs })
          yield* SubscriptionRef.update(handle.loopRef, (s) => ({
            ...s,
            startingState: reservedRunningState,
          }))
          return reservedRunningState
        }),
      )
      if (reservedStart !== undefined) {
        yield* handle
          .dispatch(LoopDriverEvent.Start.make({ item }))
          .pipe(
            Effect.catchEager((error) =>
              cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
            ),
          )
      }
    })

    handle = yield* makeAgentLoopBehavior(
      {
        ...deps,
        enqueueFollowUp: (input) => enqueueMessage(input),
      },
      sessionId,
      branchId,
      sideMutationSemaphore,
      emptyLoopQueueState(),
    )

    yield* stateRegistry.register(sessionId, branchId, {
      loopRef: handle.loopRef,
      queueMutationSemaphore: handle.queueMutationSemaphore,
      persistQueueState: handle.persistQueueState,
      closed: handle.closed,
    })
    yield* Effect.addFinalizer(() => cleanupLoop(handle))
    const startupExit = yield* Effect.exit(
      handle.start.pipe(Effect.andThen(handle.refreshRuntimeState)),
    )
    const ensureStarted = Effect.suspend(() =>
      Exit.isSuccess(startupExit)
        ? Effect.void
        : Effect.fail(causeToAgentLoopError(startupExit.cause)),
    )

    const submitTurn = Effect.fn("AgentLoopActor.submitTurn")(function* (
      operation: typeof AgentLoop.Submit.make extends (payload: infer P) => unknown ? P : never,
    ) {
      yield* ensureStarted
      yield* ensureTarget(operation.message)
      yield* markWrite
      const item = buildQueuedTurnItem(operation)
      const reservedStart = yield* handle.queueMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const startingState = yield* SubscriptionRef.get(handle.loopRef).pipe(
            Effect.map((s) => s.startingState),
          )
          if (startingState !== undefined) {
            yield* handle.persistQueueSnapshot(
              startingState,
              appendFollowUpQueueState(
                yield* SubscriptionRef.get(handle.loopRef).pipe(Effect.map((s) => s.queue)),
                item,
              ),
            )
            return
          }
          const projectedState = yield* currentRuntimeState(handle)
          if (projectedState._tag !== "Idle") {
            const nextQueue = appendFollowUpQueueState(
              yield* SubscriptionRef.get(handle.loopRef).pipe(Effect.map((s) => s.queue)),
              item,
            )
            yield* handle.persistQueueCurrentState(nextQueue)
            return
          }
          const loopState = yield* SubscriptionRef.get(handle.loopRef).pipe(
            Effect.map((s) => s.state),
          )
          if (loopState._tag !== "Idle") {
            const nextQueue = appendFollowUpQueueState(
              yield* SubscriptionRef.get(handle.loopRef).pipe(Effect.map((s) => s.queue)),
              item,
            )
            yield* handle.persistQueueCurrentState(nextQueue)
            return
          }

          const startedAtMs = yield* Clock.currentTimeMillis
          const reservedRunningState = buildRunningState(loopState, item, { startedAtMs })
          yield* SubscriptionRef.update(handle.loopRef, (s) => ({
            ...s,
            startingState: reservedRunningState,
          }))
          return reservedRunningState
        }),
      )
      if (reservedStart !== undefined) {
        yield* handle
          .dispatch(LoopDriverEvent.Start.make({ item }))
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
              yield* SubscriptionRef.get(handle.loopRef).pipe(Effect.map((s) => s.queue)),
              item,
            )
            yield* handle.persistQueueState(nextQueue)
            return undefined
          }
          const current = yield* SubscriptionRef.get(handle.loopRef)
          return {
            stateEpochBaseline: current.stateEpoch,
            turnFailureBaseline: current.turnFailure?.epoch ?? 0,
          }
        }),
      )
      if (start === undefined) return

      yield* handle
        .dispatch(LoopDriverEvent.Start.make({ item }))
        .pipe(
          Effect.catchEager((error) =>
            cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
          ),
        )

      yield* Effect.raceFirst(
        Effect.raceFirst(
          awaitIdleStateSince(handle, start.stateEpochBaseline),
          awaitTurnFailure(handle, start.turnFailureBaseline),
        ),
        handle.persistenceFailure,
      ).pipe(
        Effect.catchEager((error) => cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error)))),
      )
      yield* failIfTurnFailedSince(handle, start.turnFailureBaseline)
    })

    const applySteer = Effect.fn("AgentLoopActor.applySteer")(function* (
      command: SteerCommandType,
    ) {
      yield* ensureStarted
      yield* ensureTarget(command)
      yield* markWrite
      const projectedState = yield* currentRuntimeState(handle)

      const wrapDispatch = (event: LoopDriverEvent) =>
        handle
          .dispatch(event)
          .pipe(
            Effect.catchEager((error) =>
              cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
            ),
          )

      switch (command._tag) {
        case "SwitchAgent":
          yield* wrapDispatch(LoopDriverEvent.SwitchAgent.make({ agent: command.agent }))
          return

        case "Cancel":
        case "Interrupt":
          if (
            projectedState._tag === "Running" ||
            projectedState._tag === "WaitingForInteraction"
          ) {
            yield* wrapDispatch(LoopDriverEvent.Interrupt.make({}))
            return
          }
          const loopState = yield* handle.snapshot
          if (loopState._tag === "Running" || loopState._tag === "WaitingForInteraction") {
            yield* wrapDispatch(LoopDriverEvent.Interrupt.make({}))
          }
          return

        case "Interject": {
          const interjectMessage = Message.Interjection.make({
            id: MessageId.make(yield* platform.randomId),
            sessionId: command.sessionId,
            branchId: command.branchId,
            role: "user",
            parts: [new TextPart({ type: "text", text: command.message })],
            createdAt: yield* DateTime.nowAsDate,
          })
          const item: QueuedTurnItem = {
            message: interjectMessage,
            ...(command.agent !== undefined ? { agentOverride: command.agent } : {}),
          }
          const shouldInterrupt = yield* handle.queueMutationSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const nextQueue = appendSteeringItem(
                yield* SubscriptionRef.get(handle.loopRef).pipe(Effect.map((s) => s.queue)),
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
      Submit: ({ operation }) => submitTurn(operation),
      Run: ({ operation }) => runTurn(operation),
      QueueFollowUp: ({ operation }) =>
        ensureStarted.pipe(Effect.andThen(enqueueMessage({ message: operation.message }))),
      Steer: ({ operation }) => applySteer(operation.command),
      Interrupt: ({ operation }) =>
        applySteer(
          Schema.decodeSync(SteerCommand)({
            _tag: "Cancel",
            sessionId: operation.sessionId,
            branchId: operation.branchId,
          }),
        ),
      RespondInteraction: ({ operation }) =>
        ensureTarget(operation).pipe(
          Effect.andThen(markWrite),
          Effect.andThen(
            Effect.gen(function* () {
              const projectedState = yield* currentRuntimeState(handle)
              if (projectedState._tag !== "WaitingForInteraction") {
                const state = yield* handle.snapshot
                if (state._tag !== "WaitingForInteraction") return
              }
              yield* handle
                .dispatch(
                  LoopDriverEvent.InteractionResponded.make({ requestId: operation.requestId }),
                )
                .pipe(
                  Effect.catchEager((error) =>
                    cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
                  ),
                )
            }),
          ),
        ),
      DrainQueue: ({ operation }) =>
        ensureTarget(operation).pipe(
          Effect.andThen(markWrite),
          Effect.andThen(ensureStarted),
          Effect.andThen(
            handle.queueMutationSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const queue = yield* SubscriptionRef.get(handle.loopRef).pipe(
                  Effect.map((s) => s.queue),
                )
                const snapshot = queueSnapshotFromQueueState(queue)
                yield* handle.persistQueueState(emptyLoopQueueState())
                return snapshot
              }),
            ),
          ),
        ),
      GetQueue: ({ operation }) =>
        ensureTarget(operation).pipe(
          Effect.andThen(rejectIfTerminated),
          Effect.andThen(ensureStarted),
          Effect.andThen(
            handle.queueMutationSemaphore.withPermits(1)(
              SubscriptionRef.get(handle.loopRef).pipe(
                Effect.map((s) => queueSnapshotFromQueueState(s.queue)),
              ),
            ),
          ),
        ),
      GetState: ({ operation }) =>
        ensureTarget(operation).pipe(
          Effect.andThen(rejectIfTerminated),
          Effect.andThen(ensureStarted),
          Effect.andThen(
            handle.queueMutationSemaphore.withPermits(1)(
              SubscriptionRef.get(handle.loopRef).pipe(Effect.map(projectRuntimeState)),
            ),
          ),
        ),
      RecordToolResult: ({ operation }) =>
        ensureTarget(operation).pipe(
          Effect.andThen(markWrite),
          Effect.andThen(
            handle.sideMutationSemaphore.withPermits(1)(
              recordToolResultPhase({
                storage: deps.turnStorage,
                eventPublisher: deps.eventPublisher,
                commandId: operation.commandId ?? commandIdForToolCall(operation.toolCallId),
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
      InvokeTool: ({ operation }) =>
        ensureTarget(operation).pipe(
          Effect.andThen(markWrite),
          Effect.andThen(
            handle.sideMutationSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const currentTurnAgent = (yield* currentRuntimeState(handle)).agent
                const environment = yield* handle.resolveTurnProfile
                yield* invokeToolPhase({
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
      EnsureStarted: ({ operation }) => ensureTarget(operation).pipe(Effect.andThen(ensureStarted)),
      TerminateBranch: ({ operation }) =>
        ensureTarget(operation).pipe(
          Effect.andThen(sessionGovernance.markTerminated(sessionId)),
          Effect.andThen(cleanupLoop(handle)),
        ),
    }
  }),
  {
    // Long-lived ops (Submit/RunTurn) park inside the loop body via
    // commandGate. `concurrency: "unbounded"` keeps short ops
    // (RecordToolResult, RespondInteraction, Steer) from blocking the
    // mailbox behind a slow Submit.
    concurrency: "unbounded",
  },
)

// effect-encore forwards to Effect Cluster, which provides CurrentAddress
// internally for entity handlers; its wrapper type does not yet exclude that
// internal requirement. Keep the cast at this boundary until encore's d.ts
// catches up with upstream Entity.toLayer.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- effect-encore's wrapper type leaks CurrentAddress even though Effect Cluster provides it inside Entity.toLayer.
export const AgentLoopLiveActor = AgentLoopLiveActorLayer as WithoutCurrentAddress<
  typeof AgentLoopLiveActorLayer
>
