/**
 * `AgentLoop` as `Actor.fromEntity`.
 *
 * Replaces the per-(sessionId, branchId) hand-rolled fiber map +
 * `LoopState` tagged union + actor mailbox persistence.
 *
 * **Op surface (C5.1-followup counsel):** request/reply only.
 * `Subscribe` and `Snapshot` are NOT actor ops:
 * - `Actor.fromEntity` is request/reply; `OperationHandle.watch` is
 *   polling status, not a live state stream.
 * - State subscription stays behavior-owned and is exposed through
 *   `Actor.registerState` (or `Actor.withProtocol` later if encore grows
 *   streaming-RPC support).
 *
 * **Entity ID** keys per `(sessionId, branchId)` so all ops for one branch
 * share an actor instance. Handler concurrency is intentionally unbounded;
 * behavior-owned queue and actor-owned semaphore serialize turn execution, durable queue,
 * and side-effect lanes.
 *
 * **Single source of truth for routing** (C5.2 counsel): for ops that
 * carry a domain payload owning its own `(sessionId, branchId)`,
 * top-level routing fields are dropped — the embedded payload IS the
 * authority. Only `Interrupt` (no embedded payload) carries explicit
 * target fields.
 *
 * **Execution id key** per op:
 * - `Submit` — `message.id` (live-only)
 * - `SubmitDurable` — `message.id` (persisted; actor owns request idempotency)
 * - `Run` / `QueueFollowUp` — `message.id` (live-only)
 * - `Steer` — `commandId` (persisted; actor owns request idempotency)
 * - `Interrupt` / `RespondInteraction` — durable persisted command key
 *
 * Schemas reuse gent's existing domain (`Message`, `RunSpec`,
 * `SteerCommand`) rather than introducing a parallel envelope shape.
 *
 * @module
 */

import { DateTime, Effect, Exit, Ref, Schema, Stream, Layer, Option, Semaphore } from "effect"
import { ShardingConfig } from "effect/unstable/cluster"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Actor, ActorStateRegistry } from "effect-encore"
import { AgentName, RunSpecSchema, type RunSpec } from "../../domain/agent.js"
import { Message, type MessageMetadata } from "../../domain/message.js"
import { QueueSnapshot } from "../../domain/queue.js"
import {
  ActorCommandId,
  BranchId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
  ToolName,
} from "../../domain/ids.js"
import { SteerCommand } from "../../domain/steer.js"
import { GentPlatform } from "../gent-platform.js"
import { CurrentWorkspaceId, WorkspaceId } from "../../server/workspace-rpc.js"
import type { PromptSection } from "../../domain/prompt.js"
import {
  assistantMessageIdForCommand,
  interjectionMessageIdForCommand,
  toolCallIdForCommand,
  toolResultMessageIdForCommand,
  toolResultMessageIdForToolCall,
} from "./agent-loop.utils.js"
import {
  AgentLoopError,
  emptyLoopQueueState,
  projectRuntimeState,
  SessionRuntimeStateSchema,
  type AgentLoopState,
  type QueuedTurnItem,
} from "./agent-loop.state.js"
import {
  type AgentLoopBehavior,
  causeToAgentLoopError,
  makeAgentLoopBehavior,
} from "./agent-loop.behavior.js"
import type { EventPublisher } from "../../domain/event-publisher.js"
import type { ToolRunner } from "./tool-runner.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { AgentLoopQueueStorage } from "../../storage/agent-loop-queue-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import type { SessionStorage } from "../../storage/session-storage.js"
import type { SqlClient } from "effect/unstable/sql"
import { entityIdOf, parseEntityId } from "./agent-loop.entity-id.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { Permission } from "../../domain/permission.js"
import { recordToolResult } from "./turn-persistence.js"
import { invokeTool } from "./turn-tool-execution.js"
import { provideCurrentHostCtx } from "./current-extension-host-context.js"

const WorkspaceFields = {
  workspaceId: WorkspaceId,
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
  commandId: ActorCommandId,
}

const GetStateFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const RecordToolResultFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: Schema.optional(ActorCommandId),
  toolCallId: ToolCallId,
  toolName: ToolName,
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
  commandId: ActorCommandId,
}

type MessageType = Schema.Schema.Type<typeof Message>
type SteerCommandType = Schema.Schema.Type<typeof SteerCommand>

type WorkspaceInput = {
  readonly workspaceId: WorkspaceId
}
type TurnSubmissionInput = WorkspaceInput & {
  readonly message: MessageType
  readonly agentOverride?: AgentName
  readonly runSpec?: RunSpec
  readonly interactive?: boolean
}
type SteerInput = WorkspaceInput & {
  readonly commandId: ActorCommandId
  readonly command: SteerCommandType
}
type InterruptInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type RespondInteractionInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly requestId: InteractionRequestId
}
type DrainQueueInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type GetQueueInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type GetStateInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type RecordToolResultInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId?: ActorCommandId
  readonly toolCallId: ToolCallId
  readonly toolName: ToolName
  readonly output: unknown
  readonly isError?: boolean
}
type InvokeToolInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
  readonly toolName: string
  readonly input: unknown
}
type TerminateBranchInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type HandlerRequest<Operation> = {
  readonly operation: Operation & { readonly _tag: string }
}

export const AgentLoop = Actor.fromEntity(
  "AgentLoop",
  {
    Submit: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: (p: TurnSubmissionInput) => ({
        entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
        primaryKey: p.message.id,
      }),
    },
    SubmitDurable: {
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
      persisted: true,
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
        primaryKey: p.commandId,
      }),
    },
    GetState: {
      payload: GetStateFields,
      success: SessionRuntimeStateSchema,
      error: AgentLoopError,
      id: (p: GetStateInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.commandId,
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
    // here (vs optional in the legacy command schema) because the actor
    // execution id needs a deterministic primary key — callers that previously
    // elided commandId now generate one before sending.
    InvokeTool: {
      payload: InvokeToolFields,
      success: Schema.Void,
      error: AgentLoopError,
      persisted: true,
      id: (p: InvokeToolInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.commandId,
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
        primaryKey: p.commandId,
      }),
    },
  },
  {
    state: {
      schema: SessionRuntimeStateSchema,
      error: AgentLoopError,
    },
  },
)

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
    const current = yield* behavior.readState
    if (current.stateEpoch > baseline && current.state._tag === "Idle") return
    yield* behavior.stateChanges.pipe(
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
    const current = yield* behavior.readState
    if (current.turnFailure !== undefined && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
    const hasNewTurnFailure = (
      state: AgentLoopState,
    ): state is AgentLoopState & {
      readonly turnFailure: NonNullable<AgentLoopState["turnFailure"]>
    } => state.turnFailure !== undefined && state.turnFailure.epoch > baseline
    const next = yield* behavior.stateChanges.pipe(Stream.filter(hasNewTurnFailure), Stream.runHead)
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
    const current = yield* behavior.readState
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
const buildAgentLoopActorHandlers = (config: {
  readonly baseSections: ReadonlyArray<PromptSection>
}) =>
  Effect.gen(function* () {
    const sideMutationSemaphore = yield* Semaphore.make(1)
    // Serializes per-entity `handle` rebuild. The actor mailbox is
    // `concurrency: "unbounded"`, so concurrent ops can both observe a
    // closed loop and race into `openLoop`, leaking the first behavior's
    // fibers and producing torn reads of `handle`/`startupExit`.
    const startupSemaphore = yield* Semaphore.make(1)
    const sessionGovernance = yield* AgentLoopSessionGovernance
    const platform = yield* GentPlatform
    const addr = yield* Actor.CurrentAddress
    const { workspaceId, sessionId, branchId } = yield* parseEntityId(addr.entityId).pipe(
      Effect.orDie,
    )
    // Storage Tags yield CurrentWorkspaceId internally — every reachable
    // call path is piped through `provideActorWorkspace` below, so storage
    // operations see the correct workspace from fiber context without any
    // per-method wrapping layer.
    const brandedWorkspaceId = workspaceId
    const provideActorWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(CurrentWorkspaceId, brandedWorkspaceId))
    const messageStorage = yield* MessageStorage
    const queueStorage = yield* AgentLoopQueueStorage
    const eventStorage = yield* EventStorage
    const closed = yield* Ref.make(false)
    const operationSeen = yield* Ref.make(false)

    // `handle` and `startupExit` were plain `let` bindings before C13.1. The
    // mailbox runs at `concurrency: "unbounded"`, so the post-flip window in
    // `openLoop` between `Ref.set(closed, false)` and the assignment of
    // `handle`/`startupExit` was racing: a fiber arriving via `ensureStarted`
    // could observe `closed=false`, skip the rebuild branch, and then read
    // a stale (now-closed) handle. Promoted to `Ref` and all reads happen
    // inside `ensureStarted` (which holds `startupSemaphore` across the
    // rebuild, the post-check, and the published handle return).
    const handleRef = yield* Ref.make<AgentLoopBehavior | undefined>(undefined)
    const startupExitRef = yield* Ref.make<Exit.Exit<void, AgentLoopError> | undefined>(undefined)

    // Holds `startupSemaphore` across the closed-flip + close so a
    // concurrent `openLoop` cannot observe a half-torn-down loop nor
    // publish a fresh handle while the old one is closing.
    const closeBehavior = (loop: AgentLoopBehavior) =>
      startupSemaphore
        .withPermits(1)(
          Effect.gen(function* () {
            if (yield* Ref.get(closed)) return
            yield* Ref.set(closed, true)
            yield* loop.close
          }),
        )
        .pipe(Effect.ignore)

    const cleanupLoop = (loop: AgentLoopBehavior) => closeBehavior(loop)

    const currentRuntimeState = (loop: AgentLoopBehavior) => loop.runtimeState

    // Typed reentrant-only handle lookup. The only legitimate caller is the
    // `enqueueFollowUp` callback wired into `makeAgentLoopBehavior` — it
    // fires from inside the behavior itself (during turn execution), so the
    // handle is provably published into `handleRef` by then. Mailbox
    // handlers (which arrive from outside the behavior) MUST go through
    // `ensureStarted` instead — that path holds `startupSemaphore` across
    // the rebuild/publish, ensuring no one observes a half-reopened loop.
    const reentrantHandle = Effect.gen(function* () {
      const value = yield* Ref.get(handleRef)
      if (value === undefined) {
        return yield* new AgentLoopError({
          message: `AgentLoop handle unavailable for ${sessionId}/${branchId}`,
        })
      }
      return value
    })

    const hasPriorMessageHistory = Effect.gen(function* () {
      const messages = yield* messageStorage
        .listMessages(branchId)
        .pipe(Effect.catchEager(() => Effect.succeed([])))
      return messages.some((message) => message.sessionId === sessionId)
    })

    const latestIncompleteUserTurn = Effect.gen(function* () {
      const envelopes = yield* eventStorage
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

    const startNextQueuedTurnIfIdle = (handle: AgentLoopBehavior) =>
      Effect.gen(function* () {
        const start = yield* handle.takeNextQueuedTurnIfIdle
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

    // Both call sites supply an already-resolved `handle`:
    //   - the reentrant callback wired into `makeAgentLoopBehavior` reads
    //     `reentrantHandle` lazily — the callback fires during turn
    //     execution (well after `openLoop` published `handleRef`), so the
    //     read is provably safe by then.
    //   - the `QueueFollowUp` mailbox handler resolves it via `ensureStarted`.
    // Taking it as a parameter eliminates the implicit two-step contract
    // that previously bypassed `ensureStarted` for non-reentrant callers.
    const enqueueMessage = Effect.fn("AgentLoopActor.enqueueMessage")(function* (
      handle: AgentLoopBehavior,
      input: {
        readonly message?: MessageType
        readonly content?: string
        readonly metadata?: MessageMetadata
        readonly agentOverride?: AgentName
        readonly runSpec?: RunSpec
        readonly interactive?: boolean
      },
    ) {
      const wasAlreadyWarm = yield* markWrite
      const message =
        input.message ??
        Message.cases.regular.make({
          id: MessageId.make(yield* platform.randomId),
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: input.content ?? "" })],
          createdAt: yield* DateTime.nowAsDate,
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        })

      yield* ensureTarget(message)
      const item = buildQueuedTurnItem({
        message,
        agentOverride: input.agentOverride,
        runSpec: input.runSpec,
        interactive: input.interactive,
      })
      const reservedStart = yield* handle.reserveStartOrQueueFollowUp(item, {
        coldQueueOnly: !wasAlreadyWarm,
      })
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
          yield* startNextQueuedTurnIfIdle(handle)
        }
        return
      }
    })

    const openLoop = Effect.gen(function* () {
      const initialQueueExit = yield* Effect.exit(
        queueStorage.getQueueState(sessionId, branchId).pipe(
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
      const handle = yield* makeAgentLoopBehavior(
        sessionId,
        branchId,
        sideMutationSemaphore,
        config.baseSections,
        // Reentrant follow-up from inside the behavior. The handle is
        // already published into `handleRef` by the time this callback
        // fires (it runs during turn execution, well after `openLoop`
        // assigns `handleRef`). `reentrantHandle` reads that publication.
        (input) => reentrantHandle.pipe(Effect.flatMap((h) => enqueueMessage(h, input))),
        initialQueue,
      )
      yield* Ref.set(handleRef, handle)
      if (initialQueueFailure !== undefined) {
        yield* Ref.set(startupExitRef, Exit.fail(initialQueueFailure))
        yield* Ref.set(closed, false)
        return
      }

      const exit = yield* Effect.exit(
        handle.start.pipe(
          Effect.andThen(handle.refreshRuntimeState),
          Effect.andThen(
            Effect.gen(function* () {
              const incompleteMessage = yield* latestIncompleteUserTurn
              if (incompleteMessage !== undefined) {
                yield* handle
                  .startTurn({ message: incompleteMessage })
                  .pipe(
                    Effect.catchEager((error) =>
                      cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
                    ),
                  )
                return
              }
              const hasRecoveredQueue =
                initialQueue.inFlight !== undefined ||
                initialQueue.steering.length > 0 ||
                initialQueue.followUp.length > 0
              if (!hasRecoveredQueue) return
              if (yield* hasPriorMessageHistory) {
                yield* startNextQueuedTurnIfIdle(handle)
              }
            }),
          ),
        ),
      )
      yield* Ref.set(startupExitRef, exit)
      // Publish `closed=false` only after both `handleRef` and
      // `startupExitRef` are visible. `ensureStarted` reads `closed`
      // before reading the handle/exit, so flipping it last guarantees a
      // fiber that sees `closed=false` will read the freshly-published
      // pair, not a stale one from a previous open cycle.
      yield* Ref.set(closed, false)
    })

    yield* openLoop.pipe(provideActorWorkspace)
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(handleRef), (loop) =>
        loop !== undefined ? cleanupLoop(loop) : Effect.void,
      ),
    )

    // Serialize the full read/rebuild/check path so concurrent ops cannot
    // observe a partially-rebuilt loop. `openLoop` writes `handleRef` and
    // `startupExitRef` and only flips `closed=false` after both are
    // published; `ensureStarted` then reads them inside the same permit
    // window and returns the handle directly so callers cannot read a
    // post-rebuild stale handle.
    const ensureStarted = startupSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) {
          yield* openLoop.pipe(provideActorWorkspace)
        }
        const exit = yield* Ref.get(startupExitRef)
        if (exit === undefined || Exit.isSuccess(exit)) {
          const handle = yield* Ref.get(handleRef)
          if (handle === undefined) {
            return yield* new AgentLoopError({
              message: `AgentLoop handle unavailable for ${sessionId}/${branchId}`,
            })
          }
          return handle
        }
        return yield* causeToAgentLoopError(exit.cause)
      }),
    )

    const currentRegisteredState = Effect.gen(function* () {
      yield* rejectIfTerminated
      const handle = yield* ensureStarted
      return yield* currentRuntimeState(handle)
    })

    const registeredStateChanges = Stream.unwrap(
      Effect.gen(function* () {
        yield* rejectIfTerminated
        const handle = yield* ensureStarted
        return handle.stateChanges.pipe(
          Stream.map(projectRuntimeState),
          Stream.interruptWhen(handle.awaitExit),
        )
      }),
    )

    yield* Actor.registerState({
      get: currentRegisteredState.pipe(provideActorWorkspace),
      watch: registeredStateChanges.pipe(
        Stream.provideService(CurrentWorkspaceId, brandedWorkspaceId),
      ),
    })

    const submitTurn = Effect.fn("AgentLoopActor.submitTurn")(function* (
      operation: TurnSubmissionInput,
    ) {
      const handle = yield* ensureStarted
      yield* ensureTarget(operation.message)
      yield* markWrite
      const item = buildQueuedTurnItem(operation)
      const reservedStart = yield* handle.reserveStartOrQueueFollowUp(item, {
        coldQueueOnly: false,
      })
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
      const handle = yield* ensureStarted
      yield* ensureTarget(operation.message)
      yield* markWrite
      const item = buildQueuedTurnItem(operation)
      const start = yield* handle.reserveRunStartOrQueueFollowUp(item)
      if (start === undefined) return

      yield* handle
        .startTurn(item)
        .pipe(
          Effect.catchEager((error) =>
            cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
          ),
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
      const handle = yield* ensureStarted
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
          if (
            projectedState._tag === "Running" ||
            projectedState._tag === "WaitingForInteraction"
          ) {
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
          const interjectMessage = Message.cases.interjection.make({
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
          const loopState = yield* handle.appendSteering(item)
          const shouldInterrupt = projectedState._tag === "Running" || loopState._tag === "Running"
          if (shouldInterrupt) {
            yield* handle.interruptActiveStream
          }
          return
        }
      }
    })

    return {
      Submit: Effect.fn("AgentLoop.Submit")(({ operation }: HandlerRequest<TurnSubmissionInput>) =>
        submitTurn(operation).pipe(provideActorWorkspace),
      ),
      SubmitDurable: Effect.fn("AgentLoop.SubmitDurable")(
        ({ operation }: HandlerRequest<TurnSubmissionInput>) =>
          submitTurn(operation).pipe(provideActorWorkspace),
      ),
      Run: Effect.fn("AgentLoop.Run")(
        ({ operation }: HandlerRequest<Parameters<typeof runTurn>[0]>) =>
          runTurn(operation).pipe(provideActorWorkspace),
      ),
      QueueFollowUp: Effect.fn("AgentLoop.QueueFollowUp")(function* ({
        operation,
      }: HandlerRequest<TurnSubmissionInput>) {
        yield* Effect.gen(function* () {
          const handle = yield* ensureStarted
          yield* enqueueMessage(handle, {
            message: operation.message,
            agentOverride: operation.agentOverride,
            runSpec: operation.runSpec,
            interactive: operation.interactive,
          })
        }).pipe(provideActorWorkspace)
      }),
      Steer: Effect.fn("AgentLoop.Steer")(({ operation }: HandlerRequest<SteerInput>) =>
        applySteer(operation.commandId, operation.command).pipe(provideActorWorkspace),
      ),
      Interrupt: Effect.fn("AgentLoop.Interrupt")(({ operation }: HandlerRequest<InterruptInput>) =>
        applySteer(
          operation.commandId,
          Schema.decodeSync(SteerCommand)({
            _tag: "Cancel",
            sessionId: operation.sessionId,
            branchId: operation.branchId,
            requestId: operation.commandId,
          }),
        ).pipe(provideActorWorkspace),
      ),
      RespondInteraction: Effect.fn("AgentLoop.RespondInteraction")(function* ({
        operation,
      }: HandlerRequest<RespondInteractionInput>) {
        yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* markWrite
          const handle = yield* ensureStarted
          const projectedState = yield* currentRuntimeState(handle)
          if (projectedState._tag !== "WaitingForInteraction") {
            const state = yield* handle.snapshot
            if (state._tag !== "WaitingForInteraction") {
              if (state._tag !== "Idle") return
              const message = yield* latestIncompleteUserTurn
              if (message === undefined) return
              const baseline = (yield* handle.readState).stateEpoch
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
        }).pipe(provideActorWorkspace)
      }),
      DrainQueue: Effect.fn("AgentLoop.DrainQueue")(function* ({
        operation,
      }: HandlerRequest<DrainQueueInput>) {
        return yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* markWrite
          const handle = yield* ensureStarted
          return yield* handle.drainQueue
        }).pipe(provideActorWorkspace)
      }),
      GetQueue: Effect.fn("AgentLoop.GetQueue")(function* ({
        operation,
      }: HandlerRequest<GetQueueInput>) {
        return yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* rejectIfTerminated
          const handle = yield* ensureStarted
          return yield* handle.queueSnapshot
        }).pipe(provideActorWorkspace)
      }),
      GetState: Effect.fn("AgentLoop.GetState")(function* ({
        operation,
      }: HandlerRequest<GetStateInput>) {
        return yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* rejectIfTerminated
          const handle = yield* ensureStarted
          return yield* handle.runtimeState
        }).pipe(provideActorWorkspace)
      }),
      RecordToolResult: Effect.fn("AgentLoop.RecordToolResult")(function* ({
        operation,
      }: HandlerRequest<RecordToolResultInput>) {
        yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* markWrite
          const handle = yield* ensureStarted
          yield* handle.withSideMutation(
            recordToolResult({
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
          )
        }).pipe(
          Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))),
          provideActorWorkspace,
        )
      }),
      InvokeTool: Effect.fn("AgentLoop.InvokeTool")(function* ({
        operation,
      }: HandlerRequest<InvokeToolInput>) {
        yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* markWrite
          const handle = yield* ensureStarted
          yield* handle.withSideMutation(
            Effect.gen(function* () {
              const currentTurnAgent = (yield* currentRuntimeState(handle)).agent
              const environment = yield* handle.resolveTurnProfile
              yield* invokeTool({
                assistantMessageId: assistantMessageIdForCommand(operation.commandId),
                toolResultMessageId: toolResultMessageIdForCommand(operation.commandId),
                toolCallId: toolCallIdForCommand(operation.commandId),
                toolName: operation.toolName,
                input: operation.input,
                sessionId: operation.sessionId,
                branchId: operation.branchId,
                currentTurnAgent,
              }).pipe(
                Effect.provideService(ExtensionRegistry, environment.turnExtensionRegistry),
                Effect.provideService(Permission, environment.turnPermission),
                provideCurrentHostCtx(environment.turnHostCtx),
              )
            }),
          )
        }).pipe(
          Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))),
          provideActorWorkspace,
        )
      }),
      TerminateBranch: Effect.fn("AgentLoop.TerminateBranch")(function* ({
        operation,
      }: HandlerRequest<TerminateBranchInput>) {
        yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* sessionGovernance.markTerminated(workspaceId, sessionId)
          // Lifecycle stop must not depend on the loop being open. If the
          // mailbox closed before we got here, `handleRef` may be empty;
          // skip cleanup in that case rather than triggering a rebuild
          // via `ensureStarted`.
          const handle = yield* Ref.get(handleRef)
          if (handle !== undefined) {
            yield* cleanupLoop(handle)
          }
        }).pipe(provideActorWorkspace)
      }),
    }
  })

/**
 * Layer-level services that the per-entity build effect needs from the
 * ephemeral layer-build context (NOT from Sharding's per-entity context).
 *
 * Excluded: services Sharding adds per-entity (`Actor.CurrentAddress`) and
 * `ActorStateRegistry` provided via outer `Layer.provideMerge` — those resolve
 * from Sharding's captured services context correctly.
 */
type AgentLoopBuildContext =
  | SessionStorage
  | MessageStorage
  | AgentLoopQueueStorage
  | EventStorage
  | SqlClient.SqlClient
  | EventPublisher
  | ToolRunner
  | AgentLoopSessionGovernance
  | GentPlatform

/**
 * Snapshots the layer-build-time `AgentLoopBuildContext` slice and provides
 * it into the per-entity build effect.
 *
 * Why: `Actor.toLayer(actor, build, opts)` does NOT propagate `build`'s
 * R-channel to the resulting layer. Sharding captures its `services` context
 * at registerEntity time and provides it into `build` per-entity. In an
 * ephemeral runtime composed with `Layer.provideMerge(child, parent)`, the
 * Sharding-captured context may resolve services from the parent layer
 * (closure-bound at Sharding-build time), bypassing the child layer's
 * overrides (e.g. ephemeral SQLite). Snapshotting the *current* layer-build
 * context for the storage/event-publisher/etc. slice and providing it into
 * the build via `Effect.provideContext` (which merges) makes every
 * `yield* Tag` for those slices resolve against this ephemeral context,
 * while per-entity services (`CurrentAddress`, `ActorStateRegistry`) still
 * come from Sharding's per-entity context.
 */
const provideLayerBuildContext = <A, E, R>(
  build: Effect.Effect<A, E, R>,
): Effect.Effect<
  Effect.Effect<A, E, Exclude<R, AgentLoopBuildContext>>,
  never,
  AgentLoopBuildContext
> =>
  Effect.context<AgentLoopBuildContext>().pipe(
    Effect.map(
      (ctx) =>
        Effect.provideContext(build, ctx) as Effect.Effect<A, E, Exclude<R, AgentLoopBuildContext>>,
    ),
  )

export const AgentLoopLiveActor = (config: {
  readonly baseSections: ReadonlyArray<PromptSection>
}) =>
  Layer.unwrap(
    provideLayerBuildContext(buildAgentLoopActorHandlers(config)).pipe(
      Effect.map((build) =>
        Actor.toLayer(AgentLoop, build, {
          // Long-lived turn execution is owned by AgentLoopBehavior's worker queue.
          // `concurrency: "unbounded"` keeps short ops (RecordToolResult,
          // RespondInteraction, Steer) from waiting on unrelated mailbox handlers.
          concurrency: "unbounded",
        }).pipe(Layer.provideMerge(ActorStateRegistry.Live)),
      ),
    ),
  )

export const AgentLoopTestActor = (config: {
  readonly baseSections: ReadonlyArray<PromptSection>
}) =>
  Layer.unwrap(
    provideLayerBuildContext(buildAgentLoopActorHandlers(config)).pipe(
      Effect.map((build) =>
        Actor.toTestLayer(AgentLoop, build, {
          // Match the production mailbox behavior used by AgentLoopLiveActor.
          concurrency: "unbounded",
        }).pipe(
          Layer.provideMerge(ActorStateRegistry.Live),
          Layer.provide(ShardingConfig.layerDefaults),
        ),
      ),
    ),
  )
