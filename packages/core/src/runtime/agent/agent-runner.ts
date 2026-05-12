import { Cause, Duration, Effect, type FileSystem, Layer, type Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import type { SqlClient } from "effect/unstable/sql"
import { runProcess } from "../../utils/run-process.js"
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
  type RunSpec,
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
import { makeEphemeralAgentRootLayerFactory } from "./ephemeral-root.js"
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

      const runWithTimeout = <R>(effect: Effect.Effect<void, AgentRunError, R>) =>
        runnerConfig.timeoutMs === undefined
          ? effect
          : effect.pipe(
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

      return {
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
              makeEphemeralAgentRootLayer,
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
            })
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

                const durableRunSpec: RunSpec | undefined =
                  toolCallId !== undefined
                    ? makeRunSpec({
                        persistence: normalizedRunSpec?.persistence,
                        overrides: normalizedRunSpec?.overrides,
                        tags: normalizedRunSpec?.tags,
                        parentToolCallId: toolCallId,
                      })
                    : normalizedRunSpec
                yield* runWithTimeout(
                  sessionRuntime.runPrompt({
                    sessionId,
                    branchId,
                    agentName: params.agent.name,
                    prompt: params.prompt,
                    interactive: false,
                    ...(durableRunSpec !== undefined ? { runSpec: durableRunSpec } : {}),
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
                const preview =
                  success.text.length > 200 ? success.text.slice(0, 200) + "…" : success.text
                yield* durableRuntime.publishAgentRunSucceeded({
                  parentSessionId: params.parentSessionId,
                  parentBranchId: params.parentBranchId,
                  toolCallId,
                  sessionId,
                  agentName: params.agent.name,
                  usage: success.usage,
                  preview,
                  savedPath,
                })

                yield* WideEvent.set({
                  usage: success.usage,
                  toolCallCount: success.toolCalls?.length ?? 0,
                })

                return AgentRunResult.cases.success.make({ ...success, savedPath })
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
      }
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
> =>
  Layer.effect(
    AgentRunnerService,
    Effect.gen(function* () {
      const baseEventStore = yield* EventStore
      const extensionRegistry = yield* ExtensionRegistry
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const durableRuntime = yield* makeDurableAgentRunRuntime
      const metadataRuntime = yield* makeAgentRunMetadataRuntime
      const makeEphemeralAgentRootLayer = yield* makeEphemeralAgentRootLayerFactory

      const platform = yield* GentPlatform
      const notifyMirroredEventObservers = (_event: AgentEvent) => Effect.void

      return {
        run: Effect.fn("AgentRunner.run")(function* (params) {
          const persistence = resolveRunPersistence(params.runSpec)
          const toolCallId = params.runSpec?.parentToolCallId
          if (persistence === "ephemeral") {
            const sessionId = SessionId.make(yield* platform.randomId)
            const branchId = BranchId.make(yield* platform.randomId)
            return yield* runEphemeralAgent({
              runnerConfig: config,
              makeEphemeralAgentRootLayer,
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
            })
          }

          return yield* durableRuntime.createDurableAgentRunSession({ ...params, toolCallId }).pipe(
            Effect.flatMap(({ sessionId, branchId }) => {
              const run = Effect.gen(function* () {
                yield* WideEvent.set({ childSessionId: sessionId })

                // Capture trace context for subprocess propagation
                const currentSpan = yield* Effect.currentParentSpan.pipe(
                  Effect.orElseSucceed(() => undefined),
                )

                const binary = config.subprocessBinaryPath ?? "gent"
                // Merge parentToolCallId into runSpec for subprocess
                const subprocessRunSpec: RunSpec | undefined =
                  toolCallId !== undefined
                    ? makeRunSpec({
                        persistence: params.runSpec?.persistence,
                        overrides: params.runSpec?.overrides,
                        tags: params.runSpec?.tags,
                        parentToolCallId: toolCallId,
                      })
                    : params.runSpec
                const runSpecJson =
                  subprocessRunSpec !== undefined
                    ? yield* Schema.encodeEffect(Schema.fromJsonString(RunSpecSchema))(
                        subprocessRunSpec,
                      )
                    : undefined
                const args = [
                  binary,
                  "--headless",
                  "--session",
                  sessionId,
                  ...(config.sharedServerUrl !== undefined
                    ? ["--connect", config.sharedServerUrl]
                    : []),
                  ...(runSpecJson !== undefined ? ["--run-spec", runSpecJson] : []),
                  params.prompt,
                ]

                const parentEnv = yield* platform.env
                const env: Record<string, string | undefined> = {
                  ...parentEnv,
                  ...(config.dbPath !== undefined ? { GENT_DB_PATH: config.dbPath } : {}),
                  ...(config.sharedServerUrl !== undefined
                    ? { GENT_SHARED_SERVER_URL: config.sharedServerUrl }
                    : {}),
                  ...(currentSpan !== undefined
                    ? {
                        GENT_TRACE_ID: currentSpan.traceId,
                        GENT_PARENT_SPAN_ID: currentSpan.spanId,
                      }
                    : {}),
                }

                const [exitCode, stderrText] = yield* runProcess(binary, args.slice(1), {
                  cwd: params.cwd,
                  env,
                  stdout: "pipe",
                  stderr: "pipe",
                }).pipe(
                  Effect.map(
                    (result) => [result.exitCode, result.stderr] as readonly [number, string],
                  ),
                  Effect.catchTag("ProcessError", () =>
                    Effect.succeed([1, "Subprocess failed"] as readonly [number, string]),
                  ),
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                )

                if (exitCode !== 0) {
                  yield* durableRuntime.publishAgentRunFailed({
                    parentSessionId: params.parentSessionId,
                    parentBranchId: params.parentBranchId,
                    toolCallId,
                    sessionId,
                    agentName: params.agent.name,
                  })

                  return AgentRunResult.cases.error.make({
                    error:
                      stderrText.length > 0
                        ? stderrText.trim()
                        : `Subprocess exited with code ${exitCode}`,
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
                const preview =
                  success.text.length > 200 ? success.text.slice(0, 200) + "…" : success.text
                yield* durableRuntime.publishAgentRunSucceeded({
                  parentSessionId: params.parentSessionId,
                  parentBranchId: params.parentBranchId,
                  toolCallId,
                  sessionId,
                  agentName: params.agent.name,
                  usage: success.usage,
                  preview,
                  savedPath,
                })

                yield* WideEvent.set({
                  usage: success.usage,
                  toolCallCount: success.toolCalls?.length ?? 0,
                })

                return AgentRunResult.cases.success.make({ ...success, savedPath })
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
      }
    }),
  )
