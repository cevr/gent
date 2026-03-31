import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { simpleExtension } from "@gent/core/extensions/api"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { Permission } from "@gent/core/domain/permission"
import { PermissionHandler } from "@gent/core/domain/interaction-handlers"
import type { ToolCallId, SessionId, BranchId } from "@gent/core/domain/ids"

describe("simpleExtension", () => {
  test("creates a valid extension with tools", () => {
    const ext = simpleExtension("test-simple", (b) => {
      b.tool({
        name: "greet",
        description: "Say hello",
        parameters: { name: { type: "string" } },
        execute: async (params) => `Hello, ${params.name}!`,
      })
    })

    expect(ext.manifest.id).toBe("test-simple")
    const setup = Effect.runSync(ext.setup({ cwd: "/tmp", source: "test" }))
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

    const setup = Effect.runSync(ext.setup({ cwd: "/tmp", source: "test" }))
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

    const setup = Effect.runSync(ext.setup({ cwd: "/tmp", source: "test" }))
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

  test("registers prompt sections", () => {
    const ext = simpleExtension("test-sections", (b) => {
      b.promptSection({ id: "custom-rules", content: "Be nice.", priority: 50 })
    })

    const setup = Effect.runSync(ext.setup({ cwd: "/tmp", source: "test" }))
    expect(setup.promptSections).toBeDefined()
    expect(setup.promptSections![0]!.id).toBe("custom-rules")
    expect(setup.promptSections![0]!.content).toBe("Be nice.")
  })

  test("registers agents", () => {
    const ext = simpleExtension("test-agent", (b) => {
      b.agent({
        name: "helper",
        model: "test/model",
        description: "A helper agent",
      })
    })

    const setup = Effect.runSync(ext.setup({ cwd: "/tmp", source: "test" }))
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
      setup: Effect.runSync(ext.setup({ cwd: "/tmp", source: "test" })),
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

  test("empty extension produces valid setup", () => {
    const ext = simpleExtension("empty", () => {})
    const setup = Effect.runSync(ext.setup({ cwd: "/tmp", source: "test" }))
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

  const setup = Effect.runSync(ext.setup({ cwd: "/tmp", source: "test" }))

  const baseDeps = Layer.mergeAll(
    ExtensionRegistry.fromResolved(
      resolveExtensions([{ manifest: ext.manifest, kind: "user", sourcePath: "test", setup }]),
    ),
    Permission.Test(),
    PermissionHandler.Test(["allow"]),
  )
  const runnerLayer = ToolRunner.Live.pipe(Layer.provide(baseDeps))
  const layer = Layer.mergeAll(baseDeps, runnerLayer)

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
