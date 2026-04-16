/**
 * ACP agent configurations — command + args for each supported agent.
 *
 * @module
 */

export interface AcpAgentConfig {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export const ACP_AGENTS: Record<string, AcpAgentConfig> = {
  "claude-code": {
    command: "claude",
    args: ["acp", "--bare", "--tools", "", "--strict-mcp-config", "--dangerously-skip-permissions"],
  },
  opencode: { command: "opencode", args: ["acp"] },
  "gemini-cli": { command: "gemini", args: ["acp"] },
}
