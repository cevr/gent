import { Cause, Duration, Effect, Exit, Fiber, Layer, Option, Predicate, Stream } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { withWideEvent, WideEvent, agentRunBoundary } from "../wide-event-boundary"
import { AgentSwitched, EventStore } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import {
  AgentRunError,
  AgentRunnerService,
  AgentRunResult,
  DEFAULT_AGENT_NAME,
  makeRunSpec,
  type AgentName,
} from "../../domain/agent.js"
import { MessageId, type SessionId, type BranchId } from "../../domain/ids.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { GentPlatform } from "../gent-platform.js"
import type { BranchStorage } from "../../storage/branch-storage.js"
import { SessionStorage } from "../../storage/session-storage.js"
import type { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import type { RelationshipStorage } from "../../storage/relationship-storage.js"
import { SessionRuntime } from "../session-runtime.js"
import { makeDurableAgentRunRuntime } from "./agent-runner.durable.js"
import { ChildCompletionDelivery } from "./child-completion.js"
import { makeAgentRunMetadataRuntime } from "./agent-runner.metadata.js"
export { getSessionDepth } from "./agent-runner.durable.js"

export interface AgentRunnerConfig {
  readonly baseSections?: ReadonlyArray<PromptSection>
  readonly timeoutMs?: number
}

export const InProcessRunner = (
  runnerConfig: AgentRunnerConfig,
): Layer.Layer<
  AgentRunnerService,
  never,
  | SessionStorage
  | SessionOperationStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | SqlClient.SqlClient
  | EventStore
  | EventPublisher
  | SessionRuntime
  | GentPlatform
  | ChildCompletionDelivery
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const messageStorage = yield* MessageStorage
      const eventPublisher = yield* EventPublisher
      const sessionRuntime = yield* SessionRuntime
      const sessionStorage = yield* SessionStorage
      const eventStorage = yield* EventStorage
      const durableRuntime = yield* makeDurableAgentRunRuntime
      const metadataRuntime = yield* makeAgentRunMetadataRuntime
      const delivery = yield* ChildCompletionDelivery
      // Startup recovery runs beside the server, not before it.
      yield* Effect.forkScoped(delivery.reconcile)

      const publishAgentSwitch = (params: {
        sessionId: SessionId
        branchId: BranchId
        agentName: AgentName
      }) =>
        eventPublisher.publish(
          AgentSwitched.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            fromAgent: DEFAULT_AGENT_NAME,
            toAgent: params.agentName,
          }),
        )

      // A private child is gone once its answer is read: no loop, no rows, no
      // live events. Each step is best effort; a leftover row is not a failed run.
      const forgetPrivateSession = (sessionId: SessionId) =>
        Effect.all(
          [
            sessionRuntime.terminateSession(sessionId),
            sessionStorage.deleteSession(sessionId),
            eventStore.removeSession(sessionId),
          ],
          { discard: true },
        ).pipe(Effect.ignore)

      const runWithTimeout = <R>(effect: Effect.Effect<void, AgentRunError, R>) => {
        if (Predicate.isUndefined(runnerConfig.timeoutMs)) return effect
        return effect.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(runnerConfig.timeoutMs),
            orElse: () =>
              Effect.fail(
                new AgentRunError({
                  message: `Agent run timed out after ${runnerConfig.timeoutMs}ms`,
                }),
              ),
          }),
        )
      }

      return AgentRunnerService.of({
        start: Effect.fn("AgentRunner.start")(function* (params) {
          const child = yield* durableRuntime
            .start({
              ...params,
              admission: { requestId: params.requestId, runSpec: params.runSpec },
            })
            .pipe(
              Effect.provideService(SessionRuntime, sessionRuntime),
              Effect.catchTags({
                StorageError: (cause) =>
                  Effect.fail(new AgentRunError({ message: cause.message, cause })),
                EventStoreError: (cause) =>
                  Effect.fail(new AgentRunError({ message: cause.message, cause })),
              }),
            )
          // The handle returns now; the result arrives later as a parent message.
          yield* delivery.watch(params.requestId, {
            ...child,
            input: {
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              agentName: params.agent.name,
              prompt: params.prompt,
              cwd: params.cwd,
              toolCallId: params.toolCallId,
              runSpec: params.runSpec,
            },
          })
          return child
          // Admission and the completion watcher stand or fall together. A caller
          // interrupted between them (a dying cell worker, a cancelled tool call)
          // would leave a running child nobody delivers.
        }, Effect.uninterruptible),
        inspect: Effect.fn("AgentRunner.inspect")((params) =>
          durableRuntime.inspect(params).pipe(
            Effect.provideService(EventStorage, eventStorage),
            Effect.catchTag("StorageError", (cause) =>
              Effect.fail(new AgentRunError({ message: cause.message, cause })),
            ),
          ),
        ),
        list: Effect.fn("AgentRunner.list")((params) =>
          durableRuntime
            .list(params)
            .pipe(
              Effect.catchTag("StorageError", (cause) =>
                Effect.fail(new AgentRunError({ message: cause.message, cause })),
              ),
            ),
        ),
        cancel: Effect.fn("AgentRunner.cancel")((params) =>
          durableRuntime.cancel(params).pipe(
            Effect.provideService(EventStorage, eventStorage),
            Effect.provideService(SessionRuntime, sessionRuntime),
            Effect.catchTag("StorageError", (cause) =>
              Effect.fail(new AgentRunError({ message: cause.message, cause })),
            ),
          ),
        ),
        run: Effect.fn("AgentRunner.run")(function* (params) {
          const runSpec = params.runSpec
          const toolCallId = runSpec?.parentToolCallId
          // A private run leaves no trace on the parent: no spawn or completion
          // events, and its session is deleted once the answer is read.
          const isPrivate = runSpec?.visibility === "private"
          const agentName = params.agent.name

          const admitted = yield* durableRuntime
            .createDurableAgentRunSession({
              ...params,
              toolCallId,
              visibility: runSpec?.visibility,
            })
            .pipe(Effect.exit)
          if (Exit.isFailure(admitted)) {
            if (Cause.hasInterruptsOnly(admitted.cause)) return yield* Effect.interrupt
            return AgentRunResult.cases.error.make({
              error: Cause.pretty(admitted.cause),
              agentName,
            })
          }
          const { sessionId, branchId } = admitted.value

          const run = Effect.gen(function* () {
            yield* WideEvent.set({ childSessionId: sessionId })
            // An inheriting child starts from what the caller's model sees now:
            // hidden rows stay out, as they do in the parent's own turn.
            if (runSpec?.history === "inherit") {
              const seed = yield* messageStorage.listMessages(params.parentBranchId)
              yield* Effect.forEach(
                seed.filter((message) => message.metadata?.hidden !== true),
                (message, index) =>
                  messageStorage.createMessage({
                    ...message,
                    id: MessageId.make(`${branchId}:seed:${index}`),
                    sessionId,
                    branchId,
                  }),
                { discard: true },
              )
            }
            // The observer sees the child's events as they happen; its failures never fail the run.
            const observer = yield* Option.match(Option.fromUndefinedOr(params.observe), {
              onNone: () => Effect.succeed(Option.none<Fiber.Fiber<void>>()),
              onSome: (notify) =>
                eventStore.subscribe({ sessionId, branchId }).pipe(
                  Stream.runForEach((envelope) =>
                    notify(envelope.event).pipe(Effect.catchEager(() => Effect.void)),
                  ),
                  Effect.catchEager(() => Effect.void),
                  Effect.forkChild,
                  Effect.asSome,
                ),
            })
            yield* publishAgentSwitch({ sessionId, branchId, agentName })
            yield* runWithTimeout(
              sessionRuntime.runPrompt({
                sessionId,
                branchId,
                agentName,
                prompt: params.prompt,
                interactive: false,
                runSpec: makeRunSpec({ ...runSpec, parentToolCallId: toolCallId }),
              }),
            ).pipe(
              Effect.ensuring(
                Option.match(observer, { onNone: () => Effect.void, onSome: Fiber.interrupt }),
              ),
            )

            const success = yield* metadataRuntime.loadAgentRunSuccessData({
              branchId,
              sessionId,
              agentName,
            })
            if (!isPrivate) {
              let preview = success.text
              if (preview.length > 200) preview = preview.slice(0, 200) + "…"
              yield* durableRuntime.publishAgentRunSucceeded({
                parentSessionId: params.parentSessionId,
                parentBranchId: params.parentBranchId,
                toolCallId,
                sessionId,
                agentName,
                usage: success.usage,
                preview,
              })
            }
            yield* WideEvent.set({
              usage: success.usage,
              toolCallCount: success.toolCalls?.length ?? 0,
            })
            return AgentRunResult.cases.success.make(success)
          }).pipe(
            withWideEvent(agentRunBoundary(agentName, params.parentSessionId)),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              return Effect.gen(function* () {
                const error = Cause.pretty(cause)
                if (!isPrivate) {
                  yield* durableRuntime.publishAgentRunFailed({
                    parentSessionId: params.parentSessionId,
                    parentBranchId: params.parentBranchId,
                    toolCallId,
                    sessionId,
                    agentName,
                  })
                }
                return AgentRunResult.cases.error.make({ error, sessionId, agentName })
              })
            }),
          )
          if (!isPrivate) return yield* run
          return yield* run.pipe(Effect.ensuring(forgetPrivateSession(sessionId)))
        }),
      })
    }),
  )
