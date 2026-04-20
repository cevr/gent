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
 * Both managers are module-scope singletons created at extension setup, with
 * disposal hung off a `process`-scoped `defineResource` `stop` finalizer.
 *
 * @module
 */
import { Effect, Layer } from "effect"
import {
  defineAgent,
  defineExtension,
  defineResource,
  ExternalDriverRef,
  pipeline,
  resource,
  sectionPatternFor,
} from "@gent/core/extensions/api"
import { ACP_PROTOCOL_AGENTS, CLAUDE_CODE_AGENT_NAME } from "./config.js"
import { makeAcpTurnExecutor } from "./executor.js"
import { createAcpSessionManager } from "./session-manager.js"
import {
  createClaudeCodeSessionManager,
  makeClaudeCodeTurnExecutor,
} from "./claude-code-executor.js"
import { live as claudeSdkLive } from "./claude-sdk.js"
import { generateToolDescription } from "./mcp-codemode.js"

// Module-scope singletons — created once at extension setup, shared across
// agents and `externalDrivers` factory calls. The Claude Code manager
// captures the SDK service shape directly (rather than yielding it
// per-turn) so the executor's `executeTurn` Stream stays free of an
// `R = ClaudeSdk` requirement.
let _sharedAcpManager: ReturnType<typeof createAcpSessionManager> | undefined
const getAcpManager = () => {
  if (_sharedAcpManager === undefined) _sharedAcpManager = createAcpSessionManager()
  return _sharedAcpManager
}

let _sharedClaudeCodeManager: ReturnType<typeof createClaudeCodeSessionManager> | undefined
const getClaudeCodeManager = () => {
  if (_sharedClaudeCodeManager === undefined) {
    _sharedClaudeCodeManager = createClaudeCodeSessionManager(claudeSdkLive)
  }
  return _sharedClaudeCodeManager
}

const claudeCodeAgent = defineAgent({
  name: CLAUDE_CODE_AGENT_NAME,
  description: "Claude Code via Claude Agent SDK",
  driver: new ExternalDriverRef({ id: `acp-${CLAUDE_CODE_AGENT_NAME}` }),
})

const protocolAgents = Object.entries(ACP_PROTOCOL_AGENTS).map(([name, config]) =>
  defineAgent({
    name,
    description: `${config.command} via ACP`,
    driver: new ExternalDriverRef({ id: `acp-${name}` }),
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
 * sentinel pair that `compileSystemPrompt` emits around every section.
 *
 * Counsel C6 — replaces the prior `indexOf(section.content)` surgery,
 * which broke the moment any upstream pipeline rewrote a single
 * character inside the native section. Markers are stable across
 * upstream edits to section *content* and stay invisible to most
 * renderers, so they're the right anchor for atomic cross-section
 * mutations.
 */
const stripNativeToolSections = (compiled: string): string => {
  let out = compiled
  for (const id of NATIVE_TOOL_SECTION_IDS) {
    const pattern = sectionPatternFor(id)
    out = out.replace(pattern, "")
  }
  // Collapse the blank lines left by removed sections so we don't end up
  // with three-line gaps where one section used to be.
  return out.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")
}

export const AcpAgentsExtension = defineExtension({
  id: "@gent/acp-agents",
  agents: [claudeCodeAgent, ...protocolAgents],
  pipelines: [
    // When the resolved driver declares `toolSurface: "codemode"`, replace
    // the native tool sections (`tool-list` + `tool-guidelines`) with a
    // codemode section — the model would otherwise see two contradictory
    // tool surfaces. Detection keys off driver metadata, not driver-id
    // prefix (codex MEDIUM #3).
    pipeline("prompt.system", (input, next) =>
      Effect.gen(function* () {
        // Always run downstream first so this hook composes on top of
        // any upstream pipeline edits (additions, rewrites). We then
        // strip native tool sections via the marker sentinels and
        // append the codemode block — composing with the
        // post-`next(input)` string instead of recompiling from raw
        // sections preserves edits another extension may have made.
        const base = yield* next(input)
        if (input.driverToolSurface !== "codemode") return base
        const tools = input.tools ?? []
        if (tools.length === 0) return base
        const codemode = codemodeInstructions(generateToolDescription(tools))
        const stripped = stripNativeToolSections(base)
        return stripped.length === 0 ? codemode : `${stripped}\n\n${codemode}`
      }),
    ),
  ],
  externalDrivers: () => {
    const claudeCodeId = `acp-${CLAUDE_CODE_AGENT_NAME}`
    const claudeCode = {
      id: claudeCodeId,
      executor: makeClaudeCodeTurnExecutor(getClaudeCodeManager()),
      toolSurface: "codemode" as const,
      invalidate: () => getClaudeCodeManager().invalidateDriver(claudeCodeId),
    }
    const protocolDrivers = Object.entries(ACP_PROTOCOL_AGENTS).map(([name, config]) => {
      const id = `acp-${name}`
      return {
        id,
        executor: makeAcpTurnExecutor(id, config, getAcpManager()),
        toolSurface: "codemode" as const,
        invalidate: () => getAcpManager().invalidateDriver(id),
      }
    })
    return [claudeCode, ...protocolDrivers]
  },
  // Per-process lifecycle Resource: dispose both managers (ACP-protocol
  // subprocesses and SDK sessions) at process-scope teardown.
  resources: () => [
    resource(
      defineResource({
        scope: "process",
        layer: Layer.empty,
        stop: Effect.gen(function* () {
          yield* getAcpManager().disposeAll()
          yield* getClaudeCodeManager().disposeAll
        }),
      }),
    ),
  ],
})
