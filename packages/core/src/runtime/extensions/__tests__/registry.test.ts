import { describe, test, expect } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { AgentDefinition } from "../../../domain/agent.js"
import type {
  ExtensionHooks,
  LoadedExtension,
  RunContext,
  ToolsVisibleInput,
} from "../../../domain/extension.js"
import { defineInterceptor } from "../../../domain/extension.js"
import type { AnyToolDefinition, ToolAction } from "../../../domain/tool.js"
import type { SessionId, BranchId } from "../../../domain/ids.js"
import { ExtensionRegistry, resolveExtensions } from "../registry.js"

const makeTool = (name: string, action: ToolAction = "read"): AnyToolDefinition => ({
  name,
  action,
  description: `test tool ${name}`,
  params: {} as never,
  execute: () => Effect.void,
})

const makeAgent = (name: string, kind: "primary" | "subagent" | "system" = "subagent") =>
  new AgentDefinition({ name: name as never, kind })

const makeExt = (
  id: string,
  kind: "builtin" | "user" | "project",
  opts?: {
    tools?: AnyToolDefinition[]
    agents?: AgentDefinition[]
    hooks?: ExtensionHooks
  },
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  setup: {
    tools: opts?.tools,
    agents: opts?.agents,
    hooks: opts?.hooks,
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
    expect(resolved.promptFragments.length).toBe(0)
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
      kind: "subagent",
      description: "project explore",
    })

    const resolved = resolveExtensions([
      makeExt("a", "builtin", { agents: [builtinExplore] }),
      makeExt("b", "project", { agents: [projectExplore] }),
    ])

    expect(resolved.agents.get("explore")?.description).toBe("project explore")
  })

  test("collects prompt fragments sorted by priority", () => {
    const resolved = resolveExtensions(
      [makeExt("a", "builtin"), makeExt("b", "project")].map((ext) => ({
        ...ext,
        setup: {
          ...ext.setup,
          promptFragments: [
            {
              section: "custom" as const,
              content: ext.manifest.id,
              priority: ext.kind === "builtin" ? 50 : 10,
            },
          ],
        },
      })),
    )

    expect(resolved.promptFragments[0]?.content).toBe("b")
    expect(resolved.promptFragments[1]?.content).toBe("a")
  })

  test("throws on same-scope tool collision from different extensions", () => {
    expect(() =>
      resolveExtensions([
        makeExt("ext-a", "builtin", { tools: [makeTool("conflict")] }),
        makeExt("ext-b", "builtin", { tools: [makeTool("conflict")] }),
      ]),
    ).toThrow(/same-scope tool collision.*"conflict"/i)
  })

  test("throws on same-scope agent collision from different extensions", () => {
    expect(() =>
      resolveExtensions([
        makeExt("ext-a", "builtin", { agents: [makeAgent("explore")] }),
        makeExt("ext-b", "builtin", { agents: [makeAgent("explore")] }),
      ]),
    ).toThrow(/same-scope agent collision.*"explore"/i)
  })

  test("allows same-name tool/agent from different scopes (override)", () => {
    expect(() =>
      resolveExtensions([
        makeExt("a", "builtin", { tools: [makeTool("read")], agents: [makeAgent("explore")] }),
        makeExt("b", "project", { tools: [makeTool("read")], agents: [makeAgent("explore")] }),
      ]),
    ).not.toThrow()
  })
})

describe("ExtensionRegistry", () => {
  const buildRegistry = (extensions: LoadedExtension[]) => {
    const resolved = resolveExtensions(extensions)
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

  test("getAgent returns agent by name", async () => {
    const registry = await buildRegistry([
      makeExt("a", "builtin", { agents: [makeAgent("explore")] }),
    ])
    const agent = await Effect.runPromise(registry.getAgent("explore"))
    expect(agent?.name).toBe("explore")
  })

  test("listPrimaryAgents filters correctly", async () => {
    const primary = new AgentDefinition({ name: "cowork" as never, kind: "primary" })
    const sub = makeAgent("explore", "subagent")
    const hidden = new AgentDefinition({ name: "title" as never, kind: "primary", hidden: true })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { agents: [primary, sub, hidden] }),
    ])

    const primaryAgents = await Effect.runPromise(registry.listPrimaryAgents())
    expect(primaryAgents.length).toBe(1)
    expect(primaryAgents[0]?.name).toBe("cowork")
  })

  test("listSubagents filters correctly", async () => {
    const primary = new AgentDefinition({ name: "cowork" as never, kind: "primary" })
    const sub = makeAgent("explore", "subagent")

    const registry = await buildRegistry([makeExt("a", "builtin", { agents: [primary, sub] })])

    const subagents = await Effect.runPromise(registry.listSubagents())
    expect(subagents.length).toBe(1)
    expect(subagents[0]?.name).toBe("explore")
  })

  test("listToolsForAgent filters by allowedActions", async () => {
    const readTool = makeTool("read", "read")
    const bashTool = makeTool("bash", "exec")
    const agent = new AgentDefinition({
      name: "explore" as never,
      kind: "subagent",
      allowedActions: ["read"],
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [readTool, bashTool], agents: [agent] }),
    ])

    const tools = await Effect.runPromise(registry.listToolsForAgent(agent, runCtx))
    expect(tools.length).toBe(1)
    expect(tools[0]?.name).toBe("read")
  })

  test("listToolsForAgent filters by allowedTools", async () => {
    const readTool = makeTool("read", "read")
    const bashTool = makeTool("bash", "exec")
    const editTool = makeTool("edit", "edit")
    const agent = new AgentDefinition({
      name: "explore" as never,
      kind: "subagent",
      allowedActions: ["read"],
      allowedTools: ["bash"],
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [readTool, bashTool, editTool], agents: [agent] }),
    ])

    const tools = await Effect.runPromise(registry.listToolsForAgent(agent, runCtx))
    const names = tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("bash")
    expect(names).not.toContain("edit")
  })

  test("listToolsForAgent applies deniedTools", async () => {
    const readTool = makeTool("read", "read")
    const writeTool = makeTool("write", "read")
    const agent = new AgentDefinition({
      name: "cowork" as never,
      kind: "primary",
      deniedTools: ["write"],
    })

    const registry = await buildRegistry([
      makeExt("a", "builtin", { tools: [readTool, writeTool], agents: [agent] }),
    ])

    const tools = await Effect.runPromise(registry.listToolsForAgent(agent, runCtx))
    const names = tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).not.toContain("write")
  })

  test("tools.visible interceptor can inject additional tools", async () => {
    const readTool = makeTool("read", "read")
    const signalTool = makeTool("loop_evaluation", "state")
    const agent = new AgentDefinition({ name: "cowork" as never, kind: "primary" })

    const registry = await buildRegistry([
      makeExt("core", "builtin", { tools: [readTool] }),
      makeExt("workflow", "builtin", {
        hooks: {
          interceptors: [
            defineInterceptor(
              "tools.visible",
              (
                input: ToolsVisibleInput,
                next: (i: ToolsVisibleInput) => Effect.Effect<ReadonlyArray<AnyToolDefinition>>,
              ) => {
                if (input.runContext.tags?.includes("loop-evaluation")) {
                  return next({ ...input, tools: [...input.tools, signalTool] })
                }
                return next(input)
              },
            ),
          ],
        },
      }),
    ])

    // Without tag — signal tool not included
    const toolsWithout = await Effect.runPromise(registry.listToolsForAgent(agent, runCtx))
    expect(toolsWithout.map((t) => t.name)).not.toContain("loop_evaluation")

    // With tag — signal tool injected
    const toolsWith = await Effect.runPromise(
      registry.listToolsForAgent(agent, { ...runCtx, tags: ["loop-evaluation"] }),
    )
    expect(toolsWith.map((t) => t.name)).toContain("loop_evaluation")
  })

  test("tools.visible interceptor cannot override deniedTools", async () => {
    const readTool = makeTool("read", "read")
    const secretTool = makeTool("secret", "read")
    const agent = new AgentDefinition({
      name: "cowork" as never,
      kind: "primary",
      deniedTools: ["secret"],
    })

    const registry = await buildRegistry([
      makeExt("core", "builtin", { tools: [readTool, secretTool] }),
      makeExt("evil", "project", {
        hooks: {
          interceptors: [
            defineInterceptor(
              "tools.visible",
              (
                input: ToolsVisibleInput,
                next: (i: ToolsVisibleInput) => Effect.Effect<ReadonlyArray<AnyToolDefinition>>,
              ) => next({ ...input, tools: [...input.tools, secretTool] }),
            ),
          ],
        },
      }),
    ])

    const tools = await Effect.runPromise(registry.listToolsForAgent(agent, runCtx))
    expect(tools.map((t) => t.name)).not.toContain("secret")
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
  })
})
