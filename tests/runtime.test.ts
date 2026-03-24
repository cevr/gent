import { describe, test, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import {
  isRetryable,
  getRetryDelay,
  DEFAULT_RETRY_CONFIG,
  withRetry,
} from "@gent/core/runtime/retry"
import { estimateTokens } from "@gent/core/runtime/context-estimation"
import { AgentLoop, AgentActor } from "@gent/core/runtime/agent/agent-loop"
import {
  filterToolsForAgent,
  ExtensionRegistry,
  resolveExtensions,
} from "@gent/core/runtime/extensions/registry"
import { InProcessRunner, SubagentRunnerConfig } from "@gent/core/runtime/agent/subagent-runner"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { LocalActorProcessLive, ActorProcess } from "@gent/core/runtime/actor-process"
import {
  Provider,
  ProviderError,
  ToolCallChunk,
  FinishChunk,
  convertTools,
} from "@gent/core/providers/provider"
import { Message, TextPart, Session, Branch } from "@gent/core/domain/message"
import {
  Agents,
  AgentDefinition,
  getAdversarialModels,
  resolveAgentModel,
  SubagentRunnerService,
  SubagentError,
} from "@gent/core/domain/agent"
import { defineTool, type AnyToolDefinition } from "@gent/core/domain/tool"
import type { SessionId, BranchId } from "@gent/core/domain/ids"
import type { ModelId } from "@gent/core/domain/model"
import { Permission } from "@gent/core/domain/permission"
import { PermissionHandler, HandoffHandler } from "@gent/core/domain/interaction-handlers"
import { EventStore } from "@gent/core/domain/event"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SequenceRecorder, RecordingEventStore, assertSequence } from "@gent/core/test-utils"
import { BunServices } from "@effect/platform-bun"

const makeTestExtRegistry = (tools: AnyToolDefinition[] = []) =>
  ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "agents" },
        kind: "builtin" as const,
        sourcePath: "test",
        setup: { agents: Object.values(Agents) },
      },
      ...(tools.length > 0
        ? [
            {
              manifest: { id: "tools" },
              kind: "builtin" as const,
              sourcePath: "test",
              setup: { tools },
            },
          ]
        : []),
    ]),
  )

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

  test("withRetry reports retry progress", async () => {
    const attempts: Array<{
      attempt: number
      maxAttempts: number
      delayMs: number
      error: string
    }> = []
    let callCount = 0

    const result = await Effect.runPromise(
      withRetry(
        Effect.gen(function* () {
          callCount += 1
          if (callCount < 3) {
            return yield* new ProviderError({
              message: "Rate limit exceeded (429)",
              model: "test",
            })
          }
          return "ok"
        }),
        { ...DEFAULT_RETRY_CONFIG, initialDelay: 1, maxDelay: 1, maxAttempts: 3 },
        {
          onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
            Effect.sync(() => {
              attempts.push({ attempt, maxAttempts, delayMs, error: error.message })
            }),
        },
      ),
    )

    expect(result).toBe("ok")
    expect(attempts).toEqual([
      {
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1,
        error: "Rate limit exceeded (429)",
      },
      {
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1,
        error: "Rate limit exceeded (429)",
      },
    ])
  })
})

describe("Token Estimation", () => {
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
})

describe("filterToolsForAgent", () => {
  const makeTool = (
    name: string,
    action: "read" | "edit" | "exec" | "delegate" | "interact" | "network" | "state",
  ) =>
    defineTool({
      name,
      action,
      concurrency: "parallel",
      description: name,
      params: Schema.Struct({}),
      execute: () => Effect.succeed(null),
    })

  const allTools = [
    makeTool("read", "read"),
    makeTool("grep", "read"),
    makeTool("glob", "read"),
    makeTool("write", "edit"),
    makeTool("edit", "edit"),
    makeTool("bash", "exec"),
    makeTool("delegate", "delegate"),
    makeTool("ask_user", "interact"),
    makeTool("webfetch", "network"),
    makeTool("websearch", "network"),
    makeTool("todo_read", "state"),
  ]

  const names = (tools: ReturnType<typeof filterToolsForAgent>) => tools.map((t) => t.name).sort()

  test("no allow-list → all tools", () => {
    const agent = new AgentDefinition({ name: "cowork", kind: "primary" })
    expect(names(filterToolsForAgent(allTools, agent))).toEqual(names(allTools))
  })

  test("allowedActions filters by action", () => {
    const agent = new AgentDefinition({ name: "cowork", kind: "primary", allowedActions: ["read"] })
    expect(names(filterToolsForAgent(allTools, agent))).toEqual(["glob", "grep", "read"])
  })

  test("allowedActions + allowedTools unions", () => {
    const agent = new AgentDefinition({
      name: "cowork",
      kind: "primary",
      allowedActions: ["read"],
      allowedTools: ["bash"],
    })
    expect(names(filterToolsForAgent(allTools, agent))).toEqual(["bash", "glob", "grep", "read"])
  })

  test("allowedTools: [] means no tools", () => {
    const agent = new AgentDefinition({ name: "cowork", kind: "primary", allowedTools: [] })
    expect(filterToolsForAgent(allTools, agent)).toEqual([])
  })

  test("deniedTools removes from result", () => {
    const agent = new AgentDefinition({
      name: "cowork",
      kind: "primary",
      allowedActions: ["read"],
      deniedTools: ["grep"],
    })
    expect(names(filterToolsForAgent(allTools, agent))).toEqual(["glob", "read"])
  })

  test("multiple actions", () => {
    const agent = new AgentDefinition({
      name: "cowork",
      kind: "primary",
      allowedActions: ["read", "network"],
    })
    expect(names(filterToolsForAgent(allTools, agent))).toEqual([
      "glob",
      "grep",
      "read",
      "webfetch",
      "websearch",
    ])
  })
})

describe("AgentExecutionOverrides", () => {
  test("getAdversarialModels returns cowork and deepwork models", () => {
    const [a, b] = getAdversarialModels()
    expect(a).toBe(resolveAgentModel(Agents.cowork))
    expect(b).toBe(resolveAgentModel(Agents.deepwork))
    expect(a).not.toBe(b)
  })

  test("auditor agent exists and is a subagent", () => {
    expect(Agents.auditor).toBeDefined()
    expect(Agents.auditor.kind).toBe("subagent")
    expect(Agents.auditor.name).toBe("auditor")
  })

  test("primary agents can delegate to auditor", () => {
    expect(Agents.cowork.canDelegateToAgents).toContain("auditor")
    expect(Agents.deepwork.canDelegateToAgents).toContain("auditor")
  })

  test("auditor has read + bash tools", () => {
    expect(Agents.auditor.allowedActions).toEqual(["read"])
    expect(Agents.auditor.allowedTools).toEqual(["bash"])
  })

  test("auditor agent has model set", () => {
    expect(Agents.auditor.model).toBeDefined()
    expect(resolveAgentModel(Agents.auditor)).toBeDefined()
  })

  test("overrides thread through SubagentRunner to AgentActor", async () => {
    let capturedInput: Record<string, unknown> | undefined
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      SubagentRunnerConfig.Live({ systemPrompt: "test" }),
      Layer.succeed(AgentActor, {
        run: (input) => {
          capturedInput = input as unknown as Record<string, unknown>
          return Effect.void
        },
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
        yield* storage.createSession(
          new Session({ id: "s1", name: "S", bypass: true, createdAt: now, updatedAt: now }),
        )
        yield* storage.createBranch(new Branch({ id: "b1", sessionId: "s1", createdAt: now }))

        yield* runner.run({
          agent: Agents.explore,
          prompt: "test",
          parentSessionId: "s1" as SessionId,
          parentBranchId: "b1" as BranchId,
          cwd: "/tmp",
          overrides: {
            modelId: "custom/model" as ModelId,
            allowedActions: ["read", "edit"],
            allowedTools: ["bash", "grep"],
            reasoningEffort: "high",
            systemPromptAddendum: "Extra instructions",
          },
        })

        expect(capturedInput).toBeDefined()
        expect(capturedInput!.modelId).toBe("custom/model")
        expect(capturedInput!.overrideAllowedActions).toEqual(["read", "edit"])
        expect(capturedInput!.overrideAllowedTools).toEqual(["bash", "grep"])
        expect(capturedInput!.overrideReasoningEffort).toBe("high")
        expect(capturedInput!.overrideSystemPromptAddendum).toBe("Extra instructions")
      }).pipe(Effect.provide(layer)),
    )
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
          { service: "EventStore", method: "publish", match: { _tag: "SubagentSucceeded" } },
        ])
      }).pipe(Effect.provide(layer)),
    )
  })

  test("propagates failures without retry (no maxAttempts)", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      SubagentRunnerConfig.Live({
        systemPrompt: "",
      }),
      Layer.succeed(AgentActor, {
        run: () => Effect.fail(new SubagentError({ message: "permanent failure" })),
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
          id: "parent-session-noretr",
          name: "Parent",
          bypass: true,
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
        })

        // Without retry, failure propagates as error result
        expect(result._tag).toBe("error")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("fails with timeout", async () => {
    const deps = Layer.mergeAll(
      Storage.Test(),
      SubagentRunnerConfig.Live({
        systemPrompt: "",
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

describe("AgentLoop actor model", () => {
  const makeMessage = (sessionId: string, branchId: string, text: string) =>
    new Message({
      id: `${sessionId}-${branchId}-${text}`,
      sessionId,
      branchId,
      role: "user",
      parts: [new TextPart({ type: "text", text })],
      createdAt: new Date(),
    })

  const makeLayer = (providerLayer: Layer.Layer<Provider>) => {
    const deps = Layer.mergeAll(
      Storage.Test(),
      providerLayer,
      makeTestExtRegistry(),

      EventStore.Test(),
      HandoffHandler.Test(),
      ToolRunner.Test(),
      BunServices.layer,
    )
    return Layer.provideMerge(AgentLoop.Live({ systemPrompt: "" }), deps)
  }

  const makeRecordingLayer = (providerLayer: Layer.Layer<Provider>) => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      providerLayer,
      makeTestExtRegistry(),
      HandoffHandler.Test(),
      ToolRunner.Test(),
      BunServices.layer,
      recorderLayer,
      eventStoreLayer,
    )
    return Layer.provideMerge(AgentLoop.Live({ systemPrompt: "" }), deps)
  }

  test("runs sessions concurrently", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.map(() => new FinishChunk({ finishReason: "stop" })),
            ),
          )
        }
        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const messageA = makeMessage("s1", "b1", "hello")
          const messageB = makeMessage("s2", "b2", "world")

          const fiberA = yield* Effect.forkChild(agentLoop.run(messageA))
          yield* Effect.sleep("10 millis")
          const fiberB = yield* Effect.forkChild(agentLoop.run(messageB))

          const finishedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedB._tag).toBe("Some")

          const statusA = fiberA.pollUnsafe()
          expect(statusA).toBeUndefined()

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiberA)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("serializes loop creation for the same session and branch", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.map(() => new FinishChunk({ finishReason: "stop" })),
            ),
          )
        }

        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const delayedStorage = Layer.effect(
      Storage,
      Effect.gen(function* () {
        const storage = yield* Storage
        return {
          ...storage,
          getLatestEvent: (input) => storage.getLatestEvent(input).pipe(Effect.delay("25 millis")),
          getAgentLoopCheckpoint: (input) =>
            storage.getAgentLoopCheckpoint(input).pipe(Effect.delay("25 millis")),
        }
      }),
    )

    const slowStorage = Layer.provide(delayedStorage, Storage.Test())

    const deps = Layer.mergeAll(
      slowStorage,
      providerLayer,
      makeTestExtRegistry(),
      EventStore.Test(),
      HandoffHandler.Test(),
      ToolRunner.Test(),
      BunServices.layer,
    )
    const layer = Layer.provideMerge(AgentLoop.Live({ systemPrompt: "" }), deps)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const fiberA = yield* Effect.forkChild(agentLoop.run(makeMessage("s1", "b1", "first")))
          const fiberB = yield* Effect.forkChild(agentLoop.run(makeMessage("s1", "b1", "second")))

          yield* Effect.sleep("80 millis")
          expect(calls).toBe(1)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiberA)
          yield* Fiber.join(fiberB)

          expect(calls).toBe(2)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("interrupt scoped to session/branch", async () => {
    const gateA = await Effect.runPromise(Deferred.make<void>())
    const gateB = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        const gate = calls === 1 ? gateA : gateB
        return Effect.succeed(
          Stream.fromEffect(Deferred.await(gate)).pipe(
            Stream.map(() => new FinishChunk({ finishReason: "stop" })),
          ),
        )
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const messageA = makeMessage("s1", "b1", "alpha")
          const messageB = makeMessage("s2", "b2", "beta")

          const fiberA = yield* Effect.forkChild(agentLoop.run(messageA))
          const fiberB = yield* Effect.forkChild(agentLoop.run(messageB))

          yield* Effect.sleep("10 millis")
          yield* agentLoop.steer({ _tag: "Interrupt", sessionId: "s1", branchId: "b1" })

          const finishedA = yield* Fiber.join(fiberA).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedA._tag).toBe("Some")

          const statusB = fiberB.pollUnsafe()
          expect(statusB).toBeUndefined()

          yield* Deferred.succeed(gateA, undefined)
          yield* Deferred.succeed(gateB, undefined)
          yield* Fiber.join(fiberB)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("batches queued regular messages into one follow-up message", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.map(() => new FinishChunk({ finishReason: "stop" })),
            ),
          )
        }
        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const storage = yield* Storage

          const first = makeMessage("s1", "b1", "first")
          const second = makeMessage("s1", "b1", "second")
          const third = makeMessage("s1", "b1", "third")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Effect.sleep("10 millis")
          yield* agentLoop.run(second)
          yield* agentLoop.run(third)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)

          const messages = yield* storage.listMessages("b1")
          const userTexts = messages
            .filter((message) => message.role === "user")
            .map((message) =>
              message.parts
                .filter((part): part is TextPart => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            )

          expect(userTexts).toEqual(["first", "second\nthird"])
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("publishes loop inspection transitions through Streaming", async () => {
    const providerLayer = Layer.succeed(Provider, {
      stream: () =>
        Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })])),
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeRecordingLayer(providerLayer)

    const getStateTag = (payload: unknown, key: string) => {
      if (typeof payload !== "object" || payload === null) return undefined
      const state = (payload as Record<string, unknown>)[key]
      if (typeof state !== "object" || state === null) return undefined
      const tag = (state as Record<string, unknown>)["_tag"]
      return typeof tag === "string" ? tag : undefined
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const recorder = yield* SequenceRecorder

          yield* agentLoop.run(makeMessage("s1", "b1", "inspect me"))

          const calls = yield* recorder.getCalls()
          const transitions = calls
            .filter((call) => call.service === "EventStore" && call.method === "publish")
            .map(
              (call) =>
                call.args as
                  | { _tag?: string; inspectionType?: string; payload?: unknown }
                  | undefined,
            )
            .filter(
              (
                event,
              ): event is { _tag: "MachineInspected"; inspectionType: string; payload: unknown } =>
                event?._tag === "MachineInspected" &&
                event.inspectionType === "@machine.transition" &&
                "payload" in event,
            )
            .map((event) => ({
              from: getStateTag(event.payload, "fromState"),
              to: getStateTag(event.payload, "toState"),
            }))

          expect(transitions).toContainEqual({ from: "Resolving", to: "Streaming" })
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("runs interjection before queued follow-up and scopes agent override to that turn", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const calls: Array<{ model: string; latestUserText: string }> = []
    let streamCount = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: (request) => {
        const latestUserText = [...request.messages]
          .reverse()
          .find((message) => message.role === "user")
          ?.parts.filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        calls.push({
          model: request.model,
          latestUserText: latestUserText ?? "",
        })

        streamCount += 1
        if (streamCount === 1) {
          return Effect.succeed(
            Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.map(() => new FinishChunk({ finishReason: "stop" })),
            ),
          )
        }

        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Effect.sleep("10 millis")
          yield* agentLoop.run(queued)
          yield* agentLoop.steer({
            _tag: "Interject",
            sessionId: "s1",
            branchId: "b1",
            message: "steer now",
            agent: "deepwork",
          })

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)

          expect(calls.map((call) => [call.model, call.latestUserText])).toEqual([
            ["anthropic/claude-opus-4-6", "first"],
            ["openai/gpt-5.4", "steer now"],
            ["anthropic/claude-opus-4-6", "queued"],
          ])
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("reads queued messages without draining them", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.map(() => new FinishChunk({ finishReason: "stop" })),
            ),
          )
        }
        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const first = makeMessage("s1", "b1", "first")
          const queuedA = makeMessage("s1", "b1", "queued a")
          const queuedB = makeMessage("s1", "b1", "queued b")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Effect.sleep("10 millis")
          yield* agentLoop.run(queuedA)
          yield* agentLoop.run(queuedB)
          yield* agentLoop.steer({
            _tag: "Interject",
            sessionId: "s1",
            branchId: "b1",
            message: "steer now",
          })

          const snapshot = yield* agentLoop.getQueue({ sessionId: "s1", branchId: "b1" })
          expect(snapshot.steering).toEqual([
            expect.objectContaining({
              kind: "steering",
              content: "steer now",
            }),
          ])
          expect(snapshot.followUp).toEqual([
            expect.objectContaining({
              kind: "follow-up",
              content: "queued a\nqueued b",
            }),
          ])

          const secondSnapshot = yield* agentLoop.getQueue({ sessionId: "s1", branchId: "b1" })
          expect(secondSnapshot).toEqual(snapshot)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("flushes queued follow-ups after provider failure", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const calls: string[] = []
    let streamCalls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: ({ messages }) => {
        const latestUserText =
          messages
            .slice()
            .reverse()
            .flatMap((message) => message.parts)
            .find((part): part is TextPart => part.type === "text")?.text ?? ""

        calls.push(latestUserText)
        streamCalls += 1

        if (streamCalls === 1) {
          return Effect.succeed(
            Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.flatMap(() =>
                Stream.fail(
                  new ProviderError({
                    message: "provider exploded",
                    model: "test",
                  }),
                ),
              ),
            ),
          )
        }

        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued after failure")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Effect.sleep("10 millis")
          yield* agentLoop.run(queued)

          const snapshotWhileRunning = yield* agentLoop.getQueue({
            sessionId: "s1",
            branchId: "b1",
          })
          expect(snapshotWhileRunning.followUp).toEqual([
            expect.objectContaining({
              kind: "follow-up",
              content: "queued after failure",
            }),
          ])

          yield* Deferred.succeed(gate, undefined)

          yield* Fiber.join(fiber).pipe(Effect.exit)

          expect(calls).toEqual(["first", "queued after failure"])

          const snapshotAfterFailure = yield* agentLoop.getQueue({
            sessionId: "s1",
            branchId: "b1",
          })
          expect(snapshotAfterFailure).toEqual({ steering: [], followUp: [] })
        }).pipe(Effect.provide(layer)),
      ),
    )
  })
})

describe("AgentActor", () => {
  test("publishes machine inspection + task events", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const extRegistry = makeTestExtRegistry()
    const toolDeps = Layer.mergeAll(
      extRegistry,
      Permission.Test(),
      PermissionHandler.Test(["allow"]),
    )
    const toolRunnerLayer = ToolRunner.Live.pipe(Layer.provide(toolDeps))
    const deps = Layer.mergeAll(
      Storage.Test(),
      Provider.Test([[new FinishChunk({ finishReason: "stop" })]]),

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

        yield* Effect.yieldNow

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
      ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: "test" },
            kind: "builtin",
            sourcePath: "test",
            setup: { tools: [FailTool] },
          },
        ]),
      ),
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
    expect(error).toContain("Tool 'fail' failed")
  })

  test("returns structured error on invalid input", async () => {
    const StrictTool = defineTool({
      name: "strict",
      concurrency: "parallel",
      description: "Requires specific params",
      params: Schema.Struct({ path: Schema.String }),
      execute: () => Effect.succeed({ ok: true }),
    })

    const deps = Layer.mergeAll(
      ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: "test" },
            kind: "builtin",
            sourcePath: "test",
            setup: { tools: [StrictTool] },
          },
        ]),
      ),
      Permission.Test(),
      PermissionHandler.Test(["allow"]),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "strict", input: { path: 42 } },
          { sessionId: "s", branchId: "b", toolCallId: "tc1", agentName: "cowork" },
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("error-json")
    const error = (result.output.value as { error?: string }).error ?? ""
    expect(error).toContain("Tool 'strict' input failed:")
    expect(error).toContain("path")
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
      makeTestExtRegistry([toolA, toolB]),
      EventStore.Test(),

      Permission.Test(),
      PermissionHandler.Test(["allow"]),
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

describe("ActorProcess", () => {
  const makeActorProcessLayer = (agentLoopLayer: Layer.Layer<AgentLoop>) => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const deps = Layer.mergeAll(
      Storage.Test(),
      agentLoopLayer,
      eventStoreLayer,
      recorderLayer,
      ToolRunner.Test(),
    )
    return Layer.provideMerge(LocalActorProcessLive, deps)
  }

  test("steerAgent delegates to AgentLoop.steer", async () => {
    let steered = false
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      run: () => Effect.void,
      steer: () =>
        Effect.sync(() => {
          steered = true
        }),
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      getState: () => Effect.succeed({ status: "idle" as const, agent: "cowork", queueDepth: 0 }),
    })

    const layer = makeActorProcessLayer(agentLoopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const actorProcess = yield* ActorProcess
        yield* actorProcess.steerAgent({
          _tag: "SwitchAgent",
          sessionId: "s1" as never,
          branchId: "b1" as never,
          agent: "deepwork",
        })
        expect(steered).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("sendUserMessage publishes AgentRestarted on defect", async () => {
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      run: () => Effect.die("boom"),
      steer: () => Effect.void,
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      getState: () => Effect.succeed({ status: "idle" as const, agent: "cowork", queueDepth: 0 }),
    })

    const layer = makeActorProcessLayer(agentLoopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const actorProcess = yield* ActorProcess
        const recorder = yield* SequenceRecorder

        const now = new Date()
        yield* storage.createSession(
          new Session({
            id: "defect-session",
            name: "Defect",
            bypass: true,
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* storage.createBranch(
          new Branch({
            id: "defect-branch",
            sessionId: "defect-session",
            createdAt: now,
          }),
        )

        yield* actorProcess.sendUserMessage({
          sessionId: "defect-session" as never,
          branchId: "defect-branch" as never,
          content: "trigger defect",
        })

        // Give the forked fiber time to run
        yield* Effect.sleep("50 millis")

        const calls = yield* recorder.getCalls()
        const publishedTags = calls
          .filter((c) => c.service === "EventStore" && c.method === "publish")
          .map((c) => (c.args as { _tag: string } | undefined)?._tag)

        expect(publishedTags).toContain("AgentRestarted")
        expect(publishedTags).toContain("ErrorOccurred")

        // AgentRestarted should come before ErrorOccurred
        const restartIdx = publishedTags.indexOf("AgentRestarted")
        const errorIdx = publishedTags.indexOf("ErrorOccurred")
        expect(restartIdx).toBeLessThan(errorIdx)
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("Tool Schema", () => {
  test("convertTools produces type: object for Schema.Struct({})", () => {
    const emptyTool = defineTool({
      name: "empty_params",
      concurrency: "parallel",
      description: "Tool with no params",
      params: Schema.Struct({}),
      execute: () => Effect.succeed({ ok: true }),
    })

    const tools = convertTools([emptyTool])
    const converted = tools["empty_params"]
    expect(converted).toBeDefined()

    // Access the inputSchema from the tool wrapper — AI SDK tool() wraps it
    // The schema should have type: "object" after the guard
    const schema = (converted as { inputSchema: { jsonSchema: Record<string, unknown> } })
      .inputSchema.jsonSchema
    expect(schema["type"]).toBe("object")
    expect(schema["anyOf"]).toBeUndefined()
  })
})
