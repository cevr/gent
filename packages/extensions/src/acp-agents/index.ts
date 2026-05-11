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
import { BunServices } from "@effect/platform-bun"
import { Clock, Context, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

import {
  AgentName,
  defineAgent,
  defineExtension,
  defineResource,
  ExtensionSetupContext,
  ExternalDriverRef,
  ProviderAuthError,
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
import { live as claudeSdkLive, type AcpAgentsPlatformShape } from "./claude-sdk.js"
import { AnthropicPlatform, type AnthropicPlatformShape } from "../anthropic/platform-adapter.js"
import {
  freshEnoughForUse,
  PRIMARY_CLAUDE_SERVICE,
  readClaudeCodeCredentials,
  refreshClaudeCodeCredentials,
} from "../anthropic/oauth.js"
import { generateToolDescription } from "./mcp-codemode.js"

/**
 * Read the Claude Code OAuth access token from macOS Keychain (or
 * `~/.claude/.credentials.json` on non-darwin), refreshing if it expires
 * within the next minute. Uses the refreshed creds returned from the
 * refresh call directly — re-reading keychain would silently lose
 * direct-OAuth tokens on write-back failure.
 *
 * If the refreshed creds are still inside the freshness window, fail
 * with ProviderAuthError rather than send a token that will expire
 * mid-flight — matches AnthropicCredentialService's policy.
 */
const readClaudeCodeOAuthToken = (
  platform: AnthropicPlatformShape,
): Effect.Effect<string, ProviderAuthError> =>
  Effect.gen(function* () {
    // The ACP/SDK path always uses the primary account. Multi-account
    // routing happens at the picker UI level (which doesn't exist yet);
    // this caller spells out PRIMARY_CLAUDE_SERVICE so a future refactor
    // can audit-grep all the places that assume primary.
    let creds = yield* readClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE)
    const now = yield* Clock.currentTimeMillis
    if (!freshEnoughForUse(creds, now)) {
      creds = yield* refreshClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE)
      if (!freshEnoughForUse(creds, now)) {
        return yield* new ProviderAuthError({
          message:
            "Refreshed Claude Code credentials are still near expiry — try again in a moment.",
        })
      }
    }
    return creds.accessToken
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(Layer.merge(BunServices.layer, Layer.succeed(AnthropicPlatform, platform))),
  )

/**
 * Marker service whose only purpose is to give the lifecycle-only Resource
 * a concrete `A` channel. Effect v4 `Layer<in ROut, out E, out RIn>` makes
 * `Layer.empty: Layer<never>` non-assignable to the heterogeneous bucket
 * type `Layer<any, ...>` under contravariant `ROut`, so the prior
 * `resource()` variance widener was the only way to land a `Layer.empty`
 * leaf. Anchoring `A = AcpAgentsDisposer` keeps the leaf type structural
 * and lets `defineResource(...)` flow straight into `resources: []`.
 */
class AcpAgentsDisposer extends Context.Service<
  AcpAgentsDisposer,
  { readonly _tag: "AcpAgentsDisposer" }
>()("@gent/extensions/src/acp-agents/AcpAgentsDisposer") {}

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
      defineResource({
        scope: "process",
        layer: Layer.effect(
          AcpAgentsDisposer,
          Effect.acquireRelease(
            Effect.succeed(AcpAgentsDisposer.of({ _tag: "AcpAgentsDisposer" })),
            () =>
              Effect.gen(function* () {
                yield* acpManager.disposeAll()
                yield* claudeCodeManager.disposeAll
              }),
          ),
        ),
      }),
    ],
  }
}

export const makeAcpAgentsExtension = (
  deps: AcpAgentsManagerDeps = {},
): GentExtension<ChildProcessSpawner> => {
  const cachedBySetupContext = new WeakMap<object, ExtensionContributions>()
  const setupContributions = Effect.gen(function* () {
    const ctx = yield* ExtensionSetupContext
    const cached = cachedBySetupContext.get(ctx)
    if (cached !== undefined) return cached
    const spawner = yield* ChildProcessSpawner
    const anthropicPlatform = AnthropicPlatform.fromSetup(ctx)
    const acpPlatform = {
      parentEnv: anthropicPlatform.parentEnv,
    } satisfies AcpAgentsPlatformShape
    const contributions = buildAcpContributions(spawner, deps, {
      acp: acpPlatform,
      anthropic: anthropicPlatform,
    })
    cachedBySetupContext.set(ctx, contributions)
    return contributions
  })

  return defineExtension({
    id: "@gent/acp-agents",
    agents: [claudeCodeAgent, ...protocolAgents],
    reactions: {
      systemPrompt: rewriteCodemodeSystemPrompt,
    },
    resources: () => setupContributions.pipe(Effect.map((c) => c.resources ?? [])),
    externalDrivers: () => setupContributions.pipe(Effect.map((c) => c.externalDrivers ?? [])),
  })
}

export const AcpAgentsExtension: GentExtension<ChildProcessSpawner> = makeAcpAgentsExtension()
