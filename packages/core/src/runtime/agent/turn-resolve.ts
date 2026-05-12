import { Effect } from "effect"
import {
  AgentDefinition,
  DEFAULT_AGENT_NAME,
  resolveAgentDriver,
  resolveAgentModel,
  type AgentName as AgentNameType,
  type AgentRunOverrides,
  type RunSpec,
} from "../../domain/agent.js"
import { type ToolCapability } from "../../domain/capability/tool.js"
import { ErrorOccurred } from "../../domain/event.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { type BranchId, type SessionId } from "../../domain/ids.js"
import { compileSystemPrompt, type PromptSection } from "../../domain/prompt.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { ConfigService } from "../config-service.js"
import { DriverRegistry } from "../extensions/driver-registry.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import type { ResolvedTurn } from "./agent-loop.state.js"
import { buildTurnPromptSections, resolveReasoning } from "./agent-loop.utils.js"
import type { PublishEvent } from "./turn-response.js"

export interface ResolvedTurnContext extends ResolvedTurn {
  agent: AgentDefinition
  tools: ReadonlyArray<ToolCapability>
}

/**
 * Resolve the tool surface a driver expects, used by the `systemPrompt`
 * slot to decide whether to append/replace tool-section content.
 * External drivers expose this on `ExternalDriverContribution.toolSurface`
 * (defaulting to `"native"` when omitted); model drivers are always native.
 * Returns `undefined` when no driver is set.
 */
export const resolveDriverToolSurface: (
  agent: AgentDefinition,
) => Effect.Effect<"native" | "codemode" | undefined, never, DriverRegistry> = Effect.fn(
  "TurnHelpers.resolveDriverToolSurface",
)(function* (agent) {
  const driver = agent.driver
  if (driver === undefined) return undefined
  if (driver._tag === "model") return "native"
  const driverRegistry = yield* DriverRegistry
  const ext = yield* driverRegistry.getExternal(driver.id)
  return ext?.toolSurface ?? "native"
})

const hasAgentOverrides = (overrides: AgentRunOverrides | undefined) =>
  overrides?.allowedTools !== undefined ||
  overrides?.deniedTools !== undefined ||
  overrides?.reasoningEffort !== undefined ||
  overrides?.systemPromptAddendum !== undefined

const mergeSystemPromptAddendum = (
  base: string | undefined,
  addendum: string | undefined,
): string | undefined => {
  if (addendum === undefined) return base
  return base !== undefined ? `${base}\n\n${addendum}` : addendum
}

const applyAgentOverrides = (
  agent: AgentDefinition,
  overrides: AgentRunOverrides | undefined,
): AgentDefinition => {
  if (!hasAgentOverrides(overrides)) return agent

  const systemPromptAddendum = mergeSystemPromptAddendum(
    agent.systemPromptAddendum,
    overrides?.systemPromptAddendum,
  )

  return AgentDefinition.make({
    ...agent,
    ...(overrides?.allowedTools !== undefined ? { allowedTools: overrides.allowedTools } : {}),
    ...(overrides?.deniedTools !== undefined ? { deniedTools: overrides.deniedTools } : {}),
    ...(overrides?.reasoningEffort !== undefined
      ? { reasoningEffort: overrides.reasoningEffort }
      : {}),
    ...(systemPromptAddendum !== agent.systemPromptAddendum ? { systemPromptAddendum } : {}),
  })
}

export const resolveTurnContext = Effect.fn("TurnHelpers.resolveTurnContext")(function* (params: {
  agentOverride?: AgentNameType
  runSpec?: RunSpec
  currentAgent?: AgentNameType
  branchId: BranchId
  sessionId: SessionId
  publishEvent: PublishEvent
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
  hostCtx: ExtensionHostContext
}) {
  const extensionRegistry = yield* ExtensionRegistry
  const messageStorage = yield* MessageStorage
  const sessionStorage = yield* SessionStorage
  const currentAgent = params.agentOverride ?? params.currentAgent ?? DEFAULT_AGENT_NAME
  const rawMessages = yield* messageStorage
    .listMessages(params.branchId)
    .pipe(Effect.map((items) => [...items]))
  const agents = yield* extensionRegistry.listAgents()
  const agent = agents.find((entry) => entry.name === currentAgent)
  if (agent === undefined) {
    yield* params
      .publishEvent(
        ErrorOccurred.make({
          sessionId: params.sessionId,
          branchId: params.branchId,
          error: `Unknown agent: ${currentAgent}`,
        }),
      )
      .pipe(Effect.orDie)
    return undefined
  }
  const effectiveAgent = applyAgentOverrides(agent, params.runSpec?.overrides)

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
  const sessionConfig = yield* configService.get(params.hostCtx.cwd)
  const driverOverrides = sessionConfig.driverOverrides ?? undefined
  const driverResolution = resolveAgentDriver(effectiveAgent, driverOverrides)
  // If config-routed and the agent had no hardcoded driver, the
  // override replaces it — `effectiveAgent` is otherwise unchanged.
  const dispatchAgent =
    driverResolution.source === "config"
      ? AgentDefinition.make({ ...effectiveAgent, driver: driverResolution.driver })
      : effectiveAgent

  // Derive extension projections from explicit prompt/message slots.
  const allTools = yield* extensionRegistry.listModelCapabilities()
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
    cwd: params.hostCtx.cwd,
    home: params.hostCtx.home,
    sessionCwd: params.hostCtx.cwd,
    ...(params.hostCtx.capabilityContext !== undefined
      ? { capabilityContext: params.hostCtx.capabilityContext }
      : {}),
    turn: turnCtx,
  }
  // Filter out hidden messages — visible in transcript but excluded from LLM context
  const messages = rawMessages.filter((m) => m.metadata?.hidden !== true)

  const projEval = yield* extensionRegistry.extensionReactions.resolveTurnProjection({
    projection: projectionCtx,
    host: params.hostCtx,
  })
  const extensionProjections = [
    ...projEval.policyFragments.map((p) => ({ toolPolicy: p })),
    ...(projEval.promptSections.length > 0 ? [{ promptSections: projEval.promptSections }] : []),
  ]

  // Resolve tools + extension prompt sections via ToolPolicy compiler
  const { tools, promptSections: extensionSections } = yield* extensionRegistry.resolveToolPolicy(
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

  // Build tool-aware prompt, then run through explicit prompt slots.
  // We hand the slot layer both the compiled `basePrompt` (for append-only
  // rewrites) AND the structured `sections` (for slots
  // that need to swap or strip a section by id, e.g. codemode replacing
  // `tool-list` / `tool-guidelines` rather than appending a contradicting
  // surface).
  const allAgents = yield* extensionRegistry.listAgents()
  const sections = buildTurnPromptSections(
    params.baseSections,
    effectiveAgent,
    tools,
    extensionSections,
    allAgents,
  )
  const turnPrompt = compileSystemPrompt(sections)
  const driverToolSurface = yield* resolveDriverToolSurface(dispatchAgent)
  const systemPrompt = yield* extensionRegistry.extensionReactions.resolveSystemPrompt(
    {
      basePrompt: turnPrompt,
      agent: dispatchAgent,
      interactive: params.interactive,
      driverSource: driverResolution.source,
      tools,
      ...(driverToolSurface !== undefined ? { driverToolSurface } : {}),
      sections,
    },
    { projection: projectionCtx, host: params.hostCtx },
  )
  const session = yield* sessionStorage
    .getSession(params.sessionId)
    .pipe(Effect.catchEager(() => Effect.void))

  return {
    currentTurnAgent: currentAgent,
    messages,
    agent: dispatchAgent,
    tools,
    systemPrompt,
    modelId: params.runSpec?.overrides?.modelId ?? resolveAgentModel(dispatchAgent),
    reasoning: resolveReasoning(dispatchAgent, session?.reasoningLevel),
    temperature: dispatchAgent.temperature,
    driver: dispatchAgent.driver,
    driverSource: driverResolution.source,
  }
})
