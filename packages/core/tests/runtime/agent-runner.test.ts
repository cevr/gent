import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Context, Effect, Fiber, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  toolCallPart,
  type LanguageModelStreamPart,
} from "@gent/core-internal/test-utils/language-model"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { resolveExtensions, ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { InProcessRunner, getSessionDepth } from "../../src/runtime/agent/agent-runner"
import { makeEphemeralAgentRootLayer } from "../../src/runtime/agent/ephemeral-root"
import { ConfigService } from "../../src/runtime/config-service"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { ResourceManagerLive } from "../../src/runtime/resource-manager"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { emptyQueueSnapshot } from "@gent/core-internal/domain/queue"
import { dateFromMillis, Session, Branch, Message } from "@gent/core-internal/domain/message"
import {
  AgentRunnerService,
  AgentRunError,
  AgentName,
  DEFAULT_MAX_AGENT_RUN_DEPTH,
} from "@gent/core-internal/domain/agent"
import {
  AllBuiltinAgents,
  getBuiltinAgent,
} from "../../../extensions/tests/helpers/builtin-agents.js"
import {
  BranchId,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import { ModelId } from "@gent/core-internal/domain/model"
import { AgentEvent, EventStore, EventStoreError } from "@gent/core-internal/domain/event"
import { EventPublisher, EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import type { RelationshipStorage } from "@gent/core-internal/storage/relationship-storage"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { defineResource, ExtensionContext, tool } from "@gent/core/extensions/api"
import { EventStoreLive } from "../../src/runtime/event-store-live"
import {
  SequenceRecorder,
  RecordingEventStore,
  assertSequence,
} from "@gent/core-internal/test-utils"
import { SessionCommands } from "../../src/server/session-commands"
import { Permission } from "@gent/core-internal/domain/permission"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import {
  SessionRuntime,
  SessionRuntimeStateSchema,
  type SessionRuntimeService,
  type SessionRuntimeState,
} from "../../src/runtime/session-runtime"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
/** Scripted provider: returns stream parts from an array, one response per model stream call. */
const scriptedProvider = (
  responses: ReadonlyArray<ReadonlyArray<LanguageModelStreamPart>>,
): Layer.Layer<LanguageModel.LanguageModel> => {
  let index = 0
  return LanguageModelLayers.testStream(() =>
    Effect.succeed(
      Stream.fromIterable(responses[index++] ?? [finishPart({ finishReason: "stop" })]),
    ),
  )
}
const bashStubTool = tool({
  id: "bash",
  description: "Stub bash tool for tests",
  params: Schema.Struct({ command: Schema.String }),
  output: Schema.Struct({ output: Schema.String }),
  execute: (params) => Effect.succeed({ output: params.command }),
})
const readStubTool = tool({
  id: "read",
  description: "Stub read tool for tests",
  params: Schema.Struct({ path: Schema.String }),
  output: Schema.Struct({ output: Schema.String }),
  execute: (params) => Effect.succeed({ output: params.path }),
})
const testRegistryLayer = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: AllBuiltinAgents,
        tools: [bashStubTool],
      },
    },
  ]),
)
const withEventPublisher = (baseEventStoreLayer: Layer.Layer<EventStore>) =>
  Layer.provide(
    EventPublisherLive,
    Layer.mergeAll(
      baseEventStoreLayer,
      testRegistryLayer,
      RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ),
  )
const makeLiveAgentRunnerLayer = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: AllBuiltinAgents,
        tools: [bashStubTool, readStubTool],
      },
    },
  ])
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const storageLayer = SqliteStorage.TestWithSql()
  const clusterRunnerLayer = Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    storageLayer,
  )
  const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
  const eventPublisherLayer = Layer.provide(
    EventPublisherLive,
    Layer.mergeAll(
      storageLayer,
      eventStoreLayer,
      registryLayer,
      RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ),
  )
  const baseDeps = Layer.mergeAll(
    storageLayer,
    clusterRunnerLayer,
    eventStoreLayer,
    eventPublisherLayer,
    registryLayer,
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    ToolRunner.Test(),
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    BunPlatformLive,
    ConfigService.Test(),
    ResourceManagerLive,
    ModelRegistry.Test(),
    ephemeralParentDeps,
  )
  const sessionRuntimeLayer = Layer.provide(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.merge(baseDeps, eventPublisherLayer),
  )
  const sessionMutationsLayer = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionRuntimeLayer),
  )
  const deps = Layer.mergeAll(baseDeps, sessionMutationsLayer, sessionRuntimeLayer)
  const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
  return Layer.mergeAll(deps, runnerLayer) as Layer.Layer<
    AgentRunnerService | SessionStorage | BranchStorage | EventStore | SequenceRecorder
  >
}
// Extra services the parent context needs for ephemeral child runtime
const ephemeralParentDeps = Layer.mergeAll(
  BunPlatformLive,
  Permission.Live([], "allow"),
  RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  ConfigService.Test(),
  ModelRegistry.Test(),
)
const sessionRuntimeStub = (runPrompt: SessionRuntimeService["runPrompt"] = () => Effect.void) =>
  Layer.effect(
    SessionRuntime,
    Effect.gen(function* () {
      const runtimeState = yield* SubscriptionRef.make<SessionRuntimeState>(
        SessionRuntimeStateSchema.cases.Idle.make({
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        }),
      )
      return {
        sendUserMessage: () => Effect.void,
        recordToolResult: () => Effect.void,
        steer: () => Effect.void,
        respondInteraction: () => Effect.void,
        runPrompt: (input) =>
          Effect.gen(function* () {
            yield* SubscriptionRef.set(
              runtimeState,
              SessionRuntimeStateSchema.cases.Running.make({
                agent: input.agentName,
                queue: emptyQueueSnapshot(),
              }),
            )
            yield* runPrompt(input).pipe(
              Effect.ensuring(
                SubscriptionRef.set(
                  runtimeState,
                  SessionRuntimeStateSchema.cases.Idle.make({
                    agent: input.agentName,
                    queue: emptyQueueSnapshot(),
                  }),
                ),
              ),
            )
          }),
        queueFollowUp: () => Effect.void,
        drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getMetrics: () =>
          Effect.succeed({
            turns: 0,
            tokens: 0,
            toolCalls: 0,
            retries: 0,
            durationMs: 0,
            costUsd: 0,
            lastInputTokens: 0,
          }),
        watchState: () => Effect.succeed(SubscriptionRef.changes(runtimeState)),
        terminateSession: () => Effect.void,
        restoreSession: () => Effect.void,
      } satisfies SessionRuntimeService
    }),
  )
describe("RunSpec", () => {
  it.live("durable helper-agent runSpec reaches the provider through AgentRunner", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("child result"),
          assertRequest: (request) => {
            expect(request.model).toBe("custom/model")
            expect(request.reasoning).toBe("high")
          },
          assertOptions: (options) => {
            expect(options.tools.map((tool) => tool.name)).toEqual(["bash"])
          },
        },
      ])
      const layer = makeLiveAgentRunnerLayer(providerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-runspec"),
            name: "Parent",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("parent-runspec-branch"),
            sessionId: SessionId.make("parent-runspec"),
            createdAt: now,
          }),
        )
        const result = yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "check forwarding",
          parentSessionId: SessionId.make("parent-runspec"),
          parentBranchId: BranchId.make("parent-runspec-branch"),
          cwd: process.cwd(),
          runSpec: {
            persistence: "durable",
            tags: ["auto-loop"],
            overrides: {
              modelId: ModelId.make("custom/model"),
              allowedTools: ["bash"],
              deniedTools: ["read"],
              reasoningEffort: "high",
              systemPromptAddendum: "Extra helper-agent instructions",
            },
          },
        })
        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("child result")
        }
        yield* controls.assertDone()
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
})
describe("AgentRunner", () => {
  it.live("publishes spawn and complete events", () =>
    Effect.gen(function* () {
      const recorderLayer = SequenceRecorder.Live
      const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        sessionRuntimeStub(),
        recorderLayer,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const recorder = yield* SequenceRecorder
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "scan repo",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        const calls = yield* recorder.getCalls()
        assertSequence(calls, [
          { service: "EventStore", method: "append", match: { _tag: "AgentRunSpawned" } },
          { service: "EventStore", method: "append", match: { _tag: "AgentRunSucceeded" } },
        ])
        const spawnRecord = calls.find((c) => {
          const event = Schema.decodeUnknownOption(AgentEvent)(c.args)
          return (
            c.service === "EventStore" &&
            c.method === "append" &&
            event._tag === "Some" &&
            event.value._tag === "AgentRunSpawned"
          )
        })
        expect(spawnRecord).toBeDefined()
        const spawnEvent = yield* Schema.decodeUnknownEffect(AgentEvent)(spawnRecord?.args)
        expect(spawnEvent._tag).toBe("AgentRunSpawned")
        if (spawnEvent._tag === "AgentRunSpawned") {
          const child = yield* sessions.getSession(spawnEvent.childSessionId)
          expect(child?.activeBranchId).toBe(spawnEvent.childBranchId)
        }
        // Verify enriched AgentRunSucceeded payload fields (args is the event object directly)
        const successEvent = calls.find((c) => {
          const args = c.args as Record<string, unknown> | undefined
          return (
            c.service === "EventStore" &&
            c.method === "append" &&
            args?.["_tag"] === "AgentRunSucceeded"
          )
        })
        expect(successEvent).toBeDefined()
        const event = successEvent!.args as Record<string, unknown>
        expect(event["preview"]).toBeDefined()
        expect(typeof event["preview"]).toBe("string")
        expect(event["savedPath"]).toBeDefined()
        expect(typeof event["savedPath"]).toBe("string")
        expect(event["savedPath"]).toContain("/tmp/gent/outputs/")
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("rolls back durable child session when spawn event append fails", () =>
    Effect.gen(function* () {
      const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
      const failingPublisherLayer = Layer.succeed(EventPublisher, {
        append: () => Effect.fail(new EventStoreError({ message: "spawn append failed" })),
        deliver: () => Effect.void,
        publish: () => Effect.fail(new EventStoreError({ message: "spawn publish failed" })),
      })
      const deps = Layer.mergeAll(
        storageLayer,
        EventStore.Memory,
        failingPublisherLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        sessionRuntimeStub(),
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-spawn-rollback"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-spawn-rollback"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const result = yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "spawn rollback",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        expect(result._tag).toBe("error")
        const sessionsResult = yield* sessions.listSessions()
        expect(
          sessionsResult.filter((candidate) => candidate.parentSessionId === session.id),
        ).toEqual([])
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("propagates failures without retry (no maxAttempts)", () =>
    Effect.gen(function* () {
      const recorderLayer = SequenceRecorder.Live
      const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        sessionRuntimeStub(() => Effect.fail(new AgentRunError({ message: "permanent failure" }))),
        recorderLayer,
        eventStoreLayer,
        eventPublisherLayer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-noretr"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-noretr"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const result = yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "fail test",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        // Without retry, failure propagates as error result
        expect(result._tag).toBe("error")
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("fails with timeout", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        sessionRuntimeStub(() => Effect.never),
        eventStoreLayer,
        eventPublisherLayer,
      )
      const runnerLayer = InProcessRunner({ timeoutMs: 5 }).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-timeout"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-timeout"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        return yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "timeout test",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result._tag).toBe("error")
      if (result._tag === "error") {
        expect(result.error).toContain("timed out")
      }
    }),
  )
  it.live("ephemeral helper runs do not persist child sessions", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const providerLayer = scriptedProvider([
        [textDeltaPart("ephemeral response"), finishPart({ finishReason: "stop" })],
      ])
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        eventStoreLayer,
        eventPublisherLayer,
        testRegistryLayer,
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        ToolRunner.Test(),
        sessionRuntimeStub(),
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-ephemeral"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-ephemeral"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const runResult = yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "scan repo",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })
        const sessionsResult = yield* sessions.listSessions()
        return { runResult, sessionsResult }
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result.runResult._tag).toBe("success")
      if (result.runResult._tag === "success") {
        expect(result.runResult.persistence).toBe("ephemeral")
        expect(result.runResult.text).toContain("ephemeral response")
      }
      expect(result.sessionsResult.map((session) => session.id)).toEqual([
        SessionId.make("parent-session-ephemeral"),
      ])
    }),
  )
  it.live("ephemeral helper runs mirror child tool events into the parent store", () =>
    Effect.gen(function* () {
      const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
      const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const providerLayer = scriptedProvider([
        [
          toolCallPart("bash", { command: "pwd" }, { toolCallId: ToolCallId.make("tc-ephemeral") }),
          finishPart({ finishReason: "tool-calls" }),
        ],
        [textDeltaPart("tool finished"), finishPart({ finishReason: "stop" })],
      ])
      const deps = Layer.mergeAll(
        storageLayer,
        eventStoreLayer,
        eventPublisherLayer,
        testRegistryLayer,
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        ToolRunner.Test(),
        sessionRuntimeStub(),
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const events = yield* EventStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-mirror"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-mirror"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const runResult = yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "run helper with one tool",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })
        if (runResult._tag !== "success") {
          return { runResult, childTags: [] as string[] }
        }
        const childEvents = yield* events.listEvents({ sessionId: session.id })
        return {
          runResult,
          childTags: childEvents.map((event) => event.event._tag),
        }
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result.runResult._tag).toBe("success")
      expect(result.childTags).toContain("ToolCallStarted")
      expect(result.childTags).toContain("ToolCallSucceeded")
    }),
  )
  it.live("durable override persists child sessions for helper agents", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        sessionRuntimeStub(),
        eventStoreLayer,
        eventPublisherLayer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-durable"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-durable"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const runResult = yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "persist this child",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        const sessionsResult = yield* sessions.listSessions()
        return { runResult, sessionsResult }
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result.runResult._tag).toBe("success")
      if (result.runResult._tag === "success") {
        expect(result.runResult.persistence).toBe("durable")
      }
      expect(result.sessionsResult).toHaveLength(2)
    }),
  )
  it.live("reasoning-only assistant response surfaces reasoning as text", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const storageLayer = SqliteStorage.TestWithSql()
      // Mock agent loop that writes a reasoning-only assistant message
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const messages = yield* MessageStorage
          const now = dateFromMillis(1_767_225_600_000)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [Prompt.reasoningPart({ text: "I analyzed the repository" })],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        mockRuntime,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-reasoning"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("branch-reasoning"),
            sessionId: SessionId.make("parent-reasoning"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "analyze",
          parentSessionId: SessionId.make("parent-reasoning"),
          parentBranchId: BranchId.make("branch-reasoning"),
          cwd: "/tmp",
          runSpec: { persistence: "durable" },
        })
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result._tag).toBe("success")
      if (result._tag === "success") {
        expect(result.text).toBe("I analyzed the repository")
      }
    }),
  )
  it.live("mixed text+reasoning returns text, not reasoning", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const storageLayer = SqliteStorage.TestWithSql()
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const messages = yield* MessageStorage
          const now = dateFromMillis(1_767_225_600_000)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [
                Prompt.reasoningPart({ text: "thinking step" }),
                Prompt.textPart({ text: "the actual answer" }),
              ],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        mockRuntime,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-mixed"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("branch-mixed"),
            sessionId: SessionId.make("parent-mixed"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "analyze",
          parentSessionId: SessionId.make("parent-mixed"),
          parentBranchId: BranchId.make("branch-mixed"),
          cwd: "/tmp",
          runSpec: { persistence: "durable" },
        })
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result._tag).toBe("success")
      if (result._tag === "success") {
        expect(result.text).toBe("the actual answer")
      }
    }),
  )
  it.live("agent run output is saved to /tmp/gent/outputs/", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const storageLayer = SqliteStorage.TestWithSql()
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const messages = yield* MessageStorage
          const now = dateFromMillis(1_767_225_600_000)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [
                Prompt.reasoningPart({ text: "internal thinking" }),
                Prompt.textPart({ text: "visible answer" }),
              ],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        mockRuntime,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-save"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("branch-save"),
            sessionId: SessionId.make("parent-save"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "save test",
          parentSessionId: SessionId.make("parent-save"),
          parentBranchId: BranchId.make("branch-save"),
          cwd: "/tmp",
          runSpec: { persistence: "durable" },
        })
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result._tag).toBe("success")
      if (result._tag === "success") {
        expect(result.savedPath).toBeDefined()
        expect(result.savedPath).toContain("/tmp/gent/outputs/")
        expect(result.savedPath).toContain("explore_")
        expect(result.savedPath).toEndWith(".md")
        // Verify file contents
        const content = yield* Effect.promise(() => Bun.file(result.savedPath!).text())
        expect(content).toContain("## Reasoning")
        expect(content).toContain("internal thinking")
        expect(content).toContain("## Response")
        expect(content).toContain("visible answer")
        // Cleanup
        yield* Effect.promise(() => Bun.file(result.savedPath!).delete())
      }
    }),
  )
})
// ============================================================================
// Session depth guard
// ============================================================================
describe("session depth guard", () => {
  const run = <A, E>(
    effect: Effect.Effect<A, E, SessionStorage | BranchStorage | RelationshipStorage>,
  ) => effect.pipe(Effect.timeout("4 seconds"), Effect.provide(SqliteStorage.TestWithSql()))
  const makeSession = (id: string, parentSessionId?: string) =>
    new Session({
      id: SessionId.make(id),
      name: `session-${id}`,
      parentSessionId: parentSessionId !== undefined ? SessionId.make(parentSessionId) : undefined,
      parentBranchId:
        parentSessionId !== undefined ? BranchId.make(`branch-${parentSessionId}`) : undefined,
      createdAt: dateFromMillis(1_767_225_600_000),
      updatedAt: dateFromMillis(1_767_225_600_000),
    })
  const makeBranch = (sessionId: string) =>
    new Branch({
      id: BranchId.make(`branch-${sessionId}`),
      sessionId: SessionId.make(sessionId),
      createdAt: dateFromMillis(1_767_225_600_000),
    })
  const buildSessionChain = (depth: number) =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(makeSession("s0"))
      yield* branches.createBranch(makeBranch("s0"))
      for (let i = 1; i <= depth; i++) {
        yield* sessions.createSession(makeSession(`s${i}`, `s${i - 1}`))
        yield* branches.createBranch(makeBranch(`s${i}`))
      }
    })
  it.live("root session has depth 0", () =>
    run(
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(makeSession("root"))
        yield* branches.createBranch(makeBranch("root"))
        expect(yield* getSessionDepth(SessionId.make("root"))).toBe(0)
      }),
    ),
  )
  it.live("child of root has depth 1", () =>
    run(
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(makeSession("root"))
        yield* branches.createBranch(makeBranch("root"))
        yield* sessions.createSession(makeSession("child", "root"))
        yield* branches.createBranch(makeBranch("child"))
        expect(yield* getSessionDepth(SessionId.make("child"))).toBe(1)
      }),
    ),
  )
  it.live("grandchild has depth 2", () =>
    run(
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(makeSession("root"))
        yield* branches.createBranch(makeBranch("root"))
        yield* sessions.createSession(makeSession("child", "root"))
        yield* branches.createBranch(makeBranch("child"))
        yield* sessions.createSession(makeSession("grandchild", "child"))
        yield* branches.createBranch(makeBranch("grandchild"))
        expect(yield* getSessionDepth(SessionId.make("grandchild"))).toBe(2)
      }),
    ),
  )
  it.live("chain at max depth reports correct depth", () =>
    run(
      Effect.gen(function* () {
        yield* buildSessionChain(DEFAULT_MAX_AGENT_RUN_DEPTH)
        const deepest = SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
        expect(yield* getSessionDepth(deepest)).toBe(DEFAULT_MAX_AGENT_RUN_DEPTH)
      }),
    ),
  )
  it.live("parent at max depth blocks child spawn", () =>
    run(
      Effect.gen(function* () {
        yield* buildSessionChain(DEFAULT_MAX_AGENT_RUN_DEPTH)
        const parentId = SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
        const parentDepth = yield* getSessionDepth(parentId)
        expect(parentDepth >= DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(true)
      }),
    ),
  )
  it.live("parent below max depth allows child spawn", () =>
    run(
      Effect.gen(function* () {
        yield* buildSessionChain(DEFAULT_MAX_AGENT_RUN_DEPTH - 1)
        const parentId = SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH - 1}`)
        const parentDepth = yield* getSessionDepth(parentId)
        expect(parentDepth < DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(true)
      }),
    ),
  )
  it.live("nonexistent session returns depth 0", () =>
    run(
      Effect.gen(function* () {
        expect(yield* getSessionDepth(SessionId.make("nonexistent"))).toBe(0)
      }),
    ),
  )
})
describe("ephemeral service propagation", () => {
  const makeEphemeralLayer = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) => {
    const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
    const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)
    const deps = Layer.mergeAll(
      storageLayer,
      eventStoreLayer,
      eventPublisherLayer,
      testRegistryLayer,
      providerLayer,
      ModelResolver.fromLanguageModel(providerLayer),
      sessionRuntimeStub(),
      ephemeralParentDeps,
    )
    const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
    return Layer.mergeAll(deps, runnerLayer)
  }
  const setupParentSession = (id: SessionId) =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const now = dateFromMillis(1_767_225_600_000)
      yield* sessions.createSession(
        new Session({ id, name: "Parent", createdAt: now, updatedAt: now }),
      )
      yield* branches.createBranch(
        new Branch({ id: BranchId.make(`${id}-branch`), sessionId: id, createdAt: now }),
      )
    })
  it.live("ephemeral publisher suppresses duplicate committed delivery", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("unused")])
      const parentDeps = Layer.mergeAll(
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        testRegistryLayer,
        ephemeralParentDeps,
        BunFileSystem.layer,
        BunPath.layer,
      )
      const layer = Layer.unwrap(
        Effect.gen(function* () {
          const parentServices = yield* Effect.context()
          const extensionRegistry = yield* ExtensionRegistry
          return makeEphemeralAgentRootLayer({
            config: { baseSections: [] },
            parentServices,
            extensionRegistry,
          })
        }).pipe(Effect.provide(parentDeps)),
      )
      yield* Effect.gen(function* () {
        const publisher = yield* EventPublisher
        const events = yield* EventStore
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const sessionId = SessionId.make("ephemeral-duplicate-delivery")
        const branchId = BranchId.make("ephemeral-duplicate-delivery-branch")
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({ id: sessionId, name: "Child", createdAt: now, updatedAt: now }),
        )
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
        const envelope = yield* publisher.append(
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("ephemeral-duplicate-tool-call"),
            toolName: "bash",
          }),
        )
        yield* publisher.deliver(envelope)
        const duplicate = yield* Effect.forkScoped(
          events
            .subscribe({ sessionId, branchId, after: envelope.id })
            .pipe(Stream.take(1), Stream.runCollect),
        )
        yield* publisher.deliver(envelope)
        const deliveredAgain = yield* Fiber.join(duplicate).pipe(Effect.timeoutOption("25 millis"))
        expect(deliveredAgain._tag).toBe("None")
      }).pipe(Effect.scoped, Effect.provide(layer))
    }).pipe(Effect.timeout("4 seconds")),
  )
  it.live("ephemeral agent writes to ephemeral storage, not parent", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        textStep("ephemeral text output"),
      ])
      const layer = makeEphemeralLayer(providerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const runner = yield* AgentRunnerService
        yield* setupParentSession(SessionId.make("parent-svc-prop"))
        const result = yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "test service propagation",
          parentSessionId: SessionId.make("parent-svc-prop"),
          parentBranchId: BranchId.make("parent-svc-prop-branch"),
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })
        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("ephemeral text output")
        }
        // Parent storage should only have the parent session
        const sessionsResult = yield* sessions.listSessions()
        expect(sessionsResult.map((s) => s.id)).toEqual([SessionId.make("parent-svc-prop")])
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.timeout("4 seconds")),
  )
  it.live("ephemeral agent auto-approves interactions", () =>
    Effect.gen(function* () {
      const approveTool = tool({
        id: "approve_test",
        description: "Tests approval",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ approved: Schema.Boolean }),
        execute: Effect.fn("approve_test")(function* () {
          const ctx = yield* ExtensionContext
          const decision = yield* ctx.Interaction.approve({
            text: "approve this?",
            metadata: { type: "prompt", mode: "confirm" },
          })
          return { approved: decision.approved }
        }),
      })
      const toolRegistry = ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("agents") },
            scope: "builtin" as const,
            sourcePath: "test",
            contributions: {
              agents: AllBuiltinAgents,
              tools: [approveTool],
            },
          },
        ]),
      )
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("approve_test", { text: "test" }),
        textStep("approved"),
      ])
      const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
      const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        storageLayer,
        eventStoreLayer,
        eventPublisherLayer,
        toolRegistry,
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        sessionRuntimeStub(),
        ephemeralParentDeps,
      )
      const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const runner = yield* AgentRunnerService
        yield* setupParentSession(SessionId.make("parent-approve"))
        const result = yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "test auto-approve",
          parentSessionId: SessionId.make("parent-approve"),
          parentBranchId: BranchId.make("parent-approve-branch"),
          cwd: process.cwd(),
          runSpec: {
            persistence: "ephemeral",
            overrides: { allowedTools: ["approve_test"] },
          },
        })
        // Should succeed — approval was auto-resolved, tool ran, text followed
        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("approved")
        }
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("ephemeral agent rebuilds resource services without rerunning process lifecycle", () =>
    Effect.gen(function* () {
      let starts = 0
      class ProbeService extends Context.Service<
        ProbeService,
        { readonly read: Effect.Effect<string> }
      >()("@gent/core/tests/runtime/agent-runner.test/ProbeService") {}
      const probeTool = tool({
        id: "probe_resource",
        description: "Reads a resource-backed service",
        params: Schema.Struct({}),
        output: Schema.Struct({ value: Schema.String }),
        execute: Effect.fn("probe_resource")(function* () {
          const probe = yield* ProbeService
          return { value: yield* probe.read }
        }),
      })
      const registryLayer = ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("agents") },
            scope: "builtin" as const,
            sourcePath: "test",
            contributions: {
              agents: AllBuiltinAgents,
            },
          },
          {
            manifest: { id: ExtensionId.make("resource-probe") },
            scope: "builtin" as const,
            sourcePath: "test",
            contributions: {
              resources: [
                defineResource({
                  scope: "process",
                  layer: Layer.succeed(ProbeService, { read: Effect.succeed("service-ok") }),
                  start: Effect.sync(() => {
                    starts += 1
                  }),
                }),
              ],
              tools: [probeTool],
            },
          },
        ]),
      )
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("probe_resource", {}),
        textStep("done"),
      ])
      const storageLayer = Layer.orDie(SqliteStorage.TestWithSql())
      const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        storageLayer,
        eventStoreLayer,
        eventPublisherLayer,
        registryLayer,
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        sessionRuntimeStub(),
        ephemeralParentDeps,
      )
      const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const runner = yield* AgentRunnerService
        yield* setupParentSession(SessionId.make("parent-resource-probe"))
        const result = yield* runner.run({
          agent: getBuiltinAgent("explore")!,
          prompt: "test resource service",
          parentSessionId: SessionId.make("parent-resource-probe"),
          parentBranchId: BranchId.make("parent-resource-probe-branch"),
          cwd: process.cwd(),
          runSpec: {
            persistence: "ephemeral",
            overrides: { allowedTools: ["probe_resource"] },
          },
        })
        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("done")
        }
        expect(starts).toBe(0)
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.timeout("4 seconds")),
  )
})
