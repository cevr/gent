/**
 * Artifacts extension — generic artifact store with typed request RPCs.
 *
 * Any tool/extension can store artifacts via
 * `ctx.extension.request(ref(ArtifactRpc.Save), ...)`. Artifacts are
 * branch-aware, persist within a session, and project compact summaries
 * into the system prompt.
 */

import { Effect, Schema } from "effect"
import {
  ArtifactId,
  defineExtension,
  defineResource,
  ref,
  tool,
  ToolNeeds,
  type ToolContext,
} from "@gent/core/extensions/api"
import { ARTIFACTS_EXTENSION_ID, ArtifactRpc } from "../artifacts-protocol.js"
import { ArtifactsStoreLive } from "./store.js"

export { ARTIFACTS_EXTENSION_ID } from "../artifacts-protocol.js"

// ── Agent-facing tools ──

const ArtifactSaveTool = tool({
  id: "artifact_save",
  description:
    "Save an artifact (plan, audit report, review, or any structured result). Upserts by sourceTool + branch.",
  params: Schema.Struct({
    label: Schema.String.annotate({ description: "Short label for display" }),
    sourceTool: Schema.String.annotate({ description: "Tool that produced this artifact" }),
    content: Schema.String.annotate({ description: "Full artifact content" }),
    path: Schema.optional(Schema.String.annotate({ description: "File path if saved to disk" })),
    metadata: Schema.optional(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "Tool-specific structured data",
      }),
    ),
  }),
  execute: Effect.fn("ArtifactSaveTool.execute")(function* (params, ctx: ToolContext) {
    const artifact = yield* ctx.extension.request(ref(ArtifactRpc.Save), {
      ...params,
      branchId: ctx.branchId,
    })
    return { id: artifact.id, label: artifact.label, sourceTool: artifact.sourceTool }
  }),
})

const ArtifactReadTool = tool({
  id: "artifact_read",
  description: "Read the full content of an artifact by label/source or ID.",
  params: Schema.Struct({
    id: Schema.optional(Schema.String.annotate({ description: "Artifact ID (if known)" })),
    sourceTool: Schema.optional(
      Schema.String.annotate({ description: "Source tool name to look up by" }),
    ),
  }),
  execute: Effect.fn("ArtifactReadTool.execute")(function* (params, ctx: ToolContext) {
    const query =
      params.id !== undefined
        ? { _tag: "ById" as const, id: ArtifactId.make(params.id) }
        : { _tag: "BySource" as const, sourceTool: params.sourceTool ?? "", branchId: ctx.branchId }
    const artifact = yield* ctx.extension.request(ref(ArtifactRpc.Read), { query })
    if (artifact === null) return { found: false }
    return { found: true, ...artifact }
  }),
})

const ArtifactUpdateTool = tool({
  id: "artifact_update",
  needs: [ToolNeeds.write("artifact")],
  description:
    "Update an existing artifact. Supports content patches (find/replace), metadata updates, status changes, and label renames.",
  params: Schema.Struct({
    id: Schema.String.annotate({ description: "Artifact ID to update" }),
    find: Schema.optional(Schema.String.annotate({ description: "Text to find in content" })),
    replace: Schema.optional(Schema.String.annotate({ description: "Replacement text" })),
    replaceAll: Schema.optional(
      Schema.Boolean.annotate({ description: "Replace all occurrences (default: first only)" }),
    ),
    status: Schema.optional(
      Schema.Literals(["active", "resolved"]).annotate({ description: "New status" }),
    ),
    label: Schema.optional(Schema.String.annotate({ description: "New label" })),
    metadata: Schema.optional(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "New metadata (replaces existing)",
      }),
    ),
  }),
  execute: Effect.fn("ArtifactUpdateTool.execute")(function* (params, ctx: ToolContext) {
    const patch =
      params.find !== undefined && params.replace !== undefined
        ? { find: params.find, replace: params.replace, replaceAll: params.replaceAll }
        : undefined
    const artifact = yield* ctx.extension.request(ref(ArtifactRpc.Update), {
      id: ArtifactId.make(params.id),
      patch,
      status: params.status,
      label: params.label,
      metadata: params.metadata,
    })
    if (artifact === null) return { found: false }
    return { found: true, id: artifact.id, label: artifact.label, status: artifact.status }
  }),
})

const ArtifactClearTool = tool({
  id: "artifact_clear",
  description: "Remove an artifact by ID.",
  params: Schema.Struct({
    id: Schema.String.annotate({ description: "Artifact ID to remove" }),
  }),
  execute: Effect.fn("ArtifactClearTool.execute")(function* (params, ctx: ToolContext) {
    yield* ctx.extension.request(ref(ArtifactRpc.Clear), { id: ArtifactId.make(params.id) })
    return { cleared: true }
  }),
})

// ── Extension ──

export const ArtifactsExtension = defineExtension({
  id: ARTIFACTS_EXTENSION_ID,
  resources: [defineResource({ scope: "process", layer: ArtifactsStoreLive })],
  rpc: [
    ArtifactRpc.Save,
    ArtifactRpc.Read,
    ArtifactRpc.Update,
    ArtifactRpc.Clear,
    ArtifactRpc.List,
  ],
  tools: [ArtifactSaveTool, ArtifactReadTool, ArtifactUpdateTool, ArtifactClearTool],
})
