import { Option, Schema } from "effect"
import { ExtensionId, MessageId, ToolCallId, ToolId } from "./ids.js"
import { ResourceId, ResourceRevision } from "./resource-graph.js"

/** Revision of the loaded source snapshot that produced a tool binding. */
export const ToolSourceRevision = Schema.NonEmptyString.pipe(Schema.brand("ToolSourceRevision"))
export type ToolSourceRevision = typeof ToolSourceRevision.Type

/** Revision of the schema advertised for a tool binding. */
export const ToolSchemaRevision = Schema.NonEmptyString.pipe(Schema.brand("ToolSchemaRevision"))
export type ToolSchemaRevision = typeof ToolSchemaRevision.Type

/** A resource revision captured by one tool binding. */
export const ToolBindingResource = Schema.Struct({
  id: ResourceId,
  revision: ResourceRevision,
})
export type ToolBindingResource = typeof ToolBindingResource.Type

const canonicalResourceVector = Schema.Array(ToolBindingResource).pipe(
  Schema.check(
    Schema.makeFilter((resources: ReadonlyArray<ToolBindingResource>) => {
      let previous = Option.none<ToolBindingResource>()
      for (const resource of resources) {
        if (Option.isSome(previous) && String(previous.value.id) >= String(resource.id)) {
          return "resource revisions must be sorted by unique resource ID"
        }
        previous = Option.some(resource)
      }
      // oxlint-disable-next-line effect/noNullish -- Schema.makeFilter uses undefined for a valid value.
      return undefined
    }),
  ),
)

/** The source identity for a tool binding.
 *
 * Dynamic registrations are intentionally marked non-replayable. Their
 * process-local registration token is not a durable identity. A process-local
 * static binding is replayable only inside the generation that recorded it.
 */
export const ToolBindingSource = Schema.TaggedUnion({
  Static: {
    sourceRevision: ToolSourceRevision,
  },
  /**
   * A static tool loaded without a build-owned artifact, as in a source run.
   * The revision names one resource generation of one process. It is valid for
   * resume inside that generation and never across a process restart.
   */
  ProcessLocal: {
    sourceRevision: ToolSourceRevision,
  },
  DynamicNonReplayable: {
    sourceRevision: ToolSourceRevision,
  },
})
export type ToolBindingSource = typeof ToolBindingSource.Type

/** JSON-safe identity captured when a tool was advertised. */
export const ToolBindingIdentity = Schema.Struct({
  toolId: ToolId,
  extensionId: ExtensionId,
  source: ToolBindingSource,
  schemaRevision: ToolSchemaRevision,
  resources: canonicalResourceVector,
})
export type ToolBindingIdentity = typeof ToolBindingIdentity.Type

export const validateToolBindingIdentity = Schema.decodeUnknownEffect(ToolBindingIdentity)

/** JSON codec used by the durable binding storage. */
export const ToolBindingIdentityJson = Schema.fromJsonString(ToolBindingIdentity)

export const encodeToolBindingIdentity = Schema.encodeEffect(ToolBindingIdentityJson)
export const decodeToolBindingIdentity = Schema.decodeUnknownEffect(ToolBindingIdentityJson)

const compareResources = (left: ToolBindingResource, right: ToolBindingResource): number => {
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  return 0
}

export const canonicalizeToolBindingIdentity = (
  input: Omit<ToolBindingIdentity, "resources"> & {
    readonly resources: ReadonlyArray<ToolBindingResource>
  },
) => ({
  ...input,
  resources: [...input.resources].sort(compareResources),
})

/** Build an identity with an immutable, canonical resource vector. */
export const makeToolBindingIdentity = (
  input: Omit<ToolBindingIdentity, "resources"> & {
    readonly resources: ReadonlyArray<ToolBindingResource>
  },
): ToolBindingIdentity => ToolBindingIdentity.make(canonicalizeToolBindingIdentity(input))

/** Key for one assistant tool call binding row. */
export const ToolCallBindingKey = Schema.Struct({
  assistantMessageId: MessageId,
  toolCallId: ToolCallId,
})
export type ToolCallBindingKey = typeof ToolCallBindingKey.Type

/** The immutable row already contains a different binding identity. */
export class ToolCallBindingConflictError extends Schema.TaggedError<ToolCallBindingConflictError>()(
  "ToolCallBindingConflictError",
  {
    assistantMessageId: MessageId,
    toolCallId: ToolCallId,
  },
) {}
