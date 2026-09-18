import { Effect, Option, Predicate } from "effect"
import { omitUndefined } from "../../domain/guards.js"
import {
  AgentDefinition,
  type AgentName as AgentNameType,
  type AgentRunOverrides,
  DEFAULT_AGENT_NAME,
  DEFAULT_MODEL_ID,
  effectiveModelDriver,
  type ModelId,
  type ReasoningEffort,
  resolveAgentDriver,
  resolveAgentModel,
  type RunSpec,
} from "../../domain/agent.js"
import {
  compileSystemPrompt,
  getToolId,
  type PromptSection,
  type ToolCapability,
} from "../../domain/capability.js"
import { ErrorOccurred, EventPublisher } from "../../domain/event.js"
import { type BranchId, type SessionId } from "../../domain/ids.js"
import type { TurnProjection } from "../../domain/extension.js"
import { MessageStorage, SessionStorage } from "../../storage/storage.js"
import { ConfigService } from "../config.js"
import { CurrentExtensionHostContext, ExtensionRegistry } from "../extension-host.js"
import {
  attachToolBindingIdentity,
  compileToolPolicy,
  type ResolvedToolCapability,
  staticToolEntries,
} from "../tools.js"
import type { ResolvedTurn } from "../../domain/agent-loop.js"
import { buildTurnPromptSections } from "./agent-loop.utils.js"
export interface ResolvedTurnContext extends ResolvedTurn {
  agent: AgentDefinition
  tools: ReadonlyArray<ToolCapability>
  /** Exact owner and implementation selected for each advertised tool. */
  toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  /** Admitted host tools remain available to extension-owned execution surfaces. */
  hostToolBindings: ReadonlyMap<string, ResolvedToolCapability>
}

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

/** Config `agents[name]` and `RunSpec.overrides` reshape a definition the same way. */
export const applyAgentOverrides = (
  agent: AgentDefinition,
  overrides: Option.Option<AgentRunOverrides>,
): AgentDefinition => {
  const systemPromptAddendum = Option.match(overrides, {
    onNone: () => Option.fromUndefinedOr(agent.systemPromptAddendum),
    onSome: (value) =>
      mergeSystemPromptAddendum(
        Option.fromUndefinedOr(agent.systemPromptAddendum),
        Option.fromUndefinedOr(value.systemPromptAddendum),
      ),
  })

  const value = Option.getOrUndefined(overrides)
  return AgentDefinition.make({
    ...agent,
    ...omitUndefined({
      model: value?.modelId,
      allowedTools: value?.allowedTools,
      deniedTools: value?.deniedTools,
      reasoningEffort: value?.reasoningEffort,
      contextLength: value?.contextLength,
      maxSteps: value?.maxSteps,
      systemPromptAddendum: Option.getOrUndefined(systemPromptAddendum),
    }),
  })
}

interface SessionSettingsSource {
  readonly modelId?: ModelId
  readonly reasoningLevel?: ReasoningEffort
}

interface ResolvedSessionSettings {
  readonly modelId: ModelId
  readonly reasoningLevel: Option.Option<ReasoningEffort>
}

/**
 * What the next turn on a session would use. The session's own settings win
 * over the effective agent (definition plus config and run overrides); a
 * session whose agent is unknown falls back to the default model.
 */
export const resolveSessionSettings = (
  effectiveAgent: Option.Option<AgentDefinition>,
  session: SessionSettingsSource,
): ResolvedSessionSettings => ({
  modelId: Option.getOrElse(Option.fromUndefinedOr(session.modelId), () =>
    Option.match(effectiveAgent, {
      onNone: () => DEFAULT_MODEL_ID,
      onSome: resolveAgentModel,
    }),
  ),
  reasoningLevel: Option.orElse(Option.fromUndefinedOr(session.reasoningLevel), () =>
    Option.flatMap(effectiveAgent, (agent) => Option.fromUndefinedOr(agent.reasoningEffort)),
  ),
})

export const resolveTurnContext = Effect.fn("TurnHelpers.resolveTurnContext")(function* (params: {
  agentOverride?: AgentNameType
  runSpec?: RunSpec
  branchId: BranchId
  sessionId: SessionId
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
}) {
  const extensionRegistry = yield* ExtensionRegistry
  const messageStorage = yield* MessageStorage
  const sessionStorage = yield* SessionStorage
  const eventPublisher = yield* EventPublisher
  const hostCtx = yield* CurrentExtensionHostContext
  const currentAgent = params.agentOverride ?? DEFAULT_AGENT_NAME
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
  // `ConfigService` is a hard requirement of the actor behavior deps.
  // Making it optional here let test layers omit it and silently fall
  // through to the default driver, hiding wiring bugs.
  const configService = yield* ConfigService
  // Read overrides from the session's cwd. Without per-session
  // resolution, a multi-cwd server's project overrides would all
  // come from the launch cwd. `get(undefined)` falls back to the
  // launch-cwd cached config.
  const sessionConfig = yield* configService.get(hostCtx.cwd)
  // Config `agents[name]` reshapes the definition; the run's own overrides win.
  const effectiveAgent = applyAgentOverrides(
    applyAgentOverrides(agent, Option.fromUndefinedOr(sessionConfig.agents?.[agent.name])),
    Option.fromUndefinedOr(params.runSpec?.overrides),
  )

  // Resolve runtime driver routing — `agent.driver` (hardcoded) wins,
  // then `UserConfig.driverOverrides[agent.name]`, else default.
  const driverOverrides = sessionConfig.driverOverrides
  const driverResolution = resolveAgentDriver(effectiveAgent, driverOverrides)
  // If config-routed and the agent had no hardcoded driver, the
  // override replaces it — `effectiveAgent` is otherwise unchanged.
  let dispatchAgent = effectiveAgent
  if (driverResolution.source === "config") {
    dispatchAgent = AgentDefinition.make({ ...effectiveAgent, driver: driverResolution.driver })
  }

  // Derive extension projections from explicit prompt/message slots.
  const allToolEntries = staticToolEntries(extensionRegistry)
  const allTools = allToolEntries.map((entry) => entry.capability)
  const turnCtx = {
    sessionId: params.sessionId,
    branchId: params.branchId,
    agent: dispatchAgent,
    allTools,
    interactive: params.interactive,
    agentName: currentAgent,
    parentToolCallId: params.runSpec?.parentToolCallId,
  }
  // Filter out hidden messages — visible in transcript but excluded from LLM context
  const messages = rawMessages.filter((m) => m.metadata?.hidden !== true)

  const projEval = yield* extensionRegistry.extensionHooks.resolveTurnProjection(turnCtx)
  const extensionProjections: TurnProjection[] = projEval.policyFragments.map((p) => ({
    toolPolicy: p,
  }))
  if (projEval.promptSections.length > 0) {
    extensionProjections.push({ promptSections: projEval.promptSections })
  }

  // Resolve tools + extension prompt sections via ToolPolicy compiler
  const {
    tools: hostTools,
    modelTools: tools,
    promptSections: extensionSections,
  } = compileToolPolicy(allTools, effectiveAgent, params, extensionProjections)
  const entriesByToolId = new Map<string, ResolvedToolCapability>()
  for (const entry of allToolEntries) {
    const bound = yield* attachToolBindingIdentity(entry, resolvedExtensions.extensions)
    entriesByToolId.set(String(getToolId(entry.capability)), bound)
  }
  const hostToolBindings = new Map<string, ResolvedToolCapability>()
  for (const tool of hostTools) {
    const entry = entriesByToolId.get(String(getToolId(tool)))
    if (Predicate.isNotUndefined(entry)) hostToolBindings.set(String(getToolId(tool)), entry)
  }
  const selectedNames = new Set(tools.map((tool) => String(getToolId(tool))))
  const toolBindings = new Map([...hostToolBindings].filter(([name]) => selectedNames.has(name)))

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
  )
  const turnPrompt = compileSystemPrompt(sections)
  const systemPrompt = yield* extensionRegistry.extensionHooks.resolveSystemPrompt({
    basePrompt: turnPrompt,
    agent: dispatchAgent,
    interactive: params.interactive,
    tools,
    hostTools,
  })
  const session = yield* sessionStorage.getSession(params.sessionId).pipe(
    Effect.map(Option.fromUndefinedOr),
    Effect.orElseSucceed(() => Option.none()),
  )
  // The session's own settings win over the agent definition and config.
  const settings = resolveSessionSettings(
    Option.some(dispatchAgent),
    Option.getOrElse(session, (): SessionSettingsSource => ({})),
  )

  return {
    currentTurnAgent: currentAgent,
    messages,
    agent: dispatchAgent,
    tools,
    toolBindings,
    hostToolBindings,
    systemPrompt,
    modelId: settings.modelId,
    reasoning: Option.getOrUndefined(settings.reasoningLevel),
    temperature: dispatchAgent.temperature,
    driver: dispatchAgent.driver,
    modelDriver: effectiveModelDriver(
      Option.fromUndefinedOr(dispatchAgent.driver),
      settings.modelId,
    ),
  }
})
