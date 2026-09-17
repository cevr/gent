import { Effect, Option, Predicate, Schema } from "effect"
import type { ToolCapability } from "../../domain/capability/tool.js"
import {
  AgentName,
  RunSpecSchema,
  type AgentDefinition as AgentDefinitionType,
  type DriverRef,
  type EffectiveModelDriver,
  type AgentName as AgentNameType,
  type ReasoningEffort as ReasoningEffortType,
} from "../../domain/agent.js"
import type { AgentEvent } from "../../domain/event.js"
import { Message } from "../../domain/message.js"
import type { ModelId as ModelIdType } from "../../domain/model.js"
import { QueueSnapshot } from "../../domain/queue.js"
import {
  InteractionRequestId,
  type InteractionRequestId as InteractionRequestIdType,
  MessageId,
} from "../../domain/ids.js"

export class AgentLoopError extends Schema.TaggedError<AgentLoopError>()("AgentLoopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * A storage or transport fault becomes the loop's one caller-facing error at
 * the call that raised it, keeping what actually went wrong as the cause.
 * Mirrors `asAgentRunError` in `agent-runner.ts`.
 */
export const asAgentLoopError = (message: string) =>
  Effect.mapError((cause: unknown) => new AgentLoopError({ message, cause }))

// ── Shared field groups ──

const RunningTurnFields = {
  message: Message,
  startedAtMs: Schema.Finite,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
}

// ── Turn types (not persisted in machine state) ──

export type ResolvedTurn = {
  currentTurnAgent: AgentNameType
  messages: ReadonlyArray<Message>
  systemPrompt: string
  modelId: ModelIdType
  reasoning?: ReasoningEffortType
  temperature?: number
  tools?: ReadonlyArray<ToolCapability>
  agent?: AgentDefinitionType
  driver?: DriverRef
  /** Derived once at resolution; the resolver, retry policy, and catalog lookup share it. */
  modelDriver: EffectiveModelDriver
}

// ── Phase-tagged loop state (flat, actor-owned) ──
//
// The loop is one fiber plus this Ref. While the actor entity is
// materialized, this enum is the source of truth for "where is the loop?".

export const LoopState = Schema.TaggedUnion({
  /** No turn in progress. */
  Idle: {},
  /** Agentic loop running: resolve → stream → tools → repeat. */
  Running: RunningTurnFields,
  /** Cold state: a tool requested human approval. No turn fiber. */
  WaitingForInteraction: {
    ...RunningTurnFields,
    currentTurnAgent: AgentName,
    pendingRequestId: InteractionRequestId,
    pendingToolCallId: Schema.String,
  },
})

// ── Type aliases ──

export type LoopState = Schema.Schema.Type<typeof LoopState>
type IdleState = Extract<LoopState, { _tag: "Idle" }>
export type RunningState = Extract<LoopState, { _tag: "Running" }>
export type WaitingForInteractionState = Extract<LoopState, { _tag: "WaitingForInteraction" }>

// ── Runtime projection (transport/UI) ──
// Public runtime state mirrors the machine directly. No parallel `phase/status`
// matrix — the discriminator is the state. Owned here so the public projection
// has a single canonical declaration; `session-runtime.ts` re-exports.

export const SessionRuntimeStateSchema = Schema.TaggedUnion({
  Idle: {
    agent: AgentName,
    queue: QueueSnapshot,
  },
  Running: {
    agent: AgentName,
    queue: QueueSnapshot,
  },
  WaitingForInteraction: {
    agent: AgentName,
    queue: QueueSnapshot,
  },
})
export type SessionRuntimeState = Schema.Schema.Type<typeof SessionRuntimeStateSchema>

/** The latest model-context projection for the branch, folded from `ModelContextProjected`. */
export const ModelContextMetrics = Schema.Struct({
  estimatedTokens: Schema.Natural,
  availableInputTokens: Schema.Natural,
  contextLimitTokens: Schema.Natural,
  omittedMessages: Schema.Natural,
  /** The handoff marker leading the current window; absent after a summary-free window. */
  handoffMessageId: Schema.optional(MessageId),
  /** Projections on this branch that compacted history so far. */
  compactions: Schema.Natural,
})
export type ModelContextMetrics = typeof ModelContextMetrics.Type

export const SessionRuntimeMetrics = Schema.Struct({
  turns: Schema.Finite,
  durationMs: Schema.Finite,
  /** Cumulative USD cost: sum of `StreamEnded.costUsd` across the session's
   * event log. Cost is frozen into each event at emit time against the
   * pricing snapshot available then, so replays always sum to the same
   * total regardless of later registry refreshes. */
  costUsd: Schema.Finite,
  /** Input-tokens reported by the most recent `StreamEnded` (for "how close
   * to the context window are we right now" — sums don't answer that). */
  lastInputTokens: Schema.Finite,
  context: Schema.optional(ModelContextMetrics),
})
export type SessionRuntimeMetrics = typeof SessionRuntimeMetrics.Type

// ── State builders ──

/** Session totals read off the branch's event log; one pass, no storage. */
export const foldSessionMetrics = (
  events: ReadonlyArray<{ readonly event: AgentEvent }>,
): SessionRuntimeMetrics => {
  let turns = 0
  let durationMs = 0
  let costUsd = 0
  let lastInputTokens = 0
  let compactions = 0
  let context = Option.none<ModelContextMetrics>()
  for (const { event } of events) {
    switch (event._tag) {
      case "TurnCompleted":
        turns++
        durationMs += event.durationMs
        break
      case "ModelContextProjected":
        if (event.compacted) compactions++
        context = Option.some({
          estimatedTokens: event.estimatedTokens,
          availableInputTokens: event.availableInputTokens,
          contextLimitTokens: event.contextLimitTokens,
          omittedMessages: event.omittedMessages,
          handoffMessageId: event.handoffMessageId,
          compactions,
        })
        break
      case "StreamEnded":
        if (Predicate.isNotUndefined(event.usage)) lastInputTokens = event.usage.inputTokens
        if (Predicate.isNotUndefined(event.costUsd)) costUsd += event.costUsd
        break
    }
  }
  const metrics = { turns, durationMs, costUsd, lastInputTokens }
  return Option.match(context, {
    onNone: () => metrics,
    onSome: (value) => ({ ...metrics, context: value }),
  })
}

export const buildIdleState = (): IdleState => LoopState.cases.Idle.make({})

/**
 * The fields a phase carries over from whatever admitted it. Structural, so
 * this module never has to know about the inbox that holds the item.
 */
type TurnOrigin = {
  readonly message: Message
  readonly agentOverride?: AgentNameType
  readonly runSpec?: typeof RunSpecSchema.Type
  readonly interactive?: boolean
}

export const buildRunningState = (
  item: TurnOrigin,
  options: { startedAtMs: number },
): RunningState =>
  LoopState.cases.Running.make({
    message: item.message,
    startedAtMs: options.startedAtMs,
    agentOverride: item.agentOverride,
    runSpec: item.runSpec,
    interactive: item.interactive,
  })

export const toWaitingForInteractionState = (params: {
  state: RunningState
  currentTurnAgent: AgentNameType
  pendingRequestId: InteractionRequestIdType
  pendingToolCallId: string
}): WaitingForInteractionState =>
  LoopState.cases.WaitingForInteraction.make({
    message: params.state.message,
    startedAtMs: params.state.startedAtMs,
    agentOverride: params.state.agentOverride,
    runSpec: params.state.runSpec,
    interactive: params.state.interactive,
    currentTurnAgent: params.currentTurnAgent,
    pendingRequestId: params.pendingRequestId,
    pendingToolCallId: params.pendingToolCallId,
  })
