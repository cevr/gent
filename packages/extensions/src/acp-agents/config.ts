/**
 * ACP agent configurations.
 *
 * Each agent is a subprocess gent spawns and talks to over stdio JSON-RPC.
 *
 * @module
 */

export interface AcpProtocolAgentConfig {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/** Subprocess configurations for ACP-protocol agents. */
export const ACP_PROTOCOL_AGENTS = {
  opencode: { command: "opencode", args: ["acp"] },
  "gemini-cli": { command: "gemini", args: ["acp"] },
} satisfies Readonly<Record<string, AcpProtocolAgentConfig>>
