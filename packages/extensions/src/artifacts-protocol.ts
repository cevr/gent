import { Effect, Schema } from "effect"
import { ExtensionId, ArtifactId, BranchId, request } from "@gent/core/extensions/api"
import { ArtifactsRead, ArtifactsWrite } from "./artifacts/store.js"

export const ARTIFACTS_EXTENSION_ID = ExtensionId.make("@gent/artifacts")

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
export type ReadQuery = typeof ReadQuery.Type

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

// ── RPC ──

export const ArtifactRpc = {
  Save: request({
    id: "artifact.save",
    extensionId: ARTIFACTS_EXTENSION_ID,
    intent: "write",
    input: Schema.Struct({
      label: Schema.String,
      sourceTool: Schema.String,
      content: Schema.String,
      path: Schema.optional(Schema.String),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      branchId: Schema.optional(BranchId),
    }),
    output: Artifact,
    execute: Effect.fn("ArtifactRpc.Save")(function* (input, ctx) {
      const artifacts = yield* ArtifactsWrite
      return yield* artifacts.save(ctx.sessionId, ctx.branchId, input)
    }),
  }),
  Read: request({
    id: "artifact.read",
    extensionId: ARTIFACTS_EXTENSION_ID,
    intent: "read",
    input: Schema.Struct({ query: ReadQuery }),
    output: Schema.NullOr(Artifact),
    execute: Effect.fn("ArtifactRpc.Read")(function* ({ query }, ctx) {
      const artifacts = yield* ArtifactsRead
      return yield* artifacts.read(ctx.sessionId, ctx.branchId, query)
    }),
  }),
  Update: request({
    id: "artifact.update",
    extensionId: ARTIFACTS_EXTENSION_ID,
    intent: "write",
    input: Schema.Struct({
      id: ArtifactId,
      patch: Schema.optional(ContentPatch),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      status: Schema.optional(ArtifactStatus),
      label: Schema.optional(Schema.String),
    }),
    output: Schema.NullOr(Artifact),
    execute: Effect.fn("ArtifactRpc.Update")(function* (input, ctx) {
      const artifacts = yield* ArtifactsWrite
      return yield* artifacts.update(ctx.sessionId, ctx.branchId, input)
    }),
  }),
  Clear: request({
    id: "artifact.clear",
    extensionId: ARTIFACTS_EXTENSION_ID,
    intent: "write",
    input: Schema.Struct({ id: ArtifactId }),
    output: Schema.Void,
    execute: Effect.fn("ArtifactRpc.Clear")(function* ({ id }, ctx) {
      const artifacts = yield* ArtifactsWrite
      yield* artifacts.clear(ctx.sessionId, ctx.branchId, id)
    }),
  }),
  List: request({
    id: "artifact.list",
    extensionId: ARTIFACTS_EXTENSION_ID,
    intent: "read",
    input: Schema.Struct({ branchId: Schema.optional(BranchId) }),
    output: Schema.Array(Artifact),
    execute: Effect.fn("ArtifactRpc.List")(function* (_input, ctx) {
      const artifacts = yield* ArtifactsRead
      return yield* artifacts.list(ctx.sessionId, ctx.branchId)
    }),
  }),
}
