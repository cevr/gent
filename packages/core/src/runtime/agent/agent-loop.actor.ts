/**
 * `AgentLoop` as `Actor.fromEntity`.
 *
 * Replaces the per-(sessionId, branchId) hand-rolled fiber map +
 * `LoopState` `TaggedEnumClass` + `agent_loop_checkpoints` table
 * (C5.3 migrates persistence, C5.4 moves the loop body, C5.5
 * replaces `runTurnFiber` with `LanguageModel.streamText`).
 *
 * **Op surface (C5.1-followup counsel):** request/reply only.
 * `Subscribe` and `Snapshot` are NOT actor ops:
 * - `Actor.fromEntity` is request/reply; `OperationHandle.watch` is
 *   polling status, not a live state stream.
 * - State subscription stays as the existing `SubscriptionRef` exposed
 *   via `SessionRuntime` (or `Actor.withProtocol` later if encore grows
 *   streaming-RPC support).
 *
 * **Entity ID** keys per `(sessionId, branchId)` so all ops for one
 * branch land in the same FIFO mailbox (preserves serialization).
 *
 * **Single source of truth for routing** (C5.2 counsel): for ops that
 * carry a domain payload owning its own `(sessionId, branchId)`,
 * top-level routing fields are dropped — the embedded payload IS the
 * authority. Only `Interrupt` (no embedded payload) carries explicit
 * target fields.
 *
 * **Primary key (dedup)** per op:
 * - `Submit` / `QueueFollowUp` — `message.id`
 * - `Steer` — `commandId`
 * - `Interrupt` — `commandId`
 *
 * Schemas reuse gent's existing domain (`Message`, `RunSpec`,
 * `SteerCommand`) rather than introducing a parallel envelope shape.
 *
 * @module
 */

import { Effect, Schema } from "effect"
import { Actor } from "effect-encore"
import { AgentName, RunSpecSchema } from "../../domain/agent.js"
import { Message } from "../../domain/message.js"
import {
  ActorCommandId,
  BranchId,
  InteractionRequestId,
  SessionId,
  ToolCallId,
} from "../../domain/ids.js"
import { SteerCommand } from "../../domain/steer.js"
import { AgentLoop as AgentLoopService } from "./agent-loop.js"
import { AgentLoopError, commandIdForToolCall } from "./agent-loop.commands.js"

const entityIdOf = (sessionId: SessionId, branchId: BranchId): string => `${sessionId}:${branchId}`

const TurnSubmissionFields = {
  message: Message,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
}

const SteerFields = {
  commandId: ActorCommandId,
  command: SteerCommand,
}

const InterruptFields = {
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const RespondInteractionFields = {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: InteractionRequestId,
}

const RecordToolResultFields = {
  sessionId: SessionId,
  branchId: BranchId,
  commandId: Schema.optional(ActorCommandId),
  toolCallId: ToolCallId,
  toolName: Schema.String,
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
}

const InvokeToolFields = {
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
  toolName: Schema.String,
  input: Schema.Unknown,
}

type MessageType = Schema.Schema.Type<typeof Message>
type SteerCommandType = Schema.Schema.Type<typeof SteerCommand>

type TurnSubmissionInput = { readonly message: MessageType }
type SteerInput = { readonly commandId: ActorCommandId; readonly command: SteerCommandType }
type InterruptInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
type RespondInteractionInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly requestId: InteractionRequestId
}
type RecordToolResultInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly toolCallId: ToolCallId
}
type InvokeToolInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}

export const AgentLoop = Actor.fromEntity("AgentLoop", {
  Submit: {
    payload: TurnSubmissionFields,
    error: AgentLoopError,
    id: (p: TurnSubmissionInput) => ({
      entityId: entityIdOf(p.message.sessionId, p.message.branchId),
      primaryKey: p.message.id,
    }),
  },
  QueueFollowUp: {
    payload: TurnSubmissionFields,
    error: AgentLoopError,
    id: (p: TurnSubmissionInput) => ({
      entityId: entityIdOf(p.message.sessionId, p.message.branchId),
      primaryKey: p.message.id,
    }),
  },
  Steer: {
    payload: SteerFields,
    error: AgentLoopError,
    id: (p: SteerInput) => ({
      entityId: entityIdOf(p.command.sessionId, p.command.branchId),
      primaryKey: p.commandId,
    }),
  },
  Interrupt: {
    payload: InterruptFields,
    error: AgentLoopError,
    id: (p: InterruptInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: p.commandId,
    }),
  },
  RespondInteraction: {
    payload: RespondInteractionFields,
    error: AgentLoopError,
    id: (p: RespondInteractionInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: p.requestId,
    }),
  },
  // Mid-turn tool result. Dedup by toolCallId — replays of the same tool
  // call must collapse to one effect.
  RecordToolResult: {
    payload: RecordToolResultFields,
    error: AgentLoopError,
    id: (p: RecordToolResultInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: p.toolCallId,
    }),
  },
  // Programmatic tool invocation (server-driven). commandId is required
  // here (vs optional in the legacy command schema) because actor dedup
  // needs a deterministic primary key — callers that previously elided
  // commandId now generate one before sending.
  InvokeTool: {
    payload: InvokeToolFields,
    error: AgentLoopError,
    id: (p: InvokeToolInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: p.commandId,
    }),
  },
})

/**
 * `Actor.toLayer` handler layer for `AgentLoop`. Each handler delegates to
 * the legacy `AgentLoopService` Tag (the per-(sessionId, branchId)
 * imperative implementation). C5.4.4 will collapse the legacy
 * implementation into the actor body; until then this is a pass-through
 * that stages the architectural change without rewriting recovery flow.
 *
 * **`RecordToolResult` commandId fallback** (C5.4.1 counsel forward-note):
 * legacy `recordToolResultPhase` derives the persisted tool-result message
 * id from `commandId` via `toolResultMessageIdForCommand`. If the actor
 * payload's `commandId` is absent, generating a fresh random id per call
 * would produce a different message id on retry — breaking the actor's
 * dedup contract (same `toolCallId` must resolve to the same persisted
 * effect). The handler derives a deterministic fallback from `toolCallId`
 * via `commandIdForToolCall`, so retries collapse to the same message id.
 */
export const AgentLoopLiveActor = Actor.toLayer(
  AgentLoop,
  Effect.gen(function* () {
    const svc = yield* AgentLoopService
    return {
      Submit: ({ operation }) =>
        svc.submit(operation.message, {
          ...(operation.agentOverride !== undefined
            ? { agentOverride: operation.agentOverride }
            : {}),
          ...(operation.runSpec !== undefined ? { runSpec: operation.runSpec } : {}),
          ...(operation.interactive !== undefined ? { interactive: operation.interactive } : {}),
        }),
      QueueFollowUp: ({ operation }) =>
        svc.run(operation.message, {
          ...(operation.agentOverride !== undefined
            ? { agentOverride: operation.agentOverride }
            : {}),
          ...(operation.runSpec !== undefined ? { runSpec: operation.runSpec } : {}),
          ...(operation.interactive !== undefined ? { interactive: operation.interactive } : {}),
        }),
      Steer: ({ operation }) => svc.steer(operation.command),
      Interrupt: ({ operation }) =>
        svc.steer(
          Schema.decodeSync(SteerCommand)({
            _tag: "Cancel",
            sessionId: operation.sessionId,
            branchId: operation.branchId,
          }),
        ),
      RespondInteraction: ({ operation }) =>
        svc.respondInteraction({
          sessionId: operation.sessionId,
          branchId: operation.branchId,
          requestId: operation.requestId,
        }),
      RecordToolResult: ({ operation }) =>
        svc.recordToolResult({
          sessionId: operation.sessionId,
          branchId: operation.branchId,
          commandId: operation.commandId ?? commandIdForToolCall(operation.toolCallId),
          toolCallId: operation.toolCallId,
          toolName: operation.toolName,
          output: operation.output,
          ...(operation.isError !== undefined ? { isError: operation.isError } : {}),
        }),
      InvokeTool: ({ operation }) =>
        svc.invokeTool({
          sessionId: operation.sessionId,
          branchId: operation.branchId,
          commandId: operation.commandId,
          toolName: operation.toolName,
          input: operation.input,
        }),
    }
  }),
  {
    // Long-lived ops (Submit/RunTurn) park inside the loop body via
    // commandGate. `concurrency: "unbounded"` keeps short ops
    // (RecordToolResult, RespondInteraction, Steer) from blocking the
    // mailbox behind a slow Submit.
    concurrency: "unbounded",
  },
)
