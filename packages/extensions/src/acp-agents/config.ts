/**
 * ACP agent configurations.
 *
 * Two transport types:
 * - Claude Code: uses `@anthropic-ai/claude-agent-sdk` directly (no
 *   subprocess args here — the SDK manages its own process). Claude Code
 *   is registered separately in `index.ts`.
 * - ACP protocol agents (opencode, gemini-cli): spawn a subprocess and
 *   talk to it over stdio JSON-RPC. Configured below.
 *
 * @module
 */

export interface AcpProtocolAgentConfig {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/**
 * Subprocess configurations for ACP-protocol agents only. Claude Code is
 * NOT in this map — it goes through the SDK path (see `claude-code-executor.ts`).
 */
export const ACP_PROTOCOL_AGENTS: Record<string, AcpProtocolAgentConfig> = {
  opencode: { command: "opencode", args: ["acp"] },
  "gemini-cli": { command: "gemini", args: ["acp"] },
}

/** Claude Code agent name — registered separately because it uses the SDK path. */
export const CLAUDE_CODE_AGENT_NAME = "claude-code" as const
