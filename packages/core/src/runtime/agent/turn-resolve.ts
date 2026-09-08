import { Effect, Option, Predicate } from "effect"
import {
  AgentDefinition,
  DEFAULT_AGENT_NAME,
  resolveAgentDriver,
  resolveAgentModel,
  type AgentName as AgentNameType,
  type AgentRunOverrides,
  type RunSpec,
} from "../../domain/agent.js"
import { getToolId, type ToolCapability } from "../../domain/capability/tool.js"
import { ErrorOccurred } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { type BranchId, type SessionId } from "../../domain/ids.js"
import type { ResourceDescriptor } from "../../domain/resource-graph.js"
import type { ResourceGenerationId } from "../../domain/resource-generation.js"
import type { TurnProjection } from "../../domain/extension.js"
import { compileSystemPrompt, type PromptSection } from "../../domain/prompt.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { ConfigService } from "../config-service.js"
import { DynamicExtensionRegistry } from "../../domain/dynamic-extension-registry.js"
import { DriverRegistry } from "../extensions/driver-registry.js"
import { compileToolPolicy, ExtensionRegistry } from "../extensions/registry.js"
import type { ResolvedTurn } from "./agent-loop.state.js"
import { buildTurnPromptSections, resolveReasoning } from "./agent-loop.utils.js"
import { CurrentExtensionHostContext } from "./current-extension-host-context.js"
import type { ResourceGraphPublication } from "../extensions/resource-host/resource-graph-host.js"
import type { RuntimeProfileCatalog } from "../profile.js"
import {
  dynamicToolEntry,
  mergeResolvedToolEntries,
  staticToolEntries,
  type ResolvedToolCapability,
} from "./tool-runner.js"
import { attachToolBindingIdentity, bindingResourcesFromPlan } from "./tool-binding-replay.js"

export interface ResolvedTurnContext extends ResolvedTurn {
  agent: AgentDefinition
  tools: ReadonlyArray<ToolCapability>
  /** Exact owner and implementation selected for each advertised tool. */
  toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  /** Policy-selected host tools remain callable inside a cell, not directly by the model. */
  hostToolBindings: ReadonlyMap<string, ResolvedToolCapability>
  /** Exact resource generation captured for process-local source-mode replay. */
  turnGenerationId?: ResourceGenerationId
}

const selectModelToolSurface = (
  tools: ReadonlyArray<ToolCapability>,
  toolBindings: ReadonlyMap<string, ResolvedToolCapability>,
  agent: AgentDefinition,
) => {
  const cell = toolBindings.get("cell")
  if (agent.driver?._tag === "external" || Predicate.isUndefined(cell)) {
    return { tools, toolBindings, cellHostTools: [] }
  }
  return {
    tools: [cell.capability],
    toolBindings: new Map([["cell", cell]]),
    cellHostTools: tools,
  }
}

/**
 * Resolve the tool surface a driver expects, used by the `systemPrompt`
 * slot to decide whether to append/replace tool-section content.
 * External drivers expose this on `ExternalDriverContribution.toolSurface`
 * (defaulting to `"native"` when omitted); model drivers are always native.
 * Returns `undefined` when no driver is set.
 */
const resolveDriverToolSurfaceOption = Effect.fn("TurnHelpers.resolveDriverToolSurface")(function* (
  agent: AgentDefinition,
) {
  const driver = yield* Effect.succeed(Option.fromUndefinedOr(agent.driver))
  if (Option.isNone(driver)) return Option.none<"native" | "codemode">()
  if (driver.value._tag === "model") return Option.some<"native" | "codemode">("native")
  const driverRegistry = yield* DriverRegistry
  const ext = yield* driverRegistry.getExternal(driver.value.id)
  const surface: "native" | "codemode" = Option.match(Option.fromUndefinedOr(ext), {
    onNone: () => "native",
    onSome: (value) => Option.getOrElse(Option.fromUndefinedOr(value.toolSurface), () => "native"),
  })
  return Option.some(surface)
})

export const resolveDriverToolSurface = (agent: AgentDefinition) =>
  resolveDriverToolSurfaceOption(agent).pipe(Effect.map(Option.getOrUndefined))

const hasAgentOverrides = (overrides: Option.Option<AgentRunOverrides>) =>
  Option.match(overrides, {
    onNone: () => false,
    onSome: (value) =>
      !Predicate.isUndefined(value.allowedTools) ||
      !Predicate.isUndefined(value.deniedTools) ||
      !Predicate.isUndefined(value.reasoningEffort) ||
      !Predicate.isUndefined(value.systemPromptAddendum),
  })

const mergeSystemPromptAddendum = (
  base: Option.Option<string>,
  addendum: Option.Option<string>,
): Option.Option<string> =>
  Option.match(addendum, {
    onNone: () => base,
    onSome: (value) =>
      Option.match(base, {
        onNone: () => Option.some(value),
        onSome: (baseValue) => Option.some(`${baseValue}\n\n${value}`),
      }),
  })

const applyAgentOverrides = (
  agent: AgentDefinition,
  overrides: Option.Option<AgentRunOverrides>,
): AgentDefinition => {
  if (!hasAgentOverrides(overrides)) return agent

  const override = overrides
  const systemPromptAddendum = Option.match(override, {
    onNone: () => Option.fromUndefinedOr(agent.systemPromptAddendum),
    onSome: (value) =>
      mergeSystemPromptAddendum(
        Option.fromUndefinedOr(agent.systemPromptAddendum),
        Option.fromUndefinedOr(value.systemPromptAddendum),
      ),
  })

  return AgentDefinition.make(
    Object.assign(
      { ...agent },
      Option.match(override, {
        onNone: () => ({}),
        onSome: (value) =>
          Object.assign(
            {},
            Option.match(Option.fromUndefinedOr(value.allowedTools), {
              onNone: () => ({}),
              onSome: (allowedTools) => ({ allowedTools }),
            }),
            Option.match(Option.fromUndefinedOr(value.deniedTools), {
              onNone: () => ({}),
              onSome: (deniedTools) => ({ deniedTools }),
            }),
            Option.match(Option.fromUndefinedOr(value.reasoningEffort), {
              onNone: () => ({}),
              onSome: (reasoningEffort) => ({ reasoningEffort }),
            }),
          ),
      }),
      Option.match(systemPromptAddendum, {
        onNone: () => ({}),
        onSome: (value) => ({ systemPromptAddendum: value }),
      }),
    ),
  )
}

export const resolveTurnContext = Effect.fn("TurnHelpers.resolveTurnContext")(function* (params: {
  agentOverride?: AgentNameType
  runSpec?: RunSpec
  currentAgent?: AgentNameType
  branchId: BranchId
  sessionId: SessionId
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
  turnPublication?: ResourceGraphPublication<RuntimeProfileCatalog>
  hash: (input: string) => string
}) {
  const extensionRegistry = yield* ExtensionRegistry
  const messageStorage = yield* MessageStorage
  const sessionStorage = yield* SessionStorage
  const eventPublisher = yield* EventPublisher
  const hostCtx = yield* CurrentExtensionHostContext
  const currentAgent = Option.getOrElse(Option.fromUndefinedOr(params.agentOverride), () =>
    Option.getOrElse(Option.fromUndefinedOr(params.currentAgent), () => DEFAULT_AGENT_NAME),
  )
  const rawMessages = yield* messageStorage
    .listMessages(params.branchId)
    .pipe(Effect.map((items) => [...items]))
  const resolvedExtensions = extensionRegistry.getResolved()
  const agents = [...resolvedExtensions.agents.values()]
  const agent = agents.find((entry) => entry.name === currentAgent)
  if (Predicate.isUndefined(agent)) {
    yield* eventPublisher
      .publish(
        ErrorOccurred.make({
          sessionId: params.sessionId,
          branchId: params.branchId,
          error: `Unknown agent: ${currentAgent}`,
        }),
      )
      .pipe(Effect.orDie)
    // oxlint-disable-next-line effect/noNullish -- Unknown agents are an expected resolution miss after the error event is published.
    return undefined
  }
  const effectiveAgent = applyAgentOverrides(
    agent,
    Option.fromUndefinedOr(params.runSpec?.overrides),
  )

  // Resolve runtime driver routing — `agent.driver` (hardcoded) wins,
  // then `UserConfig.driverOverrides[agent.name]`, else default.
  // `ConfigService` is a hard requirement of the actor behavior deps.
  // Making it optional here let test layers omit it and silently fall
  // through to the default driver, hiding wiring bugs.
  const configService = yield* ConfigService
  // Read driver overrides from the session's cwd. Without per-session
  // resolution, a multi-cwd server's project overrides would all
  // come from the launch cwd. `get(undefined)` falls back to the
  // launch-cwd cached config.
  const sessionConfig = yield* configService.get(hostCtx.cwd)
  const driverOverrides = sessionConfig.driverOverrides
  const driverResolution = resolveAgentDriver(effectiveAgent, driverOverrides)
  // If config-routed and the agent had no hardcoded driver, the
  // override replaces it — `effectiveAgent` is otherwise unchanged.
  let dispatchAgent = effectiveAgent
  if (driverResolution.source === "config") {
    dispatchAgent = AgentDefinition.make({ ...effectiveAgent, driver: driverResolution.driver })
  }

  // Derive extension projections from explicit prompt/message slots.
  const dynamicRegistryOption = yield* Effect.serviceOption(DynamicExtensionRegistry)
  let dynamicTools: ReadonlyArray<ResolvedToolCapability> = []
  if (dynamicRegistryOption._tag === "Some") {
    dynamicTools = yield* dynamicRegistryOption.value
      .listToolEntries(params.sessionId)
      .pipe(Effect.map((entries) => entries.map(dynamicToolEntry)))
  }
  const allToolEntries = mergeResolvedToolEntries(
    staticToolEntries(extensionRegistry),
    dynamicTools,
  )
  const allTools = allToolEntries.map((entry) => entry.capability)
  const turnCtx = {
    sessionId: params.sessionId,
    branchId: params.branchId,
    agent: effectiveAgent,
    allTools,
    interactive: params.interactive,
    tags: params.runSpec?.tags,
    agentName: currentAgent,
    parentToolCallId: params.runSpec?.parentToolCallId,
  }
  const projectionCtx = {
    sessionId: params.sessionId,
    branchId: params.branchId,
    cwd: hostCtx.cwd,
    home: hostCtx.home,
    sessionCwd: hostCtx.cwd,
    turn: turnCtx,
  }
  // Filter out hidden messages — visible in transcript but excluded from LLM context
  const messages = rawMessages.filter((m) => m.metadata?.hidden !== true)

  const projEval = yield* extensionRegistry.extensionHooks.resolveTurnProjection(projectionCtx)
  const extensionProjections: TurnProjection[] = projEval.policyFragments.map((p) => ({
    toolPolicy: p,
  }))
  if (projEval.promptSections.length > 0) {
    extensionProjections.push({ promptSections: projEval.promptSections })
  }

  // Resolve tools + extension prompt sections via ToolPolicy compiler
  const { tools: hostTools, promptSections: extensionSections } = compileToolPolicy(
    allTools,
    effectiveAgent,
    {
      sessionId: params.sessionId,
      branchId: params.branchId,
      agentName: currentAgent,
      interactive: params.interactive,
      tags: params.runSpec?.tags,
      parentToolCallId: params.runSpec?.parentToolCallId,
    },
    extensionProjections,
  )
  let bindingResources: ReadonlyArray<ResourceDescriptor> = []
  if (Predicate.isNotUndefined(params.turnPublication)) {
    bindingResources = bindingResourcesFromPlan(
      params.turnPublication.plan.descriptors,
      params.turnPublication.plan.startOrder,
    )
  }
  const bindingContext = {
    extensions: resolvedExtensions.extensions,
    resources: bindingResources,
    publicationRevision: params.turnPublication?.publicationRevision,
    hash: params.hash,
  }
  const entriesByToolId = new Map(
    allToolEntries.map((entry) => [
      String(getToolId(entry.capability)),
      attachToolBindingIdentity(entry, bindingContext),
    ]),
  )
  const hostToolBindings = new Map<string, ResolvedToolCapability>()
  for (const tool of hostTools) {
    const entry = entriesByToolId.get(String(getToolId(tool)))
    if (Predicate.isNotUndefined(entry)) hostToolBindings.set(String(getToolId(tool)), entry)
  }
  const { tools, toolBindings, cellHostTools } = selectModelToolSurface(
    hostTools,
    hostToolBindings,
    dispatchAgent,
  )

  // Build tool-aware prompt, then run through explicit prompt slots.
  // We hand the slot layer both the compiled `basePrompt` (for append-only
  // rewrites) AND the structured `sections` (for slots
  // that need to swap or strip a section by id, e.g. codemode replacing
  // `tool-list` / `tool-guidelines` rather than appending a contradicting
  // surface).
  const sections = buildTurnPromptSections(
    params.baseSections,
    effectiveAgent,
    tools,
    extensionSections,
    cellHostTools,
  )
  const turnPrompt = compileSystemPrompt(sections)
  const driverToolSurface = yield* resolveDriverToolSurface(dispatchAgent)
  const systemPrompt = yield* extensionRegistry.extensionHooks.resolveSystemPrompt({
    basePrompt: turnPrompt,
    agent: dispatchAgent,
    interactive: params.interactive,
    driverSource: driverResolution.source,
    tools,
    driverToolSurface,
    sections,
  })
  const session = yield* sessionStorage
    .getSession(params.sessionId)
    .pipe(Effect.catchEager(() => Effect.void))

  return {
    currentTurnAgent: currentAgent,
    messages,
    agent: dispatchAgent,
    tools,
    toolBindings,
    hostToolBindings,
    turnGenerationId: params.turnPublication?.generationId,
    systemPrompt,
    modelId: params.runSpec?.overrides?.modelId ?? resolveAgentModel(dispatchAgent),
    reasoning: Option.getOrUndefined(resolveReasoning(dispatchAgent, session?.reasoningLevel)),
    temperature: dispatchAgent.temperature,
    driver: dispatchAgent.driver,
    driverSource: driverResolution.source,
  }
})
