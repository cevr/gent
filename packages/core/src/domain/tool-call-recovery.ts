/**
 * Recovering a tool call that was in flight when the process died.
 *
 * The loop knows a call was admitted and never recorded a result. It does not
 * know whether the tool kept a durable receipt it can settle from, or whether
 * the call should simply be re-issued to the model. A tool that keeps such
 * receipts answers here; anything else is re-issued.
 *
 * Core defines the question. No implementation means every pending call is
 * re-issued, which is the correct behavior for a tool with no durable state.
 */

import { Context, type Effect, Schema } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { InteractionRequestId } from "./ids.js"
import type { BranchId, MessageId, SessionId } from "./ids.js"
import type { CurrentAgentLoopTurnProfile } from "../runtime/agent/agent-loop.turn-profile.js"
import type { ToolRunner } from "../runtime/agent/tools.js"
import type { GentPlatform } from "../runtime/gent-platform.js"
import type { MessageStorage } from "../storage/message-storage.js"
import type { EventPublisher } from "./event.js"

/**
 * What recovering one pending call produced.
 *
 * `NotRecovered` covers both "not my call" and "no receipt for it", because
 * the loop treats them identically: re-issue.
 */
export const ToolCallRecoveryOutcome = Schema.TaggedUnion({
  NotRecovered: {},
  /** Settled from a receipt; the result is recorded as if the call returned. */
  Settled: { result: Schema.Any },
  /** Waiting on an interaction; the turn suspends until it resolves. */
  Suspended: { requestId: InteractionRequestId },
})
export type ToolCallRecoveryOutcome = typeof ToolCallRecoveryOutcome.Type

/** Recovery runs inside the turn and settles receipts with the turn's runtime services. */
type ToolCallRecoveryServices =
  | CurrentAgentLoopTurnProfile
  | EventPublisher
  | GentPlatform
  | MessageStorage
  | ToolRunner

interface ToolCallRecoveryApi {
  /** Recover one pending call, or report that it is not recoverable here. */
  readonly recover: (params: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly assistantMessageId: MessageId
    readonly toolCall: Prompt.ToolCallPart
  }) => Effect.Effect<ToolCallRecoveryOutcome, ToolCallRecoveryError, ToolCallRecoveryServices>
}

export class ToolCallRecoveryError extends Schema.TaggedError<ToolCallRecoveryError>()(
  "@gent/core/src/domain/tool-call-recovery/ToolCallRecoveryError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class ToolCallRecoveryService extends Context.Service<
  ToolCallRecoveryService,
  ToolCallRecoveryApi
>()("@gent/core/src/domain/tool-call-recovery/ToolCallRecoveryService") {}
