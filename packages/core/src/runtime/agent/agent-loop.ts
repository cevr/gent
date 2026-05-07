import { Context, DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { ActorAddressResolver, ActorStateRegistry } from "effect-encore"
import { AgentRunError, type RunSpec, type AgentName as AgentNameType } from "../../domain/agent.js"
import { type QueueSnapshot } from "../../domain/queue.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { Message } from "../../domain/message.js"
import { MessageId, type BranchId, type SessionId } from "../../domain/ids.js"
import { GentPlatform } from "../gent-platform.js"
import type { PromptSection } from "../../domain/prompt.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { StorageTransaction } from "../../storage/storage-transaction.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import { type SessionRuntimeState } from "./agent-loop.state.js"
import { AgentLoopError, SteerCommand } from "./agent-loop.commands.js"
export { AgentLoopError, SteerCommand }
import { persistMessageReceived, type TurnStorage } from "./turn-helpers.js"
import { AgentLoop as AgentLoopActor } from "./agent-loop.actor.js"
import { entityIdOf, parseEntityId } from "./agent-loop.entity-id.js"
import { CurrentWorkspaceId } from "../../server/workspace-rpc.js"

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
  readonly getQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AgentLoopError>
  readonly getState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<SessionRuntimeState, AgentLoopError>
  readonly watchState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<Stream.Stream<SessionRuntimeState, AgentLoopError>, AgentLoopError>
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
    | AgentLoopSessionGovernance
    | ActorAddressResolver
    | ActorStateRegistry
    | Context.Service.Identifier<typeof AgentLoopActor.Context>
  > =>
    Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const actorClientFactory = yield* AgentLoopActor.Context
        const actorAddressResolver = yield* ActorAddressResolver
        const actorStateRegistry = yield* ActorStateRegistry
        const agentLoopActorRefFor = (sessionId: SessionId, branchId: BranchId) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            return yield* actorClientFactory(entityIdOf(workspaceId, sessionId, branchId))
          })
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
        const sessionGovernance = yield* AgentLoopSessionGovernance
        const provideActorStateServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(ActorAddressResolver, actorAddressResolver),
            Effect.provideService(ActorStateRegistry, actorStateRegistry),
          )
        const provideActorStateServicesToStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
          stream.pipe(
            Stream.provideService(ActorAddressResolver, actorAddressResolver),
            Stream.provideService(ActorStateRegistry, actorStateRegistry),
          )
        const toAgentLoopError = (error: unknown) =>
          Schema.is(AgentLoopError)(error)
            ? error
            : new AgentLoopError({
                message: "AgentLoop state unavailable",
                cause: error,
              })

        return {
          runOnce: Effect.fn("AgentLoop.runOnce")(function* (input) {
            const userMessage = Message.Regular.make({
              id: MessageId.make(yield* platform.randomId),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "user",
              parts: [Prompt.textPart({ text: input.prompt })],
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

            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref
              .execute(
                AgentLoopActor.Run.make({
                  workspaceId: yield* CurrentWorkspaceId,
                  message: userMessage,
                  agentOverride: input.agentName,
                  runSpec: input.runSpec,
                  interactive: input.interactive,
                }),
              )
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

          getQueue: Effect.fn("AgentLoop.getQueue")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(
              AgentLoopActor.GetQueue.make({ ...input, workspaceId: yield* CurrentWorkspaceId }),
            )
          }),

          getState: Effect.fn("AgentLoop.getState")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            const workspaceId = yield* CurrentWorkspaceId
            return yield* provideActorStateServices(
              AgentLoopActor.getState<SessionRuntimeState, AgentLoopError, never, AgentLoopError>(
                entityIdOf(workspaceId, input.sessionId, input.branchId),
                {
                  materialize: ref.execute(
                    AgentLoopActor.EnsureStarted.make({ ...input, workspaceId }),
                  ),
                },
              ).pipe(Effect.mapError(toAgentLoopError)),
            )
          }),
          watchState: Effect.fn("AgentLoop.watchState")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            const workspaceId = yield* CurrentWorkspaceId
            return provideActorStateServicesToStream(
              AgentLoopActor.watchState<SessionRuntimeState, AgentLoopError, never, AgentLoopError>(
                entityIdOf(workspaceId, input.sessionId, input.branchId),
                {
                  materialize: ref.execute(
                    AgentLoopActor.EnsureStarted.make({ ...input, workspaceId }),
                  ),
                },
              ).pipe(Stream.mapError(toAgentLoopError)),
            )
          }),

          terminateSession: Effect.fn("AgentLoop.terminateSession")(function* (sessionId) {
            const workspaceId = yield* CurrentWorkspaceId
            yield* sessionGovernance.markTerminated(workspaceId, sessionId)
            const branchIds = yield* provideActorStateServices(
              AgentLoopActor.listStateEntityIds().pipe(
                Effect.flatMap((entityIds) =>
                  Effect.forEach(
                    entityIds,
                    (entityId) => parseEntityId(entityId).pipe(Effect.option),
                    { concurrency: "unbounded" },
                  ),
                ),
                Effect.map((targets) =>
                  targets.flatMap((target) =>
                    Option.isSome(target) &&
                    target.value.workspaceId === workspaceId &&
                    target.value.sessionId === sessionId
                      ? [target.value.branchId]
                      : [],
                  ),
                ),
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
                    }),
                  )
                }).pipe(Effect.ignore),
              { concurrency: "unbounded", discard: true },
            )
          }),
          restoreSession: (sessionId) =>
            Effect.gen(function* () {
              const workspaceId = yield* CurrentWorkspaceId
              yield* sessionGovernance.clearTerminated(workspaceId, sessionId)
            }),
        }
      }),
    )
}
