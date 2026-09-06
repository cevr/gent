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
  Schema,
} from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import type { SqlClient } from "effect/unstable/sql"
import { makeProcessRunner, type RunProcessOptions } from "../../utils/run-process.js"
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
  RunSpecSchema,
} from "../../domain/agent.js"
import { SessionId, BranchId } from "../../domain/ids.js"
import type { BranchStorage } from "../../storage/branch-storage.js"
import type { SessionStorage } from "../../storage/session-storage.js"
import type { MessageStorage } from "../../storage/message-storage.js"
import type { EventStorage } from "../../storage/event-storage.js"
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
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const baseEventStore = yield* EventStore
      const eventPublisher = yield* EventPublisher
      const sessionRuntime = yield* SessionRuntime
      const extensionRegistry = yield* ExtensionRegistry
      const durableRuntime = yield* makeDurableAgentRunRuntime
      const metadataRuntime = yield* makeAgentRunMetadataRuntime
      const makeEphemeralAgentRootLayer = yield* makeEphemeralAgentRootLayerFactory

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
            return yield* runEphemeralAgent({
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

export const SubprocessRunner = (
  config: AgentRunnerConfig,
): Layer.Layer<
  AgentRunnerService,
  never,
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | SqlClient.SqlClient
  | EventStore
  | EventPublisher
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
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const baseEventStore = yield* EventStore
      const extensionRegistry = yield* ExtensionRegistry
      const processRunner = yield* makeProcessRunner
      const durableRuntime = yield* makeDurableAgentRunRuntime
      const metadataRuntime = yield* makeAgentRunMetadataRuntime
      const makeEphemeralAgentRootLayer = yield* makeEphemeralAgentRootLayerFactory

      const platform = yield* GentPlatform
      const notifyMirroredEventObservers = (_event: AgentEvent) => Effect.void

      return AgentRunnerService.of({
        run: Effect.fn("AgentRunner.run")(function* (params) {
          const persistence = resolveRunPersistence(params.runSpec)
          const toolCallId = params.runSpec?.parentToolCallId
          if (persistence === "ephemeral") {
            const sessionId = SessionId.make(yield* platform.randomId)
            const branchId = BranchId.make(yield* platform.randomId)
            return yield* runEphemeralAgent({
              runnerConfig: config,
              durableRuntime,
              metadataRuntime,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              toolCallId,
              cwd: params.cwd,
              agentName: params.agent.name,
              prompt: params.prompt,
              runSpec: params.runSpec,
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

                // Capture trace context for subprocess propagation
                const currentSpan = yield* Effect.currentParentSpan.pipe(Effect.option)

                const binary = config.subprocessBinaryPath ?? "gent"
                // Merge parentToolCallId into runSpec for subprocess
                let subprocessRunSpec = params.runSpec
                if (Predicate.isNotUndefined(toolCallId)) {
                  subprocessRunSpec = makeRunSpec({
                    ...params.runSpec,
                    parentToolCallId: toolCallId,
                  })
                }
                const args = ["--headless", "--session", sessionId]
                if (Predicate.isNotUndefined(config.sharedServerUrl)) {
                  args.push("--connect", config.sharedServerUrl)
                }
                if (Predicate.isNotUndefined(subprocessRunSpec)) {
                  const runSpecJson = yield* Schema.encodeEffect(
                    Schema.fromJsonString(RunSpecSchema),
                  )(subprocessRunSpec)
                  args.push("--run-spec", runSpecJson)
                }
                args.push(params.prompt)

                const parentEnv = yield* platform.env
                const env: NonNullable<RunProcessOptions["env"]> = {
                  ...parentEnv,
                  GENT_DB_PATH: config.dbPath,
                  GENT_SHARED_SERVER_URL: config.sharedServerUrl,
                }
                if (Option.isSome(currentSpan)) {
                  env["GENT_TRACE_ID"] = currentSpan.value.traceId
                  env["GENT_PARENT_SPAN_ID"] = currentSpan.value.spanId
                }

                const { exitCode, stderr: stderrText } = yield* processRunner
                  .run(binary, args, {
                    cwd: params.cwd,
                    env,
                    stdout: "pipe",
                    stderr: "pipe",
                  })
                  .pipe(
                    Effect.catchTag("ProcessError", () =>
                      Effect.succeed({ exitCode: 1, stderr: "Subprocess failed" }),
                    ),
                  )

                if (exitCode !== 0) {
                  yield* durableRuntime.publishAgentRunFailed({
                    parentSessionId: params.parentSessionId,
                    parentBranchId: params.parentBranchId,
                    toolCallId,
                    sessionId,
                    agentName: params.agent.name,
                  })

                  let error = `Subprocess exited with code ${exitCode}`
                  if (stderrText.length > 0) error = stderrText.trim()
                  return AgentRunResult.cases.error.make({
                    error,
                    sessionId,
                    agentName: params.agent.name,
                    persistence,
                  })
                }

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
                    spanName: "AgentRunner.subprocess",
                  },
                  durableRuntime.publishAgentRunFailed,
                ),
              )
            }),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              return Effect.succeed(
                AgentRunResult.cases.error.make({
                  error: Cause.pretty(cause),
                  agentName: params.agent.name,
                  persistence,
                }),
              )
            }),
          )
        }),
      })
    }),
  )
