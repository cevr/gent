import { Effect, Option, Predicate } from "effect"
import { omitUndefined } from "../../domain/guards.js"
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
import type { TurnProjection } from "../../domain/extension.js"
import { compileSystemPrompt, type PromptSection } from "../../domain/prompt.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { ConfigService } from "../config-service.js"
import { compileToolPolicy, ExtensionRegistry } from "../extensions/registry.js"
import type { ResolvedTurn } from "./agent-loop.state.js"
import { buildTurnPromptSections, resolveReasoning } from "./agent-loop.utils.js"
import { CurrentExtensionHostContext } from "./current-extension-host-context.js"
import { staticToolEntries, type ResolvedToolCapability } from "./tool-runner.js"
import { attachToolBindingIdentity } from "./tool-binding-replay.js"

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

const applyAgentOverrides = (
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
      systemPromptAddendum: Option.getOrUndefined(systemPromptAddendum),
    }),
  })
}

export const resolveTurnContext = Effect.fn("TurnHelpers.resolveTurnContext")(function* (params: {
  agentOverride?: AgentNameType
  runSpec?: RunSpec
  currentAgent?: AgentNameType
  branchId: BranchId
  sessionId: SessionId
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
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
  const {
    tools: hostTools,
    modelTools: tools,
    promptSections: extensionSections,
  } = compileToolPolicy(
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
  const bindingContext = {
    extensions: resolvedExtensions.extensions,
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
    systemPrompt,
    modelId: resolveAgentModel(dispatchAgent),
    reasoning: Option.getOrUndefined(resolveReasoning(dispatchAgent, session?.reasoningLevel)),
    temperature: dispatchAgent.temperature,
    driver: dispatchAgent.driver,
  }
})
