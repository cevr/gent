import { describe, test, expect, beforeAll } from "bun:test"
import { Effect, Layer } from "effect"
import { extension } from "@gent/core/extensions/api"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol"
import { AgentRunSpawned } from "@gent/core/domain/event"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { Permission } from "@gent/core/domain/permission"
import type { ToolCallId, SessionId, BranchId } from "@gent/core/domain/ids"

describe("extension api", () => {
  test("setup exposes declared tools, prompt sections, and agents", async () => {
    const ext = extension("test-simple", (b) => {
      b.tool({
        name: "greet",
        description: "Say hello",
        parameters: { name: { type: "string" } },
        execute: async (params) => `Hello, ${params.name}!`,
      })
      b.promptSection({ id: "custom-rules", content: "Be nice.", priority: 50 })
      b.agent({
        name: "helper",
        model: "test/model",
        description: "A helper agent",
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.tools?.map((tool) => tool.name)).toEqual(["greet"])
    expect(setup.promptSections?.map((section) => section.id)).toEqual(["custom-rules"])
    expect(setup.agents?.map((agent) => agent.name)).toEqual(["helper"])
  })

  test("duplicate protocol tags fail at setup time", async () => {
    const TogglePlan = ExtensionMessage("test-dup-protocol", "TogglePlan", {})
    const ext = extension("test-dup-protocol", (b) => {
      b.protocol({ TogglePlan })
      b.protocol({ TogglePlan })
    })

    await expect(
      Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" })),
    ).rejects.toThrow("ExtensionProtocolError")
  })

  test("factory receives setup context and can be async", async () => {
    let receivedCwd = ""
    let receivedSource = ""
    const ext = extension("ctx-test", async (_b, ctx) => {
      await Promise.resolve()
      receivedCwd = ctx.cwd
      receivedSource = ctx.source
    })

    await Effect.runPromise(
      ext.setup({ cwd: "/my/project", source: "/path/to/ext.ts", home: "/tmp" }),
    )
    expect(receivedCwd).toBe("/my/project")
    expect(receivedSource).toBe("/path/to/ext.ts")
  })

  test("factory error maps to setup failure", async () => {
    const ext = extension("fail-factory", () => {
      throw new Error("factory broke")
    })

    const exit = await Effect.runPromiseExit(
      ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("interceptors register through the extension setup", async () => {
    const ext = extension("hook-test", (b) => {
      b.on("prompt.system", async (input, next) => {
        const result = await next(input)
        return `${result}\n-- Added by extension`
      })
      b.on("turn.after", async () => {})
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.hooks?.interceptors?.map((interceptor) => interceptor.key)).toEqual([
      "prompt.system",
      "turn.after",
    ])
  })

  test("startup and shutdown hooks compose in registration order", async () => {
    const order: string[] = []
    const ext = extension("lifecycle-test", (b) => {
      b.onStartup(() => {
        order.push("startup:sync")
      })
      b.onStartupEffect(Effect.sync(() => order.push("startup:effect")))
      b.onShutdown(() => {
        order.push("shutdown")
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    await Effect.runPromise(setup.onStartup!)
    await Effect.runPromise(setup.onShutdown!)
    expect(order).toEqual(["startup:sync", "startup:effect", "shutdown"])
  })

  test("integrates with extension registry", async () => {
    const ext = extension("registry-test", (b) => {
      b.tool({
        name: "my_tool",
        description: "test tool",
        execute: async () => "ok",
      })
      b.promptSection({ id: "test-section", content: "test content", priority: 90 })
    })

    const loaded = {
      manifest: ext.manifest,
      kind: "user" as const,
      sourcePath: "test",
      setup: await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" })),
    }

    const resolved = resolveExtensions([loaded])
    const layer = ExtensionRegistry.fromResolved(resolved)

    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const tools = yield* registry.listTools()
        expect(tools.some((tool) => tool.name === "my_tool")).toBe(true)

        const sections = yield* registry.listPromptSections()
        expect(sections.some((section) => section.id === "test-section")).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("extension tools through ToolRunner.run", () => {
  const ext = extension("runner-test", (b) => {
    b.tool({
      name: "format",
      description: "Formats a greeting",
      parameters: {
        name: { type: "string" },
        count: { type: "number", optional: true },
      },
      execute: async (params) => {
        const count = (params.count as number | undefined) ?? 1
        return `Hello, ${params.name}! (x${String(count)})`
      },
    })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layer: Layer.Layer<any>

  beforeAll(async () => {
    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    const baseDeps = Layer.mergeAll(
      ExtensionRegistry.fromResolved(
        resolveExtensions([{ manifest: ext.manifest, kind: "user", sourcePath: "test", setup }]),
      ),
      Permission.Test(),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(baseDeps))
    layer = Layer.mergeAll(baseDeps, runnerLayer)
  })

  const ctx = {
    sessionId: "s1" as SessionId,
    branchId: "b1" as BranchId,
    toolCallId: "tc1" as ToolCallId,
  }

  test("runs tool with required and optional params", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "format", input: { name: "Ada", count: 3 } },
          ctx,
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("json")
    expect(result.output.value).toBe("Hello, Ada! (x3)")
  })

  test("returns validation errors for malformed input", async () => {
    const missingParam = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run({ toolCallId: "tc2", toolName: "format", input: {} }, ctx)
      }).pipe(Effect.provide(layer)),
    )

    const wrongType = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc3", toolName: "format", input: { name: 42 } },
          ctx,
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(missingParam.output.type).toBe("error-json")
    expect(wrongType.output.type).toBe("error-json")
  })
})

describe("state-backed extension api", () => {
  test("state derive exposes projection output", async () => {
    const ext = extension("state-derive", (b) => {
      b.state({
        initial: { turns: 0 },
        reduce: (state, event) => {
          if (event.type === "turn-completed") return { state: { turns: state.turns + 1 } }
          return { state }
        },
        derive: (state) => ({
          promptSections: [{ id: "turns", content: `Turns: ${state.turns}`, priority: 50 }],
        }),
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.spawn).toBeDefined()
    expect(setup.projection).toBeDefined()
  })

  test("state reducer still maps AgentRun events to subagent simple event names", async () => {
    const ext = extension("state-agent-run-alias", (b) => {
      b.state({
        initial: { seenType: false, seenTag: false, seenRawTag: false },
        reduce: (state, event) => {
          if (event.type === "subagent-spawned") {
            return {
              state: {
                seenType: true,
                seenTag: event._tag === "SubagentSpawned",
                seenRawTag: event.raw._tag === "SubagentSpawned",
              },
            }
          }
          return { state }
        },
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    const actorLayer = ExtensionTurnControl.Test()
    const actor = await Effect.runPromise(
      setup.spawn!({
        sessionId: "s1" as SessionId,
        branchId: "b1" as BranchId,
      }).pipe(Effect.provide(actorLayer)),
    )

    await Effect.runPromise(actor.start.pipe(Effect.provide(actorLayer)))
    await Effect.runPromise(
      actor
        .publish(
          new AgentRunSpawned({
            parentSessionId: "s1" as SessionId,
            childSessionId: "s2" as SessionId,
            agentName: "reviewer",
            prompt: "inspect",
            branchId: "b1" as BranchId,
          }),
          { sessionId: "s1" as SessionId, branchId: "b1" as BranchId },
        )
        .pipe(Effect.provide(actorLayer)),
    )

    const snapshot = await Effect.runPromise(actor.snapshot.pipe(Effect.provide(actorLayer)))
    expect(snapshot.state).toEqual({ seenType: true, seenTag: true, seenRawTag: true })
    await Effect.runPromise(actor.stop.pipe(Effect.provide(actorLayer)))
  })

  test("malformed persist config and mixed state/actor wiring fail setup", async () => {
    const badPersist = extension("bad-persist", (b) => {
      b.state({
        initial: { x: 1 },
        reduce: (state) => ({ state }),
        // @ts-expect-error testing malformed JS author config
        persist: {},
      })
    })

    const { fromReducer } = await import("@gent/core/runtime/extensions/from-reducer")
    const actor = fromReducer({ id: "x", initial: {}, reduce: (state: object) => ({ state }) })
    const mixed = extension("mutex-test", (b) => {
      b.state({ initial: { a: 1 }, reduce: (state) => ({ state }) })
      b.actor(actor)
    })

    const badPersistExit = await Effect.runPromiseExit(
      badPersist.setup({ cwd: "/tmp", source: "test", home: "/tmp" }),
    )
    const mixedExit = await Effect.runPromiseExit(
      mixed.setup({ cwd: "/tmp", source: "test", home: "/tmp" }),
    )

    expect(badPersistExit._tag).toBe("Failure")
    expect(mixedExit._tag).toBe("Failure")
  })
})
