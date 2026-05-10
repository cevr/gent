import { DateTime, Effect, Random, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentDefinition,
  DEFAULT_AGENT_NAME,
  resolveAgentDriver,
  resolveAgentModel,
  type AgentRunOverrides,
  type AgentName as AgentNameType,
  type RunSpec,
} from "../../domain/agent.js"
import { type ToolCapability } from "../../domain/capability/tool.js"
import { calculateCost, type ModelId } from "../../domain/model.js"
import { ConfigService } from "../config-service.js"
import type { InteractionPendingError } from "../../domain/interaction-request.js"
import type { PromptSection } from "../../domain/prompt.js"
import { compileSystemPrompt } from "../../domain/prompt.js"
import { DEFAULTS } from "../../domain/defaults.js"
import { Message } from "../../domain/message.js"
import { ToolCallId, type BranchId, type MessageId, type SessionId } from "../../domain/ids.js"
import {
  ErrorOccurred,
  MessageReceived,
  ProviderRetrying,
  ToolCallFailed,
  ToolCallSucceeded,
  type EventEnvelope,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { summarizeToolOutput, stringifyOutput } from "../../domain/tool-output.js"
import { Permission } from "../../domain/permission.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type { ProviderAuthError, TurnError } from "../../domain/driver.js"
import { AllowAllPermission } from "../session-runtime-context.js"
import { EventStorage } from "../../storage/event-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { withStorageTransaction } from "../../storage/sqlite-storage.js"
import { ProviderError } from "../../domain/provider-error.js"
import { ModelResolver } from "../../providers/model-resolver.js"
import { toPrompt } from "../../providers/ai-transcript.js"
import * as AiError from "effect/unstable/ai/AiError"
import type * as Response from "effect/unstable/ai/Response"
import { withRetry } from "../retry"
import { withWideEvent, WideEvent, providerStreamBoundary } from "../wide-event-boundary"
import { DriverRegistry } from "../extensions/driver-registry.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { convertTools, ToolRunner } from "./tool-runner"
import { buildTurnPromptSections, resolveReasoning } from "./agent-loop.utils.js"
import type { ResolvedTurn } from "./agent-loop.state.js"
import {
  collectFailedModelTurnResponse,
  formatStreamErrorMessage,
  type ActiveStreamHandle,
  type CollectedTurnResponse,
  type PublishEvent,
} from "./turn-response/collectors.js"

interface CommittedMutation<A> {
  readonly result: A
  readonly envelope?: EventEnvelope
}

export const findPersistedEvent = (params: {
  sessionId: SessionId
  branchId: BranchId
  match: (envelope: EventEnvelope) => boolean
}) =>
  Effect.gen(function* () {
    const eventStorage = yield* EventStorage
    const events = yield* eventStorage.listEvents({
      sessionId: params.sessionId,
      branchId: params.branchId,
    })
    return [...events].reverse().find(params.match)
  })

export const commitWithEvent = <A, E, R>(mutation: Effect.Effect<CommittedMutation<A>, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const eventPublisher = yield* EventPublisher
    const committed = yield* withStorageTransaction(sql, mutation)
    if (committed.envelope !== undefined) {
      yield* eventPublisher.deliver(committed.envelope)
    }
    return committed.result
  })

export const persistMessageReceived = (params: { message: Message }) =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const eventPublisher = yield* EventPublisher
    return yield* commitWithEvent(
      Effect.gen(function* () {
        const existing = yield* messageStorage.getMessage(params.message.id)
        if (existing !== undefined) {
          const envelope = yield* findPersistedEvent({
            sessionId: params.message.sessionId,
            branchId: params.message.branchId,
            match: (candidate) =>
              candidate.event._tag === "MessageReceived" &&
              candidate.event.message.id === params.message.id,
          })
          return {
            result: existing,
            ...(envelope !== undefined ? { envelope } : {}),
          }
        }

        yield* messageStorage.createMessageIfAbsent(params.message)
        const envelope = yield* eventPublisher.append(
          MessageReceived.make({
            message: params.message,
          }),
        )
        return { result: params.message, envelope }
      }),
    )
  })

export const recordToolResult = (params: {
  toolResultMessageId: MessageId
  sessionId: SessionId
  branchId: BranchId
  toolCallId: ToolCallId
  toolName: string
  output: unknown
  isError?: boolean
}) =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const eventPublisher = yield* EventPublisher
    const part = Prompt.toolResultPart({
      id: params.toolCallId,
      name: params.toolName,
      isFailure: params.isError === true,
      result: params.output,
    })

    const message = Message.Regular.make({
      id: params.toolResultMessageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "tool",
      parts: [part],
      createdAt: yield* DateTime.nowAsDate,
    })

    const isError = params.isError ?? false
    const toolCallFields = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      summary: summarizeToolOutput(part),
      output: stringifyOutput(part.result),
    }

    yield* commitWithEvent(
      Effect.gen(function* () {
        const existing = yield* messageStorage.getMessage(message.id)
        if (existing !== undefined) {
          const envelope = yield* findPersistedEvent({
            sessionId: params.sessionId,
            branchId: params.branchId,
            match: (candidate) =>
              (candidate.event._tag === "ToolCallSucceeded" ||
                candidate.event._tag === "ToolCallFailed") &&
              candidate.event.toolCallId === params.toolCallId,
          })
          return {
            result: existing,
            ...(envelope !== undefined ? { envelope } : {}),
          }
        }

        const result = yield* messageStorage.createMessageIfAbsent(message)
        const envelope = yield* eventPublisher.append(
          isError ? ToolCallFailed.make(toolCallFields) : ToolCallSucceeded.make(toolCallFields),
        )
        return { result, envelope }
      }),
    )
  })

export interface ResolvedTurnContext extends ResolvedTurn {
  agent: AgentDefinition
  tools: ReadonlyArray<ToolCapability>
}

export type AssistantResponsePart =
  | Prompt.TextPart
  | Prompt.ReasoningPart
  | Prompt.FilePart
  | Prompt.ToolCallPart
  | Prompt.ToolApprovalRequestPart

export type ToolResponsePart = Prompt.ToolResultPart | Prompt.ToolApprovalResponsePart

export const toolCallsFromResponseParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): ReadonlyArray<Prompt.ToolCallPart> =>
  parts.flatMap(
    (part): ReadonlyArray<Prompt.ToolCallPart> =>
      part.type === "tool-call"
        ? [
            Prompt.toolCallPart({
              id: part.id,
              name: part.name,
              params: part.params,
              providerExecuted: part.providerExecuted,
            }),
          ]
        : [],
  )

export const persistMessageParts = (params: {
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  role: "assistant" | "tool"
  parts: ReadonlyArray<Message["parts"][number]>
  createdAt?: Date
}) =>
  Effect.gen(function* () {
    if (params.parts.length === 0) return undefined

    const messageStorage = yield* MessageStorage
    const message = Message.Regular.make({
      id: params.messageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: params.role,
      parts: [...params.parts],
      createdAt: params.createdAt ?? (yield* DateTime.nowAsDate),
    })

    const existing = yield* messageStorage.getMessage(message.id)
    if (existing !== undefined) return existing

    return yield* persistMessageReceived({ message })
  })

export const persistAssistantParts = (params: {
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<AssistantResponsePart>
  createdAt?: Date
  agentName: AgentNameType
}) =>
  persistMessageParts({
    sessionId: params.sessionId,
    branchId: params.branchId,
    messageId: params.messageId,
    role: "assistant",
    parts: params.parts,
    createdAt: params.createdAt,
  })

export const persistToolParts = (params: {
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<ToolResponsePart>
  createdAt?: Date
}) =>
  persistMessageParts({
    sessionId: params.sessionId,
    branchId: params.branchId,
    messageId: params.messageId,
    role: "tool",
    parts: params.parts,
    createdAt: params.createdAt,
  })

/**
 * Resolve the tool surface a driver expects, used by the `systemPrompt`
 * slot to decide whether to append/replace tool-section content.
 * External drivers expose this on `ExternalDriverContribution.toolSurface`
 * (defaulting to `"native"` when omitted); model drivers are always native.
 * Returns `undefined` when no driver is set.
 */
export const resolveDriverToolSurface = (
  agent: AgentDefinition,
): Effect.Effect<"native" | "codemode" | undefined, never, DriverRegistry> =>
  Effect.gen(function* () {
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

export const resolveTurnContext = (params: {
  agentOverride?: AgentNameType
  runSpec?: RunSpec
  currentAgent?: AgentNameType
  branchId: BranchId
  sessionId: SessionId
  publishEvent: PublishEvent
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const extensionRegistry = yield* ExtensionRegistry
    const messageStorage = yield* MessageStorage
    const sessionStorage = yield* SessionStorage
    const currentAgent = params.agentOverride ?? params.currentAgent ?? DEFAULT_AGENT_NAME
    const rawMessages = yield* messageStorage
      .listMessages(params.branchId)
      .pipe(Effect.map((items) => [...items]))
    const agent = yield* extensionRegistry.getAgent(currentAgent)
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

/** InteractionPendingError enriched with the toolCallId that triggered it */
export class ToolInteractionPending {
  readonly _tag = "ToolInteractionPending" as const
  constructor(
    readonly pending: InteractionPendingError,
    readonly toolCallId: ToolCallId,
  ) {}
}

export const executeToolCalls = (params: {
  toolCalls: ReadonlyArray<Prompt.ToolCallPart>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const toolRunner = yield* ToolRunner
    return yield* Effect.forEach(
      params.toolCalls,
      (toolCall) =>
        Effect.gen(function* () {
          const ctx = {
            ...params.hostCtx,
            agentName: params.currentTurnAgent,
            toolCallId: ToolCallId.make(toolCall.id),
          }
          return yield* toolRunner
            .run(
              {
                toolCallId: ToolCallId.make(toolCall.id),
                toolName: toolCall.name,
                input: toolCall.params,
              },
              ctx,
              { publishEvent: params.publishEvent },
            )
            .pipe(
              Effect.mapError((e) => new ToolInteractionPending(e, ToolCallId.make(toolCall.id))),
            )
        }),
      { concurrency: Math.max(1, DEFAULTS.toolConcurrency) },
    )
  })

type ModelTurnSource = {
  readonly driverKind: "model"
  readonly driverId?: string
  readonly stream: Stream.Stream<Response.AnyPart, ProviderError>
  readonly formatStreamError: (streamError: ProviderError) => string
  readonly collect: <R>(
    effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
  ) => Effect.Effect<CollectedTurnResponse, ProviderAuthError, R>
}

type ExternalTurnSource = {
  readonly driverKind: "external"
  readonly driverId?: string
  readonly stream: Stream.Stream<Response.AnyPart, TurnError>
  readonly formatStreamError: (streamError: TurnError) => string
  readonly collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const resolveTurnSource = (params: {
  resolved: ResolvedTurnContext
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const driverRegistry = yield* DriverRegistry
    const modelResolver = yield* ModelResolver
    const toolRunner = yield* ToolRunner
    const extensionRegistry = yield* ExtensionRegistry
    const permissionOption = yield* Effect.serviceOption(Permission)
    const permission =
      permissionOption._tag === "Some" ? permissionOption.value : AllowAllPermission
    const { resolved } = params
    if (resolved.driver?._tag === "external") {
      const executor = yield* driverRegistry.getExternalExecutor(resolved.driver.id)
      if (executor === undefined) {
        yield* params
          .publishEvent(
            ErrorOccurred.make({
              sessionId: params.sessionId,
              branchId: params.branchId,
              error: `External driver "${resolved.driver.id}" not found`,
            }),
          )
          .pipe(Effect.orDie)
        return undefined
      }

      return {
        driverKind: "external" as const,
        driverId: resolved.driver.id,
        stream: executor.executeTurn({
          sessionId: params.sessionId,
          branchId: params.branchId,
          agent: resolved.agent,
          messages: resolved.messages,
          tools: resolved.tools,
          systemPrompt: resolved.systemPrompt,
          cwd: params.hostCtx.cwd,
          abortSignal: params.activeStream.abortController.signal,
          hostCtx: params.hostCtx,
          runTool: (toolName, args) =>
            Effect.gen(function* () {
              const toolCallId = ToolCallId.make(yield* Random.nextUUIDv4)
              return yield* toolRunner
                .run({ toolCallId, toolName, input: args }, { ...params.hostCtx, toolCallId })
                .pipe(
                  Effect.provideService(ExtensionRegistry, extensionRegistry),
                  Effect.provideService(Permission, permission),
                  Effect.orDie,
                )
            }),
        }),
        formatStreamError: (streamError: unknown) =>
          `External turn executor error: ${formatStreamErrorMessage(streamError)}`,
        collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      } satisfies ExternalTurnSource
    }

    const modelRequest = {
      modelId: resolved.modelId,
      hints: {
        ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
        ...(resolved.reasoning !== undefined ? { reasoning: resolved.reasoning } : {}),
      },
      driverRegistry,
      ...(resolved.driver?._tag === "model" && resolved.driver.id !== undefined
        ? { driverId: resolved.driver.id }
        : {}),
    }
    const prompt = toPrompt(resolved.messages, { systemPrompt: resolved.systemPrompt })
    const toolkit = convertTools([...resolved.tools])
    const rawStream = Stream.unwrap(
      modelResolver.resolve(modelRequest).pipe(
        Effect.map((model) =>
          resolved.tools.length > 0
            ? model.streamText({
                prompt,
                toolkit,
                disableToolCallResolution: true as const,
              })
            : model.streamText({ prompt }),
        ),
      ),
    )

    return {
      driverKind: "model" as const,
      stream: rawStream.pipe(
        Stream.mapError(
          (error: unknown) =>
            new ProviderError({
              message: AiError.isAiError(error) ? error.message : String(error),
              model: resolved.modelId,
              cause: error,
            }),
        ),
      ),
      formatStreamError: formatStreamErrorMessage,
      collect: <R>(
        effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
      ) =>
        // `ProviderAuthError` is a fail-closed credential-absence signal —
        // not retryable, not recoverable mid-turn. Let it escape so the RPC
        // seam surfaces the typed auth failure; narrow the retry scope to
        // transient `ProviderError` only.
        withRetry(effect, undefined, {
          onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
            params
              .publishEvent(
                ProviderRetrying.make({
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  attempt,
                  maxAttempts,
                  delayMs,
                  error: error.message,
                }),
              )
              .pipe(Effect.orDie),
        }).pipe(
          Effect.catchTag("ProviderError", (streamError) =>
            collectFailedModelTurnResponse({
              streamError,
              publishEvent: params.publishEvent,
              sessionId: params.sessionId,
              branchId: params.branchId,
              activeStream: params.activeStream,
              formatStreamError: formatStreamErrorMessage,
            }),
          ),
          Effect.tap((collected) =>
            WideEvent.set({
              inputTokens: collected.messageProjection.usage?.inputTokens ?? 0,
              outputTokens: collected.messageProjection.usage?.outputTokens ?? 0,
              toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
              interrupted: collected.interrupted,
              streamFailed: collected.streamFailed,
            }),
          ),
          withWideEvent(providerStreamBoundary(resolved.modelId)),
        ),
    } satisfies ModelTurnSource
  })

// Pricing snapshot lookup: given a modelId, yield current pricing (or
// undefined if not known). Resolved once per session at AgentLoop start so
// the per-turn emission path is context-free (the machine task R must stay
// narrow to what Machine.spawn provides).
export type PricingLookup = (
  modelId: ModelId,
) => Effect.Effect<{ readonly input: number; readonly output: number } | undefined>

// Freeze pricing into the StreamEnded event at emit time. Returns undefined
// when usage is absent or pricing is missing; the reducer treats that as a
// zero contribution. Storing the computed cost on the event makes the
// transcript authoritative: replaying the same events always sums to the
// same cost, even if ModelRegistry pricing later refreshes.
export const computeStreamEndedCost = (params: {
  modelId: ModelId
  usage: { inputTokens: number; outputTokens: number } | undefined
  getPricing: PricingLookup
}): Effect.Effect<number | undefined> =>
  Effect.gen(function* () {
    if (params.usage === undefined) return undefined
    const pricing = yield* params.getPricing(params.modelId)
    if (pricing === undefined) return undefined
    return calculateCost(params.usage, pricing)
  })

export const invokeTool = (params: {
  assistantMessageId: MessageId
  toolResultMessageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  input: unknown
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const toolCalls = [
      Prompt.toolCallPart({
        id: params.toolCallId,
        name: params.toolName,
        params: params.input,
        providerExecuted: false,
      }),
    ] as const

    yield* persistAssistantParts({
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.assistantMessageId,
      parts: toolCalls,
      agentName: params.currentTurnAgent,
    })

    const existing = yield* messageStorage.getMessage(params.toolResultMessageId)
    if (existing !== undefined) return

    const toolResults = yield* executeToolCalls({
      toolCalls,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      currentTurnAgent: params.currentTurnAgent,
      hostCtx: params.hostCtx,
    })
    yield* persistToolParts({
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.toolResultMessageId,
      parts: toolResults,
    })
  })
