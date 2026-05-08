import { Effect } from "effect"
import {
  getToolId,
  getToolMetadata,
  isToolCapability,
  type ToolCapability,
} from "./capability/tool.js"
import type { ExtensionManifest } from "./extension.js"
import { ExtensionLoadError } from "./extension.js"
import type { ExtensionContributions } from "./contribution.js"

/**
 * Cross-bucket validation shared by `defineExtension` and runtime-loaded
 * extension packages. Field-local messages beat opaque shape failures.
 */

const checkBucketIds = (
  bucket: string,
  entries: ReadonlyArray<{ readonly id: string } | ToolCapability>,
  capIds: Map<string, string>,
): string | undefined => {
  for (const [i, cap] of entries.entries()) {
    const id = isToolCapability(cap) ? getToolId(cap) : cap.id
    if (capIds.has(id)) {
      return `${bucket}[${i}] (${id}): duplicate id within extension (also at ${capIds.get(id)}); cross-extension collisions are resolved by scope precedence, but intra-extension collisions are an authoring bug`
    }
    capIds.set(id, `${bucket}[${i}]`)
  }
  return undefined
}

const checkToolDescriptions = (tools: ReadonlyArray<ToolCapability>): string | undefined => {
  for (const [i, cap] of tools.entries()) {
    if (!isToolCapability(cap)) {
      return `tools[${i}]: tool must be created with \`tool({...})\` so Gent metadata is attached`
    }
    const metadata = getToolMetadata(cap)
    if (cap.description === undefined || cap.description === "") {
      return `tools[${i}] (${metadata.id}): tool requires a non-empty \`description\` (the model sees it as the tool description)`
    }
  }
  return undefined
}

const validateCapabilities = (contribs: ExtensionContributions): string | undefined => {
  const tools = contribs.tools ?? []
  const commands = contribs.actions ?? []
  const rpc = contribs.requests ?? []
  const toolErr = checkToolDescriptions(tools)
  if (toolErr !== undefined) return toolErr
  const capIds = new Map<string, string>()
  return (
    checkBucketIds("tools", tools, capIds) ??
    checkBucketIds("commands", commands, capIds) ??
    checkBucketIds("rpc", rpc, capIds)
  )
}

const validateAgents = (contribs: ExtensionContributions): string | undefined => {
  const agentNames = new Map<string, number>()
  for (const [i, a] of (contribs.agents ?? []).entries()) {
    if (agentNames.has(a.name)) {
      return `agents[${i}] (${a.name}): duplicate name within extension (also at index ${agentNames.get(a.name)})`
    }
    agentNames.set(a.name, i)
  }
  return undefined
}

const validateDriverIds = (contribs: ExtensionContributions): string | undefined => {
  const allDriverIds = new Map<string, string>()
  for (const [i, d] of (contribs.modelDrivers ?? []).entries()) {
    if (allDriverIds.has(d.id)) {
      return `modelDrivers[${i}] (${d.id}): driver id already used by ${allDriverIds.get(d.id)}`
    }
    allDriverIds.set(d.id, `modelDrivers[${i}]`)
  }
  for (const [i, d] of (contribs.externalDrivers ?? []).entries()) {
    if (allDriverIds.has(d.id)) {
      return `externalDrivers[${i}] (${d.id}): driver id already used by ${allDriverIds.get(d.id)}`
    }
    allDriverIds.set(d.id, `externalDrivers[${i}]`)
  }
  return undefined
}

const allowedContributionBuckets = new Set([
  "resources",
  "scheduledJobs",
  "tools",
  "actions",
  "requests",
  "agents",
  "reactions",
  "modelDrivers",
  "externalDrivers",
])

const allowedExtensionInputKeys = new Set(["id", ...allowedContributionBuckets])

const unknownBucketMessage = (key: string) =>
  `unknown contribution bucket "${key}"; supported buckets are ${Array.from(
    allowedContributionBuckets,
  ).join(", ")}`

const validateKnownBuckets = (contribs: ExtensionContributions): string | undefined => {
  for (const key of Object.keys(contribs)) {
    if (!allowedContributionBuckets.has(key)) {
      return unknownBucketMessage(key)
    }
  }
  return undefined
}

export const validateKnownExtensionInputBuckets = (params: object): string | undefined => {
  for (const key of Object.keys(params)) {
    if (!allowedExtensionInputKeys.has(key)) {
      return unknownBucketMessage(key)
    }
  }
  return undefined
}

export const validateExtensionPackageShape = (
  manifest: ExtensionManifest,
  contribs: ExtensionContributions,
): Effect.Effect<void, ExtensionLoadError> =>
  Effect.gen(function* () {
    const checks = [validateKnownBuckets, validateCapabilities, validateAgents, validateDriverIds]
    for (const check of checks) {
      const message = check(contribs)
      if (message !== undefined) {
        return yield* new ExtensionLoadError({ extensionId: manifest.id, message })
      }
    }
  })
