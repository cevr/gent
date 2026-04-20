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
  test("appends codemode section when driver is ACP external + driverSource set", async () => {
    const result = await runHandler({
      basePrompt: "BASE",
      agent: new AgentDefinition({
        ...baseAgent,
        driver: new ExternalDriverRef({ id: "acp-claude-code" }),
      }),
      driverSource: "config",
      tools: [fakeTool],
    })
    expect(result.startsWith("BASE\n\n")).toBe(true)
    expect(result).toContain("External Tool Surface (codemode)")
    expect(result).toContain("gent.echo({ text: string })")
  })

  test("no-op when driverSource is default", async () => {
    const result = await runHandler({
      basePrompt: "BASE",
      agent: baseAgent,
      driverSource: "default",
      tools: [fakeTool],
    })
    expect(result).toBe("BASE")
  })

  test("no-op when driver is model (not external)", async () => {
    const result = await runHandler({
      basePrompt: "BASE",
      agent: new AgentDefinition({
        ...baseAgent,
        driver: new ModelDriverRef({ id: "anthropic" }),
      }),
      driverSource: "config",
      tools: [fakeTool],
    })
    expect(result).toBe("BASE")
  })

  test("no-op when external driver id doesn't match acp- prefix", async () => {
    const result = await runHandler({
      basePrompt: "BASE",
      agent: new AgentDefinition({
        ...baseAgent,
        driver: new ExternalDriverRef({ id: "custom-driver" }),
      }),
      driverSource: "config",
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
      tools: [],
    })
    expect(result).toBe("BASE")
  })
})
