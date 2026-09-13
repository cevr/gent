import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { compileSystemPrompt, environmentSection } from "../../src/domain/prompt"
import { buildTurnPromptSections } from "../../src/runtime/agent/agent-loop.utils"
import { AgentDefinition, AgentName } from "../../src/domain/agent"
import { tool, type ToolCapability } from "@gent/core/extensions/api"

describe("environment section", () => {
  const base = {
    cwd: "/home/user/project",
    platform: "linux",
    isGitRepo: true,
    date: "2026-01-01",
  }

  test("names the working directory, platform, git state, and date", () => {
    const result = compileSystemPrompt([environmentSection(base)])
    expect(result).toContain("Working directory: /home/user/project")
    expect(result).toContain("Platform: linux")
    expect(result).toContain("Git repository: yes")
    expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/)
  })

  test("shell and OS version appear when known", () => {
    expect(environmentSection(base).content).toContain("Shell: unknown")
    expect(environmentSection({ ...base, shell: "/bin/zsh" }).content).toContain("Shell: /bin/zsh")
    expect(environmentSection({ ...base, osVersion: "24.6.0" }).content).toContain(
      "Platform: linux (24.6.0)",
    )
    expect(environmentSection({ ...base, isGitRepo: false }).content).toContain(
      "Git repository: no",
    )
  })

  test("lower priority sections appear first in compiled output", () => {
    const result = compileSystemPrompt([
      { id: "b", content: "second", priority: 20 },
      { id: "a", content: "first", priority: 10 },
    ])
    expect(result).toBe("first\n\nsecond")
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
    const result = compileSystemPrompt(buildTurnPromptSections(baseSections, agent, tools))
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
    const result = compileSystemPrompt(buildTurnPromptSections(baseSections, agent, tools))
    expect(result).toContain("## Tool Guidelines")
    expect(result).toContain("Use instead of bash cat")
  })

  test("duplicate guidelines appear only once", () => {
    const tools = [
      makeTool("read", { description: "Read", promptGuidelines: ["Shared guideline"] }),
      makeTool("grep", { description: "Grep", promptGuidelines: ["Shared guideline"] }),
    ]
    const result = compileSystemPrompt(buildTurnPromptSections(baseSections, agent, tools))
    const count = result.split("Shared guideline").length - 1
    expect(count).toBe(1)
  })

  test("includes agent addendum", () => {
    const result = compileSystemPrompt(buildTurnPromptSections(baseSections, agent, []))
    expect(result).toContain("## Agent: test-agent")
    expect(result).toContain("Be helpful.")
  })

  test("omits tool sections when no tools have metadata", () => {
    const tools = [makeTool("plain", { description: "No metadata" })]
    const result = compileSystemPrompt(buildTurnPromptSections(baseSections, agent, tools))
    expect(result).not.toContain("## Available Tools")
    expect(result).not.toContain("## Tool Guidelines")
  })

  test("a tool steering the model toward another one says so itself", () => {
    // The loop reads guidelines off the tools present; it does not know that
    // "bash" exists or that "grep" is preferable to it.
    const tools = [
      makeTool("bash", {
        description: "Run",
        promptGuidelines: ["Prefer grep over bash for file searching"],
      }),
      makeTool("grep", { description: "Search" }),
    ]
    const result = compileSystemPrompt(buildTurnPromptSections(baseSections, agent, tools))
    expect(result).toContain("Prefer grep over bash for file searching")
  })

  test("a guideline only reaches the prompt while its tool is active", () => {
    const tools = [makeTool("grep", { description: "Search" })]
    const result = compileSystemPrompt(buildTurnPromptSections(baseSections, agent, tools))
    expect(result).not.toContain("Prefer grep over bash")
  })

  test("never renders a delegation roster: children inherit the current agent", () => {
    const tools = [makeTool("delegate", { description: "Delegate work" })]
    const result = compileSystemPrompt(buildTurnPromptSections(baseSections, agent, tools))
    expect(result).not.toContain("## Delegation Targets")
  })
})
