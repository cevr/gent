import { DateTime, Effect, Ref, type Stream } from "effect"
import {
  AgentDefinition,
  DEFAULT_AGENT_NAME,
  resolveAgentDriver,
  resolveAgentModel,
  type AgentRunOverrides,
  type AgentName as AgentNameType,
  type RunSpec,
} from "../../../domain/agent.js"
import type { ToolToken } from "../../../domain/capability/tool.js"
import { calculateCost, type ModelId } from "../../../domain/model.js"
import { ConfigService } from "../../config-service.js"
import type { InteractionPendingError } from "../../../domain/interaction-request.js"
import type { PromptSection } from "../../../domain/prompt.js"
import { compileSystemPrompt } from "../../../domain/prompt.js"
import { DEFAULTS } from "../../../domain/defaults.js"
import {
  Message,
  ToolCallPart,
  ToolResultPart,
  type ImagePart,
  type ReasoningPart,
  type TextPart,
} from "../../../domain/message.js"
import {
  ToolCallId,
  type ActorCommandId,
  type BranchId,
  type MessageId,
  type SessionId,
} from "../../../domain/ids.js"
import { makeToolContext } from "../../../domain/tool.js"
import {
  ErrorOccurred,
  MessageReceived,
  ProviderRetrying,
  StreamEnded,
  StreamStarted,
  ToolCallFailed,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
  type EventEnvelope,
} from "../../../domain/event.js"
import type { EventPublisherService } from "../../../domain/event-publisher.js"
import { summarizeToolOutput, stringifyOutput } from "../../../domain/tool-output.js"
import type { PermissionService } from "../../../domain/permission.js"
import type { ExtensionHostContext } from "../../../domain/extension-host-context.js"
import type { ProviderAuthError, TurnError, TurnEvent } from "../../../domain/driver.js"
import type { StorageError, StorageService } from "../../../storage/sqlite-storage.js"
import {
  providerRequestFromMessages,
  type ProviderError,
  type ProviderStreamPart,
  type ProviderService,
} from "../../../providers/provider.js"
import type * as Response from "effect/unstable/ai/Response"
import { withRetry } from "../../retry"
import { withWideEvent, WideEvent, providerStreamBoundary } from "../../wide-event-boundary"
import type { ActorEngine } from "../../extensions/actor-engine.js"
import type { Receptionist } from "../../extensions/receptionist.js"
import type { DriverRegistryService } from "../../extensions/driver-registry.js"
import type { ExtensionRegistryService } from "../../extensions/registry.js"
import type { ExtensionRuntimeService } from "../../extensions/resource-host/extension-runtime.js"
import type { ResourceManagerService } from "../../resource-manager.js"
import type { ToolRunnerService } from "../tool-runner"
import {
  assistantMessageIdForTurn,
  buildTurnPromptSections,
  resolveReasoning,
  toolResultMessageIdForTurn,
} from "../agent-loop.utils.js"
import type { ResolvedTurn } from "../agent-loop.state.js"
import { toolResultMessageIdForCommand } from "../agent-loop.commands.js"
import {
  collectExternalTurnResponse,
  collectFailedModelTurnResponse,
  collectModelTurnResponse,
  formatStreamErrorMessage,
  type ActiveStreamHandle,
  type CollectedTurnResponse,
  type PublishEvent,
  type TurnMetrics,
} from "../turn-response/collectors.js"

type CommittedEvent<A> =
  | { readonly _tag: "changed"; readonly result: A; readonly envelope: EventEnvelope }
  | { readonly _tag: "unchanged"; readonly result: A; readonly envelope?: EventEnvelope }

export const findPersistedEvent = (params: {
  storage: StorageService
  sessionId: SessionId
  branchId: BranchId
  match: (envelope: EventEnvelope) => boolean
}) =>
  params.storage
    .listEvents({ sessionId: params.sessionId, branchId: params.branchId })
    .pipe(Effect.map((events) => [...events].reverse().find(params.match)))

export const commitWithEvent = <A, E, R>(params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  mutation: Effect.Effect<CommittedEvent<A>, E, R>
}) =>
  Effect.gen(function* () {
    const committed = yield* params.storage.withTransaction(params.mutation)
    if (committed.envelope !== undefined) {
      yield* params.eventPublisher.deliver(committed.envelope)
    }
    return committed.result
  })

export const persistMessageReceived = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  message: Message
}) =>
  commitWithEvent({
    storage: params.storage,
    eventPublisher: params.eventPublisher,
    mutation: Effect.gen(function* () {
      const existing = yield* params.storage.getMessage(params.message.id)
      if (existing !== undefined) {
        const envelope = yield* findPersistedEvent({
          storage: params.storage,
          sessionId: params.message.sessionId,
          branchId: params.message.branchId,
          match: (candidate) =>
            candidate.event._tag === "MessageReceived" &&
            candidate.event.message.id === params.message.id,
        })
        return {
          _tag: "unchanged" as const,
          result: existing,
          ...(envelope !== undefined ? { envelope } : {}),
        }
      }

      yield* params.storage.createMessageIfAbsent(params.message)
      const envelope = yield* params.eventPublisher.append(
        MessageReceived.make({
          message: params.message,
        }),
      )
      return { _tag: "changed" as const, result: params.message, envelope }
    }),
  })

export const recordToolResultPhase = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  commandId: ActorCommandId
  sessionId: SessionId
  branchId: BranchId
  toolCallId: ToolCallId
  toolName: string
  output: unknown
  isError?: boolean
}) =>
  Effect.gen(function* () {
    const outputType = params.isError === true ? "error-json" : "json"
    const part = new ToolResultPart({
      type: "tool-result",
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      output: { type: outputType, value: params.output },
    })

    const message = Message.Regular.make({
      id: toolResultMessageIdForCommand(params.commandId),
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
      output: stringifyOutput(part.output.value),
    }

    yield* commitWithEvent({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      mutation: Effect.gen(function* () {
        const existing = yield* params.storage.getMessage(message.id)
        if (existing !== undefined) {
          const envelope = yield* findPersistedEvent({
            storage: params.storage,
            sessionId: params.sessionId,
            branchId: params.branchId,
            match: (candidate) =>
              (candidate.event._tag === "ToolCallSucceeded" ||
                candidate.event._tag === "ToolCallFailed") &&
              candidate.event.toolCallId === params.toolCallId,
          })
          return {
            _tag: "unchanged" as const,
            result: existing,
            ...(envelope !== undefined ? { envelope } : {}),
          }
        }

        const result = yield* params.storage.createMessageIfAbsent(message)
        const envelope = yield* params.eventPublisher.append(
          isError ? ToolCallFailed.make(toolCallFields) : ToolCallSucceeded.make(toolCallFields),
        )
        return { _tag: "changed" as const, result, envelope }
      }),
    })
  })

export interface ResolvedTurnContext extends ResolvedTurn {
  agent: AgentDefinition
  tools: ReadonlyArray<ToolToken>
}

export type AssistantResponsePart = TextPart | ReasoningPart | ImagePart | ToolCallPart

export const toolCallsFromResponseParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): ReadonlyArray<ToolCallPart> =>
  parts.flatMap(
    (part): ReadonlyArray<ToolCallPart> =>
      part.type === "tool-call"
        ? [
            new ToolCallPart({
              type: "tool-call",
              toolCallId: ToolCallId.make(part.id),
              toolName: part.name,
              input: part.params,
            }),
          ]
        : [],
  )

export const persistMessageParts = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  role: "assistant" | "tool"
  parts: ReadonlyArray<Message["parts"][number]>
  createdAt?: Date
}) =>
  Effect.gen(function* () {
    if (params.parts.length === 0) return undefined

    const message = Message.Regular.make({
      id: params.messageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: params.role,
      parts: [...params.parts],
      createdAt: params.createdAt ?? (yield* DateTime.nowAsDate),
    })

    const existing = yield* params.storage.getMessage(message.id)
    if (existing !== undefined) return existing

    return yield* persistMessageReceived({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      message,
    })
  })

export const persistAssistantParts = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<AssistantResponsePart>
  createdAt?: Date
  agentName: AgentNameType
  extensionRegistry?: ExtensionRegistryService
  hostCtx?: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    if (
      params.extensionRegistry !== undefined &&
      params.hostCtx !== undefined &&
      params.parts.length > 0
    ) {
      yield* params.extensionRegistry.extensionReactions.emitMessageOutput(
        {
          sessionId: params.sessionId,
          branchId: params.branchId,
          agentName: params.agentName,
          parts: [...params.parts],
        },
        params.hostCtx,
      )
    }

    return yield* persistMessageParts({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.messageId,
      role: "assistant",
      parts: params.parts,
      createdAt: params.createdAt,
    })
  })

export const persistToolParts = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<ToolResultPart>
  createdAt?: Date
}) =>
  persistMessageParts({
    storage: params.storage,
    eventPublisher: params.eventPublisher,
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
  driverRegistry: DriverRegistryService,
): Effect.Effect<"native" | "codemode" | undefined> =>
  Effect.gen(function* () {
    const driver = agent.driver
    if (driver === undefined) return undefined
    if (driver._tag === "model") return "native"
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
  storage: StorageService
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
  extensionRuntime: ExtensionRuntimeService
  driverRegistry: DriverRegistryService
  sessionId: SessionId
  publishEvent: PublishEvent
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
  hostCtx: ExtensionHostContext
}): Effect.Effect<
  ResolvedTurnContext | undefined,
  StorageError,
  ConfigService | ActorEngine | Receptionist
> =>
  Effect.gen(function* () {
    const currentAgent = params.agentOverride ?? params.currentAgent ?? DEFAULT_AGENT_NAME
    const rawMessages = yield* params.storage
      .listMessages(params.branchId)
      .pipe(Effect.map((items) => [...items]))
    const agent = yield* params.extensionRegistry.getAgent(currentAgent)
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
    // `ConfigService` is a hard requirement of `AgentLoop.Live` — making
    // it optional here let test layers omit it and silently fall through
    // to the default driver, hiding wiring bugs.
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

    // Derive extension projections from state machines and explicit prompt/message slots.
    const allTools = yield* params.extensionRegistry.listModelCapabilities()
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
      turn: turnCtx,
    }
    const interceptedMessages =
      yield* params.extensionRegistry.extensionReactions.resolveContextMessages(
        {
          messages: rawMessages,
          agent: effectiveAgent,
          sessionId: params.sessionId,
          branchId: params.branchId,
        },
        { projection: projectionCtx, host: params.hostCtx },
      )

    // Filter out hidden messages — visible in transcript but excluded from LLM context
    const messages = interceptedMessages.filter((m) => m.metadata?.hidden !== true)

    const projEval =
      yield* params.extensionRegistry.extensionReactions.resolveTurnProjection(projectionCtx)
    const extensionProjections = [
      ...projEval.policyFragments.map((p) => ({ toolPolicy: p })),
      ...(projEval.promptSections.length > 0 ? [{ promptSections: projEval.promptSections }] : []),
    ]

    // Resolve tools + extension prompt sections via ToolPolicy compiler
    const { tools, promptSections: extensionSections } =
      yield* params.extensionRegistry.resolveToolPolicy(
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
    const allAgents = yield* params.extensionRegistry.listAgents()
    const sections = buildTurnPromptSections(
      params.baseSections,
      effectiveAgent,
      tools,
      extensionSections,
      allAgents,
    )
    const turnPrompt = compileSystemPrompt(sections)
    const driverToolSurface = yield* resolveDriverToolSurface(dispatchAgent, params.driverRegistry)
    const systemPrompt = yield* params.extensionRegistry.extensionReactions.resolveSystemPrompt(
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
    const session = yield* params.storage
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
  toolCalls: ReadonlyArray<ToolCallPart>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  hostCtx: ExtensionHostContext
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  permission?: PermissionService
  resourceManager: ResourceManagerService
}) =>
  Effect.forEach(
    params.toolCalls,
    (toolCall) =>
      Effect.gen(function* () {
        yield* params.publishEvent(
          ToolCallStarted.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
          }),
        )

        const ctx = makeToolContext(
          {
            ...params.hostCtx,
            agentName: params.currentTurnAgent,
          },
          toolCall.toolCallId,
        )
        const run = params.toolRunner
          .run(toolCall, ctx, {
            registry: params.extensionRegistry,
            ...(params.permission !== undefined ? { permission: params.permission } : {}),
          })
          .pipe(Effect.mapError((e) => new ToolInteractionPending(e, toolCall.toolCallId)))
        const tool = yield* params.extensionRegistry.getModelCapability(toolCall.toolName)
        const result = yield* params.resourceManager.withNeeds(tool?.needs ?? [], run)

        const outputSummary = summarizeToolOutput(result)
        const isError = result.output.type === "error-json"
        const toolCallFields = {
          sessionId: params.sessionId,
          branchId: params.branchId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          summary: outputSummary,
          output: stringifyOutput(result.output.value),
        }
        yield* params.publishEvent(
          isError ? ToolCallFailed.make(toolCallFields) : ToolCallSucceeded.make(toolCallFields),
        )
        yield* Effect.logInfo("tool.completed").pipe(
          Effect.annotateLogs({
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            isError,
          }),
        )

        return result
      }),
    { concurrency: Math.max(1, DEFAULTS.toolConcurrency) },
  )

export const resolveTurnPhase = (params: {
  message: Message
  agentOverride?: AgentNameType
  runSpec?: RunSpec
  currentAgent?: AgentNameType
  storage: StorageService
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
  extensionRuntime: ExtensionRuntimeService
  driverRegistry: DriverRegistryService
  sessionId: SessionId
  publishEvent: PublishEvent
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    yield* persistMessageReceived({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      message: params.message,
    })

    const resolved = yield* resolveTurnContext(params)
    if (resolved === undefined) return undefined

    return {
      currentTurnAgent: resolved.currentTurnAgent,
      messages: resolved.messages,
      systemPrompt: resolved.systemPrompt,
      modelId: resolved.modelId,
      tools: resolved.tools,
      agent: resolved.agent,
      ...(resolved.reasoning !== undefined ? { reasoning: resolved.reasoning } : {}),
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      ...(resolved.driver !== undefined ? { driver: resolved.driver } : {}),
      ...(resolved.driverSource !== undefined ? { driverSource: resolved.driverSource } : {}),
    } satisfies ResolvedTurn
  })

export const runTurnBeforeHook = (
  extensionRegistry: ExtensionRegistryService,
  resolved: ResolvedTurn,
  sessionId: SessionId,
  branchId: BranchId,
  hostCtx: ExtensionHostContext,
) =>
  extensionRegistry.extensionReactions.emitTurnBefore(
    {
      sessionId,
      branchId,
      agentName: resolved.currentTurnAgent,
      toolCount: resolved.tools?.length ?? 0,
      systemPromptLength: resolved.systemPrompt.length,
    },
    hostCtx,
  )

type ModelTurnSource = {
  readonly driverKind: "model"
  readonly driverId?: string
  readonly stream: Effect.Effect<
    Stream.Stream<ProviderStreamPart, ProviderError>,
    ProviderError | ProviderAuthError
  >
  readonly formatStreamError: (streamError: ProviderError) => string
  readonly collect: <R>(
    effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
  ) => Effect.Effect<CollectedTurnResponse, ProviderAuthError, R>
}

type ExternalTurnSource = {
  readonly driverKind: "external"
  readonly driverId?: string
  readonly stream: Stream.Stream<TurnEvent, TurnError>
  readonly formatStreamError: (streamError: TurnError) => string
  readonly collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const resolveTurnEventStream = (params: {
  resolved: ResolvedTurnContext
  provider: ProviderService
  driverRegistry: DriverRegistryService
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const { resolved } = params
    if (resolved.driver?._tag === "external") {
      const executor = yield* params.driverRegistry.getExternalExecutor(resolved.driver.id)
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
        }),
        formatStreamError: (streamError: unknown) =>
          `External turn executor error: ${formatStreamErrorMessage(streamError)}`,
        collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      } satisfies ExternalTurnSource
    }

    const streamEffect = params.provider.stream(
      providerRequestFromMessages({
        model: resolved.modelId,
        messages: [...resolved.messages],
        tools: [...resolved.tools],
        systemPrompt: resolved.systemPrompt,
        abortSignal: params.activeStream.abortController.signal,
        ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
        ...(resolved.reasoning !== undefined ? { reasoning: resolved.reasoning } : {}),
        driverRegistry: params.driverRegistry,
        ...(resolved.driver?._tag === "model" && resolved.driver.id !== undefined
          ? { driverId: resolved.driver.id }
          : {}),
      }),
    )

    return {
      driverKind: "model" as const,
      stream: streamEffect,
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

export const runTurnStreamPhase = (params: {
  messageId: MessageId
  step: number
  resolved: ResolvedTurnContext
  provider: ProviderService
  publishEvent: PublishEvent
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  extensionRegistry: ExtensionRegistryService
  driverRegistry: DriverRegistryService
  storage: StorageService
  hostCtx: ExtensionHostContext
  turnMetrics?: Ref.Ref<TurnMetrics>
  getPricing: PricingLookup
}) =>
  Effect.gen(function* () {
    const persistAssistantPartsLocal = (
      parts: ReadonlyArray<AssistantResponsePart>,
      createdAt?: Date,
    ) =>
      persistAssistantParts({
        storage: params.storage,
        eventPublisher: params.eventPublisher,
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: assistantMessageIdForTurn(params.messageId, params.step),
        parts,
        createdAt,
        agentName: params.resolved.currentTurnAgent,
        extensionRegistry: params.extensionRegistry,
        hostCtx: params.hostCtx,
      })

    const persistToolPartsLocal = (parts: ReadonlyArray<ToolResultPart>, createdAt?: Date) =>
      persistToolParts({
        storage: params.storage,
        eventPublisher: params.eventPublisher,
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: toolResultMessageIdForTurn(params.messageId, params.step),
        parts,
        createdAt,
      })

    const source = yield* resolveTurnEventStream({
      resolved: params.resolved,
      provider: params.provider,
      driverRegistry: params.driverRegistry,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      activeStream: params.activeStream,
      hostCtx: params.hostCtx,
    })

    if (source === undefined) {
      // `resolveTurnEventStream` returns undefined only when the resolved
      // driver is external and its executor is missing — classify the
      // failed turn by the requested driver kind so the outer loop's
      // `driverKind === "external"` break still fires if the stream-failed
      // check is ever reordered.
      return {
        responseParts: [],
        messageProjection: { assistant: [], tool: [] },
        interrupted: false,
        streamFailed: true,
        driverKind: params.resolved.driver?._tag === "external" ? "external" : "model",
      } satisfies CollectedTurnResponse
    }

    yield* params
      .publishEvent(StreamStarted.make({ sessionId: params.sessionId, branchId: params.branchId }))
      .pipe(Effect.orDie)

    yield* Effect.logInfo("turn-stream.start").pipe(
      Effect.annotateLogs({
        agent: params.resolved.currentTurnAgent,
        driverKind: source.driverKind,
        model: params.resolved.modelId,
        ...(source.driverId !== undefined ? { driverId: source.driverId } : {}),
      }),
    )

    const collected =
      source.driverKind === "model"
        ? yield* source.collect(
            source.stream.pipe(
              Effect.flatMap((turnStream) =>
                collectModelTurnResponse({
                  turnStream,
                  publishEvent: params.publishEvent,
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  modelId: params.resolved.modelId,
                  activeStream: params.activeStream,
                  formatStreamError: source.formatStreamError,
                  retryPreOutputFailures: true,
                }),
              ),
            ),
          )
        : yield* source.collect(
            collectExternalTurnResponse({
              turnStream: source.stream,
              publishEvent: params.publishEvent,
              sessionId: params.sessionId,
              branchId: params.branchId,
              activeStream: params.activeStream,
              formatStreamError: source.formatStreamError,
            }),
          )

    if (collected.interrupted) {
      yield* params
        .publishEvent(
          StreamEnded.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            interrupted: true,
          }),
        )
        .pipe(Effect.orDie)
      yield* persistAssistantPartsLocal(collected.messageProjection.assistant)
      return collected
    }

    if (collected.streamFailed) {
      yield* persistAssistantPartsLocal(collected.messageProjection.assistant)
      yield* persistToolPartsLocal(collected.messageProjection.tool)
      return collected
    }

    const streamEndedCost = yield* computeStreamEndedCost({
      modelId: params.resolved.modelId,
      usage: collected.messageProjection.usage,
      getPricing: params.getPricing,
    })
    yield* params
      .publishEvent(
        StreamEnded.make({
          sessionId: params.sessionId,
          branchId: params.branchId,
          ...(collected.messageProjection.usage !== undefined
            ? { usage: collected.messageProjection.usage }
            : {}),
          model: params.resolved.modelId,
          ...(streamEndedCost !== undefined ? { costUsd: streamEndedCost } : {}),
        }),
      )
      .pipe(Effect.orDie)
    yield* Effect.logInfo("stream.end").pipe(
      Effect.annotateLogs({
        driverKind: source.driverKind,
        inputTokens: collected.messageProjection.usage?.inputTokens ?? 0,
        outputTokens: collected.messageProjection.usage?.outputTokens ?? 0,
        toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
      }),
    )

    if (params.turnMetrics !== undefined) {
      yield* Ref.update(params.turnMetrics, (m) => ({
        ...m,
        agent: params.resolved.currentTurnAgent,
        model: params.resolved.modelId,
        inputTokens: m.inputTokens + (collected.messageProjection.usage?.inputTokens ?? 0),
        outputTokens: m.outputTokens + (collected.messageProjection.usage?.outputTokens ?? 0),
        toolCallCount: m.toolCallCount + toolCallsFromResponseParts(collected.responseParts).length,
      }))
    }

    yield* persistAssistantPartsLocal(collected.messageProjection.assistant)
    yield* persistToolPartsLocal(collected.messageProjection.tool)

    return collected
  })

export const executeToolsPhase = (params: {
  messageId: MessageId
  step: number
  toolCalls: ReadonlyArray<ToolCallPart>
  publishEvent: PublishEvent
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  hostCtx: ExtensionHostContext
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  permission?: PermissionService
  resourceManager: ResourceManagerService
  storage: StorageService
}) =>
  Effect.gen(function* () {
    if (params.toolCalls.length === 0) return

    const toolResultMessageId = toolResultMessageIdForTurn(params.messageId, params.step)
    const existing = yield* params.storage.getMessage(toolResultMessageId)
    if (existing !== undefined) return

    const toolResults = yield* executeToolCalls(params)
    yield* persistToolParts({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: toolResultMessageId,
      parts: toolResults,
    })
  })

export const invokeToolPhase = (params: {
  assistantMessageId: MessageId
  toolResultMessageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  input: unknown
  publishEvent: PublishEvent
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  permission?: PermissionService
  hostCtx: ExtensionHostContext
  resourceManager: ResourceManagerService
  storage: StorageService
}) =>
  Effect.gen(function* () {
    const toolCalls = [
      new ToolCallPart({
        type: "tool-call",
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        input: params.input,
      }),
    ] as const

    yield* persistAssistantParts({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.assistantMessageId,
      parts: toolCalls,
      agentName: params.currentTurnAgent,
      extensionRegistry: params.extensionRegistry,
      hostCtx: params.hostCtx,
    })

    const existing = yield* params.storage.getMessage(params.toolResultMessageId)
    if (existing !== undefined) return

    const toolResults = yield* executeToolCalls({
      toolCalls,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      currentTurnAgent: params.currentTurnAgent,
      hostCtx: params.hostCtx,
      toolRunner: params.toolRunner,
      extensionRegistry: params.extensionRegistry,
      permission: params.permission,
      resourceManager: params.resourceManager,
    })
    yield* persistToolParts({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.toolResultMessageId,
      parts: toolResults,
    })
  })

export const finalizeTurnPhase = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  startedAtMs: number
  messageId: MessageId
  turnInterrupted: boolean
  streamFailed?: boolean
  currentAgent: AgentNameType
  extensionRegistry: ExtensionRegistryService
  turnMetrics?: Ref.Ref<TurnMetrics>
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const existingMessage = yield* params.storage.getMessage(params.messageId)
    if (existingMessage?.turnDurationMs !== undefined) {
      const envelope = yield* findPersistedEvent({
        storage: params.storage,
        sessionId: params.sessionId,
        branchId: params.branchId,
        match: (candidate) =>
          candidate.event._tag === "TurnCompleted" &&
          candidate.event.messageId === params.messageId,
      })
      if (envelope !== undefined) {
        yield* params.eventPublisher.deliver(envelope)
      }
      return
    }

    const turnEndTime = yield* DateTime.now
    const turnDurationMs = DateTime.toEpochMillis(turnEndTime) - params.startedAtMs

    const envelope = yield* params.storage.withTransaction(
      Effect.gen(function* () {
        yield* params.storage.updateMessageTurnDuration(params.messageId, turnDurationMs)
        return yield* params.eventPublisher.append(
          TurnCompleted.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            messageId: params.messageId,
            durationMs: Number(turnDurationMs),
            ...(params.turnInterrupted ? { interrupted: true } : {}),
          }),
        )
      }),
    )
    yield* params.eventPublisher.deliver(envelope)

    yield* Effect.logDebug("finalize.turn-after.start")
    yield* params.extensionRegistry.extensionReactions.emitTurnAfter(
      {
        sessionId: params.sessionId,
        branchId: params.branchId,
        durationMs: Number(turnDurationMs),
        agentName: params.currentAgent,
        interrupted: params.turnInterrupted,
      },
      params.hostCtx,
    )
    yield* Effect.logDebug("finalize.turn-after.done")

    yield* Effect.logInfo("turn.completed").pipe(
      Effect.annotateLogs({
        durationMs: Number(turnDurationMs),
        interrupted: params.turnInterrupted,
      }),
    )

    // Emit turn-level wide event with accumulated metrics
    if (params.turnMetrics !== undefined) {
      const metrics = yield* Ref.get(params.turnMetrics)
      let status: "ok" | "error" | "interrupted" = "ok"
      if (params.turnInterrupted) status = "interrupted"
      else if (params.streamFailed === true) status = "error"
      yield* Effect.logInfo("wide-event").pipe(
        Effect.annotateLogs({
          service: "agent-loop",
          method: "turn",
          actor: metrics.agent,
          sessionId: params.sessionId,
          branchId: params.branchId,
          model: metrics.model,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          toolCallCount: metrics.toolCallCount,
          durationMs: Number(turnDurationMs),
          interrupted: params.turnInterrupted,
          status,
        }),
      )
    }
  })
