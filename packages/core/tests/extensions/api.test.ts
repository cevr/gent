import { describe, test, expect, beforeAll } from "bun:test"
import { Effect, Layer } from "effect"
import { extension } from "@gent/core/extensions/api"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { Permission } from "@gent/core/domain/permission"
import type { ToolCallId, SessionId, BranchId } from "@gent/core/domain/ids"

describe("extension", () => {
  test("creates a valid extension with tools", async () => {
    const ext = extension("test-simple", (b) => {
      b.tool({
        name: "greet",
        description: "Say hello",
        parameters: { name: { type: "string" } },
        execute: async (params) => `Hello, ${params.name}!`,
      })
    })

    expect(ext.manifest.id).toBe("test-simple")
    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.tools).toBeDefined()
    expect(setup.tools!.length).toBe(1)
    expect(setup.tools![0]!.name).toBe("greet")
  })

  test("tool execute works with async function", async () => {
    const ext = extension("test-async", (b) => {
      b.tool({
        name: "add",
        description: "Add numbers",
        parameters: { a: { type: "number" }, b: { type: "number" } },
        execute: async (params) => (params.a as number) + (params.b as number),
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    const tool = setup.tools![0]!
    const result = await Effect.runPromise(
      tool.execute(
        { a: 2, b: 3 },
        {
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          toolCallId: "tc1" as ToolCallId,
        },
      ),
    )
    expect(result).toBe(5)
  })

  test("tool execute works with sync function", async () => {
    const ext = extension("test-sync", (b) => {
      b.tool({
        name: "echo",
        description: "Echo input",
        execute: (params) => params,
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    const tool = setup.tools![0]!
    const result = await Effect.runPromise(
      tool.execute(
        { msg: "hi" },
        {
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          toolCallId: "tc1" as ToolCallId,
        },
      ),
    )
    expect(result).toEqual({ msg: "hi" })
  })

  test("registers prompt sections", async () => {
    const ext = extension("test-sections", (b) => {
      b.promptSection({ id: "custom-rules", content: "Be nice.", priority: 50 })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.promptSections).toBeDefined()
    expect(setup.promptSections![0]!.id).toBe("custom-rules")
    expect(setup.promptSections![0]!.content).toBe("Be nice.")
  })

  test("registers agents", async () => {
    const ext = extension("test-agent", (b) => {
      b.agent({
        name: "helper",
        model: "test/model",
        description: "A helper agent",
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.agents).toBeDefined()
    expect(setup.agents![0]!.name).toBe("helper")
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
        expect(tools.some((t) => t.name === "my_tool")).toBe(true)

        const sections = yield* registry.listPromptSections()
        expect(sections.some((s) => s.id === "test-section")).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("empty extension produces valid setup", async () => {
    const ext = extension("empty", () => {})
    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.tools).toBeUndefined()
    expect(setup.agents).toBeUndefined()
    expect(setup.promptSections).toBeUndefined()
  })
})

describe("extension through ToolRunner.run", () => {
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

  test("runs tool with only required params (optional omitted)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc2", toolName: "format", input: { name: "Grace" } },
          ctx,
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("json")
    expect(result.output.value).toBe("Hello, Grace! (x1)")
  })

  test("returns error on invalid params (wrong type)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc3", toolName: "format", input: { name: 42 } },
          ctx,
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("error-json")
    const error = (result.output.value as { error?: string }).error ?? ""
    expect(error).toContain("format")
  })

  test("returns error on missing required param", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run({ toolCallId: "tc4", toolName: "format", input: {} }, ctx)
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("error-json")
    const error = (result.output.value as { error?: string }).error ?? ""
    expect(error).toContain("format")
  })
})

describe("extension async factory", () => {
  test("supports async factory", async () => {
    const ext = extension("async-factory", async (b) => {
      await Promise.resolve()
      b.tool({ name: "delayed", description: "Added async", execute: async () => "ok" })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.tools!.length).toBe(1)
    expect(setup.tools![0]!.name).toBe("delayed")
  })

  test("receives setup context", async () => {
    let receivedCwd = ""
    let receivedSource = ""
    const ext = extension("ctx-test", (_b, ctx) => {
      receivedCwd = ctx.cwd
      receivedSource = ctx.source
    })

    await Effect.runPromise(
      ext.setup({ cwd: "/my/project", source: "/path/to/ext.ts", home: "/tmp" }),
    )
    expect(receivedCwd).toBe("/my/project")
    expect(receivedSource).toBe("/path/to/ext.ts")
  })

  test("factory error maps to ExtensionLoadError", async () => {
    const ext = extension("fail-factory", () => {
      throw new Error("factory broke")
    })

    const exit = await Effect.runPromiseExit(
      ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("extension hooks", () => {
  test("ext.on registers interceptors", async () => {
    const ext = extension("hook-test", (b) => {
      b.on("prompt.system", async (input, next) => {
        const result = await next(input)
        return result + "\n-- Added by extension"
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.hooks).toBeDefined()
    expect(setup.hooks!.interceptors!.length).toBe(1)
    expect(setup.hooks!.interceptors![0]!.key).toBe("prompt.system")
  })

  test("ext.on turn.after registers fire-and-forget hook", async () => {
    const ext = extension("turn-after-test", (b) => {
      b.on("turn.after", async () => {
        // side effect
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.hooks!.interceptors![0]!.key).toBe("turn.after")
  })
})

describe("extension lifecycle", () => {
  test("onStartup runs at setup time", async () => {
    let started = false
    const ext = extension("startup-test", (b) => {
      b.onStartup(() => {
        started = true
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.onStartup).toBeDefined()
    // onStartup effect is returned, not run during setup
    await Effect.runPromise(setup.onStartup!)
    expect(started).toBe(true)
  })

  test("multiple onStartup compose in order", async () => {
    const order: number[] = []
    const ext = extension("multi-startup", (b) => {
      b.onStartup(() => order.push(1))
      b.onStartup(() => order.push(2))
      b.onStartup(() => order.push(3))
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    await Effect.runPromise(setup.onStartup!)
    expect(order).toEqual([1, 2, 3])
  })

  test("onShutdown registers cleanup", async () => {
    let cleaned = false
    const ext = extension("shutdown-test", (b) => {
      b.onShutdown(() => {
        cleaned = true
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.onShutdown).toBeDefined()
    await Effect.runPromise(setup.onShutdown!)
    expect(cleaned).toBe(true)
  })
})

describe("extension state", () => {
  test("ext.state() wires fromReducer", async () => {
    const ext = extension("state-test", (b) => {
      b.state({
        initial: { count: 0 },
        reduce: (state, event) => {
          if (event.type === "turn-completed") return { state: { count: state.count + 1 } }
          return { state }
        },
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.spawnActor).toBeDefined()
  })

  test("ext.state() with derive produces projection", async () => {
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
    expect(setup.spawnActor).toBeDefined()
    expect(setup.projection).toBeDefined()
  })

  test("ext.state() throws on second call", async () => {
    const ext = extension("double-state", (b) => {
      b.state({ initial: { a: 1 }, reduce: (s) => ({ state: s }) })
      b.state({ initial: { b: 2 }, reduce: (s) => ({ state: s }) })
    })

    const exit = await Effect.runPromiseExit(
      ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("ext.state() with persist but no schema fails at setup", async () => {
    const ext = extension("bad-persist", (b) => {
      b.state({
        initial: { x: 1 },
        reduce: (s) => ({ state: s }),
        // @ts-expect-error — testing JS author passing malformed config
        persist: {},
      })
    })

    const exit = await Effect.runPromiseExit(
      ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("extension full-power methods", () => {
  test("ext.tool() passes through full AnyToolDefinition", async () => {
    const { defineTool } = await import("@gent/core/domain/tool")
    const { Schema } = await import("effect")
    const fullTool = defineTool({
      name: "full-tool",
      action: "read" as const,
      description: "A full tool",
      params: Schema.Struct({ x: Schema.Number }),
      execute: () => Effect.succeed(42),
    })

    const ext = extension("full-tool-test", (b) => {
      b.tool(fullTool)
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.tools!.length).toBe(1)
    expect(setup.tools![0]!.name).toBe("full-tool")
  })

  test("ext.agent() passes through full AgentDefinition", async () => {
    const { AgentDefinition } = await import("@gent/core/domain/agent")
    const fullAgent = new AgentDefinition({
      name: "full-agent",
      kind: "subagent",
    })

    const ext = extension("full-agent-test", (b) => {
      b.agent(fullAgent)
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.agents!.length).toBe(1)
    expect(setup.agents![0]!.name).toBe("full-agent")
  })

  test("ext.interceptor() registers raw Effect interceptor", async () => {
    const ext = extension("interceptor-test", (b) => {
      b.interceptor("prompt.system", (input, next) => next(input))
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.hooks!.interceptors!.length).toBe(1)
    expect(setup.hooks!.interceptors![0]!.key).toBe("prompt.system")
  })

  test("ext.interceptor() accepts descriptor object", async () => {
    const { defineInterceptor } = await import("@gent/core/domain/extension")
    const desc = defineInterceptor("turn.after", (_input, next) => next(_input))

    const ext = extension("descriptor-test", (b) => {
      b.interceptor(desc)
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.hooks!.interceptors![0]!.key).toBe("turn.after")
  })

  test("ext.actor() wires spawnActor and projection", async () => {
    const { fromReducer } = await import("@gent/core/runtime/extensions/from-reducer")
    const actor = fromReducer({
      id: "test-actor",
      initial: { count: 0 },
      reduce: (state: { count: number }) => ({ state }),
    })

    const ext = extension("actor-test", (b) => {
      b.actor(actor)
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.spawnActor).toBeDefined()
  })

  test("ext.layer() registers a service layer", async () => {
    const { Layer, ServiceMap } = await import("effect")
    const TestService = ServiceMap.Service<{ value: string }>("TestService")
    const testLayer = Layer.succeed(TestService, { value: "hello" })

    const ext = extension("layer-test", (b) => {
      b.layer(testLayer)
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.layer).toBeDefined()
  })

  test("ext.layer() with phase 'runtime' registers runtime layer", async () => {
    const { Layer, ServiceMap } = await import("effect")
    const RuntimeService = ServiceMap.Service<{ value: string }>("RuntimeService")
    const runtimeLayer = Layer.succeed(RuntimeService, { value: "runtime" })

    const ext = extension("runtime-layer-test", (b) => {
      b.layer(runtimeLayer, { phase: "runtime" })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.layer).toBeUndefined()
    expect(setup.runtimeLayers).toBeDefined()
    expect(setup.runtimeLayers!.length).toBe(1)
  })

  test("ext.layer() with both default and runtime phases separates layers", async () => {
    const { Layer, ServiceMap } = await import("effect")
    const DefaultService = ServiceMap.Service<{ value: string }>("DefaultService")
    const RuntimeService = ServiceMap.Service<{ value: string }>("RuntimeService")
    const defaultLayer = Layer.succeed(DefaultService, { value: "default" })
    const runtimeLayer = Layer.succeed(RuntimeService, { value: "runtime" })

    const ext = extension("mixed-layer-test", (b) => {
      b.layer(defaultLayer)
      b.layer(runtimeLayer, { phase: "runtime" })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.layer).toBeDefined()
    expect(setup.runtimeLayers).toBeDefined()
    expect(setup.runtimeLayers!.length).toBe(1)
  })

  test("ext.provider() registers a provider", async () => {
    const ext = extension("provider-test", (b) => {
      b.provider({ id: "test", name: "Test Provider", resolveModel: () => null })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.providers!.length).toBe(1)
    expect(setup.providers![0]!.id).toBe("test")
  })

  test("ext.interactionHandler() registers a handler", async () => {
    const ext = extension("handler-test", (b) => {
      b.interactionHandler({ type: "permission", layer: {} as never })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    expect(setup.interactionHandlers!.length).toBe(1)
    expect(setup.interactionHandlers![0]!.type).toBe("permission")
  })

  test("ext.onStartupEffect() composes with onStartup()", async () => {
    const order: number[] = []
    const ext = extension("mixed-startup", (b) => {
      b.onStartup(() => order.push(1))
      b.onStartupEffect(Effect.sync(() => order.push(2)))
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }))
    await Effect.runPromise(setup.onStartup!)
    expect(order).toEqual([1, 2])
  })

  test("state() and actor() are mutually exclusive", async () => {
    const { fromReducer } = await import("@gent/core/runtime/extensions/from-reducer")
    const actor = fromReducer({ id: "x", initial: {}, reduce: (s: object) => ({ state: s }) })

    const ext = extension("mutex-test", (b) => {
      b.state({ initial: { a: 1 }, reduce: (s) => ({ state: s }) })
      b.actor(actor)
    })

    const exit = await Effect.runPromiseExit(
      ext.setup({ cwd: "/tmp", source: "test", home: "/tmp" }),
    )
    expect(exit._tag).toBe("Failure")
  })
})
