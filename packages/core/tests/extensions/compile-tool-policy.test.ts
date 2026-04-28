import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { tool, type ToolToken } from "@gent/core/extensions/api"
import { compileToolPolicy } from "../../src/runtime/extensions/registry"
import { AgentDefinition, AgentName } from "@gent/core/domain/agent"
import { BranchId, SessionId } from "@gent/core/domain/ids"

describe("compileToolPolicy", () => {
  const makeTool = (name: string): ToolToken =>
    tool({
      id: name,
      description: name,
      params: Schema.Struct({}),
      execute: () => Effect.succeed(null),
    })

  const makeInteractiveTool = (name: string): ToolToken =>
    tool({
      id: name,
      description: name,
      params: Schema.Struct({}),
      interactive: true,
      execute: () => Effect.succeed(null),
    })

  const allTools = [
    makeTool("read"),
    makeTool("grep"),
    makeTool("glob"),
    makeTool("write"),
    makeTool("edit"),
    makeTool("bash"),
    makeTool("delegate"),
    makeTool("ask_user"),
    makeTool("webfetch"),
    makeTool("websearch"),
    makeTool("search_skills"),
  ]

  const emptyCtx = { sessionId: SessionId.make("s"), branchId: BranchId.make("b") }

  const names = (tools: ReadonlyArray<{ id: string }>) => tools.map((t) => String(t.id)).sort()

  test("no allow-list → all tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, [])
    expect(names(tools)).toEqual(names(allTools))
  })

  test("allowedTools restricts to exact set", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("cowork"),
      allowedTools: ["bash", "read"],
    })
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, [])
    expect(names(tools)).toEqual(["bash", "read"])
  })

  test("allowedTools: [] means no tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork"), allowedTools: [] })
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, [])
    expect(tools).toEqual([])
  })

  test("extension projection exclude removes tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const projections = [{ toolPolicy: { exclude: ["bash", "write"] } }]
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, projections)
    expect(names(tools)).not.toContain("bash")
    expect(names(tools)).not.toContain("write")
  })

  test("extension projection include adds tools when they are allowed", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("cowork"),
      allowedTools: ["read", "grep", "glob", "search_skills"],
    })
    const projections = [{ toolPolicy: { include: ["bash"] } }]
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, projections)
    expect(names(tools)).toContain("bash")
    expect(names(tools)).toContain("read")
  })

  test("extension projection overrideSet replaces tool list", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const projections = [{ toolPolicy: { overrideSet: ["read", "grep"] } }]
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, projections)
    expect(names(tools)).toEqual(["grep", "read"])
  })

  test("denied tools cannot be re-added by extension projection include", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("cowork"),
      deniedTools: ["bash"],
    })
    const projections = [{ toolPolicy: { include: ["bash"] } }]
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, projections)
    expect(names(tools)).not.toContain("bash")
  })

  test("extension prompt sections collected", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const projections = [
      { promptSections: [{ id: "ext-a", content: "Section A", priority: 90 }] },
      { promptSections: [{ id: "ext-b", content: "Section B", priority: 91 }] },
    ]
    const { promptSections } = compileToolPolicy(allTools, agent, emptyCtx, projections)
    expect(promptSections).toHaveLength(2)
    expect(promptSections.map((s) => s.id)).toEqual(["ext-a", "ext-b"])
  })

  test("interactive tools filtered when context.interactive is false", () => {
    const interactiveTool = makeInteractiveTool("ask_user")
    const nonInteractiveTool = makeTool("read")
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const ctx = { ...emptyCtx, interactive: false as const }
    const { tools } = compileToolPolicy([interactiveTool, nonInteractiveTool], agent, ctx, [])
    expect(names(tools)).toEqual(["read"])
    expect(names(tools)).not.toContain("ask_user")
  })

  test("interactive tools remain available when the run is interactive", () => {
    const interactiveTool = makeInteractiveTool("ask_user")
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const { tools } = compileToolPolicy([interactiveTool], agent, emptyCtx, [])
    expect(names(tools)).toContain("ask_user")
  })
})
