import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { compileToolPolicy } from "@gent/core/runtime/extensions/registry"
import { AgentDefinition } from "@gent/core/domain/agent"
import { defineTool } from "@gent/core/domain/tool"
import { SessionId, BranchId } from "@gent/core/domain/ids"

describe("compileToolPolicy", () => {
  const makeTool = (name: string) =>
    defineTool({
      name,
      concurrency: "parallel",
      description: name,
      params: Schema.Struct({}),
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

  const emptyCtx = { sessionId: SessionId.of("s"), branchId: BranchId.of("b") }

  const names = (tools: ReadonlyArray<{ name: string }>) => tools.map((t) => t.name).sort()

  test("no allow-list → all tools", () => {
    const agent = new AgentDefinition({ name: "cowork" })
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, [])
    expect(names(tools)).toEqual(names(allTools))
  })

  test("allowedTools filters by name", () => {
    const agent = new AgentDefinition({
      name: "cowork",
      allowedTools: ["read", "grep", "glob", "search_skills"],
    })
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, [])
    expect(names(tools)).toEqual(["glob", "grep", "read", "search_skills"])
  })

  test("allowedTools restricts to exact set", () => {
    const agent = new AgentDefinition({
      name: "cowork",
      allowedTools: ["bash", "read"],
    })
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, [])
    expect(names(tools)).toEqual(["bash", "read"])
  })

  test("allowedTools: [] means no tools", () => {
    const agent = new AgentDefinition({ name: "cowork", allowedTools: [] })
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, [])
    expect(tools).toEqual([])
  })

  test("deniedTools removes from result", () => {
    const agent = new AgentDefinition({
      name: "cowork",
      allowedTools: ["read", "grep", "glob", "search_skills"],
      deniedTools: ["grep"],
    })
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, [])
    expect(names(tools)).toEqual(["glob", "read", "search_skills"])
  })

  test("allowedTools with network tools", () => {
    const agent = new AgentDefinition({
      name: "cowork",
      allowedTools: ["read", "grep", "glob", "search_skills", "webfetch", "websearch"],
    })
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, [])
    expect(names(tools)).toEqual(["glob", "grep", "read", "search_skills", "webfetch", "websearch"])
  })

  test("extension projection include adds tools", () => {
    const agent = new AgentDefinition({
      name: "cowork",
      allowedTools: ["read", "grep", "glob", "search_skills"],
    })
    const projections = [{ toolPolicy: { include: ["bash"] } }]
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, projections)
    expect(names(tools)).toContain("bash")
    expect(names(tools)).toContain("read")
  })

  test("extension projection exclude removes tools", () => {
    const agent = new AgentDefinition({ name: "cowork" })
    const projections = [{ toolPolicy: { exclude: ["bash", "write"] } }]
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, projections)
    expect(names(tools)).not.toContain("bash")
    expect(names(tools)).not.toContain("write")
  })

  test("extension projection overrideSet replaces tool list", () => {
    const agent = new AgentDefinition({ name: "cowork" })
    const projections = [{ toolPolicy: { overrideSet: ["read", "grep"] } }]
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, projections)
    expect(names(tools)).toEqual(["grep", "read"])
  })

  test("denied tools cannot be re-added by extension projection", () => {
    const agent = new AgentDefinition({
      name: "cowork",
      deniedTools: ["bash"],
    })
    const projections = [{ toolPolicy: { include: ["bash"] } }]
    const { tools } = compileToolPolicy(allTools, agent, emptyCtx, projections)
    expect(names(tools)).not.toContain("bash")
  })

  test("extension prompt sections collected", () => {
    const agent = new AgentDefinition({ name: "cowork" })
    const projections = [
      { promptSections: [{ id: "ext-a", content: "Section A", priority: 90 }] },
      { promptSections: [{ id: "ext-b", content: "Section B", priority: 91 }] },
    ]
    const { promptSections } = compileToolPolicy(allTools, agent, emptyCtx, projections)
    expect(promptSections).toHaveLength(2)
    expect(promptSections.map((s) => s.id)).toEqual(["ext-a", "ext-b"])
  })

  test("interactive tools filtered when context.interactive is false", () => {
    const interactiveTool = defineTool({
      name: "ask_user",
      interactive: true,
      concurrency: "parallel",
      description: "ask_user",
      params: Schema.Struct({}),
      execute: () => Effect.succeed(null),
    })
    const nonInteractiveTool = makeTool("read")
    const agent = new AgentDefinition({ name: "cowork" })
    const ctx = { ...emptyCtx, interactive: false as const }
    const { tools } = compileToolPolicy([interactiveTool, nonInteractiveTool], agent, ctx, [])
    expect(names(tools)).toEqual(["read"])
    expect(names(tools)).not.toContain("ask_user")
  })

  test("interactive tools kept when context.interactive is not false", () => {
    const interactiveTool = defineTool({
      name: "ask_user",
      interactive: true,
      concurrency: "parallel",
      description: "ask_user",
      params: Schema.Struct({}),
      execute: () => Effect.succeed(null),
    })
    const agent = new AgentDefinition({ name: "cowork" })
    const { tools } = compileToolPolicy([interactiveTool], agent, emptyCtx, [])
    expect(names(tools)).toContain("ask_user")
  })
})
