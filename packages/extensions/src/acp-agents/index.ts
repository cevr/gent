/**
 * ACP Agents Extension — external agents (Claude Code, OpenCode, Gemini CLI)
 * as first-class gent agents via the ExternalDriver primitive.
 *
 * Two transport paths share this extension:
 *
 * 1. Claude Code goes through `@anthropic-ai/claude-agent-sdk` directly.
 *    The `ClaudeSdk` service owns the SDK lifecycle; the
 *    `ClaudeCodeSessionManager` caches one SDK session per gent session.
 *
 * 2. opencode and gemini-cli go through hand-rolled ACP JSON-RPC over
 *    stdio (`protocol.ts` + `schema.ts`); the `AcpSessionManager` owns
 *    one subprocess per gent session.
 *
 * Both managers are created once per extension setup and captured by the
 * contributed drivers plus the process-scoped Resource finalizer.
 *
 * @module
 */
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import {
  AgentName,
  defineAgent,
  defineResource,
  ExtensionId,
  ExternalDriverRef,
  resource,
  sectionPatternFor,
  type ExtensionContributions,
  type GentExtension,
  type ToolCapability,
} from "@gent/core/extensions/api"
import { ACP_PROTOCOL_AGENTS, CLAUDE_CODE_AGENT_NAME } from "./config.js"
import { makeAcpTurnExecutor } from "./executor.js"
import { createAcpSessionManager } from "./session-manager.js"
import {
  createClaudeCodeSessionManager,
  makeClaudeCodeTurnExecutor,
} from "./claude-code-executor.js"
import { readClaudeCodeOAuthToken } from "./claude-code-auth.js"
import { live as claudeSdkLive, type AcpAgentsPlatformShape } from "./claude-sdk.js"
import { AnthropicPlatform, runHostProcessWithSpawner } from "../anthropic/platform-adapter.js"
import { generateToolDescription } from "./mcp-codemode.js"

const claudeCodeAgent = defineAgent({
  name: AgentName.make(CLAUDE_CODE_AGENT_NAME),
  description: "Claude Code via Claude Agent SDK",
  driver: ExternalDriverRef.make({ id: `acp-${CLAUDE_CODE_AGENT_NAME}` }),
})

const protocolAgents = Object.entries(ACP_PROTOCOL_AGENTS).map(([name, config]) =>
  defineAgent({
    name: AgentName.make(name),
    description: `${config.command} via ACP`,
    driver: ExternalDriverRef.make({ id: `acp-${name}` }),
  }),
)

const codemodeInstructions = (toolList: string): string =>
  [
    "## External Tool Surface (codemode)",
    "",
    "Your tools are exposed via a single MCP `execute` tool. Call it with",
    "JavaScript that invokes `gent.<name>(args)` and returns the result.",
    "",
    "```",
    'return await gent.grep({ pattern: "TODO", path: "src/" })',
    "```",
    "",
    "Compose multiple calls in one `execute` invocation:",
    "",
    "```",
    'const files = await gent.glob({ pattern: "**/*.ts" })',
    "const matches = []",
    "for (const f of files) {",
    '  matches.push(await gent.grep({ pattern: "FIXME", path: f }))',
    "}",
    "return matches",
    "```",
    "",
    toolList,
  ].join("\n")

// Section ids produced by `buildTurnPromptSections` that describe the
// native tool surface — replaced (not appended-to) when the resolved
// driver is codemode-routed.
const NATIVE_TOOL_SECTION_IDS = ["tool-list", "tool-guidelines"] as const

/**
 * Strip native tool sections from an already-compiled prompt string by
 * matching the `<!-- @section:<id>:start --> ... <!-- @section:<id>:end -->`
 * sentinel pair that section authors opt into via `withSectionMarkers`
 * (currently `tool-list` + `tool-guidelines` in `agent-loop.utils.ts`).
 *
 * Counsel  — replaces the prior `indexOf(section.content)` surgery,
 * which broke the moment any upstream pipeline rewrote a single
 * character inside the native section. Markers are stable across
 * upstream edits to section *content* and stay invisible to most
 * renderers, so they're the right anchor for atomic cross-section
 * mutations.
 *
 * Returns `{ stripped, anyStripped }` so the caller can warn when the
 * codemode hook expected to strip but found no markers (extension
 * authored a tool-list section without going through the marker
 * helper).
 */
const stripNativeToolSections = (compiled: string): { stripped: string; anyStripped: boolean } => {
  let out = compiled
  let anyStripped = false
  for (const id of NATIVE_TOOL_SECTION_IDS) {
    // Counsel  deep — duplicate marker-wrapped sections (rare, but
    // possible when an upstream pipeline duplicates the tool list)
    // used to leave one behind because we ran a single non-global
    // replace per id. Loop until no match so every wrapped section
    // peels off, then collapse the blank lines.
    const pattern = sectionPatternFor(id)
    while (pattern.test(out)) {
      out = out.replace(pattern, "")
      anyStripped = true
    }
  }
  // Collapse the blank lines left by removed sections so we don't end up
  // with three-line gaps where one section used to be.
  const stripped = out.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")
  return { stripped, anyStripped }
}

// Heuristic check used only to warn when the codemode hook can't find
// markers but the prompt still looks like it carries a native tool
// surface — without it we'd silently send contradictory tool surfaces
// to the model (codemode block + `## Available Tools`).
const looksLikeNativeToolSurface = (s: string): boolean =>
  s.includes("## Available Tools") || s.includes("## Tool Guidelines")

const rewriteCodemodeSystemPrompt = (input: {
  readonly basePrompt: string
  readonly driverToolSurface?: "native" | "codemode"
  readonly tools?: ReadonlyArray<ToolCapability>
}) =>
  Effect.gen(function* () {
    if (input.driverToolSurface !== "codemode") return input.basePrompt
    const tools = input.tools ?? []
    if (tools.length === 0) return input.basePrompt
    const codemode = codemodeInstructions(generateToolDescription(tools))
    const { stripped } = stripNativeToolSections(input.basePrompt)
    if (looksLikeNativeToolSurface(stripped)) {
      yield* Effect.logWarning(
        "acp.codemode.native-tool-surface-leak — " +
          "prompt still contains '## Available Tools' / '## Tool Guidelines' " +
          "after marker stripping. The model will see contradictory tool " +
          "surfaces (codemode block + native section). Wrap native tool " +
          "section content with `withSectionMarkers(id, content)` from " +
          "`@gent/core/extensions/api`, or remove the upstream native " +
          "section entirely.",
      )
    }
    return stripped.length === 0 ? codemode : `${stripped}\n\n${codemode}`
  })

interface AcpAgentsManagerDeps {
  readonly makeAcpSessionManager?: (
    spawner: ChildProcessSpawner["Service"],
  ) => ReturnType<typeof createAcpSessionManager>
  readonly makeClaudeCodeSessionManager?: () => ReturnType<typeof createClaudeCodeSessionManager>
}

const buildAcpContributions = (
  spawner: ChildProcessSpawner["Service"],
  deps: AcpAgentsManagerDeps,
  platform: {
    readonly acp: AcpAgentsPlatformShape
    readonly anthropic: AnthropicPlatform["Service"]
  },
): ExtensionContributions => {
  const acpManager = (deps.makeAcpSessionManager ?? createAcpSessionManager)(spawner)
  const claudeCodeManager = (
    deps.makeClaudeCodeSessionManager ??
    (() =>
      createClaudeCodeSessionManager(claudeSdkLive(platform.acp), () =>
        readClaudeCodeOAuthToken(platform.anthropic),
      ))
  )()
  const claudeCodeId = `acp-${CLAUDE_CODE_AGENT_NAME}`
  const claudeCode = {
    id: claudeCodeId,
    executor: makeClaudeCodeTurnExecutor(claudeCodeManager),
    toolSurface: "codemode" as const,
    invalidate: () => claudeCodeManager.invalidateDriver(claudeCodeId),
  }
  const protocolDrivers = Object.entries(ACP_PROTOCOL_AGENTS).map(([name, config]) => {
    const id = `acp-${name}`
    return {
      id,
      executor: makeAcpTurnExecutor(id, config, acpManager),
      toolSurface: "codemode" as const,
      invalidate: () => acpManager.invalidateDriver(id),
    }
  })

  return {
    agents: [claudeCodeAgent, ...protocolAgents],
    reactions: {
      systemPrompt: rewriteCodemodeSystemPrompt,
    },
    externalDrivers: [claudeCode, ...protocolDrivers],
    resources: [
      resource(
        defineResource({
          scope: "process",
          layer: Layer.empty,
          stop: Effect.gen(function* () {
            yield* acpManager.disposeAll()
            yield* claudeCodeManager.disposeAll
          }),
        }),
      ),
    ],
  }
}

export const makeAcpAgentsExtension = (
  deps: AcpAgentsManagerDeps = {},
): GentExtension<ChildProcessSpawner> => ({
  manifest: { id: ExtensionId.make("@gent/acp-agents") },
  setup: (ctx) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      const gentPlatform = yield* Effect.serviceOption(GentPlatform)
      const parentEnv = gentPlatform._tag === "Some" ? yield* gentPlatform.value.env : {}
      const acpPlatform = { parentEnv } satisfies AcpAgentsPlatformShape
      const anthropicPlatform = AnthropicPlatform.of({
        platform: ctx.host.osInfo.platform,
        home: ctx.home,
        parentEnv,
        runProcess: runHostProcessWithSpawner(spawner),
      })
      return buildAcpContributions(spawner, deps, {
        acp: acpPlatform,
        anthropic: anthropicPlatform,
      })
    }),
})

export const AcpAgentsExtension: GentExtension<ChildProcessSpawner> = makeAcpAgentsExtension()
