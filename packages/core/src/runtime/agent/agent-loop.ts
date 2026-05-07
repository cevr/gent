import { Context, DateTime, Deferred, Effect, Layer, Stream, SubscriptionRef } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
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
import { AgentLoopStateRegistry } from "./agent-loop.state-registry.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import { projectRuntimeState, type SessionRuntimeState } from "./agent-loop.state.js"
import { AgentLoopError, SteerCommand } from "./agent-loop.commands.js"
export { AgentLoopError, SteerCommand }
import { persistMessageReceived, type TurnStorage } from "./turn-helpers.js"
import { AgentLoop as AgentLoopActor } from "./agent-loop.actor.js"
import { entityIdOf } from "./agent-loop.entity-id.js"
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
        const stateRegistry = yield* AgentLoopStateRegistry
        const sessionGovernance = yield* AgentLoopSessionGovernance

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
            return yield* ref.execute(
              AgentLoopActor.GetState.make({ ...input, workspaceId: yield* CurrentWorkspaceId }),
            )
          }),
          watchState: Effect.fn("AgentLoop.watchState")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(
              AgentLoopActor.EnsureStarted.make({
                ...input,
                workspaceId: yield* CurrentWorkspaceId,
              }),
            )
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
                Effect.gen(function* () {
                  const workspaceId = yield* CurrentWorkspaceId
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
            yield* stateRegistry.deregisterSession(sessionId)
          }),
          restoreSession: (sessionId) => sessionGovernance.clearTerminated(sessionId),
        }
      }),
    )
}
