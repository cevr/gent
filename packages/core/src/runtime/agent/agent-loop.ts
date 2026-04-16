import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect"
import {
  type AnyInspectionEvent,
  ActorScope,
  combineInspectors,
  InspectorService,
  Machine,
  makeInspectorEffect,
  tracingInspector,
} from "effect-machine"
import {
  AgentDefinition,
  AgentName,
  AgentRunError,
  AgentRunnerService,
  DEFAULT_AGENT_NAME,
  resolveAgentModel,
  type AgentExecutionOverrides,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { type QueueSnapshot } from "../../domain/queue.js"
import {
  AgentSwitched,
  StreamStarted,
  StreamChunk as EventStreamChunk,
  StreamEnded,
  ToolCallStarted,
  ToolCallSucceeded,
  ToolCallFailed,
  MessageReceived,
  ErrorOccurred,
  ProviderRetrying,
  TurnCompleted,
  TurnRecoveryApplied,
  MachineInspected,
  type AgentEvent,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { Message, TextPart, ReasoningPart, ToolCallPart } from "../../domain/message.js"
import { BranchId, MessageId, SessionId, ToolCallId } from "../../domain/ids.js"
import { type AnyToolDefinition, type ToolContext } from "../../domain/tool.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import {
  makeExtensionHostContext,
  unavailableHostDeps,
  type MakeExtensionHostContextDeps,
} from "../make-extension-host-context.js"
import { PromptPresenter } from "../../domain/prompt-presenter.js"
import { SearchStorage } from "../../storage/search-storage.js"
import { RuntimePlatform } from "../runtime-platform.js"
import { ApprovalService } from "../approval-service.js"
import type { InteractionPendingError } from "../../domain/interaction-request.js"
import type { PromptSection } from "../../server/system-prompt.js"
import { DEFAULTS } from "../../domain/defaults.js"
import { Storage, type StorageError, type StorageService } from "../../storage/sqlite-storage.js"
import { CheckpointStorage } from "../../storage/checkpoint-storage.js"
import {
  Provider,
  type ProviderError,
  type ProviderService,
  type StreamChunk as ProviderStreamChunk,
} from "../../providers/provider.js"
import { summarizeToolOutput, stringifyOutput } from "../../domain/tool-output.js"
import { hasMessage } from "../../domain/guards.js"
import { withRetry } from "../retry"
import { SessionProfileCache } from "../session-profile.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import {
  ExtensionStateRuntime,
  type ExtensionStateRuntimeService,
} from "../extensions/state-runtime.js"
import { ExtensionTurnControl } from "../extensions/turn-control.js"
import { withWideEvent, WideEvent, providerStreamBoundary } from "../wide-event-boundary"
import type { TurnExecutor, TurnEvent } from "../../domain/turn-executor.js"
import { ToolRunner, type ToolRunnerService } from "./tool-runner"
import {
  AGENT_LOOP_CHECKPOINT_VERSION,
  buildLoopCheckpointRecord,
  decodeLoopCheckpointState,
  shouldRetainLoopCheckpoint,
} from "./agent-loop.checkpoint.js"
import {
  AgentLoopEvent,
  AgentLoopState,
  appendFollowUpQueueState,
  appendSteeringItem,
  buildIdleState,
  buildRunningState,
  clearQueueState,
  countQueuedFollowUps,
  emptyLoopQueueState,
  queueSnapshotFromState,
  runtimeStateFromLoopState,
  takeNextQueuedTurn,
  toWaitingForInteractionState,
  updateCurrentAgentOnState,
  updateQueueOnState,
  type AssistantDraft,
  type LoopActor,
  type LoopRuntimePhase,
  type LoopRuntimeState,
  type LoopRuntimeStatus,
  type LoopState,
  type QueuedTurnItem,
  type ResolvedTurn,
  type RunningState,
} from "./agent-loop.state.js"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
  buildTurnPrompt,
  resolveReasoning,
  toolResultMessageIdForTurn,
} from "./agent-loop.utils.js"

// ============================================================================
// Turn Phases (inlined from agent-loop-phases.ts)
// ============================================================================

const formatStreamErrorMessage = (streamError: unknown) => {
  if (streamError instanceof Error) return streamError.message
  if (hasMessage(streamError)) return streamError.message
  return String(streamError)
}

type PublishEvent = (event: AgentEvent) => Effect.Effect<void, never>

export type ActiveStreamHandle = {
  abortController: AbortController
  interruptDeferred: Deferred.Deferred<void>
  interruptedRef: Ref.Ref<boolean>
}

/** Mutable accumulator for per-turn wide event fields. */
export type TurnMetrics = {
  agent: string
  model: string
  inputTokens: number
  outputTokens: number
  toolCallCount: number
}

export const emptyTurnMetrics = (): TurnMetrics => ({
  agent: DEFAULT_AGENT_NAME,
  model: "",
  inputTokens: 0,
  outputTokens: 0,
  toolCallCount: 0,
})

interface ResolvedTurnContext extends ResolvedTurn {
  agent: AgentDefinition
  tools: ReadonlyArray<AnyToolDefinition>
}

const persistAssistantText = (params: {
  storage: StorageService
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  text: string
  reasoning: string
  createdAt?: Date
}) =>
  Effect.gen(function* () {
    if (params.text === "" && params.reasoning === "") return undefined

    const parts: Array<TextPart | ReasoningPart> = []
    if (params.reasoning !== "") {
      parts.push(new ReasoningPart({ type: "reasoning", text: params.reasoning }))
    }
    if (params.text !== "") {
      parts.push(new TextPart({ type: "text", text: params.text }))
    }

    const message = new Message({
      id: params.messageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "assistant",
      parts,
      createdAt: params.createdAt ?? (yield* DateTime.nowAsDate),
    })

    const existing = yield* params.storage.getMessage(message.id)
    if (existing !== undefined) return existing

    yield* params.storage.createMessageIfAbsent(message)
    yield* params
      .publishEvent(
        new MessageReceived({
          sessionId: params.sessionId,
          branchId: params.branchId,
          messageId: message.id,
          role: "assistant",
        }),
      )
      .pipe(Effect.orDie)
    return message
  })

const resolveTurnContext = (params: {
  agentOverride?: AgentNameType
  executionOverrides?: AgentExecutionOverrides
  currentAgent?: AgentNameType
  storage: StorageService
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
  extensionStateRuntime: ExtensionStateRuntimeService
  sessionId: SessionId
  publishEvent: PublishEvent
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
  hostCtx: ExtensionHostContext
}): Effect.Effect<ResolvedTurnContext | undefined, StorageError> =>
  Effect.gen(function* () {
    const currentAgent = params.agentOverride ?? params.currentAgent ?? DEFAULT_AGENT_NAME
    const rawMessages = yield* params.storage
      .listMessages(params.branchId)
      .pipe(Effect.map((items) => [...items]))
    const agent = yield* params.extensionRegistry.getAgent(currentAgent)
    if (agent === undefined) {
      yield* params
        .publishEvent(
          new ErrorOccurred({
            sessionId: params.sessionId,
            branchId: params.branchId,
            error: `Unknown agent: ${currentAgent}`,
          }),
        )
        .pipe(Effect.orDie)
      return undefined
    }
    const effectiveAgent = applyAgentOverrides(agent, params.executionOverrides)

    // Run context.messages interceptor — extensions can inject hidden context or filter messages
    const interceptedMessages = yield* params.extensionRegistry.hooks.runInterceptor(
      "context.messages",
      {
        messages: rawMessages,
        agent: effectiveAgent,
        sessionId: params.sessionId,
        branchId: params.branchId,
      },
      (input) => Effect.succeed(input.messages),
      params.hostCtx,
    )

    // Filter out hidden messages — visible in transcript but excluded from LLM context
    const messages = interceptedMessages.filter((m) => m.metadata?.hidden !== true)

    // Derive extension projections from state machines
    const allTools = yield* params.extensionRegistry.listTools()
    const turnCtx = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      agent: effectiveAgent,
      allTools,
      interactive: params.interactive,
      tags: params.executionOverrides?.tags,
      agentName: currentAgent,
      parentToolCallId: params.executionOverrides?.parentToolCallId,
    }
    const extensionResults = yield* params.extensionStateRuntime.deriveAll(
      params.sessionId,
      turnCtx,
    )
    const actorProjections = extensionResults.map((r) => r.projection)

    // Evaluate ProjectionContribution-based projections — merge into the same
    // TurnProjection list consumed by compileToolPolicy. Actor projections
    // (above) and projection contributions (here) feed the same pipeline.
    const projEval = yield* params.extensionRegistry.getResolved().projections.evaluateAll({
      sessionId: params.sessionId,
      branchId: params.branchId,
      cwd: params.hostCtx.cwd,
      home: params.hostCtx.home,
      turn: turnCtx,
    })
    const extensionProjections = [
      ...actorProjections,
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
          tags: params.executionOverrides?.tags,
          parentToolCallId: params.executionOverrides?.parentToolCallId,
        },
        extensionProjections,
      )

    // Build tool-aware prompt, then run through prompt.system interceptor
    const allAgents = yield* params.extensionRegistry.listAgents()
    const turnPrompt = buildTurnPrompt(
      params.baseSections,
      effectiveAgent,
      tools,
      extensionSections,
      allAgents,
    )
    const systemPrompt = yield* params.extensionRegistry.hooks.runInterceptor(
      "prompt.system",
      { basePrompt: turnPrompt, agent: effectiveAgent, interactive: params.interactive },
      (input) => Effect.succeed(input.basePrompt),
      params.hostCtx,
    )
    const session = yield* params.storage
      .getSession(params.sessionId)
      .pipe(Effect.catchEager(() => Effect.void))

    return {
      currentTurnAgent: currentAgent,
      messages,
      agent: effectiveAgent,
      tools,
      systemPrompt,
      modelId: params.executionOverrides?.modelId ?? resolveAgentModel(effectiveAgent),
      reasoning: resolveReasoning(effectiveAgent, session?.reasoningLevel),
      temperature: effectiveAgent.temperature,
      execution: effectiveAgent.execution,
    }
  })

const collectStreamResponse = (params: {
  streamEffect: Stream.Stream<ProviderStreamChunk, ProviderError>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  persistAssistantText: (
    text: string,
    reasoning: string,
    createdAt?: Date,
  ) => Effect.Effect<Message | undefined, StorageError>
}) =>
  Effect.gen(function* () {
    const textParts: string[] = []
    const reasoningParts: string[] = []
    const toolCalls: ToolCallPart[] = []
    let usage: AssistantDraft["usage"] | undefined

    const streamFailed = yield* Stream.runForEach(
      params.streamEffect.pipe(
        Stream.interruptWhen(Deferred.await(params.activeStream.interruptDeferred)),
      ),
      (chunk) =>
        Effect.gen(function* () {
          if (chunk._tag === "TextChunk") {
            textParts.push(chunk.text)
            yield* params
              .publishEvent(
                new EventStreamChunk({
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  chunk: chunk.text,
                }),
              )
              .pipe(Effect.orDie)
            return
          }
          if (chunk._tag === "ReasoningChunk") {
            reasoningParts.push(chunk.text)
            return
          }
          if (chunk._tag === "ToolCallChunk") {
            toolCalls.push(
              new ToolCallPart({
                type: "tool-call",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
              }),
            )
            return
          }
          if (chunk._tag === "FinishChunk") {
            usage = chunk.usage
          }
        }),
    ).pipe(
      Effect.as(false),
      Effect.catchEager((streamError) =>
        Effect.gen(function* () {
          const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
          if (interrupted) return false
          yield* Effect.logWarning("stream error, persisting partial output").pipe(
            Effect.annotateLogs({ error: String(streamError) }),
          )
          yield* params.persistAssistantText(textParts.join(""), reasoningParts.join(""))
          yield* params
            .publishEvent(
              new StreamEnded({ sessionId: params.sessionId, branchId: params.branchId }),
            )
            .pipe(Effect.orDie)
          yield* params
            .publishEvent(
              new ErrorOccurred({
                sessionId: params.sessionId,
                branchId: params.branchId,
                error: formatStreamErrorMessage(streamError),
              }),
            )
            .pipe(Effect.orDie)
          return true
        }),
      ),
    )

    const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
    return {
      draft: {
        text: textParts.join(""),
        reasoning: reasoningParts.join(""),
        toolCalls,
        ...(usage !== undefined ? { usage } : {}),
      },
      streamFailed,
      interrupted,
    }
  })

export const persistAssistantTurn = (params: {
  storage: StorageService
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  draft: AssistantDraft
  agentName: AgentNameType
  extensionRegistry?: ExtensionRegistryService
  hostCtx?: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const assistantParts: Array<TextPart | ReasoningPart | ToolCallPart> = []
    if (params.draft.reasoning !== "") {
      assistantParts.push(new ReasoningPart({ type: "reasoning", text: params.draft.reasoning }))
    }
    if (params.draft.text !== "") {
      assistantParts.push(new TextPart({ type: "text", text: params.draft.text }))
    }
    assistantParts.push(...params.draft.toolCalls)

    const assistantMessage = new Message({
      id: params.messageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "assistant",
      parts: assistantParts,
      createdAt: yield* DateTime.nowAsDate,
    })

    const existing = yield* params.storage.getMessage(assistantMessage.id)
    if (existing !== undefined) return

    // Fire message.output hook — only for new messages (idempotent)
    if (params.extensionRegistry !== undefined && params.hostCtx !== undefined) {
      yield* params.extensionRegistry.hooks
        .runInterceptor(
          "message.output",
          {
            sessionId: params.sessionId,
            branchId: params.branchId,
            agentName: params.agentName,
            parts: assistantParts,
          },
          () => Effect.void,
          params.hostCtx,
        )
        .pipe(Effect.catchEager(() => Effect.void))
    }

    yield* params.storage.createMessageIfAbsent(assistantMessage)
    yield* params
      .publishEvent(
        new MessageReceived({
          sessionId: params.sessionId,
          branchId: params.branchId,
          messageId: assistantMessage.id,
          role: "assistant",
        }),
      )
      .pipe(Effect.orDie)
  })

/** InteractionPendingError enriched with the toolCallId that triggered it */
class ToolInteractionPending {
  readonly _tag = "ToolInteractionPending" as const
  constructor(
    readonly pending: InteractionPendingError,
    readonly toolCallId: ToolCallId,
  ) {}
}

const executeToolCalls = (params: {
  draft: AssistantDraft
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  extensionStateRuntime?: ExtensionStateRuntimeService
  bashSemaphore: Semaphore.Semaphore
}) =>
  Effect.forEach(
    params.draft.toolCalls,
    (toolCall) =>
      Effect.gen(function* () {
        yield* params.publishEvent(
          new ToolCallStarted({
            sessionId: params.sessionId,
            branchId: params.branchId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
          }),
        )

        // Thin context — ToolRunner.run() enriches this via makeExtensionHostContext
        const ctx: ToolContext = {
          sessionId: params.sessionId,
          branchId: params.branchId,
          toolCallId: toolCall.toolCallId,
          agentName: params.currentTurnAgent,
          cwd: "",
          home: "",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          extension: {} as ToolContext["extension"],
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          agent: {} as ToolContext["agent"],
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          session: {} as ToolContext["session"],
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          interaction: {} as ToolContext["interaction"],
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          turn: {} as ToolContext["turn"],
        }
        const run = params.toolRunner
          .run(toolCall, ctx, {
            registry: params.extensionRegistry,
            stateRuntime: params.extensionStateRuntime,
          })
          .pipe(Effect.mapError((e) => new ToolInteractionPending(e, toolCall.toolCallId)))
        const tool = yield* params.extensionRegistry.getTool(toolCall.toolName)
        const result = yield* tool?.concurrency === "serial"
          ? Effect.withSpan("AgentLoop.bashSemaphore")(params.bashSemaphore.withPermits(1)(run))
          : run

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
          isError ? new ToolCallFailed(toolCallFields) : new ToolCallSucceeded(toolCallFields),
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
  executionOverrides?: AgentExecutionOverrides
  currentAgent?: AgentNameType
  storage: StorageService
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
  extensionStateRuntime: ExtensionStateRuntimeService
  sessionId: SessionId
  publishEvent: PublishEvent
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const existing = yield* params.storage.getMessage(params.message.id)
    if (existing === undefined) {
      yield* params.storage.createMessageIfAbsent(params.message)
      yield* params
        .publishEvent(
          new MessageReceived({
            sessionId: params.sessionId,
            branchId: params.branchId,
            messageId: params.message.id,
            role: "user",
          }),
        )
        .pipe(Effect.orDie)
    }

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
      ...(resolved.execution !== undefined ? { execution: resolved.execution } : {}),
    } satisfies ResolvedTurn
  })

const runTurnBeforeHook = (
  extensionRegistry: ExtensionRegistryService,
  resolved: ResolvedTurn,
  sessionId: SessionId,
  branchId: BranchId,
  hostCtx: ExtensionHostContext,
) =>
  extensionRegistry.hooks
    .runInterceptor(
      "turn.before",
      {
        sessionId,
        branchId,
        agentName: resolved.currentTurnAgent,
        toolCount: resolved.tools?.length ?? 0,
        systemPromptLength: resolved.systemPrompt.length,
      },
      () => Effect.void,
      hostCtx,
    )
    .pipe(Effect.catchEager(() => Effect.void))

/**
 * Attempt to dispatch a turn to an external TurnExecutor.
 * Returns undefined if the agent uses model execution (caller should fall through to streamTurnPhase).
 * Returns { interrupted, streamFailed } if the external turn was handled.
 */
const dispatchExternalTurn = (params: {
  resolved: ResolvedTurn
  extensionRegistry: ExtensionRegistryService
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  step: number
  activeStream: ActiveStreamHandle
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  turnToolsRef: Ref.Ref<ReadonlyArray<AnyToolDefinition>>
  storage: StorageService
  hostCtx: ExtensionHostContext
  turnMetrics?: Ref.Ref<TurnMetrics>
}) =>
  Effect.gen(function* () {
    const { resolved } = params
    if (resolved.execution?._tag !== "external" || resolved.agent === undefined) return undefined

    const executor = yield* params.extensionRegistry.getTurnExecutor(resolved.execution.runnerId)
    if (executor === undefined) {
      yield* params
        .publishEvent(
          new ErrorOccurred({
            sessionId: params.sessionId,
            branchId: params.branchId,
            error: `Turn executor "${resolved.execution.runnerId}" not found`,
          }),
        )
        .pipe(Effect.orDie)
      return { interrupted: false, streamFailed: true }
    }

    const result = yield* collectExternalTurn({
      executor,
      resolved: {
        ...resolved,
        agent: resolved.agent,
        tools: yield* Ref.get(params.turnToolsRef),
      },
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.messageId,
      step: params.step,
      activeStream: params.activeStream,
      storage: params.storage,
      extensionRegistry: params.extensionRegistry,
      hostCtx: params.hostCtx,
      turnMetrics: params.turnMetrics,
    }).pipe(Effect.ensuring(Ref.set(params.activeStreamRef, undefined)))

    return result
  })

/**
 * Collect an external turn from a TurnExecutor stream → AssistantDraft.
 * Tool events (tool-started/completed/failed) are observability only — they do NOT
 * populate draft.toolCalls, preventing executeToolsPhase from re-executing them.
 */
export const collectExternalTurn = (params: {
  executor: TurnExecutor
  resolved: ResolvedTurn & { agent: AgentDefinition; tools: ReadonlyArray<AnyToolDefinition> }
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  step: number
  activeStream: ActiveStreamHandle
  storage: StorageService
  extensionRegistry: ExtensionRegistryService
  hostCtx: ExtensionHostContext
  turnMetrics?: Ref.Ref<TurnMetrics>
}) =>
  Effect.gen(function* () {
    const persistAssistantTextLocal = (text: string, reasoning: string, createdAt?: Date) =>
      persistAssistantText({
        storage: params.storage,
        publishEvent: params.publishEvent,
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: assistantMessageIdForTurn(params.messageId, params.step),
        text,
        reasoning,
        createdAt,
      })

    yield* params
      .publishEvent(new StreamStarted({ sessionId: params.sessionId, branchId: params.branchId }))
      .pipe(Effect.orDie)
    yield* Effect.logInfo("external-turn.start").pipe(
      Effect.annotateLogs({
        agent: params.resolved.currentTurnAgent,
        runnerId:
          params.resolved.execution?._tag === "external"
            ? params.resolved.execution.runnerId
            : "unknown",
      }),
    )

    const textParts: string[] = []
    const reasoningParts: string[] = []
    let usage: AssistantDraft["usage"] | undefined

    const turnStream = params.executor.executeTurn({
      sessionId: params.sessionId,
      branchId: params.branchId,
      agent: params.resolved.agent,
      messages: params.resolved.messages,
      tools: params.resolved.tools,
      systemPrompt: params.resolved.systemPrompt,
      cwd: params.hostCtx.cwd,
      abortSignal: params.activeStream.abortController.signal,
      hostCtx: params.hostCtx,
    })

    const streamFailed = yield* Stream.runForEach(
      turnStream.pipe(Stream.interruptWhen(Deferred.await(params.activeStream.interruptDeferred))),
      (event: TurnEvent) =>
        Effect.gen(function* () {
          switch (event._tag) {
            case "text-delta":
              textParts.push(event.text)
              yield* params
                .publishEvent(
                  new EventStreamChunk({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    chunk: event.text,
                  }),
                )
                .pipe(Effect.orDie)
              break
            case "reasoning-delta":
              reasoningParts.push(event.text)
              break
            case "tool-started":
              yield* params
                .publishEvent(
                  new ToolCallStarted({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.of(event.toolCallId),
                    toolName: event.toolName,
                  }),
                )
                .pipe(Effect.orDie)
              break
            case "tool-completed":
              yield* params
                .publishEvent(
                  new ToolCallSucceeded({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.of(event.toolCallId),
                    toolName: "external",
                  }),
                )
                .pipe(Effect.orDie)
              break
            case "tool-failed":
              yield* params
                .publishEvent(
                  new ToolCallFailed({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.of(event.toolCallId),
                    toolName: "external",
                    output: event.error,
                  }),
                )
                .pipe(Effect.orDie)
              break
            case "finished":
              usage = event.usage
                ? {
                    inputTokens: event.usage.inputTokens ?? 0,
                    outputTokens: event.usage.outputTokens ?? 0,
                  }
                : undefined
              break
          }
        }),
    ).pipe(
      Effect.as(false),
      Effect.catchEager((err) =>
        Effect.gen(function* () {
          const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
          if (interrupted) return false
          yield* Effect.logWarning("external-turn stream error, persisting partial output").pipe(
            Effect.annotateLogs({ error: String(err) }),
          )
          yield* persistAssistantTextLocal(textParts.join(""), reasoningParts.join(""))
          yield* params
            .publishEvent(
              new StreamEnded({ sessionId: params.sessionId, branchId: params.branchId }),
            )
            .pipe(Effect.orDie)
          yield* params
            .publishEvent(
              new ErrorOccurred({
                sessionId: params.sessionId,
                branchId: params.branchId,
                error: `External turn executor error: ${String(err)}`,
              }),
            )
            .pipe(Effect.orDie)
          return true
        }),
      ),
    )

    const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
    const draft: AssistantDraft = {
      text: textParts.join(""),
      reasoning: reasoningParts.join(""),
      toolCalls: [], // External tool events are observability only
      usage,
    }

    if (interrupted) {
      yield* params
        .publishEvent(
          new StreamEnded({
            sessionId: params.sessionId,
            branchId: params.branchId,
            interrupted: true,
          }),
        )
        .pipe(Effect.orDie)
      yield* persistAssistantTextLocal(draft.text, draft.reasoning)
      return { draft, interrupted: true, streamFailed: false }
    }

    if (streamFailed) return { draft, interrupted: false, streamFailed: true }

    yield* params
      .publishEvent(
        new StreamEnded({
          sessionId: params.sessionId,
          branchId: params.branchId,
          ...(draft.usage !== undefined ? { usage: draft.usage } : {}),
        }),
      )
      .pipe(Effect.orDie)

    if (params.turnMetrics !== undefined) {
      yield* Ref.update(params.turnMetrics, (m) => ({
        ...m,
        agent: params.resolved.currentTurnAgent,
        inputTokens: m.inputTokens + (draft.usage?.inputTokens ?? 0),
        outputTokens: m.outputTokens + (draft.usage?.outputTokens ?? 0),
        toolCallCount: m.toolCallCount,
      }))
    }

    yield* persistAssistantTurn({
      storage: params.storage,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: assistantMessageIdForTurn(params.messageId, params.step),
      draft,
      agentName: params.resolved.currentTurnAgent,
      extensionRegistry: params.extensionRegistry,
      hostCtx: params.hostCtx,
    })

    return { draft, interrupted: false, streamFailed: false }
  })

export const streamTurnPhase = (params: {
  messageId: MessageId
  step: number
  resolved: ResolvedTurn
  provider: ProviderService
  extensionRegistry: ExtensionRegistryService
  hostCtx: ExtensionHostContext
  publishEvent: PublishEvent
  storage: StorageService
  turnMetrics?: Ref.Ref<TurnMetrics>
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
}) =>
  Effect.gen(function* () {
    const persistAssistantTextLocal = (text: string, reasoning: string, createdAt?: Date) =>
      persistAssistantText({
        storage: params.storage,
        publishEvent: params.publishEvent,
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: assistantMessageIdForTurn(params.messageId, params.step),
        text,
        reasoning,
        createdAt,
      })

    const tools = params.resolved.tools ?? []

    yield* params
      .publishEvent(new StreamStarted({ sessionId: params.sessionId, branchId: params.branchId }))
      .pipe(Effect.orDie)
    yield* Effect.logInfo("stream.start").pipe(
      Effect.annotateLogs({
        agent: params.resolved.currentTurnAgent,
        model: params.resolved.modelId,
      }),
    )

    const collected = yield* Effect.gen(function* () {
      const streamEffect = yield* withRetry(
        params.provider.stream({
          model: params.resolved.modelId,
          messages: [...params.resolved.messages],
          tools: [...tools],
          systemPrompt: params.resolved.systemPrompt,
          abortSignal: params.activeStream.abortController.signal,
          ...(params.resolved.temperature !== undefined
            ? { temperature: params.resolved.temperature }
            : {}),
          ...(params.resolved.reasoning !== undefined
            ? { reasoning: params.resolved.reasoning }
            : {}),
        }),
        undefined,
        {
          onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
            params
              .publishEvent(
                new ProviderRetrying({
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  attempt,
                  maxAttempts,
                  delayMs,
                  error: error.message,
                }),
              )
              .pipe(Effect.orDie),
        },
      )

      const result = yield* collectStreamResponse({
        streamEffect,
        publishEvent: params.publishEvent,
        sessionId: params.sessionId,
        branchId: params.branchId,
        activeStream: params.activeStream,
        persistAssistantText: persistAssistantTextLocal,
      })

      yield* WideEvent.set({
        inputTokens: result.draft.usage?.inputTokens ?? 0,
        outputTokens: result.draft.usage?.outputTokens ?? 0,
        toolCallCount: result.draft.toolCalls.length,
        interrupted: result.interrupted,
        streamFailed: result.streamFailed,
      })

      return result
    }).pipe(withWideEvent(providerStreamBoundary(params.resolved.modelId)))

    if (collected.interrupted) {
      yield* params
        .publishEvent(
          new StreamEnded({
            sessionId: params.sessionId,
            branchId: params.branchId,
            interrupted: true,
          }),
        )
        .pipe(Effect.orDie)
      yield* persistAssistantTextLocal(collected.draft.text, collected.draft.reasoning)
      return collected
    }

    if (collected.streamFailed) return collected

    yield* params
      .publishEvent(
        new StreamEnded({
          sessionId: params.sessionId,
          branchId: params.branchId,
          ...(collected.draft.usage !== undefined ? { usage: collected.draft.usage } : {}),
        }),
      )
      .pipe(Effect.orDie)
    yield* Effect.logInfo("stream.end").pipe(
      Effect.annotateLogs({
        inputTokens: collected.draft.usage?.inputTokens ?? 0,
        outputTokens: collected.draft.usage?.outputTokens ?? 0,
        toolCallCount: collected.draft.toolCalls.length,
      }),
    )

    if (params.turnMetrics !== undefined) {
      yield* Ref.update(params.turnMetrics, (m) => ({
        ...m,
        agent: params.resolved.currentTurnAgent,
        model: params.resolved.modelId,
        inputTokens: m.inputTokens + (collected.draft.usage?.inputTokens ?? 0),
        outputTokens: m.outputTokens + (collected.draft.usage?.outputTokens ?? 0),
        toolCallCount: m.toolCallCount + collected.draft.toolCalls.length,
      }))
    }

    yield* persistAssistantTurn({
      storage: params.storage,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: assistantMessageIdForTurn(params.messageId, params.step),
      draft: collected.draft,
      agentName: params.resolved.currentTurnAgent,
      extensionRegistry: params.extensionRegistry,
      hostCtx: params.hostCtx,
    })

    return collected
  })

export const executeToolsPhase = (params: {
  messageId: MessageId
  step: number
  draft: AssistantDraft
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  extensionStateRuntime?: ExtensionStateRuntimeService
  bashSemaphore: Semaphore.Semaphore
  storage: StorageService
}) =>
  Effect.gen(function* () {
    if (params.draft.toolCalls.length === 0) return

    const toolResultMessageId = toolResultMessageIdForTurn(params.messageId, params.step)
    const existing = yield* params.storage.getMessage(toolResultMessageId)
    if (existing !== undefined) return

    const toolResults = yield* executeToolCalls(params)
    const toolResultMessage = new Message({
      id: toolResultMessageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "tool",
      parts: toolResults,
      createdAt: yield* DateTime.nowAsDate,
    })
    yield* params.storage.createMessageIfAbsent(toolResultMessage)
    yield* params
      .publishEvent(
        new MessageReceived({
          sessionId: params.sessionId,
          branchId: params.branchId,
          messageId: toolResultMessage.id,
          role: "tool",
        }),
      )
      .pipe(Effect.orDie)
  })

export const invokeToolPhase = (params: {
  assistantMessageId: MessageId
  toolResultMessageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  input: unknown
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  hostCtx: ExtensionHostContext
  bashSemaphore: Semaphore.Semaphore
  storage: StorageService
}) =>
  Effect.gen(function* () {
    const draft: AssistantDraft = {
      text: "",
      reasoning: "",
      toolCalls: [
        new ToolCallPart({
          type: "tool-call",
          toolCallId: params.toolCallId,
          toolName: params.toolName,
          input: params.input,
        }),
      ],
    }

    yield* persistAssistantTurn({
      storage: params.storage,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.assistantMessageId,
      draft,
      agentName: params.currentTurnAgent,
      extensionRegistry: params.extensionRegistry,
      hostCtx: params.hostCtx,
    })

    const existing = yield* params.storage.getMessage(params.toolResultMessageId)
    if (existing !== undefined) return

    const toolResults = yield* executeToolCalls({
      draft,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      currentTurnAgent: params.currentTurnAgent,
      toolRunner: params.toolRunner,
      extensionRegistry: params.extensionRegistry,
      bashSemaphore: params.bashSemaphore,
    })

    yield* params.storage.createMessageIfAbsent(
      new Message({
        id: params.toolResultMessageId,
        sessionId: params.sessionId,
        branchId: params.branchId,
        role: "tool",
        parts: toolResults,
        createdAt: yield* DateTime.nowAsDate,
      }),
    )
    yield* params
      .publishEvent(
        new MessageReceived({
          sessionId: params.sessionId,
          branchId: params.branchId,
          messageId: params.toolResultMessageId,
          role: "tool",
        }),
      )
      .pipe(Effect.orDie)
  })

export const finalizeTurnPhase = (params: {
  storage: StorageService
  publishEvent: PublishEvent
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
    if (existingMessage?.turnDurationMs !== undefined) return

    const turnEndTime = yield* DateTime.now
    const turnDurationMs = DateTime.toEpochMillis(turnEndTime) - params.startedAtMs

    yield* params.storage.updateMessageTurnDuration(params.messageId, turnDurationMs)
    yield* params
      .publishEvent(
        new TurnCompleted({
          sessionId: params.sessionId,
          branchId: params.branchId,
          durationMs: Number(turnDurationMs),
          ...(params.turnInterrupted ? { interrupted: true } : {}),
        }),
      )
      .pipe(Effect.orDie)

    // Run turn.after interceptor — extensions can schedule follow-ups, count turns, etc.
    yield* Effect.logDebug("finalize.turn-after.start")
    yield* params.extensionRegistry.hooks
      .runInterceptor(
        "turn.after",
        {
          sessionId: params.sessionId,
          branchId: params.branchId,
          durationMs: Number(turnDurationMs),
          agentName: params.currentAgent,
          interrupted: params.turnInterrupted,
        },
        () => Effect.void,
        params.hostCtx,
      )
      .pipe(Effect.catchEager(() => Effect.void))
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

// Agent Loop Error

export class AgentLoopError extends Schema.TaggedErrorClass<AgentLoopError>()("AgentLoopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// Steer Command

const SteerTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

export const SteerCommand = Schema.Union([
  Schema.TaggedStruct("Cancel", SteerTargetFields),
  Schema.TaggedStruct("Interrupt", SteerTargetFields),
  Schema.TaggedStruct("Interject", {
    ...SteerTargetFields,
    message: Schema.String,
    agent: Schema.optional(AgentName),
  }),
  Schema.TaggedStruct("SwitchAgent", { ...SteerTargetFields, agent: AgentName }),
])
export type SteerCommand = typeof SteerCommand.Type

// Agent Loop Context

const resolveStoredAgent = (params: {
  storage: StorageService
  sessionId: SessionId
  branchId: BranchId
}): Effect.Effect<AgentNameType, never> =>
  Effect.gen(function* () {
    const latestAgentEvent = yield* params.storage
      .getLatestEvent({
        sessionId: params.sessionId,
        branchId: params.branchId,
        tags: ["AgentSwitched"],
      })
      .pipe(Effect.catchEager(() => Effect.void))

    const raw =
      latestAgentEvent !== undefined && latestAgentEvent._tag === "AgentSwitched"
        ? latestAgentEvent.toAgent
        : undefined

    return Schema.is(AgentName)(raw) ? raw : DEFAULT_AGENT_NAME
  })

const hasAgentOverrides = (overrides: AgentExecutionOverrides | undefined) =>
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
  overrides: AgentExecutionOverrides | undefined,
): AgentDefinition => {
  if (!hasAgentOverrides(overrides)) {
    return agent
  }

  const systemPromptAddendum = mergeSystemPromptAddendum(
    agent.systemPromptAddendum,
    overrides?.systemPromptAddendum,
  )

  return new AgentDefinition({
    ...agent,
    ...(overrides?.allowedTools !== undefined ? { allowedTools: overrides.allowedTools } : {}),
    ...(overrides?.deniedTools !== undefined ? { deniedTools: overrides.deniedTools } : {}),
    ...(overrides?.reasoningEffort !== undefined
      ? { reasoningEffort: overrides.reasoningEffort }
      : {}),
    ...(systemPromptAddendum !== agent.systemPromptAddendum ? { systemPromptAddendum } : {}),
  })
}

type SemaphoreType = Semaphore.Semaphore

type LoopHandle = {
  actor: LoopActor
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  pendingQueueRef: Ref.Ref<LoopState["queue"]>
  bashSemaphore: SemaphoreType
  scope: Scope.Closeable
}

const mergePendingQueue = (
  queue: LoopState["queue"],
  pending: LoopState["queue"],
): LoopState["queue"] => {
  let merged = queue
  for (const item of pending.steering) {
    merged = appendSteeringItem(merged, item)
  }
  for (const item of pending.followUp) {
    merged = appendFollowUpQueueState(merged, item)
  }
  return merged
}

const queueWithPending = (
  pendingQueueRef: Ref.Ref<LoopState["queue"]>,
  queue: LoopState["queue"],
) => Ref.get(pendingQueueRef).pipe(Effect.map((pending) => mergePendingQueue(queue, pending)))

const consumeQueueWithPending = (
  pendingQueueRef: Ref.Ref<LoopState["queue"]>,
  queue: LoopState["queue"],
) =>
  Effect.gen(function* () {
    const pending = yield* Ref.get(pendingQueueRef)
    yield* Ref.set(pendingQueueRef, emptyLoopQueueState())
    return mergePendingQueue(queue, pending)
  })

const interruptActiveStream = (activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>) =>
  Effect.gen(function* () {
    const activeStream = yield* Ref.get(activeStreamRef)
    if (activeStream === undefined) return
    yield* Ref.set(activeStream.interruptedRef, true)
    yield* Deferred.succeed(activeStream.interruptDeferred, undefined).pipe(Effect.ignore)
    activeStream.abortController.abort()
  })

const publishPhaseFailure = (params: {
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  sessionId: SessionId
  branchId: BranchId
  cause: Cause.Cause<unknown>
}) =>
  params
    .publishEvent(
      new ErrorOccurred({
        sessionId: params.sessionId,
        branchId: params.branchId,
        error: Cause.pretty(params.cause),
      }),
    )
    .pipe(
      Effect.catchEager((error) =>
        Effect.logWarning("failed to publish ErrorOccurred").pipe(
          Effect.annotateLogs({ error: String(error) }),
        ),
      ),
      Effect.asVoid,
    )

const makePublishingInspector = (params: {
  publishEvent: (event: AgentEvent) => Effect.Effect<void, never>
  sessionId: SessionId
  branchId: BranchId
}) =>
  combineInspectors(
    tracingInspector<{ readonly _tag: string }, { readonly _tag: string }>({
      attributes: () => ({
        sessionId: params.sessionId,
        branchId: params.branchId,
      }),
    }),
    makeInspectorEffect<{ readonly _tag: string }, { readonly _tag: string }>(
      (event: AnyInspectionEvent) =>
        params
          .publishEvent(
            new MachineInspected({
              sessionId: params.sessionId,
              branchId: params.branchId,
              actorId: event.actorId,
              inspectionType: event.type,
              payload: event,
            }),
          )
          .pipe(
            Effect.withSpan("Machine.inspect.publish"),
            Effect.catchEager((error) =>
              Effect.logWarning("failed to publish MachineInspected").pipe(
                Effect.annotateLogs({ error: String(error) }),
              ),
            ),
          ),
    ),
  )

type LoopRecoveryDecision = {
  state: LoopState
  recovery?: {
    phase: "Idle" | "Running" | "WaitingForInteraction"
    action: "resume-queued-turn" | "replay-running" | "restore-cold"
    detail?: string
  }
}

/** Recovery decision for persist.onRestore — takes decoded state, returns adjusted state or None. */
const makeRecoveryDecision = (params: {
  state: LoopState
  storage: StorageService
  extensionRegistry: ExtensionRegistryService
  currentAgent: AgentNameType
  publishEvent: (event: AgentEvent) => Effect.Effect<void, never>
  sessionId: SessionId
  branchId: BranchId
}): Effect.Effect<Option.Option<LoopState>, StorageError> =>
  Effect.gen(function* () {
    const state = params.state

    const publishRecovery = (recovery: LoopRecoveryDecision["recovery"]) =>
      recovery === undefined
        ? Effect.void
        : params
            .publishEvent(
              new TurnRecoveryApplied({
                sessionId: params.sessionId,
                branchId: params.branchId,
                phase: recovery.phase,
                action: recovery.action,
                ...(recovery.detail !== undefined ? { detail: recovery.detail } : {}),
              }),
            )
            .pipe(Effect.catchEager(() => Effect.void))

    if (state._tag === "Idle") {
      const { queue, nextItem } = takeNextQueuedTurn(state.queue)
      if (nextItem !== undefined) {
        yield* publishRecovery({ phase: "Idle", action: "resume-queued-turn" })
        return Option.some(
          buildRunningState(
            { queue, currentAgent: state.currentAgent ?? params.currentAgent },
            nextItem,
          ),
        )
      }
      return Option.some(
        state.currentAgent === undefined
          ? updateCurrentAgentOnState(state, params.currentAgent)
          : state,
      )
    }

    if (state._tag === "Running") {
      // The Running task will re-derive loop position from storage
      // (assistant message? tool results? → resume from correct point)
      yield* publishRecovery({ phase: "Running", action: "replay-running" })
      return Option.some(state)
    }

    if (state._tag === "WaitingForInteraction") {
      // Cold state — restore directly. Interaction re-publish happens via
      // InteractionStorage.listPending() in the server startup path.
      yield* publishRecovery({ phase: "WaitingForInteraction", action: "restore-cold" })
      return Option.some(state)
    }

    return Option.none()
  })

// Agent Loop Service

export interface AgentLoopService {
  readonly runOnce: (input: {
    sessionId: SessionId
    branchId: BranchId
    agentName: AgentNameType
    prompt: string
    interactive?: boolean
    overrides?: AgentExecutionOverrides
  }) => Effect.Effect<void, AgentRunError>
  readonly submit: (
    message: Message,
    options?: {
      agentOverride?: AgentNameType
      executionOverrides?: AgentExecutionOverrides
      interactive?: boolean
    },
  ) => Effect.Effect<void, AgentLoopError>
  readonly run: (
    message: Message,
    options?: {
      agentOverride?: AgentNameType
      executionOverrides?: AgentExecutionOverrides
      interactive?: boolean
    },
  ) => Effect.Effect<void, AgentLoopError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void>
  readonly followUp: (message: Message) => Effect.Effect<void, AgentLoopError>
  readonly drainQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot>
  readonly getQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot>
  readonly isRunning: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<boolean>
  readonly respondInteraction: (input: {
    sessionId: SessionId
    branchId: BranchId
    requestId: string
  }) => Effect.Effect<void>
  readonly getActor: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<LoopActor>
  readonly getState: (input: { sessionId: SessionId; branchId: BranchId }) => Effect.Effect<{
    phase: LoopRuntimePhase
    status: LoopRuntimeStatus
    agent: AgentNameType
    queue: QueueSnapshot
  }>
  readonly toRuntimeState: (state: LoopState) => LoopRuntimeState
}

export class AgentLoop extends Context.Service<AgentLoop, AgentLoopService>()(
  "@gent/core/src/runtime/agent/agent-loop/AgentLoop",
) {
  static Live = (config: {
    baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<
    AgentLoop,
    never,
    | Storage
    | CheckpointStorage
    | Provider
    | ExtensionRegistry
    | ExtensionStateRuntime
    | ExtensionTurnControl
    | EventPublisher
    | ToolRunner
  > =>
    Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const storage = yield* Storage
        const checkpointStorage = yield* CheckpointStorage
        const provider = yield* Provider
        const extensionRegistry = yield* ExtensionRegistry
        const extensionStateRuntime = yield* ExtensionStateRuntime
        const extensionTurnControl = yield* ExtensionTurnControl
        const eventPublisher = yield* EventPublisher
        const toolRunner = yield* ToolRunner
        const loopsRef = yield* Ref.make<Map<string, LoopHandle>>(new Map())
        const pendingQueuesRef = yield* Ref.make<Map<string, LoopState["queue"]>>(new Map())
        const loopsSemaphore = yield* Semaphore.make(1)

        const stateKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`
        const getPendingQueue = (sessionId: SessionId, branchId: BranchId) =>
          Ref.get(pendingQueuesRef).pipe(
            Effect.map(
              (queues) => queues.get(stateKey(sessionId, branchId)) ?? emptyLoopQueueState(),
            ),
          )
        const setPendingQueue = (
          sessionId: SessionId,
          branchId: BranchId,
          queue: LoopState["queue"],
        ) =>
          Ref.update(pendingQueuesRef, (queues) => {
            const next = new Map(queues)
            const key = stateKey(sessionId, branchId)
            if (queue.steering.length === 0 && queue.followUp.length === 0) {
              next.delete(key)
            } else {
              next.set(key, queue)
            }
            return next
          })

        const makeLoop = (
          sessionId: SessionId,
          branchId: BranchId,
          initialQueue: LoopState["queue"],
        ) =>
          Effect.gen(function* () {
            const publishEvent = (event: AgentEvent) =>
              eventPublisher.publish(event).pipe(
                Effect.mapError(
                  (error) =>
                    new AgentLoopError({
                      message: `Failed to publish ${event._tag}`,
                      cause: error,
                    }),
                ),
              )
            const publishEventOrDie = (event: AgentEvent) => publishEvent(event).pipe(Effect.orDie)

            // Resolve services lazily — by the time makeLoop runs, all services
            // exist in the ambient scope (including AgentRunnerService, which
            // depends on AgentLoop and would create a circular Layer dep)
            const fallback = unavailableHostDeps("agent-loop")
            const lazyDeps = yield* Effect.all({
              platform: Effect.serviceOption(RuntimePlatform),
              approvalService: Effect.serviceOption(ApprovalService),
              promptPresenter: Effect.serviceOption(PromptPresenter),
              searchStorage: Effect.serviceOption(SearchStorage),
              agentRunner: Effect.serviceOption(AgentRunnerService),
              sessionProfileCache: Effect.serviceOption(SessionProfileCache),
            })

            const hostDeps: MakeExtensionHostContextDeps = {
              platform:
                lazyDeps.platform._tag === "Some" ? lazyDeps.platform.value : fallback.platform,
              extensionStateRuntime,
              approvalService:
                lazyDeps.approvalService._tag === "Some"
                  ? lazyDeps.approvalService.value
                  : fallback.approvalService,
              promptPresenter:
                lazyDeps.promptPresenter._tag === "Some"
                  ? lazyDeps.promptPresenter.value
                  : fallback.promptPresenter,
              extensionRegistry,
              turnControl: extensionTurnControl,
              storage,
              searchStorage:
                lazyDeps.searchStorage._tag === "Some"
                  ? lazyDeps.searchStorage.value
                  : fallback.searchStorage,
              agentRunner:
                lazyDeps.agentRunner._tag === "Some"
                  ? lazyDeps.agentRunner.value
                  : fallback.agentRunner,
              eventPublisher,
            }

            const defaultHostCtx = makeExtensionHostContext({ sessionId, branchId }, hostDeps)

            const profileCache =
              lazyDeps.sessionProfileCache._tag === "Some"
                ? lazyDeps.sessionProfileCache.value
                : undefined

            /** Resolve per-turn context: session cwd → profile → registry + baseSections + hostCtx.
             *  Falls back to server-wide defaults when no profile cache or no session cwd. */
            const resolveTurnProfile = Effect.gen(function* () {
              const session = yield* storage
                .getSession(sessionId)
                .pipe(Effect.orElseSucceed(() => undefined))
              const sessionCwd = session?.cwd

              if (profileCache !== undefined && sessionCwd !== undefined) {
                const profile = yield* profileCache.resolve(sessionCwd)
                const turnHostCtx = makeExtensionHostContext(
                  { sessionId, branchId, sessionCwd },
                  {
                    ...hostDeps,
                    extensionRegistry: profile.registryService,
                    extensionStateRuntime: profile.extensionStateRuntime,
                  },
                )
                return {
                  turnExtensionRegistry: profile.registryService,
                  turnExtensionStateRuntime: profile.extensionStateRuntime,
                  turnBaseSections: profile.baseSections,
                  turnHostCtx,
                }
              }

              return {
                turnExtensionRegistry: extensionRegistry as ExtensionRegistryService,
                turnExtensionStateRuntime: extensionStateRuntime as ExtensionStateRuntimeService,
                turnBaseSections: config.baseSections,
                turnHostCtx: defaultHostCtx,
              }
            })

            const loopScope = yield* Scope.make()
            const bashSemaphore = yield* Semaphore.make(1)
            const activeStreamRef = yield* Ref.make<ActiveStreamHandle | undefined>(undefined)
            const pendingQueueRef = yield* Ref.make(emptyLoopQueueState())
            const turnToolsRef = yield* Ref.make<ReadonlyArray<AnyToolDefinition>>([])
            const turnMetricsRef = yield* Ref.make(emptyTurnMetrics())
            const interruptedRef = yield* Ref.make(false)
            const currentAgent = yield* resolveStoredAgent({ storage, sessionId, branchId })
            const inspector = makePublishingInspector({
              publishEvent: publishEventOrDie,
              sessionId,
              branchId,
            })

            const switchAgentOnState = <S extends LoopState>(
              state: S,
              next: AgentNameType,
            ): Effect.Effect<S> =>
              Effect.gen(function* () {
                const previous = state.currentAgent ?? DEFAULT_AGENT_NAME
                if (previous === next) return state
                // Use per-session profile registry when available
                const { turnExtensionRegistry: switchRegistry } = yield* resolveTurnProfile
                const resolved = yield* switchRegistry.getAgent(next)
                if (resolved === undefined) return state

                yield* publishEvent(
                  new AgentSwitched({
                    sessionId,
                    branchId,
                    fromAgent: previous,
                    toAgent: next,
                  }),
                ).pipe(
                  Effect.catchEager((error) =>
                    Effect.logWarning("failed to publish AgentSwitched").pipe(
                      Effect.annotateLogs({ error: String(error) }),
                    ),
                  ),
                )

                return updateCurrentAgentOnState(state, next)
              }).pipe(Effect.orDie) as Effect.Effect<S>

            // ── The inner agentic loop ──
            // resolve → stream → tools → repeat until LLM returns no tool calls
            const runTurn = Effect.fn("AgentLoop.runTurn")(function* (state: RunningState) {
              yield* Ref.set(turnMetricsRef, emptyTurnMetrics())

              // Resolve per-turn profile (session cwd → extension registry + baseSections)
              const {
                turnExtensionRegistry,
                turnExtensionStateRuntime,
                turnBaseSections,
                turnHostCtx,
              } = yield* resolveTurnProfile

              let step = 0
              let interrupted = yield* Ref.get(interruptedRef)
              let streamFailed = false
              let currentTurnAgent: AgentNameType = state.currentAgent ?? DEFAULT_AGENT_NAME

              // Resume check: if assistant message with tool calls exists but no tool results,
              // we're resuming from WaitingForInteraction or crash. Execute tools first.
              // Resume always targets step 1 — interactions/crashes happen during the first tool execution.
              const resumeStep = 1
              const existingAssistant = yield* storage
                .getMessage(assistantMessageIdForTurn(state.message.id, resumeStep))
                .pipe(Effect.orElseSucceed(() => undefined))
              if (existingAssistant !== undefined && !interrupted) {
                const draft = assistantDraftFromMessage(existingAssistant)
                if (draft.toolCalls.length > 0) {
                  const existingResults = yield* storage
                    .getMessage(toolResultMessageIdForTurn(state.message.id, resumeStep))
                    .pipe(Effect.orElseSucceed(() => undefined))
                  if (existingResults === undefined) {
                    // Resume tool execution (interaction response or crash recovery)
                    yield* Effect.logInfo("turn.resume-tools")
                    const interactionSignal = yield* executeToolsPhase({
                      messageId: state.message.id,
                      step: resumeStep,
                      draft,
                      publishEvent: publishEventOrDie,
                      sessionId,
                      branchId,
                      currentTurnAgent,
                      toolRunner,
                      extensionRegistry: turnExtensionRegistry,
                      extensionStateRuntime: turnExtensionStateRuntime,
                      bashSemaphore,
                      storage,
                    }).pipe(
                      Effect.as(undefined as ToolInteractionPending | undefined),
                      Effect.catchIf(
                        (e): e is ToolInteractionPending => e instanceof ToolInteractionPending,
                        (e) => Effect.succeed(e),
                      ),
                    )

                    if (interactionSignal !== undefined) {
                      const { pending, toolCallId } = interactionSignal
                      return AgentLoopEvent.InteractionRequested({
                        completedToolResults: [],
                        pendingRequestId: pending.requestId,
                        pendingToolCallId: toolCallId as string,

                        currentTurnAgent,
                        draft,
                      })
                    }
                    // Tools done — fall through to the loop which will resolve/stream the next step
                    step = 1
                  }
                  // If tool results already exist, the loop will re-resolve (picks them up from storage)
                }
              }

              while (true) {
                step++
                if (step > DEFAULTS.maxTurnSteps) {
                  yield* Effect.logWarning("turn.max-steps-exceeded").pipe(
                    Effect.annotateLogs({ step, max: DEFAULTS.maxTurnSteps }),
                  )
                  break
                }

                if (yield* Ref.get(interruptedRef)) {
                  interrupted = true
                  break
                }

                // 1. Resolve
                const resolved = yield* resolveTurnPhase({
                  message: state.message,
                  agentOverride: state.agentOverride,
                  executionOverrides: state.executionOverrides,
                  currentAgent: state.currentAgent,
                  storage,
                  branchId,
                  extensionRegistry: turnExtensionRegistry,
                  extensionStateRuntime: turnExtensionStateRuntime,
                  sessionId,
                  publishEvent: publishEventOrDie,
                  baseSections: turnBaseSections,
                  interactive: state.interactive,
                  hostCtx: turnHostCtx,
                })
                if (resolved === undefined) break

                yield* Ref.set(turnToolsRef, resolved.tools)
                currentTurnAgent = resolved.currentTurnAgent
                if (step === 1) {
                  yield* Ref.update(turnMetricsRef, (m) => ({
                    ...m,
                    agent: resolved.currentTurnAgent,
                    model: resolved.modelId,
                  }))
                }

                if (yield* Ref.get(interruptedRef)) {
                  interrupted = true
                  break
                }

                // 1b. Pre-turn hook
                yield* runTurnBeforeHook(
                  turnExtensionRegistry,
                  resolved,
                  sessionId,
                  branchId,
                  turnHostCtx,
                )

                // 2. Stream (or external turn)
                const activeStream: ActiveStreamHandle = {
                  abortController: new AbortController(),
                  interruptDeferred: yield* Deferred.make<void>(),
                  interruptedRef: yield* Ref.make(false),
                }
                yield* Ref.set(activeStreamRef, activeStream)

                // Dispatch: external executor or model-backed stream
                const externalResult = yield* dispatchExternalTurn({
                  resolved,
                  extensionRegistry: turnExtensionRegistry,
                  publishEvent: publishEventOrDie,
                  sessionId,
                  branchId,
                  messageId: state.message.id,
                  step,
                  activeStream,
                  activeStreamRef,
                  turnToolsRef,
                  storage,
                  hostCtx: turnHostCtx,
                  turnMetrics: turnMetricsRef,
                })
                if (externalResult !== undefined) {
                  interrupted = externalResult.interrupted
                  streamFailed = externalResult.streamFailed
                  break
                }

                const collected = yield* streamTurnPhase({
                  messageId: state.message.id,
                  step,
                  resolved: {
                    currentTurnAgent: resolved.currentTurnAgent,
                    messages: resolved.messages,
                    systemPrompt: resolved.systemPrompt,
                    modelId: resolved.modelId,
                    tools: yield* Ref.get(turnToolsRef),
                    ...(resolved.reasoning !== undefined ? { reasoning: resolved.reasoning } : {}),
                    ...(resolved.temperature !== undefined
                      ? { temperature: resolved.temperature }
                      : {}),
                  },
                  provider,
                  extensionRegistry: turnExtensionRegistry,
                  hostCtx: turnHostCtx,
                  publishEvent: publishEventOrDie,
                  storage,
                  sessionId,
                  branchId,
                  activeStream,
                  turnMetrics: turnMetricsRef,
                }).pipe(Effect.ensuring(Ref.set(activeStreamRef, undefined)))

                if (collected.interrupted) {
                  interrupted = true
                  break
                }
                if (collected.streamFailed) {
                  streamFailed = true
                  break
                }

                // No tool calls → LLM is done
                if (collected.draft.toolCalls.length === 0) break

                // 3. Execute tools
                const interactionSignal = yield* executeToolsPhase({
                  messageId: state.message.id,
                  step,
                  draft: collected.draft,
                  publishEvent: publishEventOrDie,
                  sessionId,
                  branchId,
                  currentTurnAgent: resolved.currentTurnAgent,
                  toolRunner,
                  extensionRegistry: turnExtensionRegistry,
                  extensionStateRuntime: turnExtensionStateRuntime,
                  bashSemaphore,
                  storage,
                }).pipe(
                  Effect.as(undefined as ToolInteractionPending | undefined),
                  Effect.catchIf(
                    (e): e is ToolInteractionPending => e instanceof ToolInteractionPending,
                    (e) => Effect.succeed(e),
                  ),
                )

                if (interactionSignal !== undefined) {
                  const { pending, toolCallId } = interactionSignal
                  return AgentLoopEvent.InteractionRequested({
                    completedToolResults: [],
                    pendingRequestId: pending.requestId,
                    pendingToolCallId: toolCallId as string,
                    currentTurnAgent: resolved.currentTurnAgent,
                    draft: collected.draft,
                  })
                }

                // Loop — tool results persisted, next resolve picks them up
              }

              // Finalize — TurnCompleted fires once per turn
              yield* finalizeTurnPhase({
                storage,
                publishEvent: publishEventOrDie,
                sessionId,
                branchId,
                startedAtMs: state.startedAtMs,
                messageId: state.message.id,
                turnInterrupted: interrupted,
                streamFailed,
                currentAgent: currentTurnAgent,
                extensionRegistry: turnExtensionRegistry,
                turnMetrics: turnMetricsRef,
                hostCtx: turnHostCtx,
              })

              return AgentLoopEvent.TurnDone
            })

            const loopMachine = Machine.make({
              state: AgentLoopState,
              event: AgentLoopEvent,
              initial: buildIdleState({ currentAgent, queue: initialQueue }),
            })
              // Idle → Running
              .on(AgentLoopState.Idle, AgentLoopEvent.Start, ({ state, event }) =>
                buildRunningState(state, event.item),
              )
              // Queue/steer/switch accepted in all states
              .on(AgentLoopState.Idle, AgentLoopEvent.QueueFollowUp, ({ state, event }) => {
                const queued = appendFollowUpQueueState(state.queue, event.item)
                if (event.resumeIfIdle) {
                  const { queue, nextItem } = takeNextQueuedTurn(queued)
                  if (nextItem !== undefined) {
                    return buildRunningState({ queue, currentAgent: state.currentAgent }, nextItem)
                  }
                }
                return updateQueueOnState(state, queued)
              })
              .on(
                [AgentLoopState.Running, AgentLoopState.WaitingForInteraction],
                AgentLoopEvent.QueueFollowUp,
                ({ state, event }) =>
                  updateQueueOnState(state, appendFollowUpQueueState(state.queue, event.item)),
              )
              .on(
                [AgentLoopState.Idle, AgentLoopState.Running, AgentLoopState.WaitingForInteraction],
                AgentLoopEvent.ClearQueue,
                ({ state }) => updateQueueOnState(state, clearQueueState(state.queue)),
              )
              .on(
                [AgentLoopState.Idle, AgentLoopState.Running, AgentLoopState.WaitingForInteraction],
                AgentLoopEvent.SwitchAgent,
                ({ state, event }) => switchAgentOnState(state, event.agent),
              )
              .on(AgentLoopState.Idle, AgentLoopEvent.QueueSteering, ({ state, event }) =>
                updateQueueOnState(state, appendSteeringItem(state.queue, event.item)),
              )
              .on(AgentLoopState.Idle, AgentLoopEvent.Interrupt, ({ state }) => state)
              // Running — steering and interrupt
              .on(AgentLoopState.Running, AgentLoopEvent.QueueSteering, ({ state, event }) =>
                Effect.gen(function* () {
                  if (event.urgent) {
                    yield* interruptActiveStream(activeStreamRef)
                  }
                  return updateQueueOnState(state, appendSteeringItem(state.queue, event.item))
                }),
              )
              .on(AgentLoopState.Running, AgentLoopEvent.Interrupt, ({ state }) =>
                Effect.gen(function* () {
                  yield* Ref.set(interruptedRef, true)
                  yield* interruptActiveStream(activeStreamRef)
                  return state
                }),
              )
              // Running → Idle (turn done), or re-enter Running (queued follow-up)
              // Use state.queue (live, includes follow-ups queued during turn) not event.queue (stale)
              .reenter(AgentLoopState.Running, AgentLoopEvent.TurnDone, ({ state }) =>
                Effect.gen(function* () {
                  const mergedQueue = yield* consumeQueueWithPending(pendingQueueRef, state.queue)
                  const { queue, nextItem } = takeNextQueuedTurn(mergedQueue)
                  if (nextItem !== undefined) {
                    yield* Ref.set(interruptedRef, false)
                    return buildRunningState({ queue, currentAgent: state.currentAgent }, nextItem)
                  }
                  yield* Ref.set(interruptedRef, false)
                  return buildIdleState({ queue, currentAgent: state.currentAgent })
                }),
              )
              .on(AgentLoopState.Running, AgentLoopEvent.TurnFailed, ({ state }) =>
                Effect.gen(function* () {
                  const mergedQueue = yield* consumeQueueWithPending(pendingQueueRef, state.queue)
                  yield* Ref.set(interruptedRef, false)
                  return buildIdleState({ queue: mergedQueue, currentAgent: state.currentAgent })
                }),
              )
              // Running → WaitingForInteraction
              .on(AgentLoopState.Running, AgentLoopEvent.InteractionRequested, ({ state, event }) =>
                toWaitingForInteractionState({
                  state,
                  currentTurnAgent: event.currentTurnAgent,
                  draft: event.draft,
                  completedToolResults: [...event.completedToolResults],
                  pendingRequestId: event.pendingRequestId,
                  pendingToolCallId: event.pendingToolCallId,
                }),
              )
              // WaitingForInteraction — cold state, no task fiber
              .on(
                AgentLoopState.WaitingForInteraction,
                AgentLoopEvent.QueueSteering,
                ({ state, event }) =>
                  updateQueueOnState(state, appendSteeringItem(state.queue, event.item)),
              )
              .on(AgentLoopState.WaitingForInteraction, AgentLoopEvent.Interrupt, ({ state }) =>
                Effect.gen(function* () {
                  // Transition to Running with interrupt set — task will finalize immediately
                  yield* Ref.set(interruptedRef, true)
                  return AgentLoopState.Running.with(state, {
                    message: state.message,
                    startedAtMs: state.startedAtMs,
                    agentOverride: state.agentOverride,
                    executionOverrides: state.executionOverrides,
                    interactive: state.interactive,
                  })
                }),
              )
              // WaitingForInteraction → Running (resume)
              .on(
                AgentLoopState.WaitingForInteraction,
                AgentLoopEvent.InteractionResponded,
                ({ state }) =>
                  AgentLoopState.Running.with(state, {
                    message: state.message,
                    startedAtMs: state.startedAtMs,
                    agentOverride: state.agentOverride,
                    executionOverrides: state.executionOverrides,
                    interactive: state.interactive,
                  }),
              )
              // Running task — the agentic loop
              .task(
                AgentLoopState.Running,
                ({ state }) =>
                  runTurn(state).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.turn"),
                    Effect.tapCause((cause) =>
                      publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                    ),
                  ),
                { name: "turn", onFailure: () => AgentLoopEvent.TurnFailed },
              )

            const loopActor = yield* Machine.spawn(loopMachine, {
              id: `agent-loop:${sessionId}:${branchId}`,
              lifecycle: {
                recovery: {
                  resolve: (_ctx) =>
                    Effect.withSpan("AgentLoop.recovery.resolve")(
                      Effect.gen(function* () {
                        const record = yield* checkpointStorage.get({ sessionId, branchId })
                        if (record === undefined) return Option.none<LoopState>()
                        if (record.version !== AGENT_LOOP_CHECKPOINT_VERSION) {
                          yield* checkpointStorage.remove({ sessionId, branchId })
                          return Option.none<LoopState>()
                        }
                        const decoded = yield* Effect.option(
                          decodeLoopCheckpointState(record.stateJson),
                        )
                        if (Option.isNone(decoded)) {
                          yield* checkpointStorage.remove({ sessionId, branchId })
                          return Option.none<LoopState>()
                        }
                        return yield* makeRecoveryDecision({
                          state: decoded.value,
                          storage,
                          extensionRegistry,
                          currentAgent,
                          publishEvent: publishEventOrDie,
                          sessionId,
                          branchId,
                        }).pipe(Effect.catchEager(() => Effect.succeed(Option.none<LoopState>())))
                      }).pipe(Effect.catchEager(() => Effect.succeed(Option.none<LoopState>()))),
                    ),
                },
                durability: {
                  save: (commit) =>
                    Effect.withSpan("AgentLoop.durability.save")(
                      Effect.gen(function* () {
                        yield* Effect.logDebug("checkpoint.save.start").pipe(
                          Effect.annotateLogs({ nextState: commit.nextState._tag }),
                        )
                        if (!shouldRetainLoopCheckpoint(commit.nextState)) {
                          yield* checkpointStorage.remove({ sessionId, branchId })
                          yield* Effect.logDebug("checkpoint.save.removed")
                          return
                        }
                        yield* checkpointStorage.upsert(
                          yield* buildLoopCheckpointRecord({
                            sessionId,
                            branchId,
                            state: commit.nextState,
                          }),
                        )
                        yield* Effect.logDebug("checkpoint.save.done").pipe(
                          Effect.annotateLogs({ nextState: commit.nextState._tag }),
                        )
                      }).pipe(
                        Effect.catchEager((error) =>
                          Effect.logWarning("checkpoint.save failed").pipe(
                            Effect.annotateLogs({ error: String(error) }),
                          ),
                        ),
                      ),
                    ),
                },
              },
            }).pipe(
              Effect.provideService(InspectorService, inspector),
              Effect.provideService(ActorScope, loopScope),
            )

            return {
              actor: loopActor,
              activeStreamRef,
              pendingQueueRef,
              bashSemaphore,
              scope: loopScope,
            }
          })

        const getLoop = Effect.fn("AgentLoop.getLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          // Allocate + register under semaphore, then start outside.
          // Machine.spawn returns an unstarted actor — fibers don't run
          // until actor.start. This prevents the self-deadlock where
          // background fibers re-enter getLoop before the handle is
          // installed in loopsRef.
          const created = yield* Effect.withSpan("AgentLoop.getLoop.semaphore")(
            loopsSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const existing = (yield* Ref.get(loopsRef)).get(key)
                if (existing !== undefined) return undefined
                const initialQueue =
                  (yield* Ref.get(pendingQueuesRef)).get(key) ?? emptyLoopQueueState()
                const handle = yield* makeLoop(sessionId, branchId, initialQueue)
                yield* Ref.update(loopsRef, (loops) => {
                  const next = new Map(loops)
                  next.set(key, handle)
                  return next
                })
                yield* setPendingQueue(sessionId, branchId, emptyLoopQueueState())
                return handle
              }),
            ),
          )
          if (created !== undefined) {
            yield* created.actor.start
            return created
          }
          // Handle was installed by another fiber — guaranteed to exist
          // since the semaphore serializes creation for the same key.
          const loops = yield* Ref.get(loopsRef)
          const existing = loops.get(key)
          if (existing === undefined) {
            return yield* Effect.die(new Error(`Loop handle missing for ${key} after creation`))
          }
          return existing
        })

        const findLoop = Effect.fn("AgentLoop.findLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          const loops = yield* Ref.get(loopsRef)
          return loops.get(key)
        })

        const findOrRestoreLoop = Effect.fn("AgentLoop.findOrRestoreLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const existing = yield* findLoop(sessionId, branchId)
          if (existing !== undefined) return existing

          const checkpoint = Option.getOrUndefined(
            yield* Effect.option(checkpointStorage.get({ sessionId, branchId })),
          )
          if (checkpoint === undefined) return undefined

          return yield* getLoop(sessionId, branchId)
        })

        const buildQueuedTurnItem = (
          message: Message,
          options?:
            | {
                agentOverride?: AgentNameType
                executionOverrides?: AgentExecutionOverrides
                interactive?: boolean
              }
            | undefined,
        ): QueuedTurnItem => ({
          message,
          ...(options?.agentOverride !== undefined ? { agentOverride: options.agentOverride } : {}),
          ...(options?.executionOverrides !== undefined
            ? { executionOverrides: options.executionOverrides }
            : {}),
          ...(options?.interactive !== undefined ? { interactive: options.interactive } : {}),
        })

        const service: AgentLoopService = {
          runOnce: Effect.fn("AgentLoop.runOnce")(function* (input) {
            const userMessage = new Message({
              id: MessageId.of(Bun.randomUUIDv7()),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: input.prompt })],
              createdAt: yield* DateTime.nowAsDate,
            })

            yield* storage.createMessage(userMessage).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentRunError({
                    message: `Failed to create user message for ${input.sessionId}`,
                    cause,
                  }),
              ),
            )
            yield* eventPublisher
              .publish(
                new MessageReceived({
                  sessionId: input.sessionId,
                  branchId: input.branchId,
                  messageId: userMessage.id,
                  role: "user",
                }),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentRunError({
                      message: `Failed to publish MessageReceived for ${input.sessionId}`,
                      cause,
                    }),
                ),
              )

            return yield* service
              .run(userMessage, {
                agentOverride: input.agentName,
                ...(input.overrides !== undefined ? { executionOverrides: input.overrides } : {}),
                ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentRunError({
                      message: cause.message,
                      cause,
                    }),
                ),
              )
          }),

          submit: Effect.fn("AgentLoop.submit")(function* (
            message: Message,
            options?: {
              agentOverride?: AgentNameType
              executionOverrides?: AgentExecutionOverrides
              interactive?: boolean
            },
          ) {
            const loop = yield* getLoop(message.sessionId, message.branchId)
            const initialState = yield* loop.actor.snapshot
            const item = buildQueuedTurnItem(message, options)

            if (initialState._tag !== "Idle") {
              yield* loop.actor.call(AgentLoopEvent.QueueFollowUp({ item, resumeIfIdle: true }))
              return
            }

            yield* loop.actor.call(AgentLoopEvent.Start({ item }))
          }),

          run: Effect.fn("AgentLoop.run")(function* (
            message: Message,
            options?: {
              agentOverride?: AgentNameType
              executionOverrides?: AgentExecutionOverrides
              interactive?: boolean
            },
          ) {
            const loop = yield* getLoop(message.sessionId, message.branchId)
            const initialState = yield* loop.actor.snapshot
            const item = buildQueuedTurnItem(message, options)

            if (initialState._tag !== "Idle") {
              yield* loop.actor.call(AgentLoopEvent.QueueFollowUp({ item, resumeIfIdle: true }))
              return
            }

            yield* loop.actor.send(AgentLoopEvent.Start({ item }))
            yield* loop.actor.waitFor((state) => state._tag === "Idle" && state !== initialState)
          }),

          steer: (command) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(command.sessionId, command.branchId)
              const loopState = yield* loop.actor.snapshot

              switch (command._tag) {
                case "SwitchAgent":
                  yield* loop.actor.cast(AgentLoopEvent.SwitchAgent({ agent: command.agent }))
                  return
                case "Cancel":
                case "Interrupt":
                  if (loopState._tag === "Running" || loopState._tag === "WaitingForInteraction") {
                    yield* loop.actor.cast(AgentLoopEvent.Interrupt)
                  }
                  return
                case "Interject": {
                  const interjectMessage = new Message({
                    id: MessageId.of(Bun.randomUUIDv7()),
                    sessionId: command.sessionId,
                    branchId: command.branchId,
                    kind: "interjection",
                    role: "user",
                    parts: [new TextPart({ type: "text", text: command.message })],
                    createdAt: yield* DateTime.nowAsDate,
                  })
                  const item: QueuedTurnItem = {
                    message: interjectMessage,
                    ...(command.agent !== undefined ? { agentOverride: command.agent } : {}),
                  }
                  const urgent = loopState._tag === "Running"
                  yield* loop.actor.call(AgentLoopEvent.QueueSteering({ item, urgent }))
                  return
                }
              }
            }),

          followUp: (message) =>
            Effect.gen(function* () {
              const loop = yield* findLoop(message.sessionId, message.branchId)
              if (loop === undefined) {
                const pendingQueue = yield* getPendingQueue(message.sessionId, message.branchId)
                if (countQueuedFollowUps(pendingQueue) >= DEFAULTS.followUpQueueMax) {
                  return yield* new AgentLoopError({
                    message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                  })
                }
                yield* setPendingQueue(
                  message.sessionId,
                  message.branchId,
                  appendFollowUpQueueState(pendingQueue, { message }),
                )
                return
              }
              const loopState = yield* loop.actor.snapshot
              const effectiveQueue = yield* queueWithPending(loop.pendingQueueRef, loopState.queue)
              if (countQueuedFollowUps(effectiveQueue) >= DEFAULTS.followUpQueueMax) {
                return yield* new AgentLoopError({
                  message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                })
              }
              const event = AgentLoopEvent.QueueFollowUp({
                item: { message },
                resumeIfIdle:
                  loopState._tag === "Running" || loopState._tag === "WaitingForInteraction",
              })
              if (loopState._tag === "Running" || loopState._tag === "WaitingForInteraction") {
                if (loopState._tag === "Running") {
                  yield* Ref.update(loop.pendingQueueRef, (pending) =>
                    appendFollowUpQueueState(pending, event.item),
                  )
                  return
                }
                yield* loop.actor.cast(event)
                return
              }
              yield* loop.actor.call(event)
            }),

          drainQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                const pendingQueue = yield* getPendingQueue(input.sessionId, input.branchId)
                yield* setPendingQueue(input.sessionId, input.branchId, emptyLoopQueueState())
                return queueSnapshotFromState(buildIdleState({ queue: pendingQueue }))
              }

              const loopState = yield* loop.actor.snapshot
              const mergedState = updateQueueOnState(
                loopState,
                yield* consumeQueueWithPending(loop.pendingQueueRef, loopState.queue),
              )
              const snapshot = queueSnapshotFromState(mergedState)
              yield* loop.actor.call(AgentLoopEvent.ClearQueue)
              return snapshot
            }),

          getQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                return queueSnapshotFromState(
                  buildIdleState({
                    queue: yield* getPendingQueue(input.sessionId, input.branchId),
                  }),
                )
              }

              const loopState = yield* loop.actor.snapshot
              const mergedState = updateQueueOnState(
                loopState,
                yield* queueWithPending(loop.pendingQueueRef, loopState.queue),
              )
              return queueSnapshotFromState(mergedState)
            }),

          isRunning: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) return false
              return runtimeStateFromLoopState(yield* loop.actor.snapshot).status !== "idle"
            }),

          respondInteraction: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) return
              const state = yield* loop.actor.snapshot
              if (state._tag !== "WaitingForInteraction") return
              yield* loop.actor.call(
                AgentLoopEvent.InteractionResponded({ requestId: input.requestId }),
              )
            }),

          getActor: (input) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(input.sessionId, input.branchId)
              return loop.actor
            }),

          getState: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop !== undefined) {
                const loopState = yield* loop.actor.snapshot
                return runtimeStateFromLoopState({
                  ...loopState,
                  queue: yield* queueWithPending(loop.pendingQueueRef, loopState.queue),
                })
              }

              const pendingQueue = yield* getPendingQueue(input.sessionId, input.branchId)
              return {
                ...runtimeStateFromLoopState(
                  buildIdleState({
                    currentAgent: yield* resolveStoredAgent({
                      storage,
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                    }),
                    queue: pendingQueue,
                  }),
                ),
              }
            }),
          toRuntimeState: runtimeStateFromLoopState,
        }

        yield* extensionTurnControl.bind({
          queueFollowUp: Effect.fn("AgentLoop.boundQueueFollowUp")(function* (input) {
            const message = new Message({
              id: MessageId.of(Bun.randomUUIDv7()),
              sessionId: input.sessionId,
              branchId: input.branchId,
              kind: "regular",
              role: "user",
              parts: [new TextPart({ type: "text", text: input.content })],
              createdAt: yield* DateTime.nowAsDate,
              metadata: input.metadata,
            })
            yield* service.followUp(message).pipe(Effect.catchEager(() => Effect.void))
          }),
          interject: Effect.fn("AgentLoop.boundInterject")(function* (input) {
            yield* service
              .steer({
                _tag: "Interject",
                sessionId: input.sessionId,
                branchId: input.branchId,
                message: input.content,
              })
              .pipe(Effect.catchEager(() => Effect.void))
          }),
        })

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const loops = yield* Ref.get(loopsRef)
            yield* Effect.forEach(
              Array.from(loops.values()),
              (loop) => Scope.close(loop.scope, Exit.void),
              { concurrency: "unbounded" },
            )
          }),
        )

        return service
      }),
    )

  static Test = (): Layer.Layer<AgentLoop> =>
    Layer.succeed(AgentLoop, {
      runOnce: () => Effect.void,
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      isRunning: (_input) => Effect.succeed(false),
      respondInteraction: () => Effect.void,
      getActor: () => Effect.die("AgentLoop.Test.getActor not implemented"),
      getState: () =>
        Effect.succeed({
          phase: "idle",
          status: "idle",
          agent: DEFAULT_AGENT_NAME,
          queue: { steering: [], followUp: [] },
        }),
      toRuntimeState: runtimeStateFromLoopState,
    })
}
