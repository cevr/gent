import { DateTime, Deferred, Effect, Ref, Stream, type Semaphore } from "effect"
import {
  type AgentDefinition,
  Agents,
  type ReasoningEffort,
  resolveAgentModel,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { DEFAULTS } from "../../domain/defaults.js"
import {
  ErrorOccurred,
  type AgentEvent,
  MessageReceived,
  ProviderRetrying,
  StreamChunk as EventStreamChunk,
  StreamEnded,
  StreamStarted,
  ToolCallFailed,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "../../domain/event.js"
import { type BranchId, type MessageId, type SessionId } from "../../domain/ids.js"
import { type HandoffHandlerService } from "../../domain/interaction-handlers.js"
import { Message, ReasoningPart, TextPart, ToolCallPart } from "../../domain/message.js"
import type { ModelId } from "../../domain/model.js"
import {
  type ProviderError,
  type ProviderService,
  type ProviderRequest,
  type StreamChunk as ProviderStreamChunk,
} from "../../providers/provider.js"
import { type StorageError, type StorageService } from "../../storage/sqlite-storage.js"
import { summarizeToolOutput, stringifyOutput } from "../../domain/tool-output.js"
import { type ToolContext } from "../../domain/tool.js"
import { estimateContextPercent } from "../context-estimation"
import { type ExtensionRegistryService } from "../extensions/registry.js"
import { withRetry } from "../retry"
import { type ToolRunnerService } from "./tool-runner"

const buildSystemPrompt = (basePrompt: string, agent: AgentDefinition): string => {
  const parts: string[] = [basePrompt]

  if (agent.systemPromptAddendum !== undefined && agent.systemPromptAddendum !== "") {
    parts.push(`\n\n## Agent: ${agent.name}\n${agent.systemPromptAddendum}`)
  }

  return parts.join("")
}

const VALID_REASONING_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])

const resolveReasoning = (
  agent: AgentDefinition,
  sessionOverride?: string,
): ProviderRequest["reasoning"] | undefined => {
  if (sessionOverride !== undefined && VALID_REASONING_LEVELS.has(sessionOverride)) {
    return sessionOverride as ProviderRequest["reasoning"]
  }
  return agent.reasoningEffort
}

const formatStreamErrorMessage = (streamError: unknown) => {
  if (streamError instanceof Error) return streamError.message
  if ("message" in (streamError as Record<string, unknown>)) {
    return String((streamError as Record<string, unknown>)["message"])
  }
  return String(streamError)
}

const summarizeRecentMessages = (messages: ReadonlyArray<Message>) => {
  const recentText = messages
    .slice(-20)
    .map((m) => {
      const text = m.parts
        .filter((p): p is typeof TextPart.Type => p.type === "text")
        .map((p) => p.text)
        .join("\n")
      return text !== "" ? `${m.role}: ${text}` : ""
    })
    .filter((line) => line.length > 0)
    .join("\n\n")
  return recentText.length > 0 ? recentText.slice(0, 4000) : "Session context"
}

type PublishEvent = (event: AgentEvent) => Effect.Effect<void, unknown>

export type ActiveStreamHandle = {
  abortController: AbortController
  interruptDeferred: Deferred.Deferred<void>
  interruptedRef: Ref.Ref<boolean>
}

export type AssistantDraft = {
  text: string
  reasoning: string
  toolCalls: ReadonlyArray<ToolCallPart>
  usage?: { inputTokens: number; outputTokens: number }
}

export type ResolvedTurn = {
  currentTurnAgent: AgentNameType
  messages: ReadonlyArray<Message>
  systemPrompt: string
  modelId: ModelId
  reasoning?: ReasoningEffort
  temperature?: number
}

interface ResolvedTurnContext extends ResolvedTurn {
  agent: AgentDefinition
}

const persistAssistantText = (params: {
  storage: StorageService
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
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
      id: Bun.randomUUIDv7() as MessageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "assistant",
      parts,
      createdAt: params.createdAt ?? new Date(),
    })

    yield* params.storage.createMessage(message)
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
  currentAgent?: AgentNameType
  storage: StorageService
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
  sessionId: SessionId
  publishEvent: PublishEvent
  systemPrompt: string
}): Effect.Effect<ResolvedTurnContext | undefined, StorageError> =>
  Effect.gen(function* () {
    const currentAgent = params.agentOverride ?? params.currentAgent ?? "cowork"
    const messages = yield* params.storage
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

    const systemPrompt = yield* params.extensionRegistry.hooks.runInterceptor(
      "prompt.system",
      { basePrompt: buildSystemPrompt(params.systemPrompt, agent), agent },
      (input) => Effect.succeed(input.basePrompt),
    )
    const session = yield* params.storage
      .getSession(params.sessionId)
      .pipe(Effect.catchEager(() => Effect.succeed(undefined)))

    return {
      currentTurnAgent: currentAgent,
      messages,
      agent,
      systemPrompt,
      modelId: resolveAgentModel(agent),
      reasoning: resolveReasoning(agent, session?.reasoningLevel),
      temperature: agent.temperature,
    }
  })

interface CollectedStreamResponse {
  draft: AssistantDraft
  streamFailed: boolean
  interrupted: boolean
}

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
          yield* Effect.logWarning("stream error, persisting partial output", streamError)
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

const persistAssistantTurn = (params: {
  storage: StorageService
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  draft: AssistantDraft
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
      id: Bun.randomUUIDv7() as MessageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "assistant",
      parts: assistantParts,
      createdAt: new Date(),
    })

    yield* params.storage.createMessage(assistantMessage)
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

const executeToolCalls = (params: {
  draft: AssistantDraft
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  bypass: boolean
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
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

        const ctx: ToolContext = {
          sessionId: params.sessionId,
          branchId: params.branchId,
          toolCallId: toolCall.toolCallId,
          agentName: params.currentTurnAgent,
        }
        const run = params.toolRunner.run(toolCall, ctx, { bypass: params.bypass })
        const tool = yield* params.extensionRegistry.getTool(toolCall.toolName)
        const result = yield* tool?.concurrency === "serial"
          ? params.bashSemaphore.withPermits(1)(run)
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

const runAutoHandoffIfNeeded = (params: {
  turnInterrupted: boolean
  handoffSuppress: number
  storage: StorageService
  branchId: BranchId
  currentAgent: AgentNameType
  extensionRegistry: ExtensionRegistryService
  sessionId: SessionId
  handoffHandler: HandoffHandlerService
}) =>
  Effect.gen(function* () {
    if (params.turnInterrupted) return params.handoffSuppress
    if (params.handoffSuppress > 0) return params.handoffSuppress - 1

    const allMessages = yield* params.storage.listMessages(params.branchId)
    const currentAgentDef = yield* params.extensionRegistry.getAgent(params.currentAgent)
    const modelId = resolveAgentModel(currentAgentDef ?? Agents.cowork)
    const contextPercent = estimateContextPercent(allMessages, modelId)
    if (contextPercent < DEFAULTS.handoffThresholdPercent) return params.handoffSuppress

    yield* Effect.logInfo("auto-handoff.threshold").pipe(
      Effect.annotateLogs({
        contextPercent,
        threshold: DEFAULTS.handoffThresholdPercent,
      }),
    )
    const decision = yield* params.handoffHandler
      .present({
        sessionId: params.sessionId,
        branchId: params.branchId,
        summary: summarizeRecentMessages(allMessages),
        reason: `Context at ${contextPercent}% (threshold: ${DEFAULTS.handoffThresholdPercent}%)`,
      })
      .pipe(Effect.catchEager(() => Effect.succeed("reject" as const)))

    return decision === "reject" ? 5 : params.handoffSuppress
  })

export const resolveTurnPhase = (params: {
  message: Message
  agentOverride?: AgentNameType
  currentAgent?: AgentNameType
  storage: StorageService
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
  sessionId: SessionId
  publishEvent: PublishEvent
  systemPrompt: string
}) =>
  Effect.gen(function* () {
    yield* params.storage.createMessage(params.message)
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

    const resolved = yield* resolveTurnContext(params)
    if (resolved === undefined) return undefined

    return {
      currentTurnAgent: resolved.currentTurnAgent,
      messages: resolved.messages,
      systemPrompt: resolved.systemPrompt,
      modelId: resolved.modelId,
      ...(resolved.reasoning !== undefined ? { reasoning: resolved.reasoning } : {}),
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
    } satisfies ResolvedTurn
  })

export const streamTurnPhase = (params: {
  resolved: ResolvedTurn
  provider: ProviderService
  extensionRegistry: ExtensionRegistryService
  publishEvent: PublishEvent
  storage: StorageService
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
        text,
        reasoning,
        createdAt,
      })

    const agent = yield* params.extensionRegistry.getAgent(params.resolved.currentTurnAgent)
    if (agent === undefined) {
      return {
        draft: { text: "", reasoning: "", toolCalls: [] },
        interrupted: false,
        streamFailed: true,
      } satisfies CollectedStreamResponse
    }

    const tools = yield* params.extensionRegistry.listToolsForAgent(agent, {
      sessionId: params.sessionId,
      branchId: params.branchId,
      agentName: params.resolved.currentTurnAgent,
    })

    yield* params
      .publishEvent(new StreamStarted({ sessionId: params.sessionId, branchId: params.branchId }))
      .pipe(Effect.orDie)
    yield* Effect.logInfo("stream.start").pipe(
      Effect.annotateLogs({
        agent: params.resolved.currentTurnAgent,
        model: params.resolved.modelId,
      }),
    )

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
    ).pipe(Effect.withSpan("AgentLoop.provider.stream"))

    const collected = yield* collectStreamResponse({
      streamEffect,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      activeStream: params.activeStream,
      persistAssistantText: persistAssistantTextLocal,
    })

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

    yield* persistAssistantTurn({
      storage: params.storage,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      draft: collected.draft,
    })

    return collected
  })

export const executeToolsPhase = (params: {
  draft: AssistantDraft
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  bypass: boolean
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  bashSemaphore: Semaphore.Semaphore
  storage: StorageService
}) =>
  Effect.gen(function* () {
    if (params.draft.toolCalls.length === 0) return

    const toolResults = yield* executeToolCalls(params)
    const toolResultMessage = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "tool",
      parts: toolResults,
      createdAt: new Date(),
    })
    yield* params.storage.createMessage(toolResultMessage)
  })

export const finalizeTurnPhase = (params: {
  storage: StorageService
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  startedAtMs: number
  messageId: MessageId
  turnInterrupted: boolean
  handoffSuppress: number
  currentAgent: AgentNameType
  extensionRegistry: ExtensionRegistryService
  handoffHandler: HandoffHandlerService
}) =>
  Effect.gen(function* () {
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
    yield* Effect.logInfo("turn.completed").pipe(
      Effect.annotateLogs({
        durationMs: Number(turnDurationMs),
        interrupted: params.turnInterrupted,
      }),
    )

    return yield* runAutoHandoffIfNeeded({
      turnInterrupted: params.turnInterrupted,
      handoffSuppress: params.handoffSuppress,
      storage: params.storage,
      branchId: params.branchId,
      currentAgent: params.currentAgent,
      extensionRegistry: params.extensionRegistry,
      sessionId: params.sessionId,
      handoffHandler: params.handoffHandler,
    })
  })
