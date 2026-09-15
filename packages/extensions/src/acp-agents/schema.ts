/**
 * ACP (Agent Client Protocol) v1 — Effect Schema types.
 *
 * Only the subset gent needs as a client. All field names match
 * the wire format (camelCase per serde(rename_all = "camelCase")).
 *
 * @module
 */
import { Schema } from "effect"

// ── Shared ──

export class Implementation extends Schema.Class<Implementation>("AcpImplementation")({
  name: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  version: Schema.String,
}) {}

// ── Initialize ──

export class FsCapabilities extends Schema.Class<FsCapabilities>("AcpFsCapabilities")({
  readTextFile: Schema.optional(Schema.Boolean),
  writeTextFile: Schema.optional(Schema.Boolean),
}) {}

export class ClientCapabilities extends Schema.Class<ClientCapabilities>("AcpClientCapabilities")({
  fs: Schema.optional(FsCapabilities),
  terminal: Schema.optional(Schema.Boolean),
}) {}

export class InitializeRequest extends Schema.Class<InitializeRequest>("AcpInitializeRequest")({
  protocolVersion: Schema.optional(Schema.Finite),
  clientCapabilities: Schema.optional(ClientCapabilities),
  clientInfo: Schema.optional(Implementation),
}) {}

export class McpCapabilities extends Schema.Class<McpCapabilities>("AcpMcpCapabilities")({
  http: Schema.optional(Schema.Boolean),
  sse: Schema.optional(Schema.Boolean),
}) {}

export class AgentCapabilities extends Schema.Class<AgentCapabilities>("AcpAgentCapabilities")({
  loadSession: Schema.optional(Schema.Boolean),
  mcpCapabilities: Schema.optional(McpCapabilities),
}) {}

export class InitializeResponse extends Schema.Class<InitializeResponse>("AcpInitializeResponse")({
  protocolVersion: Schema.Finite,
  agentCapabilities: Schema.optional(AgentCapabilities),
  agentInfo: Schema.optional(Implementation),
}) {}

// ── Session ──

export class NewSessionRequest extends Schema.Class<NewSessionRequest>("AcpNewSessionRequest")({
  cwd: Schema.String,
  mcpServers: Schema.optional(Schema.Array(Schema.Unknown)),
  /**
   * Out-of-band metadata. ACP agents that recognise it use
   * `_meta.systemPrompt: string` to replace the default system prompt
   * (or `{ append: string }` to append). Treated as `Schema.Unknown` —
   * the wire format is open and per-agent.
   */
  _meta: Schema.optional(Schema.Unknown),
}) {}

export class NewSessionResponse extends Schema.Class<NewSessionResponse>("AcpNewSessionResponse")({
  sessionId: Schema.String,
}) {}

// ── Prompt ──

export class PromptRequest extends Schema.Class<PromptRequest>("AcpPromptRequest")({
  sessionId: Schema.String,
  prompt: Schema.Array(Schema.Unknown),
}) {}

export const StopReason = Schema.Literals([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
])
export type StopReason = typeof StopReason.Type

export class PromptResponse extends Schema.Class<PromptResponse>("AcpPromptResponse")({
  stopReason: StopReason,
}) {}

export class SessionNotification extends Schema.Class<SessionNotification>(
  "AcpSessionNotification",
)({
  sessionId: Schema.String,
  update: Schema.Unknown,
}) {}

// ── Request Permission (agent → client request) ──

export class PermissionOption extends Schema.Class<PermissionOption>("AcpPermissionOption")({
  optionId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"]),
}) {}

export class RequestPermissionRequest extends Schema.Class<RequestPermissionRequest>(
  "AcpRequestPermissionRequest",
)({
  sessionId: Schema.String,
  toolCall: Schema.Unknown,
  options: Schema.Array(PermissionOption),
}) {}
