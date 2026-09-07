import { canonicalJsonString } from "effect-encore"
import { Option, Predicate, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import type { LoadedExtension } from "../../domain/extension.js"
import type { ResourceGenerationId } from "../../domain/resource-generation.js"
import {
  makeToolBindingIdentity,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
  type ToolBindingIdentity,
  type ToolBindingResource,
} from "../../domain/tool-binding.js"
import type { MessageId, ToolCallId, ToolId } from "../../domain/ids.js"
import { type ResourceDescriptor, type ResourceId } from "../../domain/resource-graph.js"
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

export class ToolBindingCaptureError extends Schema.TaggedError<ToolBindingCaptureError>()(
  "ToolBindingCaptureError",
  {
    assistantMessageId: Schema.String,
    toolCallId: Schema.String,
    toolId: Schema.String,
    message: Schema.String,
  },
) {}

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

export interface ToolBindingIdentityContext {
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly resources: ReadonlyArray<ResourceDescriptor>
  readonly publicationRevision?: string
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

const resourceVectorFor = (
  resources: ReadonlyArray<ResourceDescriptor>,
): ReadonlyArray<ToolBindingResource> =>
  resources.map((resource) => ({
    id: resource.id,
    revision: resource.revision,
  }))

const sourceRevisionFor = (
  extension: LoadedExtension,
  publicationRevision: ToolBindingIdentityContext["publicationRevision"],
): Option.Option<ToolSourceRevision> => {
  if (Predicate.isUndefined(extension.artifactIdentity)) return Option.none()
  const sourceParts = [
    "artifact",
    extension.artifactIdentity,
    extension.scope,
    extension.sourcePath,
    extension.manifest.id,
  ]
  if (Predicate.isNotUndefined(publicationRevision)) {
    sourceParts.push("publication", publicationRevision)
  }
  return Option.some(ToolSourceRevision.make(sourceParts.join(":")))
}

const dynamicSourceRevisionFor = (entry: ResolvedToolCapability): ToolSourceRevision =>
  ToolSourceRevision.make(`dynamic:${entry.extensionId}:${getToolId(entry.capability)}`)

/** Attach the durable identity available for one freshly selected capability. */
export const attachToolBindingIdentity = (
  entry: ResolvedToolCapability,
  context: ToolBindingIdentityContext,
): ResolvedToolCapability => {
  const extension = context.extensions.find(
    (candidate) => candidate.manifest.id === entry.extensionId,
  )
  let sourceRevision = Option.none<ToolSourceRevision>()
  if (entry.origin === "dynamic") {
    sourceRevision = Option.some(dynamicSourceRevisionFor(entry))
  } else if (Predicate.isNotUndefined(extension)) {
    const revision = sourceRevisionFor(extension, context.publicationRevision)
    if (Option.isSome(revision)) sourceRevision = revision
  }
  if (Option.isNone(sourceRevision)) return entry

  let source: ToolBindingIdentity["source"]
  if (entry.origin === "dynamic") {
    source = ToolBindingSource.cases.DynamicNonReplayable.make({
      sourceRevision: sourceRevision.value,
    })
  } else {
    source = ToolBindingSource.cases.Static.make({ sourceRevision: sourceRevision.value })
  }
  const binding = makeToolBindingIdentity({
    toolId: getToolId(entry.capability),
    extensionId: entry.extensionId,
    source,
    schemaRevision: schemaRevisionFor(entry.capability, context.hash),
    resources: resourceVectorFor(context.resources),
  })
  return { ...entry, binding }
}

/** Identity for a static tool without a build artifact. It names one process generation. */
export const processLocalToolBindingIdentity = (
  entry: ResolvedToolCapability,
  context: {
    readonly generationId: ResourceGenerationId
    readonly resources: ReadonlyArray<ResourceDescriptor>
    readonly hash: (input: string) => string
  },
): Option.Option<ToolBindingIdentity> => {
  if (entry.origin === "dynamic" || Predicate.isNotUndefined(entry.binding)) return Option.none()
  return Option.some(
    makeToolBindingIdentity({
      toolId: getToolId(entry.capability),
      extensionId: entry.extensionId,
      source: ToolBindingSource.cases.ProcessLocal.make({
        sourceRevision: ToolSourceRevision.make(`process:${context.generationId}`),
      }),
      schemaRevision: schemaRevisionFor(entry.capability, context.hash),
      resources: resourceVectorFor(context.resources),
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

export const bindingResourcesFromPlan = (
  descriptors: ReadonlyArray<ResourceDescriptor>,
  activeIds: ReadonlyArray<ResourceId>,
): ReadonlyArray<ResourceDescriptor> => {
  const active = new Set(activeIds)
  return descriptors.filter((descriptor) => active.has(descriptor.id))
}

export const makeBindingReplayError = (params: {
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
  readonly toolId: ToolId
  readonly reason: ToolBindingReplayReason
  readonly message: string
}) => new ToolBindingReplayError(params)
