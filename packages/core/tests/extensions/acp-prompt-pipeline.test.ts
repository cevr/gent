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
import { withSectionMarkers } from "@gent/core/server/system-prompt"
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

  test("strips marker-wrapped tool-list / tool-guidelines and appends codemode", async () => {
    // basePrompt mirrors what `compileSystemPrompt` produces in
    // production: native tool sections wrapped in `@section:<id>` start
    // and end sentinels. Counsel C6 — the codemode hook now matches
    // those sentinels rather than doing `indexOf(section.content)` on
    // raw content, so upstream edits to the *content* between the
    // sentinels still get cleaned up atomically.
    const compiled = [
      "ID-SECTION",
      withSectionMarkers("tool-list", "## Available Tools\n\n- echo"),
      withSectionMarkers("tool-guidelines", "## Tool Guidelines\n\n- use tools"),
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
    })
    expect(result).toContain("ID-SECTION")
    expect(result).toContain("EXTRA-SECTION")
    expect(result).toContain("External Tool Surface (codemode)")
    expect(result).not.toContain("## Available Tools")
    expect(result).not.toContain("- use tools")
    // Sentinels are removed alongside content.
    expect(result).not.toContain("@section:tool-list")
    expect(result).not.toContain("@section:tool-guidelines")
  })

  test("strips even when upstream rewrote the inner section content", async () => {
    // An upstream pipeline mutated the inside of the tool-list section.
    // The marker sentinels still bound the block, so the codemode hook
    // strips it cleanly — the prior `indexOf(section.content)` shape
    // would have left rewritten content stranded in the prompt.
    const compiled = [
      "INSTRUCTIONS-FROM-UPSTREAM",
      "ID-SECTION",
      withSectionMarkers("tool-list", "## Available Tools\n\n- echo (rewritten upstream)"),
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
    })
    expect(result).toContain("INSTRUCTIONS-FROM-UPSTREAM")
    expect(result).toContain("ID-SECTION")
    expect(result).toContain("EXTRA-SECTION")
    expect(result).toContain("External Tool Surface (codemode)")
    expect(result).not.toContain("rewritten upstream")
    expect(result).not.toContain("@section:tool-list")
  })

  test("leaves prompt untouched when native sections lack markers", async () => {
    // If the section was authored without sentinels (e.g. an extension
    // produced a tool-list section directly), the codemode hook can't
    // locate it. Prefer leaving the prompt untouched over guessing —
    // the model gets a contradicting tool surface, which is bad, but
    // mangled-prompt is worse. The native-builder always wraps these
    // sections, so this is only a concern for hand-rolled extensions.
    const compiled = ["ID-SECTION", "## Available Tools\n\n- echo", "EXTRA-SECTION"].join("\n\n")
    const result = await runHandler({
      basePrompt: compiled,
      agent: new AgentDefinition({
        ...baseAgent,
        driver: new ExternalDriverRef({ id: "acp-claude-code" }),
      }),
      driverSource: "config",
      driverToolSurface: "codemode",
      tools: [fakeTool],
    })
    expect(result).toContain("## Available Tools")
    expect(result).toContain("External Tool Surface (codemode)")
  })
})
