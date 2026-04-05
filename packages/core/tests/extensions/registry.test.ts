import { describe, test, expect } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { AgentDefinition } from "@gent/core/domain/agent"
import type {
  ExtensionHooks,
  LoadedExtension,
  ProviderContribution,
  RunContext,
} from "@gent/core/domain/extension"
import type { AnyToolDefinition, ToolAction } from "@gent/core/domain/tool"
import type { SessionId, BranchId } from "@gent/core/domain/ids"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"

const makeTool = (name: string, action: ToolAction = "read"): AnyToolDefinition => ({
  name,
  action,
  description: `test tool ${name}`,
  params: {} as never,
  execute: () => Effect.void,
})

const makeAgent = (name: string, options?: ConstructorParameters<typeof AgentDefinition>[0]) =>
  new AgentDefinition({ name: name as never, ...options })

const makeProvider = (providerId: string, name?: string): ProviderContribution => ({
  id: providerId,
  name: name ?? providerId,
  resolveModel: (modelName) => ({ modelId: `${providerId}/${modelName}` }),
})

const makeExt = (
  id: string,
  kind: "builtin" | "user" | "project",
  opts?: {
    tools?: AnyToolDefinition[]
    agents?: AgentDefinition[]
    hooks?: ExtensionHooks
    providers?: ProviderContribution[]
  },
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  setup: {
    tools: opts?.tools,
    agents: opts?.agents,
    hooks: opts?.hooks,
    providers: opts?.providers,
  },
})

const runCtx: RunContext = {
  sessionId: "test-session" as SessionId,
  branchId: "test-branch" as BranchId,
}

describe("resolveExtensions", () => {
  test("empty extensions produce empty maps", () => {
    const resolved = resolveExtensions([])
    expect(resolved.tools.size).toBe(0)
    expect(resolved.agents.size).toBe(0)
  })

  test("collects tools from multiple extensions", () => {
    const resolved = resolveExtensions([
      makeExt("a", "builtin", { tools: [makeTool("read"), makeTool("write")] }),
      makeExt("b", "builtin", { tools: [makeTool("bash", "exec")] }),
    ])
    expect(resolved.tools.size).toBe(3)
    expect(resolved.tools.has("read")).toBe(true)
    expect(resolved.tools.has("write")).toBe(true)
    expect(resolved.tools.has("bash")).toBe(true)
  })

  test("later scope wins for same-name tool", () => {
    const builtinRead = makeTool("read")
    const projectRead = { ...makeTool("read"), description: "project override" }

    const resolved = resolveExtensions([
      makeExt("a", "builtin", { tools: [builtinRead] }),
      makeExt("b", "project", { tools: [projectRead] }),
    ])

    expect(resolved.tools.get("read")?.description).toBe("project override")
  })

  test("later scope wins for same-name agent", () => {
    const builtinExplore = makeAgent("explore")
    const projectExplore = new AgentDefinition({
      name: "explore" as never,
      description: "project explore",
    })

    const resolved = resolveExtensions([
      makeExt("a", "builtin", { agents: [builtinExplore] }),
      makeExt("b", "project", { agents: [projectExplore] }),
    ])

    expect(resolved.agents.get("explore")?.description).toBe("project explore")
  })

  test("allows same-name tool/agent from different scopes (override)", () => {
    expect(() =>
      resolveExtensions([
        makeExt("a", "builtin", { tools: [makeTool("read")], agents: [makeAgent("explore")] }),
        makeExt("b", "project", { tools: [makeTool("read")], agents: [makeAgent("explore")] }),
      ]),
    ).not.toThrow()
  })

  test("collects providers from extensions", () => {
    const resolved = resolveExtensions([
      makeExt("a", "builtin", { providers: [makeProvider("anthropic"), makeProvider("openai")] }),
    ])
    expect(resolved.providers.size).toBe(2)
    expect(resolved.providers.has("anthropic")).toBe(true)
    expect(resolved.providers.has("openai")).toBe(true)
  })

  test("later scope wins for same-id provider", () => {
    const resolved = resolveExtensions([
      makeExt("a", "builtin", { providers: [makeProvider("anthropic", "Builtin Anthropic")] }),
      makeExt("b", "project", { providers: [makeProvider("anthropic", "Custom Anthropic")] }),
    ])
    expect(resolved.providers.get("anthropic")?.name).toBe("Custom Anthropic")
  })

  test("merges scheduled job failures into extension statuses", () => {
    const resolved = resolveExtensions(
      [makeExt("@gent/memory", "builtin")],
      [],
      new Map([["@gent/memory", [{ jobId: "reflect", error: "launchd registration failed" }]]]),
    )

    expect(resolved.extensionStatuses).toEqual([
      {
        manifest: { id: "@gent/memory" },
        kind: "builtin",
        sourcePath: "/test/@gent/memory",
        status: "active",
        scheduledJobFailures: [{ jobId: "reflect", error: "launchd registration failed" }],
      },
    ])
  })

  test("surfaces provided failed extensions without recomputing validation", () => {
    const resolved = resolveExtensions(
      [makeExt("healthy", "builtin", { tools: [makeTool("read")] })],
      [
        {
          manifest: { id: "broken" },
          kind: "builtin",
          sourcePath: "builtin",
          phase: "validation",
          error: "duplicate tool read",
        },
      ],
    )

    expect(resolved.extensions.map((ext) => ext.manifest.id)).toEqual(["healthy"])
    expect(resolved.failedExtensions).toEqual([
      {
        manifest: { id: "broken" },
        kind: "builtin",
        sourcePath: "builtin",
        phase: "validation",
        error: "duplicate tool read",
      },
    ])
    expect(resolved.extensionStatuses).toEqual([
      {
        manifest: { id: "healthy" },
        kind: "builtin",
        sourcePath: "/test/healthy",
        status: "active",
      },
      {
        manifest: { id: "broken" },
        kind: "builtin",
        sourcePath: "builtin",
        phase: "validation",
        error: "duplicate tool read",
        status: "failed",
      },
    ])
  })
})

describe("resolveExtensions — disabled filtering", () => {
  test("disabled extensions are excluded when filtered before resolve", () => {
    const disabledSet = new Set(["@gent/task-tools"])
    const extensions = [
      makeExt("@gent/fs-tools", "builtin", { tools: [makeTool("read")] }),
      makeExt("@gent/task-tools", "builtin", { tools: [makeTool("add_todo")] }),
    ]
    const enabled = extensions.filter((ext) => !disabledSet.has(ext.manifest.id))
    const resolved = resolveExtensions(enabled)

    expect(resolved.tools.has("read")).toBe(true)
    expect(resolved.tools.has("add_todo")).toBe(false)
    expect(resolved.extensions.length).toBe(1)
  })

  test("disabled extensions agents are excluded", () => {
    const disabledSet = new Set(["@gent/agents"])
    const extensions = [
      makeExt("@gent/agents", "builtin", {
        agents: [makeAgent("cowork", { model: "anthropic/claude-opus-4-6" as never })],
      }),
      makeExt("@gent/fs-tools", "builtin", { tools: [makeTool("read")] }),
    ]
    const enabled = extensions.filter((ext) => !disabledSet.has(ext.manifest.id))
    const resolved = resolveExtensions(enabled)

    expect(resolved.agents.size).toBe(0)
    expect(resolved.tools.has("read")).toBe(true)
  })

  test("disabled extensions providers are excluded", () => {
    const disabledSet = new Set(["@gent/openai"])
    const extensions = [
      makeExt("@gent/anthropic", "builtin", { providers: [makeProvider("anthropic")] }),
      makeExt("@gent/openai", "builtin", { providers: [makeProvider("openai")] }),
    ]
    const enabled = extensions.filter((ext) => !disabledSet.has(ext.manifest.id))
    const resolved = resolveExtensions(enabled)

    expect(resolved.providers.has("anthropic")).toBe(true)
    expect(resolved.providers.has("openai")).toBe(false)
  })

  test("multiple disabled extensions are all excluded", () => {
    const disabledSet = new Set(["@gent/task-tools", "@gent/agents", "@gent/openai"])
    const extensions = [
      makeExt("@gent/task-tools", "builtin", { tools: [makeTool("add_todo")] }),
      makeExt("@gent/agents", "builtin", {
        agents: [makeAgent("cowork", { model: "anthropic/claude-opus-4-6" as never })],
      }),
      makeExt("@gent/openai", "builtin", { providers: [makeProvider("openai")] }),
      makeExt("@gent/fs-tools", "builtin", { tools: [makeTool("read")] }),
    ]
    const enabled = extensions.filter((ext) => !disabledSet.has(ext.manifest.id))
    const resolved = resolveExtensions(enabled)

    expect(resolved.tools.size).toBe(1)
    expect(resolved.tools.has("read")).toBe(true)
    expect(resolved.agents.size).toBe(0)
    expect(resolved.providers.size).toBe(0)
  })
})

describe("ExtensionRegistry", () => {
  const buildRegistry = (
    extensions: LoadedExtension[],
    failedExtensions: Parameters<typeof resolveExtensions>[1] = [],
  ) => {
    const resolved = resolveExtensions(extensions, failedExtensions)
    return ManagedRuntime.make(ExtensionRegistry.fromResolved(resolved)).runPromise(
      Effect.gen(function* () {
        return yield* ExtensionRegistry
      }),
    )
  }

  test("getTool returns tool by name", async () => {
    const registry = await buildRegistry([makeExt("a", "builtin", { tools: [makeTool("read")] })])
    const tool = await Effect.runPromise(registry.getTool("read"))
    expect(tool?.name).toBe("read")
  })

  test("getTool returns undefined for missing tool", async () => {
    const registry = await buildRegistry([])
    const tool = await Effect.runPromise(registry.getTool("nonexistent"))
    expect(tool).toBeUndefined()
  })

  test("listTools returns all tools", async () => {
    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [makeTool("read"), makeTool("write")] }),
    ])
    const tools = await Effect.runPromise(registry.listTools())
    expect(tools.length).toBe(2)
  })

  test("extension diagnostics expose both active and failed activation state", async () => {
    const registry = await buildRegistry(
      [makeExt("healthy", "builtin", { tools: [makeTool("read")] })],
      [
        {
          manifest: { id: "broken" },
          kind: "builtin",
          sourcePath: "builtin",
          phase: "startup",
          error: "startup boom",
        },
      ],
    )

    const tools = await Effect.runPromise(registry.listTools())
    const failed = await Effect.runPromise(registry.listFailedExtensions())
    const statuses = await Effect.runPromise(registry.listExtensionStatuses())

    expect(tools.map((tool) => tool.name)).toEqual(["read"])
    expect(failed).toEqual([
      {
        manifest: { id: "broken" },
        kind: "builtin",
        sourcePath: "builtin",
        phase: "startup",
        error: "startup boom",
      },
    ])
    expect(statuses).toEqual([
      {
        manifest: { id: "healthy" },
        kind: "builtin",
        sourcePath: "/test/healthy",
        status: "active",
      },
      {
        manifest: { id: "broken" },
        kind: "builtin",
        sourcePath: "builtin",
        status: "failed",
        phase: "startup",
        error: "startup boom",
      },
    ])
  })

  test("getAgent returns agent by name", async () => {
    const registry = await buildRegistry([
      makeExt("a", "builtin", { agents: [makeAgent("explore")] }),
    ])
    const agent = await Effect.runPromise(registry.getAgent("explore"))
    expect(agent?.name).toBe("explore")
  })

  test("listAgents returns all registered agents", async () => {
    const cowork = new AgentDefinition({
      name: "cowork" as never,
      model: "anthropic/claude-opus-4-6" as never,
    })
    const explore = makeAgent("explore")
    const deepwork = new AgentDefinition({
      name: "deepwork" as never,
      model: "openai/gpt-5.4" as never,
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { agents: [cowork, explore, deepwork] }),
    ])

    const agents = await Effect.runPromise(registry.listAgents())
    expect(agents.length).toBe(3)
    expect(agents.map((a) => a.name)).toContain("cowork")
    expect(agents.map((a) => a.name)).toContain("explore")
    expect(agents.map((a) => a.name)).toContain("deepwork")
  })

  test("resolveToolPolicy filters by allowedActions", async () => {
    const readTool = makeTool("read", "read")
    const bashTool = makeTool("bash", "exec")
    const agent = new AgentDefinition({
      name: "explore" as never,
      allowedActions: ["read"],
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [readTool, bashTool], agents: [agent] }),
    ])

    const { tools } = await Effect.runPromise(registry.resolveToolPolicy(agent, runCtx, []))
    expect(tools.length).toBe(1)
    expect(tools[0]?.name).toBe("read")
  })

  test("resolveToolPolicy filters by allowedTools", async () => {
    const readTool = makeTool("read", "read")
    const bashTool = makeTool("bash", "exec")
    const editTool = makeTool("edit", "edit")
    const agent = new AgentDefinition({
      name: "explore" as never,
      allowedActions: ["read"],
      allowedTools: ["bash"],
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [readTool, bashTool, editTool], agents: [agent] }),
    ])

    const { tools } = await Effect.runPromise(registry.resolveToolPolicy(agent, runCtx, []))
    const names = tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("bash")
    expect(names).not.toContain("edit")
  })

  test("resolveToolPolicy applies deniedTools", async () => {
    const readTool = makeTool("read", "read")
    const writeTool = makeTool("write", "read")
    const agent = new AgentDefinition({
      name: "cowork" as never,
      deniedTools: ["write"],
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [readTool, writeTool], agents: [agent] }),
    ])

    const { tools } = await Effect.runPromise(registry.resolveToolPolicy(agent, runCtx, []))
    const names = tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).not.toContain("write")
  })

  test("tagInjections inject tools when tag matches", async () => {
    const readTool = makeTool("read", "read")
    const signalTool = makeTool("test_signal", "state")
    const agent = new AgentDefinition({ name: "cowork" as never })

    const registry = await buildRegistry([
      makeExt("core", "builtin", { tools: [readTool] }),
      {
        ...makeExt("workflow", "builtin"),
        setup: { tagInjections: [{ tag: "test-signal", tools: [signalTool] }] },
      },
    ])

    // Without tag — signal tool not included
    const { tools: toolsWithout } = await Effect.runPromise(
      registry.resolveToolPolicy(agent, runCtx, []),
    )
    expect(toolsWithout.map((t) => t.name)).not.toContain("test_signal")

    // With tag — signal tool injected
    const { tools: toolsWith } = await Effect.runPromise(
      registry.resolveToolPolicy(agent, { ...runCtx, tags: ["test-signal"] }, []),
    )
    expect(toolsWith.map((t) => t.name)).toContain("test_signal")
  })

  test("denied tools cannot be injected via tag or projection", async () => {
    const readTool = makeTool("read", "read")
    const secretTool = makeTool("secret", "read")
    const agent = new AgentDefinition({
      name: "cowork" as never,
      deniedTools: ["secret"],
    })

    const registry = await buildRegistry([
      makeExt("core", "builtin", { tools: [readTool, secretTool] }),
    ])

    // Try to force-include via projection
    const { tools } = await Effect.runPromise(
      registry.resolveToolPolicy(agent, runCtx, [{ toolPolicy: { include: ["secret"] } }]),
    )
    expect(tools.map((t) => t.name)).not.toContain("secret")
  })

  test("getProvider returns provider by id", async () => {
    const registry = await buildRegistry([
      makeExt("a", "builtin", { providers: [makeProvider("anthropic")] }),
    ])
    const provider = await Effect.runPromise(registry.getProvider("anthropic"))
    expect(provider?.id).toBe("anthropic")
  })

  test("getProvider returns undefined for missing provider", async () => {
    const registry = await buildRegistry([])
    const provider = await Effect.runPromise(registry.getProvider("nonexistent"))
    expect(provider).toBeUndefined()
  })

  test("listProviders returns all providers", async () => {
    const registry = await buildRegistry([
      makeExt("a", "builtin", {
        providers: [makeProvider("anthropic"), makeProvider("openai")],
      }),
    ])
    const providers = await Effect.runPromise(registry.listProviders())
    expect(providers.length).toBe(2)
  })

  test("Test layer provides empty registry", async () => {
    const registry = await ManagedRuntime.make(ExtensionRegistry.Test()).runPromise(
      Effect.gen(function* () {
        return yield* ExtensionRegistry
      }),
    )

    const tools = await Effect.runPromise(registry.listTools())
    expect(tools.length).toBe(0)

    const agents = await Effect.runPromise(registry.listAgents())
    expect(agents.length).toBe(0)

    const providers = await Effect.runPromise(registry.listProviders())
    expect(providers.length).toBe(0)
  })
})
