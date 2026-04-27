import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { AgentDefinition } from "@gent/core/domain/agent"
import type { LoadedExtension, RunContext } from "../../src/domain/extension.js"
import type { ModelDriverContribution } from "@gent/core/domain/driver"
import type { AnyCapabilityContribution } from "@gent/core/domain/capability"
import { SessionId, BranchId } from "@gent/core/domain/ids"
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
const makeTool = (name: string): AnyCapabilityContribution => ({
  id: name,
  description: `test tool ${name}`,
  audiences: ["model"],
  intent: "write",
  input: Schema.Unknown,
  output: Schema.Unknown,
  effect: () => Effect.void,
})

const makeAgent = (name: string, options?: ConstructorParameters<typeof AgentDefinition>[0]) =>
  AgentDefinition.make({ name: name as never, ...options })

const makeProvider = (providerId: string, name?: string): ModelDriverContribution => ({
  id: providerId,
  name: name ?? providerId,
  resolveModel: (modelName) => ({ modelId: `${providerId}/${modelName}` }),
})

// C7: static prompt sections live on `Capability.prompt`. Build a synthetic
// no-op model capability to carry each section through the pipeline.
const promptSectionAsToolContribution = (section: PromptSection): AnyCapabilityContribution => ({
  id: `section-carrier-${section.id}`,
  description: `carrier for ${section.id}`,
  audiences: ["model"],
  intent: "write",
  input: Schema.Struct({}),
  output: Schema.Unknown,
  prompt: section,
  effect: () => Effect.void,
})

const makeExt = (
  id: string,
  scope: "builtin" | "user" | "project",
  opts?: {
    tools?: AnyCapabilityContribution[]
    agents?: AgentDefinition[]
    modelDrivers?: ModelDriverContribution[]
    promptSections?: PromptSection[]
    capabilities?: AnyCapabilityContribution[]
  },
): LoadedExtension => ({
  manifest: { id },
  scope,
  sourcePath: `/test/${id}`,
  contributions: {
    capabilities: [
      ...(opts?.tools ?? []),
      ...(opts?.promptSections ?? []).map(promptSectionAsToolContribution),
      ...(opts?.capabilities ?? []),
    ],
    agents: opts?.agents,
    modelDrivers: opts?.modelDrivers,
  },
})

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

  // W10-3a regression: the typed `tools:` bucket is a separate field on
  // `ExtensionContributions`. Resolved capability winners must include
  // entries from BOTH `tools:` (new path) and `capabilities:` (legacy
  // shim path until W10-5). Bypass `makeExt` to write straight into the
  // contributions bag — the helper currently routes everything through
  // `capabilities:`.
  test("resolves model capabilities from both `tools:` and `capabilities:` buckets", () => {
    const fromToolsBucket: LoadedExtension = {
      manifest: { id: "a-tools-bucket" },
      scope: "builtin",
      sourcePath: "/test/a-tools-bucket",
      contributions: { tools: [makeTool("read")] },
    }
    const fromCapabilitiesBucket: LoadedExtension = {
      manifest: { id: "b-capabilities-bucket" },
      scope: "builtin",
      sourcePath: "/test/b-capabilities-bucket",
      contributions: { capabilities: [makeTool("write")] },
    }
    const resolved = resolveExtensions([fromToolsBucket, fromCapabilitiesBucket])
    expect(resolved.modelCapabilities.has("read")).toBe(true)
    expect(resolved.modelCapabilities.has("write")).toBe(true)
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
      new Map([["@gent/memory", [{ jobId: "reflect", error: "launchd registration failed" }]]]),
    )

    expect(resolved.extensionStatuses).toEqual([
      {
        manifest: { id: "@gent/memory" },
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
          manifest: { id: "broken" },
          scope: "builtin",
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
        scope: "builtin",
        sourcePath: "builtin",
        phase: "validation",
        error: "duplicate tool read",
      },
    ])
    expect(resolved.extensionStatuses).toEqual([
      {
        manifest: { id: "healthy" },
        scope: "builtin",
        sourcePath: "/test/healthy",
        status: "active",
      },
      {
        manifest: { id: "broken" },
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

  test("registered model capability is findable by name", async () => {
    const registry = await buildRegistry([makeExt("a", "builtin", { tools: [makeTool("read")] })])
    const tool = await Effect.runPromise(registry.getModelCapability("read"))
    expect(tool?.id).toBe("read")
  })

  test("unregistered model capability name returns undefined", async () => {
    const registry = await buildRegistry([])
    const tool = await Effect.runPromise(registry.getModelCapability("nonexistent"))
    expect(tool).toBeUndefined()
  })

  test("lists all registered tools across extensions", async () => {
    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [makeTool("read"), makeTool("write")] }),
    ])
    const tools = await Effect.runPromise(registry.listModelCapabilities())
    expect(tools.length).toBe(2)
  })

  test("extension diagnostics expose both active and failed activation state", async () => {
    const registry = await buildRegistry(
      [makeExt("healthy", "builtin", { tools: [makeTool("read")] })],
      [
        {
          manifest: { id: "broken" },
          scope: "builtin",
          sourcePath: "builtin",
          phase: "startup",
          error: "startup boom",
        },
      ],
    )

    const tools = await Effect.runPromise(registry.listModelCapabilities())
    const failed = await Effect.runPromise(registry.listFailedExtensions())
    const statuses = await Effect.runPromise(registry.listExtensionStatuses())

    expect(tools.map((tool) => tool.id)).toEqual(["read"])
    expect(failed).toEqual([
      {
        manifest: { id: "broken" },
        scope: "builtin",
        sourcePath: "builtin",
        phase: "startup",
        error: "startup boom",
      },
    ])
    expect(statuses).toEqual([
      {
        manifest: { id: "healthy" },
        scope: "builtin",
        sourcePath: "/test/healthy",
        status: "active",
      },
      {
        manifest: { id: "broken" },
        scope: "builtin",
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
    const cowork = AgentDefinition.make({
      name: "cowork" as never,
      model: "anthropic/claude-opus-4-6" as never,
    })
    const explore = makeAgent("explore")
    const deepwork = AgentDefinition.make({
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

  test("allowedTools narrows the resolved tool set", async () => {
    const readTool = makeTool("read")
    const bashTool = makeTool("bash")
    const agent = AgentDefinition.make({
      name: "explore" as never,
      allowedTools: ["read"],
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [readTool, bashTool], agents: [agent] }),
    ])

    const { tools } = await Effect.runPromise(registry.resolveToolPolicy(agent, runCtx, []))
    expect(tools.length).toBe(1)
    expect(tools[0]?.id).toBe("read")
  })

  test("allowedTools restricts the resolved set to exactly the listed names", async () => {
    const readTool = makeTool("read")
    const bashTool = makeTool("bash")
    const editTool = makeTool("edit")
    const agent = AgentDefinition.make({
      name: "explore" as never,
      allowedTools: ["read", "bash"],
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [readTool, bashTool, editTool], agents: [agent] }),
    ])

    const { tools } = await Effect.runPromise(registry.resolveToolPolicy(agent, runCtx, []))
    const names = tools.map((t) => t.id)
    expect(names).toContain("read")
    expect(names).toContain("bash")
    expect(names).not.toContain("edit")
  })

  test("deniedTools removes matching entries from the resolved set", async () => {
    const readTool = makeTool("read")
    const writeTool = makeTool("write")
    const agent = AgentDefinition.make({
      name: "cowork" as never,
      deniedTools: ["write"],
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [readTool, writeTool], agents: [agent] }),
    ])

    const { tools } = await Effect.runPromise(registry.resolveToolPolicy(agent, runCtx, []))
    const names = tools.map((t) => t.id)
    expect(names).toContain("read")
    expect(names).not.toContain("write")
  })

  test("denied tools cannot be injected via projection", async () => {
    const readTool = makeTool("read")
    const secretTool = makeTool("secret")
    const agent = AgentDefinition.make({
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
    expect(tools.map((t) => t.id)).not.toContain("secret")
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

    const tools = await Effect.runPromise(registries.ext.listModelCapabilities())
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

  // C7 dropped: dynamic prompt sections were `DynamicPromptSection.resolve`.
  // After C7 dynamic content lives on `Projection.prompt(value)` and is
  // assembled per-turn by ProjectionRegistry, not by `listPromptSections`
  // (which only sees static sections from `Capability.prompt`).
})

// Slash-command discovery — identity-first scope shadowing followed by
// audience/intent authorization. These lock the C4.3 scenarios after
// command contributions were collapsed into capabilities.
describe("resolveExtensions — slash command discovery (C4.3)", () => {
  test('Capability(audiences:["human-slash"], intent:"write") appears in commands', () => {
    const cap: AnyCapabilityContribution = {
      id: "echo",
      audiences: ["human-slash"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      promptSnippet: "Echo the args back.",
      effect: () => Effect.void,
    }
    const resolved = resolveExtensions([makeExt("@test/echo", "builtin", { capabilities: [cap] })])
    const commands = listSlashCommands(resolved.extensions)
    expect(commands.map((c) => c.name)).toContain("echo")
    expect(commands.find((c) => c.name === "echo")?.description).toBe("Echo the args back.")
  })

  // W10-3c regression: the typed `commands:` bucket is a separate field on
  // `ExtensionContributions`. `listSlashCommands` must include entries from
  // BOTH `commands:` (new path) and `capabilities:` (legacy shim path until
  // W10-5). Bypass `makeExt` to write straight into the contributions bag —
  // the helper currently routes everything through `capabilities:`.
  test("listSlashCommands reads from both `commands:` and `capabilities:` buckets", () => {
    const fromCommandsBucket: AnyCapabilityContribution = {
      id: "from-commands",
      audiences: ["human-slash"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const fromLegacyBucket: AnyCapabilityContribution = {
      id: "from-legacy",
      audiences: ["human-slash"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const a: LoadedExtension = {
      manifest: { id: "@test/cmd-bucket" },
      scope: "builtin",
      sourcePath: "/test/cmd-bucket",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test crafts a token-shaped value to bypass the ActionToken brand
      contributions: { commands: [fromCommandsBucket as never] },
    }
    const b: LoadedExtension = {
      manifest: { id: "@test/legacy-bucket" },
      scope: "builtin",
      sourcePath: "/test/legacy-bucket",
      contributions: { capabilities: [fromLegacyBucket] },
    }
    const resolved = resolveExtensions([a, b])
    const commands = listSlashCommands(resolved.extensions)
    expect(commands.map((c) => c.name)).toContain("from-commands")
    expect(commands.map((c) => c.name)).toContain("from-legacy")
  })

  test("project capability narrowing audience to non-slash SHADOWS builtin slash command", () => {
    // Builtin exposes a slash command via human-slash capability.
    const builtinCap: AnyCapabilityContribution = {
      id: "act",
      audiences: ["human-slash"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const builtin = makeExt("@test/shadow", "builtin", { capabilities: [builtinCap] })
    // Project overrides the same name with a capability that explicitly
    // narrows audiences to palette-only — must shadow + remove from slash list,
    // NOT fall through to the builtin command.
    const projectCap: AnyCapabilityContribution = {
      id: "act",
      audiences: ["human-palette"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const project = makeExt("@test/shadow", "project", { capabilities: [projectCap] })

    const resolved = resolveExtensions([builtin, project])
    const commands = listSlashCommands(resolved.extensions)
    expect(commands.map((c) => c.name)).not.toContain("act")
  })

  test("palette-only capability does not appear in the slash-backed command list", () => {
    const cap: AnyCapabilityContribution = {
      id: "palette-only",
      audiences: ["human-palette"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const resolved = resolveExtensions([
      makeExt("@test/palette", "builtin", { capabilities: [cap] }),
    ])
    const commands = listSlashCommands(resolved.extensions)
    expect(commands.map((c) => c.name)).not.toContain("palette-only")
  })

  test('project capability with audiences:["transport-public"] SHADOWS builtin slash command', () => {
    const builtinCap: AnyCapabilityContribution = {
      id: "act",
      audiences: ["human-slash"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const builtin = makeExt("@test/shadow", "builtin", { capabilities: [builtinCap] })
    const projectCap: AnyCapabilityContribution = {
      id: "act",
      audiences: ["transport-public"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const project = makeExt("@test/shadow", "project", { capabilities: [projectCap] })

    const resolved = resolveExtensions([builtin, project])
    const commands = listSlashCommands(resolved.extensions)
    expect(commands.map((c) => c.name)).not.toContain("act")
  })

  test('project capability with intent:"read" SHADOWS builtin slash command', () => {
    const builtinCap: AnyCapabilityContribution = {
      id: "look",
      audiences: ["human-slash"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const builtin = makeExt("@test/shadow", "builtin", { capabilities: [builtinCap] })
    const projectCap: AnyCapabilityContribution = {
      id: "look",
      audiences: ["human-slash"],
      intent: "read",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const project = makeExt("@test/shadow", "project", { capabilities: [projectCap] })

    const resolved = resolveExtensions([builtin, project])
    // project shadows builtin; intent: "read" — read capabilities ARE allowed as commands
    // (the filter is audiences:["human-slash"], not intent:"write")
    const commands = listSlashCommands(resolved.extensions)
    expect(commands.map((c) => c.name)).toContain("look")
  })

  test("model-only capability SHADOWS builtin slash command", () => {
    const builtinCap: AnyCapabilityContribution = {
      id: "run",
      audiences: ["human-slash"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const builtin = makeExt("@test/shadow", "builtin", { capabilities: [builtinCap] })
    const projectCap: AnyCapabilityContribution = {
      id: "run",
      audiences: ["model"],
      intent: "write",
      input: Schema.String,
      output: Schema.Void,
      effect: () => Effect.void,
    }
    const project = makeExt("@test/shadow", "project", { capabilities: [projectCap] })

    const resolved = resolveExtensions([builtin, project])
    const commands = listSlashCommands(resolved.extensions)
    expect(commands.map((c) => c.name)).not.toContain("run")
  })

  // ── Model capability surface ────────────────────────────────────────

  test('Capability(audiences:["model"]) appears as a model capability', () => {
    const cap: AnyCapabilityContribution = {
      id: "echo",
      description: "Echo input back as output.",
      audiences: ["model"],
      intent: "write",
      input: Schema.String,
      output: Schema.Unknown,
      effect: () => Effect.succeed(undefined),
    }
    const resolved = resolveExtensions([makeExt("@test/echo", "builtin", { capabilities: [cap] })])
    expect(resolved.modelCapabilities.has("echo")).toBe(true)
    expect(resolved.modelCapabilities.get("echo")?.description).toBe("Echo input back as output.")
  })

  test('project capability with audiences:["agent-protocol"] SHADOWS builtin tool', () => {
    const builtin = makeExt("@test/shadow", "builtin", { tools: [makeTool("act")] })
    const projectCap: AnyCapabilityContribution = {
      id: "act",
      audiences: ["agent-protocol"],
      intent: "write",
      input: Schema.Unknown,
      output: Schema.Unknown,
      effect: () => Effect.succeed(undefined),
    }
    const project = makeExt("@test/shadow", "project", { capabilities: [projectCap] })

    const resolved = resolveExtensions([builtin, project])
    expect(resolved.modelCapabilities.has("act")).toBe(false)
  })

  test('project capability with audiences:["transport-public"] SHADOWS builtin tool', () => {
    const builtin = makeExt("@test/shadow", "builtin", { tools: [makeTool("look")] })
    const projectCap: AnyCapabilityContribution = {
      id: "look",
      audiences: ["transport-public"],
      intent: "read",
      input: Schema.Unknown,
      output: Schema.Unknown,
      effect: () => Effect.succeed(undefined),
    }
    const project = makeExt("@test/shadow", "project", { capabilities: [projectCap] })

    const resolved = resolveExtensions([builtin, project])
    expect(resolved.modelCapabilities.has("look")).toBe(false)
  })

  test("project capability with audiences including model OVERRIDES builtin tool", () => {
    const builtin = makeExt("@test/shadow", "builtin", { tools: [makeTool("run")] })
    const projectCap: AnyCapabilityContribution = {
      id: "run",
      description: "project run override",
      audiences: ["model"],
      intent: "write",
      input: Schema.Unknown,
      output: Schema.Unknown,
      effect: () => Effect.succeed(undefined),
    }
    const project = makeExt("@test/shadow", "project", { capabilities: [projectCap] })

    const resolved = resolveExtensions([builtin, project])
    expect(resolved.modelCapabilities.has("run")).toBe(true)
    expect(resolved.modelCapabilities.get("run")?.description).toBe("project run override")
  })

  test("model capability preserves all ModelAudienceFields", () => {
    const cap: AnyCapabilityContribution = {
      id: "rich",
      description: "rich tool",
      audiences: ["model"],
      intent: "write",
      input: Schema.Unknown,
      output: Schema.Unknown,
      resources: ["fs:/tmp", "net:443"],
      idempotent: true,
      promptSnippet: "Snippet here.",
      promptGuidelines: ["use carefully", "log result"],
      interactive: true,
      effect: () => Effect.succeed(undefined),
    }
    const resolved = resolveExtensions([makeExt("@test/rich", "builtin", { capabilities: [cap] })])
    const tool = resolved.modelCapabilities.get("rich")
    expect(tool).toBeDefined()
    expect(tool?.description).toBe("rich tool")
    expect(tool?.resources).toEqual(["fs:/tmp", "net:443"])
    expect(tool?.idempotent).toBe(true)
    expect(tool?.promptSnippet).toBe("Snippet here.")
    expect(tool?.promptGuidelines).toEqual(["use carefully", "log result"])
    expect(tool?.interactive).toBe(true)
  })

  test("non-model capability does NOT appear as a tool", () => {
    const cap: AnyCapabilityContribution = {
      id: "rpc-only",
      audiences: ["agent-protocol"],
      intent: "read",
      input: Schema.Unknown,
      output: Schema.Unknown,
      effect: () => Effect.succeed(undefined),
    }
    const resolved = resolveExtensions([makeExt("@test/rpc", "builtin", { capabilities: [cap] })])
    expect(resolved.modelCapabilities.has("rpc-only")).toBe(false)
  })
})
