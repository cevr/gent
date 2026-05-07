import { Context, DateTime, Deferred, Effect, Layer, Stream, SubscriptionRef } from "effect"
import {
  AgentRunError,
  DEFAULT_AGENT_NAME,
  type RunSpec,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { emptyQueueSnapshot, type QueueSnapshot } from "../../domain/queue.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { Message, TextPart, type MessageMetadata } from "../../domain/message.js"
import {
  ActorCommandId,
  type InteractionRequestId,
  MessageId,
  type ToolCallId,
  type BranchId,
  type SessionId,
} from "../../domain/ids.js"
import { GentPlatform } from "../gent-platform.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { StorageError } from "../../domain/storage-error.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { StorageTransaction } from "../../storage/storage-transaction.js"
import { AgentLoopStateRegistry } from "./agent-loop.state-registry.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import {
  SessionRuntimeStateSchema,
  projectRuntimeState,
  type SessionRuntimeState,
} from "./agent-loop.state.js"
import { AgentLoopError, SteerCommand } from "./agent-loop.commands.js"
export { AgentLoopError, SteerCommand }
import { persistMessageReceived, type TurnStorage } from "./phases/turn.js"
import { AgentLoop as AgentLoopActor } from "./agent-loop.actor.js"
import { entityIdOf } from "./agent-loop.entity-id.js"

// Agent Loop Context

// Internal turn engine. Server-facing callers should go through SessionRuntime.

export interface AgentLoopService {
  readonly runOnce: (input: {
    sessionId: SessionId
    branchId: BranchId
    agentName: AgentNameType
    prompt: string
    interactive?: boolean
    runSpec?: RunSpec
  }) => Effect.Effect<void, AgentRunError>
  readonly submit: (
    message: Message,
    options?: {
      agentOverride?: AgentNameType
      runSpec?: RunSpec
      interactive?: boolean
    },
  ) => Effect.Effect<void, AgentLoopError>
  readonly run: (
    message: Message,
    options?: {
      agentOverride?: AgentNameType
      runSpec?: RunSpec
      interactive?: boolean
    },
  ) => Effect.Effect<void, AgentLoopError>
  readonly queueFollowUp: (input: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    metadata?: MessageMetadata
  }) => Effect.Effect<void, AgentLoopError | StorageError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void, AgentLoopError>
  readonly drainQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AgentLoopError>
  readonly getQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AgentLoopError>
  readonly respondInteraction: (input: {
    sessionId: SessionId
    branchId: BranchId
    requestId: InteractionRequestId
  }) => Effect.Effect<void, AgentLoopError>
  readonly recordToolResult: (input: {
    commandId?: ActorCommandId
    sessionId: SessionId
    branchId: BranchId
    toolCallId: ToolCallId
    toolName: string
    output: unknown
    isError?: boolean
  }) => Effect.Effect<void, AgentLoopError>
  readonly invokeTool: (input: {
    commandId?: ActorCommandId
    sessionId: SessionId
    branchId: BranchId
    toolName: string
    input: unknown
  }) => Effect.Effect<void, AgentLoopError>
  readonly getState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<SessionRuntimeState, AgentLoopError>
  readonly watchState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<Stream.Stream<SessionRuntimeState>, AgentLoopError>
  readonly terminateSession: (sessionId: SessionId) => Effect.Effect<void>
  readonly restoreSession: (sessionId: SessionId) => Effect.Effect<void>
}

export class AgentLoop extends Context.Service<AgentLoop, AgentLoopService>()(
  "@gent/core/src/runtime/agent/agent-loop/AgentLoop",
) {
  static Live = (_config: {
    baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<
    AgentLoop,
    never,
    | SessionStorage
    | MessageStorage
    | EventStorage
    | StorageTransaction
    | EventPublisher
    | GentPlatform
    | AgentLoopStateRegistry
    | AgentLoopSessionGovernance
    | Context.Service.Identifier<typeof AgentLoopActor.Context>
  > =>
    Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const actorClientFactory = yield* AgentLoopActor.Context
        const agentLoopActorRefFor = (sessionId: SessionId, branchId: BranchId) =>
          actorClientFactory(entityIdOf(sessionId, branchId))
        const sessionStorage = yield* SessionStorage
        const messageStorage = yield* MessageStorage
        const eventStorage = yield* EventStorage
        const storageTransaction = yield* StorageTransaction
        const turnStorage: TurnStorage = {
          transaction: storageTransaction,
          events: eventStorage,
          messages: messageStorage,
          sessions: sessionStorage,
        }
        const eventPublisher = yield* EventPublisher
        const platform = yield* GentPlatform
        const nextActorCommandId = Effect.map(platform.randomId, (id) => ActorCommandId.make(id))
        const stateRegistry = yield* AgentLoopStateRegistry
        const sessionGovernance = yield* AgentLoopSessionGovernance
        let service: AgentLoopService

        service = {
          runOnce: Effect.fn("AgentLoop.runOnce")(function* (input) {
            const userMessage = Message.Regular.make({
              id: MessageId.make(yield* platform.randomId),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: input.prompt })],
              createdAt: yield* DateTime.nowAsDate,
            })

            yield* persistMessageReceived({
              storage: turnStorage,
              eventPublisher,
              message: userMessage,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentRunError({
                    message: `Failed to persist user message for ${input.sessionId}`,
                    cause,
                  }),
              ),
            )

            return yield* service
              .run(userMessage, {
                agentOverride: input.agentName,
                ...(input.runSpec !== undefined ? { runSpec: input.runSpec } : {}),
                ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentRunError({
                      message: cause.message,
                      cause,
                    }),
                ),
              )
          }),

          submit: Effect.fn("AgentLoop.submit")(function* (
            message: Message,
            options?: {
              agentOverride?: AgentNameType
              runSpec?: RunSpec
              interactive?: boolean
            },
          ) {
            const ref = yield* agentLoopActorRefFor(message.sessionId, message.branchId)
            return yield* ref.execute(
              AgentLoopActor.Submit.make({
                message,
                agentOverride: options?.agentOverride,
                runSpec: options?.runSpec,
                interactive: options?.interactive,
              }),
            )
          }),

          run: Effect.fn("AgentLoop.run")(function* (
            message: Message,
            options?: {
              agentOverride?: AgentNameType
              runSpec?: RunSpec
              interactive?: boolean
            },
          ) {
            const ref = yield* agentLoopActorRefFor(message.sessionId, message.branchId)
            return yield* ref.execute(
              AgentLoopActor.Run.make({
                message,
                agentOverride: options?.agentOverride,
                runSpec: options?.runSpec,
                interactive: options?.interactive,
              }),
            )
          }),

          queueFollowUp: Effect.fn("AgentLoop.queueFollowUp")(function* (input) {
            const message = Message.Regular.make({
              id: MessageId.make(yield* platform.randomId),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: input.content })],
              createdAt: yield* DateTime.nowAsDate,
              ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            })
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(
              AgentLoopActor.QueueFollowUp.make({
                message,
                agentOverride: undefined,
                runSpec: undefined,
                interactive: undefined,
              }),
            )
          }),

          steer: Effect.fn("AgentLoop.steer")(function* (command) {
            const ref = yield* agentLoopActorRefFor(command.sessionId, command.branchId)
            yield* ref.execute(
              AgentLoopActor.Steer.make({
                commandId: yield* nextActorCommandId,
                command,
              }),
            )
          }),

          drainQueue: Effect.fn("AgentLoop.drainQueue")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(
              AgentLoopActor.DrainQueue.make({
                ...input,
                commandId: yield* nextActorCommandId,
              }),
            )
          }),

          getQueue: Effect.fn("AgentLoop.getQueue")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(AgentLoopActor.GetQueue.make(input))
          }),

          respondInteraction: Effect.fn("AgentLoop.respondInteraction")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(AgentLoopActor.RespondInteraction.make(input))
          }),

          recordToolResult: Effect.fn("AgentLoop.recordToolResult")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(
              AgentLoopActor.RecordToolResult.make({
                ...input,
                commandId: input.commandId,
                isError: input.isError,
              }),
            )
          }),

          invokeTool: Effect.fn("AgentLoop.invokeTool")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(
              AgentLoopActor.InvokeTool.make({
                ...input,
                commandId: input.commandId ?? (yield* nextActorCommandId),
              }),
            )
          }),

          getState: Effect.fn("AgentLoop.getState")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(AgentLoopActor.GetState.make(input))
          }),
          watchState: Effect.fn("AgentLoop.watchState")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(AgentLoopActor.EnsureStarted.make(input))
            const registered = yield* stateRegistry.find(input.sessionId, input.branchId)
            if (registered === undefined) {
              return yield* new AgentLoopError({
                message: `AgentLoop state unavailable: ${input.sessionId}/${input.branchId}`,
              })
            }
            const changes = SubscriptionRef.changes(registered.loopRef).pipe(
              Stream.map(projectRuntimeState),
            )
            return registered.closed === undefined
              ? changes
              : changes.pipe(Stream.interruptWhen(Deferred.await(registered.closed)))
          }),

          terminateSession: Effect.fn("AgentLoop.terminateSession")(function* (sessionId) {
            yield* sessionGovernance.markTerminated(sessionId)
            const branchIds = yield* stateRegistry.listForSession(sessionId)
            yield* Effect.forEach(
              branchIds,
              (branchId) =>
                agentLoopActorRefFor(sessionId, branchId).pipe(
                  Effect.flatMap((ref) =>
                    ref.execute(
                      AgentLoopActor.TerminateBranch.make({
                        sessionId,
                        branchId,
                      }),
                    ),
                  ),
                  Effect.ignore,
                ),
              { concurrency: "unbounded", discard: true },
            )
            yield* stateRegistry.deregisterSession(sessionId)
          }),
          restoreSession: (sessionId) => sessionGovernance.clearTerminated(sessionId),
        }

        return service
      }),
    )

  static Test = (overrides: Partial<AgentLoopService> = {}): Layer.Layer<AgentLoop> =>
    Layer.succeed(AgentLoop, {
      runOnce: () => Effect.void,
      submit: () => Effect.void,
      run: () => Effect.void,
      queueFollowUp: () => Effect.void,
      steer: () => Effect.void,
      drainQueue: () => Effect.succeed(emptyQueueSnapshot()),
      getQueue: () => Effect.succeed(emptyQueueSnapshot()),
      respondInteraction: () => Effect.void,
      recordToolResult: () => Effect.void,
      invokeTool: () => Effect.void,
      terminateSession: () => Effect.void,
      restoreSession: () => Effect.void,
      getState: () =>
        Effect.succeed(
          SessionRuntimeStateSchema.Idle.make({
            agent: DEFAULT_AGENT_NAME,
            queue: emptyQueueSnapshot(),
          }),
        ),
      watchState: () => Effect.succeed(Stream.empty),
      ...overrides,
    })
}
