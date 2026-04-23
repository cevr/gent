/**
 * Executor extension domain — schemas, errors, result types.
 *
 * Covers settings resolution, sidecar endpoint shape,
 * MCP bridge result/inspection types, and tagged errors.
 */

import { Schema } from "effect"

// ── Settings ──

export const ExecutorMode = Schema.Literals(["local", "remote"])
export type ExecutorMode = typeof ExecutorMode.Type

export const ExecutorSettings = Schema.Struct({
  mode: Schema.optional(ExecutorMode),
  autoStart: Schema.optional(Schema.Boolean),
  remoteUrl: Schema.optional(Schema.String),
  stopLocalOnShutdown: Schema.optional(Schema.Boolean),
})
export type ExecutorSettings = typeof ExecutorSettings.Type

export const ExecutorSettingsDefaults: ResolvedExecutorSettings = {
  mode: "local",
  autoStart: true,
  remoteUrl: "",
  stopLocalOnShutdown: true,
}

export type ResolvedExecutorSettings = Required<ExecutorSettings>

export const resolveSettings = (
  ...layers: ReadonlyArray<ExecutorSettings>
): ResolvedExecutorSettings => {
  let merged: ResolvedExecutorSettings = { ...ExecutorSettingsDefaults }
  for (const layer of layers) {
    if (layer.mode !== undefined) merged = { ...merged, mode: layer.mode }
    if (layer.autoStart !== undefined) merged = { ...merged, autoStart: layer.autoStart }
    if (layer.remoteUrl !== undefined) merged = { ...merged, remoteUrl: layer.remoteUrl }
    if (layer.stopLocalOnShutdown !== undefined)
      merged = { ...merged, stopLocalOnShutdown: layer.stopLocalOnShutdown }
  }
  return merged
}

// ── Endpoint ──

export const ScopeInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  dir: Schema.String,
})
export type ScopeInfo = typeof ScopeInfo.Type

export const ExecutorEndpoint = Schema.Struct({
  mode: ExecutorMode,
  baseUrl: Schema.String,
  ownedByGent: Schema.Boolean,
  scope: ScopeInfo,
})
export type ExecutorEndpoint = typeof ExecutorEndpoint.Type

// ── Errors ──

export class ExecutorSidecarError extends Schema.TaggedErrorClass<ExecutorSidecarError>()(
  "ExecutorSidecarError",
  {
    code: Schema.Literals([
      "PACKAGE_RESOLUTION_FAILED",
      "UNSUPPORTED_PLATFORM",
      "BOOTSTRAP_FAILED",
      "RUNTIME_MISSING",
      "STARTUP_TIMEOUT",
      "SCOPE_MISMATCH",
      "PORT_EXHAUSTED",
    ]),
    message: Schema.String,
  },
) {}

export class ExecutorMcpError extends Schema.TaggedErrorClass<ExecutorMcpError>()(
  "ExecutorMcpError",
  {
    phase: Schema.Literals(["connect", "execute", "resume", "inspect", "close"]),
    message: Schema.String,
  },
) {}

// ── MCP result types ──

/** Normalized tool result from MCP callTool — used by both execute and resume */
export const ExecutorMcpToolResult = Schema.Struct({
  text: Schema.String,
  structuredContent: Schema.Unknown,
  isError: Schema.Boolean,
  executionId: Schema.optional(Schema.String),
})
export type ExecutorMcpToolResult = typeof ExecutorMcpToolResult.Type

/** Structured content from executor — normalized to tagged variants. */
export const ExecutorCompleted = Schema.TaggedStruct("completed", {
  result: Schema.Unknown,
  logs: Schema.Array(Schema.String),
})

export const ExecutorFailed = Schema.TaggedStruct("error", {
  error: Schema.String,
  logs: Schema.Array(Schema.String),
})

export const ExecutorInteraction = Schema.Union([
  Schema.TaggedStruct("form", {
    message: Schema.String,
    requestedSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  Schema.TaggedStruct("url", {
    message: Schema.String,
    url: Schema.String,
  }),
])
export type ExecutorInteraction = typeof ExecutorInteraction.Type

export const ExecutorWaitingForInteraction = Schema.TaggedStruct("waiting_for_interaction", {
  executionId: Schema.String,
  interaction: ExecutorInteraction,
})
export type ExecutorWaitingForInteraction = typeof ExecutorWaitingForInteraction.Type

export const ExecutorStructuredContent = Schema.Union([
  ExecutorCompleted,
  ExecutorFailed,
  ExecutorWaitingForInteraction,
])
export type ExecutorStructuredContent = typeof ExecutorStructuredContent.Type

/** MCP server info from listTools + getInstructions */
export const ExecutorMcpToolInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
})

export const ExecutorMcpInspection = Schema.Struct({
  instructions: Schema.optional(Schema.String),
  tools: Schema.Array(ExecutorMcpToolInfo),
})
export type ExecutorMcpInspection = typeof ExecutorMcpInspection.Type

export const ResumeAction = Schema.Literals(["accept", "decline", "cancel"])
export type ResumeAction = typeof ResumeAction.Type

// ── Constants ──

export const EXECUTOR_EXTENSION_ID = "@gent/executor"

export const DEFAULT_PORT_SEED = 4788
export const PORT_SCAN_LIMIT = 32
export const HEALTH_TIMEOUT_MS = 2_000
export const STARTUP_TIMEOUT_MS = 30_000
export const SHUTDOWN_TIMEOUT_MS = 2_000
