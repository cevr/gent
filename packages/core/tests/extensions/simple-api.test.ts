import { describe, test, expect, beforeAll } from "bun:test"
import { Effect, Layer } from "effect"
import { simpleExtension } from "@gent/core/extensions/api"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { Permission } from "@gent/core/domain/permission"
import { PermissionHandler } from "@gent/core/domain/interaction-handlers"
import type { ToolCallId, SessionId, BranchId } from "@gent/core/domain/ids"

describe("simpleExtension", () => {
  test("creates a valid extension with tools", async () => {
    const ext = simpleExtension("test-simple", (b) => {
      b.tool({
        name: "greet",
        description: "Say hello",
        parameters: { name: { type: "string" } },
        execute: async (params) => `Hello, ${params.name}!`,
      })
    })

    expect(ext.manifest.id).toBe("test-simple")
    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.tools).toBeDefined()
    expect(setup.tools!.length).toBe(1)
    expect(setup.tools![0]!.name).toBe("greet")
  })

  test("tool execute works with async function", async () => {
    const ext = simpleExtension("test-async", (b) => {
      b.tool({
        name: "add",
        description: "Add numbers",
        parameters: { a: { type: "number" }, b: { type: "number" } },
        execute: async (params) => (params.a as number) + (params.b as number),
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
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
    const ext = simpleExtension("test-sync", (b) => {
      b.tool({
        name: "echo",
        description: "Echo input",
        execute: (params) => params,
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
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
    const ext = simpleExtension("test-sections", (b) => {
      b.promptSection({ id: "custom-rules", content: "Be nice.", priority: 50 })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.promptSections).toBeDefined()
    expect(setup.promptSections![0]!.id).toBe("custom-rules")
    expect(setup.promptSections![0]!.content).toBe("Be nice.")
  })

  test("registers agents", async () => {
    const ext = simpleExtension("test-agent", (b) => {
      b.agent({
        name: "helper",
        model: "test/model",
        description: "A helper agent",
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.agents).toBeDefined()
    expect(setup.agents![0]!.name).toBe("helper")
  })

  test("integrates with extension registry", async () => {
    const ext = simpleExtension("registry-test", (b) => {
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
      setup: await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" })),
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
    const ext = simpleExtension("empty", () => {})
    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.tools).toBeUndefined()
    expect(setup.agents).toBeUndefined()
    expect(setup.promptSections).toBeUndefined()
  })
})

describe("simpleExtension through ToolRunner.run", () => {
  const ext = simpleExtension("runner-test", (b) => {
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
    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    const baseDeps = Layer.mergeAll(
      ExtensionRegistry.fromResolved(
        resolveExtensions([{ manifest: ext.manifest, kind: "user", sourcePath: "test", setup }]),
      ),
      Permission.Test(),
      PermissionHandler.Test(["allow"]),
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

describe("simpleExtension async factory", () => {
  test("supports async factory", async () => {
    const ext = simpleExtension("async-factory", async (b) => {
      await Promise.resolve()
      b.tool({ name: "delayed", description: "Added async", execute: async () => "ok" })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.tools!.length).toBe(1)
    expect(setup.tools![0]!.name).toBe("delayed")
  })

  test("receives setup context", async () => {
    let receivedCwd = ""
    let receivedSource = ""
    const ext = simpleExtension("ctx-test", (_b, ctx) => {
      receivedCwd = ctx.cwd
      receivedSource = ctx.source
    })

    await Effect.runPromise(ext.setup({ cwd: "/my/project", source: "/path/to/ext.ts" }))
    expect(receivedCwd).toBe("/my/project")
    expect(receivedSource).toBe("/path/to/ext.ts")
  })

  test("factory error maps to ExtensionLoadError", async () => {
    const ext = simpleExtension("fail-factory", () => {
      throw new Error("factory broke")
    })

    const exit = await Effect.runPromiseExit(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(exit._tag).toBe("Failure")
  })
})

describe("simpleExtension hooks", () => {
  test("ext.on registers interceptors", async () => {
    const ext = simpleExtension("hook-test", (b) => {
      b.on("prompt.system", async (input, next) => {
        const result = await next(input)
        return result + "\n-- Added by extension"
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.hooks).toBeDefined()
    expect(setup.hooks!.interceptors!.length).toBe(1)
    expect(setup.hooks!.interceptors![0]!.key).toBe("prompt.system")
  })

  test("ext.on turn.after registers fire-and-forget hook", async () => {
    const ext = simpleExtension("turn-after-test", (b) => {
      b.on("turn.after", async () => {
        // side effect
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.hooks!.interceptors![0]!.key).toBe("turn.after")
  })
})

describe("simpleExtension lifecycle", () => {
  test("onStartup runs at setup time", async () => {
    let started = false
    const ext = simpleExtension("startup-test", (b) => {
      b.onStartup(() => {
        started = true
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.onStartup).toBeDefined()
    // onStartup effect is returned, not run during setup
    await Effect.runPromise(setup.onStartup!)
    expect(started).toBe(true)
  })

  test("multiple onStartup compose in order", async () => {
    const order: number[] = []
    const ext = simpleExtension("multi-startup", (b) => {
      b.onStartup(() => order.push(1))
      b.onStartup(() => order.push(2))
      b.onStartup(() => order.push(3))
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    await Effect.runPromise(setup.onStartup!)
    expect(order).toEqual([1, 2, 3])
  })

  test("onShutdown registers cleanup", async () => {
    let cleaned = false
    const ext = simpleExtension("shutdown-test", (b) => {
      b.onShutdown(() => {
        cleaned = true
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.onShutdown).toBeDefined()
    await Effect.runPromise(setup.onShutdown!)
    expect(cleaned).toBe(true)
  })
})

describe("simpleExtension state", () => {
  test("ext.state() wires fromReducer", async () => {
    const ext = simpleExtension("state-test", (b) => {
      b.state({
        initial: { count: 0 },
        reduce: (state, event) => {
          if (event.type === "turn-completed") return { state: { count: state.count + 1 } }
          return { state }
        },
      })
    })

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.spawnActor).toBeDefined()
  })

  test("ext.state() with derive produces projection", async () => {
    const ext = simpleExtension("state-derive", (b) => {
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

    const setup = await Effect.runPromise(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.spawnActor).toBeDefined()
    expect(setup.projection).toBeDefined()
  })

  test("ext.state() throws on second call", async () => {
    const ext = simpleExtension("double-state", (b) => {
      b.state({ initial: { a: 1 }, reduce: (s) => ({ state: s }) })
      b.state({ initial: { b: 2 }, reduce: (s) => ({ state: s }) })
    })

    const exit = await Effect.runPromiseExit(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(exit._tag).toBe("Failure")
  })

  test("ext.state() with persist but no schema fails at setup", async () => {
    const ext = simpleExtension("bad-persist", (b) => {
      b.state({
        initial: { x: 1 },
        reduce: (s) => ({ state: s }),
        // @ts-expect-error — testing JS author passing malformed config
        persist: {},
      })
    })

    const exit = await Effect.runPromiseExit(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(exit._tag).toBe("Failure")
  })
})
