import { Effect, Option, Predicate, Schema } from "effect"
import {
  getToolId,
  getToolMetadata,
  isToolCapability,
  type ToolCapability,
} from "./capability/tool.js"
import type { ExtensionManifest } from "./extension.js"
import { ExtensionLoadError } from "./extension.js"
import type { ExtensionContributions } from "./contribution.js"
import { ResourceDescriptor } from "./resource-graph.js"

/**
 * Cross-bucket validation shared by `defineExtension` and runtime-loaded
 * extension packages. Field-local messages beat opaque shape failures.
 */

const checkBucketIds = (
  bucket: string,
  entries: ReadonlyArray<{ readonly id: string } | ToolCapability>,
  capIds: Map<string, string>,
): Option.Option<string> => {
  for (const [i, cap] of entries.entries()) {
    let id: string
    if (isToolCapability(cap)) {
      id = getToolId(cap)
    } else {
      id = cap.id
    }
    if (capIds.has(id)) {
      return Option.some(
        `${bucket}[${i}] (${id}): duplicate id within extension (also at ${capIds.get(id)}); cross-extension collisions are resolved by scope precedence, but intra-extension collisions are an authoring bug`,
      )
    }
    capIds.set(id, `${bucket}[${i}]`)
  }
  return Option.none()
}

const checkToolDescriptions = (tools: ReadonlyArray<ToolCapability>): Option.Option<string> => {
  for (const [i, cap] of tools.entries()) {
    if (!isToolCapability(cap)) {
      return Option.some(
        `tools[${i}]: tool must be created with \`tool({...})\` so Gent metadata is attached`,
      )
    }
    const metadata = getToolMetadata(cap)
    if (Predicate.isUndefined(cap.description) || cap.description === "") {
      return Option.some(
        `tools[${i}] (${metadata.id}): tool requires a non-empty \`description\` (the model sees it as the tool description)`,
      )
    }
  }
  return Option.none()
}

const validateCapabilities = (contribs: ExtensionContributions): Option.Option<string> => {
  const tools = contribs.tools ?? []
  const rpc = contribs.requests ?? []
  const toolErr = checkToolDescriptions(tools)
  if (Option.isSome(toolErr)) return toolErr
  const capIds = new Map<string, string>()
  return Option.orElse(checkBucketIds("tools", tools, capIds), () =>
    checkBucketIds("requests", rpc, capIds),
  )
}

const validateAgents = (contribs: ExtensionContributions): Option.Option<string> => {
  const agentNames = new Map<string, number>()
  for (const [i, a] of (contribs.agents ?? []).entries()) {
    if (agentNames.has(a.name)) {
      return Option.some(
        `agents[${i}] (${a.name}): duplicate name within extension (also at index ${agentNames.get(a.name)})`,
      )
    }
    agentNames.set(a.name, i)
  }
  return Option.none()
}

const validateResources = (contribs: ExtensionContributions): Option.Option<string> => {
  for (const [i, resource] of (contribs.resources ?? []).entries()) {
    if (Schema.is(ResourceDescriptor)(resource)) continue
    return Option.some(
      `resources[${i}]: resource requires non-empty id and revision, a requires array, and a boolean required flag`,
    )
  }
  return Option.none()
}

const validateDriverIds = (contribs: ExtensionContributions): Option.Option<string> => {
  const allDriverIds = new Map<string, string>()
  for (const [i, d] of (contribs.modelDrivers ?? []).entries()) {
    if (allDriverIds.has(d.id)) {
      return Option.some(
        `modelDrivers[${i}] (${d.id}): driver id already used by ${allDriverIds.get(d.id)}`,
      )
    }
    allDriverIds.set(d.id, `modelDrivers[${i}]`)
  }
  for (const [i, d] of (contribs.externalDrivers ?? []).entries()) {
    if (allDriverIds.has(d.id)) {
      return Option.some(
        `externalDrivers[${i}] (${d.id}): driver id already used by ${allDriverIds.get(d.id)}`,
      )
    }
    allDriverIds.set(d.id, `externalDrivers[${i}]`)
  }
  return Option.none()
}

const allowedContributionBuckets = new Set([
  "resources",
  "scheduledJobs",
  "tools",
  "requests",
  "agents",
  "hooks",
  "modelDrivers",
  "externalDrivers",
])

const unknownBucketMessage = (key: string) =>
  `unknown contribution bucket "${key}"; supported buckets are ${Array.from(
    allowedContributionBuckets,
  ).join(", ")}`

const validateKnownBuckets = (contribs: ExtensionContributions): Option.Option<string> => {
  for (const key of Object.keys(contribs)) {
    if (!allowedContributionBuckets.has(key)) {
      return Option.some(unknownBucketMessage(key))
    }
  }
  return Option.none()
}

export const validateExtensionPackage = (
  manifest: ExtensionManifest,
  contribs: ExtensionContributions,
): Effect.Effect<void, ExtensionLoadError> =>
  Effect.gen(function* () {
    const checks = [
      validateKnownBuckets,
      validateResources,
      validateCapabilities,
      validateAgents,
      validateDriverIds,
    ]
    for (const check of checks) {
      const message = check(contribs)
      if (Option.isSome(message)) {
        return yield* new ExtensionLoadError({ extensionId: manifest.id, message: message.value })
      }
    }
  })
