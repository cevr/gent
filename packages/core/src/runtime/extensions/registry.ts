import { Context, Effect, Layer, Schema } from "effect"
import { resolveAgentModel, type AgentDefinition } from "../../domain/agent.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "../../domain/driver.js"
import type { ModelId } from "../../domain/model.js"
import type {
  CommandContribution,
  ExtensionStatusInfo,
  FailedExtension,
  TurnProjection,
  LoadedExtension,
  RunContext,
  ScheduledJobFailureInfo,
} from "../../domain/extension.js"
import {
  isDynamicPromptSection,
  type PromptSection,
  type PromptSectionInput,
} from "../../domain/prompt.js"
import type { AnyToolDefinition } from "../../domain/tool.js"
import type { PermissionRule } from "../../domain/permission.js"
import { type AnyCapabilityContribution } from "../../domain/capability.js"
import {
  type Contribution,
  extractAgents,
  extractCapabilities,
  extractCommands,
  extractExternalDrivers,
  extractModelDrivers,
  extractPermissionRules,
  extractPromptSections,
  extractTools,
} from "../../domain/contribution.js"
import { type CompiledHookMap, compileInterceptors } from "./interceptor-registry.js"
import { compileProjections, type CompiledProjections } from "./projection-registry.js"
import { compileQueries, type CompiledQueries } from "./query-registry.js"
import { compileMutations, type CompiledMutations } from "./mutation-registry.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

// Resolved snapshot — the immutable compiled state

export interface ResolvedExtensions {
  readonly tools: ReadonlyMap<string, AnyToolDefinition>
  readonly agents: ReadonlyMap<string, AgentDefinition>
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly externalDrivers: ReadonlyMap<string, ExternalDriverContribution>
  readonly promptSections: ReadonlyMap<string, PromptSectionInput>
  readonly commands: ReadonlyArray<CommandContribution>
  readonly permissionRules: ReadonlyArray<PermissionRule>
  readonly hooks: CompiledHookMap
  readonly projections: CompiledProjections
  readonly queries: CompiledQueries
  readonly mutations: CompiledMutations
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly failedExtensions: ReadonlyArray<FailedExtension>
  readonly extensionStatuses: ReadonlyArray<ExtensionStatusInfo>
}

type ScheduledJobFailureByExtension = ReadonlyMap<string, ReadonlyArray<ScheduledJobFailureInfo>>

/** Compile a keyed contribution from sorted extensions. Later scope wins. */
const compileContributions = <T>(
  sorted: ReadonlyArray<LoadedExtension>,
  extract: (contributions: ReadonlyArray<Contribution>) => ReadonlyArray<T>,
  getKey: (item: T) => string,
): Map<string, T> => {
  const result = new Map<string, T>()
  for (const ext of sorted) {
    for (const item of extract(ext.contributions)) {
      const key = getKey(item)
      result.set(key, item)
    }
  }
  return result
}

/**
 * C4.3 bridge — lower a `Capability` whose `audiences` includes a human-facing
 * surface ("human-slash"/"human-palette") with `intent: "write"` into a
 * `CommandContribution` shape. Args (a string) are decoded through the
 * capability's `input` schema (typically `Schema.String`), and any
 * `CapabilityError` is escalated to a defect — commands have no typed-failure
 * channel today.
 *
 * The wrapper preserves the capability's `id` as the command `name`. This
 * bridge is scoped to C4.3-4 and deleted in C4.5 along with the
 * `CommandContribution` type.
 */
const capabilityToCommand = (cap: AnyCapabilityContribution): CommandContribution => ({
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
      yield* cap
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        .effect(decoded, hostCtx as Parameters<typeof cap.effect>[1])
        .pipe(Effect.orDie, Effect.asVoid)
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
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

  const tools = compileContributions(sorted, extractTools, (t) => t.name)
  const agents = compileContributions(sorted, extractAgents, (a) => a.name)
  const modelDrivers = compileContributions(sorted, extractModelDrivers, (d) => d.id)
  const externalDrivers = compileContributions(sorted, extractExternalDrivers, (d) => d.id)

  // Prompt sections: last scope wins by section id
  const promptSectionsMap = compileContributions(sorted, extractPromptSections, (p) => p.id)

  const commands: CommandContribution[] = []
  const permissionRules: PermissionRule[] = []
  for (const ext of sorted) {
    for (const cmd of extractCommands(ext.contributions)) commands.push(cmd)
    // C4.3 bridge: capability(audiences includes "human-slash"|"human-palette",
    // intent: "write") shows up here as a CommandContribution. Decodes args
    // through the capability's input schema (typically Schema.String) and
    // translates CapabilityError → defect (commands have no typed-failure
    // channel). Identical "scope-shadowing-then-authorize" rule as the
    // query/mutation bridges, but commands' identity is `name`, not `(extId, id)`,
    // so we keep their flat array shape.
    for (const cap of extractCapabilities(ext.contributions)) {
      if (cap.intent !== "write") continue
      if (!cap.audiences.includes("human-slash") && !cap.audiences.includes("human-palette")) {
        continue
      }
      commands.push(capabilityToCommand(cap))
    }
    for (const rule of extractPermissionRules(ext.contributions)) permissionRules.push(rule)
  }

  const hooks = compileInterceptors(sorted).chain
  const projections = compileProjections(sorted)
  const queries = compileQueries(sorted)
  const mutations = compileMutations(sorted)
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
    commands,
    permissionRules,
    hooks,
    projections,
    queries,
    mutations,
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

  // Command resolution
  readonly listCommands: () => Effect.Effect<ReadonlyArray<CommandContribution>>

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

  // Hooks
  readonly hooks: CompiledHookMap

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
      listCommands: () => Effect.succeed(resolved.commands),
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
      listPromptSections: () =>
        Effect.forEach([...resolved.promptSections.values()], (section) =>
          isDynamicPromptSection(section)
            ? Effect.map(section.resolve, (content) => ({
                id: section.id,
                content,
                priority: section.priority,
              }))
            : Effect.succeed(section),
        ),
      listFailedExtensions: () => Effect.succeed(resolved.failedExtensions),
      listExtensionStatuses: () => Effect.succeed(resolved.extensionStatuses),
      hooks: resolved.hooks,
      getResolved: () => resolved,
    })

  static Test = (): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions([]))
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
