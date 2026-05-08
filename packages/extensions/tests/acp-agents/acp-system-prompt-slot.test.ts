/**
 * ACP system-prompt slot — when the resolved driver is an ACP
 * external driver, the prompt gains a "codemode" tool surface section.
 *
 * Tests run the registered runtime slot directly (not through the full agent
 * loop) so the mapping is exercised without a real session.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Path, Schema } from "effect"
import { BunChildProcessSpawner, BunFileSystem } from "@effect/platform-bun"
import { AcpAgentsExtension } from "@gent/extensions/acp-agents"
import {
  AgentDefinition,
  ExternalDriverRef,
  ModelDriverRef,
} from "@gent/core-internal/domain/agent"
import { tool, type SystemPromptInput, type ToolCapability } from "@gent/core/extensions/api"
import { withSectionMarkers } from "@gent/core-internal/domain/prompt"
import { testExtensionHostContext, testSetupCtx } from "@gent/core-internal/test-utils"
const baseAgent = AgentDefinition.make({
  name: "cowork" as never,
})
const fakeTool: ToolCapability = tool({
  id: "echo",
  description: "echo tool",
  params: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  execute: () => Effect.succeed({ ok: true }),
})
const stubHostCtx = testExtensionHostContext()
const spawnerLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
)
const getSystemPrompt = Effect.gen(function* () {
  const contributions = yield* AcpAgentsExtension.setup(
    testSetupCtx({
      cwd: "/tmp",
      source: "builtin",
      home: "/home/x",
    }),
  ).pipe(Effect.provide(spawnerLayer))
  const systemPrompt = contributions.reactions?.systemPrompt
  if (systemPrompt === undefined) throw new Error("expected ACP systemPrompt reaction")
  return systemPrompt as (
    input: SystemPromptInput,
    ctx: typeof stubHostCtx,
  ) => Effect.Effect<string>
})
const runHandler = (input: {
  readonly basePrompt: string
  readonly agent: AgentDefinition
  readonly driverSource?: "config" | "default"
  readonly driverToolSurface?: "native" | "codemode"
  readonly tools?: ReadonlyArray<ToolCapability>
}) =>
  Effect.gen(function* () {
    const systemPrompt = yield* getSystemPrompt
    return yield* systemPrompt(input, stubHostCtx)
  })
describe("ACP systemPrompt slot", () => {
  it.live("appends codemode section when driverToolSurface is codemode", () =>
    Effect.gen(function* () {
      const result = yield* runHandler({
        basePrompt: "BASE",
        agent: AgentDefinition.make({
          ...baseAgent,
          driver: ExternalDriverRef.make({ id: "acp-claude-code" }),
        }),
        driverSource: "config",
        driverToolSurface: "codemode",
        tools: [fakeTool],
      })
      expect(result.startsWith("BASE\n\n")).toBe(true)
      expect(result).toContain("External Tool Surface (codemode)")
      expect(result).toContain("gent.echo({ text: string })")
    }),
  )
  it.live("no-op when driverToolSurface is undefined (model-routed)", () =>
    Effect.gen(function* () {
      const result = yield* runHandler({
        basePrompt: "BASE",
        agent: baseAgent,
        driverSource: "default",
        tools: [fakeTool],
      })
      expect(result).toBe("BASE")
    }),
  )
  it.live("no-op when driverToolSurface is native", () =>
    Effect.gen(function* () {
      const result = yield* runHandler({
        basePrompt: "BASE",
        agent: AgentDefinition.make({
          ...baseAgent,
          driver: ModelDriverRef.make({ id: "anthropic" }),
        }),
        driverSource: "config",
        driverToolSurface: "native",
        tools: [fakeTool],
      })
      expect(result).toBe("BASE")
    }),
  )
  it.live("no-op when external driver opts out of codemode (toolSurface: native)", () =>
    Effect.gen(function* () {
      const result = yield* runHandler({
        basePrompt: "BASE",
        agent: AgentDefinition.make({
          ...baseAgent,
          driver: ExternalDriverRef.make({ id: "custom-driver" }),
        }),
        driverSource: "config",
        driverToolSurface: "native",
        tools: [fakeTool],
      })
      expect(result).toBe("BASE")
    }),
  )
  it.live("no-op when tools list is empty", () =>
    Effect.gen(function* () {
      const result = yield* runHandler({
        basePrompt: "BASE",
        agent: AgentDefinition.make({
          ...baseAgent,
          driver: ExternalDriverRef.make({ id: "acp-claude-code" }),
        }),
        driverSource: "config",
        driverToolSurface: "codemode",
        tools: [],
      })
      expect(result).toBe("BASE")
    }),
  )
  it.live("strips marker-wrapped tool-list / tool-guidelines and appends codemode", () =>
    Effect.gen(function* () {
      const compiled = [
        "ID-SECTION",
        withSectionMarkers("tool-list", "## Available Tools\n\n- echo"),
        withSectionMarkers("tool-guidelines", "## Tool Guidelines\n\n- use tools"),
        "EXTRA-SECTION",
      ].join("\n\n")
      const result = yield* runHandler({
        basePrompt: compiled,
        agent: AgentDefinition.make({
          ...baseAgent,
          driver: ExternalDriverRef.make({ id: "acp-claude-code" }),
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
      expect(result).not.toContain("@section:tool-list")
      expect(result).not.toContain("@section:tool-guidelines")
    }),
  )
  it.live("strips even when upstream rewrote the inner section content", () =>
    Effect.gen(function* () {
      const compiled = [
        "INSTRUCTIONS-FROM-UPSTREAM",
        "ID-SECTION",
        withSectionMarkers("tool-list", "## Available Tools\n\n- echo (rewritten upstream)"),
        "EXTRA-SECTION",
      ].join("\n\n")
      const result = yield* runHandler({
        basePrompt: compiled,
        agent: AgentDefinition.make({
          ...baseAgent,
          driver: ExternalDriverRef.make({ id: "acp-claude-code" }),
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
    }),
  )
  it.live("strips every duplicate marker-wrapped section", () =>
    Effect.gen(function* () {
      const compiled = [
        "ID-SECTION",
        withSectionMarkers("tool-list", "## Available Tools\n\n- echo (a)"),
        withSectionMarkers("tool-list", "## Available Tools\n\n- echo (b)"),
        "EXTRA-SECTION",
      ].join("\n\n")
      const result = yield* runHandler({
        basePrompt: compiled,
        agent: AgentDefinition.make({
          ...baseAgent,
          driver: ExternalDriverRef.make({ id: "acp-claude-code" }),
        }),
        driverSource: "config",
        driverToolSurface: "codemode",
        tools: [fakeTool],
      })
      expect(result).not.toContain("echo (a)")
      expect(result).not.toContain("echo (b)")
      expect(result).toContain("External Tool Surface (codemode)")
    }),
  )
  it.live("leaves prompt untouched when native sections lack markers", () =>
    Effect.gen(function* () {
      const compiled = [
        "ID-SECTION",
        "## Available Tools\n\n- echo",
        "## Tool Guidelines\n\n- use tools",
        "EXTRA-SECTION",
      ].join("\n\n")
      const result = yield* runHandler({
        basePrompt: compiled,
        agent: AgentDefinition.make({
          ...baseAgent,
          driver: ExternalDriverRef.make({ id: "acp-claude-code" }),
        }),
        driverSource: "config",
        driverToolSurface: "codemode",
        tools: [fakeTool],
      })
      expect(result).toContain("## Available Tools")
      expect(result).toContain("External Tool Surface (codemode)")
    }),
  )
})
