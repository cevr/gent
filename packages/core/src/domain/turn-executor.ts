import type { Effect, Stream } from "effect"
import { Schema } from "effect"
import type { AgentDefinition } from "./agent.js"
import type { BranchId, SessionId } from "./ids.js"
import type { AnyToolDefinition } from "./tool.js"
import type { ExtensionHostContext } from "./extension-host-context.js"
import type { Message } from "./message.js"

// ── TurnEvent — what an external executor streams back ──

export class TextDelta extends Schema.TaggedClass<TextDelta>()("text-delta", {
  text: Schema.String,
}) {}

export class ReasoningDelta extends Schema.TaggedClass<ReasoningDelta>()("reasoning-delta", {
  text: Schema.String,
}) {}

export class ToolStarted extends Schema.TaggedClass<ToolStarted>()("tool-started", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.optional(Schema.Unknown),
}) {}

export class ToolCompleted extends Schema.TaggedClass<ToolCompleted>()("tool-completed", {
  toolCallId: Schema.String,
  output: Schema.optional(Schema.Unknown),
}) {}

export class ToolFailed extends Schema.TaggedClass<ToolFailed>()("tool-failed", {
  toolCallId: Schema.String,
  error: Schema.String,
}) {}

export const TurnEventUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
})
export type TurnEventUsage = typeof TurnEventUsage.Type

export class Finished extends Schema.TaggedClass<Finished>()("finished", {
  stopReason: Schema.String,
  usage: Schema.optional(TurnEventUsage),
}) {}

export const TurnEvent = Schema.Union([
  TextDelta,
  ReasoningDelta,
  ToolStarted,
  ToolCompleted,
  ToolFailed,
  Finished,
])
export type TurnEvent = typeof TurnEvent.Type

// ── TurnError ──

export class TurnError extends Schema.TaggedErrorClass<TurnError>()("TurnError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// ── TurnContext — what the executor receives per turn ──

export interface TurnContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agent: AgentDefinition
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<AnyToolDefinition>
  readonly systemPrompt: string
  readonly cwd: string
  readonly abortSignal: AbortSignal
  readonly hostCtx: ExtensionHostContext
}

// ── TurnExecutor — implementation registered through `ExternalDriverContribution` ──

export interface TurnExecutor {
  readonly executeTurn: (ctx: TurnContext) => Stream.Stream<TurnEvent, TurnError>
  readonly cancel?: (sessionId: string) => Effect.Effect<void>
}
