import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { AgentDefinition } from "@gent/core/domain/agent"
import type { LoadedExtension, RunContext } from "@gent/core/domain/extension"
import type { ModelDriverContribution } from "@gent/core/domain/driver"
import type { AnyToolDefinition } from "@gent/core/domain/tool"
import type { PromptSectionInput } from "@gent/core/domain/prompt"
import { SessionId, BranchId } from "@gent/core/domain/ids"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { DriverRegistry } from "@gent/core/runtime/extensions/driver-registry"
import {
  agent as agentContribution,
  modelDriver as modelDriverContribution,
  promptSection as promptSectionContribution,
  tool as toolContribution,
} from "@gent/core/domain/contribution"

const makeTool = (name: string): AnyToolDefinition => ({
  name,
  description: `test tool ${name}`,
  params: {} as never,
  execute: () => Effect.void,
})

const makeAgent = (name: string, options?: ConstructorParameters<typeof AgentDefinition>[0]) =>
  new AgentDefinition({ name: name as never, ...options })

const makeProvider = (providerId: string, name?: string): ModelDriverContribution => ({
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
    modelDrivers?: ModelDriverContribution[]
    promptSections?: PromptSectionInput[]
  },
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  contributions: [
    ...(opts?.tools ?? []).map(toolContribution),
    ...(opts?.agents ?? []).map(agentContribution),
    ...(opts?.modelDrivers ?? []).map(modelDriverContribution),
    ...(opts?.promptSections ?? []).map(promptSectionContribution),
  ],
})

const runCtx: RunContext = {
  sessionId: SessionId.of("test-session"),
  branchId: BranchId.of("test-branch"),
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
      makeExt("b", "builtin", { tools: [makeTool("bash")] }),
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
      makeExt("a", "builtin", {
        modelDrivers: [makeProvider("anthropic"), makeProvider("openai")],
      }),
    ])
    expect(resolved.modelDrivers.size).toBe(2)
    expect(resolved.modelDrivers.has("anthropic")).toBe(true)
    expect(resolved.modelDrivers.has("openai")).toBe(true)
  })

  test("later scope wins for same-id provider", () => {
    const resolved = resolveExtensions([
      makeExt("a", "builtin", { modelDrivers: [makeProvider("anthropic", "Builtin Anthropic")] }),
      makeExt("b", "project", { modelDrivers: [makeProvider("anthropic", "Custom Anthropic")] }),
    ])
    expect(resolved.modelDrivers.get("anthropic")?.name).toBe("Custom Anthropic")
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
      makeExt("@gent/anthropic", "builtin", { modelDrivers: [makeProvider("anthropic")] }),
      makeExt("@gent/openai", "builtin", { modelDrivers: [makeProvider("openai")] }),
    ]
    const enabled = extensions.filter((ext) => !disabledSet.has(ext.manifest.id))
    const resolved = resolveExtensions(enabled)

    expect(resolved.modelDrivers.has("anthropic")).toBe(true)
    expect(resolved.modelDrivers.has("openai")).toBe(false)
  })

  test("multiple disabled extensions are all excluded", () => {
    const disabledSet = new Set(["@gent/task-tools", "@gent/agents", "@gent/openai"])
    const extensions = [
      makeExt("@gent/task-tools", "builtin", { tools: [makeTool("add_todo")] }),
      makeExt("@gent/agents", "builtin", {
        agents: [makeAgent("cowork", { model: "anthropic/claude-opus-4-6" as never })],
      }),
      makeExt("@gent/openai", "builtin", { modelDrivers: [makeProvider("openai")] }),
      makeExt("@gent/fs-tools", "builtin", { tools: [makeTool("read")] }),
    ]
    const enabled = extensions.filter((ext) => !disabledSet.has(ext.manifest.id))
    const resolved = resolveExtensions(enabled)

    expect(resolved.tools.size).toBe(1)
    expect(resolved.tools.has("read")).toBe(true)
    expect(resolved.agents.size).toBe(0)
    expect(resolved.modelDrivers.size).toBe(0)
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

  const buildDriverRegistry = (
    extensions: LoadedExtension[],
    failedExtensions: Parameters<typeof resolveExtensions>[1] = [],
  ) => {
    const resolved = resolveExtensions(extensions, failedExtensions)
    return ManagedRuntime.make(
      DriverRegistry.fromResolved({
        modelDrivers: resolved.modelDrivers,
        externalDrivers: resolved.externalDrivers,
      }),
    ).runPromise(
      Effect.gen(function* () {
        return yield* DriverRegistry
      }),
    )
  }

  test("registered tool is findable by name", async () => {
    const registry = await buildRegistry([makeExt("a", "builtin", { tools: [makeTool("read")] })])
    const tool = await Effect.runPromise(registry.getTool("read"))
    expect(tool?.name).toBe("read")
  })

  test("unregistered tool name returns undefined", async () => {
    const registry = await buildRegistry([])
    const tool = await Effect.runPromise(registry.getTool("nonexistent"))
    expect(tool).toBeUndefined()
  })

  test("lists all registered tools across extensions", async () => {
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

  test("registered agent is findable by name", async () => {
    const registry = await buildRegistry([
      makeExt("a", "builtin", { agents: [makeAgent("explore")] }),
    ])
    const agent = await Effect.runPromise(registry.getAgent("explore"))
    expect(agent?.name).toBe("explore")
  })

  test("lists all agents including override winners", async () => {
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

  test("resolveToolPolicy filters by allowedTools", async () => {
    const readTool = makeTool("read")
    const bashTool = makeTool("bash")
    const agent = new AgentDefinition({
      name: "explore" as never,
      allowedTools: ["read"],
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [readTool, bashTool], agents: [agent] }),
    ])

    const { tools } = await Effect.runPromise(registry.resolveToolPolicy(agent, runCtx, []))
    expect(tools.length).toBe(1)
    expect(tools[0]?.name).toBe("read")
  })

  test("resolveToolPolicy allowedTools restricts to exact set", async () => {
    const readTool = makeTool("read")
    const bashTool = makeTool("bash")
    const editTool = makeTool("edit")
    const agent = new AgentDefinition({
      name: "explore" as never,
      allowedTools: ["read", "bash"],
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
    const readTool = makeTool("read")
    const writeTool = makeTool("write")
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

  test("denied tools cannot be injected via projection", async () => {
    const readTool = makeTool("read")
    const secretTool = makeTool("secret")
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

  test("registered model driver is findable by ID", async () => {
    const registry = await buildDriverRegistry([
      makeExt("a", "builtin", { modelDrivers: [makeProvider("anthropic")] }),
    ])
    const provider = await Effect.runPromise(registry.getModel("anthropic"))
    expect(provider?.id).toBe("anthropic")
  })

  test("unregistered model driver ID returns undefined", async () => {
    const registry = await buildDriverRegistry([])
    const provider = await Effect.runPromise(registry.getModel("nonexistent"))
    expect(provider).toBeUndefined()
  })

  test("lists all registered model drivers", async () => {
    const registry = await buildDriverRegistry([
      makeExt("a", "builtin", {
        modelDrivers: [makeProvider("anthropic"), makeProvider("openai")],
      }),
    ])
    const providers = await Effect.runPromise(registry.listModels())
    expect(providers.length).toBe(2)
  })

  test("test layer starts with empty registry", async () => {
    const layer = Layer.merge(
      ExtensionRegistry.Test(),
      DriverRegistry.fromResolved({ modelDrivers: new Map(), externalDrivers: new Map() }),
    )
    const registries = await ManagedRuntime.make(layer).runPromise(
      Effect.gen(function* () {
        const ext = yield* ExtensionRegistry
        const driver = yield* DriverRegistry
        return { ext, driver }
      }),
    )

    const tools = await Effect.runPromise(registries.ext.listTools())
    expect(tools.length).toBe(0)

    const agents = await Effect.runPromise(registries.ext.listAgents())
    expect(agents.length).toBe(0)

    const providers = await Effect.runPromise(registries.driver.listModels())
    expect(providers.length).toBe(0)
  })

  test("static prompt sections are returned as-is", async () => {
    const registry = await buildRegistry([
      makeExt("@gent/test", "builtin", {
        promptSections: [{ id: "test", content: "Hello", priority: 50 }],
      }),
    ])
    const sections = await Effect.runPromise(registry.listPromptSections())
    expect(sections.length).toBe(1)
    expect(sections[0]?.id).toBe("test")
    expect(sections[0]?.content).toBe("Hello")
    expect(sections[0]?.priority).toBe(50)
  })

  test("dynamic prompt sections are resolved", async () => {
    const registry = await buildRegistry([
      makeExt("@gent/test", "builtin", {
        promptSections: [
          { id: "dynamic", priority: 80, resolve: Effect.succeed("Dynamic content") },
        ],
      }),
    ])
    const sections = await Effect.runPromise(registry.listPromptSections())
    expect(sections.length).toBe(1)
    expect(sections[0]?.id).toBe("dynamic")
    expect(sections[0]?.content).toBe("Dynamic content")
    expect(sections[0]?.priority).toBe(80)
  })

  test("mixed static and dynamic sections", async () => {
    const registry = await buildRegistry([
      makeExt("@gent/test", "builtin", {
        promptSections: [
          { id: "static", content: "Static", priority: 10 },
          { id: "dynamic", priority: 20, resolve: Effect.succeed("Resolved") },
        ],
      }),
    ])
    const sections = await Effect.runPromise(registry.listPromptSections())
    expect(sections.length).toBe(2)
    const ids = sections.map((s) => s.id)
    expect(ids).toContain("static")
    expect(ids).toContain("dynamic")
  })
})
