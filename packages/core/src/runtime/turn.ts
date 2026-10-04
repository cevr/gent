import {
  type AgentDefinition,
  AgentName,
  type AgentName as AgentNameType,
  resolveSessionAgent,
  calculateCost,
  DEFAULT_AGENT_NAME,
  DEFAULT_MODEL_ID,
  type DriverRef,
  effectiveEffort,
  effectiveModelDriver,
  type EffectiveModelDriver,
  isReasoningEffort,
  type Model,
  ModelId,
  type ModelId as ModelIdType,
  promptCacheTtlMsFor,
  type ReasoningEffort,
  resolveAgentModel,
} from "../domain/agent.js"
import {
  AGENT_PROMPT_PRIORITY,
  compileSharedSystemPrompt,
  compileSystemPrompt,
  dateNotice,
  dateSection,
  fromWireToolPart,
  getToolId,
  getToolMetadata,
  type PromptSection,
  systemPromptBlocks,
  type ToolCapability,
  toWirePrompt,
  wireToolName,
} from "../domain/capability.js"
import {
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
  decodeToolOutput,
  encodeToolOutput,
  Message,
  messagePartsToolCallParts,
  isSpawnedSession,
  normalizeResponseParts,
  projectResponsePartsToMessageParts,
  responseUsage,
  type SessionAdmission,
  stringifyOutput,
  summarizeToolResult,
  openedByClient,
} from "../domain/message.js"
import {
  type BranchId,
  type ExtensionId,
  InteractionRequestId,
  MessageId,
  type ProcessGenerationId,
  type SessionId,
  ToolCallId,
} from "../domain/ids.js"
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Match,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
  type Scope,
  Semaphore,
  Stream,
} from "effect"
import type {
  ExtensionHostContext,
  ExtensionModelsService,
  TurnNotice,
  TurnProjection,
} from "../domain/extension.js"
import {
  ApprovalService,
  CurrentExtensionHostContext,
  ExtensionRegistry,
  type ExtensionRegistryService,
  type ExtensionTurnNotice,
  provideCurrentCapabilityContext,
  provideCurrentHostCtx,
  provideExtensionLeaf,
  RunOpener,
} from "./extension-host.js"
import type * as Response from "effect/ai/Response"
import {
  credentialFailureMessage,
  isWindowFullStopReason,
  type ModelRouteChoice,
  type VirtualModelChoice,
  type ModelRouteCurrent,
  type ModelRouteDecision,
  type ModelRouteInput,
  type ModelRouterContribution,
  type ProviderAuthError,
  type ProviderHints,
  ProviderStopReason,
  type RunEffort,
} from "../domain/driver.js"
import {
  type AgentEvent,
  ErrorOccurred,
  type EventEnvelope,
  EventStore,
  StreamChunk as EventStreamChunk,
  MessageReceived,
  ModelContextProjected,
  ModelRouted,
  ProviderRetrying,
  StreamEnded,
  StreamStarted,
  ToolCallFailed,
  ToolCallSucceeded,
  TurnCompleted,
  type Usage,
} from "../domain/event.js"
import { causeMessage, omitUndefined } from "../domain/guards.js"
import { ProviderError } from "../domain/errors.js"
import * as Prompt from "effect/ai/Prompt"
import {
  emptyTurnRecord,
  EventStorage,
  makeStorageTransaction,
  MessageStorage,
  type PendingToolCall,
  RelationshipStorage,
  SessionOperationStorage,
  SessionStorage,
  type StorageTransaction,
  ToolCallBindingStorage,
  type TurnRecord,
  TurnRecordStorage,
} from "../storage/storage.js"
import {
  attachToolBindingIdentity,
  compileToolPolicy,
  convertTools,
  executeToolCalls,
  processLocalReplayBindingKey,
  processLocalReplayResultKey,
  ProcessLocalToolReplay,
  type ResolvedToolCapability,
  resolveReplayToolBinding,
  staticToolEntries,
  ToolBindingReplayError,
  ToolCallRecoveryOutcome,
  ToolCallRecoveryService,
  ToolInteractionPending,
  type TurnInterruption,
} from "./tools.js"
import { ConfigService, RuntimeEnvironment, type UserConfig } from "./config.js"
import { type AgentLoopError, asAgentLoopError, type RunningState } from "../domain/agent-loop.js"
import {
  driverCacheWritesByLifetime,
  driverRetryPolicy,
  limitResetAt,
  ModelRegistry,
  ModelResolver,
  type ResolveModelRequest,
  retryProviderCall,
  retryReason,
  servedEffortRouter,
  type ServedVirtualModel,
  servedVirtualModel,
  virtualDefaultModel,
} from "./provider.js"
import { WideEvent, WideEventBoundary, withWideEvent } from "effect-wide-event"
import {
  currentHandoffId,
  estimateHistoryTokens,
  estimateTextTokens,
  estimateToolSchemaTokens,
  messagesInCurrentWindow,
  isTokenLimit,
  outputReserveTokens,
  ModelContextBudget,
  ModelContextCapabilityError,
  ModelContextCapabilityFailure,
  ModelContextLedger,
  announcedModel,
  assistantRunEfforts,
  modelChangeNotice,
  projectContextWindow,
  projectCurrentWindow,
  type PromptCache,
  type StepMeasure,
  toolImagePrompt,
  toPrompt,
  turnNoticesText,
} from "./model-context.js"
import { toolImageDirectory } from "./tool-image.js"
import { GentPlatform } from "./gent-platform.js"
import type { LoopInbox } from "./agent-loop.js"

// ── prompt sections ─────────────────────────────────────────────────────────

/**
 * Build the per-turn prompt sections (base + agent addendum + tool list +
 * tool guidelines + extension extras). Returns the unsorted section list;
 * `compileSystemPrompt` sorts it by priority.
 */
export const buildTurnPromptSections = (
  baseSections: ReadonlyArray<PromptSection>,
  agent: AgentDefinition,
  tools: ReadonlyArray<ToolCapability>,
  extraSections?: ReadonlyArray<PromptSection>,
): ReadonlyArray<PromptSection> => {
  const sections: PromptSection[] = [...baseSections]

  // Agent addendum: the agent's own, after the part its children share.
  if (!Predicate.isUndefined(agent.systemPromptAddendum) && agent.systemPromptAddendum !== "") {
    sections.push({
      id: "agent-addendum",
      content: `## Agent: ${agent.name}\n${agent.systemPromptAddendum}`,
      priority: AGENT_PROMPT_PRIORITY + 90,
    })
  }

  const toolsWithMetadata = tools.map((tool) => ({
    id: getToolId(tool),
    metadata: getToolMetadata(tool),
  }))

  // Tool list — tools with promptSnippet get listed explicitly. It follows
  // the tool set, which differs by agent, so it is the agent's own part.
  const snippets = toolsWithMetadata
    .values()
    .filter((tool) => !Predicate.isUndefined(tool.metadata.promptSnippet))
    .map((tool) => `- **${tool.id}**: ${tool.metadata.promptSnippet}`)
    .toArray()
  if (snippets.length > 0) {
    sections.push({
      id: "tool-list",
      content: `## Available Tools\n\n${snippets.join("\n")}`,
      priority: AGENT_PROMPT_PRIORITY + 2,
    })
  }

  // Tool guidelines — collected from active tools + conditional rules; the
  // agent's own part, like the tool list.
  // Every guideline comes from the tool that owns it. The loop does not know
  // tool names -- a tool that wants to steer the model toward another one says
  // so in its own `promptGuidelines`.
  const guidelines = toolsWithMetadata.flatMap((tool) => tool.metadata.promptGuidelines ?? [])
  if (guidelines.length > 0) {
    const deduped = [...new Set(guidelines)]
    sections.push({
      id: "tool-guidelines",
      content: `## Tool Guidelines\n\n${deduped.map((g) => `- ${g}`).join("\n")}`,
      priority: AGENT_PROMPT_PRIORITY + 4,
    })
  }

  // Extension-contributed sections
  if (!Predicate.isUndefined(extraSections)) {
    for (const s of extraSections) {
      sections.push(s)
    }
  }

  return sections
}

/**
 * The two message ids one step of a turn owns.
 *
 * Both ids are derived from the same `(messageId, step)` pair, so they travel
 * as one value. A caller that addresses a different step than the one it is
 * running says so by building a second address, which reads as the difference
 * it is.
 */
interface StepAddress {
  readonly assistant: MessageId
  readonly toolResult: MessageId
}

const stepAddress = (messageId: MessageId, step: number): StepAddress => ({
  assistant: assistantMessageIdForTurn(messageId, step),
  toolResult: toolResultMessageIdForTurn(messageId, step),
})
/** The durable instruction that follows a step whose stream failed after partial output. */
const continuationMessageIdForTurn = (messageId: MessageId, step: number): MessageId =>
  MessageId.make(`${messageId}:continuation:${step}`)

/**
 * The durable instruction that opens the last step a turn is allowed.
 *
 * Separate from `continuationMessageIdForTurn` because it is not a
 * continuation: continuations are bounded per turn and answer a step that went
 * wrong, while this one opens a step the budget itself ended.
 */
const finalStepMessageIdForTurn = (messageId: MessageId): MessageId =>
  MessageId.make(`${messageId}:final-step`)

const toolCallsFromMessage = (message: Message) => messagePartsToolCallParts(message.parts)

// ── turn profile ────────────────────────────────────────────────────────────

export interface AgentLoopTurnProfile {
  readonly turnBaseSections: ReadonlyArray<PromptSection>
  readonly turnHostCtx: ExtensionHostContext
  /** Whether a user can answer in this turn (`turnCanAsk`). */
  readonly turnInteractive: boolean
  /**
   * The services the turn and every extension leaf in it run with. It is the
   * one owner of the turn's `ExtensionRegistry`: a loop that suspends an
   * extension (a failed branch Resource) writes the narrowed registry here.
   */
  readonly turnCapabilityContext: Context.Context<ExtensionRegistry>
  /** Identity of the process that built the profile; a process-local tool binding replays only inside it. */
  readonly turnGenerationId: ProcessGenerationId
}

export class CurrentAgentLoopTurnProfile extends Context.Service<
  CurrentAgentLoopTurnProfile,
  AgentLoopTurnProfile
>()("@gent/core/src/runtime/turn/CurrentAgentLoopTurnProfile") {}

/** The turn's registry, as its capability context holds it. */
export const turnRegistry = (profile: AgentLoopTurnProfile): ExtensionRegistryService =>
  Context.get(profile.turnCapabilityContext, ExtensionRegistry)

/** Provide one resolved turn profile to the complete effect. */
export const runAgentLoopTurnProfile =
  (profile: AgentLoopTurnProfile) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CurrentAgentLoopTurnProfile, profile),
      Effect.provideContext(profile.turnCapabilityContext),
      provideCurrentCapabilityContext(profile.turnCapabilityContext),
      provideCurrentHostCtx(profile.turnHostCtx),
    )

// ── turn-response ───────────────────────────────────────────────────────────

/**
 * Cancellation handle for an in-flight turn stream. `interrupted` is the
 * single source of truth: succeeding it both unblocks
 * `Stream.interruptWhen(...)` and (via the constructor-wired listener)
 * aborts the underlying `AbortController` for AI SDK interop. Callers
 * read `Deferred.isDone(interrupted)` instead of a parallel boolean Ref.
 */
export type ActiveStreamHandle = {
  readonly interrupted: Deferred.Deferred<void>
  readonly abortSignal: AbortSignal
}

const makeAbortController = (): AbortController => new AbortController()

/**
 * Scoped: the forked listener that translates `Deferred.succeed(interrupted)`
 * into `abortController.abort()` lives for the duration of the supplied
 * scope. Clean turn completion closes the scope and interrupts the listener,
 * preventing the per-turn fiber-leak that a detached fork would produce.
 */
export const makeActiveStreamHandle: Effect.Effect<ActiveStreamHandle, never, Scope.Scope> =
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>()
    const abortController = makeAbortController()
    yield* Effect.forkScoped(
      Deferred.await(interrupted).pipe(Effect.andThen(Effect.sync(() => abortController.abort()))),
    )
    return { interrupted, abortSignal: abortController.signal }
  })

export const signalActiveStreamInterrupt = (handle: ActiveStreamHandle): Effect.Effect<void> =>
  Deferred.done(handle.interrupted, Exit.void).pipe(Effect.asVoid)

const wasInterrupted = (handle: ActiveStreamHandle): Effect.Effect<boolean> =>
  Deferred.isDone(handle.interrupted)

/** Mutable accumulator for per-turn wide event fields. */
type TurnMetrics = {
  /** The turn these totals belong to; a resume of the same turn keeps them. */
  messageId: Option.Option<MessageId>
  agent: AgentNameType
  model: string
  /** Tokens of the steps that reported usable counts: the known part of the turn's spend. */
  inputTokens: number
  outputTokens: number
  /** Parts of `inputTokens` the provider read from, and wrote to, its prompt cache. */
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * USD of the steps, of the compaction summaries this turn wrote and of its
   * route's classifier calls. None once one of them could not be priced (its
   * model has no price, or it reported no usable counts): a sum of the rest
   * would read as the turn's whole cost, the same rule `usageKnown` keeps for
   * the tokens.
   */
  costUsd: Option.Option<number>
  /**
   * The routes `costUsd` holds, by turn and router (`routeChargeKey`): each
   * route of a turn, its model route and its effort route, is charged once.
   */
  routesCharged: ReadonlySet<string>
  toolCallCount: number
  /** Model steps seen this turn; zero means no usage can be reported. */
  steps: number
  /** False once any step reported no usage or an unusable count: the totals are then partial. */
  usageKnown: boolean
}

const emptyTurnMetrics = (): TurnMetrics => ({
  messageId: Option.none(),
  agent: DEFAULT_AGENT_NAME,
  model: "",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: Option.some(0),
  routesCharged: new Set(),
  toolCallCount: 0,
  steps: 0,
  usageKnown: true,
})

/**
 * Whether the totals are the turn's whole spend: at least one model step ran,
 * and every step reported usable counts. The `TurnCompleted` receipt and the
 * `turnAfter` hooks both read this, so a record built from either agrees.
 */
const usageComplete = (metrics: TurnMetrics): boolean => metrics.steps > 0 && metrics.usageKnown

/**
 * The ledger's totals when they are this turn's. A turn that failed before it
 * began left another turn's counts there: it spent nothing it can report.
 */
const turnMetricsFor = (metrics: TurnMetrics, messageId: MessageId): TurnMetrics => {
  if (Option.contains(metrics.messageId, messageId)) return metrics
  return {
    ...emptyTurnMetrics(),
    messageId: Option.some(messageId),
    usageKnown: false,
    costUsd: Option.none(),
  }
}

/** How a turn ended, as its receipt and its `turnAfter` hooks record it. */
interface TurnEnd {
  readonly messageId: MessageId
  readonly startedAtMs: number
  readonly turnInterrupted: boolean
  readonly streamFailed: boolean
  readonly unanswered: boolean
}

/** What appending a turn's receipt settled: its duration and what it spent. */
interface TurnReceipt {
  readonly durationMs: number
  readonly metrics: TurnMetrics
}

interface TurnResponseMessages {
  readonly assistant: ReadonlyArray<AssistantResponsePart>
  readonly tool: ReadonlyArray<ToolResponsePart>
  readonly usage?: Usage
}

export interface CollectedTurnResponse {
  readonly responseParts: ReadonlyArray<Response.AnyPart>
  readonly messageProjection: TurnResponseMessages
  readonly interrupted: boolean
  readonly streamFailed: boolean
  /**
   * The provider refused the request as too long before any output, or the
   * window filled while the model wrote (`windowFull`), and the turn may
   * recover: the next step hands the window off first.
   */
  readonly contextOverflow: boolean
  /**
   * The provider stopped the reply because the context window filled
   * (`isWindowFullStopReason`): the reply is cut, whether or not the turn may
   * still hand off.
   */
  readonly windowFull: boolean
  /**
   * When the usage limit the step failed on resets (`limitResetAt`): the
   * provider named a time past the driver's retry cap. None for any other step.
   */
  readonly retryAt: Option.Option<number>
}

const publishEventOrDie = (event: AgentEvent) =>
  Effect.gen(function* () {
    const eventStore = yield* EventStore
    yield* eventStore.publish(event).pipe(Effect.orDie)
  })

export const collectNormalizedResponse = (params: {
  responseParts: ReadonlyArray<Response.AnyPart>
  streamFailed: boolean
  interrupted: boolean
}): CollectedTurnResponse => {
  const normalized = normalizeResponseParts(params.responseParts)
  const messages = projectResponsePartsToMessageParts(normalized)
  const usageOption = normalized
    .filter((part): part is Response.FinishPart => part.type === "finish")
    .map((part) => responseUsage(part.usage))
    .find(Option.isSome)
  const usage = Option.getOrUndefined(usageOption ?? Option.none())

  return {
    responseParts: normalized,
    messageProjection: {
      assistant: messages.assistant,
      tool: messages.tool,
      usage,
    },
    interrupted: params.interrupted,
    streamFailed: params.streamFailed,
    contextOverflow: false,
    windowFull: false,
    retryAt: Option.none(),
  }
}

const isObservableModelOutputPart = (part: Response.AnyPart): boolean => {
  switch (part.type) {
    case "text":
      return part.text.length > 0
    case "text-delta":
      return part.delta.length > 0
    case "reasoning":
      return part.text.length > 0
    case "reasoning-delta":
      return part.delta.length > 0
    case "file":
    case "tool-call":
    case "tool-approval-request":
      return true
    case "tool-result":
      return part.preliminary !== true
    default:
      return false
  }
}

/** What the user reads after a refusal the turn recovers from. */
const CONTEXT_OVERFLOW_RECOVERY =
  "the provider refused the context as too long; handing the window off and running the step again"

/** What the user reads when the window filled mid-reply and the turn hands it off. */
const CONTEXT_WINDOW_FULL_RECOVERY =
  "the context window filled before the reply finished; handing the window off and continuing"

/** What the user reads when the handed-off window is refused as well; the turn ends. */
const CONTEXT_OVERFLOW_AGAIN =
  "the provider refused the context as too long again after the window was handed off; the latest messages alone are longer than the model accepts"

/** Text a stream failure adds to its error, and whether the turn goes on past it. */
interface StreamFailureNote {
  readonly text: string
  /** The turn recovers: the error is published as a notice. */
  readonly notice: boolean
}

/**
 * The receipt fields (`StreamEnded`) for the effort a request sent: its
 * level, or `reasoningDefault` for a request that named none to a model
 * that reasons. Neither field when nothing is known.
 */
const effortReceipt = (
  sent: Option.Option<RunEffort>,
): { readonly reasoningLevel?: ReasoningEffort; readonly reasoningDefault?: true } =>
  Option.match(sent, {
    onNone: () => ({}),
    onSome: (effort) => {
      if (effort === "default") return { reasoningDefault: true }
      return { reasoningLevel: effort }
    },
  })

/**
 * Close the step on a stream failure: log it, end the stream, and surface the
 * error. The end names the model: the step ran on it, settled or not. A
 * `note` adds to the error; one the turn recovers from makes it a notice.
 * The error carries the usage limit's reset time when the step failed on one.
 */
const reportStreamFailure = (
  params: {
    messageId: MessageId
    step: number
    sessionId: SessionId
    branchId: BranchId
    modelId: ModelIdType
    reasoningLevel?: RunEffort
    retryAt: Option.Option<number>
  },
  streamError: ProviderError,
  message: string,
  note: Option.Option<StreamFailureNote> = Option.none(),
) =>
  Effect.gen(function* () {
    yield* Effect.logWarning(message).pipe(Effect.annotateLogs({ error: String(streamError) }))
    yield* publishEventOrDie(
      StreamEnded.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: params.messageId,
        step: params.step,
        model: params.modelId,
        outcome: "Failed",
        ...effortReceipt(Option.fromUndefinedOr(params.reasoningLevel)),
      }),
    )
    const failure = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      error: streamError.message,
      ...omitUndefined({ retryAt: Option.getOrUndefined(params.retryAt) }),
    }
    yield* publishEventOrDie(
      Option.match(note, {
        onNone: () => ErrorOccurred.make(failure),
        onSome: (next) => {
          const noted = { ...failure, error: `${failure.error}; ${next.text}` }
          // Only a recovery is a notice; a turn that ends on it stays an error.
          if (next.notice) return ErrorOccurred.make({ ...noted, notice: true })
          return ErrorOccurred.make(noted)
        },
      }),
    )
  })

export const collectModelTurnResponse = (params: {
  messageId: MessageId
  step: number
  turnStream: Stream.Stream<Response.AnyPart, ProviderError>
  sessionId: SessionId
  branchId: BranchId
  modelId: ModelIdType
  /** The effort the step's request sent; its end names it. */
  reasoningLevel?: RunEffort
  activeStream: ActiveStreamHandle
}) =>
  Effect.gen(function* () {
    const responseParts: Response.AnyPart[] = []
    let hasObservableOutput = false

    const streamFailed = yield* Stream.runForEach(
      params.turnStream.pipe(Stream.interruptWhen(Deferred.await(params.activeStream.interrupted))),
      (part) =>
        Effect.gen(function* () {
          if (part.type === "error") {
            return yield* new ProviderError({
              message: causeMessage(part.error),
              model: params.modelId,
              cause: part.error,
            })
          }
          responseParts.push(part)
          hasObservableOutput = hasObservableOutput || isObservableModelOutputPart(part)
          if (part.type === "text-delta") {
            yield* publishEventOrDie(
              EventStreamChunk.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                chunk: part.delta,
              }),
            )
          }
        }),
    ).pipe(
      Effect.as(false),
      Effect.catchTag("ProviderError", (streamError) =>
        Effect.gen(function* () {
          const interrupted = yield* wasInterrupted(params.activeStream)
          if (interrupted) return false
          // Nothing observable was produced yet: let the caller's retry policy try again.
          if (!hasObservableOutput) return yield* streamError
          yield* reportStreamFailure(
            { ...params, retryAt: Option.none() },
            streamError,
            "stream error, persisting partial output",
          )
          return true
        }),
      ),
    )

    const interrupted = yield* wasInterrupted(params.activeStream)
    return collectNormalizedResponse({
      responseParts,
      streamFailed,
      interrupted,
    })
  })

export const collectFailedModelTurnResponse = (params: {
  messageId: MessageId
  step: number
  streamError: ProviderError
  sessionId: SessionId
  branchId: BranchId
  modelId: ModelIdType
  /** The effort the step's request sent; its end names it. */
  reasoningLevel?: RunEffort
  activeStream: ActiveStreamHandle
  /** The provider refused the request as too long, and the turn will hand off and retry. */
  contextOverflow: boolean
  /** The provider refused as too long a window this turn already handed off. */
  refusedAgain?: boolean
  /** When the usage limit the step failed on resets (`limitResetAt`). */
  retryAt: Option.Option<number>
}) =>
  Effect.gen(function* () {
    const interrupted = yield* wasInterrupted(params.activeStream)
    const contextOverflow = params.contextOverflow && !interrupted
    const retryAt = Option.filter(params.retryAt, () => !interrupted)
    if (!interrupted) {
      let note = Option.none<StreamFailureNote>()
      if (contextOverflow) note = Option.some({ text: CONTEXT_OVERFLOW_RECOVERY, notice: true })
      else if (params.refusedAgain === true) {
        note = Option.some({ text: CONTEXT_OVERFLOW_AGAIN, notice: false })
      }
      yield* reportStreamFailure(
        params,
        params.streamError,
        "stream error before output, retries exhausted",
        note,
      )
    }

    return {
      ...collectNormalizedResponse({
        responseParts: [],
        streamFailed: !interrupted,
        interrupted,
      }),
      contextOverflow,
      retryAt,
    }
  })

// ── turn-ledger ─────────────────────────────────────────────────────────────

/*
 * What the turn now running has spent.
 *
 * A turn's token totals, tool-call count and step count accumulate across its
 * model steps and are read once, at the end, to fill `TurnCompleted`. The
 * accumulator therefore outlives no turn: the next one starts from zero. A
 * turn parked on an interaction and resumed is the same turn, so its steps
 * before the park still count. The totals hold only what steps reported in
 * usable counts. Steps this process never saw (a turn resumed after a
 * restart) and steps cut short without usage add nothing and mark the totals
 * partial: `TurnCompleted` then carries no total, and `turnAfter` gets the
 * known part with `complete: false`.
 *
 * `beginTurn` is the reset, and a writer says what its step observed rather
 * than how to merge it; the fold (which totals to add, which counts make the
 * total unreportable) lives here.
 */

/**
 * A token count this turn can report. A provider that returns a negative,
 * fractional or oversized number has told us nothing usable: that step adds
 * nothing, and the turn's totals become partial rather than wrong.
 */
const reportable = (count: number) => Number.isSafeInteger(count) && count >= 0

interface TurnLedger {
  /** A turn begins or resumes. A different turn starts from zero; the same one keeps its totals. */
  readonly beginTurn: (messageId: MessageId) => Effect.Effect<void>
  /** The turn committed steps before this ledger saw it: its total cannot be complete. */
  readonly noteUnseenSteps: Effect.Effect<void>
  /** Which agent and model this turn runs as. Known before its first step. */
  readonly noteModel: (params: {
    readonly agent: AgentNameType
    readonly model: ModelIdType
  }) => Effect.Effect<void>
  /**
   * One model step finished. `usage` is absent when the provider reported
   * none, which makes this turn's totals partial.
   */
  readonly noteStep: (params: {
    readonly agent: AgentNameType
    readonly model: ModelIdType
    readonly usage: Option.Option<Usage>
    /** The step's price, frozen on its `StreamEnded`. */
    readonly costUsd: Option.Option<number>
    readonly toolCallCount: number
  }) => Effect.Effect<void>
  /**
   * A compaction summary this turn wrote or tried to write, and its price:
   * none when its model has no price or the summary failed after its model
   * was admitted, which leaves the turn without a cost. Its tokens are not a
   * step's.
   */
  readonly noteCompaction: (costUsd: Option.Option<number>) => Effect.Effect<void>
  /**
   * A route this turn runs on, published now or recorded before (an earlier
   * step, a process before a restart): its model route or its effort route.
   * Each route's classifier calls are charged once per turn: none when a
   * classifier has no price, which leaves the turn without a cost; a route
   * that asked no classifier costs nothing.
   */
  readonly noteRoute: (route: ModelRouted) => Effect.Effect<void>
  /** What this turn spent, as `TurnCompleted` reports it. */
  readonly total: Effect.Effect<TurnMetrics>
  /** A step's request carried these notices. */
  readonly noteNotices: (notices: ReadonlyArray<ExtensionTurnNotice>) => Effect.Effect<void>
  /** The keys of every notice a step of this turn carried, by the extension that showed it. */
  readonly shownNotices: Effect.Effect<ReadonlyMap<ExtensionId, ReadonlySet<string>>>
  /** A step joined this steering message into the turn. */
  readonly noteJoined: (messageId: MessageId) => Effect.Effect<void>
  /** The steering messages this process saw a step of this turn join. */
  readonly joined: Effect.Effect<ReadonlySet<MessageId>>
  /** A model step settled: `retryAt` is its usage limit's reset, none for any other end. */
  readonly noteStepEnd: (retryAt: Option.Option<number>) => Effect.Effect<void>
  /** The reset of the usage limit this turn's last step failed on. */
  readonly retryAt: Effect.Effect<Option.Option<number>>
}

/** A cache count the receipt records: zero is left out, as the steps leave it out. */
const positiveCount = (count: number) => Option.liftPredicate(count, (value) => value > 0)

/** Two prices summed: none when either is unknown. */
const addCost = (total: Option.Option<number>, cost: Option.Option<number>) =>
  Option.zipWith(total, cost, (sum, value) => sum + value)

/**
 * What a route's classifier calls cost: nothing when it asked none, none when
 * it asked one with no price.
 */
const routeCharge = (route: ModelRouted): Option.Option<number> =>
  Option.fromUndefinedOr(route.costUsd).pipe(
    Option.orElse(() => Option.liftPredicate(0, () => Predicate.isUndefined(route.classifier))),
  )

/** One route of one turn: a turn has at most a model route and an effort route. */
const routeChargeKey = (route: ModelRouted) =>
  `${route.messageId}\u0000${String(route.effortOnly === true)}\u0000${route.selected}`

export const makeTurnLedger: Effect.Effect<TurnLedger> = Effect.gen(function* () {
  const metrics = yield* Ref.make(emptyTurnMetrics())
  const shown = yield* Ref.make<ReadonlyMap<ExtensionId, ReadonlySet<string>>>(new Map())
  const joined = yield* Ref.make<ReadonlySet<MessageId>>(new Set())
  const lastRetryAt = yield* Ref.make(Option.none<number>())
  return {
    beginTurn: (messageId) =>
      Ref.modify(metrics, (m): readonly [boolean, TurnMetrics] => {
        if (Option.contains(m.messageId, messageId)) return [false, m]
        return [true, { ...emptyTurnMetrics(), messageId: Option.some(messageId) }]
      }).pipe(
        Effect.flatMap((fresh) => {
          if (!fresh) return Effect.void
          return Ref.set(shown, new Map()).pipe(
            Effect.andThen(Ref.set(joined, new Set())),
            Effect.andThen(Ref.set(lastRetryAt, Option.none())),
          )
        }),
      ),
    noteUnseenSteps: Ref.update(metrics, (m) => {
      if (m.steps > 0) return m
      return { ...m, usageKnown: false, costUsd: Option.none() }
    }),
    noteModel: (params) =>
      Ref.update(metrics, (m) => ({ ...m, agent: params.agent, model: params.model })),
    noteStep: (params) =>
      Ref.update(metrics, (m) => {
        const counted = {
          messageId: m.messageId,
          agent: params.agent,
          model: params.model,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cacheReadTokens: m.cacheReadTokens,
          cacheWriteTokens: m.cacheWriteTokens,
          costUsd: Option.none<number>(),
          routesCharged: m.routesCharged,
          toolCallCount: m.toolCallCount + params.toolCallCount,
          steps: m.steps + 1,
          usageKnown: false,
        }
        if (Option.isNone(params.usage)) return counted
        const step = params.usage.value
        const stepCacheRead = Option.getOrElse(
          Option.fromUndefinedOr(step.cacheReadTokens),
          () => 0,
        )
        const stepCacheWrite = Option.getOrElse(
          Option.fromUndefinedOr(step.cacheWriteTokens),
          () => 0,
        )
        const inputTokens = m.inputTokens + step.inputTokens
        const outputTokens = m.outputTokens + step.outputTokens
        const cacheReadTokens = m.cacheReadTokens + stepCacheRead
        const cacheWriteTokens = m.cacheWriteTokens + stepCacheWrite
        const usable = [
          step.inputTokens,
          step.outputTokens,
          stepCacheRead,
          stepCacheWrite,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        ].every(reportable)
        if (!usable) return counted
        return {
          ...counted,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          costUsd: addCost(m.costUsd, params.costUsd),
          usageKnown: m.usageKnown,
        }
      }),
    noteCompaction: (costUsd) =>
      Ref.update(metrics, (m) => ({ ...m, costUsd: addCost(m.costUsd, costUsd) })),
    // Every step of a routed turn reads its route; only the first one this
    // ledger sees for the turn charges it.
    noteRoute: (route) =>
      Ref.update(metrics, (m) => {
        const key = routeChargeKey(route)
        if (m.routesCharged.has(key)) return m
        return {
          ...m,
          costUsd: addCost(m.costUsd, routeCharge(route)),
          routesCharged: new Set([...m.routesCharged, key]),
        }
      }),
    total: Ref.get(metrics),
    noteNotices: (notices) =>
      Ref.update(shown, (current) => {
        const next = new Map(current)
        for (const { extensionId, notice } of notices) {
          const earlier = Option.getOrElse(Option.fromUndefinedOr(next.get(extensionId)), () => [])
          next.set(extensionId, new Set([...earlier, ...notice.keys]))
        }
        return next
      }),
    shownNotices: Ref.get(shown),
    noteJoined: (messageId) => Ref.update(joined, (current) => new Set([...current, messageId])),
    joined: Ref.get(joined),
    noteStepEnd: (retryAt) => Ref.set(lastRetryAt, retryAt),
    retryAt: Ref.get(lastRetryAt),
  }
})

// ── turn-persistence ────────────────────────────────────────────────────────

type ToolTerminalEvent = Extract<
  AgentEvent,
  { readonly _tag: "ToolCallSucceeded" | "ToolCallFailed" }
>

export class ToolResultReplayError extends Schema.TaggedError<ToolResultReplayError>()(
  "ToolResultReplayError",
  {
    assistantMessageId: MessageId,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    message: Schema.String,
  },
) {}

const isToolTerminalEvent: (event: AgentEvent) => event is ToolTerminalEvent = Predicate.or(
  Predicate.and(Predicate.isTagged("ToolCallSucceeded"), Schema.is(ToolCallSucceeded)),
  Predicate.and(Predicate.isTagged("ToolCallFailed"), Schema.is(ToolCallFailed)),
)

const replayResult = (event: ToolTerminalEvent): Option.Option<Prompt.ToolResultPart["result"]> => {
  if (Predicate.isNotUndefined(event.resultJson)) {
    const decoded = decodeToolOutput(event.resultJson)
    return decoded
  }
  if (Predicate.isNotUndefined(event.output)) return Option.some(event.output)
  if (Predicate.isNotUndefined(event.summary)) return Option.some(event.summary)
  return Option.some("")
}

interface CommittedMutation<A> {
  readonly result: A
  readonly envelope?: EventEnvelope
}

type AssistantResponsePart =
  | Prompt.TextPart
  | Prompt.ReasoningPart
  | Prompt.FilePart
  | Prompt.ToolCallPart
  | Prompt.ToolApprovalRequestPart

type ToolResponsePart = Prompt.ToolResultPart | Prompt.ToolApprovalResponsePart

const findPersistedEvent = Effect.fn("TurnHelpers.findPersistedEvent")(function* (params: {
  sessionId: SessionId
  branchId: BranchId
  match: (envelope: EventEnvelope) => boolean
}) {
  const eventStorage = yield* EventStorage
  const events = yield* eventStorage.listEvents({
    sessionId: params.sessionId,
    branchId: params.branchId,
  })
  return [...events].reverse().find(params.match)
})

export const findPersistedToolResults = Effect.fn("TurnHelpers.findPersistedToolResults")(
  function* (params: {
    sessionId: SessionId
    branchId: BranchId
    assistantMessageId: MessageId
    toolCalls: ReadonlyArray<Prompt.ToolCallPart>
  }) {
    const eventStorage = yield* EventStorage
    // The window this step settled, read by id range. Every tool step of
    // every turn reaches here, so the read is bounded by the step rather
    // than by the transcript.
    const events = yield* eventStorage.listToolResultWindow({
      sessionId: params.sessionId,
      branchId: params.branchId,
      assistantMessageId: params.assistantMessageId,
    })
    if (events.length === 0) return new Map<string, Prompt.ToolResultPart>()

    const terminalEvents = events.map((envelope) => envelope.event).filter(isToolTerminalEvent)
    const results = new Map<string, Prompt.ToolResultPart>()
    for (const toolCall of params.toolCalls) {
      const event = terminalEvents.find(
        (candidate) => candidate.toolCallId === toolCall.id && candidate.toolName === toolCall.name,
      )
      if (Predicate.isUndefined(event)) continue
      const result = replayResult(event)
      if (Option.isNone(result)) {
        return yield* new ToolResultReplayError({
          assistantMessageId: params.assistantMessageId,
          toolCallId: ToolCallId.make(toolCall.id),
          toolName: toolCall.name,
          message: `Stored tool result for ${toolCall.name} has invalid structured output`,
        })
      }
      results.set(
        toolCall.id,
        Prompt.toolResultPart({
          id: toolCall.id,
          name: toolCall.name,
          isFailure: event._tag === "ToolCallFailed",
          providerExecuted: false,
          result: result.value,
        }),
      )
    }
    return results
  },
)

const commitWithEvent = Effect.fn("TurnHelpers.commitWithEvent")(function* <A, E, R>(
  mutation: Effect.Effect<CommittedMutation<A>, E, R>,
) {
  const eventStore = yield* EventStore
  const storageTransaction = yield* makeStorageTransaction
  const committed = yield* storageTransaction(mutation)
  if (!Predicate.isUndefined(committed.envelope)) {
    yield* eventStore.deliver(committed.envelope)
  }
  return committed.result
})

export const persistMessageReceived = Effect.fn("TurnHelpers.persistMessageReceived")(
  function* (params: { message: Message }) {
    const messageStorage = yield* MessageStorage
    const eventStore = yield* EventStore
    return yield* commitWithEvent(
      Effect.gen(function* () {
        const existing = yield* messageStorage.getMessage(params.message.id)
        if (!Predicate.isUndefined(existing)) {
          const envelope = yield* findPersistedEvent({
            sessionId: params.message.sessionId,
            branchId: params.message.branchId,
            match: (candidate) =>
              candidate.event._tag === "MessageReceived" &&
              candidate.event.message.id === params.message.id,
          })
          return {
            result: existing,
            envelope,
          }
        }

        yield* messageStorage.createMessageIfAbsent(params.message)
        const envelope = yield* eventStore.append(
          MessageReceived.make({
            message: params.message,
          }),
        )
        return { result: params.message, envelope }
      }),
    )
  },
)

/**
 * Close stale running tool projections. A stored result without a terminal
 * tool event (a recovered cell, a replay failure, a host that died mid-call)
 * gets its terminal event here, before any new model work reads the transcript.
 */
const reconcileToolProjections = Effect.fn("TurnHelpers.reconcileToolProjections")(
  function* (params: {
    sessionId: SessionId
    branchId: BranchId
    assistantMessageId: MessageId
    parts: ReadonlyArray<Prompt.ToolResultPart>
  }) {
    if (params.parts.length === 0) return
    const eventStorage = yield* EventStorage
    const eventStore = yield* EventStore
    // Only this step's own results are reconciled, so the anchored window
    // holds every terminal event that could already have closed one.
    const events = yield* eventStorage.listToolResultWindow({
      sessionId: params.sessionId,
      branchId: params.branchId,
      assistantMessageId: params.assistantMessageId,
    })
    const closed = new Set(
      events.flatMap((envelope) => {
        if (!isToolTerminalEvent(envelope.event)) return []
        return [envelope.event.toolCallId]
      }),
    )
    for (const part of params.parts) {
      const toolCallId = ToolCallId.make(part.id)
      if (closed.has(toolCallId)) continue
      const fields = {
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId,
        toolName: part.name,
        summary: summarizeToolResult(part),
        output: stringifyOutput(part.result),
        resultJson: encodeToolOutput(part.result),
        assistantMessageId: params.assistantMessageId,
      }
      let terminal: AgentEvent = ToolCallSucceeded.make(fields)
      if (part.isFailure) terminal = ToolCallFailed.make(fields)
      yield* eventStore.publish(terminal)
      closed.add(toolCallId)
    }
  },
)

/** One durable message per role: the caller names the role it is persisting. */
const persistMessageParts = Effect.fn("TurnHelpers.persistMessageParts")(function* (
  params: {
    sessionId: SessionId
    branchId: BranchId
    messageId: MessageId
    createdAt?: Date
  } & (
    | { role: "assistant"; parts: ReadonlyArray<AssistantResponsePart> }
    | { role: "tool"; parts: ReadonlyArray<ToolResponsePart> }
  ),
) {
  if (params.parts.length === 0) return Option.none<Message>()

  const messageStorage = yield* MessageStorage
  const message = Message.cases.regular.make({
    id: params.messageId,
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: params.role,
    parts: [...params.parts],
    createdAt: params.createdAt ?? (yield* DateTime.nowAsDate),
  })

  const existing = yield* messageStorage.getMessage(message.id)
  if (!Predicate.isUndefined(existing)) return Option.some(existing)

  return yield* persistMessageReceived({ message }).pipe(Effect.asSome)
})

/** Persist an assistant tool-call message and its immutable bindings together. */
export const persistAssistantPartsWithBindings = Effect.fn(
  "TurnHelpers.persistAssistantPartsWithBindings",
)(function* (params: {
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<AssistantResponsePart>
  toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  storageTransaction: StorageTransaction
  createdAt?: Date
}) {
  if (params.parts.length === 0) {
    return Option.none<{ readonly message: Message; readonly inserted: boolean }>()
  }

  const messageStorage = yield* MessageStorage
  const bindingStorage = yield* ToolCallBindingStorage
  const eventStore = yield* EventStore
  const message = Message.cases.regular.make({
    id: params.messageId,
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "assistant",
    parts: [...params.parts],
    createdAt: params.createdAt ?? (yield* DateTime.nowAsDate),
  })
  const toolCalls = params.parts.filter(
    (part): part is Prompt.ToolCallPart => part.type === "tool-call",
  )
  const committed = yield* params.storageTransaction(
    Effect.gen(function* () {
      const existing = yield* messageStorage.getMessage(message.id)
      let stored: Message = message
      let inserted = false
      let envelope = Option.none<EventEnvelope>()
      if (Predicate.isUndefined(existing)) {
        stored = yield* messageStorage.createMessageIfAbsent(message)
        inserted = true
        envelope = Option.some(yield* eventStore.append(MessageReceived.make({ message: stored })))
      } else {
        stored = existing
        envelope = Option.fromUndefinedOr(
          yield* findPersistedEvent({
            sessionId: params.sessionId,
            branchId: params.branchId,
            match: (candidate) =>
              candidate.event._tag === "MessageReceived" &&
              candidate.event.message.id === message.id,
          }),
        )
      }

      if (Predicate.isUndefined(existing)) {
        for (const toolCall of toolCalls) {
          const entry = params.toolBindings.get(toolCall.name)
          if (Predicate.isUndefined(entry) || Predicate.isUndefined(entry.binding)) continue
          yield* bindingStorage.save({
            assistantMessageId: message.id,
            toolCallId: ToolCallId.make(toolCall.id),
            sessionId: params.sessionId,
            branchId: params.branchId,
            binding: entry.binding,
          })
        }
      }
      return { result: { message: stored, inserted }, envelope }
    }),
  )
  if (Option.isSome(committed.envelope)) {
    yield* eventStore.deliver(committed.envelope.value)
  }
  return Option.some(committed.result)
})

/**
 * Records what a tool call produced: the result parts on the tool message,
 * then the terminal event for every call the transcript has not closed.
 * The two are never useful apart, so a caller cannot persist and forget.
 */
export const recordToolOutcome = (params: {
  sessionId: SessionId
  branchId: BranchId
  toolResultMessageId: MessageId
  assistantMessageId: MessageId
  parts: ReadonlyArray<ToolResponsePart>
}) =>
  persistMessageParts({
    role: "tool",
    sessionId: params.sessionId,
    branchId: params.branchId,
    messageId: params.toolResultMessageId,
    parts: params.parts,
  }).pipe(
    Effect.andThen(
      reconcileToolProjections({
        sessionId: params.sessionId,
        branchId: params.branchId,
        assistantMessageId: params.assistantMessageId,
        parts: params.parts.filter((part) => part.type === "tool-result"),
      }),
    ),
  )

// ── turn-resolve ────────────────────────────────────────────────────────────

/** What one step of a turn runs with: the agent, its prompt, model and tool bindings. */
interface ResolvedTurnContext {
  currentTurnAgent: AgentNameType
  messages: ReadonlyArray<Message>
  /** The system prompt as cache blocks: the part children share, then the agent's own (`systemPromptBlocks`). */
  systemPrompt: ReadonlyArray<string>
  modelId: ModelIdType
  reasoning?: ReasoningEffort
  temperature?: number
  /** Derived once at resolution; the resolver, retry policy, and catalog lookup share it. */
  modelDriver: EffectiveModelDriver
  agent: AgentDefinition
  /** The tools the request advertises. */
  tools: ReadonlyArray<ToolCapability>
  /**
   * Every tool the profile registers, the advertised ones first. The reply
   * decodes against them, so a call to one the turn did not advertise (a host
   * tool behind the cell, a denied one) reaches the runner, which answers it
   * as a failed result, instead of failing the stream.
   */
  replyTools: ReadonlyArray<ToolCapability>
  /** Exact owner and implementation selected for each advertised tool. */
  toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  /** Admitted host tools remain available to extension-owned execution surfaces. */
  hostToolBindings: ReadonlyMap<string, ResolvedToolCapability>
  /** Sent after the conversation, never in `systemPrompt`: see `toPrompt`. */
  notices: ReadonlyArray<ExtensionTurnNotice>
  /** Today's date when the prompt names an earlier one (`dateNotice`); sent first among the notices. */
  dateNotice: Option.Option<TurnNotice>
  /** The session is a spawned child (`isSpawnedSession`): its requests say so to the driver. */
  child: boolean
  /** The driver the agent names; a routed turn derives `modelDriver` from it again. */
  driverRef: Option.Option<DriverRef>
  /** The effort the session itself set; it wins over a routed choice's. */
  sessionReasoning: Option.Option<ReasoningEffort>
  /** `/effort auto`: the effort router picks the turn's level (`routeEffort`). */
  effortAuto: boolean
}

/** The notices a step's request carries after the conversation: the date first, then the extensions'. */
const requestNotices = (resolved: ResolvedTurnContext): ReadonlyArray<TurnNotice> => [
  ...Option.toArray(resolved.dateNotice),
  ...resolved.notices.map(({ notice }) => notice),
]

interface SessionSettingsSource {
  readonly modelId?: ModelId
  readonly reasoningLevel?: ReasoningEffort
}

/** How a session's next turn routes; see `resolveSessionRoute`. */
interface SessionRoute {
  /** The agent the session names; the default one when it names none. */
  readonly name: AgentNameType
  /**
   * That agent from the roster (extension agents and config `agents`
   * entries) with the run's overrides applied (`resolveSessionAgent`); none
   * when no agent has the name. Its `driver` is its own: a config
   * `driverOverrides` entry reaches `modelDriver` only.
   */
  readonly definition: Option.Option<AgentDefinition>
  readonly modelId: ModelId
  readonly reasoningLevel: Option.Option<ReasoningEffort>
  /** The level without the session's own: what clearing it falls back to. */
  readonly defaultReasoningLevel: Option.Option<ReasoningEffort>
  /** The driver the model dispatches through, and the catalog id it reaches. */
  readonly modelDriver: EffectiveModelDriver
  /** The driver the agent names (its own, else config `driverOverrides`). */
  readonly driverRef: Option.Option<DriverRef>
}

/**
 * How a session's next turn routes, derived once. The agent is the one its
 * admission names (the default when it names none), reshaped by config
 * `agents[name]` and then by the admission's run overrides. The model
 * dispatches through the agent's own driver; when it names none, through
 * config `driverOverrides[name]`; else through the model id's provider. The
 * session's own model and reasoning win over the agent's; an unknown agent
 * falls back to the default model. The turn, the snapshot footer and the
 * auth gate all read it here, so a child session is its agent everywhere and
 * the three cannot disagree on a model or driver.
 */
export const resolveSessionRoute = (params: {
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly admission: Option.Option<SessionAdmission>
  readonly config: Pick<UserConfig, "agents" | "driverOverrides">
  readonly session: SessionSettingsSource
}): SessionRoute => {
  const name = Option.getOrElse(
    Option.flatMap(params.admission, (admission) => Option.fromUndefinedOr(admission.agent)),
    () => DEFAULT_AGENT_NAME,
  )
  const definition = resolveSessionAgent({
    agents: params.agents,
    configAgents: Option.fromUndefinedOr(params.config.agents),
    name,
    overrides: Option.flatMap(params.admission, (admission) =>
      Option.fromUndefinedOr(admission.runSpec?.overrides),
    ),
  })
  const modelId = Option.getOrElse(Option.fromUndefinedOr(params.session.modelId), () =>
    Option.match(definition, {
      onNone: () => DEFAULT_MODEL_ID,
      onSome: resolveAgentModel,
    }),
  )
  const defaultReasoningLevel = Option.flatMap(definition, (agent) =>
    Option.fromUndefinedOr(agent.reasoningEffort),
  )
  const driverRef = Option.flatMap(definition, (agent) =>
    Option.orElse(Option.fromUndefinedOr(agent.driver), () =>
      Option.fromUndefinedOr(params.config.driverOverrides?.[agent.name]),
    ),
  )
  return {
    name,
    definition,
    modelId,
    reasoningLevel: Option.orElse(
      Option.fromUndefinedOr(params.session.reasoningLevel),
      () => defaultReasoningLevel,
    ),
    defaultReasoningLevel,
    modelDriver: effectiveModelDriver(driverRef, modelId),
    driverRef,
  }
}

/**
 * The driver a route's turn needs a credential for. A virtual model needs its
 * default choice's: the model its turn runs on when its router does not choose.
 */
export const routeCredentialDriver = (
  route: SessionRoute,
  profile: Parameters<typeof servedVirtualModel>[0],
): Option.Option<string> =>
  Option.match(
    servedVirtualModel(profile, route.modelId).pipe(
      Option.flatMap(Result.getSuccess),
      Option.flatMap((served) => virtualDefaultModel(served.model)),
    ),
    {
      onNone: () => route.modelDriver.driverId,
      onSome: (modelId) => effectiveModelDriver(route.driverRef, modelId).driverId,
    },
  )

/** The agent a session's turns run as, by name; the default when the session names none. */
export const sessionAgentName = Effect.fn("TurnHelpers.sessionAgentName")(function* (
  sessionId: SessionId,
) {
  const session = yield* (yield* SessionStorage).getSession(sessionId)
  return Option.getOrElse(
    Option.fromUndefinedOr(session?.admission?.agent),
    () => DEFAULT_AGENT_NAME,
  )
})

const resolveTurnContext = Effect.fn("TurnHelpers.resolveTurnContext")(function* (params: {
  branchId: BranchId
  sessionId: SessionId
  baseSections: ReadonlyArray<PromptSection>
  /** False withholds the tools that ask the user: an extension opened the turn. */
  interactive: boolean
}) {
  const extensionRegistry = yield* ExtensionRegistry
  const messageStorage = yield* MessageStorage
  const sessionStorage = yield* SessionStorage
  const eventStore = yield* EventStore
  const hostCtx = yield* CurrentExtensionHostContext
  // The session names the agent every one of its turns runs as. A turn whose
  // session cannot be read fails rather than run as the default agent, which
  // would hand a child the tools and model its parent withheld.
  const session = Option.fromUndefinedOr(yield* sessionStorage.getSession(params.sessionId))
  const admission = Option.flatMap(session, (value) => Option.fromUndefinedOr(value.admission))
  const rawMessages = yield* messageStorage
    .listMessages(params.branchId)
    .pipe(Effect.map((items) => [...items]))
  const resolvedExtensions = extensionRegistry.getResolved()
  // `ConfigService` is required, so a root that omits it fails at wiring.
  const configService = yield* ConfigService
  // Overrides come from the session's cwd, so a multi-cwd server reads each
  // project's own config. A turn whose user or project config file does not
  // load does not run: the file's fields would read as unset (project) or as
  // the last file that loaded (user), so a `tools` restriction in it could
  // fall away and the agent would run with more than its author gave it.
  // Config never widens what an agent may do. The error names each file;
  // the next turn after the fix runs. Other readers (health, providers, the
  // route a client reads) stay lenient: only a turn spends authority.
  const fresh = yield* configService.getFresh(hostCtx.cwd)
  if (fresh.failures.length > 0) {
    yield* eventStore
      .publish(
        ErrorOccurred.make({
          sessionId: params.sessionId,
          branchId: params.branchId,
          error: fresh.failures
            .map(
              (failure) =>
                `${failure.path} did not load; turns in ${hostCtx.cwd} do not run until it is fixed: ${failure.message}`,
            )
            .join("\n"),
        }),
      )
      .pipe(Effect.orDie)
    // oxlint-disable-next-line effect/noNullish -- A config that does not load ends the turn after the error event is published, as an unknown agent does.
    return undefined
  }
  const route = resolveSessionRoute({
    agents: [...resolvedExtensions.agents.values()],
    admission,
    config: fresh.config,
    session: Option.getOrElse(session, (): SessionSettingsSource => ({})),
  })
  const { name: currentAgent, definition } = route
  if (Option.isNone(definition)) {
    yield* eventStore
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
  const dispatchAgent = definition.value
  const interactive = params.interactive

  // Derive extension projections from explicit prompt/message slots.
  const allToolEntries = staticToolEntries(extensionRegistry)
  const allTools = allToolEntries.map((entry) => entry.capability)
  // Filter out hidden messages — visible in transcript but excluded from LLM context
  const messages = rawMessages.filter((m) => m.metadata?.hidden !== true)

  const projEval = yield* extensionRegistry
    .getResolved()
    .extensionHooks.resolveTurnProjection({ agent: dispatchAgent })
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
  } = compileToolPolicy(allTools, dispatchAgent, { interactive }, extensionProjections)
  const entriesByToolId = new Map<string, ResolvedToolCapability>()
  for (const entry of allToolEntries) {
    const bound = yield* attachToolBindingIdentity(entry)
    entriesByToolId.set(String(getToolId(entry.capability)), bound)
  }
  const hostToolBindings = new Map<string, ResolvedToolCapability>()
  for (const tool of hostTools) {
    const entry = entriesByToolId.get(String(getToolId(tool)))
    if (Predicate.isNotUndefined(entry)) hostToolBindings.set(String(getToolId(tool)), entry)
  }
  const selectedNames = new Set(tools.map((tool) => String(getToolId(tool))))
  const toolBindings = new Map([...hostToolBindings].filter(([name]) => selectedNames.has(name)))

  // Build the tool-aware prompt, then run it through the systemPrompt hooks,
  // which receive the compiled `basePrompt`. The prompt's date is the day the
  // session tree's root started, so the cached prefix holds past midnight and
  // a child shares its parent's; a turn on a later day reads today's date in
  // a notice after the conversation.
  const zone = DateTime.zoneMakeLocal()
  const today = DateTime.setZone(yield* DateTime.now, zone)
  const ancestors = yield* (yield* RelationshipStorage).getSessionAncestors(params.sessionId)
  const treeStart = Option.fromUndefinedOr(ancestors.at(-1)).pipe(
    Option.flatMap((root) => DateTime.make(root.createdAt)),
    Option.map((start) => DateTime.setZone(start, zone)),
    Option.getOrElse(() => today),
  )
  const sections = buildTurnPromptSections(
    [...params.baseSections, dateSection(treeStart)],
    dispatchAgent,
    tools,
    extensionSections,
  )
  const turnPrompt = compileSystemPrompt(sections)
  const systemPrompt = yield* extensionRegistry.getResolved().extensionHooks.resolveSystemPrompt({
    basePrompt: turnPrompt,
    agent: dispatchAgent,
    interactive,
    tools,
    hostTools,
  })
  return {
    currentTurnAgent: currentAgent,
    messages,
    agent: dispatchAgent,
    tools,
    replyTools: [
      ...tools,
      ...allTools.filter((tool) => !selectedNames.has(String(getToolId(tool)))),
    ],
    toolBindings,
    hostToolBindings,
    systemPrompt: systemPromptBlocks(systemPrompt, compileSharedSystemPrompt(sections)),
    modelId: route.modelId,
    reasoning: Option.getOrUndefined(route.reasoningLevel),
    temperature: dispatchAgent.temperature,
    modelDriver: route.modelDriver,
    notices: projEval.notices,
    dateNotice: dateNotice(treeStart, today),
    child: Option.exists(session, isSpawnedSession),
    driverRef: route.driverRef,
    sessionReasoning: Option.flatMap(session, (value) =>
      Option.fromUndefinedOr(value.reasoningLevel),
    ),
    effortAuto: Option.exists(session, (value) => value.reasoningAuto === true),
  }
})

// ── model-routing ───────────────────────────────────────────────────────────

/*
 * A turn on a virtual model (`router/auto`) runs on one concrete model. The
 * router picks it once, before the turn's first request; the `ModelRouted`
 * event records the pick, and every later step, a replay and a recovered
 * turn read it and never route again. Routing writes nothing the model
 * reads: the request on the routed model is the one the same turn sends on
 * that model selected by hand, model-change notice included.
 *
 * A route that fails, times out or picks a choice the turn cannot run falls
 * back: the model the branch runs on when it is a choice, else the default
 * choice. Where a turn cannot route (a later step, after the selection
 * changed mid-turn, or a conversation that ends on an assistant message,
 * which Anthropic 4.6 and later refuse as a prefill), the router is not
 * asked and the turn keeps the model the branch runs on. A turn never fails
 * on its route.
 */

/** The most a router may take, its classifier calls included; past it the turn falls back. */
const ROUTE_DEADLINE_MS = 10_000

/** The most of a router's reason a `ModelRouted` keeps. */
const ROUTE_REASON_CHARS = 200

/** What routing reads from the branch's log. */
interface RoutingLog {
  /** The concrete model the branch runs on: its last request's, or a notice's. */
  readonly current: Option.Option<ModelIdType>
  readonly lastCallModel: Option.Option<ModelIdType>
  readonly lastCallAtMillis: Option.Option<number>
  readonly measure: Option.Option<StepMeasure>
  /** The branch's newest `ModelRouted`. */
  readonly routed: Option.Option<ModelRouted>
}

/** Where a routed turn runs, and whether an earlier step (or process) recorded it. */
interface TurnRoute {
  readonly event: ModelRouted
  readonly recorded: boolean
  /**
   * Where the call carried the effort router (`ModelRouteInput.effort`): its
   * pick, or why the call failed. None where the call did not answer for it.
   */
  readonly effort: DecidedEffort
}

/** The effort router the model route's call may answer for too, and what it reads. */
interface CombinedEffort {
  readonly served: ServedVirtualModel
  readonly log: EffortRoutingLog
}

/** One classifier call a route made: its model and its price, none when unpriced. */
interface RouteCall {
  readonly model: ModelIdType
  readonly costUsd: Option.Option<number>
}

/** A request may end here: on the user's message or a tool result, never an assistant prefill. */
const endsOnInput = (messages: ReadonlyArray<Message>): boolean =>
  Option.exists(
    Option.fromUndefinedOr(messages.at(-1)),
    (message) => message.role === "user" || message.role === "tool",
  )

/**
 * The turn on its routed model: the driver derived again for it, and the
 * choice's effort unless the session set its own.
 */
const applyTurnRoute = <Resolved extends ResolvedTurnContext>(
  resolved: Resolved,
  route: ModelRouted,
): Resolved => {
  const reasoning = Option.orElse(resolved.sessionReasoning, () =>
    Option.orElse(Option.fromUndefinedOr(route.effort), () =>
      Option.fromUndefinedOr(resolved.reasoning),
    ),
  )
  return {
    ...resolved,
    modelId: route.model,
    modelDriver: effectiveModelDriver(resolved.driverRef, route.model),
    ...omitUndefined({ reasoning: Option.getOrUndefined(reasoning) }),
  }
}

/** The sum of the calls' prices; none when one is unpriced or there was no call. */
const routeCost = (calls: ReadonlyArray<RouteCall>): Option.Option<number> => {
  if (calls.length === 0) return Option.none()
  return Option.map(Option.all(calls.map((call) => call.costUsd)), (costs) =>
    costs.reduce((sum, cost) => sum + cost, 0),
  )
}

/**
 * Ask `router` for one pick, `ROUTE_DEADLINE_MS` at most. A router's
 * failure, timeout or defect is a reason to fall back, never the turn's. The
 * route runs as a leaf of the extension that registered the router, as its
 * tools do, so its state pulse and its sends name it. The router's
 * classifier calls go through the run's own facet; core records each one's
 * model and price for the event and the turn's cost, a call made before a
 * failure included.
 */
const askRouter = Effect.fn("TurnHelpers.askRouter")(function* (
  router: ModelRouterContribution,
  input: ModelRouteInput,
) {
  const host = yield* CurrentExtensionHostContext
  const owner = (yield* ExtensionRegistry).getResolved().modelRouterOwners.get(router.id)
  const calls = yield* Ref.make<ReadonlyArray<RouteCall>>([])
  const Models: ExtensionModelsService = {
    ...host.Models,
    decide: (request) =>
      host.Models.decide(request).pipe(
        Effect.tap((reply) =>
          Ref.update(calls, (all) => [
            ...all,
            { model: reply.model, costUsd: Option.fromUndefinedOr(reply.costUsd) },
          ]),
        ),
      ),
  }
  const picked = yield* router.route(input).pipe(
    provideExtensionLeaf(omitUndefined({ extensionId: owner })),
    Effect.provideService(CurrentExtensionHostContext, { ...host, Models }),
    Effect.map((pick): Result.Result<ModelRouteDecision, string> => Result.succeed(pick)),
    Effect.timeoutOrElse({
      duration: Duration.millis(ROUTE_DEADLINE_MS),
      orElse: () =>
        Effect.succeed(Result.fail(`the router gave no answer within ${ROUTE_DEADLINE_MS} ms`)),
    }),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      return Effect.succeed(Result.fail(`the router failed: ${causeMessage(Cause.squash(cause))}`))
    }),
  )
  return { picked, calls: yield* Ref.get(calls) }
})

/**
 * Route one turn of `served`. None when no choice names a model the catalog
 * lists: the turn cannot run.
 */
const routeTurn = Effect.fn("TurnHelpers.routeTurn")(function* (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
  readonly step: number
  readonly resolved: ResolvedTurnContext
  readonly served: ServedVirtualModel
  readonly log: RoutingLog
  /** On `/effort auto`, where this router serves the effort router too. */
  readonly effort: Option.Option<CombinedEffort>
}) {
  const { resolved, served, log } = params
  const selected = resolved.modelId
  const recorded = Option.filter(
    log.routed,
    (event) => event.messageId === params.messageId && event.selected === selected,
  )
  if (Option.isSome(recorded)) {
    return Option.some<TurnRoute>({
      event: recorded.value,
      recorded: true,
      effort: Option.none(),
    })
  }
  const startedAt = yield* Clock.currentTimeMillis
  const modelRegistry = yield* ModelRegistry
  // A turn runs only on a chat model the catalog lists.
  const entryOf = (id: ModelIdType) =>
    modelRegistry.get(id).pipe(
      Effect.map(Option.filter((model) => Predicate.isUndefined(model.kind))),
      Effect.catchEager(() => Effect.succeedNone),
    )
  const choices = served.model.choices
  // A choice that names no model keeps the model the branch runs on.
  const kept = Option.orElse(log.current, () => virtualDefaultModel(served.model))
  const listed = yield* Effect.forEach(choices, (choice) =>
    Option.match(
      Option.orElse(Option.fromUndefinedOr(choice.model), () => kept),
      {
        onNone: () => Effect.succeed(Option.none<Model>()),
        onSome: entryOf,
      },
    ),
  )
  // A turn runs only on a model whose driver has a sign-in that `/auth` lists
  // as ready: the driver the turn would dispatch through on it.
  const modelResolver = yield* ModelResolver
  const registry = yield* ExtensionRegistry
  const driverOf = (model: Model) => effectiveModelDriver(resolved.driverRef, model.id).driverId
  const unsignedDriver = yield* Effect.forEach(listed, (entry) =>
    Option.match(Option.flatMap(entry, driverOf), {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (driverId) =>
        Effect.map(modelResolver.signedIn(driverId, registry), (signedIn) =>
          Option.liftPredicate(driverId, () => !signedIn),
        ),
    }),
  )
  const unsignedAt = (index: number) =>
    Option.flatten(Option.fromUndefinedOr(unsignedDriver[index]))
  const candidates = listed.map((entry, index) =>
    Option.filter(entry, () => Option.isNone(unsignedAt(index))),
  )
  const entryAt = (models: ReadonlyArray<Option.Option<Model>>) => (index: number) =>
    Option.flatten(Option.fromUndefinedOr(models[index]))
  const candidateAt = entryAt(candidates)
  const runnable = (index: number) => Option.isSome(candidateAt(index))
  const indexes = choices.map((_, index) => index)
  const atChoice = (index: number, reason: string, fellBack: boolean) =>
    Option.map(candidateAt(index), (model) => ({
      choice: Option.some(index),
      model,
      reason,
      fellBack,
    }))
  // The current model when it is a choice (the default first, then one
  // that names it), else the default choice, else the first that runs.
  const fallbackAmong = (at: (index: number) => Option.Option<Model>, reason: string) => {
    const runs = (index: number) => Option.isSome(at(index))
    const runsOnCurrent = (index: number) =>
      Option.exists(at(index), (model) => Option.contains(log.current, model.id))
    const index = Option.liftPredicate(served.model.fallback, runsOnCurrent).pipe(
      Option.orElse(() =>
        Option.fromUndefinedOr(
          indexes.find(
            (index) => runsOnCurrent(index) && Predicate.isNotUndefined(choices[index]?.model),
          ),
        ),
      ),
      Option.orElse(() => Option.liftPredicate(served.model.fallback, runs)),
      Option.orElse(() => Option.fromUndefinedOr(indexes.find(runs))),
    )
    return Option.flatMap(index, (choice) =>
      Option.map(at(choice), (model) => ({
        choice: Option.some(choice),
        model,
        reason,
        fellBack: true,
      })),
    )
  }
  // With no choice signed in the router is not asked: the turn falls back
  // among the listed choices, and the provider's own sign-in error stops the
  // request, as it does on a model selected by hand.
  const unsigned = [...new Set(unsignedDriver.flatMap(Option.toArray))].map(
    (driverId) => `"${driverId}"`,
  )
  const unsignedProviders = () => {
    if (unsigned.length <= 1) return `the provider ${unsigned.join("")} has`
    return `the providers ${unsigned.slice(0, -1).join(", ")} and ${unsigned.at(-1)} have`
  }
  const noneSignedIn = `no choice can run: ${unsignedProviders()} no sign-in`
  const anyRunnable = indexes.some(runnable)
  const fallback = (reason: string) => {
    if (anyRunnable) return fallbackAmong(candidateAt, reason)
    return fallbackAmong(entryAt(listed), noneSignedIn)
  }

  const now = yield* Clock.currentTimeMillis
  const current = yield* Option.match(log.current, {
    onNone: () => Effect.succeed(Option.none<ModelRouteCurrent>()),
    onSome: (id) =>
      Effect.map(
        entryOf(id),
        Option.map((model: Model): ModelRouteCurrent => ({
          model,
          // A cache belongs to the model of the last request. A model whose
          // entry names no lifetime never goes cold.
          warm:
            Option.contains(log.lastCallModel, model.id) &&
            Option.exists(log.lastCallAtMillis, (at) =>
              Option.match(promptCacheTtlMsFor(model, resolved.child), {
                onNone: () => true,
                onSome: (ttlMs) => now < at + ttlMs,
              }),
            ),
          historyTokens: estimateHistoryTokens(resolved.messages, log.measure, model),
        })),
      ),
  })

  // Where the turn cannot route, it keeps the model the branch runs on, a
  // choice or not, and sets no effort: a switch there would rewrite the
  // cache mid-turn or send a prefill. A branch with no request yet takes the
  // default choice.
  const keep = (reason: string) =>
    Option.match(current, {
      onNone: () => fallback(reason),
      onSome: ({ model }) =>
        Option.some({ choice: Option.none<number>(), model, reason, fellBack: true }),
    })
  let decision = keep("a turn routes only before its first request")
  const firstRequest = params.step <= 1
  if (firstRequest && !endsOnInput(resolved.messages))
    decision = keep("the conversation ends on an assistant message, so the turn keeps its model")
  if (firstRequest && endsOnInput(resolved.messages) && !anyRunnable)
    decision = fallback(noneSignedIn)
  let spent: ReadonlyArray<RouteCall> = []
  let effortPick: DecidedEffort = Option.none()
  if (firstRequest && endsOnInput(resolved.messages) && anyRunnable) {
    const effort = yield* Option.match(params.effort, {
      onNone: () => Effect.succeedNone,
      onSome: (combined) =>
        combinedEffortInput({
          sessionId: params.sessionId,
          resolved,
          combined,
          models: candidates.flatMap(Option.toArray),
        }),
    })
    const asked = yield* askRouter(served.router, {
      model: served.model,
      messages: resolved.messages,
      candidates,
      current,
      child: resolved.child,
      ...omitUndefined({ effort: Option.getOrUndefined(effort) }),
    })
    spent = asked.calls
    const picked = asked.picked
    if (Option.isSome(effort))
      effortPick = Result.match(picked, {
        onFailure: (failure) => Option.some(Result.fail(failure)),
        onSuccess: (decision) =>
          Option.map(Option.fromUndefinedOr(decision.effort), Result.succeed),
      })
    if (Result.isFailure(picked)) {
      yield* Effect.logWarning("turn.route-fell-back").pipe(
        Effect.annotateLogs({ model: selected, reason: picked.failure }),
      )
      decision = fallback(picked.failure)
    } else if (!Number.isInteger(picked.success.choice) || !runnable(picked.success.choice)) {
      const pick = picked.success.choice
      decision = fallback(
        Option.match(unsignedAt(pick), {
          onNone: () => `the router picked choice ${pick}, which the turn cannot run`,
          onSome: (driverId) =>
            `the router picked choice ${pick}, whose provider "${driverId}" has no sign-in`,
        }),
      )
    } else {
      decision = atChoice(picked.success.choice, picked.success.reason, false)
    }
  }
  if (Option.isNone(decision)) return Option.none<TurnRoute>()

  const { choice, model, reason, fellBack } = decision.value
  const event = ModelRouted.make({
    sessionId: params.sessionId,
    branchId: params.branchId,
    messageId: params.messageId,
    selected,
    model: model.id,
    reason: reason.slice(0, ROUTE_REASON_CHARS),
    durationMs: (yield* Clock.currentTimeMillis) - startedAt,
    ...omitUndefined({
      choice: Option.getOrUndefined(choice),
      effort: Option.getOrUndefined(
        Option.flatMap(choice, (index) => Option.fromUndefinedOr(choices[index]?.effort)),
      ),
      fallback: Option.getOrUndefined(Option.liftPredicate(fellBack, Boolean)),
      classifier: spent.at(-1)?.model,
      costUsd: Option.getOrUndefined(routeCost(spent)),
    }),
  })
  return Option.some<TurnRoute>({ event, recorded: false, effort: effortPick })
})

/**
 * The effort router's part of a model route's input: each effort choice
 * with a model of the route's choices it runs on (`admitEfforts` on that
 * model). None where no choice runs on any of them.
 */
const combinedEffortInput = Effect.fn("TurnHelpers.combinedEffortInput")(function* (params: {
  readonly sessionId: SessionId
  readonly resolved: ResolvedTurnContext
  readonly combined: CombinedEffort
  readonly models: ReadonlyArray<Model>
}) {
  const choices = params.combined.served.model.choices
  const distinct = [...new Map(params.models.map((model) => [model.id, model])).values()]
  const admitted = yield* Effect.forEach(distinct, (model) =>
    admitEfforts({
      sessionId: params.sessionId,
      turn: {
        modelId: model.id,
        modelDriver: effectiveModelDriver(params.resolved.driverRef, model.id),
      },
      messages: params.resolved.messages,
      child: params.resolved.child,
      choices,
      log: params.combined.log,
    }),
  )
  const admissions = admitted.flatMap(Option.toArray)
  const candidates = choices.map((_, index) =>
    Option.firstSomeOf(
      admissions.map((admission) =>
        Option.flatten(Option.fromUndefinedOr(admission.candidates[index])),
      ),
    ),
  )
  return Option.liftPredicate({ model: params.combined.served.model, candidates }, () =>
    candidates.some(Option.isSome),
  )
})

// ── effort-routing ──────────────────────────────────────────────────────────

/*
 * `/effort auto` (`Session.reasoningAuto`) asks the effort router
 * (`ModelRouterContribution.effort`) for the level of each user turn, once,
 * before the turn's first request, on the model the turn runs on (a model
 * route first, where the session is on a virtual model). Its pick wins over
 * a model route's choice: auto is the session's own setting. A `ModelRouted`
 * with `effortOnly` records the pick. Once that receipt is stored, every
 * later step, a replay and a recovered turn run at it and charge it, whether
 * or not a router serves then, and nothing asks again. A process that stops
 * after the classifier answered and before the receipt was stored leaves no
 * receipt: the recovered turn asks again, and the first call's cost is not
 * recorded. A spawned child keeps its own effort and is never routed.
 *
 * The model's metadata (the levels it takes, its cache lifetime) is the
 * catalog entry of the model the turn dispatches to
 * (`modelDriver.contextModelId`, after a driver override); the receipts name
 * the model the session asked for.
 *
 * Decided by the cache-rate north star: a level change that the driver does
 * not carry inside the conversation goes at the top of the request and
 * rewrites the whole cached prefix. On a warm cache a choice is offered only
 * where its level is the one the cache was written at or the driver carries
 * the change from this history (`ModelResolver.carriesEffort`, the driver's
 * `carriesEffort`); with no other choice the turn keeps its level, the router
 * is not asked, and the receipt says why. A cold cache is written again
 * anyway: there every level the model takes is offered. A router that fails
 * keeps the exact level the branch runs at.
 *
 * Decided by the cost north star: where the router of the session's virtual
 * model serves the effort router too, the model route's call carries the
 * effort choices (`combinedEffortRoute`, `ModelRouteInput.effort`), and one
 * classifier call picks both. The effort receipt then names no classifier
 * and no cost: the model route's receipt holds the one charge. A failed
 * combined call is not repeated; a router that answers no effort leaves the
 * effort router to be asked alone.
 */

/** What the effort route reads from the branch's log. */
interface EffortRoutingLog {
  /** The branch's newest effort route. */
  readonly routed: Option.Option<ModelRouted>
  readonly lastCallModel: Option.Option<ModelIdType>
  readonly lastCallAtMillis: Option.Option<number>
  readonly measure: Option.Option<StepMeasure>
  /** The newest step's receipt: its model, and the effort its request was sent at. */
  readonly lastEffort: Option.Option<StepEffort>
  /** Each step's receipt, by the id of the assistant message it wrote. */
  readonly stepEfforts: ReadonlyMap<string, StepEffort>
}

/** An effort route's pick: the choice, its level (none: no level named), and why. */
interface EffortDecision {
  readonly choice: Option.Option<number>
  readonly effort: Option.Option<ReasoningEffort>
  readonly reason: string
  readonly fellBack: boolean
}

/** The model a turn runs on: as the session asked for it, and as it dispatches. */
interface EffortTurnModel {
  readonly modelId: ModelIdType
  readonly modelDriver: EffectiveModelDriver
}

/** The effort choices a turn on one model may take, and the level its cache holds. */
interface EffortAdmission {
  /** The catalog entry of the model the turn dispatches to. */
  readonly model: Model
  /**
   * Aligned with the router's choices: the model, for a choice whose level
   * the model takes as it is and, on a warm cache, that keeps the cache.
   */
  readonly candidates: ReadonlyArray<Option.Option<Model>>
  readonly warm: boolean
  /** The level the branch's last request on this model went out at. */
  readonly held: Option.Option<RunEffort>
}

/**
 * Which of `choices` a turn on `turn` may take. None where the turn routes
 * no effort: a model the catalog does not list, one that does not reason,
 * or one that takes none of the levels.
 */
const admitEfforts = Effect.fn("TurnHelpers.admitEfforts")(function* (params: {
  readonly sessionId: SessionId
  readonly turn: EffortTurnModel
  readonly messages: ReadonlyArray<Message>
  readonly child: boolean
  readonly choices: ReadonlyArray<VirtualModelChoice>
  readonly log: EffortRoutingLog
}) {
  const { turn, log } = params
  const listed = yield* (yield* ModelRegistry).get(turn.modelDriver.contextModelId).pipe(
    Effect.map(Option.filter((model) => Predicate.isUndefined(model.kind))),
    Effect.catchEager(() => Effect.succeedNone),
  )
  const reasons = Option.filter(listed, (model) => model.reasoning !== false)
  if (Option.isNone(reasons)) return Option.none<EffortAdmission>()
  const model = reasons.value
  // A choice runs on the model at a level the model takes as it is.
  const accepted = params.choices.map((choice) =>
    Option.filter(Option.fromUndefinedOr(choice.effort), (level) =>
      Option.contains(effectiveEffort(model, level), level),
    ),
  )
  if (!accepted.some(Option.isSome)) return Option.none<EffortAdmission>()
  const now = yield* Clock.currentTimeMillis
  // A cache belongs to the model of the last request; one with no lifetime never goes cold.
  const warm =
    Option.contains(log.lastCallModel, turn.modelId) &&
    Option.exists(log.lastCallAtMillis, (at) =>
      Option.match(promptCacheTtlMsFor(model, params.child), {
        onNone: () => true,
        onSome: (ttlMs) => now < at + ttlMs,
      }),
    )
  const held = Option.flatMap(
    Option.filter(log.lastEffort, (receipt) => receipt.model === turn.modelId),
    (receipt) => receipt.level,
  )
  if (!warm || Option.isNone(held)) {
    return Option.some<EffortAdmission>({
      model,
      candidates: accepted.map(Option.as(model)),
      warm,
      held,
    })
  }
  // Warm: a change of level must ride inside the conversation, from the
  // efforts its earlier runs were sent at.
  const reasoningHistory = assistantRunEfforts(params.messages, (message) =>
    Option.fromUndefinedOr(log.stepEfforts.get(message.id)).pipe(
      Option.filter((receipt) => receipt.model === turn.modelId),
      Option.flatMap((receipt) => receipt.level),
    ),
  )
  const resolver = yield* ModelResolver
  const registry = yield* ExtensionRegistry
  const keepsCache = (level: ReasoningEffort) => {
    if (Option.contains(held, level)) return Effect.succeed(true)
    return resolver.carriesEffort(
      {
        modelId: turn.modelId,
        hints: {
          reasoning: level,
          reasoningHistory,
          cacheKey: params.sessionId,
          child: params.child,
          ...omitUndefined({ supportsReasoning: model.reasoning }),
        },
        ...omitUndefined({ driverId: Option.getOrUndefined(turn.modelDriver.driverId) }),
      },
      registry,
    )
  }
  const candidates = yield* Effect.forEach(accepted, (level) =>
    Option.match(level, {
      onNone: () => Effect.succeedNone,
      onSome: (value) =>
        Effect.map(keepsCache(value), (keeps) => Option.liftPredicate(model, () => keeps)),
    }),
  )
  return Option.some<EffortAdmission>({ model, candidates, warm, held })
})

/**
 * The model route's call, where it carried the effort router: its effort
 * pick, or why the call failed (no second call is made). None: ask the
 * effort router alone.
 */
type DecidedEffort = Option.Option<Result.Result<ModelRouteChoice, string>>

/**
 * Route the effort of one turn. None where the turn routes no effort: a
 * spawned child, a later step (auto set mid-turn: the turn keeps its first
 * step's level), a model the catalog does not list or that does not reason,
 * or one that takes none of the router's levels.
 */
const routeEffort = Effect.fn("TurnHelpers.routeEffort")(function* (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
  readonly step: number
  readonly resolved: ResolvedTurnContext
  readonly served: ServedVirtualModel
  readonly log: EffortRoutingLog
  readonly decided: DecidedEffort
}) {
  const { resolved, served, log } = params
  if (resolved.child || params.step > 1) return Option.none<ModelRouted>()
  const startedAt = yield* Clock.currentTimeMillis
  const admission = yield* admitEfforts({
    sessionId: params.sessionId,
    turn: resolved,
    messages: resolved.messages,
    child: resolved.child,
    choices: served.model.choices,
    log,
  })
  if (Option.isNone(admission)) return Option.none<ModelRouted>()
  const { model, candidates, warm, held } = admission.value
  const choices = served.model.choices
  const levelAt = (index: number) => Option.fromUndefinedOr(choices[index]?.effort)
  const runnable = (index: number) =>
    Option.isSome(Option.flatten(Option.fromUndefinedOr(candidates[index])))
  const indexes = choices.map((_, index) => index)
  const choiceAt = (level: RunEffort) =>
    Option.fromUndefinedOr(
      indexes.find((index) => runnable(index) && Option.contains(levelAt(index), level)),
    )
  // The level the branch runs at, kept exactly as it was sent, a level no
  // choice names included: a request that named none names none.
  const keep = (level: RunEffort, reason: string, fellBack: boolean): EffortDecision => ({
    choice: choiceAt(level),
    effort: Option.filter(Option.some(level), isReasoningEffort),
    reason,
    fellBack,
  })
  // With a level held, that level; else the default choice, else the first that runs.
  const fallback = (reason: string): EffortDecision =>
    Option.match(held, {
      onSome: (level) => keep(level, reason, true),
      onNone: () => {
        const index = Option.liftPredicate(served.model.fallback, runnable).pipe(
          Option.orElse(() => Option.fromUndefinedOr(indexes.find(runnable))),
        )
        return {
          choice: index,
          effort: Option.flatMap(index, levelAt),
          reason,
          fellBack: true,
        }
      },
    })
  // The choices that would change the level the cache was written at.
  const changes = indexes.filter(
    (index) =>
      runnable(index) && !Option.exists(held, (level) => Option.contains(levelAt(index), level)),
  )
  const heldLevel = Option.getOrElse(held, (): RunEffort => "default")

  let spent: ReadonlyArray<RouteCall> = []
  let decision: EffortDecision
  if (!endsOnInput(resolved.messages)) {
    decision = Option.match(held, {
      onNone: () => fallback("the conversation ends on an assistant message"),
      onSome: (level) =>
        keep(
          level,
          "the conversation ends on an assistant message, so the turn keeps its effort",
          false,
        ),
    })
  } else if (warm && Option.isSome(held) && changes.length === 0) {
    decision = keep(
      heldLevel,
      `the cache is warm and the driver carries no change from ${heldLevel} on this history, which would rewrite the cache: the turn keeps its effort`,
      false,
    )
  } else if (Option.isSome(params.decided) && Result.isFailure(params.decided.value)) {
    decision = fallback(params.decided.value.failure)
  } else if (Option.isSome(params.decided) && Result.isSuccess(params.decided.value)) {
    const pick = params.decided.value.success
    if (Number.isInteger(pick.choice) && runnable(pick.choice)) {
      decision = {
        choice: Option.some(pick.choice),
        effort: levelAt(pick.choice),
        reason: pick.reason,
        fellBack: false,
      }
    } else {
      decision = fallback(
        `the router picked effort choice ${pick.choice}, which ${model.id} does not take here`,
      )
    }
  } else if (!indexes.some(runnable)) {
    decision = fallback(`no effort choice keeps the cache of ${model.id}`)
  } else {
    const current = Option.map(log.lastCallModel, (): ModelRouteCurrent => ({
      model,
      warm,
      historyTokens: estimateHistoryTokens(resolved.messages, log.measure, model),
    }))
    const asked = yield* askRouter(served.router, {
      model: served.model,
      messages: resolved.messages,
      candidates,
      current,
      child: resolved.child,
    })
    spent = asked.calls
    const picked = asked.picked
    if (Result.isFailure(picked)) {
      yield* Effect.logWarning("turn.effort-route-fell-back").pipe(
        Effect.annotateLogs({ model: model.id, reason: picked.failure }),
      )
      decision = fallback(picked.failure)
    } else if (!Number.isInteger(picked.success.choice) || !runnable(picked.success.choice)) {
      decision = fallback(
        `the router picked choice ${picked.success.choice}, which ${model.id} does not take here`,
      )
    } else {
      decision = {
        choice: Option.some(picked.success.choice),
        effort: levelAt(picked.success.choice),
        reason: picked.success.reason,
        fellBack: false,
      }
    }
  }

  const event = ModelRouted.make({
    sessionId: params.sessionId,
    branchId: params.branchId,
    messageId: params.messageId,
    selected: ModelId.make(`${served.router.id}/${served.model.name}`),
    model: resolved.modelId,
    reason: decision.reason.slice(0, ROUTE_REASON_CHARS),
    durationMs: (yield* Clock.currentTimeMillis) - startedAt,
    effortOnly: true,
    ...omitUndefined({
      choice: Option.getOrUndefined(decision.choice),
      effort: Option.getOrUndefined(decision.effort),
      fallback: Option.getOrUndefined(Option.liftPredicate(decision.fellBack, Boolean)),
      classifier: spent.at(-1)?.model,
      costUsd: Option.getOrUndefined(routeCost(spent)),
    }),
  })
  return Option.some(event)
})

/**
 * The effort part of a model route's call: on `/effort auto`, at a turn's
 * first step with no effort route stored, where the router that serves the
 * virtual model serves the effort router too.
 */
const combinedEffortRoute = (params: {
  readonly resolved: ResolvedTurnContext
  readonly step: number
  readonly messageId: MessageId
  readonly routedModel: ServedVirtualModel
  readonly effortRouter: Option.Option<Result.Result<ServedVirtualModel, string>>
  readonly log: EffortRoutingLog
}): Option.Option<CombinedEffort> => {
  const stored = Option.exists(params.log.routed, (event) => event.messageId === params.messageId)
  if (!params.resolved.effortAuto || params.step > 1 || stored) return Option.none()
  return params.effortRouter.pipe(
    Option.flatMap(Result.getSuccess),
    Option.filter((served) => served.router.id === params.routedModel.router.id),
    Option.map((served): CombinedEffort => ({ served, log: params.log })),
  )
}

/** The turn at its effort route's level; a route that names none sends no level. */
const applyEffortRoute = (
  resolved: ResolvedTurnContext,
  route: ModelRouted,
): ResolvedTurnContext => {
  const { reasoning: _set, ...unnamed } = resolved
  return Option.match(Option.fromUndefinedOr(route.effort), {
    onNone: () => unnamed,
    onSome: (level) => ({ ...unnamed, reasoning: level }),
  })
}

/**
 * A step of a turn on `/effort auto`, at the level its effort route picks:
 * published once, charged once per turn. A stored route of the turn wins
 * before any router is read: a recovered turn runs at it and charges it
 * though its router is gone. A router that cannot serve is a catalog
 * failure; the turn runs at the level it would without auto.
 */
const atAutoEffort = Effect.fn("TurnHelpers.atAutoEffort")(function* (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
  readonly step: number
  readonly resolved: ResolvedTurnContext
  readonly ledger: Pick<TurnLedger, "noteRoute">
  readonly log: EffortRoutingLog
  readonly decided: DecidedEffort
}) {
  const recorded = Option.filter(params.log.routed, (event) => event.messageId === params.messageId)
  if (Option.isSome(recorded)) {
    yield* params.ledger.noteRoute(recorded.value)
    return applyEffortRoute(params.resolved, recorded.value)
  }
  const served = servedEffortRouter((yield* ExtensionRegistry).getResolved())
  if (Option.isNone(served)) return params.resolved
  if (Result.isFailure(served.value)) {
    if (params.step <= 1)
      yield* Effect.logWarning("turn.effort-router-refused").pipe(
        Effect.annotateLogs({ reason: served.value.failure }),
      )
    return params.resolved
  }
  const route = yield* routeEffort({ ...params, served: served.value.success })
  if (Option.isNone(route)) return params.resolved
  yield* publishEventOrDie(route.value)
  yield* params.ledger.noteRoute(route.value)
  return applyEffortRoute(params.resolved, route.value)
})

// ── turn-source ─────────────────────────────────────────────────────────────

/**
 * Where a turn's parts come from: the model stream.
 *
 * `resolveTurnSource` projects the model context, applies the pending
 * context directive, and hands back a stream plus the collector that turns
 * it into a persisted response.
 */

const toolCallsFromResponseParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): ReadonlyArray<Prompt.ToolCallPart> =>
  parts.flatMap((part): ReadonlyArray<Prompt.ToolCallPart> => {
    if (part.type === "tool-call") {
      return [
        Prompt.toolCallPart({
          id: part.id,
          name: part.name,
          params: part.params,
          providerExecuted: part.providerExecuted,
        }),
      ]
    }
    return []
  })

/** What a step's receipt (`StreamEnded`) says its request sent: the model, and the effort. */
interface StepEffort {
  readonly model: ModelIdType
  readonly level: Option.Option<RunEffort>
}

/**
 * The turn at the effort its first step was sent at. A level set while the
 * turn runs takes effect at the next turn, as an effort marker does
 * (Anthropic applies one from the next user turn, and a step after a tool
 * result has none before it), so each step's receipt names the level the
 * provider applies. A first step sent at the model's default sends no level
 * after it either. A first step on another model, or one whose receipt is
 * unknown, leaves the level as set.
 */
const atTurnEffort = (
  resolved: ResolvedTurnContext,
  firstStep: Option.Option<StepEffort>,
): ResolvedTurnContext =>
  Option.match(
    Option.flatMap(
      Option.filter(firstStep, (receipt) => receipt.model === resolved.modelId),
      (receipt) => receipt.level,
    ),
    {
      onNone: () => resolved,
      onSome: (level) => {
        const { reasoning: _set, ...unnamed } = resolved
        if (level === "default") return unnamed
        return { ...unnamed, reasoning: level }
      },
    },
  )

type ModelTurnSource = {
  /** The compaction summary written for this step, and its price when its model has one. */
  readonly compaction: Option.Option<{ readonly costUsd: Option.Option<number> }>
  /** The chars/4 estimate of the system prompt, notices and tools this request carries. */
  readonly overheadTokens: number
  /**
   * The effort this request sends (`effectiveEffort`); `"default"` when it
   * names no level to a model that reasons, none when the model does not.
   */
  readonly reasoningLevel: Option.Option<RunEffort>
  readonly stream: Stream.Stream<Response.AnyPart, ProviderError>
  readonly collect: <R>(
    effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
  ) => Effect.Effect<CollectedTurnResponse, ProviderAuthError, R | EventStore>
}

const resolveTurnSource = Effect.fn("TurnHelpers.resolveTurnSource")(function* (params: {
  messageId: MessageId
  step: number
  /**
   * The last step this turn may run. The model keeps its tool definitions —
   * dropping them would invalidate the provider's cached prefix — but is told
   * it may not call one, so the step produces the turn's answer.
   */
  finalStep: boolean
  resolved: ResolvedTurnContext
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  /** What the provider reported the branch's last settled step took. */
  measure: Option.Option<StepMeasure>
  /** When the branch's last model request went out, in epoch milliseconds. */
  lastCallAtMillis: Option.Option<number>
  /** The model the branch's last model request ran on. */
  lastCallModel: Option.Option<ModelIdType>
  /** The branch's step receipts, by the id of the assistant message each step wrote. */
  stepEfforts: ReadonlyMap<string, StepEffort>
  /**
   * The provider refused this turn's last request as too long: this step
   * hands the window off first, and a second refusal ends the turn.
   */
  overflowed: boolean
}) {
  const extensionRegistry = yield* ExtensionRegistry
  const { resolved } = params
  const operations = yield* SessionOperationStorage
  // None: the agent sets no ceiling. Some(false): the turn spent it.
  const reserveAttempt = Option.match(Option.fromUndefinedOr(resolved.agent.maxModelAttempts), {
    onNone: () => Effect.succeedNone,
    onSome: (max) =>
      operations
        .reserveModelAttempt({
          sessionId: params.sessionId,
          branchId: params.branchId,
          messageId: params.messageId,
          max,
        })
        .pipe(
          Effect.asSome,
          Effect.mapError(
            (cause) =>
              new ProviderError({
                message: "Cannot reserve model attempt",
                model: resolved.modelId,
                cause,
              }),
          ),
        ),
  })
  const modelResolver = yield* ModelResolver
  const resolveAdmittedModel = Effect.fn("TurnHelpers.resolveAdmittedModel")(function* (
    request: ResolveModelRequest,
  ) {
    const admission = yield* reserveAttempt
    if (Option.isSome(admission) && !admission.value) {
      return yield* new ProviderError({
        message: "Model-attempt budget exhausted",
        model: resolved.modelId,
      })
    }
    return yield* modelResolver
      .resolve(request)
      .pipe(Effect.provideService(ExtensionRegistry, extensionRegistry))
  })
  const { driverId, contextModelId } = resolved.modelDriver
  const retryPolicy = yield* driverRetryPolicy(driverId)

  const modelRegistry = yield* ModelRegistry
  const modelOption = yield* modelRegistry.get(contextModelId)
  if (Option.isNone(modelOption)) {
    return yield* new ModelContextCapabilityError({
      failure: ModelContextCapabilityFailure.cases.UnknownModel.make({
        modelId: contextModelId,
      }),
    })
  }
  // Every chat turn passes here before its driver resolves a model, whichever
  // agent, config or override named it; a classifier's window changes nothing.
  if (modelOption.value.kind === "classifier") {
    return yield* new ModelContextCapabilityError({
      failure: ModelContextCapabilityFailure.cases.ClassifierModel.make({
        modelId: contextModelId,
      }),
    })
  }
  // The agent's own window wins over the catalog: config or a run override can shrink it.
  const contextLimit = Option.getOrUndefined(
    Option.orElse(Option.fromUndefinedOr(resolved.agent.contextLength), () =>
      Option.fromUndefinedOr(modelOption.value.contextLength),
    ),
  )
  if (Predicate.isUndefined(contextLimit)) {
    return yield* new ModelContextCapabilityError({
      failure: ModelContextCapabilityFailure.cases.MissingContextLimit.make({
        modelId: contextModelId,
      }),
    })
  }
  if (!Number.isSafeInteger(contextLimit) || contextLimit <= 0) {
    return yield* new ModelContextCapabilityError({
      failure: ModelContextCapabilityFailure.cases.InvalidContextLimit.make({
        modelId: contextModelId,
        reason: "contextLength must be a positive safe integer",
      }),
    })
  }
  // A model whose catalog entry names no cache lifetime never goes cold. A
  // cache belongs to the model that wrote it: a turn on another model than
  // the last request reads no cache either way, and handing its window off
  // for that would surprise the reader who only switched models.
  const sameModel = Option.contains(params.lastCallModel, params.resolved.modelId)
  const promptCache = Option.map(
    Option.all([
      Option.filter(params.lastCallAtMillis, () => sameModel),
      promptCacheTtlMsFor(modelOption.value, resolved.child),
    ]),
    ([lastCallAtMillis, ttlMs]): PromptCache => ({
      lastCallAtMillis,
      ttlMs,
      pricing: Option.fromUndefinedOr(modelOption.value.pricing),
    }),
  )
  // The catalog's input cap binds whatever window the agent names: a provider
  // refuses input past it however large the window is.
  const inputLimit = Option.fromUndefinedOr(modelOption.value.inputLimit).pipe(
    Option.filter(isTokenLimit),
  )
  const reservedOutputTokens = outputReserveTokens({
    contextLimitTokens: contextLimit,
    outputLimitTokens: Option.fromUndefinedOr(modelOption.value.outputLimit),
  })
  const budget = ModelContextBudget.make({
    contextLimitTokens: contextLimit,
    ...omitUndefined({
      inputLimitTokens: Option.getOrUndefined(inputLimit),
      imageCost: modelOption.value.imageCost,
    }),
    reservedSystemTokens:
      resolved.systemPrompt.reduce((sum, block) => sum + estimateTextTokens(block), 0) +
      Option.match(turnNoticesText(requestNotices(resolved)), {
        onNone: () => 0,
        onSome: estimateTextTokens,
      }),
    reservedToolTokens: estimateToolSchemaTokens(resolved.tools),
    reservedOutputTokens,
  })
  const turnHints = {
    temperature: resolved.temperature,
    reasoning: resolved.reasoning,
    // The driver reads the catalog's word on reasoning, not the model name.
    child: resolved.child,
    supportsReasoning: modelOption.value.reasoning,
    // The request asks for no more output than the budget keeps free, so
    // input within the budget plus the reply never passes the window.
    maxTokens: reservedOutputTokens,
  } satisfies ProviderHints
  // The receipt names what the driver sends: the same levels, the same clamp.
  // A request that names no level to a model the catalog says reasons runs
  // at the model's default, which is not an unknown level.
  const reasoningLevel: Option.Option<RunEffort> = Option.match(
    Option.fromUndefinedOr(resolved.reasoning),
    {
      onNone: () =>
        Option.some<RunEffort>("default").pipe(
          Option.filter(() => modelOption.value.reasoning === true),
        ),
      onSome: (level) => effectiveEffort(modelOption.value, level),
    },
  )
  const modelRequest: ResolveModelRequest = {
    modelId: resolved.modelId,
    // The session is the cache key: the next step reads this step's prefix.
    hints: { ...turnHints, cacheKey: params.sessionId },
    driverId: Option.getOrUndefined(driverId),
  }
  const eventStore = yield* EventStore
  // Summaries and window markers persist the same way every durable message
  // does: once, with a delivered event.
  const persistDurableMessage = (message: Message) => persistMessageReceived({ message })
  // The model can ask, from inside a dispatching tool, for a fresh window or a
  // focused summary. A branch with no such tool has no ledger and no
  // directives, so the read falls back to an inert one.
  const ledger = Option.getOrElse(
    yield* Effect.serviceOption(ModelContextLedger),
    () => ModelContextLedger.inert,
  )
  // A directive belongs to the turn whose tool call scheduled it: the first
  // projection of a new turn drops whatever an earlier turn left behind.
  if (params.step <= 1) yield* ledger.discardDirective
  const directive = yield* ledger.pendingDirective
  // Set once a summary model is admitted: from then on its call may spend
  // tokens whether or not a summary comes back.
  const summaryAdmitted = yield* Ref.make(false)
  const hostCtx = yield* CurrentExtensionHostContext
  const { durableMessages, compacted, summary } = yield* projectContextWindow({
    sessionId: params.sessionId,
    branchId: params.branchId,
    modelId: contextModelId,
    agentName: resolved.agent.name,
    messages: resolved.messages,
    budget,
    measure: params.measure,
    overflowed: params.overflowed,
    directive,
    turnStart: params.step <= 1,
    promptCache,
    persist: persistDurableMessage,
    // The summary is plain text under a small output cap. Reasoning tokens
    // count against that cap on some providers, so the summary asks for none
    // and never inherits the turn's effort. Its prompt is unique, so it names
    // no cache key: nothing would read its cache entry back.
    summaryModel: (maxTokens) =>
      resolveAdmittedModel({
        ...modelRequest,
        hints: { ...turnHints, maxTokens, reasoning: "none" },
      }).pipe(Effect.tap(() => Ref.set(summaryAdmitted, true))),
  }).pipe(
    // The compactor runs with the context a tool call on this branch gets:
    // the session's cwd and facets, and the agent whose window it compacts.
    // An installed compactor runs as its owner's leaf (`ownedCompactor` in
    // `extension-host.ts`); this frame serves one provided with no owner.
    provideExtensionLeaf({}),
    provideCurrentHostCtx({ ...hostCtx, agentName: resolved.agent.name }),
  )

  // A summary is priced by the model its receipt names, as a step is by its
  // own. A summary that failed after its model was admitted has no receipt,
  // so its spend is unknown: the turn's cost is then absent, never partial.
  const compaction = yield* Option.match(summary, {
    onNone: () =>
      Ref.get(summaryAdmitted).pipe(
        Effect.map((admitted) =>
          Option.liftPredicate({ costUsd: Option.none<number>() }, () => admitted),
        ),
      ),
    onSome: (value) =>
      computeStreamEndedCost({
        modelId: value.modelId,
        usage: Option.fromUndefinedOr(value.usage),
      }).pipe(Effect.map((costUsd) => Option.some({ costUsd }))),
  })
  const compactionCostUsd = Option.flatMap(compaction, (value) => value.costUsd)

  const finalWindow = messagesInCurrentWindow(durableMessages)
  const projection = yield* projectCurrentWindow({
    modelId: contextModelId,
    messages: durableMessages,
    budget,
    measure: params.measure,
  })
  const handoffMessageId = Option.getOrUndefined(currentHandoffId(finalWindow))
  yield* ledger.recordProjection({
    estimatedTokens: projection.estimatedTokens,
    availableInputTokens: projection.availableInputTokens,
    contextLimitTokens: contextLimit,
    omittedMessages: projection.omittedMessageIds.length,
    handoffMessageId,
  })
  // Acknowledged only after the projection it shaped succeeded, so a failed
  // projection retries it and a successful one applies it exactly once.
  if (Option.isSome(directive)) yield* ledger.acknowledgeDirective(directive.value)
  yield* eventStore.publish(
    ModelContextProjected.make({
      sessionId: params.sessionId,
      branchId: params.branchId,
      estimatedTokens: projection.estimatedTokens,
      availableInputTokens: projection.availableInputTokens,
      contextLimitTokens: contextLimit,
      omittedMessages: projection.omittedMessageIds.length,
      handoffMessageId,
      compacted,
      costUsd: Option.getOrUndefined(compactionCostUsd),
    }),
  )
  // The provider sees each tool under its wire name, in the declarations and
  // in the conversation's calls; the reply's parts name the tool ids again.
  // Each tool image goes after its result, from the blob store: the stored
  // result holds only its reference.
  const toolImages = yield* toolImagePrompt({
    messages: projection.messages,
    model: modelOption.value,
    directory: yield* toolImageDirectory((yield* RuntimeEnvironment).home),
  })
  const prompt = toWirePrompt(
    toPrompt(projection.messages, {
      systemPrompt: resolved.systemPrompt,
      notices: requestNotices(resolved),
      toolImages,
    }),
  )
  // The effort each assistant run of this prompt was sent at, by its
  // receipt. A receipt of another model says nothing about this one.
  const reasoningHistory = assistantRunEfforts(projection.messages, (message) =>
    Option.fromUndefinedOr(params.stepEfforts.get(message.id)).pipe(
      Option.filter((receipt) => receipt.model === resolved.modelId),
      Option.flatMap((receipt) => receipt.level),
    ),
  )
  const stepRequest: ResolveModelRequest = {
    ...modelRequest,
    hints: { ...modelRequest.hints, reasoningHistory },
  }
  const wireStream = Stream.unwrap(
    resolveAdmittedModel(stepRequest).pipe(
      Effect.map((model) => {
        if (resolved.tools.length > 0) {
          if (params.finalStep) {
            return model.streamText({
              prompt,
              toolkit: convertTools([...resolved.tools]),
              toolChoice: "none",
              disableToolCallResolution: true,
            })
          }
          // The reply decodes against every tool the profile registers;
          // `oneOf` keeps the request's declarations to the advertised ones,
          // in their order, so the request is the same bytes.
          return model.streamText({
            prompt,
            toolkit: convertTools([...resolved.replyTools]),
            toolChoice: { oneOf: resolved.tools.map((tool) => wireToolName(getToolId(tool))) },
            disableToolCallResolution: true,
          })
        }
        return model.streamText({ prompt })
      }),
    ),
  )
  const rawStream = wireStream.pipe(Stream.map(fromWireToolPart))
  // The raw stop reason the driver reports for this attempt's stream
  // (`ProviderStopReason`); a retried attempt starts with none.
  const stopReason = yield* Ref.make(Option.none<string>())
  const reportedStream = Stream.unwrap(
    Ref.set(stopReason, Option.none()).pipe(Effect.as(rawStream)),
  ).pipe(
    Stream.provideService(
      ProviderStopReason,
      ProviderStopReason.of({ report: (reason) => Ref.set(stopReason, Option.some(reason)) }),
    ),
  )
  /**
   * A settled reply the provider stopped because the window filled is cut
   * (`windowFull`). It hands the window off as a refusal does, once per
   * refusal and never on the last step of the budget.
   */
  const withStopReason = (collected: CollectedTurnResponse) =>
    Effect.gen(function* () {
      if (collected.streamFailed || collected.interrupted) return collected
      const windowFull = Option.exists(yield* Ref.get(stopReason), isWindowFullStopReason)
      if (!windowFull) return collected
      const contextOverflow = !params.overflowed && !params.finalStep
      if (contextOverflow) {
        yield* publishEventOrDie(
          ErrorOccurred.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            error: CONTEXT_WINDOW_FULL_RECOVERY,
            notice: true,
          }),
        )
      }
      return { ...collected, windowFull, contextOverflow }
    })

  return {
    compaction,
    overheadTokens: budget.reservedSystemTokens + budget.reservedToolTokens,
    reasoningLevel,
    stream: reportedStream.pipe(
      Stream.mapError(
        // oxlint-disable-next-line effect/noUnknownParameters -- Model streams expose provider-specific error values.
        (error: unknown) =>
          new ProviderError({
            // A credential failure the driver attached reads as its own message, not SDK text.
            message: Option.getOrElse(credentialFailureMessage(error), () => causeMessage(error)),
            model: resolved.modelId,
            cause: error,
          }),
      ),
    ),
    collect: <R>(
      effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
    ) =>
      // `ProviderAuthError` is a fail-closed credential-absence signal —
      // not retryable, not recoverable mid-turn. Let it escape so the RPC
      // seam surfaces the typed auth failure; narrow the retry scope to
      // transient `ProviderError` only.
      effect.pipe(
        retryProviderCall(retryPolicy, {
          // A cancel during a backoff ends the wait; the failure it leaves
          // reads as an interrupted step below.
          stop: Deferred.await(params.activeStream.interrupted),
          onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
            publishEventOrDie(
              ProviderRetrying.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                attempt,
                maxAttempts,
                delayMs,
                error: retryReason(error),
              }),
            ),
        }),
        Effect.catchTag("ProviderError", (streamError) =>
          Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
            collectFailedModelTurnResponse({
              messageId: params.messageId,
              step: params.step,
              streamError,
              sessionId: params.sessionId,
              branchId: params.branchId,
              modelId: resolved.modelId,
              reasoningLevel: Option.getOrUndefined(reasoningLevel),
              activeStream: params.activeStream,
              // One recovery per refusal: a step that already handed off, or the
              // last step of the budget, fails the turn as any failure does.
              contextOverflow:
                !params.overflowed &&
                !params.finalStep &&
                retryPolicy.contextOverflow(streamError.cause),
              refusedAgain: params.overflowed && retryPolicy.contextOverflow(streamError.cause),
              retryAt: limitResetAt(retryPolicy, streamError, nowMs),
            }),
          ),
        ),
        Effect.flatMap(withStopReason),
        Effect.tap((collected) => {
          const usage = Option.getOrElse(
            Option.fromUndefinedOr(collected.messageProjection.usage),
            () => ({ inputTokens: 0, outputTokens: 0 }),
          )
          return WideEvent.set({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
            interrupted: collected.interrupted,
            streamFailed: collected.streamFailed,
          })
        }),
        withWideEvent(
          WideEventBoundary.provider("stream", {
            envelope: { model: resolved.modelId },
          }),
        ),
      ),
  } satisfies ModelTurnSource
})

// Freeze pricing into the StreamEnded event at emit time. Returns None
// when usage is absent or pricing is missing; the reducer treats that as a
// zero contribution. Storing the computed cost on the event makes the
// transcript authoritative: replaying the same events always sums to the
// same cost, even if ModelRegistry pricing later refreshes.
const computeStreamEndedCost: (params: {
  modelId: ModelId
  usage: Option.Option<Parameters<typeof calculateCost>[0]>
}) => Effect.Effect<Option.Option<number>, never, ModelRegistry | ExtensionRegistry> = Effect.fn(
  "TurnHelpers.computeStreamEndedCost",
)(function* (params) {
  if (Option.isNone(params.usage)) return Option.none()
  const modelRegistry = yield* ModelRegistry
  const pricing = yield* modelRegistry.get(params.modelId).pipe(
    Effect.map(Option.flatMap((model) => Option.fromUndefinedOr(model.pricing))),
    Effect.catchEager(() => Effect.succeedNone),
  )
  if (Option.isNone(pricing)) return Option.none()
  return Option.some(calculateCost(params.usage.value, pricing))
})

// ── turn-execution ──────────────────────────────────────────────────────────

/**
 * What one model step produced, classified once from the collected response.
 * Policy (continue, stop, run tools) matches on this; nothing else inspects
 * the response parts, and the tag travels on the step's `StreamEnded` event.
 */
const StepOutcome = Schema.TaggedUnion({
  Interrupted: {},
  /**
   * The stream failed; `partialOutput` says whether observable output was saved
   * first, `contextOverflow` that the provider refused the request as too long
   * and the turn may hand off and retry.
   */
  Failed: { partialOutput: Schema.Boolean, contextOverflow: Schema.Boolean },
  /**
   * The model asked for tools; the response parts carry them.
   * `contextOverflow`: the window filled while it wrote, and the step after
   * the tools hands the window off first.
   */
  ToolCalls: { count: Schema.Int, contextOverflow: Schema.Boolean },
  /**
   * No tool calls: an answer, nothing at all, or output cut off at the output
   * limit or by a full window. `contextOverflow`: the window filled, and the
   * continuation hands the window off first. `blocked`: the provider blocked
   * the reply (a `content-filter` finish, Anthropic's `refusal`); the same
   * window would be blocked again, so no continuation follows.
   */
  Answered: {
    empty: Schema.Boolean,
    truncated: Schema.Boolean,
    contextOverflow: Schema.Boolean,
    blocked: Schema.Boolean,
  },
})
type StepOutcome = Schema.Schema.Type<typeof StepOutcome>

export const classifyStep = (collected: CollectedTurnResponse): StepOutcome => {
  const observable = collected.responseParts.some(isObservableModelOutputPart)
  if (collected.interrupted) return StepOutcome.cases.Interrupted.make({})
  if (collected.streamFailed) {
    return StepOutcome.cases.Failed.make({
      partialOutput: observable,
      contextOverflow: collected.contextOverflow,
    })
  }
  const count = toolCallsFromResponseParts(collected.responseParts).length
  const { contextOverflow } = collected
  if (count > 0) return StepOutcome.cases.ToolCalls.make({ count, contextOverflow })
  // An `"unknown"` finish alone is not a cut: some drivers report it on a
  // normal end. Only the output limit and a full window are.
  return StepOutcome.cases.Answered.make({
    empty: !observable,
    truncated:
      collected.windowFull ||
      collected.responseParts.some((part) => part.type === "finish" && part.reason === "length"),
    contextOverflow,
    blocked: collected.responseParts.some(
      (part) => part.type === "finish" && part.reason === "content-filter",
    ),
  })
}

const PROVIDER_BLOCKED_RESPONSE = "the provider blocked the response"

const MAX_TURN_STEPS = 200
/** Continuation instructions one turn may persist after a failed, empty, or truncated step. */
const MAX_CONTINUATIONS_PER_TURN = 2
const CONTINUATION_INSTRUCTION =
  "Your previous reply was cut off by a provider error after partial output. The partial output is saved above. Continue from where you stopped. Do not repeat text you already wrote."

const EMPTY_RESPONSE_INSTRUCTION =
  "Your previous step returned no text and no tool calls. Answer the request now using the tool results above."

/**
 * What the model is told on the last step its turn is allowed.
 *
 * The step runs with `toolChoice: "none"`, so this is not a request the model
 * can decline by calling one more tool: it is the only move left. Prior art:
 * opencode-v2 does the same at its own ceiling (`runner/llm.ts:221`).
 */
const MAX_STEPS_INSTRUCTION =
  "You have reached the maximum number of steps for this turn, so tools are now disabled. Do not attempt another tool call. Reply with text only: say that the step limit stopped you, summarise what you established, and name what is still unfinished."

const TRUNCATED_RESPONSE_INSTRUCTION =
  "Your previous step was cut off by the output limit or a full context window before it finished. Text it wrote is saved above; a tool call it was writing was discarded. Continue in smaller steps: resume the text where it stopped without repeating it, or make one shorter tool call now and continue after its result."

export const TurnOutcome = Schema.TaggedUnion({
  Done: {},
  InteractionRequested: {
    pendingRequestId: InteractionRequestId,
  },
})
export type TurnOutcome = Schema.Schema.Type<typeof TurnOutcome>

/**
 * A flag a receipt carries only when it happened. A present `false` would read
 * as a receipt that the turn was not interrupted, which historical receipts
 * cannot make, so `false` becomes absent instead.
 */
const flagWhenTrue = (value: boolean): Option.Option<true> => {
  if (value) return Option.some(true)
  return Option.none()
}

/** What the turn loop does after one step. */
const StepResult = Schema.TaggedUnion({
  Continue: { currentTurnAgent: AgentName },
  Stop: {
    currentTurnAgent: AgentName,
    interrupted: Schema.Boolean,
    streamFailed: Schema.Boolean,
    /** The model never produced an answer and no continuation is left. */
    unanswered: Schema.Boolean,
  },
  Interaction: { outcome: TurnOutcome },
  /**
   * The provider refused the request as too long, or the window filled while
   * the model wrote: the next step hands the window off first.
   */
  HandOff: { currentTurnAgent: AgentName },
})
type StepResult = Schema.Schema.Type<typeof StepResult>

/**
 * End the turn after this step. The three flags default to false, so a caller
 * names only the one that happened — and a step that simply finished names
 * none.
 */
const endStep = (
  currentTurnAgent: AgentNameType,
  reason: {
    readonly interrupted?: boolean
    readonly streamFailed?: boolean
    readonly unanswered?: boolean
  },
) =>
  StepResult.cases.Stop.make({
    currentTurnAgent,
    interrupted: reason.interrupted ?? false,
    streamFailed: reason.streamFailed ?? false,
    unanswered: reason.unanswered ?? false,
  })

type AgentLoopTurnExecutionContext = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly resolveTurnProfile: (
    run: RunOpener,
  ) => Effect.Effect<AgentLoopTurnProfile, AgentLoopError, Scope.Scope>
  readonly activeStreamRef: Ref.Ref<Option.Option<ActiveStreamHandle>>
  readonly turnLedger: TurnLedger
  readonly turnInterruption: TurnInterruption
  readonly inbox: LoopInbox
  /** The branch's services a turn's hooks run with; see `AgentLoopBehavior.branchContext`. */
  readonly branchContext: Context.Context<never>
  /**
   * True once the loop stops its turn (a close, or its scope's teardown).
   * Set before the loop interrupts the turn, never by a user's cancel.
   */
  readonly loopStopping: Effect.Effect<boolean>
}

export const makeAgentLoopTurnExecution = (scope: AgentLoopTurnExecutionContext) =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const operations = yield* SessionOperationStorage
    const eventStore = yield* EventStore
    const storageTransaction = yield* makeStorageTransaction
    const configServiceForRun = yield* ConfigService
    const platform = yield* GentPlatform
    const toolBindingStorage = yield* ToolCallBindingStorage
    const turnRecordStorage = yield* TurnRecordStorage
    const processLocalReplay = yield* ProcessLocalToolReplay
    const eventStorage = yield* EventStorage

    /**
     * The model the branch last ran on or was told it continues with: a
     * step's `StreamEnded`, or a model-change notice's announced
     * model, whichever the log holds last. The step boundary compares it with
     * the model the next step resolves; where the settings event sits in the
     * log does not matter. A notice counts because the model reads it on every
     * later step: a step on the new model that breaks, or a resend after an
     * interrupt, does not need the switch announced again.
     *
     * The same read finds the provider's measure of the last settled step:
     * the input on its `StreamEnded` and the overhead that request carried,
     * tied to the reply that step stored. The projection counts the messages
     * before that reply at that size (derived from the log, never kept beside
     * it). A row with no recorded overhead measures nothing.
     *
     * The newest request start says when the branch last called a model: a
     * `StreamStarted`, stored just before the request went out, or a
     * `ProviderRetrying`, whose retry went out `delayMs` after it was stored.
     * The provider refreshes its cache when a request starts, so a turn that
     * starts one lifetime after it may hand a large window off first. The
     * newest `StreamEnded` names the model that request ran on: the cache
     * belongs to it.
     *
     * The cursor only bounds the read to the events since the last one it
     * saw; the values are always re-derived from the log.
     */
    const knownStepModel = ({ event }: EventEnvelope): Option.Option<ModelIdType> => {
      if (event._tag === "StreamEnded") return Option.fromUndefinedOr(event.model)
      if (event._tag === "MessageReceived") return announcedModel(event.message)
      return Option.none()
    }
    const knownStepMeasure = ({ event }: EventEnvelope): Option.Option<StepMeasure> => {
      if (event._tag !== "StreamEnded") return Option.none()
      return Option.all([
        Option.fromUndefinedOr(event.messageId),
        Option.fromUndefinedOr(event.step),
        Option.fromUndefinedOr(event.usage),
        Option.fromUndefinedOr(event.requestOverheadTokens),
      ]).pipe(
        Option.map(([messageId, step, usage, overheadTokens]) => ({
          replyId: stepAddress(messageId, step).assistant,
          inputTokens: usage.inputTokens,
          overheadTokens,
        })),
      )
    }
    const knownRequestStart = ({ event, createdAt }: EventEnvelope): Option.Option<number> => {
      if (event._tag === "StreamStarted") return Option.some(createdAt)
      if (event._tag === "ProviderRetrying") return Option.some(createdAt + event.delayMs)
      return Option.none()
    }
    const knownRequestModel = ({ event }: EventEnvelope): Option.Option<ModelIdType> => {
      if (event._tag !== "StreamEnded") return Option.none()
      return Option.fromUndefinedOr(event.model)
    }
    /** A step's receipt, by the id of the assistant message the step wrote. */
    const knownStepEffort = ({
      event,
    }: EventEnvelope): Option.Option<readonly [string, StepEffort]> => {
      if (event._tag !== "StreamEnded") return Option.none()
      return Option.all([
        Option.fromUndefinedOr(event.messageId),
        Option.fromUndefinedOr(event.step),
        Option.fromUndefinedOr(event.model),
      ]).pipe(
        Option.map(
          ([messageId, step, model]) =>
            [
              stepAddress(messageId, step).assistant,
              {
                model,
                level: Option.orElse(Option.fromUndefinedOr(event.reasoningLevel), () =>
                  Option.some<RunEffort>("default").pipe(
                    Option.filter(() => event.reasoningDefault === true),
                  ),
                ),
              },
            ] as const,
        ),
      )
    }
    /** The receipts with the ones `events` add; a step that ran again keeps its last. */
    const withStepEfforts = (
      known: ReadonlyMap<string, StepEffort>,
      events: ReadonlyArray<EventEnvelope>,
    ): ReadonlyMap<string, StepEffort> => {
      const added = events.flatMap((envelope) => Option.toArray(knownStepEffort(envelope)))
      if (added.length === 0) return known
      return new Map([...known, ...added])
    }
    // The newest `ModelRouted` of each kind holds the route of the turn it
    // names: a later step and a recovered turn run on it rather than route
    // again. A turn has at most a model route and an effort route.
    const knownRoute = ({ event }: EventEnvelope): Option.Option<ModelRouted> => {
      if (event._tag !== "ModelRouted" || event.effortOnly === true) return Option.none()
      return Option.some(event)
    }
    const knownEffortRoute = ({ event }: EventEnvelope): Option.Option<ModelRouted> => {
      if (event._tag !== "ModelRouted" || event.effortOnly !== true) return Option.none()
      return Option.some(event)
    }
    const knownLastEffort = (envelope: EventEnvelope): Option.Option<StepEffort> =>
      Option.map(knownStepEffort(envelope), ([, receipt]) => receipt)
    interface KnownSteps {
      readonly cursor: number
      readonly model: Option.Option<ModelIdType>
      readonly measure: Option.Option<StepMeasure>
      readonly lastCallAtMillis: Option.Option<number>
      readonly lastCallModel: Option.Option<ModelIdType>
      readonly stepEfforts: ReadonlyMap<string, StepEffort>
      readonly lastEffort: Option.Option<StepEffort>
      readonly routed: Option.Option<ModelRouted>
      readonly effortRouted: Option.Option<ModelRouted>
    }
    const unknownSteps = {
      model: Option.none<ModelIdType>(),
      measure: Option.none<StepMeasure>(),
      lastCallAtMillis: Option.none<number>(),
      lastCallModel: Option.none<ModelIdType>(),
      stepEfforts: new Map<string, StepEffort>(),
      lastEffort: Option.none<StepEffort>(),
      routed: Option.none<ModelRouted>(),
      effortRouted: Option.none<ModelRouted>(),
    }
    const lastKnownStep = yield* Ref.make<KnownSteps>({ cursor: 0, ...unknownSteps })
    const newest = <A>(
      events: ReadonlyArray<EventEnvelope>,
      read: (envelope: EventEnvelope) => Option.Option<A>,
      otherwise: Option.Option<A>,
    ): Option.Option<A> => {
      const index = events.findLastIndex((envelope) => Option.isSome(read(envelope)))
      return Option.match(Option.fromUndefinedOr(events[index]), {
        onNone: () => otherwise,
        onSome: read,
      })
    }
    const readKnownSteps = Effect.gen(function* () {
      const known = yield* Ref.get(lastKnownStep)
      const events = yield* eventStorage.listEvents({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        afterId: known.cursor,
      })
      const current: KnownSteps = {
        cursor: Option.match(Option.fromUndefinedOr(events.at(-1)), {
          onNone: () => known.cursor,
          onSome: (envelope) => envelope.id,
        }),
        model: newest(events, knownStepModel, known.model),
        measure: newest(events, knownStepMeasure, known.measure),
        lastCallAtMillis: newest(events, knownRequestStart, known.lastCallAtMillis),
        lastCallModel: newest(events, knownRequestModel, known.lastCallModel),
        stepEfforts: withStepEfforts(known.stepEfforts, events),
        lastEffort: newest(events, knownLastEffort, known.lastEffort),
        routed: newest(events, knownRoute, known.routed),
        effortRouted: newest(events, knownEffortRoute, known.effortRouted),
      }
      yield* Ref.set(lastKnownStep, current)
      return current
    })
    const clearProcessLocalReplayBindings = (assistantMessageId: string) =>
      processLocalReplay.clearBindingsWithPrefix(
        `${scope.sessionId}:${scope.branchId}:${assistantMessageId}:`,
      )
    const clearProcessLocalReplayBindingsForTurn = (messageId: string) =>
      processLocalReplay.clearBindingsWithPrefix(
        `${scope.sessionId}:${scope.branchId}:${messageId}:assistant:`,
      )
    const clearProcessLocalToolResultsForTurn = (messageId: string) =>
      processLocalReplay.clearResultsWithPrefix(
        `${scope.sessionId}:${scope.branchId}:${messageId}:tool-result:`,
      )

    const captureReplayToolBindings = Effect.fn("AgentLoop.captureReplayToolBindings")(
      function* (params: {
        readonly assistantMessageId: RunningState["message"]["id"]
        readonly toolCalls: ReadonlyArray<Prompt.ToolCallPart>
        readonly turnProfile: AgentLoopTurnProfile
      }) {
        const bindings = new Map<string, ResolvedToolCapability>()
        for (const toolCall of params.toolCalls) {
          const entry = yield* resolveReplayToolBinding({
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            assistantMessageId: params.assistantMessageId,
            toolCall,
            generationId: params.turnProfile.turnGenerationId,
          }).pipe(
            Effect.provideService(ToolCallBindingStorage, toolBindingStorage),
            Effect.provideService(ProcessLocalToolReplay, processLocalReplay),
            Effect.provideService(GentPlatform, platform),
          )
          bindings.set(toolCall.name, entry)
        }
        return bindings
      },
    )

    /**
     * The turn's durable position.
     *
     * One row per turn, keyed by the user message that opened it. The row is
     * written at each step boundary, after that step's messages and in its own
     * transaction, so a resumed turn reads one row instead of probing derived
     * message ids. A crash between the two writes leaves the row behind the
     * messages, so every read confirms it against them.
     */
    const turnRecordKey = (messageId: RunningState["message"]["id"]) => ({
      sessionId: scope.sessionId,
      branchId: scope.branchId,
      messageId,
    })

    const readTurnRecord = (messageId: RunningState["message"]["id"]) =>
      turnRecordStorage.get(turnRecordKey(messageId)).pipe(
        // A read failure must not end a turn that can still run: the probe
        // fallback in `resumeTurn` re-derives the position from the messages.
        Effect.catch((cause) =>
          Effect.logWarning("turn.record-read-failed").pipe(
            Effect.annotateLogs({ error: String(cause) }),
            Effect.as(emptyTurnRecord),
          ),
        ),
      )

    /**
     * The turn's only write path: change the fields `change` names and carry
     * the rest forward. A field a writer does not name keeps its value, so a
     * writer never restates a field to keep it, and cannot reset one by leaving
     * it out.
     *
     * `onFailure` says what a storage failure does. `"log"`: the turn goes
     * on, and a read failure writes over the empty record (the probe fallback
     * in `resumeTurn` re-derives a lost position). `"die"`: a change a
     * restart must find, such as the parked marks that decide whether a call
     * runs again; its read or write fails the step as a defect.
     *
     * `base` is the record a caller has already read; without it the current
     * record is read here.
     */
    const writeTurnRecord = (
      messageId: RunningState["message"]["id"],
      change: (current: TurnRecord) => Partial<TurnRecord>,
      options: { readonly onFailure: "log" | "die"; readonly base?: TurnRecord },
    ) => {
      const readBase = Effect.gen(function* () {
        if (Predicate.isNotUndefined(options.base)) return options.base
        if (options.onFailure === "die")
          return yield* turnRecordStorage.get(turnRecordKey(messageId))
        return yield* readTurnRecord(messageId)
      })
      const write = Effect.gen(function* () {
        const current = yield* readBase
        yield* turnRecordStorage.put(turnRecordKey(messageId), { ...current, ...change(current) })
      })
      if (options.onFailure === "die") return write.pipe(Effect.orDie)
      return write.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("turn.record-write-failed").pipe(
            Effect.annotateLogs({ error: String(cause) }),
          ),
        ),
      )
    }

    /** The step opened: its assistant message committed, its calls are pending. */
    const openTurnStep = Effect.fn("AgentLoop.openTurnStep")(function* (params: {
      readonly messageId: RunningState["message"]["id"]
      readonly step: number
      readonly toolCalls: ReadonlyArray<Prompt.ToolCallPart>
    }) {
      const pendingToolCalls: ReadonlyArray<PendingToolCall> = params.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
      }))
      yield* writeTurnRecord(
        params.messageId,
        () => ({ step: params.step - 1, pendingToolCalls }),
        { onFailure: "log" },
      )
    })

    /**
     * Calls of the step parked on an interaction. `parked` names the calls
     * whose run ended at the ask; they run again when the turn resumes. The
     * whole pending list is restated, so a mark never depends on an earlier
     * write. Each call is marked when it parks, while its siblings may still
     * run: an answer given before a restart is taken by the resumed call.
     */
    const markParkedCalls = Effect.fn("AgentLoop.markParkedCalls")(function* (params: {
      readonly messageId: RunningState["message"]["id"]
      readonly toolCalls: ReadonlyArray<Prompt.ToolCallPart>
      readonly parked: ReadonlySet<string>
    }) {
      const pendingToolCalls: ReadonlyArray<PendingToolCall> = params.toolCalls.map((toolCall) => {
        if (!params.parked.has(toolCall.id)) return { id: toolCall.id, name: toolCall.name }
        return { id: toolCall.id, name: toolCall.name, parked: true }
      })
      yield* writeTurnRecord(params.messageId, () => ({ pendingToolCalls }), { onFailure: "die" })
    })

    /**
     * A resumed step is about to run its parked calls again. Their marks go
     * first: a restart during that run finds calls cut short, not parked.
     */
    const clearParkedCalls = (messageId: RunningState["message"]["id"]) =>
      writeTurnRecord(
        messageId,
        (current) => ({
          pendingToolCalls: current.pendingToolCalls.map((call) => ({
            id: call.id,
            name: call.name,
          })),
        }),
        { onFailure: "die" },
      )

    /** The step closed: every message it owns has committed. */
    const closeTurnStep = Effect.fn("AgentLoop.closeTurnStep")(function* (params: {
      readonly messageId: RunningState["message"]["id"]
      readonly step: number
    }) {
      yield* writeTurnRecord(
        params.messageId,
        (current) => ({ step: Math.max(current.step, params.step), pendingToolCalls: [] }),
        { onFailure: "log" },
      )
    })

    /**
     * What one step already knows about its calls, before any tool runs.
     *
     * None when the step's tool message exists: the step is settled, and it
     * is closed here. Otherwise the known results, by precedence: a stored
     * terminal event wins over a recovered result, which wins over a result
     * this process kept. Every path that writes the step's results reads this
     * first, so none of them overwrites a result the step already has.
     */
    const readKnownStepResults = Effect.fn("AgentLoop.readKnownStepResults")(function* (params: {
      readonly messageId: RunningState["message"]["id"]
      readonly step: number
      readonly toolCalls: ReadonlyArray<Prompt.ToolCallPart>
      readonly recoveredResults: ReadonlyArray<Prompt.ToolResultPart>
    }) {
      const address = stepAddress(params.messageId, params.step)
      const resultKey = processLocalReplayResultKey({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        toolResultMessageId: address.toolResult,
      })
      const existing = yield* messageStorage.getMessage(address.toolResult)
      if (!Predicate.isUndefined(existing)) {
        yield* processLocalReplay.removeResults(resultKey)
        yield* closeTurnStep({ messageId: params.messageId, step: params.step })
        return Option.none()
      }

      const persistedResults = yield* findPersistedToolResults({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        assistantMessageId: address.assistant,
        toolCalls: params.toolCalls,
      }).pipe(
        Effect.catchIf(Schema.is(ToolResultReplayError), (error) =>
          Effect.gen(function* () {
            const failureParts = params.toolCalls.map((toolCall) =>
              Prompt.toolResultPart({
                id: toolCall.id,
                name: toolCall.name,
                isFailure: true,
                providerExecuted: false,
                result: {
                  error: error.message,
                  reason: "CorruptResult",
                },
              }),
            )
            yield* recordToolOutcome({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              toolResultMessageId: address.toolResult,
              assistantMessageId: address.assistant,
              parts: failureParts,
            }).pipe(Effect.orDie)
            return yield* error
          }),
        ),
      )
      const localResults = yield* processLocalReplay.getResults(resultKey)
      const knownResults = new Map(localResults)
      for (const result of params.recoveredResults) knownResults.set(result.id, result)
      for (const [toolCallId, result] of persistedResults) {
        knownResults.set(toolCallId, result)
      }
      return Option.some({ resultKey, localResults, knownResults })
    })

    /**
     * Run the step's tool calls and commit their results.
     *
     * Answers with the interaction a tool parked on, if one did: a tool that
     * asks the user is not a failure, so it leaves as a value the step's
     * policy can match rather than as an error every caller must re-catch.
     */
    const executeTools = Effect.fn("AgentLoop.executeTools")(
      function* (params: {
        messageId: RunningState["message"]["id"]
        step: number
        toolCalls: ReadonlyArray<Prompt.ToolCallPart>
        currentTurnAgent: AgentNameType
        toolBindings: ResolvedTurnContext["toolBindings"]
        hostToolBindings: ResolvedTurnContext["toolBindings"]
        recoveredResults?: ReadonlyArray<Prompt.ToolResultPart>
      }) {
        if (params.toolCalls.length === 0) return Option.none<ToolInteractionPending>()

        const address = stepAddress(params.messageId, params.step)
        const known = yield* readKnownStepResults({
          messageId: params.messageId,
          step: params.step,
          toolCalls: params.toolCalls,
          recoveredResults: params.recoveredResults ?? [],
        })
        if (Option.isNone(known)) return Option.none<ToolInteractionPending>()
        const { resultKey, localResults, knownResults } = known.value
        const pendingToolCalls = params.toolCalls.filter(
          (toolCall) => !knownResults.has(toolCall.id),
        )
        // Every call that parks is marked when it parks, one write at a time,
        // each restating every mark so far. Only a parked call runs again
        // when the turn resumes; a call cut short without a mark does not.
        const parked = yield* Ref.make<ReadonlySet<string>>(new Set())
        const markLock = yield* Semaphore.make(1)
        const onParked = (toolCallId: ToolCallId) =>
          Ref.updateAndGet(parked, (current) => new Set([...current, toolCallId])).pipe(
            Effect.flatMap((marked) =>
              markParkedCalls({
                messageId: params.messageId,
                toolCalls: params.toolCalls,
                parked: marked,
              }),
            ),
            markLock.withPermits(1),
          )
        const executedResults = yield* executeToolCalls({
          interruption: scope.turnInterruption.awaitInterrupt,
          hostToolBindings: params.hostToolBindings,
          assistantMessageId: address.assistant,
          toolCalls: pendingToolCalls,
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          currentTurnAgent: params.currentTurnAgent,
          toolBindings: params.toolBindings,
          onParked,
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              if (error.completedResults.length === 0) return
              const partial = new Map(localResults)
              for (const result of error.completedResults) partial.set(result.id, result)
              yield* processLocalReplay.setResults(resultKey, partial)
            }),
          ),
        )
        const executedById = new Map(executedResults.map((part) => [part.id, part]))
        const toolResults = params.toolCalls.flatMap((toolCall) => {
          const persisted = knownResults.get(toolCall.id)
          if (Predicate.isNotUndefined(persisted)) return [persisted]
          const executed = executedById.get(toolCall.id)
          if (Predicate.isNotUndefined(executed)) return [executed]
          return []
        })
        yield* recordToolOutcome({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          toolResultMessageId: address.toolResult,
          assistantMessageId: address.assistant,
          parts: toolResults,
        })
        yield* processLocalReplay.removeResults(resultKey)
        yield* closeTurnStep({ messageId: params.messageId, step: params.step })
        return Option.none<ToolInteractionPending>()
      },
      Effect.catchIf(Schema.is(ToolInteractionPending), (pending) => Effect.succeedSome(pending)),
    )

    const collectTurnStream = Effect.fn("AgentLoop.collectTurnStream")(function* (params: {
      messageId: RunningState["message"]["id"]
      step: number
      /** The last step the turn may run; it streams with tools disabled. */
      finalStep: boolean
      resolved: ResolvedTurnContext
      activeStream: ActiveStreamHandle
      measure: Option.Option<StepMeasure>
      lastCallAtMillis: Option.Option<number>
      lastCallModel: Option.Option<ModelIdType>
      stepEfforts: ReadonlyMap<string, StepEffort>
      overflowed: boolean
    }) {
      const persistAssistantPartsWithBindingsAt = (
        at: StepAddress,
        parts: ReadonlyArray<AssistantResponsePart>,
        createdAt?: Date,
      ) =>
        persistAssistantPartsWithBindings({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: at.assistant,
          parts,
          toolBindings: params.resolved.toolBindings,
          storageTransaction,
          createdAt,
        }).pipe(
          Effect.tap((persisted) =>
            Effect.gen(function* () {
              if (Option.isNone(persisted) || !persisted.value.inserted) return
              for (const part of parts) {
                if (part.type !== "tool-call") continue
                const entry = params.resolved.toolBindings.get(part.name)
                if (Predicate.isNotUndefined(entry) && Predicate.isUndefined(entry.binding)) {
                  yield* processLocalReplay.setBinding(
                    processLocalReplayBindingKey({
                      sessionId: scope.sessionId,
                      branchId: scope.branchId,
                      assistantMessageId: at.assistant,
                      toolCallId: part.id,
                    }),
                    { entry },
                  )
                }
              }
            }),
          ),
        )

      const source = yield* resolveTurnSource({
        messageId: params.messageId,
        step: params.step,
        finalStep: params.finalStep,
        resolved: params.resolved,
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        activeStream: params.activeStream,
        measure: params.measure,
        lastCallAtMillis: params.lastCallAtMillis,
        lastCallModel: params.lastCallModel,
        stepEfforts: params.stepEfforts,
        overflowed: params.overflowed,
      })
      if (Option.isSome(source.compaction))
        yield* scope.turnLedger.noteCompaction(source.compaction.value.costUsd)
      yield* scope.turnLedger.noteNotices(params.resolved.notices)

      yield* publishEventOrDie(
        StreamStarted.make({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: params.messageId,
          step: params.step,
          ...effortReceipt(source.reasoningLevel),
        }),
      )

      yield* Effect.logInfo("turn-stream.start").pipe(
        Effect.annotateLogs({
          agent: params.resolved.currentTurnAgent,
          model: params.resolved.modelId,
        }),
      )

      const collected = yield* source.collect(
        collectModelTurnResponse({
          messageId: params.messageId,
          step: params.step,
          turnStream: source.stream,
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          modelId: params.resolved.modelId,
          reasoningLevel: Option.getOrUndefined(source.reasoningLevel),
          activeStream: params.activeStream,
        }),
      )
      yield* scope.turnLedger.noteStepEnd(collected.retryAt)

      const outcome = classifyStep(collected)
      // The step whose messages carry this response.
      const responseAddress = stepAddress(params.messageId, params.step)
      const assistantParts = collected.messageProjection.assistant
      const toolParts = collected.messageProjection.tool

      // A settled step: cost frozen into the boundary event, metrics folded,
      // parts persisted with their bindings.
      const settleStep = Effect.gen(function* () {
        // The driver splits the cache writes by lifetime when their rates differ.
        const finishMetadata = collected.responseParts
          .filter((part): part is Response.FinishPart => part.type === "finish")
          .reduce<Response.ProviderMetadata>(
            (merged, part) => ({ ...merged, ...part.metadata }),
            {},
          )
        const cacheWritesByLifetime = yield* driverCacheWritesByLifetime(
          params.resolved.modelDriver.driverId,
          finishMetadata,
        )
        const usage = Option.fromUndefinedOr(collected.messageProjection.usage)
        // Priced by the catalog id, the same one the context window reads: a
        // driver override routes `provider/model` to `driver/model`.
        const pricedModel = params.resolved.modelDriver.contextModelId
        const streamEndedCost = yield* computeStreamEndedCost({
          modelId: pricedModel,
          usage: Option.map(usage, (counts) => ({ ...counts, cacheWritesByLifetime })),
        })
        yield* publishEventOrDie(
          StreamEnded.make({
            messageId: params.messageId,
            step: params.step,
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            usage: collected.messageProjection.usage,
            requestOverheadTokens: source.overheadTokens,
            model: params.resolved.modelId,
            costUsd: Option.getOrUndefined(streamEndedCost),
            pricedModel,
            child: params.resolved.child,
            cacheWritesByLifetime: Option.getOrUndefined(
              Option.liftPredicate(cacheWritesByLifetime, (writes) => writes.length > 0),
            ),
            outcome: outcome._tag,
            ...effortReceipt(source.reasoningLevel),
          }),
        )
        const { inputTokens, outputTokens } = Option.getOrElse(usage, () => ({
          inputTokens: 0,
          outputTokens: 0,
        }))
        const toolCallCount = toolCallsFromResponseParts(collected.responseParts).length
        yield* Effect.logInfo("stream.end").pipe(
          Effect.annotateLogs({
            outcome: outcome._tag,
            inputTokens,
            outputTokens,
            toolCallCount,
          }),
        )
        yield* scope.turnLedger.noteStep({
          agent: params.resolved.currentTurnAgent,
          model: params.resolved.modelId,
          usage,
          costUsd: streamEndedCost,
          toolCallCount,
        })
        yield* persistAssistantPartsWithBindingsAt(responseAddress, assistantParts)
        const stepToolCalls = assistantParts.filter(
          (part): part is Prompt.ToolCallPart => part.type === "tool-call",
        )
        yield* openTurnStep({
          messageId: params.messageId,
          step: params.step,
          toolCalls: stepToolCalls,
        })
        yield* persistMessageParts({
          role: "tool",
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: responseAddress.toolResult,
          parts: toolParts,
        })
        // A step the model answered owns no unsettled call; a tool step is
        // closed by `executeTools` once its results commit.
        if (stepToolCalls.length === 0) {
          yield* closeTurnStep({ messageId: params.messageId, step: params.step })
        }
      })

      /**
       * The stream stopped before the step settled. Keep what arrived, and give
       * every tool call that never ran a failure result: a call with no result
       * makes the transcript unreadable for every later turn.
       */
      const persistCutStep = (reason: "Interrupted" | "StreamFailed") =>
        Effect.gen(function* () {
          yield* persistMessageParts({
            role: "assistant",
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            messageId: responseAddress.assistant,
            parts: assistantParts,
          })
          const settled = new Set(
            toolParts.filter((part) => part.type === "tool-result").map((part) => part.id),
          )
          const unrun = assistantParts
            .filter((part) => part.type === "tool-call")
            .filter((call) => !settled.has(call.id))
            .map((call) =>
              Prompt.toolResultPart({
                id: call.id,
                name: call.name,
                isFailure: true,
                providerExecuted: false,
                result: { error: "The tool did not run: the step stopped first.", reason },
              }),
            )
          yield* recordToolOutcome({
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            toolResultMessageId: responseAddress.toolResult,
            assistantMessageId: responseAddress.assistant,
            parts: [...toolParts, ...unrun],
          })
          yield* closeTurnStep({ messageId: params.messageId, step: params.step })
          // A cut step spent tokens nobody reported, so the turn's total is unknown.
          yield* scope.turnLedger.noteStep({
            agent: params.resolved.currentTurnAgent,
            model: params.resolved.modelId,
            usage: Option.none(),
            costUsd: Option.none(),
            toolCallCount: 0,
          })
        })

      yield* Match.type<StepOutcome>().pipe(
        Match.tagsExhaustive({
          Interrupted: () =>
            Effect.gen(function* () {
              yield* publishEventOrDie(
                StreamEnded.make({
                  messageId: params.messageId,
                  step: params.step,
                  sessionId: scope.sessionId,
                  branchId: scope.branchId,
                  model: params.resolved.modelId,
                  interrupted: true,
                  outcome: "Interrupted",
                  ...effortReceipt(source.reasoningLevel),
                }),
              )
              yield* persistCutStep("Interrupted")
            }),
          // The failure already ended the stream where it broke; keep what arrived.
          Failed: () => persistCutStep("StreamFailed"),
          ToolCalls: () => settleStep,
          Answered: () => settleStep,
        }),
      )(outcome)

      return { collected, outcome }
    })

    const interactionOutcome = (pending: ToolInteractionPending) =>
      StepResult.cases.Interaction.make({
        outcome: TurnOutcome.cases.InteractionRequested.make({
          pendingRequestId: pending.pending.requestId,
        }),
      })

    /**
     * Stores the turn's duration and appends its one `TurnCompleted` in a
     * transaction, then delivers it. It returns what the `turnAfter` hooks
     * read. The stored duration marks the receipt: a later call (a replay
     * after a restart, or a failure after the receipt was stored) delivers
     * the stored receipt again and returns none, so the hooks run once.
     */
    const appendTurnReceipt = Effect.fn("AgentLoop.appendTurnReceipt")(function* (params: TurnEnd) {
      const existingMessage = yield* messageStorage.getMessage(params.messageId)
      if (!Predicate.isUndefined(existingMessage?.turnDurationMs)) {
        const envelope = yield* findPersistedEvent({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          match: (candidate) =>
            candidate.event._tag === "TurnCompleted" &&
            candidate.event.messageId === params.messageId,
        })
        if (!Predicate.isUndefined(envelope)) {
          yield* eventStore.deliver(envelope)
        }
        return Option.none<TurnReceipt>()
      }

      const turnEndTime = yield* DateTime.now
      const durationMs = Math.max(0, DateTime.toEpochMillis(turnEndTime) - params.startedAtMs)
      const metrics = turnMetricsFor(yield* scope.turnLedger.total, params.messageId)
      // Token totals are a receipt only when they are complete; a partial sum
      // would read as the turn's true total.
      const total = flagWhenTrue(usageComplete(metrics))
      const usage = Option.map(total, () => ({
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        ...omitUndefined({
          cacheReadTokens: Option.getOrUndefined(positiveCount(metrics.cacheReadTokens)),
          cacheWriteTokens: Option.getOrUndefined(positiveCount(metrics.cacheWriteTokens)),
        }),
      }))
      const costUsd = Option.flatMap(total, () => metrics.costUsd)

      const envelope = yield* storageTransaction(
        Effect.gen(function* () {
          yield* messageStorage.updateMessageTurnDuration(params.messageId, durationMs)
          return yield* eventStore.append(
            TurnCompleted.make({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              messageId: params.messageId,
              durationMs,
              streamFailed: params.streamFailed,
              ...omitUndefined({
                interrupted: Option.getOrUndefined(flagWhenTrue(params.turnInterrupted)),
                unanswered: Option.getOrUndefined(flagWhenTrue(params.unanswered)),
                usage: Option.getOrUndefined(usage),
                costUsd: Option.getOrUndefined(costUsd),
              }),
            }),
          )
        }),
      )
      yield* eventStore.deliver(envelope)
      return Option.some<TurnReceipt>({ durationMs, metrics })
    })

    /** The turn's `turnAfter` hooks, after its receipt; the caller provides the turn's profile. */
    const emitTurnAfter = Effect.fn("AgentLoop.emitTurnAfter")(function* (
      params: TurnEnd & TurnReceipt & { readonly agentName: AgentNameType },
    ) {
      const extensionRegistry = yield* ExtensionRegistry
      // A turn that did not answer read none of its notices: they show again.
      const answered = !(params.turnInterrupted || params.streamFailed || params.unanswered)
      let readNotices: ReadonlyMap<ExtensionId, ReadonlySet<string>> = new Map()
      if (answered) readNotices = yield* scope.turnLedger.shownNotices
      // Only a turn that failed on its own names the limit it stopped at.
      let retryAt = Option.none<number>()
      if (params.streamFailed && !params.turnInterrupted) retryAt = yield* scope.turnLedger.retryAt
      yield* extensionRegistry.getResolved().extensionHooks.emitTurnAfter(
        {
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          durationMs: params.durationMs,
          messageId: params.messageId,
          joinedMessageIds: yield* scope.turnLedger.joined,
          startedAtMs: params.startedAtMs,
          agentName: params.agentName,
          interrupted: params.turnInterrupted,
          streamFailed: params.streamFailed,
          retryAt,
          unanswered: params.unanswered,
          usage: {
            known: {
              inputTokens: params.metrics.inputTokens,
              outputTokens: params.metrics.outputTokens,
              cacheReadTokens: params.metrics.cacheReadTokens,
              cacheWriteTokens: params.metrics.cacheWriteTokens,
              costUsd: params.metrics.costUsd,
            },
            complete: usageComplete(params.metrics),
          },
        },
        readNotices,
      )
    })

    const finalizeTurn = Effect.fn("AgentLoop.finalizeTurn")(function* (
      params: TurnEnd & { readonly turnAgent: AgentNameType },
    ) {
      const receipt = yield* appendTurnReceipt(params)
      if (Option.isNone(receipt)) return
      const { durationMs, metrics } = receipt.value

      yield* Effect.logDebug("finalize.turn-after.start")
      yield* emitTurnAfter({ ...params, durationMs, metrics, agentName: params.turnAgent })
      yield* Effect.logDebug("finalize.turn-after.done")

      yield* Effect.logInfo("turn.completed").pipe(
        Effect.annotateLogs({
          durationMs,
          interrupted: params.turnInterrupted,
          unanswered: params.unanswered,
        }),
      )
      if (params.unanswered) {
        yield* Effect.logWarning("turn.unanswered").pipe(
          Effect.annotateLogs({ continuations: MAX_CONTINUATIONS_PER_TURN }),
        )
      }

      const failedWithoutInterrupt = params.streamFailed && !params.turnInterrupted
      yield* WideEvent.set({
        actor: metrics.agent,
        model: metrics.model,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        toolCallCount: metrics.toolCallCount,
        interrupted: params.turnInterrupted,
        ...omitUndefined({
          streamFailed: Option.getOrUndefined(flagWhenTrue(failedWithoutInterrupt)),
          unanswered: Option.getOrUndefined(flagWhenTrue(params.unanswered)),
        }),
      })
    })

    /**
     * Ends a turn that a phase failure stopped, through the same receipt and
     * hooks as `finalizeTurn`: one `TurnCompleted` with `streamFailed`, after
     * the `ErrorOccurred` that names the cause, then the `turnAfter` hooks
     * once. A handler reads it as it reads a broken stream: a goal pauses
     * rather than stall. The hooks' profile, branch services and agent are
     * resolved after the receipt is stored, because the failure may have been
     * one of those reads.
     */
    const completeFailedTurn = Effect.fn("AgentLoop.completeFailedTurn")(function* (
      state: RunningState,
    ) {
      // A turn that failed before it ran (the worker's agent read) never began
      // its ledger: begin it here, so the receipt and hooks read this turn's
      // record, not the turn before it. A turn that ran keeps its own.
      yield* scope.turnLedger.beginTurn(state.message.id)
      const end: TurnEnd = {
        messageId: state.message.id,
        startedAtMs: state.startedAtMs,
        turnInterrupted: false,
        streamFailed: true,
        unanswered: false,
      }
      const receipt = yield* appendTurnReceipt(end)
      if (Option.isNone(receipt)) return
      const context = scope.branchContext
      const turnProfile = yield* scope.resolveTurnProfile(
        RunOpener.cases.Turn.make({ openedByClient: openedByClient(state.message) }),
      )
      const agentName = yield* sessionAgentName(scope.sessionId)
      yield* emitTurnAfter({ ...end, ...receipt.value, agentName }).pipe(
        underTurnProfile(turnProfile),
        Effect.provideContext(context),
      )
    })

    /** Runs a turn's work under its profile. */
    const underTurnProfile =
      (turnProfile: AgentLoopTurnProfile) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ConfigService, configServiceForRun),
          runAgentLoopTurnProfile(turnProfile),
        )

    /** The turn context for a running turn: agent, prompt, model, and bindings. */
    const resolveForState = (turnProfile: AgentLoopTurnProfile) =>
      resolveTurnContext({
        branchId: scope.branchId,
        sessionId: scope.sessionId,
        baseSections: turnProfile.turnBaseSections,
        interactive: turnProfile.turnInteractive,
      })

    const resolveReplayHostBindings = Effect.fn("AgentLoop.resolveReplayHostBindings")(
      function* (params: {
        readonly turnProfile: AgentLoopTurnProfile
        readonly nativeToolCalls: ReadonlyArray<Prompt.ToolCallPart>
        readonly toolBindings: Map<string, ResolvedToolCapability>
      }) {
        // A dispatching tool's inner calls need the turn's host bindings, so
        // recovery must rebuild them. A plain tool needs only its own. Which
        // tools dispatch is declared on the capability, not known by name.
        const dispatching = params.nativeToolCalls.filter((call) =>
          Option.match(Option.fromUndefinedOr(params.toolBindings.get(call.name)), {
            onNone: () => false,
            onSome: (entry) => getToolMetadata(entry.capability).dispatches === true,
          }),
        )
        if (dispatching.length === 0) return params.toolBindings
        const resolved = yield* resolveForState(params.turnProfile)
        // The turn's agent no longer exists, or its config does not load: the
        // resolve already published an error that names it. Neither grants
        // anything, so the dispatching calls lose their bindings and settle as
        // failed; the next step meets the same refusal and ends the turn
        // unanswered.
        if (Predicate.isUndefined(resolved)) {
          for (const call of dispatching) params.toolBindings.delete(call.name)
          return params.toolBindings
        }
        // A stored binding cannot restore authority the current agent policy
        // removed: a tool the agent no longer grants must not come back.
        for (const call of dispatching) {
          if (!resolved.toolBindings.has(call.name)) params.toolBindings.delete(call.name)
        }
        return resolved.hostToolBindings
      },
    )

    /**
     * Where a turn stands.
     *
     * The record answers in one read. Two cases still read messages:
     *
     * - The record names a pending step. Its assistant message carries the
     *   call arguments, which the row deliberately does not duplicate.
     * - The turn has no row. Either it is starting -- its first step has not
     *   committed yet, so there is nothing to resume -- or it was written
     *   before the record existed. The probe separates those two, and adopts
     *   whatever it derives, so it runs at most once per turn.
     */
    const resolveTurnPosition = Effect.fn("AgentLoop.resolveTurnPosition")(function* (
      messageId: RunningState["message"]["id"],
    ) {
      const settled: ReadonlyArray<Prompt.ToolCallPart> = []
      const noPendingStep = {
        step: 0,
        pendingAssistant: Option.none<Message>(),
        pendingToolCalls: settled,
        // No call of a step the record does not name may run again.
        parkedCallIds: new Set<string>(),
      }
      const record = yield* readTurnRecord(messageId)
      if (record.pendingToolCalls.length > 0) {
        const pendingStep = record.step + 1
        const assistant = yield* messageStorage.getMessage(
          stepAddress(messageId, pendingStep).assistant,
        )
        // A row naming a step whose assistant message is gone is stale: the
        // messages, never the row, decide what actually happened.
        if (Predicate.isNotUndefined(assistant)) {
          return {
            step: record.step,
            pendingAssistant: Option.some(assistant),
            pendingToolCalls: toolCallsFromMessage(assistant),
            parkedCallIds: new Set(
              record.pendingToolCalls.filter((call) => call.parked === true).map((call) => call.id),
            ),
          }
        }
      } else if (record.step > 0 || record.continuations > 0) {
        // The row names no unsettled call. That is only true if the next step
        // never committed its messages: the row is written after them, and in
        // its own transaction, so a crash in between leaves a step's assistant
        // message durable while the row still names the step before it. Ask
        // the messages before believing the row, exactly as the branch above
        // does — otherwise the probe is skipped and the turn re-issues a step
        // whose tool calls are already on disk and will never be answered.
        const nextAssistant = yield* messageStorage.getMessage(
          stepAddress(messageId, record.step + 1).assistant,
        )
        if (Predicate.isUndefined(nextAssistant)) {
          return { ...noPendingStep, step: record.step }
        }
      }

      // No usable row. Derive the position from the messages once, then adopt
      // it. A turn that is only starting exits on the first missing id. The
      // row is written after its step's messages, so the steps it names are
      // settled: the probe starts past them. A step that wrote nothing (an
      // empty answer re-prompted) has no assistant message, and a probe from
      // step 1 would stop there and move the turn backwards.
      let lastCompletedStep = record.step
      let pendingAssistant = Option.none<Message>()
      let pendingToolCalls: ReadonlyArray<Prompt.ToolCallPart> = []
      for (let step = record.step + 1; step <= MAX_TURN_STEPS; step++) {
        const at = stepAddress(messageId, step)
        const existingAssistant = yield* messageStorage.getMessage(at.assistant)
        if (Predicate.isUndefined(existingAssistant)) break
        const toolCalls = toolCallsFromMessage(existingAssistant)
        if (toolCalls.length === 0) {
          lastCompletedStep = step
          continue
        }
        const existingResults = yield* messageStorage.getMessage(at.toolResult)
        if (Predicate.isUndefined(existingResults)) {
          pendingAssistant = Option.some(existingAssistant)
          pendingToolCalls = toolCalls
          break
        }
        lastCompletedStep = step
      }
      // A turn that has committed nothing owns no position worth storing.
      if (lastCompletedStep === 0 && Option.isNone(pendingAssistant)) return noPendingStep
      const derivedPending: ReadonlyArray<PendingToolCall> = pendingToolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
      }))
      yield* writeTurnRecord(
        messageId,
        () => ({ step: lastCompletedStep, pendingToolCalls: derivedPending }),
        { onFailure: "log", base: record },
      )
      return {
        step: lastCompletedStep,
        pendingAssistant,
        pendingToolCalls,
        parkedCallIds: noPendingStep.parkedCallIds,
      }
    })

    const resumeTurn = Effect.fn("AgentLoop.resumeTurn")(function* (params: {
      readonly state: RunningState
      readonly messageId: RunningState["message"]["id"]
      readonly interrupted: boolean
      readonly currentTurnAgent: AgentNameType
      readonly turnProfile: AgentLoopTurnProfile
    }) {
      const position = yield* resolveTurnPosition(params.messageId)
      const lastCompletedStep = position.step
      const pendingStep = position.step + 1

      // An interrupt that lands while a step waits on its tools (a parked
      // interaction) still owes every call of that step a result: the
      // projection rejects a call with none. Results the step already has are
      // kept; the rest say the interrupt stopped them.
      if (params.interrupted) {
        if (Option.isNone(position.pendingAssistant)) {
          return { step: lastCompletedStep, interaction: Option.none() }
        }
        const known = yield* readKnownStepResults({
          messageId: params.messageId,
          step: pendingStep,
          toolCalls: position.pendingToolCalls,
          recoveredResults: [],
        })
        if (Option.isNone(known)) return { step: pendingStep, interaction: Option.none() }
        const address = stepAddress(params.messageId, pendingStep)
        const parts = position.pendingToolCalls.map(
          (call) =>
            known.value.knownResults.get(call.id) ??
            Prompt.toolResultPart({
              id: call.id,
              name: call.name,
              isFailure: true,
              providerExecuted: false,
              result: {
                error: "The tool did not finish: the turn was interrupted.",
                reason: "Interrupted",
              },
            }),
        )
        yield* recordToolOutcome({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          toolResultMessageId: address.toolResult,
          assistantMessageId: position.pendingAssistant.value.id,
          parts,
        })
        yield* processLocalReplay.removeResults(known.value.resultKey)
        yield* closeTurnStep({ messageId: params.messageId, step: pendingStep })
        return { step: pendingStep, interaction: Option.none() }
      }
      if (Option.isNone(position.pendingAssistant)) {
        return { step: lastCompletedStep, interaction: Option.none() }
      }
      const pendingAssistant = position.pendingAssistant
      const pendingToolCalls = position.pendingToolCalls

      yield* Effect.logInfo("turn.resume-tools")
      const recoveredResults: Array<Prompt.ToolResultPart> = []
      const nativeToolCalls: Array<Prompt.ToolCallPart> = []
      // A tool that keeps durable receipts can settle a call the crash left in
      // flight. Which tools those are is not the loop's business; every other
      // call is decided below by the parked mark.
      const recovery = yield* Effect.serviceOption(ToolCallRecoveryService)
      for (const toolCall of pendingToolCalls) {
        const outcome: ToolCallRecoveryOutcome = yield* Option.match(recovery, {
          onNone: () =>
            Effect.succeed<ToolCallRecoveryOutcome>(
              ToolCallRecoveryOutcome.cases.NotRecovered.make({}),
            ),
          onSome: (service) =>
            service
              .recover({
                sessionId: scope.sessionId,
                branchId: scope.branchId,
                assistantMessageId: pendingAssistant.value.id,
                toolCall,
              })
              .pipe(
                runAgentLoopTurnProfile(params.turnProfile),
                asAgentLoopError("Tool call recovery failed"),
              ),
        })
        if (outcome._tag === "Suspended") {
          return {
            step: pendingStep,
            interaction: Option.some(
              TurnOutcome.cases.InteractionRequested.make({
                pendingRequestId: outcome.requestId,
              }),
            ),
          }
        }
        if (outcome._tag === "Settled") {
          recoveredResults.push(outcome.result)
          continue
        }
        nativeToolCalls.push(toolCall)
      }
      // A call whose result is already known needs no binding: it will not
      // run again. Only the calls still owed a result are captured, so one
      // missing binding cannot turn a stored success into a failure.
      const known = yield* readKnownStepResults({
        messageId: params.messageId,
        step: pendingStep,
        toolCalls: pendingToolCalls,
        recoveredResults,
      })
      // The step's results are already stored: this is the step boundary.
      if (Option.isNone(known)) {
        yield* deliverSteeringAtStepBoundary({ finalStep: false })
        return { step: pendingStep, interaction: Option.none() }
      }
      const unsettledCalls = nativeToolCalls.filter(
        (toolCall) => !known.value.knownResults.has(toolCall.id),
      )
      // Only a call that parked on an interaction runs again: its last run
      // stopped at the ask. Any other unsettled call has no recorded result:
      // it was cut short while it ran, it finished beside a parked sibling
      // (step results are kept only in process memory until the whole step
      // settles), or it never started (the step's concurrency cap). Running
      // it again could repeat what it already did, so the model reads that
      // no result was recorded instead.
      const cutShort = unsettledCalls.filter((toolCall) => !position.parkedCallIds.has(toolCall.id))
      for (const toolCall of cutShort) {
        recoveredResults.push(
          Prompt.toolResultPart({
            id: toolCall.id,
            name: toolCall.name,
            isFailure: true,
            providerExecuted: false,
            result: {
              error:
                "No result was recorded before the server stopped: the tool may have run in part, in full, or not at all. It did not run again; check its effects before you retry it.",
              reason: "Interrupted",
            },
          }),
        )
      }
      const cutShortIds = new Set(cutShort.map((toolCall) => toolCall.id))
      const rerunCalls = unsettledCalls.filter((toolCall) => !cutShortIds.has(toolCall.id))
      const knownResults = new Map(known.value.knownResults)
      for (const result of recoveredResults) {
        if (!knownResults.has(result.id)) knownResults.set(result.id, result)
      }
      const toolBindings = yield* captureReplayToolBindings({
        assistantMessageId: pendingAssistant.value.id,
        toolCalls: rerunCalls,
        turnProfile: params.turnProfile,
      }).pipe(
        Effect.catchIf(Schema.is(ToolBindingReplayError), (error) =>
          Effect.gen(function* () {
            const parts = pendingToolCalls.map(
              (toolCall) =>
                knownResults.get(toolCall.id) ??
                Prompt.toolResultPart({
                  id: toolCall.id,
                  name: toolCall.name,
                  isFailure: true,
                  providerExecuted: false,
                  result: { error: error.message, reason: error.reason },
                }),
            )
            yield* recordToolOutcome({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              toolResultMessageId: stepAddress(params.messageId, pendingStep).toolResult,
              assistantMessageId: pendingAssistant.value.id,
              parts,
            }).pipe(Effect.orDie)
            return yield* error
          }),
        ),
      )
      const hostToolBindings = yield* resolveReplayHostBindings({
        turnProfile: params.turnProfile,
        nativeToolCalls: nativeToolCalls.filter((toolCall) => !cutShortIds.has(toolCall.id)),
        toolBindings,
      })
      if (rerunCalls.length > 0) yield* clearParkedCalls(params.messageId)
      const interactionSignal = yield* executeTools({
        hostToolBindings,
        messageId: params.messageId,
        step: pendingStep,
        toolCalls: pendingToolCalls,
        currentTurnAgent: params.currentTurnAgent,
        toolBindings,
        recoveredResults,
      })
      if (Option.isNone(interactionSignal)) {
        yield* clearProcessLocalReplayBindings(pendingAssistant.value.id)
        // The resumed step's results are stored and no stream is open: steering
        // that arrived while the turn was parked joins before the next model
        // request, as it does after any tool step (`runTools`).
        yield* deliverSteeringAtStepBoundary({ finalStep: false })
        return { step: pendingStep, interaction: Option.none() }
      }
      const pending = interactionSignal.value
      const outcome = interactionOutcome(pending)
      return { step: pendingStep, interaction: Option.some(outcome.outcome) }
    })

    /**
     * A safe step boundary: tool results are stored and no stream is open.
     * Steering admitted while the step ran joins the transcript here, so the
     * next model call reads it without an interrupted stream. Reports whether
     * anything joined: an answer written while steering waited is not the
     * turn's last word.
     *
     * The inbox decides *which* items a step may take and when none may be
     * taken at all; this supplies only the transcript write.
     *
     * An interrupted turn makes no further model request, so it holds
     * steering back as a final step does: a joined message would be marked
     * answered by a turn that never reads it. It stays queued and opens the
     * next turn.
     */
    const deliverSteeringAtStepBoundary = (options: { readonly finalStep: boolean }) =>
      Effect.gen(function* () {
        const interrupted = yield* scope.turnInterruption.interrupted
        return yield* deliverSteeringUnlessLast({ finalStep: options.finalStep || interrupted })
      })
    const deliverSteeringUnlessLast = (options: { readonly finalStep: boolean }) =>
      scope.inbox.deliverSteering({
        finalStep: options.finalStep,
        // The message joins the transcript now. Its admission time could sort it
        // between a tool call and its result, which the projection rejects.
        //
        // `joinedTurn` marks it as answered by the turn it joined. Without the
        // mark it is a user-role message with no `TurnCompleted` of its own,
        // and a restart reads that as an unanswered turn and answers it twice.
        // Only delivery sets it: an interjection that woke an idle branch
        // never reaches this boundary and must still recover. The sender's own
        // custom type stays; the TUI draws the sender row from it.
        join: (item) =>
          Effect.gen(function* () {
            yield* persistMessageReceived({
              message: {
                ...item.message,
                createdAt: yield* DateTime.nowAsDate,
                metadata: { ...item.message.metadata, joinedTurn: true },
              },
            })
            yield* scope.turnLedger.noteJoined(item.message.id)
          }),
      })

    /**
     * Narrow retry inside a turn: whatever the model did produce stays, a
     * durable instruction follows it, and the same turn runs one more model
     * step. Bounded per turn; a further failure ends the turn.
     *
     * Two callers share this. A stream that failed after partial output asks
     * the model to continue; a stream that succeeded with nothing at all asks
     * it to answer. Both would otherwise finalize a turn the caller cannot
     * distinguish from a real reply.
     */
    const continueWithinTurn = Effect.fn("AgentLoop.continueWithinTurn")(function* (params: {
      readonly messageId: RunningState["message"]["id"]
      readonly step: number
      readonly instruction: string
    }) {
      const record = yield* readTurnRecord(params.messageId)
      const used = record.continuations
      if (used >= MAX_CONTINUATIONS_PER_TURN) return false
      yield* persistMessageReceived({
        message: Message.cases.regular.make({
          id: continuationMessageIdForTurn(params.messageId, params.step),
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          role: "user",
          parts: [Prompt.textPart({ text: params.instruction })],
          createdAt: yield* DateTime.nowAsDate,
          metadata: { customType: "continuation", details: { step: params.step } },
        }),
      })
      yield* writeTurnRecord(params.messageId, () => ({ continuations: used + 1 }), {
        onFailure: "log",
        base: record,
      })
      yield* Effect.logInfo("turn.continue-within-turn").pipe(
        Effect.annotateLogs({ step: params.step, continuation: used + 1 }),
      )
      return true
    })

    const runTurnStep = Effect.fn("AgentLoop.runTurnStep")(function* (params: {
      readonly state: RunningState
      readonly step: number
      readonly currentTurnAgent: AgentNameType
      readonly turnProfile: AgentLoopTurnProfile
      /** The provider refused the last step as too long; this one hands the window off first. */
      readonly overflowed: boolean
    }) {
      const resolvedAtBoundary = yield* resolveForState(params.turnProfile)
      // `resolveTurnContext` published `ErrorOccurred` and gave up — an unknown
      // agent, most often. The turn produced no answer, so say so rather than
      // publish a `TurnCompleted` no caller can tell from a reply.
      if (Predicate.isUndefined(resolvedAtBoundary)) {
        return endStep(params.currentTurnAgent, { unanswered: true })
      }
      // A line the loop writes at this boundary, after the messages this step
      // resolved: the step reads it too. Replay finds it by id, so it is
      // appended once.
      let resolved: ResolvedTurnContext = resolvedAtBoundary
      const appendBoundaryLine = Effect.fn("AgentLoop.appendBoundaryLine")(function* (
        message: Message,
      ) {
        const persisted = yield* persistMessageReceived({ message })
        if (resolved.messages.some((existing) => existing.id === persisted.id)) return
        resolved = { ...resolved, messages: [...resolved.messages, persisted] }
      })
      // A `/model` switch lands here, never between a tool call and its
      // result: the settings writer only records the choice.
      const knownSteps = yield* readKnownSteps.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("turn.model-change-read-failed").pipe(
            Effect.annotateLogs({ error: String(cause) }),
            Effect.as(unknownSteps),
          ),
        ),
      )
      // A virtual model runs the turn on the concrete model its router picks,
      // before the model-change notice compares models: a routed switch
      // writes the transcript a hand switch writes.
      const profile = (yield* ExtensionRegistry).getResolved()
      const virtual = servedVirtualModel(profile, resolved.modelId)
      const effortLog: EffortRoutingLog = {
        routed: knownSteps.effortRouted,
        lastCallModel: knownSteps.lastCallModel,
        lastCallAtMillis: knownSteps.lastCallAtMillis,
        measure: knownSteps.measure,
        lastEffort: knownSteps.lastEffort,
        stepEfforts: knownSteps.stepEfforts,
      }
      // One classifier call per user turn: where the virtual model's router
      // serves the effort router too, its call picks the level as well.
      const combinedEffort = (routedModel: ServedVirtualModel) =>
        combinedEffortRoute({
          resolved,
          step: params.step,
          messageId: params.state.message.id,
          routedModel,
          effortRouter: servedEffortRouter(profile),
          log: effortLog,
        })
      let decided: DecidedEffort = Option.none()
      if (Option.isSome(virtual)) {
        const unrunnable = (error: string) =>
          publishEventOrDie(
            ErrorOccurred.make({ sessionId: scope.sessionId, branchId: scope.branchId, error }),
          ).pipe(Effect.as(endStep(params.currentTurnAgent, { unanswered: true })))
        if (Result.isFailure(virtual.value)) return yield* unrunnable(virtual.value.failure)
        const routedModel = virtual.value.success
        const route = yield* routeTurn({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: params.state.message.id,
          step: params.step,
          resolved,
          served: routedModel,
          log: {
            current: knownSteps.model,
            lastCallModel: knownSteps.lastCallModel,
            lastCallAtMillis: knownSteps.lastCallAtMillis,
            measure: knownSteps.measure,
            routed: knownSteps.routed,
          },
          effort: combinedEffort(routedModel),
        })
        if (Option.isNone(route))
          return yield* unrunnable(
            `Model router "${resolved.modelId}": no choice names a model the catalog lists`,
          )
        if (!route.value.recorded) yield* publishEventOrDie(route.value.event)
        // A recorded route is charged too: a process that recovers the turn
        // starts a new ledger, and the route's classifier calls are still spent.
        yield* scope.turnLedger.noteRoute(route.value.event)
        resolved = applyTurnRoute(resolved, route.value.event)
        decided = route.value.effort
      }
      if (resolved.effortAuto)
        resolved = yield* atAutoEffort({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: params.state.message.id,
          step: params.step,
          resolved,
          ledger: scope.turnLedger,
          log: effortLog,
          decided,
        })
      if (params.step > 1) {
        resolved = atTurnEffort(
          resolved,
          Option.fromUndefinedOr(
            knownSteps.stepEfforts.get(stepAddress(params.state.message.id, 1).assistant),
          ),
        )
      }
      const previousModel = knownSteps.model
      if (Option.isSome(previousModel) && previousModel.value !== resolved.modelId) {
        yield* appendBoundaryLine(
          modelChangeNotice({
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            turnMessageId: params.state.message.id,
            step: params.step,
            previousModelId: previousModel.value,
            nextModelId: resolved.modelId,
            createdAt: yield* DateTime.nowAsDate,
          }),
        )
      }

      const currentTurnAgent = resolved.currentTurnAgent
      const stop = (reason: {
        readonly interrupted?: boolean
        readonly streamFailed?: boolean
        readonly unanswered?: boolean
      }) => endStep(currentTurnAgent, reason)
      const proceed = StepResult.cases.Continue.make({ currentTurnAgent })

      const maxSteps = Math.min(resolved.agent.maxSteps ?? MAX_TURN_STEPS, MAX_TURN_STEPS)
      if (params.step > maxSteps) {
        // The final step refuses its tool calls and stops, so only a resume
        // past the budget lands here. Leaving the flags false publishes a
        // `TurnCompleted` no caller can tell from a reply, and headless mode
        // reads exactly that flag to pick its exit code, so `gent -H` would
        // exit 0 having printed nothing.
        yield* Effect.logWarning("turn.max-steps-exceeded").pipe(
          Effect.annotateLogs({ step: params.step, max: maxSteps }),
        )
        return stop({ unanswered: true })
      }
      // The last step the budget allows. Rather than cut the turn off mid-plan,
      // tell the model its tools are gone and let it spend this step writing
      // the answer. Prior art: opencode-v2 does the same at its ceiling
      // (`runner/llm.ts:221`).
      const finalStep = params.step === maxSteps
      if (finalStep) {
        yield* appendBoundaryLine(
          Message.cases.regular.make({
            id: finalStepMessageIdForTurn(params.state.message.id),
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            role: "user",
            parts: [Prompt.textPart({ text: MAX_STEPS_INSTRUCTION })],
            createdAt: yield* DateTime.nowAsDate,
            metadata: { customType: "max-steps", details: { step: params.step } },
          }),
        )
        yield* Effect.logWarning("turn.max-steps-final").pipe(
          Effect.annotateLogs({ step: params.step, max: maxSteps }),
        )
      }
      if (params.step === 1) {
        yield* scope.turnLedger.noteModel({ agent: currentTurnAgent, model: resolved.modelId })
      }
      if (yield* scope.turnInterruption.interrupted) {
        return stop({ interrupted: true })
      }

      const { collected, outcome } = yield* Effect.scoped(
        Effect.gen(function* () {
          const activeStream = yield* makeActiveStreamHandle
          yield* Ref.set(scope.activeStreamRef, Option.some(activeStream))
          return yield* collectTurnStream({
            messageId: params.state.message.id,
            step: params.step,
            finalStep,
            resolved,
            activeStream,
            measure: knownSteps.measure,
            lastCallAtMillis: knownSteps.lastCallAtMillis,
            lastCallModel: knownSteps.lastCallModel,
            stepEfforts: knownSteps.stepEfforts,
            overflowed: params.overflowed,
          })
        }).pipe(Effect.ensuring(Ref.set(scope.activeStreamRef, Option.none()))),
      )
      // Whatever the model did produce stays; a durable instruction follows it
      // and the same turn runs one more step. Once the continuations are spent,
      // or on the last step the budget allows, stop: no step would answer it.
      const continueOr = (instruction: string, otherwise: StepResult) => {
        if (finalStep) return Effect.succeed(otherwise)
        return continueWithinTurn({
          messageId: params.state.message.id,
          step: params.step,
          instruction,
        }).pipe(
          Effect.map((continued) => {
            if (continued) return proceed
            return otherwise
          }),
        )
      }
      const refuseToolsAtStepLimit = Effect.gen(function* () {
        const address = stepAddress(params.state.message.id, params.step)
        yield* recordToolOutcome({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          toolResultMessageId: address.toolResult,
          assistantMessageId: address.assistant,
          parts: toolCallsFromResponseParts(collected.responseParts).map((call) =>
            Prompt.toolResultPart({
              id: call.id,
              name: call.name,
              isFailure: true,
              providerExecuted: false,
              result: {
                error: "The tool did not run: the turn reached its step limit.",
                reason: "StepLimit",
              },
            }),
          ),
        })
        yield* clearProcessLocalReplayBindings(address.assistant)
        yield* closeTurnStep({ messageId: params.state.message.id, step: params.step })
      })
      const runTools = Effect.gen(function* () {
        const interactionSignal = yield* executeTools({
          hostToolBindings: resolved.hostToolBindings,
          messageId: params.state.message.id,
          step: params.step,
          toolCalls: toolCallsFromResponseParts(collected.responseParts),
          currentTurnAgent,
          toolBindings: resolved.toolBindings,
        })
        if (Option.isSome(interactionSignal)) {
          return interactionOutcome(interactionSignal.value)
        }
        yield* clearProcessLocalReplayBindings(
          stepAddress(params.state.message.id, params.step).assistant,
        )
        yield* deliverSteeringAtStepBoundary({ finalStep: false })
        return proceed
      })
      // The window filled while the model wrote: a step that would go on
      // hands the window off first, as after a refusal.
      const handOffWhen = <E, R>(
        contextOverflow: boolean,
        next: Effect.Effect<StepResult, E, R>,
      ): Effect.Effect<StepResult, E, R> => {
        if (!contextOverflow) return next
        return next.pipe(
          Effect.map((result) => {
            if (result._tag !== "Continue") return result
            return StepResult.cases.HandOff.make({ currentTurnAgent })
          }),
        )
      }

      return yield* Match.type<StepOutcome>().pipe(
        Match.tagsExhaustive({
          Interrupted: () => Effect.succeed(stop({ interrupted: true })),
          Failed: ({ partialOutput, contextOverflow }) => {
            // Refused as too long before any output: the same window would be
            // refused again, so the next step hands it off first.
            if (contextOverflow) {
              return Effect.succeed(StepResult.cases.HandOff.make({ currentTurnAgent }))
            }
            if (!partialOutput) return Effect.succeed(stop({ streamFailed: true }))
            return continueOr(CONTINUATION_INSTRUCTION, stop({ streamFailed: true }))
          },
          // A step with nothing observable answered nothing; one cut off at the
          // output limit or by a full window lost what it was writing.
          // Re-prompt rather than report the fragment as the reply; once
          // continuations are spent, say so. A full window has no room for
          // the continuation, so the step that runs it hands the window off.
          Answered: ({ empty, truncated, contextOverflow, blocked }) => {
            // The provider blocked the request, not the answer: a re-prompt
            // resends the same window to the same filter. The text it kept
            // stays; the error says why the reply ends there.
            if (blocked) {
              return publishEventOrDie(
                ErrorOccurred.make({
                  sessionId: scope.sessionId,
                  branchId: scope.branchId,
                  error: PROVIDER_BLOCKED_RESPONSE,
                }),
              ).pipe(Effect.as(stop({ unanswered: empty })))
            }
            if (!empty && !truncated) {
              // Steering that arrived while the answer streamed joins this
              // turn. Left for the next one, it would be answered in a turn
              // whose receipt nobody waits for: a parent hears a child once.
              //
              // Not on the last step of the budget: delivery takes the item
              // off the queue, and with no step left to read it the message
              // would be gone. It stays queued and opens the next turn.
              return deliverSteeringAtStepBoundary({ finalStep }).pipe(
                Effect.map((joined) => {
                  if (joined) return proceed
                  return stop({})
                }),
              )
            }
            let instruction = EMPTY_RESPONSE_INSTRUCTION
            if (truncated) instruction = TRUNCATED_RESPONSE_INSTRUCTION
            return handOffWhen(
              contextOverflow,
              continueOr(instruction, stop({ unanswered: empty })),
            )
          },
          // The last budgeted step ran with `toolChoice: "none"`; a call made
          // anyway is refused, not run. No step follows to read its result, and
          // a tool with side effects would act after the budget said stop.
          ToolCalls: ({ contextOverflow }) => {
            if (!finalStep) return handOffWhen(contextOverflow, runTools)
            return refuseToolsAtStepLimit.pipe(Effect.as(stop({ unanswered: true })))
          },
        }),
      )(outcome)
    })

    const runTurn = Effect.fn("AgentLoop.runTurn")(function* (state: RunningState) {
      yield* scope.turnLedger.beginTurn(state.message.id)
      const cancelled = yield* operations
        .isTurnCancelled({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: state.message.id,
        })
        .pipe(asAgentLoopError("Cannot read targeted cancellation"))
      if (cancelled) yield* scope.turnInterruption.interrupt

      // Whether a user can answer comes from what opened the turn and
      // whether its session was spawned (`turnCanAsk`).
      const turnProfile = yield* scope.resolveTurnProfile(
        RunOpener.cases.Turn.make({ openedByClient: openedByClient(state.message) }),
      )

      const provideTurnContext = underTurnProfile(turnProfile)

      let preserveReplayBindings = false
      // The session names its agent; each resolved step reports it again.
      const turnAgent = yield* sessionAgentName(scope.sessionId)

      /**
       * Run model steps until one says stop, the branch is interrupted, or a
       * tool parks the turn on an interaction.
       *
       * Returns the `Stop` that ends the turn, or the `Interaction` that
       * suspends it. Everything `finalizeTurn` needs already rides on `Stop`,
       * so the loop hands that value up instead of unpacking it into flags.
       *
       * A step the provider refused as too long is run again after a handoff
       * (`HandOff`); the step after it that settles clears the mark, so each
       * refusal gets one recovery and a refusal of the handed-off window ends
       * the turn. A reply the window cut off hands off the same way before
       * its continuation step; a cut in the handed-off window only continues.
       */
      const runSteps = Effect.fn("AgentLoop.runSteps")(function* (from: number) {
        let step = from
        let agent = turnAgent
        let overflowed = false
        while (true) {
          step++
          if (yield* scope.turnInterruption.interrupted) {
            return endStep(agent, { interrupted: true })
          }
          const result: StepResult = yield* runTurnStep({
            state,
            step,
            currentTurnAgent: agent,
            turnProfile,
            overflowed,
          })
          overflowed = result._tag === "HandOff"
          if (result._tag !== "Continue" && result._tag !== "HandOff") return result
          agent = result.currentTurnAgent
        }
      })

      return yield* Effect.gen(function* () {
        yield* persistMessageReceived({ message: state.message })
        yield* scope.inbox.settle(state.message.id)

        const resumed = yield* resumeTurn({
          state,
          messageId: state.message.id,
          interrupted: yield* scope.turnInterruption.interrupted,
          currentTurnAgent: turnAgent,
          turnProfile,
        })
        if (Option.isSome(resumed.interaction)) {
          preserveReplayBindings = true
          return resumed.interaction.value
        }
        if (resumed.step > 0) yield* scope.turnLedger.noteUnseenSteps

        const ended = yield* runSteps(resumed.step)
        if (ended._tag === "Interaction") {
          preserveReplayBindings = true
          return ended.outcome
        }

        yield* finalizeTurn({
          startedAtMs: state.startedAtMs,
          messageId: state.message.id,
          turnInterrupted: ended.interrupted,
          streamFailed: ended.streamFailed,
          unanswered: ended.unanswered,
          turnAgent: ended.currentTurnAgent,
        })
        return TurnOutcome.cases.Done.make({})
      })
        .pipe(provideTurnContext)
        .pipe(
          Effect.onExit(() =>
            Effect.gen(function* () {
              if (preserveReplayBindings) return
              yield* clearProcessLocalReplayBindingsForTurn(state.message.id)
              yield* clearProcessLocalToolResultsForTurn(state.message.id)
              // A request lives no longer than its turn. A turn its loop
              // stopped has not ended: it runs again after the restart, and
              // its requests and answers stay for it. The loop says so; the
              // exit's cause cannot, since a stop can land while a parked
              // call's failure is still on its way out.
              if (yield* scope.loopStopping) return
              const approval = yield* Effect.serviceOption(ApprovalService)
              if (Option.isSome(approval))
                yield* approval.value.endTurn({
                  sessionId: scope.sessionId,
                  branchId: scope.branchId,
                })
            }),
          ),
        )
    })

    return { runTurn, completeFailedTurn }
  })
