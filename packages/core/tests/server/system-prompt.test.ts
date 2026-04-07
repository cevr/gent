import { describe, test, expect } from "bun:test"
import {
  buildSystemPrompt,
  buildBasePromptSections,
  compileSystemPrompt,
} from "@gent/core/server/system-prompt"
import { buildTurnPrompt } from "@gent/core/runtime/agent/agent-loop.utils"
import { AgentDefinition } from "@gent/core/domain/agent"

describe("buildSystemPrompt", () => {
  const base = {
    cwd: "/home/user/project",
    platform: "linux",
    isGitRepo: true,
  }

  test("includes identity with harness mention", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain("operating inside gent, an agent harness")
  })

  test("includes character section", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain("# Character")
    expect(result).toContain("Finish what you start")
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

  test("includes skills when provided", () => {
    const result = buildSystemPrompt({
      ...base,
      skills: [{ name: "effect-v4", path: "/skills/effect-v4.md", content: "Effect patterns" }],
    })
    expect(result).toContain("effect-v4")
  })

  test("omits skills section when empty array", () => {
    const result = buildSystemPrompt({ ...base, skills: [] })
    const withoutSkills = buildSystemPrompt(base)
    expect(result).toBe(withoutSkills)
  })

  test("includes date in ISO format", () => {
    const result = buildSystemPrompt(base)
    expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/)
  })
})

describe("buildBasePromptSections", () => {
  const base = {
    cwd: "/test",
    platform: "darwin",
    isGitRepo: false,
  }

  test("produces identity, character, tools, and environment sections", () => {
    const sections = buildBasePromptSections(base)
    expect(sections.length).toBeGreaterThanOrEqual(6)
    const ids = sections.map((s) => s.id)
    expect(ids).toContain("identity")
    expect(ids).toContain("character")
    expect(ids).toContain("tools")
    expect(ids).toContain("environment")
  })

  test("lower priority sections appear first in compiled output", () => {
    const result = compileSystemPrompt([
      { id: "b", content: "second", priority: 20 },
      { id: "a", content: "first", priority: 10 },
    ])
    expect(result).toBe("first\n\nsecond")
  })
})

describe("buildTurnPrompt", () => {
  const agent = new AgentDefinition({
    name: "test-agent",
    systemPromptAddendum: "Be helpful.",
  })

  const baseSections = [{ id: "base", content: "You are a test agent.", priority: 0 }]

  test("includes tool snippets when tools have promptSnippet", () => {
    const tools = [
      {
        name: "read",
        action: "read" as const,
        description: "Read files",
        promptSnippet: "Read file contents",
        params: {} as never,
        execute: (() => {}) as never,
      },
      {
        name: "bash",
        action: "exec" as const,
        description: "Run commands",
        promptSnippet: "Execute shell commands",
        params: {} as never,
        execute: (() => {}) as never,
      },
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).toContain("## Available Tools")
    expect(result).toContain("**read**: Read file contents")
    expect(result).toContain("**bash**: Execute shell commands")
  })

  test("includes tool guidelines when tools have promptGuidelines", () => {
    const tools = [
      {
        name: "read",
        action: "read" as const,
        description: "Read files",
        promptGuidelines: ["Use instead of bash cat"] as const,
        params: {} as never,
        execute: (() => {}) as never,
      },
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).toContain("## Tool Guidelines")
    expect(result).toContain("Use instead of bash cat")
  })

  test("duplicate guidelines appear only once", () => {
    const tools = [
      {
        name: "read",
        action: "read" as const,
        description: "Read",
        promptGuidelines: ["Shared guideline"] as const,
        params: {} as never,
        execute: (() => {}) as never,
      },
      {
        name: "grep",
        action: "read" as const,
        description: "Grep",
        promptGuidelines: ["Shared guideline"] as const,
        params: {} as never,
        execute: (() => {}) as never,
      },
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
    const tools = [
      {
        name: "plain",
        action: "read" as const,
        description: "No metadata",
        params: {} as never,
        execute: (() => {}) as never,
      },
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).not.toContain("## Available Tools")
    expect(result).not.toContain("## Tool Guidelines")
  })

  test("prefer-dedicated-tools guideline names only active tools", () => {
    const tools = [
      {
        name: "bash",
        action: "exec" as const,
        description: "Run",
        params: {} as never,
        execute: (() => {}) as never,
      },
      {
        name: "grep",
        action: "read" as const,
        description: "Search",
        params: {} as never,
        execute: (() => {}) as never,
      },
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).toContain("Prefer grep over bash")
    expect(result).not.toContain("glob")
  })

  test("names all active dedicated tools in the guideline", () => {
    const tools = [
      {
        name: "bash",
        action: "exec" as const,
        description: "Run",
        params: {} as never,
        execute: (() => {}) as never,
      },
      {
        name: "grep",
        action: "read" as const,
        description: "Search",
        params: {} as never,
        execute: (() => {}) as never,
      },
      {
        name: "glob",
        action: "read" as const,
        description: "Find",
        params: {} as never,
        execute: (() => {}) as never,
      },
      {
        name: "read",
        action: "read" as const,
        description: "Read",
        params: {} as never,
        execute: (() => {}) as never,
      },
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).toContain("Prefer grep/glob/read over bash")
  })

  test("omits prefer-dedicated-tools guideline when only bash active", () => {
    const tools = [
      {
        name: "bash",
        action: "exec" as const,
        description: "Run",
        params: {} as never,
        execute: (() => {}) as never,
      },
    ]
    const result = buildTurnPrompt(baseSections, agent, tools)
    expect(result).not.toContain("Prefer")
  })

  test("synthesizes delegation targets when delegate is in tool set", () => {
    const tools = [
      {
        name: "delegate",
        action: "delegate" as const,
        description: "Delegate work",
        params: {} as never,
        execute: (() => {}) as never,
      },
    ]
    const targets = [
      new AgentDefinition({ name: "explore", description: "Fast codebase search" }),
      new AgentDefinition({ name: "explore-2", description: "Code review" }),
      new AgentDefinition({ name: "no-desc" }), // no description — should be excluded
    ]
    const result = buildTurnPrompt(baseSections, agent, tools, undefined, targets)
    expect(result).toContain("## Delegation Targets")
    expect(result).toContain("**explore**: Fast codebase search")
    expect(result).toContain("**explore-2**: Code review")
    expect(result).not.toContain("no-desc")
  })

  test("excludes current agent from delegation targets", () => {
    const self = new AgentDefinition({ name: "test-agent", description: "Self" })
    const tools = [
      {
        name: "delegate",
        action: "delegate" as const,
        description: "Delegate",
        params: {} as never,
        execute: (() => {}) as never,
      },
    ]
    const targets = [self, new AgentDefinition({ name: "other", description: "Other agent" })]
    const result = buildTurnPrompt(baseSections, agent, tools, undefined, targets)
    expect(result).toContain("**other**: Other agent")
    expect(result).not.toContain("**test-agent**")
  })

  test("omits delegation targets when delegate not in tool set", () => {
    const tools = [
      {
        name: "read",
        action: "read" as const,
        description: "Read",
        params: {} as never,
        execute: (() => {}) as never,
      },
    ]
    const targets = [new AgentDefinition({ name: "explore", description: "Search" })]
    const result = buildTurnPrompt(baseSections, agent, tools, undefined, targets)
    expect(result).not.toContain("## Delegation Targets")
  })
})
