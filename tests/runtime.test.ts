import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import {
  isRetryable,
  getRetryDelay,
  DEFAULT_RETRY_CONFIG,
  pruneToolOutputs,
  estimateTokens,
  DEFAULT_COMPACTION_CONFIG,
  AgentActor,
  ActorSystemDefault,
  InProcessRunner,
  SubagentRunnerConfig,
  ToolRunner,
} from "@gent/runtime"
import { Provider, ProviderError, ToolCallChunk, FinishChunk } from "@gent/providers"
import {
  Message,
  TextPart,
  ToolResultPart,
  Agents,
  AgentRegistry,
  Session,
  Branch,
  SubagentRunnerService,
  SubagentError,
  defineTool,
  ToolRegistry,
  Permission,
  PermissionHandler,
  EventStore,
} from "@gent/core"
import { Storage } from "@gent/storage"
import { SequenceRecorder, RecordingEventStore, assertSequence } from "@gent/test-utils"

describe("Retry Logic", () => {
  test("isRetryable detects rate limits", () => {
    const rateLimitError = new ProviderError({
      message: "Rate limit exceeded (429)",
      model: "test",
    })
    expect(isRetryable(rateLimitError)).toBe(true)
  })

  test("isRetryable detects overload", () => {
    const overloadError = new ProviderError({
      message: "Service overloaded",
      model: "test",
    })
    expect(isRetryable(overloadError)).toBe(true)
  })

  test("isRetryable detects 500 errors", () => {
    const serverError = new ProviderError({
      message: "Internal server error 500",
      model: "test",
    })
    expect(isRetryable(serverError)).toBe(true)
  })

  test("isRetryable returns false for non-retryable errors", () => {
    const authError = new ProviderError({
      message: "Invalid API key",
      model: "test",
    })
    expect(isRetryable(authError)).toBe(false)
  })

  test("getRetryDelay uses exponential backoff", () => {
    const delay0 = getRetryDelay(0, null)
    const delay1 = getRetryDelay(1, null)
    const delay2 = getRetryDelay(2, null)

    expect(delay0).toBe(DEFAULT_RETRY_CONFIG.initialDelay)
    expect(delay1).toBe(DEFAULT_RETRY_CONFIG.initialDelay * 2)
    expect(delay2).toBe(DEFAULT_RETRY_CONFIG.initialDelay * 4)
  })

  test("getRetryDelay respects maxDelay", () => {
    const delay = getRetryDelay(10, null)
    expect(delay).toBeLessThanOrEqual(DEFAULT_RETRY_CONFIG.maxDelay)
  })
})

describe("Compaction", () => {
  test("estimateTokens calculates token count", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "Hello world" })], // 11 chars
        createdAt: new Date(),
      }),
    ]

    const tokens = estimateTokens(messages)
    expect(tokens).toBe(3) // ceil(11/4) = 3
  })

  test("pruneToolOutputs preserves recent outputs", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "tool",
        parts: [
          new ToolResultPart({
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "test",
            output: { type: "json", value: { data: "x".repeat(1000) } },
          }),
        ],
        createdAt: new Date(),
      }),
    ]

    // With high pruneProtect, nothing should be pruned
    const config = { ...DEFAULT_COMPACTION_CONFIG, pruneProtect: 100000 }
    const result = pruneToolOutputs(messages, config)
    expect(result.length).toBe(1)
    const firstMessage = result[0]
    expect(firstMessage).toBeDefined()
    const firstPart = firstMessage?.parts[0] as ToolResultPart | undefined
    expect(firstPart).toBeDefined()
    expect(firstPart?.output.value).not.toHaveProperty("_pruned")
  })
})

describe("Subagent Runner", () => {
  test("publishes spawn and complete events", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      SubagentRunnerConfig.Live({
        systemPrompt: "",
      }),
      Layer.succeed(AgentActor, {
        run: () => Effect.void,
      }),
      recorderLayer,
      eventStoreLayer,
    )
    const runnerLayer = InProcessRunner.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* SubagentRunnerService
        const recorder = yield* SequenceRecorder

        const now = new Date()
        const session = new Session({
          id: "parent-session",
          name: "Parent",
          bypass: true,
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
        })

        const calls = yield* recorder.getCalls()
        assertSequence(calls, [
          { service: "EventStore", method: "publish", match: { _tag: "SubagentSpawned" } },
          { service: "EventStore", method: "publish", match: { _tag: "SubagentCompleted" } },
        ])
      }).pipe(Effect.provide(layer)),
    )
  })

  test("retries transient failures", async () => {
    let attempts = 0

    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      SubagentRunnerConfig.Live({
        systemPrompt: "",
        maxAttempts: 2,
        retryInitialDelayMs: 1,
        retryMaxDelayMs: 1,
      }),
      Layer.succeed(AgentActor, {
        run: () =>
          Effect.gen(function* () {
            if (attempts++ === 0) {
              return yield* Effect.fail(new SubagentError({ message: "transient" }))
            }
          }),
      }),
      recorderLayer,
      eventStoreLayer,
    )
    const runnerLayer = InProcessRunner.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* SubagentRunnerService

        const now = new Date()
        const session = new Session({
          id: "parent-session-retry",
          name: "Parent",
          bypass: true,
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "parent-branch-retry",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        const result = yield* runner.run({
          agent: Agents.explore,
          prompt: "retry test",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
        })

        expect(result._tag).toBe("success")
      }).pipe(Effect.provide(layer)),
    )

    expect(attempts).toBe(2)
  })

  test("fails with timeout", async () => {
    const deps = Layer.mergeAll(
      Storage.Test(),
      SubagentRunnerConfig.Live({
        systemPrompt: "",
        maxAttempts: 1,
        timeoutMs: 5,
      }),
      Layer.succeed(AgentActor, {
        run: () => Effect.sleep("50 millis"),
      }),
      EventStore.Test(),
    )
    const runnerLayer = InProcessRunner.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const runner = yield* SubagentRunnerService

        const now = new Date()
        const session = new Session({
          id: "parent-session-timeout",
          name: "Parent",
          bypass: true,
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
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("error")
    expect(result.error).toContain("timed out")
  })
})

describe("AgentActor", () => {
  test("publishes machine inspection + task events", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const toolDeps = Layer.mergeAll(
      ToolRegistry.Live([]),
      Permission.Test(),
      PermissionHandler.Test(["allow"]),
    )
    const toolRunnerLayer = ToolRunner.Live.pipe(Layer.provide(toolDeps))
    const deps = Layer.mergeAll(
      Storage.Test(),
      Provider.Test([[new FinishChunk({ finishReason: "stop" })]]),
      AgentRegistry.Live,
      ActorSystemDefault,
      recorderLayer,
      eventStoreLayer,
      toolDeps,
      toolRunnerLayer,
    )
    const actorLayer = AgentActor.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, actorLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const actor = yield* AgentActor
        const recorder = yield* SequenceRecorder

        const now = new Date()
        const session = new Session({
          id: "inspection-session",
          name: "Inspection",
          bypass: true,
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "inspection-branch",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* actor.run({
          sessionId: session.id,
          branchId: branch.id,
          agentName: "cowork",
          prompt: "inspect",
          systemPrompt: "",
          bypass: true,
        })

        yield* Effect.yieldNow()

        const calls = yield* recorder.getCalls()
        const tags = calls
          .filter((call) => call.service === "EventStore" && call.method === "publish")
          .map((call) => (call.args as { _tag: string } | undefined)?._tag)

        expect(tags.includes("MachineInspected")).toBe(true)
        expect(tags.includes("MachineTaskSucceeded")).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("ToolRunner", () => {
  test("returns error result when tool fails", async () => {
    const FailTool = defineTool({
      name: "fail",
      concurrency: "parallel",
      description: "Fails on purpose",
      params: Schema.Struct({}),
      execute: () => Effect.fail(new Error("boom")),
    })

    const deps = Layer.mergeAll(
      ToolRegistry.Live([FailTool]),
      Permission.Test(),
      PermissionHandler.Test(["allow"]),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "fail", input: {} },
          { sessionId: "s", branchId: "b", toolCallId: "tc1", agentName: "cowork" },
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("error-json")
    const error = (result.output.value as { error?: string }).error ?? ""
    expect(error).toContain("Tool failed")
  })
})

describe("Tool concurrency", () => {
  test("serial tool calls do not overlap", async () => {
    const events: string[] = []
    let running = 0
    let maxRunning = 0

    const makeSerialTool = (name: string) =>
      defineTool({
        name,
        concurrency: "serial",
        description: `Serial tool ${name}`,
        params: Schema.Struct({}),
        execute: () =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              running += 1
              maxRunning = Math.max(maxRunning, running)
              events.push(`start:${name}`)
            })

            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  setTimeout(resolve, 20)
                }),
            )

            yield* Effect.sync(() => {
              events.push(`end:${name}`)
              running -= 1
            })

            return { ok: true }
          }),
      })

    const toolA = makeSerialTool("serial-a")
    const toolB = makeSerialTool("serial-b")

    const providerResponses = [
      [
        new ToolCallChunk({ toolCallId: "tc-1", toolName: "serial-a", input: {} }),
        new ToolCallChunk({ toolCallId: "tc-2", toolName: "serial-b", input: {} }),
        new FinishChunk({ finishReason: "tool_calls" }),
      ],
      [new FinishChunk({ finishReason: "stop" })],
    ]

    const deps = Layer.mergeAll(
      Storage.Test(),
      Provider.Test(providerResponses),
      ToolRegistry.Live([toolA, toolB]),
      EventStore.Test(),
      AgentRegistry.Live,
      Permission.Test(),
      PermissionHandler.Test(["allow"]),
      ActorSystemDefault,
    )
    const toolRunnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const actorDeps = Layer.mergeAll(deps, toolRunnerLayer)
    const actorLayer = AgentActor.Live.pipe(Layer.provide(actorDeps))
    const layer = Layer.mergeAll(actorDeps, actorLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const actor = yield* AgentActor

        const now = new Date()
        const session = new Session({
          id: "serial-session",
          name: "Serial Test",
          bypass: true,
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "serial-branch",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* actor.run({
          sessionId: session.id,
          branchId: branch.id,
          agentName: "cowork",
          prompt: "run serial tools",
          systemPrompt: "",
          bypass: true,
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(maxRunning).toBe(1)
    expect(events.length).toBe(4)
    expect(events[0]?.startsWith("start:")).toBe(true)
    expect(events[1]?.startsWith("end:")).toBe(true)
    expect(events[2]?.startsWith("start:")).toBe(true)
    expect(events[3]?.startsWith("end:")).toBe(true)
    expect(events[0]?.slice("start:".length)).toBe(events[1]?.slice("end:".length))
    expect(events[2]?.slice("start:".length)).toBe(events[3]?.slice("end:".length))
  })
})
