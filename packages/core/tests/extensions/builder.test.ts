import { describe, test, expect } from "bun:test"
import { Effect, Layer, Context } from "effect"
import { extension } from "@gent/core/extensions/api"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import type { ProviderResolution } from "@gent/core/domain/provider-contribution"
import { testSetupCtx } from "@gent/core/test-utils"

const setup = (ext: ReturnType<typeof extension>) => Effect.runPromise(ext.setup(testSetupCtx()))

const stubResolution: ProviderResolution = { layer: Layer.empty as never }

describe("fluent builder", () => {
  // ── Variadic registration ──

  test("tools() registers multiple tools", async () => {
    const ext = extension("multi-tools", ({ ext }) =>
      ext.tools(
        { name: "a", description: "A", execute: () => Effect.succeed("a") },
        { name: "b", description: "B", execute: () => Effect.succeed("b") },
      ),
    )
    const s = await setup(ext)
    expect(s.tools?.map((t) => t.name)).toEqual(["a", "b"])
  })

  test("agents() registers multiple agents", async () => {
    const ext = extension("multi-agents", ({ ext }) =>
      ext.agents({ name: "alpha", model: "test/m1" }, { name: "beta", model: "test/m2" }),
    )
    const s = await setup(ext)
    expect(s.agents?.map((a) => a.name)).toEqual(["alpha", "beta"])
  })

  test("promptSections() registers static sections", async () => {
    const ext = extension("multi-sections", ({ ext }) =>
      ext.promptSections(
        { id: "s1", content: "one", priority: 10 },
        { id: "s2", content: "two", priority: 20 },
      ),
    )
    const s = await setup(ext)
    expect(s.promptSections?.map((ps) => ps.id)).toEqual(["s1", "s2"])
  })

  test("promptSections() registers dynamic sections", async () => {
    const ext = extension("dynamic-section", ({ ext }) =>
      ext.promptSections({
        id: "dyn",
        priority: 50,
        resolve: Effect.succeed("dynamic content"),
      }),
    )
    const s = await setup(ext)
    expect(s.promptSections).toHaveLength(1)
    const loaded = {
      manifest: ext.manifest,
      kind: "builtin" as const,
      sourcePath: "test",
      setup: s,
    }
    const resolved = resolveExtensions([loaded])
    const layer = ExtensionRegistry.fromResolved(resolved)
    const sections = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ExtensionRegistry
        return yield* reg.listPromptSections()
      }).pipe(Effect.provide(layer)),
    )
    expect(sections.find((ps) => ps.id === "dyn")?.content).toBe("dynamic content")
  })

  test("jobs() registers scheduled jobs", async () => {
    const ext = extension("multi-jobs", ({ ext }) =>
      ext.jobs(
        {
          id: "j1",
          schedule: "0 * * * *",
          target: { kind: "headless-agent", agent: "a", prompt: "p" },
        },
        {
          id: "j2",
          schedule: "0 0 * * *",
          target: { kind: "headless-agent", agent: "b", prompt: "q" },
        },
      ),
    )
    const s = await setup(ext)
    expect(s.jobs?.map((j) => j.id)).toEqual(["j1", "j2"])
  })

  // ── Single-call enforcement ──

  test("tools() throws on second call", async () => {
    expect(() =>
      extension("double-tools", ({ ext }) =>
        // @ts-expect-error — tools not in return type after first call
        ext
          .tools({ name: "a", description: "A", execute: () => Effect.succeed("a") })
          .tools({ name: "b", description: "B", execute: () => Effect.succeed("b") }),
      ),
    ).not.toThrow() // TS catches it; runtime guard is belt-and-suspenders

    // But runtime does throw:
    const ext = extension("double-tools-rt", ({ ext }) => {
      const b = ext.tools({ name: "a", description: "A", execute: () => Effect.succeed("a") })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(b as any).tools({ name: "b", description: "B", execute: () => Effect.succeed("b") })
      return b
    })
    await expect(setup(ext)).rejects.toThrow(/tools\(\) can only be called once/)
  })

  test("layer() throws on second call", async () => {
    const TestService = Context.Service<typeof TestService, { readonly value: string }>()("Test")
    const ext = extension("double-layer", ({ ext }) => {
      const b = ext.layer(Layer.succeed(TestService, { value: "a" }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(b as any).layer(Layer.succeed(TestService, { value: "b" }))
      return b
    })
    await expect(setup(ext)).rejects.toThrow(/layer\(\) can only be called once/)
  })

  test("actor() throws on second call", async () => {
    const ext = extension("double-actor", ({ ext }) => {
      const b = ext.actor({ machine: {} as never })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(b as any).actor({ machine: {} as never })
      return b
    })
    await expect(setup(ext)).rejects.toThrow(/actor\(\) can only be called once/)
  })

  test("provider() throws on second call", async () => {
    const ext = extension("double-provider", ({ ext }) => {
      const b = ext.provider({ id: "a", name: "A", resolveModel: () => stubResolution })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(b as any).provider({ id: "b", name: "B", resolveModel: () => stubResolution })
      return b
    })
    await expect(setup(ext)).rejects.toThrow(/provider\(\) can only be called once/)
  })

  // ── Multi-call methods ──

  test("on() allows multiple hook registrations", async () => {
    const ext = extension("multi-on", ({ ext }) =>
      ext.on("turn.after", () => Effect.void).on("message.input", (input, next) => next(input)),
    )
    const s = await setup(ext)
    expect(s.hooks?.interceptors?.map((i) => i.key)).toEqual(["turn.after", "message.input"])
  })

  test("command() allows multiple registrations", async () => {
    const ext = extension("multi-cmd", ({ ext }) =>
      ext.command("a", { handler: () => Effect.void }).command("b", { handler: () => Effect.void }),
    )
    const s = await setup(ext)
    expect(s.commands?.map((c) => c.name)).toEqual(["a", "b"])
  })

  test("bus() allows multiple subscriptions", async () => {
    const ext = extension("multi-bus", ({ ext }) =>
      ext.bus("channel:a", () => Effect.void).bus("channel:b", () => Effect.void),
    )
    const s = await setup(ext)
    expect(s.busSubscriptions).toHaveLength(2)
  })

  test("onStartup() composes multiple hooks", async () => {
    const order: number[] = []
    const ext = extension("multi-startup", ({ ext }) =>
      ext.onStartup(Effect.sync(() => order.push(1))).onStartup(Effect.sync(() => order.push(2))),
    )
    const s = await setup(ext)
    await Effect.runPromise(s.onStartup!)
    expect(order).toEqual([1, 2])
  })

  // ── Chaining returns builder ──

  test("full chain produces complete setup", async () => {
    const ext = extension("full-chain", ({ ext }) =>
      ext
        .tools({ name: "t", description: "T", execute: () => Effect.succeed("t") })
        .agents({ name: "a", model: "test/m" })
        .promptSections({ id: "p", content: "P", priority: 10 })
        .on("turn.after", () => Effect.void)
        .command("cmd", { handler: () => Effect.void })
        .onStartup(Effect.void)
        .onShutdown(Effect.void),
    )
    const s = await setup(ext)
    expect(s.tools).toHaveLength(1)
    expect(s.agents).toHaveLength(1)
    expect(s.promptSections).toHaveLength(1)
    expect(s.hooks?.interceptors).toHaveLength(1)
    expect(s.commands).toHaveLength(1)
    expect(s.onStartup).toBeDefined()
    expect(s.onShutdown).toBeDefined()
  })

  // ── Layer + Provides ──

  test("layer() widens Provides — dynamic promptSection can access provided service", async () => {
    const TestService = Context.Service<typeof TestService, { readonly value: string }>()("Test")

    const ext = extension("layer-provides", ({ ext }) =>
      ext.layer(Layer.succeed(TestService, { value: "hello from layer" })).promptSections({
        id: "from-layer",
        priority: 50,
        resolve: Effect.gen(function* () {
          const svc = yield* TestService
          return svc.value
        }),
      }),
    )

    const s = await setup(ext)
    expect(s.layer).toBeDefined()
    expect(s.promptSections).toHaveLength(1)

    // Verify the dynamic section resolves through the layer
    const loaded = {
      manifest: ext.manifest,
      kind: "builtin" as const,
      sourcePath: "test",
      setup: s,
    }
    const resolved = resolveExtensions([loaded])
    const registryLayer = ExtensionRegistry.fromResolved(resolved)

    // Provide the extension's own layer so the dynamic section can resolve
    const fullLayer = Layer.merge(registryLayer, s.layer!)

    const sections = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ExtensionRegistry
        return yield* reg.listPromptSections()
      }).pipe(Effect.provide(fullLayer)),
    )

    const section = sections.find((ps) => ps.id === "from-layer")
    expect(section?.content).toBe("hello from layer")
  })

  // ── Provides negative constraint (compile-time) ──

  test("dynamic promptSection without matching layer is a compile error", () => {
    const TestService = Context.Service<typeof TestService, { readonly value: string }>()("Test")

    // This should NOT compile — TestService is in R but no .layer() provides it.
    // @ts-expect-error — Type 'TestService' is not assignable to type 'never'
    extension("no-layer", ({ ext }) =>
      ext.promptSections({
        id: "bad",
        priority: 50,
        resolve: Effect.gen(function* () {
          const svc = yield* TestService
          return svc.value
        }),
      }),
    )
  })

  // ── Provider yields providers array ──

  test("provider() produces single-element providers array in setup", async () => {
    const ext = extension("provider-test", ({ ext }) =>
      ext.provider({ id: "test-provider", name: "Test", resolveModel: () => stubResolution }),
    )
    const s = await setup(ext)
    expect(s.providers).toHaveLength(1)
    expect(s.providers?.[0]?.id).toBe("test-provider")
  })

  // ── Empty builder produces empty setup ──

  test("bare builder produces empty setup", async () => {
    const ext = extension("empty", ({ ext }) => ext)
    const s = await setup(ext)
    expect(s.tools).toBeUndefined()
    expect(s.agents).toBeUndefined()
    expect(s.promptSections).toBeUndefined()
    expect(s.hooks).toBeUndefined()
    expect(s.layer).toBeUndefined()
    expect(s.providers).toBeUndefined()
    expect(s.jobs).toBeUndefined()
    expect(s.actor).toBeUndefined()
  })
})
