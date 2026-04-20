import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema, Stream } from "effect"
import {
  Provider,
  FinishChunk,
  TextChunk,
  ToolCallChunk,
  type StreamChunk,
} from "@gent/core/providers/provider"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { InProcessRunner, getSessionDepth } from "@gent/core/runtime/agent/agent-runner"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { Session, Branch, Message, ReasoningPart, TextPart } from "@gent/core/domain/message"
import {
  resolveAgentModel,
  AgentRunnerService,
  AgentRunError,
  DEFAULT_MAX_AGENT_RUN_DEPTH,
  type RunSpec,
} from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { SessionId, BranchId, MessageId } from "@gent/core/domain/ids"
import { ModelId } from "@gent/core/domain/model"
import { EventStore } from "@gent/core/domain/event"
import { Storage, type StorageService } from "@gent/core/storage/sqlite-storage"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { tool } from "@gent/core/extensions/api"
import { EventStoreLive } from "@gent/core/runtime/event-store-live"
import { SequenceRecorder, RecordingEventStore, assertSequence } from "@gent/core/test-utils"
import { textStep, toolCallStep } from "@gent/core/debug/provider"
import {
  MachineEngine,
  type MachineEngineService,
} from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { Permission } from "@gent/core/domain/permission"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ServerProfileService } from "@gent/core/runtime/scope-brands"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { rmSync } from "node:fs"

/** Scripted provider: returns chunks from an array, one response per stream() call. */
const scriptedProvider = (
  responses: ReadonlyArray<ReadonlyArray<StreamChunk>>,
): Layer.Layer<Provider> => {
  let index = 0
  return Layer.succeed(Provider, {
    stream: () =>
      Effect.succeed(
        Stream.fromIterable(responses[index++] ?? [new FinishChunk({ finishReason: "stop" })]),
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

const testRegistryLayer = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: "agents" },
      kind: "builtin",
      sourcePath: "test",
      contributions: {
        agents: Object.values(Agents),
        capabilities: [bashStubTool],
      },
    },
  ]),
)

const withEventPublisher = (
  baseEventStoreLayer: Layer.Layer<EventStore>,
  stateRuntimeLayer: Layer.Layer<MachineEngine> = MachineEngine.Test(),
) =>
  Layer.provide(
    EventPublisherLive,
    Layer.mergeAll(
      baseEventStoreLayer,
      stateRuntimeLayer,
      testRegistryLayer,
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ),
  )

// Extra services the parent context needs for ephemeral child runtime
const ephemeralParentDeps = Layer.mergeAll(
  BunServices.layer,
  Permission.Live([], "allow"),
  RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  ServerProfileService.Test(),
)

describe("RunSpec", () => {
  test("dual model pair resolves to cowork and deepwork models", () => {
    const registry = resolveExtensions([
      {
        manifest: { id: "agents" },
        kind: "builtin",
        sourcePath: "test",
        contributions: { agents: Object.values(Agents) },
      },
    ])
    const impl = ExtensionRegistry.fromResolved(registry)
    return Effect.gen(function* () {
      const reg = yield* ExtensionRegistry
      const [a, b] = yield* reg.resolveDualModelPair()
      expect(a).toBe(resolveAgentModel(Agents.cowork))
      expect(b).toBe(resolveAgentModel(Agents.deepwork))
      expect(a).not.toBe(b)
    }).pipe(Effect.provide(impl), Effect.runPromise)
  })

  test("runSpec reaches the agent loop", async () => {
    let capturedInput:
      | {
          sessionId: SessionId
          branchId: BranchId
          agentName: string
          prompt: string
          interactive?: boolean
          runSpec?: RunSpec
        }
      | undefined
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)
    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Debug(),
      ToolRunner.Test(),
      Layer.succeed(AgentLoop, {
        runOnce: (input) => {
          capturedInput = input
          return Effect.void
        },
        submit: () => Effect.void,
        run: () => Effect.void,
        steer: () => Effect.void,
        followUp: () => Effect.void,
        drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        isRunning: () => Effect.succeed(false),
      }),
      recorderLayer,
      eventStoreLayer,
      eventPublisherLayer,
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        const now = new Date()
        yield* storage.createSession(
          new Session({ id: "s1", name: "S", createdAt: now, updatedAt: now }),
        )
        yield* storage.createBranch(new Branch({ id: "b1", sessionId: "s1", createdAt: now }))

        yield* runner.run({
          agent: Agents.explore,
          prompt: "test",
          parentSessionId: SessionId.of("s1"),
          parentBranchId: BranchId.of("b1"),
          cwd: "/tmp",
          runSpec: {
            persistence: "durable",
            tags: ["auto-loop"],
            overrides: {
              modelId: ModelId.of("custom/model"),
              allowedTools: ["bash", "grep"],
              deniedTools: ["write"],
              reasoningEffort: "high",
              systemPromptAddendum: "Extra instructions",
            },
          },
        })

        expect(capturedInput).toBeDefined()
        expect(capturedInput!.runSpec?.overrides?.modelId).toBe("custom/model")
        expect(capturedInput!.runSpec?.overrides?.allowedTools).toEqual(["bash", "grep"])
        expect(capturedInput!.runSpec?.overrides?.deniedTools).toEqual(["write"])
        expect(capturedInput!.runSpec?.overrides?.reasoningEffort).toBe("high")
        expect(capturedInput!.runSpec?.overrides?.systemPromptAddendum).toBe("Extra instructions")
        expect(capturedInput!.runSpec?.tags).toEqual(["auto-loop"])
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("AgentRunner", () => {
  test("publishes spawn and complete events", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)
    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Debug(),
      ToolRunner.Test(),
      Layer.succeed(AgentLoop, {
        runOnce: () => Effect.void,
        submit: () => Effect.void,
        run: () => Effect.void,
        steer: () => Effect.void,
        followUp: () => Effect.void,
        drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        isRunning: () => Effect.succeed(false),
      }),
      recorderLayer,
      eventStoreLayer,
      eventPublisherLayer,
      BunFileSystem.layer,
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService
        const recorder = yield* SequenceRecorder

        const now = new Date()
        const session = new Session({
          id: "parent-session",
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* runner.run({
          agent: Agents.explore,
          prompt: "scan repo",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })

        const calls = yield* recorder.getCalls()
        assertSequence(calls, [
          { service: "EventStore", method: "publish", match: { _tag: "AgentRunSpawned" } },
          { service: "EventStore", method: "publish", match: { _tag: "AgentRunSucceeded" } },
        ])

        // Verify enriched AgentRunSucceeded payload fields (args is the event object directly)
        const successEvent = calls.find((c) => {
          const args = c.args as Record<string, unknown> | undefined
          return (
            c.service === "EventStore" &&
            c.method === "publish" &&
            args?._tag === "AgentRunSucceeded"
          )
        })
        expect(successEvent).toBeDefined()
        const event = successEvent!.args as Record<string, unknown>
        expect(event.preview).toBeDefined()
        expect(typeof event.preview).toBe("string")
        expect(event.savedPath).toBeDefined()
        expect(typeof event.savedPath).toBe("string")
        expect(event.savedPath).toContain("/tmp/gent/outputs/")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("propagates failures without retry (no maxAttempts)", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)
    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Debug(),
      ToolRunner.Test(),
      Layer.succeed(AgentLoop, {
        runOnce: () => Effect.fail(new AgentRunError({ message: "permanent failure" })),
        submit: () => Effect.void,
        run: () => Effect.void,
        steer: () => Effect.void,
        followUp: () => Effect.void,
        drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        isRunning: () => Effect.succeed(false),
      }),
      recorderLayer,
      eventStoreLayer,
      eventPublisherLayer,
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        const now = new Date()
        const session = new Session({
          id: "parent-session-noretr",
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch-noretr",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        const result = yield* runner.run({
          agent: Agents.explore,
          prompt: "fail test",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })

        // Without retry, failure propagates as error result
        expect(result._tag).toBe("error")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("fails with timeout", async () => {
    const eventStoreLayer = EventStore.Memory
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)
    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Debug(),
      ToolRunner.Test(),
      Layer.succeed(AgentLoop, {
        runOnce: () => Effect.sleep("50 millis"),
        submit: () => Effect.void,
        run: () => Effect.void,
        steer: () => Effect.void,
        followUp: () => Effect.void,
        drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        isRunning: () => Effect.succeed(false),
      }),
      eventStoreLayer,
      eventPublisherLayer,
    )
    const runnerLayer = InProcessRunner({ timeoutMs: 5 }).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        const now = new Date()
        const session = new Session({
          id: "parent-session-timeout",
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch-timeout",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        return yield* runner.run({
          agent: Agents.explore,
          prompt: "timeout test",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("error")
    expect(result.error).toContain("timed out")
  })

  test("ephemeral helper runs do not persist child sessions", async () => {
    const eventStoreLayer = EventStore.Memory
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      eventStoreLayer,
      eventPublisherLayer,
      testRegistryLayer,
      scriptedProvider([
        [new TextChunk({ text: "ephemeral response" }), new FinishChunk({ finishReason: "stop" })],
      ]),
      ToolRunner.Test(),
      Layer.succeed(AgentLoop, {
        runOnce: () => Effect.void,
        submit: () => Effect.void,
        run: () => Effect.void,
        steer: () => Effect.void,
        followUp: () => Effect.void,
        drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        isRunning: () => Effect.succeed(false),
      }),
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        const now = new Date()
        const session = new Session({
          id: "parent-session-ephemeral",
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch-ephemeral",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        const runResult = yield* runner.run({
          agent: Agents.explore,
          prompt: "scan repo",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })

        const sessions = yield* storage.listSessions()
        return { runResult, sessions }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.runResult._tag).toBe("success")
    if (result.runResult._tag === "success") {
      expect(result.runResult.persistence).toBe("ephemeral")
      expect(result.runResult.text).toContain("ephemeral response")
    }
    expect(result.sessions.map((session) => session.id)).toEqual(["parent-session-ephemeral"])
  })

  test("ephemeral helper runs mirror child tool events into the parent store", async () => {
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
          new ToolCallChunk({
            toolCallId: "tc-ephemeral",
            toolName: "bash",
            input: { command: "pwd" },
          }),
          new FinishChunk({ finishReason: "tool_calls" }),
        ],
        [new TextChunk({ text: "tool finished" }), new FinishChunk({ finishReason: "stop" })],
      ]),
      ToolRunner.Test(),
      Layer.succeed(AgentLoop, {
        runOnce: () => Effect.void,
        submit: () => Effect.void,
        run: () => Effect.void,
        steer: () => Effect.void,
        followUp: () => Effect.void,
        drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        isRunning: () => Effect.succeed(false),
      }),
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        const now = new Date()
        const session = new Session({
          id: "parent-session-mirror",
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch-mirror",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        const runResult = yield* runner.run({
          agent: Agents.explore,
          prompt: "run helper with one tool",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })

        if (runResult._tag !== "success") {
          return { runResult, childTags: [] as string[] }
        }

        const childEvents = yield* storage.listEvents({ sessionId: runResult.sessionId })
        return {
          runResult,
          childTags: childEvents.map((event) => event.event._tag),
        }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.runResult._tag).toBe("success")
    expect(result.childTags).toContain("ToolCallStarted")
    expect(result.childTags).toContain("ToolCallSucceeded")
  })

  test("ephemeral mirrored child events bypass extension reduction for synthetic child sessions", async () => {
    const storageLayer = Storage.TestWithSql()
    const baseEventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
    const publishedSessionIds: string[] = []
    const stateRuntime: MachineEngineService = {
      publish: (_event, ctx) =>
        Effect.sync(() => {
          publishedSessionIds.push(ctx.sessionId)
          return [] as ReadonlyArray<string>
        }),
      send: () => Effect.void,
      execute: () => Effect.die("not used"),
      getActorStatuses: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    }
    const eventPublisherLayer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(
        baseEventStoreLayer,
        Layer.succeed(MachineEngine, stateRuntime),
        testRegistryLayer,
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ),
    )
    const deps = Layer.mergeAll(
      storageLayer,
      baseEventStoreLayer,
      eventPublisherLayer,
      testRegistryLayer,
      scriptedProvider([
        [
          new ToolCallChunk({
            toolCallId: "tc-ephemeral-reduce",
            toolName: "bash",
            input: { command: "pwd" },
          }),
          new FinishChunk({ finishReason: "tool_calls" }),
        ],
        [new TextChunk({ text: "tool finished" }), new FinishChunk({ finishReason: "stop" })],
      ]),
      ToolRunner.Test(),
      Layer.succeed(AgentLoop, {
        runOnce: () => Effect.void,
        submit: () => Effect.void,
        run: () => Effect.void,
        steer: () => Effect.void,
        followUp: () => Effect.void,
        drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        isRunning: () => Effect.succeed(false),
      }),
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        const now = new Date()
        const session = new Session({
          id: "parent-session-reduce",
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch-reduce",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* runner.run({
          agent: Agents.explore,
          prompt: "run helper with mirrored child events",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(publishedSessionIds.length).toBeGreaterThan(0)
    expect(new Set(publishedSessionIds)).toEqual(new Set(["parent-session-reduce"]))
  })

  test("durable override persists child sessions for helper agents", async () => {
    const eventStoreLayer = EventStore.Memory
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)
    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Debug(),
      ToolRunner.Test(),
      Layer.succeed(AgentLoop, {
        runOnce: () => Effect.void,
        submit: () => Effect.void,
        run: () => Effect.void,
        steer: () => Effect.void,
        followUp: () => Effect.void,
        drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        isRunning: () => Effect.succeed(false),
      }),
      eventStoreLayer,
      eventPublisherLayer,
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        const now = new Date()
        const session = new Session({
          id: "parent-session-durable",
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch-durable",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        const runResult = yield* runner.run({
          agent: Agents.explore,
          prompt: "persist this child",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
          runSpec: { persistence: "durable" },
        })

        const sessions = yield* storage.listSessions()
        return { runResult, sessions }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.runResult._tag).toBe("success")
    if (result.runResult._tag === "success") {
      expect(result.runResult.persistence).toBe("durable")
    }
    expect(result.sessions).toHaveLength(2)
  })

  test("reasoning-only assistant response surfaces reasoning as text", async () => {
    const eventStoreLayer = EventStore.Memory
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)

    // Mock AgentLoop that writes a reasoning-only assistant message
    const mockLoop = Layer.succeed(AgentLoop, {
      runOnce: (input) =>
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()
          yield* storage.createMessage(
            new Message({
              id: MessageId.of(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [new ReasoningPart({ type: "reasoning", text: "I analyzed the repository" })],
              createdAt: now,
            }),
          )
        }),
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      isRunning: () => Effect.succeed(false),
    })

    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Debug(),
      ToolRunner.Test(),
      mockLoop,
      eventStoreLayer,
      eventPublisherLayer,
      BunFileSystem.layer,
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        const now = new Date()
        yield* storage.createSession(
          new Session({
            id: "parent-reasoning",
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({ id: "branch-reasoning", sessionId: "parent-reasoning", createdAt: now }),
        )

        return yield* runner.run({
          agent: Agents.explore,
          prompt: "analyze",
          parentSessionId: SessionId.of("parent-reasoning"),
          parentBranchId: BranchId.of("branch-reasoning"),
          cwd: "/tmp",
          persistence: "durable",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("success")
    if (result._tag === "success") {
      expect(result.text).toBe("I analyzed the repository")
    }
  })

  test("mixed text+reasoning returns text, not reasoning", async () => {
    const eventStoreLayer = EventStore.Memory
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)

    const mockLoop = Layer.succeed(AgentLoop, {
      runOnce: (input) =>
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()
          yield* storage.createMessage(
            new Message({
              id: MessageId.of(`${input.sessionId}:assistant:1`),
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
        }),
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      isRunning: () => Effect.succeed(false),
    })

    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Debug(),
      ToolRunner.Test(),
      mockLoop,
      eventStoreLayer,
      eventPublisherLayer,
      BunFileSystem.layer,
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        const now = new Date()
        yield* storage.createSession(
          new Session({ id: "parent-mixed", name: "P", createdAt: now, updatedAt: now }),
        )
        yield* storage.createBranch(
          new Branch({ id: "branch-mixed", sessionId: "parent-mixed", createdAt: now }),
        )

        return yield* runner.run({
          agent: Agents.explore,
          prompt: "analyze",
          parentSessionId: SessionId.of("parent-mixed"),
          parentBranchId: BranchId.of("branch-mixed"),
          cwd: "/tmp",
          persistence: "durable",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("success")
    if (result._tag === "success") {
      expect(result.text).toBe("the actual answer")
    }
  })

  test("agent run output is saved to /tmp/gent/outputs/", async () => {
    const eventStoreLayer = EventStore.Memory
    const eventPublisherLayer = withEventPublisher(eventStoreLayer)

    const mockLoop = Layer.succeed(AgentLoop, {
      runOnce: (input) =>
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()
          yield* storage.createMessage(
            new Message({
              id: MessageId.of(`${input.sessionId}:assistant:1`),
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
        }),
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      isRunning: () => Effect.succeed(false),
    })

    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Debug(),
      ToolRunner.Test(),
      mockLoop,
      eventStoreLayer,
      eventPublisherLayer,
      BunFileSystem.layer,
    )
    const runnerLayer = InProcessRunner({}).pipe(
      Layer.provide(Layer.merge(deps, ephemeralParentDeps)),
    )
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        const now = new Date()
        yield* storage.createSession(
          new Session({ id: "parent-save", name: "P", createdAt: now, updatedAt: now }),
        )
        yield* storage.createBranch(
          new Branch({ id: "branch-save", sessionId: "parent-save", createdAt: now }),
        )

        return yield* runner.run({
          agent: Agents.explore,
          prompt: "save test",
          parentSessionId: SessionId.of("parent-save"),
          parentBranchId: BranchId.of("branch-save"),
          cwd: "/tmp",
          persistence: "durable",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("success")
    if (result._tag === "success") {
      expect(result.savedPath).toBeDefined()
      expect(result.savedPath).toContain("/tmp/gent/outputs/")
      expect(result.savedPath).toContain("explore_")
      expect(result.savedPath).toEndWith(".md")

      // Verify file contents
      const content = await Bun.file(result.savedPath!).text()
      expect(content).toContain("## Reasoning")
      expect(content).toContain("internal thinking")
      expect(content).toContain("## Response")
      expect(content).toContain("visible answer")

      // Cleanup
      rmSync(result.savedPath!, { force: true })
    }
  })
})

// ============================================================================
// Session depth guard
// ============================================================================

describe("session depth guard", () => {
  const run = <A, E>(effect: Effect.Effect<A, E, Storage>) =>
    Effect.runPromise(Effect.provide(effect, Storage.Test()))

  const makeSession = (id: string, parentSessionId?: string) =>
    new Session({
      id: SessionId.of(id),
      name: `session-${id}`,
      parentSessionId: parentSessionId !== undefined ? SessionId.of(parentSessionId) : undefined,
      parentBranchId:
        parentSessionId !== undefined ? BranchId.of(`branch-${parentSessionId}`) : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

  const makeBranch = (sessionId: string) =>
    new Branch({
      id: BranchId.of(`branch-${sessionId}`),
      sessionId: SessionId.of(sessionId),
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

  test("root session has depth 0", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(makeSession("root"))
        yield* storage.createBranch(makeBranch("root"))
        expect(yield* getSessionDepth(SessionId.of("root"), storage)).toBe(0)
      }),
    )
  })

  test("child of root has depth 1", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(makeSession("root"))
        yield* storage.createBranch(makeBranch("root"))
        yield* storage.createSession(makeSession("child", "root"))
        yield* storage.createBranch(makeBranch("child"))
        expect(yield* getSessionDepth(SessionId.of("child"), storage)).toBe(1)
      }),
    )
  })

  test("grandchild has depth 2", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.createSession(makeSession("root"))
        yield* storage.createBranch(makeBranch("root"))
        yield* storage.createSession(makeSession("child", "root"))
        yield* storage.createBranch(makeBranch("child"))
        yield* storage.createSession(makeSession("grandchild", "child"))
        yield* storage.createBranch(makeBranch("grandchild"))
        expect(yield* getSessionDepth(SessionId.of("grandchild"), storage)).toBe(2)
      }),
    )
  })

  test("chain at max depth reports correct depth", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* buildSessionChain(storage, DEFAULT_MAX_AGENT_RUN_DEPTH)
        const deepest = SessionId.of(`s${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
        expect(yield* getSessionDepth(deepest, storage)).toBe(DEFAULT_MAX_AGENT_RUN_DEPTH)
      }),
    )
  })

  test("parent at max depth blocks child spawn", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* buildSessionChain(storage, DEFAULT_MAX_AGENT_RUN_DEPTH)
        const parentId = SessionId.of(`s${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
        const parentDepth = yield* getSessionDepth(parentId, storage)
        expect(parentDepth >= DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(true)
      }),
    )
  })

  test("parent below max depth allows child spawn", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* buildSessionChain(storage, DEFAULT_MAX_AGENT_RUN_DEPTH - 1)
        const parentId = SessionId.of(`s${DEFAULT_MAX_AGENT_RUN_DEPTH - 1}`)
        const parentDepth = yield* getSessionDepth(parentId, storage)
        expect(parentDepth < DEFAULT_MAX_AGENT_RUN_DEPTH).toBe(true)
      }),
    )
  })

  test("nonexistent session returns depth 0", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        expect(yield* getSessionDepth(SessionId.of("nonexistent"), storage)).toBe(0)
      }),
    )
  })
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
      Layer.succeed(AgentLoop, {
        runOnce: () => Effect.void,
        submit: () => Effect.void,
        run: () => Effect.void,
        steer: () => Effect.void,
        followUp: () => Effect.void,
        drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
        isRunning: () => Effect.succeed(false),
      }),
      ephemeralParentDeps,
    )
    const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
    return Layer.mergeAll(deps, runnerLayer)
  }

  const setupParentSession = (storage: StorageService, id: string) =>
    Effect.gen(function* () {
      const now = new Date()
      yield* storage.createSession(
        new Session({ id, name: "Parent", createdAt: now, updatedAt: now }),
      )
      yield* storage.createBranch(new Branch({ id: `${id}-branch`, sessionId: id, createdAt: now }))
    })

  test("ephemeral agent writes to ephemeral storage, not parent", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([textStep("ephemeral text output")])
      const layer = makeEphemeralLayer(providerLayer)

      yield* Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        yield* setupParentSession(storage, "parent-svc-prop")

        const result = yield* runner.run({
          agent: Agents.explore,
          prompt: "test service propagation",
          parentSessionId: SessionId.of("parent-svc-prop"),
          parentBranchId: BranchId.of("parent-svc-prop-branch"),
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })

        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("ephemeral text output")
        }

        // Parent storage should only have the parent session
        const sessions = yield* storage.listSessions()
        expect(sessions.map((s) => s.id)).toEqual(["parent-svc-prop"])
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.runPromise))

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
            manifest: { id: "agents" },
            kind: "builtin" as const,
            sourcePath: "test",
            contributions: {
              agents: Object.values(Agents),
              capabilities: [approveTool],
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
        Layer.succeed(AgentLoop, {
          runOnce: () => Effect.void,
          submit: () => Effect.void,
          run: () => Effect.void,
          steer: () => Effect.void,
          followUp: () => Effect.void,
          drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
          getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
          isRunning: () => Effect.succeed(false),
        }),
        ephemeralParentDeps,
      )
      const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)

      yield* Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* AgentRunnerService

        yield* setupParentSession(storage, "parent-approve")

        const result = yield* runner.run({
          agent: Agents.explore,
          prompt: "test auto-approve",
          parentSessionId: SessionId.of("parent-approve"),
          parentBranchId: BranchId.of("parent-approve-branch"),
          cwd: process.cwd(),
          runSpec: { persistence: "ephemeral" },
        })

        // Should succeed — approval was auto-resolved, tool ran, text followed
        expect(result._tag).toBe("success")
        if (result._tag === "success") {
          expect(result.text).toContain("approved")
        }
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.runPromise))
})
