/**
 * ACP system-prompt slot — when the resolved driver is an ACP
 * external driver, the prompt gains a "codemode" tool surface section.
 *
 * Tests run the registered runtime slot directly (not through the full agent
 * loop) so the mapping is exercised without a real session.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Schema } from "effect"
import { AcpAgentsExtension } from "@gent/extensions/acp-agents"
import {
  AgentDefinition,
  AgentName,
  ExternalDriverRef,
  ModelDriverRef,
} from "@gent/core/domain/agent"
import { tool, type ToolToken } from "@gent/core/extensions/api"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { withSectionMarkers } from "@gent/core/domain/prompt"
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
const baseAgent = AgentDefinition.make({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
  name: "cowork" as never,
})
const fakeTool: ToolToken = tool({
  id: "echo",
  description: "echo tool",
  params: Schema.Struct({ text: Schema.String }),
  execute: () => Effect.succeed({ ok: true }),
})
const stubHostCtx = {} as ExtensionHostContext
const stubProjectionCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/home/x",
  turn: {
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    agent: baseAgent,
    allTools: [],
    agentName: AgentName.make("cowork"),
  },
}
const getRuntimeSlots = Effect.gen(function* () {
  const contributions = yield* AcpAgentsExtension.setup({ cwd: "/tmp", home: "/home/x" } as never)
  return compileExtensionReactions([
    {
      manifest: AcpAgentsExtension.manifest,
      scope: "builtin",
      sourcePath: "test",
      contributions,
    },
  ])
})
const runHandler = (input: {
  readonly basePrompt: string
  readonly agent: AgentDefinition
  readonly driverSource?: "config" | "default"
  readonly driverToolSurface?: "native" | "codemode"
  readonly tools?: ReadonlyArray<ToolToken>
}) =>
  Effect.gen(function* () {
    const slots = yield* getRuntimeSlots
    return yield* slots.resolveSystemPrompt(input, {
      projection: { ...stubProjectionCtx, turn: { ...stubProjectionCtx.turn, agent: input.agent } },
      host: stubHostCtx,
    })
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
