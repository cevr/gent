import {
  Predicate,
  Cause,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
  type FileSystem,
  type Path,
  type Scope,
} from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type { MessageStorage as ClusterMessageStorage, Sharding } from "effect/unstable/cluster"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { SqlClient } from "effect/unstable/sql"
import { AgentName, AgentRunError, RunSpecSchema, type RunSpec } from "../domain/agent.js"
import type { QueueSnapshot } from "../domain/queue.js"
import type { EventStore } from "../domain/event.js"
import type { EventPublisher } from "../domain/event-publisher.js"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  MessageId,
  RequestId,
  SessionId,
  type InteractionRequestId,
} from "../domain/ids.js"
import { Message, MessageMetadata } from "../domain/message.js"
import type { PromptSection } from "../domain/prompt.js"
import type { AgentLoopQueueStorage } from "../storage/agent-loop-queue-storage.js"
import type { BranchStorage } from "../storage/branch-storage.js"
import type { EventStorage } from "../storage/event-storage.js"
import type { MessageStorage } from "../storage/message-storage.js"
import type { SessionStorage } from "../storage/session-storage.js"
import { AgentLoop as AgentLoopActor, AgentLoopLiveActor } from "./agent/agent-loop.actor.js"
import { entityIdOf, parseEntityId } from "./agent/agent-loop.entity-id.js"
import { AgentLoopSessionGovernance } from "./agent/agent-loop.session-governance.js"
import type { ExtensionRegistry } from "./extensions/registry.js"
import type { DriverRegistry } from "./extensions/driver-registry.js"
import type { ModelRegistry } from "./model-registry.js"
import type { ModelResolver } from "../providers/model-resolver.js"
import type { ApprovalService } from "./approval-service.js"
import { GentPlatform } from "./gent-platform.js"
import type { ToolRunner } from "./agent/tool-runner.js"
import type { ToolCallBindingStorage } from "../storage/tool-call-binding-storage.js"
import type { ConfigService } from "./config-service.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

const SESSION_TERMINATION_CONCURRENCY = 16
import type { SteerCommand as SteerCommandType } from "../domain/steer.js"
import { resolveExistingSessionBranch } from "./session-runtime-context.js"
import { AgentLoopError } from "./agent/agent-loop.state.js"
import type { SessionRuntimeMetrics, SessionRuntimeState } from "./agent/agent-loop.state.js"
export {
  SessionRuntimeMetrics,
  SessionRuntimeStateSchema,
  type SessionRuntimeState,
} from "./agent/agent-loop.state.js"

export class SessionRuntimeError extends Schema.TaggedError<SessionRuntimeError>()(
  "SessionRuntimeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const SessionRuntimeErrorSchema = SessionRuntimeError

export const SessionRuntimeTarget = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
export type SessionRuntimeTarget = typeof SessionRuntimeTarget.Type

/**
 * Client-generated request ID for end-to-end correlation + transport-retry
 * dedup. Bounded so a malicious/buggy client cannot bloat per-server
 * dedup caches keyed on it. Callers in this repo use `crypto.randomUUID()`.
 */
const FollowUpSourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const SendUserMessagePayload = Schema.Struct({
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  agentOverride: Schema.optional(AgentName),
  interactive: Schema.optional(Schema.Boolean),
  runSpec: Schema.optional(RunSpecSchema),
  /** Client-generated correlation id for end-to-end observability. */
  requestId: Schema.optional(RequestId),
})
export type SendUserMessagePayload = typeof SendUserMessagePayload.Type

export const CancelInterruptPayload = Schema.TaggedStruct("Cancel", {
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
})
export type CancelInterruptPayload = typeof CancelInterruptPayload.Type

export const InterruptTurnPayload = Schema.TaggedStruct("Interrupt", {
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
})
export type InterruptTurnPayload = typeof InterruptTurnPayload.Type

export const InterjectPayload = Schema.TaggedStruct("Interject", {
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
  message: Schema.String,
})
export type InterjectPayload = typeof InterjectPayload.Type

export const InterruptPayload = Schema.Union([
  CancelInterruptPayload,
  InterruptTurnPayload,
  InterjectPayload,
]).pipe(Schema.toTaggedUnion("_tag"))
export type InterruptPayload = typeof InterruptPayload.Type

export const RunPromptPayload = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  agentName: AgentName,
  prompt: Schema.String,
  interactive: Schema.optional(Schema.Boolean),
  runSpec: Schema.optional(RunSpecSchema),
})
export type RunPromptPayload = typeof RunPromptPayload.Type

export const QueueFollowUpPayload = Schema.Struct({
  sourceId: FollowUpSourceIdSchema,
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  metadata: Schema.optional(MessageMetadata),
})
export type QueueFollowUpPayload = typeof QueueFollowUpPayload.Type

export const ExtensionRequestPayload = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  extensionId: ExtensionId,
  capabilityId: Schema.String,
  input: Schema.Unknown,
})
export type ExtensionRequestPayload = typeof ExtensionRequestPayload.Type

export const DrainQueuedMessagesPayload = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
})
export type DrainQueuedMessagesPayload = typeof DrainQueuedMessagesPayload.Type

export const SessionRuntimeSessionTarget = Schema.Struct({
  sessionId: SessionId,
})
export type SessionRuntimeSessionTarget = typeof SessionRuntimeSessionTarget.Type

type SessionRuntimeLayerRequirements =
  | ApprovalService
  | Sharding.Sharding
  | ClusterMessageStorage.MessageStorage
  | EventStorage
  | EventStore
  | EventPublisher
  | ExtensionRegistry
  | DriverRegistry
  | ModelRegistry
  | GentPlatform
  | SessionStorage
  | MessageStorage
  | AgentLoopQueueStorage
  | BranchStorage
  | SqlClient.SqlClient
  | ModelResolver
  | ToolRunner
  | ToolCallBindingStorage
  | ConfigService
  | AgentLoopSessionGovernance
  | ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope

export interface SessionRuntimeService {
  readonly sendUserMessage: (
    input: SendUserMessagePayload,
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly steer: (command: SteerCommandType) => Effect.Effect<void, SessionRuntimeError>
  readonly respondInteraction: (
    input: SessionRuntimeTarget & { readonly requestId: InteractionRequestId },
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly runPrompt: (input: RunPromptPayload) => Effect.Effect<void, AgentRunError>
  readonly queueFollowUp: (input: QueueFollowUpPayload) => Effect.Effect<void, SessionRuntimeError>
  readonly requestExtension: (
    input: ExtensionRequestPayload,
  ) => Effect.Effect<unknown, SessionRuntimeError>
  readonly drainQueuedMessages: (
    input: DrainQueuedMessagesPayload,
  ) => Effect.Effect<QueueSnapshot, SessionRuntimeError>
  readonly getQueuedMessages: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<QueueSnapshot, SessionRuntimeError>
  readonly getMetrics: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<SessionRuntimeMetrics, SessionRuntimeError>
  readonly getState: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<SessionRuntimeState, SessionRuntimeError>
  readonly watchState: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<Stream.Stream<SessionRuntimeState, SessionRuntimeError>, SessionRuntimeError>
  readonly terminateSession: (sessionId: SessionId) => Effect.Effect<void, SessionRuntimeError>
}

const wrapError = (message: string, cause: Cause.Cause<unknown>) => {
  // Preserve inner typed SessionRuntimeError (e.g. from `requireSessionExists`)
  // so callers observing the cause chain see the specific "Session not found"
  // message instead of a generic "<op> failed" wrapper.
  const inner = cause.reasons.find(Cause.isFailReason)?.error
  if (Schema.is(SessionRuntimeError)(inner)) return inner
  return new SessionRuntimeError({ message, cause })
}

const userMessageIdForCommand = (commandId: ActorCommandId) => MessageId.make(commandId)
const followUpMessageIdForSource = (input: {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly sourceId: string
}) =>
  MessageId.make(
    `follow-up:${input.workspaceId}:${input.sessionId}:${input.branchId}:${input.sourceId}`,
  )
const commandIdForRequestId = (requestId: string) => ActorCommandId.make(`message:${requestId}`)

const wrapStreamSessionRuntimeError = (
  operation: string,
  error: Schema.Schema.Type<typeof Schema.Unknown>,
) => {
  if (Schema.is(SessionRuntimeError)(error)) return error
  return new SessionRuntimeError({
    message: `${operation} failed`,
    cause: error,
  })
}

interface RunPromptInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName: AgentName
  readonly prompt: string
  readonly interactive?: boolean
  readonly runSpec?: RunSpec
}

const makeLiveSessionRuntime = Effect.gen(function* () {
  // Resolve the actor client factory once at construction time. Per-method
  // dispatch uses `ActorRef.execute(op)`, which carries no requirement,
  // instead of the `OperationHandle.execute(payload)` form (which would
  // re-introduce the actor client requirement at each call site).
  const actorClientFactory = yield* AgentLoopActor.Context
  const actorControl = yield* AgentLoopActor.Control
  const actorState = yield* AgentLoopActor.State
  const agentLoopActorRefFor = (sessionId: SessionId, branchId: BranchId) =>
    Effect.gen(function* () {
      const workspaceId = yield* CurrentWorkspaceId
      return yield* actorClientFactory(entityIdOf(workspaceId, sessionId, branchId))
    })
  const agentLoopSessionGovernance = yield* AgentLoopSessionGovernance
  const platform = yield* GentPlatform
  const storageContext = yield* Effect.context<SessionStorage | BranchStorage>()
  // Every public session-scoped boundary (writes + reads) MUST validate the
  // durable `(sessionId, branchId)` target before proceeding. In-memory
  // tombstones do not survive restart, and branch ids are globally addressable
  // enough that session-only checks hide cross-session mistakes.
  const requireSessionBranch = (target: SessionRuntimeTarget) =>
    resolveExistingSessionBranch(target).pipe(
      Effect.mapError(
        (cause) =>
          new SessionRuntimeError({
            message: cause.message,
            cause,
          }),
      ),
      Effect.provideContext(storageContext),
    )

  const toAgentLoopError = (error: Schema.Schema.Type<typeof Schema.Unknown>) => {
    if (Schema.is(AgentLoopError)(error)) return error
    return new AgentLoopError({
      message: "AgentLoop state unavailable",
      cause: error,
    })
  }
  const runPromptThroughActor = Effect.fn("SessionRuntime.runPromptThroughActor")(function* (
    input: RunPromptInput,
  ) {
    const userMessage = Message.cases.regular.make({
      id: MessageId.make(yield* platform.randomId),
      sessionId: input.sessionId,
      branchId: input.branchId,
      role: "user",
      parts: [Prompt.textPart({ text: input.prompt })],
      createdAt: yield* DateTime.nowAsDate,
    })

    const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
    let payload = {
      workspaceId: yield* CurrentWorkspaceId,
      message: userMessage,
      agentOverride: input.agentName,
      // Actor operation payloads map optional schema fields to required
      // `T | undefined` properties. Keep the fields explicit at this wire
      // boundary so the operation encoder receives the expected shape.
      runSpec: input.runSpec,
      interactive: input.interactive,
    }
    if (Predicate.isNotUndefined(input.runSpec)) payload = { ...payload, runSpec: input.runSpec }
    if (Predicate.isNotUndefined(input.interactive))
      payload = { ...payload, interactive: input.interactive }
    return yield* ref.execute(AgentLoopActor.Run.make(payload)).pipe(
      Effect.mapError(
        (cause) =>
          new AgentRunError({
            message: cause.message,
            cause,
          }),
      ),
    )
  })

  const watchRuntimeState = Effect.fn("SessionRuntime.watchRuntimeState")(function* (
    input: SessionRuntimeTarget,
  ) {
    const workspaceId = yield* CurrentWorkspaceId
    return actorState
      .watch(entityIdOf(workspaceId, input.sessionId, input.branchId))
      .pipe(Stream.mapError(toAgentLoopError))
  })

  const terminateRuntimeSession = Effect.fn("SessionRuntime.terminateRuntimeSession")(function* (
    sessionId: SessionId,
  ) {
    const workspaceId = yield* CurrentWorkspaceId
    const branchIds = yield* actorState.listEntityIds.pipe(
      Effect.flatMap((entityIds) =>
        Effect.forEach(entityIds, (entityId) => parseEntityId(entityId).pipe(Effect.option), {
          concurrency: SESSION_TERMINATION_CONCURRENCY,
        }),
      ),
      Effect.map((targets) =>
        targets.flatMap((target) => {
          if (
            Option.isSome(target) &&
            target.value.workspaceId === workspaceId &&
            target.value.sessionId === sessionId
          ) {
            return [target.value.branchId]
          }
          return []
        }),
      ),
    )
    yield* Effect.forEach(
      branchIds,
      (branchId) =>
        Effect.gen(function* () {
          const ref = yield* agentLoopActorRefFor(sessionId, branchId)
          yield* ref.execute(
            AgentLoopActor.TerminateBranch.make({
              workspaceId,
              sessionId,
              branchId,
              commandId: ActorCommandId.make(yield* platform.randomId),
            }),
          )
        }).pipe(Effect.ignore),
      { concurrency: SESSION_TERMINATION_CONCURRENCY, discard: true },
    )
  })

  const queueFollowUpThroughActor = Effect.fn("SessionRuntime.queueFollowUpThroughActor")(
    function* (input: QueueFollowUpPayload) {
      const workspaceId = yield* CurrentWorkspaceId
      const message = Message.cases.regular.make({
        id: followUpMessageIdForSource({ workspaceId, ...input }),
        sessionId: input.sessionId,
        branchId: input.branchId,
        role: "user",
        parts: [Prompt.textPart({ text: input.content })],
        createdAt: yield* DateTime.nowAsDate,
        metadata: input.metadata,
      })
      const payload = {
        workspaceId,
        message,
      }
      const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
      yield* ref.execute(AgentLoopActor.QueueFollowUp.make(payload)).pipe(
        Effect.mapError(
          (cause) =>
            new SessionRuntimeError({
              message: `Failed to queue follow-up ${message.id}`,
              cause,
            }),
        ),
      )
    },
  )

  const redeliverPendingActorMessages = (target: SessionRuntimeTarget) =>
    Effect.gen(function* () {
      const workspaceId = yield* CurrentWorkspaceId
      yield* actorControl.redeliver(entityIdOf(workspaceId, target.sessionId, target.branchId))
    }).pipe(Effect.ignore)

  const sendUserMessage = Effect.fn("SessionRuntime.sendUserMessage")(function* (
    input: SendUserMessagePayload,
  ) {
    yield* requireSessionBranch(input)
    let commandId: ActorCommandId
    if (Predicate.isNotUndefined(input.commandId)) {
      commandId = input.commandId
    } else if (Predicate.isNotUndefined(input.requestId)) {
      commandId = commandIdForRequestId(input.requestId)
    } else {
      commandId = ActorCommandId.make(yield* platform.randomId)
    }
    const shouldHoldCompletion =
      !Predicate.isUndefined(input.requestId) || !Predicate.isUndefined(input.commandId)
    const messageId = userMessageIdForCommand(commandId)
    const message = Message.cases.regular.make({
      id: messageId,
      sessionId: input.sessionId,
      branchId: input.branchId,
      role: "user",
      parts: [Prompt.textPart({ text: input.content })],
      createdAt: yield* DateTime.nowAsDate,
    })

    let payload = {
      workspaceId: yield* CurrentWorkspaceId,
      message,
      // Actor operation payloads require optional fields explicitly.
      // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
      agentOverride: input.agentOverride,
      // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
      interactive: input.interactive,
      // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
      runSpec: input.runSpec,
    }
    if (Predicate.isNotUndefined(input.agentOverride)) {
      payload = { ...payload, agentOverride: input.agentOverride }
    }
    if (Predicate.isNotUndefined(input.interactive)) {
      payload = { ...payload, interactive: input.interactive }
    }
    if (Predicate.isNotUndefined(input.runSpec)) {
      payload = { ...payload, runSpec: input.runSpec }
    }
    const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
    if (shouldHoldCompletion) {
      yield* ref.execute(AgentLoopActor.SubmitAndWait.make(payload))
    } else {
      yield* ref.execute(AgentLoopActor.Submit.make(payload))
    }
    yield* Effect.logInfo("session-runtime.message.submitted").pipe(
      Effect.annotateLogs({
        sessionId: input.sessionId,
        branchId: input.branchId,
      }),
    )
  })

  return {
    sendUserMessage: (input) =>
      sendUserMessage(input).pipe(
        Effect.catchCause((cause) => Effect.fail(wrapError("sendUserMessage failed", cause))),
      ),

    // `ref.send` is fire-forget at the handler level — INTENTIONAL.
    // `Steer.Interject` semantics: caller needs to know the steering item
    // is registered (handler enqueue complete), not that the interjected
    // turn ran. Switching to `ref.execute` (or `send + waitFor`) deadlocks
    // because `applySteer` itself yields `ensureStarted` while the gated
    // in-flight turn holds the actor; the persisted reply can't drain.
    // Empirically validated twice: W35-C7.3 (commit `a8b084bc`),
    // re-derived W37-S4-C10 (2026-05-11) — both produced 4s timeout on
    // `tests/runtime/session-runtime.test.ts` ("steer interject interrupts
    // the active turn ahead of queued follow-ups"). Note: `ref.send` does
    // NOT silently drop runtime delivery errors — the discardCall Effect
    // propagates; only statically typed `never`. `Steer.persisted: true`
    // is the durability guarantee (Steer survives crash + redeliver) and
    // is NOT what's being relaxed here.
    steer: (command) =>
      requireSessionBranch(command).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const commandId = ActorCommandId.make(command.requestId)
            const payload = {
              workspaceId: yield* CurrentWorkspaceId,
              commandId,
              command,
            }
            const ref = yield* agentLoopActorRefFor(command.sessionId, command.branchId)
            yield* ref.send(AgentLoopActor.Steer.make(payload))
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("steer failed", cause))),
      ),

    respondInteraction: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            const payload = AgentLoopActor.RespondInteraction.make({
              ...input,
              workspaceId,
            })
            yield* ref.execute(payload)
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("respondInteraction failed", cause))),
      ),

    runPrompt: (input: RunPromptInput) => runPromptThroughActor(input),

    queueFollowUp: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() => queueFollowUpThroughActor(input)),
        Effect.catchCause((cause) => Effect.fail(wrapError("queueFollowUp failed", cause))),
      ),

    requestExtension: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(
              AgentLoopActor.RequestExtension.make({
                sessionId: input.sessionId,
                branchId: input.branchId,
                extensionId: input.extensionId,
                capabilityId: input.capabilityId,
                input: Option.match(Option.fromUndefinedOr(input.input), {
                  onNone: () => ({ _tag: "Missing" }),
                  onSome: (value) => ({ _tag: "Present", value }),
                }),
                workspaceId: yield* CurrentWorkspaceId,
                commandId: ActorCommandId.make(yield* platform.randomId),
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("requestExtension failed", cause))),
      ),

    drainQueuedMessages: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const commandId = ActorCommandId.make(input.requestId)
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            const workspaceId = yield* CurrentWorkspaceId
            yield* ref.execute(
              AgentLoopActor.GetQueue.make({
                ...input,
                workspaceId,
                commandId: ActorCommandId.make(yield* platform.randomId),
              }),
            )
            return yield* ref.execute(
              AgentLoopActor.DrainQueue.make({
                ...input,
                workspaceId,
                commandId,
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("drainQueuedMessages failed", cause))),
      ),

    getQueuedMessages: (input) =>
      requireSessionBranch(input).pipe(
        Effect.andThen(redeliverPendingActorMessages(input)),
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(
              AgentLoopActor.GetQueue.make({
                ...input,
                workspaceId: yield* CurrentWorkspaceId,
                commandId: ActorCommandId.make(yield* platform.randomId),
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("getQueuedMessages failed", cause))),
      ),

    getMetrics: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(
              AgentLoopActor.GetMetrics.make({
                ...input,
                workspaceId: yield* CurrentWorkspaceId,
                commandId: ActorCommandId.make(yield* platform.randomId),
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("getMetrics failed", cause))),
      ),

    getState: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(
              AgentLoopActor.GetState.make({
                ...input,
                workspaceId: yield* CurrentWorkspaceId,
                commandId: ActorCommandId.make(yield* platform.randomId),
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("getState failed", cause))),
      ),

    watchState: (input) =>
      Effect.gen(function* () {
        yield* requireSessionBranch(input)
        return (yield* watchRuntimeState(input)).pipe(
          Stream.mapError((error) => wrapStreamSessionRuntimeError("watchState", error)),
        )
      }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("watchState failed", cause)))),

    terminateSession: (sessionId) =>
      Effect.gen(function* () {
        const workspaceId = yield* CurrentWorkspaceId
        yield* agentLoopSessionGovernance.markTerminated(workspaceId, sessionId)
        yield* terminateRuntimeSession(sessionId)
      }).pipe(
        Effect.catchCause((cause) => Effect.fail(wrapError("terminateSession failed", cause))),
      ),
  } satisfies SessionRuntimeService
})

export class SessionRuntime extends Context.Service<SessionRuntime, SessionRuntimeService>()(
  "@gent/core/src/runtime/session-runtime/SessionRuntime",
) {
  static Live = (config: {
    readonly baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<SessionRuntime, never, SessionRuntimeLayerRequirements> =>
    Layer.effect(SessionRuntime, makeLiveSessionRuntime).pipe(
      // Keep actor support services in the live context. `SessionRuntime`
      // captures actor clients, but the AgentLoop entity manager must remain
      // scoped for those clients to make progress.
      Layer.provideMerge(AgentLoopLiveActor(config)),
    )
}
