import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import {
  buildSystemPrompt,
  buildBasePromptSections,
  compileSystemPrompt,
  sectionPatternFor,
  withSectionMarkers,
} from "@gent/core-internal/domain/prompt"
import { buildTurnPrompt } from "../../src/runtime/agent/agent-loop.utils"
import { AgentDefinition, AgentName } from "@gent/core-internal/domain/agent"
import { tool, type ToolCapability } from "@gent/core/extensions/api"

describe("system prompt composition", () => {
  const base = {
    cwd: "/home/user/project",
    platform: "linux",
    isGitRepo: true,
    date: "2026-01-01",
  }

  test("includes identity as a general purpose agent that uses code", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain("You are Gent, a general purpose agent that uses code to solve tasks.")
  })

  test("includes work section with cell and delegation guidance", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain("# Work")
    expect(result).toContain("The cell is your persistent control environment.")
    expect(result).toContain("A child inherits your agent and model")
  })

  test("includes environment section", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain("Working directory: /home/user/project")
    expect(result).toContain("Platform: linux")
    expect(result).toContain("Git repository: yes")
  })

  test("includes shell when provided", () => {
    const result = buildSystemPrompt({ ...base, shell: "/bin/zsh" })
    expect(result).toContain("Shell: /bin/zsh")
  })

  test("defaults shell to unknown when not provided", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain("Shell: unknown")
  })

  test("includes OS version when provided", () => {
    const result = buildSystemPrompt({ ...base, osVersion: "24.6.0" })
    expect(result).toContain("Platform: linux (24.6.0)")
  })

  test("omits OS version parenthetical when not provided", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain("Platform: linux\n")
    expect(result).not.toContain("Platform: linux (")
  })

  test("isGitRepo false → 'no'", () => {
    const result = buildSystemPrompt({ ...base, isGitRepo: false })
    expect(result).toContain("Git repository: no")
  })

  test("includes custom instructions when provided", () => {
    const result = buildSystemPrompt({
      ...base,
      customInstructions: "Always use TypeScript strict mode",
    })
    expect(result).toContain("# Project Instructions")
    expect(result).toContain("Always use TypeScript strict mode")
  })

  test("omits custom instructions when empty", () => {
    const result = buildSystemPrompt({ ...base, customInstructions: "" })
    expect(result).not.toContain("# Project Instructions")
  })

  test("omits custom instructions when undefined", () => {
    const result = buildSystemPrompt(base)
    expect(result).not.toContain("# Project Instructions")
  })

  test("includes date in ISO format", () => {
    const result = buildSystemPrompt(base)
    expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/)
  })
})

describe("base prompt sections", () => {
  const base = {
    cwd: "/test",
    platform: "darwin",
    isGitRepo: false,
    date: "2026-01-01",
  }

  test("produces identity, work, communication, boundaries, and environment sections", () => {
    const sections = buildBasePromptSections(base)
    const ids = sections.map((s) => s.id)
    expect(ids).toEqual(["identity", "work", "communication", "boundaries", "environment"])
  })

  test("appends project-instructions section when custom instructions are present", () => {
    const sections = buildBasePromptSections({ ...base, customInstructions: "Use Bun." })
    const ids = sections.map((s) => s.id)
    expect(ids.at(-1)).toBe("project-instructions")
  })

  test("lower priority sections appear first in compiled output", () => {
    const result = compileSystemPrompt([
      { id: "b", content: "second", priority: 20 },
      { id: "a", content: "first", priority: 10 },
    ])
    expect(result).toBe("first\n\nsecond")
  })
})

describe("section marker parsing", () => {
  // Counsel  — `PromptSection.id` is unconstrained; the helpers must
  // tolerate ids carrying regex metacharacters without leaking them
  // into the compiled pattern.
  test("round-trips a normal id", () => {
    const wrapped = withSectionMarkers("tool-list", "## Available Tools\n\n- echo")
    const match = wrapped.match(sectionPatternFor("tool-list"))
    expect(match?.[1]).toBe("## Available Tools\n\n- echo")
  })

  test("escapes regex metacharacters in the id", () => {
    // A section author choosing this id would, with naive escaping,
    // turn `.` into 'any char' and `+` into 'one or more', which would
    // both over-match and risk catastrophic-backtracking input. Full
    // escape protects the helper from that surface.
    const id = "tool.list+v2"
    const wrapped = withSectionMarkers(id, "ALPHA")
    const pattern = sectionPatternFor(id)
    const match = wrapped.match(pattern)
    expect(match?.[1]).toBe("ALPHA")
    // A confusable id (different chars where the metacharacters would
    // have matched) does not match the strict pattern.
    const wrappedSibling = withSectionMarkers("toolXlistXv2", "BRAVO")
    expect(pattern.test(wrappedSibling)).toBe(false)
  })

  test("does not match across two sibling sections", () => {
    // The lazy `[\s\S]*?` between markers must not span from one
    // section's start to a later section's end.
    const a = withSectionMarkers("tool-list", "ALPHA")
    const b = withSectionMarkers("tool-list", "BRAVO")
    const compiled = `${a}\n\n${b}`
    const matches = compiled.match(new RegExp(sectionPatternFor("tool-list").source, "g"))
    expect(matches?.length).toBe(2)
  })
})

describe("turn prompt composition", () => {
  const makeTool = (
    id: string,
    overrides: {
      readonly description?: string
      readonly promptSnippet?: string
      readonly promptGuidelines?: ReadonlyArray<string>
    } = {},
  ): ToolCapability =>
    tool({
      id,
      description: overrides.description ?? id,
      params: Schema.Struct({}),
      output: Schema.Void,
      execute: () => Effect.void,
      promptSnippet: overrides.promptSnippet,
      promptGuidelines: overrides.promptGuidelines,
    })

  const agent = AgentDefinition.make({
    name: AgentName.make("test-agent"),
    systemPromptAddendum: "Be helpful.",
  })

  const baseSections = [{ id: "base", content: "You are a test agent.", priority: 0 }]

  test("includes tool snippets when tools have promptSnippet", () => {
    const tools = [
      makeTool("read", { description: "Read files", promptSnippet: "Read file contents" }),
      makeTool("bash", { description: "Run commands", promptSnippet: "Execute shell commands" }),
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).toContain("## Available Tools")
    expect(result).toContain("**read**: Read file contents")
    expect(result).toContain("**bash**: Execute shell commands")
  })

  test("includes tool guidelines when tools have promptGuidelines", () => {
    const tools = [
      makeTool("read", {
        description: "Read files",
        promptGuidelines: ["Use instead of bash cat"],
      }),
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).toContain("## Tool Guidelines")
    expect(result).toContain("Use instead of bash cat")
  })

  test("duplicate guidelines appear only once", () => {
    const tools = [
      makeTool("read", { description: "Read", promptGuidelines: ["Shared guideline"] }),
      makeTool("grep", { description: "Grep", promptGuidelines: ["Shared guideline"] }),
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    const count = result.split("Shared guideline").length - 1
    expect(count).toBe(1)
  })

  test("includes agent addendum", () => {
    const result = buildTurnPrompt(baseSections, agent, [])
    expect(result).toContain("## Agent: test-agent")
    expect(result).toContain("Be helpful.")
  })

  test("omits tool sections when no tools have metadata", () => {
    const tools = [makeTool("plain", { description: "No metadata" })]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).not.toContain("## Available Tools")
    expect(result).not.toContain("## Tool Guidelines")
  })

  test("prefer-dedicated-tools guideline names only active tools", () => {
    const tools = [
      makeTool("bash", { description: "Run" }),
      makeTool("grep", { description: "Search" }),
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).toContain("Prefer grep over bash")
    expect(result).not.toContain("glob")
  })

  test("names all active dedicated tools in the guideline", () => {
    const tools = [
      makeTool("bash", { description: "Run" }),
      makeTool("grep", { description: "Search" }),
      makeTool("glob", { description: "Find" }),
      makeTool("read", { description: "Read" }),
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).toContain("Prefer grep/glob/read over bash")
  })

  test("omits prefer-dedicated-tools guideline when only bash active", () => {
    const tools = [makeTool("bash", { description: "Run" })]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).not.toContain("Prefer")
  })

  test("never renders a delegation roster: children inherit the current agent", () => {
    const tools = [makeTool("delegate", { description: "Delegate work" })]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).not.toContain("## Delegation Targets")
  })
})
