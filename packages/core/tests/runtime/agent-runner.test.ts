import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FinishChunk, Provider, TextChunk, ToolCallChunk } from "@gent/core/providers/provider"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { InProcessRunner } from "@gent/core/runtime/agent/agent-runner"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { Session, Branch } from "@gent/core/domain/message"
import {
  Agents,
  resolveAgentModel,
  AgentRunnerService,
  AgentRunError,
  type AgentExecutionOverrides,
} from "@gent/core/domain/agent"
import type { SessionId, BranchId } from "@gent/core/domain/ids"
import type { ModelId } from "@gent/core/domain/model"
import { EventStore } from "@gent/core/domain/event"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { EventStoreLive } from "@gent/core/runtime/event-store-live"
import { SequenceRecorder, RecordingEventStore, assertSequence } from "@gent/core/test-utils"
import {
  ExtensionStateRuntime,
  type ExtensionStateRuntimeService,
} from "@gent/core/runtime/extensions/state-runtime"
import { makeReducingEventStore } from "@gent/core/server/dependencies"

const testRegistryLayer = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: "agents" },
      kind: "builtin",
      sourcePath: "test",
      setup: { agents: Object.values(Agents) },
    },
  ]),
)

describe("AgentExecutionOverrides", () => {
  test("resolveDualModelPair returns cowork/deepwork models from registry", () => {
    const registry = resolveExtensions([
      {
        manifest: { id: "agents" },
        kind: "builtin",
        sourcePath: "test",
        setup: { agents: Object.values(Agents) },
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

  test("overrides thread through AgentRunner to AgentLoop.runOnce", async () => {
    let capturedInput:
      | {
          sessionId: SessionId
          branchId: BranchId
          agentName: string
          prompt: string
          interactive?: boolean
          overrides?: AgentExecutionOverrides
        }
      | undefined
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Test([]),
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
    )
    const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
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
          parentSessionId: "s1" as SessionId,
          parentBranchId: "b1" as BranchId,
          cwd: "/tmp",
          persistence: "durable",
          overrides: {
            modelId: "custom/model" as ModelId,
            allowedActions: ["read", "edit"],
            allowedTools: ["bash", "grep"],
            deniedTools: ["write"],
            reasoningEffort: "high",
            systemPromptAddendum: "Extra instructions",
            tags: ["auto-loop"],
          },
        })

        expect(capturedInput).toBeDefined()
        expect(capturedInput!.overrides?.modelId).toBe("custom/model")
        expect(capturedInput!.overrides?.allowedActions).toEqual(["read", "edit"])
        expect(capturedInput!.overrides?.allowedTools).toEqual(["bash", "grep"])
        expect(capturedInput!.overrides?.deniedTools).toEqual(["write"])
        expect(capturedInput!.overrides?.reasoningEffort).toBe("high")
        expect(capturedInput!.overrides?.systemPromptAddendum).toBe("Extra instructions")
        expect(capturedInput!.overrides?.tags).toEqual(["auto-loop"])
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("AgentRunner", () => {
  test("publishes spawn and complete events", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Test([]),
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
    )
    const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
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
          persistence: "durable",
        })

        const calls = yield* recorder.getCalls()
        assertSequence(calls, [
          { service: "EventStore", method: "publish", match: { _tag: "AgentRunSpawned" } },
          { service: "EventStore", method: "publish", match: { _tag: "AgentRunSucceeded" } },
        ])
      }).pipe(Effect.provide(layer)),
    )
  })

  test("propagates failures without retry (no maxAttempts)", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Test([]),
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
    )
    const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
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
          persistence: "durable",
        })

        // Without retry, failure propagates as error result
        expect(result._tag).toBe("error")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("fails with timeout", async () => {
    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Test([]),
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
      EventStore.Test(),
    )
    const runnerLayer = InProcessRunner({ timeoutMs: 5 }).pipe(Layer.provide(deps))
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
          persistence: "durable",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("error")
    expect(result.error).toContain("timed out")
  })

  test("ephemeral helper runs do not persist child sessions", async () => {
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      EventStore.Test(),
      testRegistryLayer,
      Provider.Test([
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
    const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
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
    const deps = Layer.mergeAll(
      storageLayer,
      EventStoreLive.pipe(Layer.provide(storageLayer)),
      testRegistryLayer,
      Provider.Test([
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
    const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
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
    const stateRuntime: ExtensionStateRuntimeService = {
      publish: (_event, ctx) =>
        Effect.sync(() => {
          publishedSessionIds.push(ctx.sessionId)
          return false
        }),
      deriveAll: () => Effect.succeed([]),
      send: () => Effect.void,
      ask: () => Effect.die("not used"),
      getUiSnapshots: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
      notifyObservers: () => Effect.void,
    }
    const reducingEventStoreLayer = Layer.provide(
      makeReducingEventStore,
      Layer.merge(baseEventStoreLayer, Layer.succeed(ExtensionStateRuntime, stateRuntime)),
    )
    const deps = Layer.mergeAll(
      storageLayer,
      baseEventStoreLayer,
      reducingEventStoreLayer,
      testRegistryLayer,
      Provider.Test([
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
    const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
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
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(publishedSessionIds.length).toBeGreaterThan(0)
    expect(new Set(publishedSessionIds)).toEqual(new Set(["parent-session-reduce"]))
  })

  test("durable override persists child sessions for helper agents", async () => {
    const deps = Layer.mergeAll(
      Storage.Test(),
      ExtensionRegistry.Test(),
      Provider.Test([]),
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
      EventStore.Test(),
    )
    const runnerLayer = InProcessRunner({}).pipe(Layer.provide(deps))
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
          persistence: "durable",
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
})
