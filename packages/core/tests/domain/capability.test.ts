import { describe, expect, test } from "bun:test"
import { Context, Effect, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import {
  defineRequests,
  getToolId,
  ref,
  request,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import {
  compileSystemPrompt,
  environmentSection,
  getToolMetadata,
  isToolCapability,
} from "../../src/domain/capability"
import { ExtensionId, type RpcId, type ToolId } from "../../src/domain/ids"
import { buildTurnPromptSections } from "../../src/runtime/turn"
import { AgentDefinition, AgentName } from "../../src/domain/agent"

// ── capability-ref.test ─────────────────────────────────────────────────────

/**
 * Asserts the typed-ref accessor invariants for capabilities:
 *
 * 1. `request(...)` attaches a `CapabilityRef` under a private request-local
 *    symbol (private — only `ref(capability)` reads it).
 * 2. `ref(requestCapability)` returns the typed ref with the same id and
 *    schemas the author provided.
 * 3. `ref(toolCapability)` fails at compile time — only request capabilities
 *    carry a ref.
 */

describe("ref(capability)", () => {
  test("factories brand emitted bucket ids while accepting author strings", () => {
    const toolCapability = tool({
      id: "test.tool",
      description: "ephemeral",
      params: Schema.Struct({ x: Schema.String }),
      output: Schema.String,
      execute: () => Effect.succeed("ok"),
    })
    const requestCapability = request({
      id: "test.read",
      input: Schema.Struct({ q: Schema.String }),
      output: Schema.Struct({ n: Schema.Finite }),
      execute: () => Effect.succeed({ n: 1 }),
    })

    const toolId: ToolId = getToolId(toolCapability)
    const rpcId: RpcId = requestCapability.id
    expect([String(toolId), String(rpcId)]).toEqual(["test.tool", "test.read"])
  })

  test("tool lowers to a native Effect AI tool with Gent metadata annotations", () => {
    const params = Schema.Struct({ x: Schema.String })
    const capability = tool({
      id: "test.tool",
      description: "ephemeral",
      destructive: true,
      readonly: true,
      params,
      output: Schema.String,
      promptSnippet: "short",
      promptGuidelines: ["be precise"],
      interactive: true,
      execute: () => Effect.succeed("ok"),
    })

    expect(isToolCapability(capability)).toBe(true)
    expect(Context.get(capability.annotations, AiTool.Readonly)).toBe(true)
    expect(Context.get(capability.annotations, AiTool.Destructive)).toBe(true)

    const metadata = getToolMetadata(capability)
    expect(metadata.id).toBe(getToolId(capability))
    expect(metadata.readonly).toBe(true)
    expect(metadata.input).toBe(params)
    expect(metadata.promptSnippet).toBe("short")
    expect(metadata.promptGuidelines).toEqual(["be precise"])
    expect(metadata.interactive).toBe(true)
  })

  test("default tool is neither readonly nor destructive", () => {
    const capability = tool({
      id: "test.write",
      description: "write without destructive side effects",
      params: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.succeed("ok"),
    })

    expect(Context.get(capability.annotations, AiTool.Readonly)).toBe(false)
    expect(Context.get(capability.annotations, AiTool.Destructive)).toBe(false)
  })

  test("returns the typed ref for a request capability, preserving id + schema identity", () => {
    const inputSchema = Schema.Struct({ q: Schema.String })
    const outputSchema = Schema.Struct({ n: Schema.Finite })
    const { capability } = defineRequests(ExtensionId.make("ext-test"), {
      capability: request({
        id: "test.read",
        input: inputSchema,
        output: outputSchema,
        execute: () => Effect.succeed({ n: 1 }),
      }),
    })

    const r = ref(capability)
    const capabilityId: RpcId = r.capabilityId
    expect(String(capabilityId)).toBe("test.read")
    expect(String(r.extensionId)).toBe("ext-test")
    // Schema identity: refValue forwards author schemas by reference. A
    // future refactor that clones/wraps would silently change decode
    // behavior at the dispatcher boundary.
    expect(r.input).toBe(inputSchema)
    expect(r.output).toBe(outputSchema)
  })

  test("defineRequests binds exported protocol refs without per-request extension ids", () => {
    const rpc = defineRequests(ExtensionId.make("protocol-ext"), {
      Read: request({
        id: "protocol.read",
        input: Schema.Struct({ q: Schema.String }),
        output: Schema.String,
        execute: ({ q }) => Effect.succeed(q),
      }),
    })

    expect(String(ref(rpc.Read).extensionId)).toBe("protocol-ext")
    expect(String(ref(rpc.Read).capabilityId)).toBe("protocol.read")
  })

  test("ref accessor only accepts request capabilities", () => {
    const capability = tool({
      id: "test.tool",
      description: "ephemeral",
      params: Schema.Struct({ x: Schema.String }),
      output: Schema.String,
      execute: () => Effect.succeed("ok"),
    })

    // @ts-expect-error Tool capabilities are not request refs.
    ref(capability)
  })
})

// ── tool-declarations.test ──────────────────────────────────────────────────

/**
 * A tool's optional declarations survive the trip into its capability.
 *
 * Each one is declared once and copied twice -- input to metadata, metadata to
 * capability -- and an absent one must stay absent rather than arrive as
 * `undefined`, because both are exact optional properties.
 */

const params = Schema.Struct({ text: Schema.String })
const output = Schema.String

const bareTool = tool({
  id: "bare",
  description: "declares nothing optional",
  params,
  output,
  execute: () => Effect.succeed("done"),
})

const declaredTool = tool({
  id: "declared",
  description: "declares everything optional",
  params,
  output,
  promptSnippet: "a one-liner",
  promptGuidelines: ["prefer this tool"],
  interactive: true,
  dispatches: true,
  execute: () => Effect.succeed("done"),
})

describe("tool declarations", () => {
  test("reach the metadata annotation", () => {
    const metadata = getToolMetadata(declaredTool)
    expect(metadata.promptSnippet).toBe("a one-liner")
    expect(metadata.promptGuidelines).toEqual(["prefer this tool"])
    expect(metadata.interactive).toBe(true)
    expect(metadata.dispatches).toBe(true)
  })

  test("reach the capability itself", () => {
    expect(declaredTool.promptSnippet).toBe("a one-liner")
    expect(declaredTool.promptGuidelines).toEqual(["prefer this tool"])
    expect(declaredTool.interactive).toBe(true)
    expect(declaredTool.dispatches).toBe(true)
  })

  test("stay absent, not undefined, when the tool declares none", () => {
    const metadata = getToolMetadata(bareTool)
    for (const key of ["promptSnippet", "promptGuidelines", "interactive", "dispatches"]) {
      expect(Object.hasOwn(metadata, key)).toBe(false)
      expect(Object.hasOwn(bareTool, key)).toBe(false)
    }
  })
})

// ── prompt.test ─────────────────────────────────────────────────────────────

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
