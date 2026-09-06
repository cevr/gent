import { Schema } from "effect"
import { ExtensionId, RequestId } from "./ids.js"
import { ResourceDescriptor, type ResourceId } from "./resource-graph.js"
import { WorkspaceId } from "../server/workspace-rpc.js"

/** A canonical path used as one durable resource-graph owner key. */
export const CanonicalCwd = Schema.NonEmptyString.pipe(Schema.brand("CanonicalCwd"))
export type CanonicalCwd = typeof CanonicalCwd.Type

/** Revision of the JSON-safe source snapshot that produced a desired graph. */
export const ResourceGraphRevision = Schema.NonEmptyString.pipe(
  Schema.brand("ResourceGraphRevision"),
)
export type ResourceGraphRevision = typeof ResourceGraphRevision.Type

/** A monotonic desired-graph sequence within one durable owner key. */
export const ResourceGraphSequence = Schema.Natural
export type ResourceGraphSequence = typeof ResourceGraphSequence.Type

/** One loaded extension identity captured without its runtime contribution values. */
export const ResourceGraphExtensionSource = Schema.Struct({
  extensionId: ExtensionId,
  scope: Schema.Literals(["builtin", "user", "project"]),
  version: Schema.optional(Schema.String),
  source: Schema.NonEmptyString,
})
export type ResourceGraphExtensionSource = typeof ResourceGraphExtensionSource.Type

/** JSON-safe loaded source and configuration inputs for one desired graph. */
export const ResourceGraphSource = Schema.Struct({
  revision: ResourceGraphRevision,
  config: Schema.Json,
  extensions: Schema.Array(ResourceGraphExtensionSource),
})
export type ResourceGraphSource = typeof ResourceGraphSource.Type

/** Explicit declaration data. Runtime layers, scopes, contexts, and effects are absent. */
export const ResourceGraphSnapshot = Schema.Struct({
  source: ResourceGraphSource,
  descriptors: Schema.Array(ResourceDescriptor),
})
export type ResourceGraphSnapshot = typeof ResourceGraphSnapshot.Type

/** Durable owner key. Callers must resolve `cwd` before constructing this value. */
export const ResourceGraphKey = Schema.Struct({
  workspaceId: WorkspaceId,
  cwd: CanonicalCwd,
})
export type ResourceGraphKey = typeof ResourceGraphKey.Type

/** One desired graph command and its optimistic-concurrency expectation. */
export const ResourceGraphDesiredCommand = Schema.Struct({
  ...ResourceGraphKey.fields,
  commandId: RequestId,
  expectedRevision: Schema.optional(ResourceGraphRevision),
  desiredRevision: ResourceGraphRevision,
  snapshot: ResourceGraphSnapshot,
})
export type ResourceGraphDesiredCommand = typeof ResourceGraphDesiredCommand.Type

/** Receipt key shared by applying, applied, and failed transitions. */
export const ResourceGraphReceiptKey = Schema.Struct({
  ...ResourceGraphKey.fields,
  desiredRevision: ResourceGraphRevision,
  desiredSequence: ResourceGraphSequence,
})
export type ResourceGraphReceiptKey = typeof ResourceGraphReceiptKey.Type

/** Immutable acceptance receipt for one desired command. */
export const ResourceGraphDesiredReceipt = Schema.Struct({
  ...ResourceGraphReceiptKey.fields,
  commandId: RequestId,
})
export type ResourceGraphDesiredReceipt = typeof ResourceGraphDesiredReceipt.Type

/** A successful application receipt always applies its desired revision. */
export const ResourceGraphAppliedReceipt = ResourceGraphReceiptKey
export type ResourceGraphAppliedReceipt = typeof ResourceGraphAppliedReceipt.Type

export const ResourceGraphFailure = Schema.Struct({
  message: Schema.String,
})
export type ResourceGraphFailure = typeof ResourceGraphFailure.Type

export const ResourceGraphFailedReceipt = Schema.Struct({
  ...ResourceGraphReceiptKey.fields,
  failure: ResourceGraphFailure,
})
export type ResourceGraphFailedReceipt = typeof ResourceGraphFailedReceipt.Type

export const ResourceGraphStatusState = Schema.Literals([
  "pending",
  "applying",
  "applied",
  "failed",
])
export type ResourceGraphStatusState = typeof ResourceGraphStatusState.Type

/**
 * Durable desired/applied projection for one `(workspaceId, cwd)` owner.
 *
 * `appliedRevision` records the last successful application. It does not
 * assert that the current process still owns a live scope. A restart must
 * reacquire live resources even when desired and applied revisions match.
 */
export const ResourceGraphStatus = Schema.Struct({
  ...ResourceGraphKey.fields,
  commandId: RequestId,
  desiredRevision: ResourceGraphRevision,
  desiredSequence: ResourceGraphSequence,
  snapshot: ResourceGraphSnapshot,
  appliedRevision: Schema.optional(ResourceGraphRevision),
  appliedSequence: Schema.optional(ResourceGraphSequence),
  state: ResourceGraphStatusState,
  failure: Schema.optional(ResourceGraphFailure),
})
export type ResourceGraphStatus = typeof ResourceGraphStatus.Type

export const ResourceGraphSnapshotJson = Schema.fromJsonString(ResourceGraphSnapshot)
export const ResourceGraphDesiredCommandJson = Schema.fromJsonString(ResourceGraphDesiredCommand)
export const ResourceGraphFailureJson = Schema.fromJsonString(ResourceGraphFailure)

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const canonicalResourceIds = (ids: ReadonlyArray<ResourceId>): ReadonlyArray<ResourceId> => {
  const unique = new Map<ResourceId, ResourceId>()
  for (const id of ids) unique.set(id, id)
  return [...unique.values()].sort(compareStrings)
}

const canonicalDescriptor = (descriptor: ResourceDescriptor): ResourceDescriptor =>
  ResourceDescriptor.make({
    id: descriptor.id,
    revision: descriptor.revision,
    requires: canonicalResourceIds(descriptor.requires),
    required: descriptor.required,
  })

const canonicalSource = (source: ResourceGraphSource): ResourceGraphSource => ({
  ...source,
  // Declaration order is part of catalog precedence. Canonical JSON handles
  // object-key order at persistence without reordering this array.
  extensions: [...source.extensions],
})

/** Canonicalize JSON-safe source and descriptor ordering before persistence. */
export const canonicalizeResourceGraphSnapshot = (
  snapshot: ResourceGraphSnapshot,
): ResourceGraphSnapshot => ({
  source: canonicalSource(snapshot.source),
  descriptors: [...snapshot.descriptors]
    .map(canonicalDescriptor)
    .sort((left, right) => compareStrings(left.id, right.id)),
})

/** Canonicalize a desired command without introducing runtime values. */
export const canonicalizeResourceGraphDesiredCommand = (
  command: ResourceGraphDesiredCommand,
): ResourceGraphDesiredCommand => ({
  ...command,
  snapshot: canonicalizeResourceGraphSnapshot(command.snapshot),
})

export class ResourceGraphCommandConflictError extends Schema.TaggedError<ResourceGraphCommandConflictError>()(
  "ResourceGraphCommandConflictError",
  {
    workspaceId: WorkspaceId,
    cwd: CanonicalCwd,
    commandId: RequestId,
  },
) {}

export class ResourceGraphExpectedRevisionError extends Schema.TaggedError<ResourceGraphExpectedRevisionError>()(
  "ResourceGraphExpectedRevisionError",
  {
    workspaceId: WorkspaceId,
    cwd: CanonicalCwd,
  },
) {}

export class ResourceGraphStaleReceiptError extends Schema.TaggedError<ResourceGraphStaleReceiptError>()(
  "ResourceGraphStaleReceiptError",
  {
    workspaceId: WorkspaceId,
    cwd: CanonicalCwd,
    desiredRevision: ResourceGraphRevision,
    desiredSequence: ResourceGraphSequence,
  },
) {}
