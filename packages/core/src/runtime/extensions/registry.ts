import { Context, Effect, Layer, Schema } from "effect"
import { resolveAgentModel, type AgentDefinition } from "../../domain/agent.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "../../domain/driver.js"
import type { ModelId } from "../../domain/model.js"
import type {
  ExtensionStatusInfo,
  FailedExtension,
  TurnProjection,
  LoadedExtension,
  RunContext,
  ScheduledJobFailureInfo,
} from "../../domain/extension.js"
import { type PromptSection } from "../../domain/prompt.js"
import type { AnyToolDefinition } from "../../domain/tool.js"
import type { PermissionRule } from "../../domain/permission.js"
import { type AnyCapabilityContribution } from "../../domain/capability.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { compileRuntimeSlots, type CompiledRuntimeSlots } from "./runtime-slots.js"
import { compileProjections, type CompiledProjections } from "./projection-registry.js"
import { compileCapabilities, type CompiledCapabilities } from "./capability-host.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

// SlashCommand — public-facing slash entry. Built from `Capability` winners
// whose `audiences.includes("human-slash")`. Read- and write-intent both
// surface as commands; the audience is the load-bearing filter. The legacy
// server-side `CommandContribution` shape died in C8.
export interface SlashCommand {
  readonly name: string
  readonly description?: string
  readonly handler: (args: string, ctx: ExtensionHostContext) => Effect.Effect<void>
}

// Resolved snapshot — the immutable compiled state

export interface ResolvedExtensions {
  readonly tools: ReadonlyMap<string, AnyToolDefinition>
  readonly agents: ReadonlyMap<string, AgentDefinition>
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly externalDrivers: ReadonlyMap<string, ExternalDriverContribution>
  readonly promptSections: ReadonlyMap<string, PromptSection>
  readonly permissionRules: ReadonlyArray<PermissionRule>
  readonly runtimeSlots: CompiledRuntimeSlots
  readonly projections: CompiledProjections
  readonly capabilities: CompiledCapabilities
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly failedExtensions: ReadonlyArray<FailedExtension>
  readonly extensionStatuses: ReadonlyArray<ExtensionStatusInfo>
}

type ScheduledJobFailureByExtension = ReadonlyMap<string, ReadonlyArray<ScheduledJobFailureInfo>>

/** Compile a keyed bucket from sorted extensions. Later scope wins. */
const compileBucket = <T>(
  sorted: ReadonlyArray<LoadedExtension>,
  pickBucket: (ext: LoadedExtension) => ReadonlyArray<T> | undefined,
  getKey: (item: T) => string,
): Map<string, T> => {
  const result = new Map<string, T>()
  for (const ext of sorted) {
    const items = pickBucket(ext) ?? []
    for (const item of items) {
      const key = getKey(item)
      result.set(key, item)
    }
  }
  return result
}

const compileCapabilityWinners = (
  sorted: ReadonlyArray<LoadedExtension>,
): ReadonlyMap<string, AnyCapabilityContribution> => {
  const winners = new Map<string, AnyCapabilityContribution>()
  for (const ext of sorted) {
    for (const cap of ext.contributions.capabilities ?? []) {
      winners.set(cap.id, cap)
    }
  }
  return winners
}

const sortExtensionsByScope = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

/**
 * C4.4 bridge — lower a `Capability` whose `audiences` includes `"model"`
 * into an `AnyToolDefinition` so the existing `ToolRunner` (which still
 * consumes `tool: AnyToolDefinition` from the registry) keeps working
 * unchanged.
 *
 * Field mapping:
 *   `cap.id`               → `tool.name`
 *   `cap.description ?? ""` → `tool.description` (lint enforces non-empty
 *                             at construction time; this is a defense for
 *                             the rare null escape)
 *   `cap.input`            → `tool.params`
 *   `cap.effect`           → `tool.execute` (CapabilityCoreContext is a
 *                             structural subtype of ToolContext, so any
 *                             handler that asks for the narrower type
 *                             remains well-typed at the contravariant arg)
 *
 * `ModelAudienceFields` (`resources`, `idempotent`, `promptSnippet`,
 * `promptGuidelines`, `interactive`) flow through unchanged.
 *
 * Output validation: the bridge encodes through `cap.output` after the
 * effect runs. CapabilityContribution's contract is "input/output validated
 * at the host boundary" (see `capability-host.ts:184`); the legacy
 * ToolRunner only validates input. We restore the missing half here so
 * Capability semantics hold even when tools dispatch through ToolRunner
 * instead of CapabilityHost (codex BLOCK 1 on C4.4a). Misshape coerces
 * to defect — ToolRunner has no typed-failure channel that maps to schema
 * violations.
 *
 * C4.5 deletes this wrapper along with the `ToolDefinition` type once
 * the runner consumes Capability directly.
 */
const capabilityToTool = (cap: AnyCapabilityContribution): AnyToolDefinition => ({
  name: cap.id,
  description: cap.description ?? "",
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  params: cap.input as AnyToolDefinition["params"],
  ...(cap.resources !== undefined ? { resources: cap.resources } : {}),
  ...(cap.idempotent !== undefined ? { idempotent: cap.idempotent } : {}),
  ...(cap.promptSnippet !== undefined ? { promptSnippet: cap.promptSnippet } : {}),
  ...(cap.promptGuidelines !== undefined ? { promptGuidelines: cap.promptGuidelines } : {}),
  ...(cap.interactive !== undefined ? { interactive: cap.interactive } : {}),
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at tool-bridge boundary
  execute: (params, ctx) => {
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at tool-bridge boundary
    const wrapped = Effect.gen(function* () {
      const output = yield* cap.effect(
        params,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        ctx as Parameters<typeof cap.effect>[1],
      )
      // Validate output against the capability's declared schema. For tools
      // whose output is `Schema.Unknown` this is a no-op; for any tool with
      // a typed output schema it catches host-side misshape. Misshape →
      // defect; ToolRunner has no typed channel for schema violations.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      yield* Schema.encodeUnknownEffect(cap.output as Schema.Any)(output).pipe(Effect.orDie)
      return output
    })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return wrapped as ReturnType<AnyToolDefinition["execute"]>
  },
})

/**
 * Lower a `Capability` with `intent: "write"` and
 * `audiences.includes("human-slash")` into a `SlashCommand`. Args (a string)
 * are decoded through the capability's `input` schema (typically
 * `Schema.String`); any `CapabilityError` is escalated to a defect — slash
 * commands have no typed-failure channel today.
 */
const capabilityToCommand = (cap: AnyCapabilityContribution): SlashCommand => ({
  name: cap.id,
  ...(cap.promptSnippet !== undefined ? { description: cap.promptSnippet } : {}),
  handler: (args, hostCtx) => {
    // The capability's effect signature is wider than the command host
    // surface (ModelCapabilityContext extends ExtensionHostContext), so the
    // structural cast is sound — every field the capability core context
    // demands is present on hostCtx. CommandContribution.handler returns
    // `Effect<void>`; the capability's requirements + error channel are
    // erased at this command-bridge boundary, mirroring the query/mutation
    // registries — those services are provided by the extension's
    // contributed Layer at composition time.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at command bridge
    const wrapped = Effect.gen(function* () {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const decoded = yield* Schema.decodeUnknownEffect(cap.input as Schema.Any)(args).pipe(
        Effect.orDie,
      )
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at command bridge
      const output = yield* cap
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        .effect(decoded, hostCtx as Parameters<typeof cap.effect>[1])
        .pipe(Effect.orDie)
      // Validate the output even though the command surface discards it —
      // keeps the bridge honest about CapabilityContribution's input/output
      // boundary contract (codex ADVISORY 3 on C4.3). Misshape is a host
      // bug, so coerce to defect.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      yield* Schema.encodeUnknownEffect(cap.output as Schema.Any)(output).pipe(Effect.orDie)
    })
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at command bridge
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return wrapped as Effect.Effect<void>
  },
})

/** Compile prevalidated extensions into an immutable resolved snapshot. */
export const resolveExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
  failedExtensions: ReadonlyArray<FailedExtension> = [],
  scheduledJobFailures: ScheduledJobFailureByExtension = new Map(),
): ResolvedExtensions => {
  const mergedFailures = [...failedExtensions]
  const sorted = sortExtensionsByScope(extensions)

  // Tool resolution — identity-first scope shadowing followed by audience
  // authorization. Tools' identity is `cap.id` (flat). Every capability
  // (regardless of audience) enters the candidate map; authorization
  // (`audiences.includes("model")`) happens AFTER selection so a higher-scope
  // override that narrows audiences correctly hides a shadowed builtin tool.
  const toolWinners = compileCapabilityWinners(sorted)

  const tools = new Map<string, AnyToolDefinition>()
  for (const [name, cap] of toolWinners) {
    if (!cap.audiences.includes("model")) continue
    tools.set(name, capabilityToTool(cap))
  }

  const agents = compileBucket(
    sorted,
    (e) => e.contributions.agents,
    (a) => a.name,
  )
  const modelDrivers = compileBucket(
    sorted,
    (e) => e.contributions.modelDrivers,
    (d) => d.id,
  )
  const externalDrivers = compileBucket(
    sorted,
    (e) => e.contributions.externalDrivers,
    (d) => d.id,
  )

  // Prompt sections from `Capability.prompt` are read off the WINNERS map,
  // not raw extractions. Otherwise a higher-scope capability shadowing a
  // lower-scope tool would still inherit the loser's prompt — defeating the
  // shadow (codex BLOCKER on C7). Last scope wins by section id, identical
  // to the legacy promptSection contribution semantics.
  // (Dynamic prompt content lives on `Projection.prompt(value)` and is
  // assembled per-turn by ProjectionRegistry, not here.)
  const promptSectionsMap = new Map<string, PromptSection>()
  for (const cap of toolWinners.values()) {
    if (cap.prompt) promptSectionsMap.set(cap.prompt.id, cap.prompt)
  }

  // C7: permission rules collected from WINNERS, not raw extractions —
  // otherwise overriding `bash` without `permissionRules` would still inherit
  // builtin denies (codex BLOCKER on C7).
  const permissionRules: PermissionRule[] = []
  for (const cap of toolWinners.values()) {
    if (cap.permissionRules) permissionRules.push(...cap.permissionRules)
  }

  const runtimeSlots = compileRuntimeSlots(sorted)
  const projections = compileProjections(sorted)
  const capabilities = compileCapabilities(sorted)
  const extensionStatuses: ExtensionStatusInfo[] = [
    ...sorted.map((ext) => ({
      manifest: ext.manifest,
      kind: ext.kind,
      sourcePath: ext.sourcePath,
      status: "active" as const,
      ...(scheduledJobFailures.has(ext.manifest.id)
        ? { scheduledJobFailures: scheduledJobFailures.get(ext.manifest.id) }
        : {}),
    })),
    ...mergedFailures.map((failure) => ({
      ...failure,
      status: "failed" as const,
      ...(scheduledJobFailures.has(failure.manifest.id)
        ? { scheduledJobFailures: scheduledJobFailures.get(failure.manifest.id) }
        : {}),
    })),
  ]

  return {
    tools,
    agents,
    modelDrivers,
    externalDrivers,
    promptSections: promptSectionsMap,
    permissionRules,
    runtimeSlots,
    projections,
    capabilities,
    extensions: sorted,
    failedExtensions: mergedFailures,
    extensionStatuses,
  }
}

// ToolPolicy compiler — unified tool filtering + prompt section collection

export interface CompiledToolPolicy {
  readonly tools: ReadonlyArray<AnyToolDefinition>
  readonly promptSections: ReadonlyArray<PromptSection>
}

/**
 * Compile the active tool set and prompt sections for a turn.
 *
 * Pipeline:
 * 1. Agent allow/deny filtering
 * 2. Extension projection fragments (include/exclude/overrideSet)
 * 3. Re-apply agent deny list (extensions can't escape denials)
 * 4. Collect extension-contributed prompt sections
 */
export const compileToolPolicy = (
  allTools: ReadonlyArray<AnyToolDefinition>,
  agent: AgentDefinition,
  runContext: RunContext,
  extensionProjections: ReadonlyArray<TurnProjection>,
): CompiledToolPolicy => {
  const allToolsByName = new Map(allTools.map((t) => [t.name, t]))

  // 1. Agent allow/deny filtering
  let tools = filterToolsForAgent(allTools, agent)

  // 2. Extension projection fragments (overrideSet is exclusive — include/exclude ignored when set)
  for (const projection of extensionProjections) {
    const policy = projection.toolPolicy
    if (policy === undefined) continue

    if (policy.overrideSet !== undefined) {
      // Replace the full tool list from the known tool universe
      tools = policy.overrideSet.flatMap((name) => {
        const t = allToolsByName.get(name)
        return t !== undefined ? [t] : []
      })
    } else {
      if (policy.include !== undefined) {
        const existing = new Set(tools.map((t) => t.name))
        for (const name of policy.include) {
          if (!existing.has(name)) {
            const t = allToolsByName.get(name)
            if (t !== undefined) {
              tools.push(t)
              existing.add(name)
            }
          }
        }
      }
      if (policy.exclude !== undefined) {
        const excludeSet = new Set(policy.exclude)
        tools = tools.filter((t) => !excludeSet.has(t.name))
      }
    }
  }

  // 4. Re-apply agent deny list — extensions can't escape denials
  tools = applyDenyFilter(tools, agent)

  // 5. Filter interactive tools in non-interactive contexts (headless, subagent)
  if (runContext.interactive === false) {
    tools = tools.filter((t) => t.interactive !== true)
  }

  // 6. Collect extension-contributed prompt sections
  const promptSections: PromptSection[] = []
  for (const projection of extensionProjections) {
    if (projection.promptSections !== undefined) {
      promptSections.push(...projection.promptSections)
    }
  }

  return { tools, promptSections }
}

// Extension Registry Service

export interface ExtensionRegistryService {
  // Tool resolution
  readonly getTool: (name: string) => Effect.Effect<AnyToolDefinition | undefined>
  readonly listTools: () => Effect.Effect<ReadonlyArray<AnyToolDefinition>>
  /** Resolve tools + prompt sections for an agent turn, applying extension projections. */
  readonly resolveToolPolicy: (
    agent: AgentDefinition,
    runContext: RunContext,
    extensionProjections: ReadonlyArray<TurnProjection>,
  ) => Effect.Effect<CompiledToolPolicy>

  // Agent resolution
  readonly getAgent: (name: string) => Effect.Effect<AgentDefinition | undefined>
  readonly listAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>

  /** Resolve primary + reviewer model pair for dual-model workflows.
   *  Tries cowork/deepwork by name, falls back to first two modeled agents, dies if none. */
  readonly resolveDualModelPair: () => Effect.Effect<[ModelId, ModelId]>

  // Permission rules
  readonly listPermissionRules: () => Effect.Effect<ReadonlyArray<PermissionRule>>

  // Prompt sections
  readonly listPromptSections: () => Effect.Effect<ReadonlyArray<PromptSection>>

  // Diagnostics
  readonly listFailedExtensions: () => Effect.Effect<ReadonlyArray<FailedExtension>>
  readonly listExtensionStatuses: () => Effect.Effect<ReadonlyArray<ExtensionStatusInfo>>

  readonly runtimeSlots: CompiledRuntimeSlots

  // Raw resolved data — needed for rebuilding extension services in child runtimes
  readonly getResolved: () => ResolvedExtensions
}

export class ExtensionRegistry extends Context.Service<
  ExtensionRegistry,
  ExtensionRegistryService
>()("@gent/core/src/runtime/extensions/registry/ExtensionRegistry") {
  static fromResolved = (resolved: ResolvedExtensions): Layer.Layer<ExtensionRegistry> =>
    Layer.succeed(ExtensionRegistry, {
      getTool: (name) => Effect.succeed(resolved.tools.get(name)),
      listTools: () => Effect.succeed([...resolved.tools.values()]),
      resolveToolPolicy: (agent, runContext, extensionProjections) =>
        Effect.succeed(
          compileToolPolicy([...resolved.tools.values()], agent, runContext, extensionProjections),
        ),
      listPermissionRules: () => Effect.succeed(resolved.permissionRules),
      getAgent: (name) => Effect.succeed(resolved.agents.get(name)),
      listAgents: () => Effect.succeed([...resolved.agents.values()]),
      resolveDualModelPair: () =>
        Effect.gen(function* () {
          const agents = [...resolved.agents.values()]
          // 1. Name-based: cowork + deepwork (the standard dual-model pair)
          const cowork = resolved.agents.get("cowork")
          const deepwork = resolved.agents.get("deepwork")
          if (cowork !== undefined && deepwork !== undefined) {
            return [resolveAgentModel(cowork), resolveAgentModel(deepwork)] as [ModelId, ModelId]
          }
          // 3. Position-based fallback: first two modeled agents
          const modeledAgents = agents.filter((agent) => agent.model !== undefined)
          if (modeledAgents.length >= 2) {
            const first = modeledAgents[0]
            const second = modeledAgents[1]
            if (first !== undefined && second !== undefined) {
              return [resolveAgentModel(first), resolveAgentModel(second)] as [ModelId, ModelId]
            }
          }
          if (modeledAgents.length === 1) {
            const only = modeledAgents[0]
            if (only !== undefined) {
              return [resolveAgentModel(only), resolveAgentModel(only)] as [ModelId, ModelId]
            }
          }
          return yield* Effect.die(
            "No modeled agents registered — dual-model workflows require at least one agent with a model",
          )
        }),
      // C7: dynamic prompt sections live on `Projection.prompt(value)`. The
      // sections here come from `Capability.prompt`, all static. No more
      // per-section Effect resolution — return the array directly.
      listPromptSections: () => Effect.succeed([...resolved.promptSections.values()]),
      listFailedExtensions: () => Effect.succeed(resolved.failedExtensions),
      listExtensionStatuses: () => Effect.succeed(resolved.extensionStatuses),
      runtimeSlots: resolved.runtimeSlots,
      getResolved: () => resolved,
    })

  static Test = (): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions([]))
}

export const listSlashCommands = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<SlashCommand> => {
  const winners = compileCapabilityWinners(sortExtensionsByScope(extensions))
  const commands: SlashCommand[] = []
  for (const cap of winners.values()) {
    if (!cap.audiences.includes("human-slash")) continue
    commands.push(capabilityToCommand(cap))
  }
  return commands
}

/** Resolve a required agent from the registry. Fails with a clear error if not found. */
export const requireAgent = (name: string) =>
  Effect.gen(function* () {
    const registry = yield* ExtensionRegistry
    const agent = yield* registry.getAgent(name)
    if (agent === undefined) {
      return yield* Effect.die(
        new Error(
          `Required agent "${name}" not found in ExtensionRegistry. Is @gent/agents disabled?`,
        ),
      )
    }
    return agent
  })

// Tool filtering — pure helper for agent tool visibility

const filterToolsForAgent = (
  allTools: ReadonlyArray<AnyToolDefinition>,
  agent: AgentDefinition,
): AnyToolDefinition[] => {
  let tools: AnyToolDefinition[]

  if (agent.allowedTools !== undefined) {
    const names = new Set(agent.allowedTools)
    tools = allTools.filter((t) => names.has(t.name))
  } else {
    tools = [...allTools]
  }

  if (agent.deniedTools !== undefined) {
    tools = applyDenyFilter(tools, agent)
  }

  return tools
}

/** Re-apply deny filter — extensions can't escape agent denials. */
const applyDenyFilter = (
  tools: ReadonlyArray<AnyToolDefinition>,
  agent: AgentDefinition,
): AnyToolDefinition[] => {
  if (agent.deniedTools === undefined) return [...tools]
  const denied = new Set(agent.deniedTools)
  return tools.filter((t) => !denied.has(t.name))
}
