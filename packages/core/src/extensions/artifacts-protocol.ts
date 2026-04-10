import { Schema } from "effect"
import { ExtensionMessage } from "../domain/extension-protocol.js"
import { ArtifactId, BranchId } from "../domain/ids.js"

export const ARTIFACTS_EXTENSION_ID = "@gent/artifacts"

// ── Artifact schema ──

export const ArtifactStatus = Schema.Literals(["active", "resolved"])
export type ArtifactStatus = typeof ArtifactStatus.Type

export const Artifact = Schema.Struct({
  id: ArtifactId,
  label: Schema.String,
  sourceTool: Schema.String,
  content: Schema.String,
  path: Schema.optional(Schema.String),
  status: ArtifactStatus,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  branchId: Schema.optional(BranchId),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type Artifact = typeof Artifact.Type

// ── Content patch ──

export const ContentPatch = Schema.Struct({
  find: Schema.String,
  replace: Schema.String,
  replaceAll: Schema.optional(Schema.Boolean),
})
export type ContentPatch = typeof ContentPatch.Type

// ── Read discriminated union: by id OR by sourceTool ──

export const ReadById = Schema.TaggedStruct("ById", { id: ArtifactId })
export const ReadBySource = Schema.TaggedStruct("BySource", {
  sourceTool: Schema.String,
  branchId: Schema.optional(BranchId),
})
export const ReadQuery = Schema.Union([ReadById, ReadBySource])

// ── UI snapshot ──

export const ArtifactEntry = Schema.Struct({
  id: ArtifactId,
  label: Schema.String,
  sourceTool: Schema.String,
  status: ArtifactStatus,
  path: Schema.optional(Schema.String),
  branchId: Schema.optional(BranchId),
  createdAt: Schema.Number,
})
export type ArtifactEntry = typeof ArtifactEntry.Type

export const ArtifactUiModel = Schema.Struct({
  items: Schema.Array(ArtifactEntry),
})
export type ArtifactUiModel = typeof ArtifactUiModel.Type

// ── Protocol ──

export const ArtifactProtocol = {
  Save: ExtensionMessage.reply(
    ARTIFACTS_EXTENSION_ID,
    "Save",
    {
      label: Schema.String,
      sourceTool: Schema.String,
      content: Schema.String,
      path: Schema.optional(Schema.String),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      branchId: Schema.optional(BranchId),
    },
    Artifact,
  ),
  Read: ExtensionMessage.reply(
    ARTIFACTS_EXTENSION_ID,
    "Read",
    {
      query: ReadQuery,
    },
    Schema.NullOr(Artifact),
  ),
  Update: ExtensionMessage.reply(
    ARTIFACTS_EXTENSION_ID,
    "Update",
    {
      id: ArtifactId,
      patch: Schema.optional(ContentPatch),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      status: Schema.optional(ArtifactStatus),
      label: Schema.optional(Schema.String),
    },
    Schema.NullOr(Artifact),
  ),
  Clear: ExtensionMessage.reply(
    ARTIFACTS_EXTENSION_ID,
    "Clear",
    {
      id: ArtifactId,
    },
    Schema.Void,
  ),
  List: ExtensionMessage.reply(
    ARTIFACTS_EXTENSION_ID,
    "List",
    {
      branchId: Schema.optional(BranchId),
    },
    Schema.Array(Artifact),
  ),
}
