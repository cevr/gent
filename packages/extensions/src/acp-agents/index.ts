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
  resource,
} from "@gent/core/extensions/api"
import { ACP_PROTOCOL_AGENTS, CLAUDE_CODE_AGENT_NAME } from "./config.js"
import { makeAcpTurnExecutor } from "./executor.js"
import { createAcpSessionManager } from "./session-manager.js"
import {
  createClaudeCodeSessionManager,
  makeClaudeCodeTurnExecutor,
} from "./claude-code-executor.js"
import { live as claudeSdkLive } from "./claude-sdk.js"

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

export const AcpAgentsExtension = defineExtension({
  id: "@gent/acp-agents",
  agents: [claudeCodeAgent, ...protocolAgents],
  externalDrivers: () => {
    const claudeCode = {
      id: `acp-${CLAUDE_CODE_AGENT_NAME}`,
      executor: makeClaudeCodeTurnExecutor(getClaudeCodeManager()),
    }
    const protocolDrivers = Object.entries(ACP_PROTOCOL_AGENTS).map(([name, config]) => ({
      id: `acp-${name}`,
      executor: makeAcpTurnExecutor(config, getAcpManager()),
    }))
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
