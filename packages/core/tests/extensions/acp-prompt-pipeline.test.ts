/**
 * ACP system-prompt pipeline — when the resolved driver is an ACP
 * external driver, the prompt gains a "codemode" tool surface section.
 *
 * Tests run the registered pipeline directly (not through the full agent
 * loop) so the mapping is exercised without a real session.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AcpAgentsExtension } from "@gent/extensions/acp-agents"
import { AgentDefinition, ExternalDriverRef, ModelDriverRef } from "@gent/core/domain/agent"
import type { AnyToolDefinition } from "@gent/core/domain/tool"

const baseAgent = new AgentDefinition({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  name: "cowork" as never,
})

const fakeTool: AnyToolDefinition = {
  name: "echo",
  description: "echo tool",
  params: Schema.Struct({ text: Schema.String }),
  execute: () => Effect.succeed({ ok: true }),
}

const getPromptPipeline = async () => {
  const contributions = await Effect.runPromise(
    AcpAgentsExtension.setup({ cwd: "/tmp", home: "/home/x" } as never),
  )
  const pipelines = contributions.pipelines ?? []
  const promptPipeline = pipelines.find((p) => p.hook === "prompt.system")
  if (promptPipeline === undefined) throw new Error("prompt.system pipeline not registered")
  return promptPipeline
}

const runHandler = async (
  input: Parameters<Awaited<ReturnType<typeof getPromptPipeline>>["handler"]>[0],
): Promise<string> => {
  const p = await getPromptPipeline()
  const result = await Effect.runPromise(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    p.handler(input, (i) => Effect.succeed(i.basePrompt), {} as never) as Effect.Effect<string>,
  )
  return result
}

describe("ACP prompt.system pipeline", () => {
  test("appends codemode section when driverToolSurface is codemode", async () => {
    const result = await runHandler({
      basePrompt: "BASE",
      agent: new AgentDefinition({
        ...baseAgent,
        driver: new ExternalDriverRef({ id: "acp-claude-code" }),
      }),
      driverSource: "config",
      driverToolSurface: "codemode",
      tools: [fakeTool],
    })
    expect(result.startsWith("BASE\n\n")).toBe(true)
    expect(result).toContain("External Tool Surface (codemode)")
    expect(result).toContain("gent.echo({ text: string })")
  })

  test("no-op when driverToolSurface is undefined (model-routed)", async () => {
    const result = await runHandler({
      basePrompt: "BASE",
      agent: baseAgent,
      driverSource: "default",
      tools: [fakeTool],
    })
    expect(result).toBe("BASE")
  })

  test("no-op when driverToolSurface is native", async () => {
    const result = await runHandler({
      basePrompt: "BASE",
      agent: new AgentDefinition({
        ...baseAgent,
        driver: new ModelDriverRef({ id: "anthropic" }),
      }),
      driverSource: "config",
      driverToolSurface: "native",
      tools: [fakeTool],
    })
    expect(result).toBe("BASE")
  })

  test("no-op when external driver opts out of codemode (toolSurface: native)", async () => {
    const result = await runHandler({
      basePrompt: "BASE",
      agent: new AgentDefinition({
        ...baseAgent,
        driver: new ExternalDriverRef({ id: "custom-driver" }),
      }),
      driverSource: "config",
      driverToolSurface: "native",
      tools: [fakeTool],
    })
    expect(result).toBe("BASE")
  })

  test("no-op when tools list is empty", async () => {
    const result = await runHandler({
      basePrompt: "BASE",
      agent: new AgentDefinition({
        ...baseAgent,
        driver: new ExternalDriverRef({ id: "acp-claude-code" }),
      }),
      driverSource: "config",
      driverToolSurface: "codemode",
      tools: [],
    })
    expect(result).toBe("BASE")
  })

  test("structural rewrite: strips tool-list / tool-guidelines from compiled prompt and appends codemode", async () => {
    // basePrompt represents the post-`next(input)` compiled string —
    // that's what an upstream pipeline (or the loop's default builder)
    // hands us. The hook surgically removes native tool-section content
    // from that string and appends the codemode block, preserving any
    // upstream edits (counsel MEDIUM #5).
    const compiled = [
      "ID-SECTION",
      "## Available Tools\n\n- echo",
      "## Tool Guidelines\n\n- use tools",
      "EXTRA-SECTION",
    ].join("\n\n")
    const result = await runHandler({
      basePrompt: compiled,
      agent: new AgentDefinition({
        ...baseAgent,
        driver: new ExternalDriverRef({ id: "acp-claude-code" }),
      }),
      driverSource: "config",
      driverToolSurface: "codemode",
      tools: [fakeTool],
      sections: [
        { id: "identity", content: "ID-SECTION", priority: 0 },
        { id: "tool-list", content: "## Available Tools\n\n- echo", priority: 42 },
        { id: "tool-guidelines", content: "## Tool Guidelines\n\n- use tools", priority: 44 },
        { id: "extra", content: "EXTRA-SECTION", priority: 80 },
      ],
    })
    expect(result).toContain("ID-SECTION")
    expect(result).toContain("EXTRA-SECTION")
    expect(result).toContain("External Tool Surface (codemode)")
    expect(result).not.toContain("## Available Tools\n\n- echo")
    expect(result).not.toContain("- use tools")
  })

  test("preserves upstream basePrompt edits when stripping native sections", async () => {
    // Simulate an earlier pipeline that prepended an "INSTRUCTIONS"
    // block to the compiled prompt — the upstream edit must survive
    // the codemode rewrite.
    const compiled = [
      "INSTRUCTIONS-FROM-UPSTREAM",
      "ID-SECTION",
      "## Available Tools\n\n- echo",
      "EXTRA-SECTION",
    ].join("\n\n")
    const result = await runHandler({
      basePrompt: compiled,
      agent: new AgentDefinition({
        ...baseAgent,
        driver: new ExternalDriverRef({ id: "acp-claude-code" }),
      }),
      driverSource: "config",
      driverToolSurface: "codemode",
      tools: [fakeTool],
      sections: [
        { id: "identity", content: "ID-SECTION", priority: 0 },
        { id: "tool-list", content: "## Available Tools\n\n- echo", priority: 42 },
        { id: "extra", content: "EXTRA-SECTION", priority: 80 },
      ],
    })
    expect(result).toContain("INSTRUCTIONS-FROM-UPSTREAM")
    expect(result).toContain("ID-SECTION")
    expect(result).toContain("EXTRA-SECTION")
    expect(result).toContain("External Tool Surface (codemode)")
    expect(result).not.toContain("## Available Tools\n\n- echo")
  })
})
