import {
  Cause,
  type Crypto,
  Duration,
  Effect,
  type FileSystem,
  Layer,
  Option,
  Predicate,
  type Path,
} from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import type { SqlClient } from "effect/unstable/sql"
import { withWideEvent, WideEvent, agentRunBoundary } from "../wide-event-boundary"
import { AgentSwitched, EventStore, type AgentEvent } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import {
  AgentRunError,
  AgentRunnerService,
  AgentRunResult,
  DEFAULT_AGENT_NAME,
  makeRunSpec,
  resolveRunPersistence,
  type AgentName,
} from "../../domain/agent.js"
import { SessionId, BranchId } from "../../domain/ids.js"
import type { Message } from "../../domain/message.js"
import type { BranchStorage } from "../../storage/branch-storage.js"
import type { SessionStorage } from "../../storage/session-storage.js"
import type { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import type { RelationshipStorage } from "../../storage/relationship-storage.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { GentPlatform } from "../gent-platform.js"
import { SessionRuntime } from "../session-runtime.js"
import type { ModelResolver } from "../../providers/model-resolver.js"
import type { RuntimeEnvironment } from "../runtime-environment.js"
import type { ConfigService } from "../config-service.js"
import type { ModelRegistry } from "../model-registry.js"
import type { AgentRunnerConfig } from "./agent-runner.config.js"
import { makeDurableAgentRunRuntime } from "./agent-runner.durable.js"
import { ChildCompletionDelivery } from "./child-completion.js"
import { runEphemeralAgent } from "./agent-runner.ephemeral.js"
import {
  EphemeralAgentRootLayerFactoryService,
  makeEphemeralAgentRootLayerFactory,
} from "./ephemeral-root.js"
import { makeAgentRunMetadataRuntime } from "./agent-runner.metadata.js"
import { normalizeRunSpec, handleAgentRunFailure } from "./agent-runner.run-spec.js"
export type { AgentRunnerConfig } from "./agent-runner.config.js"
export { getSessionDepth } from "./agent-runner.durable.js"

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
  | ExtensionRegistry
  | ModelResolver
  | RuntimeEnvironment
  | FileSystem.FileSystem
  | Path.Path
  | ConfigService
  | ModelRegistry
  | ChildProcessSpawner.ChildProcessSpawner
  | GentPlatform
  | Crypto.Crypto
  | ChildCompletionDelivery
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const baseEventStore = yield* EventStore
      const parentMessageStorage = yield* MessageStorage
      const eventPublisher = yield* EventPublisher
      const sessionRuntime = yield* SessionRuntime
      const eventStorage = yield* EventStorage
      const extensionRegistry = yield* ExtensionRegistry
      const durableRuntime = yield* makeDurableAgentRunRuntime
      const metadataRuntime = yield* makeAgentRunMetadataRuntime
      const makeEphemeralAgentRootLayer = yield* makeEphemeralAgentRootLayerFactory
      const delivery = yield* ChildCompletionDelivery
      // Startup recovery runs beside the server, not before it.
      yield* Effect.forkScoped(delivery.reconcile)

      const platform = yield* GentPlatform
      const notifyMirroredEventObservers = (_event: AgentEvent) => Effect.void
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
        }),
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
          const persistence = resolveRunPersistence(params.runSpec)
          const normalizedRunSpec = normalizeRunSpec(params.runSpec)
          const toolCallId = params.runSpec?.parentToolCallId

          const handleUnexpectedFailure = (cause: Cause.Cause<unknown>) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            return Effect.succeed(
              AgentRunResult.cases.error.make({
                error: Cause.pretty(cause),
                agentName: params.agent.name,
                persistence,
              }),
            )
          }

          if (persistence === "ephemeral") {
            const sessionId = SessionId.make(yield* platform.randomId)
            const branchId = BranchId.make(yield* platform.randomId)
            // An inheriting child starts from the caller's branch as it stands now.
            let seedMessages: ReadonlyArray<Message> = []
            if (normalizedRunSpec?.history === "inherit") {
              seedMessages = yield* parentMessageStorage
                .listMessages(params.parentBranchId)
                .pipe(
                  Effect.mapError((cause) => new AgentRunError({ message: cause.message, cause })),
                )
            }
            return yield* runEphemeralAgent({
              seedMessages,
              runnerConfig,
              durableRuntime,
              metadataRuntime,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              toolCallId,
              cwd: params.cwd,
              agentName: params.agent.name,
              prompt: params.prompt,
              runSpec: normalizedRunSpec,
              persistence,
              parentBaseEventStore: baseEventStore,
              notifyMirroredEventObservers,
              sessionId,
              branchId,
              extensionRegistry,
            }).pipe(
              Effect.provideService(
                EphemeralAgentRootLayerFactoryService,
                makeEphemeralAgentRootLayer,
              ),
            )
          }

          return yield* durableRuntime.createDurableAgentRunSession({ ...params, toolCallId }).pipe(
            Effect.flatMap(({ sessionId, branchId }) => {
              const run = Effect.gen(function* () {
                yield* WideEvent.set({ childSessionId: sessionId })

                yield* publishAgentSwitch({
                  sessionId,
                  branchId,
                  agentName: params.agent.name,
                })

                let durableRunSpec = normalizedRunSpec
                if (Predicate.isNotUndefined(toolCallId)) {
                  durableRunSpec = makeRunSpec({
                    ...normalizedRunSpec,
                    parentToolCallId: toolCallId,
                  })
                }
                yield* runWithTimeout(
                  sessionRuntime.runPrompt({
                    sessionId,
                    branchId,
                    agentName: params.agent.name,
                    prompt: params.prompt,
                    interactive: false,
                    runSpec: durableRunSpec,
                  }),
                )

                const { success, reasoning } = yield* metadataRuntime.loadAgentRunSuccessData({
                  branchId,
                  sessionId,
                  agentName: params.agent.name,
                  persistence,
                })
                const savedPath = yield* metadataRuntime.saveAgentRunOutput({
                  text: success.text,
                  reasoning,
                  agentName: params.agent.name,
                  sessionId,
                })
                let preview = success.text
                if (preview.length > 200) preview = preview.slice(0, 200) + "…"
                yield* durableRuntime.publishAgentRunSucceeded({
                  parentSessionId: params.parentSessionId,
                  parentBranchId: params.parentBranchId,
                  toolCallId,
                  sessionId,
                  agentName: params.agent.name,
                  usage: success.usage,
                  preview,
                  savedPath: Option.getOrUndefined(savedPath),
                })

                yield* WideEvent.set({
                  usage: success.usage,
                  toolCallCount: success.toolCalls?.length ?? 0,
                })

                return AgentRunResult.cases.success.make({
                  ...success,
                  savedPath: Option.getOrUndefined(savedPath),
                })
              }).pipe(withWideEvent(agentRunBoundary(params.agent.name, params.parentSessionId)))

              return run.pipe(
                handleAgentRunFailure(
                  {
                    parentSessionId: params.parentSessionId,
                    parentBranchId: params.parentBranchId,
                    toolCallId,
                    sessionId,
                    agentName: params.agent.name,
                    persistence,
                    spanName: "AgentRunner.inProcess",
                  },
                  durableRuntime.publishAgentRunFailed,
                ),
              )
            }),
            Effect.catchCause(handleUnexpectedFailure),
          )
        }),
      })
    }),
  )
