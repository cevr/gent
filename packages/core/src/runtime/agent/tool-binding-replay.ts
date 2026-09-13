import { canonicalJsonString } from "effect-encore"
import { Option, Predicate, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import type { LoadedExtension } from "../../domain/extension.js"
import type { ProcessGenerationId } from "../../domain/process-generation.js"
import {
  makeToolBindingIdentity,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
  type ToolBindingIdentity,
} from "../../domain/tool-binding.js"
import type { MessageId, ToolCallId, ToolId } from "../../domain/ids.js"
import { getToolId, type ToolCapability } from "../../domain/capability/tool.js"
import type { ResolvedToolCapability } from "./tool-runner.js"

export type ToolBindingReplayReason =
  | "MissingBinding"
  | "DynamicNonReplayable"
  | "ToolUnavailable"
  | "MissingSourceIdentity"
  | "SourceMismatch"
  | "SchemaMismatch"
  | "ResourceMismatch"

export class ToolBindingReplayError extends Schema.TaggedError<ToolBindingReplayError>()(
  "ToolBindingReplayError",
  {
    assistantMessageId: Schema.String,
    toolCallId: Schema.String,
    toolId: Schema.String,
    reason: Schema.Literals([
      "MissingBinding",
      "DynamicNonReplayable",
      "ToolUnavailable",
      "MissingSourceIdentity",
      "SourceMismatch",
      "SchemaMismatch",
      "ResourceMismatch",
    ]),
    message: Schema.String,
  },
) {}

interface ToolBindingIdentityContext {
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly hash: (input: string) => string
}

const schemaRevisionFor = (
  tool: ToolCapability,
  hash: (input: string) => string,
): ToolSchemaRevision => {
  const advertisedSchema = Schema.decodeUnknownSync(Schema.Json)({
    name: String(getToolId(tool)),
    description: tool.description,
    parameters: AiTool.getJsonSchema(tool),
  })
  return ToolSchemaRevision.make(`schema:${hash(canonicalJsonString(advertisedSchema))}`)
}

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
export const attachToolBindingIdentity = (
  entry: ResolvedToolCapability,
  context: ToolBindingIdentityContext,
): ResolvedToolCapability => {
  const extension = context.extensions.find(
    (candidate) => candidate.manifest.id === entry.extensionId,
  )
  let sourceRevision = Option.none<ToolSourceRevision>()
  if (Predicate.isNotUndefined(extension)) {
    const revision = sourceRevisionFor(extension)
    if (Option.isSome(revision)) sourceRevision = revision
  }
  if (Option.isNone(sourceRevision)) return entry

  const source = ToolBindingSource.cases.Static.make({ sourceRevision: sourceRevision.value })
  const binding = makeToolBindingIdentity({
    toolId: getToolId(entry.capability),
    extensionId: entry.extensionId,
    source,
    schemaRevision: schemaRevisionFor(entry.capability, context.hash),
    resources: [],
  })
  return { ...entry, binding }
}

/** Identity for a static tool without a build artifact. It names one process generation. */
export const processLocalToolBindingIdentity = (
  entry: ResolvedToolCapability,
  context: {
    readonly generationId: ProcessGenerationId
    readonly hash: (input: string) => string
  },
): Option.Option<ToolBindingIdentity> => {
  if (Predicate.isNotUndefined(entry.binding)) return Option.none()
  return Option.some(
    makeToolBindingIdentity({
      toolId: getToolId(entry.capability),
      extensionId: entry.extensionId,
      source: ToolBindingSource.cases.ProcessLocal.make({
        sourceRevision: ToolSourceRevision.make(`process:${context.generationId}`),
      }),
      schemaRevision: schemaRevisionFor(entry.capability, context.hash),
      resources: [],
    }),
  )
}

const sameResource = (
  left: ToolBindingIdentity["resources"][number],
  right: ToolBindingIdentity["resources"][number],
): boolean => left.id === right.id && left.revision === right.revision

export const sameToolBindingIdentity = (
  left: ToolBindingIdentity,
  right: ToolBindingIdentity,
): boolean => {
  if (
    left.toolId !== right.toolId ||
    left.extensionId !== right.extensionId ||
    left.schemaRevision !== right.schemaRevision ||
    left.source._tag !== right.source._tag ||
    left.source.sourceRevision !== right.source.sourceRevision ||
    left.resources.length !== right.resources.length
  ) {
    return false
  }
  return left.resources.every((resource, index) => {
    const other = right.resources[index]
    return Predicate.isNotUndefined(other) && sameResource(resource, other)
  })
}

export const bindingMismatchReason = (
  stored: ToolBindingIdentity,
  current: ToolBindingIdentity,
): Exclude<
  ToolBindingReplayReason,
  "MissingBinding" | "DynamicNonReplayable" | "ToolUnavailable" | "MissingSourceIdentity"
> => {
  if (stored.source.sourceRevision !== current.source.sourceRevision) return "SourceMismatch"
  if (stored.schemaRevision !== current.schemaRevision) return "SchemaMismatch"
  if (stored.resources.length !== current.resources.length) return "ResourceMismatch"
  for (const [index, resource] of stored.resources.entries()) {
    const other = current.resources[index]
    if (Predicate.isUndefined(other) || !sameResource(resource, other)) {
      return "ResourceMismatch"
    }
  }
  return "SourceMismatch"
}

export const makeBindingReplayError = (params: {
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
  readonly toolId: ToolId
  readonly reason: ToolBindingReplayReason
  readonly message: string
}) => new ToolBindingReplayError(params)
