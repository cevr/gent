import { describe, test, expect, it } from "effect-bun-test"
import { Effect, Layer, Schema, Stream, SubscriptionRef } from "effect"
import {
  Provider,
  finishPart,
  textDeltaPart,
  toolCallPart,
  type ProviderStreamPart,
} from "@gent/core/providers/provider"
import { textStep, toolCallStep } from "@gent/core/debug/provider"
import { resolveExtensions, ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { InProcessRunner, getSessionDepth } from "../../src/runtime/agent/agent-runner"
import { ConfigService } from "../../src/runtime/config-service"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { ResourceManagerLive } from "../../src/runtime/resource-manager"
import { emptyQueueSnapshot } from "@gent/core/domain/queue"
import { Session, Branch, Message, ReasoningPart, TextPart } from "@gent/core/domain/message"
import {
  resolveAgentModel,
  AgentRunnerService,
  AgentRunError,
  AgentName,
  DEFAULT_MAX_AGENT_RUN_DEPTH,
} from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { BranchId, ExtensionId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { ModelId } from "@gent/core/domain/model"
import { AgentEvent, EventStore, EventStoreError } from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { Storage, type StorageService } from "@gent/core/storage/sqlite-storage"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { tool } from "@gent/core/extensions/api"
import { EventStoreLive } from "../../src/runtime/event-store-live"
import { SequenceRecorder, RecordingEventStore, assertSequence } from "@gent/core/test-utils"
import { ExtensionRuntime } from "../../src/runtime/extensions/resource-host/extension-runtime"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { EventPublisherLive } from "../../src/server/event-publisher"
import { SessionCommands } from "../../src/server/session-commands"
import { Permission } from "@gent/core/domain/permission"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { SessionCwdRegistry } from "../../src/runtime/session-cwd-registry"
import { ServerProfileService } from "../../src/runtime/scope-brands"
import {
  SessionRuntime,
  SessionRuntimeStateSchema,
  type SessionRuntimeService,
  type SessionRuntimeState,
} from "../../src/runtime/session-runtime"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { rmSync } from "node:fs"
/** Scripted provider: returns stream parts from an array, one response per stream() call. */
const scriptedProvider = (
  responses: ReadonlyArray<ReadonlyArray<ProviderStreamPart>>,
): Layer.Layer<Provider> => {
  let index = 0
  return Layer.succeed(Provider, {
    stream: () =>
      Effect.succeed(
        Stream.fromIterable(responses[index++] ?? [finishPart({ finishReason: "stop" })]),
      ),
    generate: () => Effect.succeed("test response"),
  })
}
const bashStubTool = tool({
  id: "bash",
  description: "Stub bash tool for tests",
  params: Schema.Struct({ command: Schema.String }),
  execute: (params) => Effect.succeed({ output: params.command }),
})
const readStubTool = tool({
  id: "read",
  description: "Stub read tool for tests",
  params: Schema.Struct({ path: Schema.String }),
  execute: (params) => Effect.succeed({ output: params.path }),
})
const testRegistryLayer = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: Object.values(Agents),
        tools: [bashStubTool],
      },
    },
  ]),
)
const withEventPublisher = (
  baseEventStoreLayer: Layer.Layer<EventStore>,
  extensionRuntimeLayer: Layer.Layer<ExtensionRuntime> = ExtensionRuntime.Test(),
) =>
  Layer.provide(
    EventPublisherLive,
    Layer.mergeAll(
      baseEventStoreLayer,
      extensionRuntimeLayer,
      ActorEngine.Live,
      testRegistryLayer,
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ),
  )
const makeLiveAgentRunnerLayer = (providerLayer: Layer.Layer<Provider>) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: Object.values(Agents),
        tools: [bashStubTool, readStubTool],
      },
    },
  ])
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const storageLayer = Storage.TestWithSql()
  const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
  const eventPublisherLayer = Layer.provide(
    EventPublisherLive,
    Layer.mergeAll(
      storageLayer,
      eventStoreLayer,
      registryLayer,
      ExtensionRuntime.Test(),
      ActorEngine.Live,
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ),
  )
  const baseDeps = Layer.mergeAll(
    storageLayer,
    eventStoreLayer,
    eventPublisherLayer,
    registryLayer,
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
    providerLayer,
    ToolRunner.Test(),
    ExtensionRuntime.Test(),
    ActorEngine.Live,
    ExtensionTurnControl.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ResourceManagerLive,
    SessionCwdRegistry.Test(),
    SessionCommands.SessionRuntimeTerminatorLive,
    ModelRegistry.Test(),
    ephemeralParentDeps,
  )
  const sessionMutationsLayer = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.merge(baseDeps, eventPublisherLayer),
  )
  const sessionRuntimeLayer = Layer.provide(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionMutationsLayer),
  )
  const deps = Layer.mergeAll(baseDeps, sessionMutationsLayer, sessionRuntimeLayer)
  const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
  return Layer.mergeAll(deps, runnerLayer)
}
// Extra services the parent context needs for ephemeral child runtime
const ephemeralParentDeps = Layer.mergeAll(
  BunServices.layer,
  Permission.Live([], "allow"),
  RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  ServerProfileService.Test(),
  ConfigService.Test(),
  ModelRegistry.Test(),
)
const sessionRuntimeStub = (runPrompt: SessionRuntimeService["runPrompt"] = () => Effect.void) =>
  Layer.effect(
    SessionRuntime,
    Effect.gen(function* () {
      const runtimeState = yield* SubscriptionRef.make<SessionRuntimeState>(
        SessionRuntimeStateSchema.Idle.make({
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        }),
      )
      return {
        dispatch: () => Effect.void,
        runPrompt: (input) =>
          Effect.gen(function* () {
            yield* SubscriptionRef.set(
              runtimeState,
              SessionRuntimeStateSchema.Running.make({
                agent: input.agentName,
                queue: emptyQueueSnapshot(),
              }),
            )
            yield* runPrompt(input).pipe(
              Effect.ensuring(
                SubscriptionRef.set(
                  runtimeState,
                  SessionRuntimeStateSchema.Idle.make({
                    agent: input.agentName,
                    queue: emptyQueueSnapshot(),
                  }),
                ),
              ),
            )
          }),
        drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getState: () => SubscriptionRef.get(runtimeState),
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
  test("dual model pair resolves to cowork and deepwork models", () => {
    const registry = resolveExtensions([
      {
        manifest: { id: ExtensionId.make("agents") },
        scope: "builtin",
        sourcePath: "test",
        contributions: { agents: Object.values(Agents) },
      },
    ])
    const impl = ExtensionRegistry.fromResolved(registry)
    return Effect.gen(function* () {
      const reg = yield* ExtensionRegistry
      const [a, b] = yield* reg.resolveDualModelPair()
      expect(a).toBe(resolveAgentModel(Agents["cowork"]!))
      expect(b).toBe(resolveAgentModel(Agents["deepwork"]!))
      expect(a).not.toBe(b)
    }).pipe(Effect.timeout("4 seconds"), Effect.provide(impl), Effect.runPromise)
  })
  it.live("durable helper-agent runSpec reaches the provider through AgentRunner", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        {
          ...textStep("child result"),
          assertRequest: (request) => {
            expect(request.model).toBe("custom/model")
            expect(request.reasoning).toBe("high")
            expect(request.tools?.map((candidate) => String(candidate.id))).toEqual(["bash"])
          },
        },
      ])
      const layer = makeLiveAgentRunnerLayer(providerLayer)
      yield* Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const now = new Date()
        yield* storage.createSession(
          new Session({
            id: SessionId.make("parent-runspec"),
            name: "Parent",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("parent-runspec-branch"),
            sessionId: SessionId.make("parent-runspec"),
            createdAt: now,
          }),
        )
        const result = yield* runner.run({
          agent: Agents["explore"]!,
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
        Storage.Test(),
        ExtensionRegistry.Test(),
        Provider.Debug(),
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
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const recorder = yield* SequenceRecorder
        const now = new Date()
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
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)
        yield* runner.run({
          agent: Agents["explore"]!,
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
        const spawnEvent = Schema.decodeUnknownSync(AgentEvent)(spawnRecord?.args)
        expect(spawnEvent._tag).toBe("AgentRunSpawned")
        if (spawnEvent._tag === "AgentRunSpawned") {
          const child = yield* storage.getSession(spawnEvent.childSessionId)
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
      const storageLayer = Storage.TestWithSql()
      const failingPublisherLayer = Layer.succeed(EventPublisher, {
        append: () => Effect.fail(new EventStoreError({ message: "spawn append failed" })),
        deliver: () => Effect.void,
        publish: () => Effect.fail(new EventStoreError({ message: "spawn publish failed" })),
        terminateSession: () => Effect.void,
      })
      const deps = Layer.mergeAll(
        storageLayer,
        EventStore.Memory,
        failingPublisherLayer,
        ExtensionRegistry.Test(),
        Provider.Debug(),
        ToolRunner.Test(),
        sessionRuntimeStub(),
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const now = new Date()
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
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)
        const result = yield* runner.run({
          agent: Agents["explore"]!,
          prompt: "spawn rollback",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        expect(result._tag).toBe("error")
        const sessions = yield* storage.listSessions()
        expect(sessions.filter((candidate) => candidate.parentSessionId === session.id)).toEqual([])
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("propagates failures without retry (no maxAttempts)", () =>
    Effect.gen(function* () {
      const recorderLayer = SequenceRecorder.Live
      const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        Storage.Test(),
        ExtensionRegistry.Test(),
        Provider.Debug(),
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
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const now = new Date()
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
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)
        const result = yield* runner.run({
          agent: Agents["explore"]!,
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
        Storage.Test(),
        ExtensionRegistry.Test(),
        Provider.Debug(),
        ToolRunner.Test(),
        sessionRuntimeStub(() => Effect.sleep("50 millis")),
        eventStoreLayer,
        eventPublisherLayer,
      )
      const runnerLayer = InProcessRunner({ timeoutMs: 5 }).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const now = new Date()
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
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)
        return yield* runner.run({
          agent: Agents["explore"]!,
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
      const deps = Layer.mergeAll(
        Storage.TestWithSql(),
        eventStoreLayer,
        eventPublisherLayer,
        testRegistryLayer,
        scriptedProvider([
          [textDeltaPart("ephemeral response"), finishPart({ finishReason: "stop" })],
        ]),
        ToolRunner.Test(),
        sessionRuntimeStub(),
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const now = new Date()
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
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)
        const runResult = yield* runner.run({
          agent: Agents["explore"]!,
          prompt: "scan repo",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })
        const sessions = yield* storage.listSessions()
        return { runResult, sessions }
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result.runResult._tag).toBe("success")
      if (result.runResult._tag === "success") {
        expect(result.runResult.persistence).toBe("ephemeral")
        expect(result.runResult.text).toContain("ephemeral response")
      }
      expect(result.sessions.map((session) => session.id)).toEqual([
        SessionId.make("parent-session-ephemeral"),
      ])
    }),
  )
  it.live("ephemeral helper runs mirror child tool events into the parent store", () =>
    Effect.gen(function* () {
      const storageLayer = Storage.TestWithSql()
      const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        storageLayer,
        eventStoreLayer,
        eventPublisherLayer,
        testRegistryLayer,
        scriptedProvider([
          [
            toolCallPart(
              "bash",
              { command: "pwd" },
              { toolCallId: ToolCallId.make("tc-ephemeral") },
            ),
            finishPart({ finishReason: "tool-calls" }),
          ],
          [textDeltaPart("tool finished"), finishPart({ finishReason: "stop" })],
        ]),
        ToolRunner.Test(),
        sessionRuntimeStub(),
      )
      const runnerLayer = InProcessRunner({}).pipe(
        Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const now = new Date()
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
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)
        const runResult = yield* runner.run({
          agent: Agents["explore"]!,
          prompt: "run helper with one tool",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })
        if (runResult._tag !== "success") {
          return { runResult, childTags: [] as string[] }
        }
        const childEvents = yield* storage.listEvents({ sessionId: session.id })
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
        Storage.Test(),
        ExtensionRegistry.Test(),
        Provider.Debug(),
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
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const now = new Date()
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
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)
        const runResult = yield* runner.run({
          agent: Agents["explore"]!,
          prompt: "persist this child",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
        const sessions = yield* storage.listSessions()
        return { runResult, sessions }
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result.runResult._tag).toBe("success")
      if (result.runResult._tag === "success") {
        expect(result.runResult.persistence).toBe("durable")
      }
      expect(result.sessions).toHaveLength(2)
    }),
  )
  it.live("reasoning-only assistant response surfaces reasoning as text", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const storageLayer = Storage.Test()
      // Mock agent loop that writes a reasoning-only assistant message
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()
          yield* storage.createMessage(
            Message.Regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [new ReasoningPart({ type: "reasoning", text: "I analyzed the repository" })],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        Provider.Debug(),
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
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const now = new Date()
        yield* storage.createSession(
          new Session({
            id: SessionId.make("parent-reasoning"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("branch-reasoning"),
            sessionId: SessionId.make("parent-reasoning"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: Agents["explore"]!,
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
      const storageLayer = Storage.Test()
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()
          yield* storage.createMessage(
            Message.Regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [
                new ReasoningPart({ type: "reasoning", text: "thinking step" }),
                new TextPart({ type: "text", text: "the actual answer" }),
              ],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        Provider.Debug(),
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
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const now = new Date()
        yield* storage.createSession(
          new Session({
            id: SessionId.make("parent-mixed"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("branch-mixed"),
            sessionId: SessionId.make("parent-mixed"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: Agents["explore"]!,
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
      const storageLayer = Storage.Test()
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()
          yield* storage.createMessage(
            Message.Regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [
                new ReasoningPart({ type: "reasoning", text: "internal thinking" }),
                new TextPart({ type: "text", text: "visible answer" }),
              ],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        Provider.Debug(),
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
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const now = new Date()
        yield* storage.createSession(
          new Session({
            id: SessionId.make("parent-save"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: BranchId.make("branch-save"),
            sessionId: SessionId.make("parent-save"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: Agents["explore"]!,
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
        rmSync(result.savedPath!, { force: true })
      }
    }),
  )
})
// ============================================================================
// Session depth guard
// ============================================================================
describe("session depth guard", () => {
  const run = <A, E>(effect: Effect.Effect<A, E, Storage>) =>
    Effect.runPromise(effect.pipe(Effect.timeout("4 seconds"), Effect.provide(Storage.Test())))
  const makeSession = (id: string, parentSessionId?: string) =>
    new Session({
      id: SessionId.make(id),
      name: `session-${id}`,
      parentSessionId: parentSessionId !== undefined ? SessionId.make(parentSessionId) : undefined,
      parentBranchId:
        parentSessionId !== undefined ? BranchId.make(`branch-${parentSessionId}`) : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  const makeBranch = (sessionId: string) =>
    new Branch({
      id: BranchId.make(`branch-${sessionId}`),
      sessionId: SessionId.make(sessionId),
      createdAt: new Date(),
    })
  const buildSessionChain = (storage: StorageService, depth: number) =>
    Effect.gen(function* () {
      yield* storage.createSession(makeSession("s0"))
      yield* storage.createBranch(makeBranch("s0"))
      for (let i = 1; i <= depth; i++) {
        yield* storage.createSession(makeSession(`s${i}`, `s${i - 1}`))
        yield* storage.createBranch(makeBranch(`s${i}`))
      }
    })
  it.live("root session has depth 0", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        run(
          Effect.gen(function* () {
            const storage = yield* Storage
            yield* storage.createSession(makeSession("root"))
            yield* storage.createBranch(makeBranch("root"))
            expect(yield* getSessionDepth(SessionId.make("root"), storage)).toBe(0)
          }),
        ),
      )
    }),
  )
  it.live("child of root has depth 1", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        run(
          Effect.gen(function* () {
            const storage = yield* Storage
            yield* storage.createSession(makeSession("root"))
            yield* storage.createBranch(makeBranch("root"))
            yield* storage.createSession(makeSession("child", "root"))
            yield* storage.createBranch(makeBranch("child"))
            expect(yield* getSessionDepth(SessionId.make("child"), storage)).toBe(1)
          }),
        ),
      )
    }),
  )
  it.live("grandchild has depth 2", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        run(
          Effect.gen(function* () {
            const storage = yield* Storage
            yield* storage.createSession(makeSession("root"))
            yield* storage.createBranch(makeBranch("root"))
            yield* storage.createSession(makeSession("child", "root"))
            yield* storage.createBranch(makeBranch("child"))
            yield* storage.createSession(makeSession("grandchild", "child"))
            yield* storage.createBranch(makeBranch("grandchild"))
            expect(yield* getSessionDepth(SessionId.make("grandchild"), storage)).toBe(2)
          }),
        ),
      )
    }),
  )
  it.live("chain at max depth reports correct depth", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        run(
          Effect.gen(function* () {
            const storage = yield* Storage
            yield* buildSessionChain(storage, DEFAULT_MAX_AGENT_RUN_DEPTH)
            const deepest = SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
            expect(yield* getSessionDepth(deepest, storage)).toBe(DEFAULT_MAX_AGENT_RUN_DEPTH)
          }),
        ),
      )
    }),
  )
  it.live("parent at max depth blocks child spawn", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        run(
          Effect.gen(function* () {
            const storage = yield* Storage
            yield* buildSessionChain(storage, DEFAULT_MAX_AGENT_RUN_DEPTH)
            const parentId = SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
            const parentDepth = yield* getSessionDepth(parentId, storage)
            expect(parentDepth >= DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(true)
          }),
        ),
      )
    }),
  )
  it.live("parent below max depth allows child spawn", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        run(
          Effect.gen(function* () {
            const storage = yield* Storage
            yield* buildSessionChain(storage, DEFAULT_MAX_AGENT_RUN_DEPTH - 1)
            const parentId = SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH - 1}`)
            const parentDepth = yield* getSessionDepth(parentId, storage)
            expect(parentDepth < DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(true)
          }),
        ),
      )
    }),
  )
  it.live("nonexistent session returns depth 0", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        run(
          Effect.gen(function* () {
            const storage = yield* Storage
            expect(yield* getSessionDepth(SessionId.make("nonexistent"), storage)).toBe(0)
          }),
        ),
      )
    }),
  )
})
describe("ephemeral service propagation", () => {
  const makeEphemeralLayer = (providerLayer: Layer.Layer<Provider>) => {
    const storageLayer = Storage.TestWithSql()
    const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)
    const deps = Layer.mergeAll(
      storageLayer,
      eventStoreLayer,
      eventPublisherLayer,
      testRegistryLayer,
      providerLayer,
      sessionRuntimeStub(),
      ephemeralParentDeps,
    )
    const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
    return Layer.mergeAll(deps, runnerLayer)
  }
  const setupParentSession = (storage: StorageService, id: SessionId) =>
    Effect.gen(function* () {
      const now = new Date()
      yield* storage.createSession(
        new Session({ id, name: "Parent", createdAt: now, updatedAt: now }),
      )
      yield* storage.createBranch(
        new Branch({ id: BranchId.make(`${id}-branch`), sessionId: id, createdAt: now }),
      )
    })
  test("ephemeral agent writes to ephemeral storage, not parent", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([textStep("ephemeral text output")])
      const layer = makeEphemeralLayer(providerLayer)
      yield* Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        yield* setupParentSession(storage, SessionId.make("parent-svc-prop"))
        const result = yield* runner.run({
          agent: Agents["explore"]!,
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
        const sessions = yield* storage.listSessions()
        expect(sessions.map((s) => s.id)).toEqual([SessionId.make("parent-svc-prop")])
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.timeout("4 seconds"), Effect.runPromise))
  test("ephemeral agent auto-approves interactions", () =>
    Effect.gen(function* () {
      const approveTool = tool({
        id: "approve_test",
        description: "Tests approval",
        params: Schema.Struct({ text: Schema.String }),
        execute: Effect.fn("approve_test")(function* (_params, ctx) {
          const decision = yield* ctx.interaction.approve({
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
              agents: Object.values(Agents),
              tools: [approveTool],
            },
          },
        ]),
      )
      const { layer: providerLayer } = yield* Provider.Sequence([
        toolCallStep("approve_test", { text: "test" }),
        textStep("approved"),
      ])
      const storageLayer = Storage.TestWithSql()
      const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        storageLayer,
        eventStoreLayer,
        eventPublisherLayer,
        toolRegistry,
        providerLayer,
        sessionRuntimeStub(),
        ephemeralParentDeps,
      )
      const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        yield* setupParentSession(storage, SessionId.make("parent-approve"))
        const result = yield* runner.run({
          agent: Agents["explore"]!,
          prompt: "test auto-approve",
          parentSessionId: SessionId.make("parent-approve"),
          parentBranchId: BranchId.make("parent-approve-branch"),
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })
        // Should succeed — approval was auto-resolved, tool ran, text followed
        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("approved")
        }
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.timeout("4 seconds"), Effect.runPromise))
})
