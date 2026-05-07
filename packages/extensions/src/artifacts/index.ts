/**
 * Artifacts extension — generic artifact store with typed request RPCs.
 *
 * Agent tools use `ArtifactsRead` / `ArtifactsWrite` directly. `ArtifactRpc`
 * remains the public/client transport surface.
 */

import { Effect, Schema } from "effect"
import {
  ArtifactId,
  defineExtension,
  defineResource,
  tool,
  ToolNeeds,
  type ToolCapabilityContext,
} from "@gent/core/extensions/api"
import { ARTIFACTS_EXTENSION_ID, ArtifactRpc, ReadQuery } from "../artifacts-protocol.js"
import { ArtifactsRead, ArtifactsStoreLive, ArtifactsWrite } from "./store.js"

export { ARTIFACTS_EXTENSION_ID } from "../artifacts-protocol.js"

// ── Agent-facing tools ──

const ArtifactSaveParams = Schema.Struct({
  label: Schema.String.annotate({ description: "Short label for display" }),
  sourceTool: Schema.String.annotate({ description: "Tool that produced this artifact" }),
  content: Schema.String.annotate({ description: "Full artifact content" }),
  path: Schema.optional(Schema.String.annotate({ description: "File path if saved to disk" })),
  metadata: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "Tool-specific structured data",
    }),
  ),
})

const ArtifactSaveResult = Schema.Struct({
  id: ArtifactId,
  label: Schema.String,
  sourceTool: Schema.String,
})

const ArtifactSaveTool = tool({
  id: "artifact_save",
  description:
    "Save an artifact (plan, audit report, review, or any structured result). Upserts by sourceTool + branch.",
  params: ArtifactSaveParams,
  output: ArtifactSaveResult,
  execute: Effect.fn("ArtifactSaveTool.execute")(function* (params, ctx: ToolCapabilityContext) {
    const artifacts = yield* ArtifactsWrite
    const artifact = yield* artifacts.save(ctx.sessionId, ctx.branchId, params)
    return { id: artifact.id, label: artifact.label, sourceTool: artifact.sourceTool }
  }),
})

const ArtifactReadParams = Schema.Struct({
  id: Schema.optional(Schema.String.annotate({ description: "Artifact ID (if known)" })),
  sourceTool: Schema.optional(
    Schema.String.annotate({ description: "Source tool name to look up by" }),
  ),
})

const ArtifactReadResult = Schema.Struct({
  found: Schema.Boolean,
  id: Schema.optional(ArtifactId),
  label: Schema.optional(Schema.String),
  sourceTool: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["active", "resolved"])),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  branchId: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
})

const ArtifactReadTool = tool({
  id: "artifact_read",
  description: "Read the full content of an artifact by label/source or ID.",
  params: ArtifactReadParams,
  output: ArtifactReadResult,
  execute: Effect.fn("ArtifactReadTool.execute")(function* (params, ctx: ToolCapabilityContext) {
    const query =
      params.id !== undefined
        ? ReadQuery.ById.make({ id: ArtifactId.make(params.id) })
        : ReadQuery.BySource.make({ sourceTool: params.sourceTool ?? "", branchId: ctx.branchId })
    const artifacts = yield* ArtifactsRead
    const artifact = yield* artifacts.read(ctx.sessionId, ctx.branchId, query)
    if (artifact === null) return { found: false }
    return { found: true, ...artifact }
  }),
})

const ArtifactUpdateParams = Schema.Struct({
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
})

const ArtifactUpdateResult = Schema.Struct({
  found: Schema.Boolean,
  id: Schema.optional(ArtifactId),
  label: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["active", "resolved"])),
})

const ArtifactUpdateTool = tool({
  id: "artifact_update",
  needs: [ToolNeeds.write("artifact")],
  description:
    "Update an existing artifact. Supports content patches (find/replace), metadata updates, status changes, and label renames.",
  params: ArtifactUpdateParams,
  output: ArtifactUpdateResult,
  execute: Effect.fn("ArtifactUpdateTool.execute")(function* (params, ctx: ToolCapabilityContext) {
    const patch =
      params.find !== undefined && params.replace !== undefined
        ? { find: params.find, replace: params.replace, replaceAll: params.replaceAll }
        : undefined
    const artifacts = yield* ArtifactsWrite
    const artifact = yield* artifacts.update(ctx.sessionId, ctx.branchId, {
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

const ArtifactClearParams = Schema.Struct({
  id: Schema.String.annotate({ description: "Artifact ID to remove" }),
})

const ArtifactClearResult = Schema.Struct({
  cleared: Schema.Boolean,
})

const ArtifactClearTool = tool({
  id: "artifact_clear",
  description: "Remove an artifact by ID.",
  params: ArtifactClearParams,
  output: ArtifactClearResult,
  execute: Effect.fn("ArtifactClearTool.execute")(function* (params, ctx: ToolCapabilityContext) {
    const artifacts = yield* ArtifactsWrite
    yield* artifacts.clear(ctx.sessionId, ctx.branchId, ArtifactId.make(params.id))
    return { cleared: true }
  }),
})

// ── Extension ──

export const ArtifactsExtension = defineExtension({
  id: ARTIFACTS_EXTENSION_ID,
  resources: [defineResource({ scope: "process", layer: ArtifactsStoreLive })],
  requests: [
    ArtifactRpc.Save,
    ArtifactRpc.Read,
    ArtifactRpc.Update,
    ArtifactRpc.Clear,
    ArtifactRpc.List,
  ],
  tools: [ArtifactSaveTool, ArtifactReadTool, ArtifactUpdateTool, ArtifactClearTool],
})
