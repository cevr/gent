import { Schema } from "effect"
import { ExtensionId, MessageId, ToolCallId, ToolId } from "./ids.js"

/** Revision of the loaded source snapshot that produced a tool binding. */
export const ToolSourceRevision = Schema.NonEmptyString.pipe(Schema.brand("ToolSourceRevision"))
export type ToolSourceRevision = typeof ToolSourceRevision.Type

/** Revision of the schema advertised for a tool binding. */
export const ToolSchemaRevision = Schema.NonEmptyString.pipe(Schema.brand("ToolSchemaRevision"))
export type ToolSchemaRevision = typeof ToolSchemaRevision.Type

/** The source identity for a tool binding.
 *
 * A static binding names a build artifact and replays across processes. A
 * process-local binding is replayable only inside the process that recorded it.
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
})
export type ToolBindingSource = typeof ToolBindingSource.Type

/** JSON-safe identity captured when a tool was advertised. */
export const ToolBindingIdentity = Schema.Struct({
  toolId: ToolId,
  extensionId: ExtensionId,
  source: ToolBindingSource,
  schemaRevision: ToolSchemaRevision,
})
export type ToolBindingIdentity = typeof ToolBindingIdentity.Type

export const validateToolBindingIdentity = Schema.decodeUnknownEffect(ToolBindingIdentity)

/** JSON codec used by the durable binding storage. */
const ToolBindingIdentityJson = Schema.fromJsonString(ToolBindingIdentity)

export const encodeToolBindingIdentity = Schema.encodeEffect(ToolBindingIdentityJson)
export const decodeToolBindingIdentity = Schema.decodeUnknownEffect(ToolBindingIdentityJson)

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
