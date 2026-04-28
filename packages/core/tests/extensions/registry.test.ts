import { describe, test, expect, it } from "effect-bun-test"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { AgentDefinition, AgentName } from "@gent/core/domain/agent"
import type { LoadedExtension, RunContext } from "../../src/domain/extension.js"
import type { ModelDriverContribution } from "@gent/core/domain/driver"
import { BranchId, ExtensionId, SessionId } from "@gent/core/domain/ids"
import {
  action,
  request,
  tool,
  ToolNeeds,
  type ActionToken,
  type RequestToken,
  type ToolToken,
} from "@gent/core/extensions/api"
import {
  ExtensionRegistry,
  listSlashCommands,
  resolveExtensions,
} from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import type { PromptSection } from "@gent/core/domain/prompt"
// Test helper: build a no-op model Capability directly. Post-B11.5d the
// `tool({...})` factory rejects the legacy `{ name, params, execute }`
// shape, so test fixtures here construct the lowered Capability literal.
const makeTool = (name: string): ToolToken =>
  tool({
    id: name,
    description: `test tool ${name}`,
    params: Schema.Struct({}),
    execute: () => Effect.void,
  })
const makeAgent = (
  name: string,
  options?: Partial<ConstructorParameters<typeof AgentDefinition>[0]>,
) => AgentDefinition.make({ name: AgentName.make(name), ...options })
const makeProvider = (providerId: string, name?: string): ModelDriverContribution => ({
  id: providerId,
  name: name ?? providerId,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: empty layer
  resolveModel: (_modelName) => ({ layer: Layer.empty as never }),
})
// C7: static prompt sections live on `Capability.prompt`. Build a synthetic
// no-op model capability to carry each section through the pipeline.
const promptSectionAsToolContribution = (section: PromptSection): ToolToken =>
  tool({
    id: `section-carrier-${section.id}`,
    description: `carrier for ${section.id}`,
    params: Schema.Struct({}),
    prompt: section,
    execute: () => Effect.void,
  })
const makeExt = (
  id: string,
  scope: "builtin" | "user" | "project",
  opts?: {
    tools?: ToolToken[]
    commands?: ActionToken[]
    rpc?: RequestToken[]
    agents?: AgentDefinition[]
    modelDrivers?: ModelDriverContribution[]
    promptSections?: PromptSection[]
  },
): LoadedExtension => {
  const tools = [
    ...(opts?.tools ?? []),
    ...(opts?.promptSections ?? []).map(promptSectionAsToolContribution),
  ]
  return {
    manifest: { id: ExtensionId.make(id) },
    scope,
    sourcePath: `/test/${id}`,
    contributions: {
      ...(tools.length > 0 ? { tools } : {}),
      ...(opts?.commands !== undefined ? { commands: opts.commands } : {}),
      ...(opts?.rpc !== undefined ? { rpc: opts.rpc } : {}),
      agents: opts?.agents,
      modelDrivers: opts?.modelDrivers,
    },
  }
}
const makeCommand = (id: string, options?: Partial<Parameters<typeof action>[0]>): ActionToken =>
  action({
    id,
    name: id,
    description: options?.description ?? `${id} command`,
    surface: options?.surface ?? "slash",
    input: options?.input ?? Schema.String,
    output: options?.output ?? Schema.Void,
    execute: () => Effect.void,
    ...options,
  })
const makeRequest = (
  id: string,
  options?: {
    readonly intent?: "read" | "write"
    readonly extensionId?: ExtensionId
  },
): RequestToken => {
  const intent = options?.intent ?? "read"
  const extensionId = options?.extensionId ?? ExtensionId.make("@test/rpc")
  if (intent === "read") {
    return request({
      id,
      extensionId,
      intent: "read",
      input: Schema.Unknown,
      output: Schema.Unknown,
      execute: () => Effect.succeed(undefined),
    })
  }
  return request({
    id,
    extensionId,
    intent: "write",
    input: Schema.Unknown,
    output: Schema.Unknown,
    execute: () => Effect.succeed(undefined),
  })
}
const runCtx: RunContext = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
}
describe("resolveExtensions", () => {
  test("empty extensions produce empty maps", () => {
    const resolved = resolveExtensions([])
    expect(resolved.modelCapabilities.size).toBe(0)
    expect(resolved.agents.size).toBe(0)
  })
  test("collects tools from multiple extensions", () => {
    const resolved = resolveExtensions([
      makeExt("a", "builtin", { tools: [makeTool("read"), makeTool("write")] }),
      makeExt("b", "builtin", { tools: [makeTool("bash")] }),
    ])
    expect(resolved.modelCapabilities.size).toBe(3)
    expect(resolved.modelCapabilities.has("read")).toBe(true)
    expect(resolved.modelCapabilities.has("write")).toBe(true)
    expect(resolved.modelCapabilities.has("bash")).toBe(true)
  })
  test("later scope wins for same-name tool", () => {
    const builtinRead = makeTool("read")
    const projectRead = { ...makeTool("read"), description: "project override" }
    const resolved = resolveExtensions([
      makeExt("a", "builtin", { tools: [builtinRead] }),
      makeExt("b", "project", { tools: [projectRead] }),
    ])
    expect(resolved.modelCapabilities.get("read")?.description).toBe("project override")
  })
  test("later scope wins for same-name agent", () => {
    const builtinExplore = makeAgent("explore")
    const projectExplore = AgentDefinition.make({
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
      new Map([
        [
          ExtensionId.make("@gent/memory"),
          [{ jobId: "reflect", error: "launchd registration failed" }],
        ],
      ]),
    )
    expect(resolved.extensionStatuses).toEqual([
      {
        manifest: { id: ExtensionId.make("@gent/memory") },
        scope: "builtin",
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
          manifest: { id: ExtensionId.make("broken") },
          scope: "builtin",
          sourcePath: "builtin",
          phase: "validation",
          error: "duplicate tool read",
        },
      ],
    )
    expect(resolved.extensions.map((ext) => ext.manifest.id)).toEqual([ExtensionId.make("healthy")])
    expect(resolved.failedExtensions).toEqual([
      {
        manifest: { id: ExtensionId.make("broken") },
        scope: "builtin",
        sourcePath: "builtin",
        phase: "validation",
        error: "duplicate tool read",
      },
    ])
    expect(resolved.extensionStatuses).toEqual([
      {
        manifest: { id: ExtensionId.make("healthy") },
        scope: "builtin",
        sourcePath: "/test/healthy",
        status: "active",
      },
      {
        manifest: { id: ExtensionId.make("broken") },
        scope: "builtin",
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
    expect(resolved.modelCapabilities.has("read")).toBe(true)
    expect(resolved.modelCapabilities.has("add_todo")).toBe(false)
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
    expect(resolved.modelCapabilities.has("read")).toBe(true)
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
    expect(resolved.modelCapabilities.size).toBe(1)
    expect(resolved.modelCapabilities.has("read")).toBe(true)
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
  it.live("registered model capability is findable by name", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.promise(() =>
        buildRegistry([makeExt("a", "builtin", { tools: [makeTool("read")] })]),
      )
      const tool = yield* registry.getModelCapability("read")
      expect(String(tool?.id)).toBe("read")
    }),
  )
  it.live("unregistered model capability name returns undefined", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.promise(() => buildRegistry([]))
      const tool = yield* registry.getModelCapability("nonexistent")
      expect(tool).toBeUndefined()
    }),
  )
  it.live("lists all registered tools across extensions", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.promise(() =>
        buildRegistry([makeExt("a", "builtin", { tools: [makeTool("read"), makeTool("write")] })]),
      )
      const tools = yield* registry.listModelCapabilities()
      expect(tools.length).toBe(2)
    }),
  )
  it.live("extension diagnostics expose both active and failed activation state", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.promise(() =>
        buildRegistry(
          [makeExt("healthy", "builtin", { tools: [makeTool("read")] })],
          [
            {
              manifest: { id: ExtensionId.make("broken") },
              scope: "builtin",
              sourcePath: "builtin",
              phase: "startup",
              error: "startup boom",
            },
          ],
        ),
      )
      const tools = yield* registry.listModelCapabilities()
      const failed = yield* registry.listFailedExtensions()
      const statuses = yield* registry.listExtensionStatuses()
      expect(tools.map((tool) => String(tool.id))).toEqual(["read"])
      expect(failed).toEqual([
        {
          manifest: { id: ExtensionId.make("broken") },
          scope: "builtin",
          sourcePath: "builtin",
          phase: "startup",
          error: "startup boom",
        },
      ])
      expect(statuses).toEqual([
        {
          manifest: { id: ExtensionId.make("healthy") },
          scope: "builtin",
          sourcePath: "/test/healthy",
          status: "active",
        },
        {
          manifest: { id: ExtensionId.make("broken") },
          scope: "builtin",
          sourcePath: "builtin",
          status: "failed",
          phase: "startup",
          error: "startup boom",
        },
      ])
    }),
  )
  it.live("registered agent is findable by name", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.promise(() =>
        buildRegistry([makeExt("a", "builtin", { agents: [makeAgent("explore")] })]),
      )
      const agent = yield* registry.getAgent(AgentName.make("explore"))
      expect(agent?.name).toBe(AgentName.make("explore"))
    }),
  )
  it.live("lists all agents including override winners", () =>
    Effect.gen(function* () {
      const cowork = AgentDefinition.make({
        name: "cowork" as never,
        model: "anthropic/claude-opus-4-6" as never,
      })
      const explore = makeAgent("explore")
      const deepwork = AgentDefinition.make({
        name: "deepwork" as never,
        model: "openai/gpt-5.4" as never,
      })
      const registry = yield* Effect.promise(() =>
        buildRegistry([makeExt("a", "builtin", { agents: [cowork, explore, deepwork] })]),
      )
      const agents = yield* registry.listAgents()
      expect(agents.length).toBe(3)
      expect(agents.map((a) => a.name)).toContain(AgentName.make("cowork"))
      expect(agents.map((a) => a.name)).toContain(AgentName.make("explore"))
      expect(agents.map((a) => a.name)).toContain(AgentName.make("deepwork"))
    }),
  )
  it.live("allowedTools narrows the resolved tool set", () =>
    Effect.gen(function* () {
      const readTool = makeTool("read")
      const bashTool = makeTool("bash")
      const agent = AgentDefinition.make({
        name: "explore" as never,
        allowedTools: ["read"],
      })
      const registry = yield* Effect.promise(() =>
        buildRegistry([makeExt("a", "builtin", { tools: [readTool, bashTool], agents: [agent] })]),
      )
      const { tools } = yield* registry.resolveToolPolicy(agent, runCtx, [])
      expect(tools.length).toBe(1)
      expect(String(tools[0]?.id)).toBe("read")
    }),
  )
  it.live("allowedTools restricts the resolved set to exactly the listed names", () =>
    Effect.gen(function* () {
      const readTool = makeTool("read")
      const bashTool = makeTool("bash")
      const editTool = makeTool("edit")
      const agent = AgentDefinition.make({
        name: "explore" as never,
        allowedTools: ["read", "bash"],
      })
      const registry = yield* Effect.promise(() =>
        buildRegistry([
          makeExt("a", "builtin", { tools: [readTool, bashTool, editTool], agents: [agent] }),
        ]),
      )
      const { tools } = yield* registry.resolveToolPolicy(agent, runCtx, [])
      const names = tools.map((t) => String(t.id))
      expect(names).toContain("read")
      expect(names).toContain("bash")
      expect(names).not.toContain("edit")
    }),
  )
  it.live("deniedTools removes matching entries from the resolved set", () =>
    Effect.gen(function* () {
      const readTool = makeTool("read")
      const writeTool = makeTool("write")
      const agent = AgentDefinition.make({
        name: "cowork" as never,
        deniedTools: ["write"],
      })
      const registry = yield* Effect.promise(() =>
        buildRegistry([makeExt("a", "builtin", { tools: [readTool, writeTool], agents: [agent] })]),
      )
      const { tools } = yield* registry.resolveToolPolicy(agent, runCtx, [])
      const names = tools.map((t) => String(t.id))
      expect(names).toContain("read")
      expect(names).not.toContain("write")
    }),
  )
  it.live("denied tools cannot be injected via projection", () =>
    Effect.gen(function* () {
      const readTool = makeTool("read")
      const secretTool = makeTool("secret")
      const agent = AgentDefinition.make({
        name: "cowork" as never,
        deniedTools: ["secret"],
      })
      const registry = yield* Effect.promise(() =>
        buildRegistry([makeExt("core", "builtin", { tools: [readTool, secretTool] })]),
      )
      // Try to force-include via projection
      const { tools } = yield* registry.resolveToolPolicy(agent, runCtx, [
        { toolPolicy: { include: ["secret"] } },
      ])
      expect(tools.map((t) => String(t.id))).not.toContain("secret")
    }),
  )
  it.live("registered model driver is findable by ID", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.promise(() =>
        buildDriverRegistry([
          makeExt("a", "builtin", { modelDrivers: [makeProvider("anthropic")] }),
        ]),
      )
      const provider = yield* registry.getModel("anthropic")
      expect(provider?.id).toBe("anthropic")
    }),
  )
  it.live("unregistered model driver ID returns undefined", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.promise(() => buildDriverRegistry([]))
      const provider = yield* registry.getModel("nonexistent")
      expect(provider).toBeUndefined()
    }),
  )
  it.live("lists all registered model drivers", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.promise(() =>
        buildDriverRegistry([
          makeExt("a", "builtin", {
            modelDrivers: [makeProvider("anthropic"), makeProvider("openai")],
          }),
        ]),
      )
      const providers = yield* registry.listModels()
      expect(providers.length).toBe(2)
    }),
  )
  it.live("test layer starts with empty registry", () =>
    Effect.gen(function* () {
      const layer = Layer.merge(
        ExtensionRegistry.Test(),
        DriverRegistry.fromResolved({ modelDrivers: new Map(), externalDrivers: new Map() }),
      )
      const registries = yield* Effect.promise(() =>
        ManagedRuntime.make(layer).runPromise(
          Effect.gen(function* () {
            const ext = yield* ExtensionRegistry
            const driver = yield* DriverRegistry
            return { ext, driver }
          }),
        ),
      )
      const tools = yield* registries.ext.listModelCapabilities()
      expect(tools.length).toBe(0)
      const agents = yield* registries.ext.listAgents()
      expect(agents.length).toBe(0)
      const providers = yield* registries.driver.listModels()
      expect(providers.length).toBe(0)
    }),
  )
  it.live("static prompt sections are returned as-is", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.promise(() =>
        buildRegistry([
          makeExt("@gent/test", "builtin", {
            promptSections: [{ id: "test", content: "Hello", priority: 50 }],
          }),
        ]),
      )
      const sections = yield* registry.listPromptSections()
      expect(sections.length).toBe(1)
      expect(sections[0]?.id).toBe("test")
      expect(sections[0]?.content).toBe("Hello")
      expect(sections[0]?.priority).toBe(50)
    }),
  )
  // C7 dropped: dynamic prompt sections were `DynamicPromptSection.resolve`.
  // After C7 dynamic content lives on `Projection.prompt(value)` and is
  // assembled per-turn by ExtensionReactions, not by `listPromptSections`
  // (which only sees static sections from `Capability.prompt`).
})
// Slash-command discovery — identity-first scope shadowing followed by
// bucket/surface authorization.
describe("resolveExtensions — slash command discovery", () => {
  test("slash action appears in commands", () => {
    const cap = makeCommand("echo", {
      description: "Echo the args back.",
      promptSnippet: "Echo the args back.",
    })
    const resolved = resolveExtensions([makeExt("@test/echo", "builtin", { commands: [cap] })])
    const commands = listSlashCommands(resolved.extensions)
    expect(commands.map((c) => c.name)).toContain("echo")
    expect(commands.find((c) => c.name === "echo")?.description).toBe("Echo the args back.")
  })
  test("project palette command shadows builtin slash command", () => {
    const builtinCap = makeCommand("act")
    const builtin = makeExt("@test/shadow", "builtin", { commands: [builtinCap] })
    const projectCap = makeCommand("act", { surface: "palette" })
    const project = makeExt("@test/shadow", "project", { commands: [projectCap] })
    const resolved = resolveExtensions([builtin, project])
    const commands = listSlashCommands(resolved.extensions)
    expect(commands.map((c) => c.name)).not.toContain("act")
  })
  test("palette-only command does not appear in the slash-backed command list", () => {
    const cap = makeCommand("palette-only", { surface: "palette" })
    const resolved = resolveExtensions([makeExt("@test/palette", "builtin", { commands: [cap] })])
    const commands = listSlashCommands(resolved.extensions)
    expect(commands.map((c) => c.name)).not.toContain("palette-only")
  })
  // ── Model capability surface ────────────────────────────────────────
  test("tool appears as a model capability", () => {
    const cap = tool({
      id: "echo",
      description: "Echo input back as output.",
      params: Schema.String,
      execute: () => Effect.succeed(undefined),
    })
    const resolved = resolveExtensions([makeExt("@test/echo", "builtin", { tools: [cap] })])
    expect(resolved.modelCapabilities.has("echo")).toBe(true)
    expect(resolved.modelCapabilities.get("echo")?.description).toBe("Echo input back as output.")
  })
  test("project rpc shadows builtin tool", () => {
    const builtin = makeExt("@test/shadow", "builtin", { tools: [makeTool("act")] })
    const projectCap = makeRequest("act", { intent: "write" })
    const project = makeExt("@test/shadow", "project", { rpc: [projectCap] })
    const resolved = resolveExtensions([builtin, project])
    expect(resolved.modelCapabilities.has("act")).toBe(false)
  })
  test("project command shadows builtin tool", () => {
    const builtin = makeExt("@test/shadow", "builtin", { tools: [makeTool("look")] })
    const projectCap = makeCommand("look")
    const project = makeExt("@test/shadow", "project", { commands: [projectCap] })
    const resolved = resolveExtensions([builtin, project])
    expect(resolved.modelCapabilities.has("look")).toBe(false)
  })
  test("project tool overrides builtin tool", () => {
    const builtin = makeExt("@test/shadow", "builtin", { tools: [makeTool("run")] })
    const projectCap = tool({
      id: "run",
      description: "project run override",
      params: Schema.Unknown,
      execute: () => Effect.succeed(undefined),
    })
    const project = makeExt("@test/shadow", "project", { tools: [projectCap] })
    const resolved = resolveExtensions([builtin, project])
    expect(resolved.modelCapabilities.has("run")).toBe(true)
    expect(resolved.modelCapabilities.get("run")?.description).toBe("project run override")
  })
  test("model capability preserves all tool metadata fields", () => {
    const cap = tool({
      id: "rich",
      description: "rich tool",
      params: Schema.Unknown,
      needs: [ToolNeeds.write("fs"), ToolNeeds.read("network")],
      promptSnippet: "Snippet here.",
      promptGuidelines: ["use carefully", "log result"],
      interactive: true,
      execute: () => Effect.succeed(undefined),
    })
    const resolved = resolveExtensions([makeExt("@test/rich", "builtin", { tools: [cap] })])
    const resolvedTool = resolved.modelCapabilities.get("rich")
    expect(resolvedTool).toBeDefined()
    expect(resolvedTool?.description).toBe("rich tool")
    expect(resolvedTool?.needs).toEqual([ToolNeeds.write("fs"), ToolNeeds.read("network")])
    expect(resolvedTool?.promptSnippet).toBe("Snippet here.")
    expect(resolvedTool?.promptGuidelines).toEqual(["use carefully", "log result"])
    expect(resolvedTool?.interactive).toBe(true)
  })
  test("rpc does not appear as a tool", () => {
    const cap = makeRequest("rpc-only")
    const resolved = resolveExtensions([makeExt("@test/rpc", "builtin", { rpc: [cap] })])
    expect(resolved.modelCapabilities.has("rpc-only")).toBe(false)
  })
})
