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

// ── Content Blocks (discriminated on `type`, not `_tag` — matches ACP wire format) ──

export class TextContent extends Schema.Class<TextContent>("AcpTextContent")({
  type: Schema.Literal("text"),
  text: Schema.String,
}) {}

export class ImageContent extends Schema.Class<ImageContent>("AcpImageContent")({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
}) {}

export type ContentBlock = TextContent | ImageContent

// ── MCP Server Config ──

export class McpEnvVar extends Schema.Class<McpEnvVar>("AcpMcpEnvVar")({
  name: Schema.String,
  value: Schema.String,
}) {}

export class McpServerStdio extends Schema.Class<McpServerStdio>("AcpMcpServerStdio")({
  name: Schema.String,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(McpEnvVar)),
}) {}

export class McpHeaderEntry extends Schema.Class<McpHeaderEntry>("AcpMcpHeaderEntry")({
  name: Schema.String,
  value: Schema.String,
}) {}

export class McpServerHttp extends Schema.Class<McpServerHttp>("AcpMcpServerHttp")({
  type: Schema.Literal("http"),
  name: Schema.String,
  url: Schema.String,
  headers: Schema.optional(Schema.Array(McpHeaderEntry)),
}) {}

export class McpServerSse extends Schema.Class<McpServerSse>("AcpMcpServerSse")({
  type: Schema.Literal("sse"),
  name: Schema.String,
  url: Schema.String,
  headers: Schema.optional(Schema.Array(McpHeaderEntry)),
}) {}

export type McpServer = McpServerStdio | McpServerHttp | McpServerSse

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
  protocolVersion: Schema.optional(Schema.Number),
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
  protocolVersion: Schema.Number,
  agentCapabilities: Schema.optional(AgentCapabilities),
  agentInfo: Schema.optional(Implementation),
}) {}

// ── Session ──

export class NewSessionRequest extends Schema.Class<NewSessionRequest>("AcpNewSessionRequest")({
  cwd: Schema.String,
  mcpServers: Schema.optional(Schema.Array(Schema.Unknown)),
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

// ── Cancel (notification — no response) ──

export class CancelNotification extends Schema.Class<CancelNotification>("AcpCancelNotification")({
  sessionId: Schema.String,
}) {}

// ── Session Update Notifications ──

export class ContentChunkUpdate extends Schema.Class<ContentChunkUpdate>("AcpContentChunkUpdate")({
  sessionUpdate: Schema.Literals(["agent_message_chunk", "agent_thought_chunk"]),
  content: Schema.Unknown,
}) {}

export class ToolCallNotification extends Schema.Class<ToolCallNotification>(
  "AcpToolCallNotification",
)({
  sessionUpdate: Schema.Literal("tool_call"),
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}) {}

export class ToolCallUpdateNotification extends Schema.Class<ToolCallUpdateNotification>(
  "AcpToolCallUpdateNotification",
)({
  sessionUpdate: Schema.Literal("tool_call_update"),
  toolCallId: Schema.String,
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
}) {}

/** Discriminate on sessionUpdate field. We only care about these variants. */
export const SessionUpdate = Schema.Union([
  ContentChunkUpdate,
  ToolCallNotification,
  ToolCallUpdateNotification,
])
export type SessionUpdate = typeof SessionUpdate.Type

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

export class PermissionOutcomeSelected extends Schema.Class<PermissionOutcomeSelected>(
  "AcpPermissionOutcomeSelected",
)({
  outcome: Schema.Literal("selected"),
  optionId: Schema.String,
}) {}

export class PermissionOutcomeCancelled extends Schema.Class<PermissionOutcomeCancelled>(
  "AcpPermissionOutcomeCancelled",
)({
  outcome: Schema.Literal("cancelled"),
}) {}

export const PermissionOutcome = Schema.Union([
  PermissionOutcomeSelected,
  PermissionOutcomeCancelled,
])
export type PermissionOutcome = typeof PermissionOutcome.Type
