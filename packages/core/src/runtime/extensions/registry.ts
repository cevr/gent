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
import { type PromptSection } from "../../domain/prompt.js"
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
} from "../../domain/contribution.js"
import { type CompiledPipelines, compilePipelines } from "./pipeline-host.js"
import { type CompiledSubscriptions, compileSubscriptions } from "./subscription-host.js"
import { compileProjections, type CompiledProjections } from "./projection-registry.js"
import { compileCapabilities, type CompiledCapabilities } from "./capability-host.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

// Resolved snapshot — the immutable compiled state

export interface ResolvedExtensions {
  readonly tools: ReadonlyMap<string, AnyToolDefinition>
  readonly agents: ReadonlyMap<string, AgentDefinition>
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly externalDrivers: ReadonlyMap<string, ExternalDriverContribution>
  readonly promptSections: ReadonlyMap<string, PromptSection>
  readonly commands: ReadonlyArray<CommandContribution>
  readonly permissionRules: ReadonlyArray<PermissionRule>
  readonly pipelines: CompiledPipelines
  readonly subscriptions: CompiledSubscriptions
  readonly projections: CompiledProjections
  readonly capabilities: CompiledCapabilities
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
 * C4.3 bridge — lower a `Capability` with `intent: "write"` and
 * `audiences.includes("human-slash")` into a `CommandContribution` shape.
 * (Palette-only capabilities never reach this wrapper — the slash-list
 * compiler in `resolveExtensions` filters them out before lowering.) Args
 * (a string) are decoded through the capability's `input` schema (typically
 * `Schema.String`), and any `CapabilityError` is escalated to a defect —
 * commands have no typed-failure channel today.
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
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

  // Tool resolution — identity-first scope shadowing followed by audience
  // authorization. Tools' identity is `cap.id` (flat). Every capability
  // (regardless of audience) enters the candidate map; authorization
  // (`audiences.includes("model")`) happens AFTER selection so a higher-scope
  // override that narrows audiences correctly hides a shadowed builtin tool.
  const toolWinners = new Map<string, AnyCapabilityContribution>()
  for (const ext of sorted) {
    for (const cap of extractCapabilities(ext.contributions)) {
      toolWinners.set(cap.id, cap)
    }
  }

  const tools = new Map<string, AnyToolDefinition>()
  for (const [name, cap] of toolWinners) {
    if (!cap.audiences.includes("model")) continue
    tools.set(name, capabilityToTool(cap))
  }

  const agents = compileContributions(sorted, extractAgents, (a) => a.name)
  const modelDrivers = compileContributions(sorted, extractModelDrivers, (d) => d.id)
  const externalDrivers = compileContributions(sorted, extractExternalDrivers, (d) => d.id)

  // Prompt sections come from two sources after C7:
  //   1. Static `Capability.prompt` — bundled with the Capability that owns it
  //      (renders whenever the Capability is loaded; no audience filter).
  //   2. (Dynamic content lives on `Projection.prompt(value)` — assembled at
  //      turn time, not here.)
  // Last scope wins by section id, identical to the legacy promptSection
  // contribution semantics.
  const promptSectionsMap = new Map<string, PromptSection>()
  for (const ext of sorted) {
    for (const cap of extractCapabilities(ext.contributions)) {
      if (cap.prompt) promptSectionsMap.set(cap.prompt.id, cap.prompt)
    }
  }

  // C4.3 command bridge — identity-first scope shadowing followed by
  // audience/intent authorization, mirroring the query/mutation bridges
  // (see `query-registry.ts:111` / `mutation-registry.ts:85`).
  //
  // Commands' identity is `name` (flat). Both legacy `CommandContribution`s
  // AND every `CapabilityContribution` enter the candidate map keyed by name
  // REGARDLESS of audience or intent — pre-filtering would let a builtin
  // slash command leak when a higher-scope capability with the same id but
  // a non-slash audience or `intent: "read"` is registered.
  //
  // Since `sorted` walks builtin → user → project, later writes win
  // (project shadows builtin). Authorization happens AFTER selection — a
  // higher-scope override that doesn't satisfy `intent: "write"` +
  // `audiences.includes("human-slash")` SHADOWS the lower-scope command and
  // disappears from the slash list (codex BLOCK on C4.3 follow-up).
  //
  // `"human-palette"` is deliberately NOT slash-authorizable here — the legacy
  // CommandContribution shape has no audience field, so the TUI surfaces every
  // listed entry as both a slash AND a palette command. Including palette-only
  // capabilities would accidentally make them slash-invokable. The
  // palette-vs-slash split materializes when C4.5 routes commands through
  // CapabilityHost directly.
  type CommandCandidate =
    | { readonly _source: "command"; readonly cmd: CommandContribution }
    | { readonly _source: "capability"; readonly cap: AnyCapabilityContribution }

  const commandWinners = new Map<string, CommandCandidate>()
  const permissionRules: PermissionRule[] = []
  for (const ext of sorted) {
    for (const cmd of extractCommands(ext.contributions)) {
      commandWinners.set(cmd.name, { _source: "command", cmd })
    }
    for (const cap of extractCapabilities(ext.contributions)) {
      // Identity-first: ALL capabilities shadow same-name lower-scope entries
      // by id, even if they will fail the slash authorization below. A
      // project-scope capability with `audiences:["transport-public"]` or
      // `intent:"read"` MUST shadow the builtin slash command — otherwise the
      // builtin leaks. Authorization is the second step; selection is first.
      commandWinners.set(cap.id, { _source: "capability", cap })
      // C7: permission rules are now bundled on the Capability they gate.
      if (cap.permissionRules) permissionRules.push(...cap.permissionRules)
    }
  }

  const isAuthorizedAsSlashCommand = (entry: CommandCandidate): boolean =>
    entry._source === "command" ||
    (entry.cap.intent === "write" && entry.cap.audiences.includes("human-slash"))

  const commands: CommandContribution[] = []
  for (const entry of commandWinners.values()) {
    if (!isAuthorizedAsSlashCommand(entry)) continue
    commands.push(entry._source === "command" ? entry.cmd : capabilityToCommand(entry.cap))
  }

  const pipelines = compilePipelines(sorted)
  const subscriptions = compileSubscriptions(sorted)
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
    commands,
    permissionRules,
    pipelines,
    subscriptions,
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

  // Pipelines (transformers with `next`) and Subscriptions (void observers)
  readonly pipelines: CompiledPipelines
  readonly subscriptions: CompiledSubscriptions

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
      // C7: dynamic prompt sections live on `Projection.prompt(value)`. The
      // sections here come from `Capability.prompt`, all static. No more
      // per-section Effect resolution — return the array directly.
      listPromptSections: () => Effect.succeed([...resolved.promptSections.values()]),
      listFailedExtensions: () => Effect.succeed(resolved.failedExtensions),
      listExtensionStatuses: () => Effect.succeed(resolved.extensionStatuses),
      pipelines: resolved.pipelines,
      subscriptions: resolved.subscriptions,
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
