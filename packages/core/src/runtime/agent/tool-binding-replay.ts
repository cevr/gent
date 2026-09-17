import { canonicalJsonString } from "effect-encore"
import { Effect, Option, Predicate, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import type { LoadedExtension } from "../../domain/extension.js"
import type { ProcessGenerationId } from "../../domain/process-generation.js"
import {
  ToolBindingIdentity,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "../../domain/tool-binding.js"
import type { MessageId, ToolCallId, ToolId } from "../../domain/ids.js"
import { getToolId, type ToolCapability } from "../../domain/capability/tool.js"
import type { ResolvedToolCapability } from "./tool-runner.js"
import { GentPlatform } from "../gent-platform.js"

export type ToolBindingReplayReason =
  | "MissingBinding"
  | "ToolUnavailable"
  | "MissingSourceIdentity"
  | "SourceMismatch"
  | "SchemaMismatch"

export class ToolBindingReplayError extends Schema.TaggedError<ToolBindingReplayError>()(
  "ToolBindingReplayError",
  {
    assistantMessageId: Schema.String,
    toolCallId: Schema.String,
    toolId: Schema.String,
    reason: Schema.Literals([
      "MissingBinding",
      "ToolUnavailable",
      "MissingSourceIdentity",
      "SourceMismatch",
      "SchemaMismatch",
    ]),
    message: Schema.String,
  },
) {}

const advertisedSchemaJson = (tool: ToolCapability): string =>
  canonicalJsonString(
    Schema.decodeUnknownSync(Schema.Json)({
      name: String(getToolId(tool)),
      description: tool.description,
      parameters: AiTool.getJsonSchema(tool),
    }),
  )

const schemaRevisionFor = (tool: ToolCapability) =>
  Effect.map(GentPlatform, (platform) =>
    ToolSchemaRevision.make(`schema:${platform.hash("sha256", advertisedSchemaJson(tool))}`),
  )

const sourceRevisionFor = (extension: LoadedExtension): Option.Option<ToolSourceRevision> => {
  if (Predicate.isUndefined(extension.artifactIdentity)) return Option.none()
  const sourceParts = [
    "artifact",
    extension.artifactIdentity,
    extension.scope,
    extension.sourcePath,
    extension.manifest.id,
  ]
  return Option.some(ToolSourceRevision.make(sourceParts.join(":")))
}

/** Attach the durable identity available for one freshly selected capability. */
export const attachToolBindingIdentity = Effect.fn("ToolBinding.attachIdentity")(function* (
  entry: ResolvedToolCapability,
  extensions: ReadonlyArray<LoadedExtension>,
) {
  const extension = extensions.find((candidate) => candidate.manifest.id === entry.extensionId)
  let sourceRevision = Option.none<ToolSourceRevision>()
  if (Predicate.isNotUndefined(extension)) {
    const revision = sourceRevisionFor(extension)
    if (Option.isSome(revision)) sourceRevision = revision
  }
  if (Option.isNone(sourceRevision)) return entry

  const source = ToolBindingSource.cases.Static.make({ sourceRevision: sourceRevision.value })
  const binding = ToolBindingIdentity.make({
    toolId: getToolId(entry.capability),
    extensionId: entry.extensionId,
    source,
    schemaRevision: yield* schemaRevisionFor(entry.capability),
  })
  return { ...entry, binding }
})

/** Identity for a static tool without a build artifact. It names one process generation. */
export const processLocalToolBindingIdentity = Effect.fn("ToolBinding.processLocalIdentity")(
  function* (entry: ResolvedToolCapability, generationId: ProcessGenerationId) {
    if (Predicate.isNotUndefined(entry.binding)) return Option.none<ToolBindingIdentity>()
    return Option.some(
      ToolBindingIdentity.make({
        toolId: getToolId(entry.capability),
        extensionId: entry.extensionId,
        source: ToolBindingSource.cases.ProcessLocal.make({
          sourceRevision: ToolSourceRevision.make(`process:${generationId}`),
        }),
        schemaRevision: yield* schemaRevisionFor(entry.capability),
      }),
    )
  },
)

export const sameToolBindingIdentity = (
  left: ToolBindingIdentity,
  right: ToolBindingIdentity,
): boolean =>
  left.toolId === right.toolId &&
  left.extensionId === right.extensionId &&
  left.schemaRevision === right.schemaRevision &&
  left.source._tag === right.source._tag &&
  left.source.sourceRevision === right.source.sourceRevision

export const bindingMismatchReason = (
  stored: ToolBindingIdentity,
  current: ToolBindingIdentity,
): Exclude<
  ToolBindingReplayReason,
  "MissingBinding" | "ToolUnavailable" | "MissingSourceIdentity"
> => {
  if (stored.source.sourceRevision !== current.source.sourceRevision) return "SourceMismatch"
  if (stored.schemaRevision !== current.schemaRevision) return "SchemaMismatch"
  return "SourceMismatch"
}

export const makeBindingReplayError = (params: {
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
  readonly toolId: ToolId
  readonly reason: ToolBindingReplayReason
  readonly message: string
}) => new ToolBindingReplayError(params)
