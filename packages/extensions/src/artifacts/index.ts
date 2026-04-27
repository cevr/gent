/**
 * Artifacts extension — generic artifact store with typed protocol.
 *
 * Any tool/extension can store artifacts via
 * `ctx.extension.ask(ArtifactProtocol.Save.make(...))`. Artifacts are
 * branch-aware, persist within a session, and project compact summaries
 * into the system prompt.
 *
 * The store lives on a `Behavior` actor (W10-1d). Tool envelopes route
 * to the mailbox via the actor-route fallback — `ArtifactProtocol.X`
 * `_tag`s match `ArtifactsMsg.X` `_tag`s.
 */

import { Effect, Schema } from "effect"
import { ArtifactId, defineExtension, tool, type ToolContext } from "@gent/core/extensions/api"
import { ARTIFACTS_EXTENSION_ID, ArtifactProtocol } from "../artifacts-protocol.js"
import { artifactsActor } from "./actor.js"

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
    const artifact = yield* ctx.extension.ask(
      ArtifactProtocol.Save.make({
        ...params,
        branchId: ctx.branchId,
      }),
      ctx.branchId,
    )
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
    const artifact = yield* ctx.extension.ask(ArtifactProtocol.Read.make({ query }), ctx.branchId)
    if (artifact === null) return { found: false }
    return { found: true, ...artifact }
  }),
})

const ArtifactUpdateTool = tool({
  id: "artifact_update",
  resources: ["artifact_update"],
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
    const artifact = yield* ctx.extension.ask(
      ArtifactProtocol.Update.make({
        id: ArtifactId.make(params.id),
        patch,
        status: params.status,
        label: params.label,
        metadata: params.metadata,
      }),
      ctx.branchId,
    )
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
    yield* ctx.extension.ask(
      ArtifactProtocol.Clear.make({ id: ArtifactId.make(params.id) }),
      ctx.branchId,
    )
    return { cleared: true }
  }),
})

// ── Extension ──

export const ArtifactsExtension = defineExtension({
  id: ARTIFACTS_EXTENSION_ID,
  actors: [artifactsActor],
  protocols: ArtifactProtocol,
  tools: [ArtifactSaveTool, ArtifactReadTool, ArtifactUpdateTool, ArtifactClearTool],
})
