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
import { entityIdOf } from "./agent-loop.entity-id.js"

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

/**
 * `EnsureStarted` materializes the entity (runs build, recovers checkpoint,
 * registers state) without performing any other work. Cold `watchState`
 * callers send this before subscribing to the registry's SubscriptionRef so
 * the entity exists when their watcher attaches.
 */
const EnsureStartedFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

/**
 * `TerminateBranch` shuts down a single branch's loop. Distinct from
 * generic `Interrupt` (which only flushes pending mailbox items) because
 * session termination semantically closes branch resources and must run
 * inside the entity's own scope. Used by `AgentLoopSessionGovernance`-driven
 * `terminateSession` sweeps.
 */
const TerminateBranchFields = {
  sessionId: SessionId,
  branchId: BranchId,
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
type EnsureStartedInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}
type TerminateBranchInput = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
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
  // No-op materialization. Cold `watchState` callers send this before
  // subscribing to the registry's SubscriptionRef so the entity exists
  // (build runs, recovery completes, state is registered) when their
  // watcher attaches. Constant primaryKey collapses redundant calls.
  EnsureStarted: {
    payload: EnsureStartedFields,
    error: AgentLoopError,
    id: (p: EnsureStartedInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: "ensure-started",
    }),
  },
  // Branch-local shutdown. Used by session terminate sweeps to close a
  // single branch's loop resources from inside the entity's own scope.
  TerminateBranch: {
    payload: TerminateBranchFields,
    error: AgentLoopError,
    id: (p: TerminateBranchInput) => ({
      entityId: entityIdOf(p.sessionId, p.branchId),
      primaryKey: "terminate-branch",
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
      QueueFollowUp: ({ operation }) => {
        // Legacy `svc.queueFollowUp` builds the message internally from
        // `{sessionId, branchId, content, metadata}` then enqueues. The actor
        // payload carries an already-constructed `Message`, so we extract the
        // text content and metadata back out to drive the legacy enqueue
        // path until C5.4.4 collapses the body.
        const text = operation.message.parts
          .filter((part) => part.type === "text")
          .map((part) => (part as { readonly text: string }).text)
          .join("")
        return svc
          .queueFollowUp({
            sessionId: operation.message.sessionId,
            branchId: operation.message.branchId,
            content: text,
            ...(operation.message.metadata !== undefined
              ? { metadata: operation.message.metadata }
              : {}),
          })
          .pipe(
            Effect.catchTag("StorageError", (cause) =>
              Effect.fail(
                new AgentLoopError({ message: `queueFollowUp storage failed: ${cause.message}` }),
              ),
            ),
          )
      },
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
      // c.1.b.1: stub. `getState` materializes the loop via the legacy
      // `getLoop` path, which is exactly the cold-watch invariant we want.
      // c.1.b.2 replaces this with the per-entity build's natural
      // materialization (build runs once, registers state, returns).
      EnsureStarted: ({ operation }) =>
        svc
          .getState({ sessionId: operation.sessionId, branchId: operation.branchId })
          .pipe(Effect.asVoid),
      // c.1.b.1: stub. Routed to `terminateSession` (which closes ALL
      // branches under the session). c.1.b.4 narrows this to a single
      // branch close once `terminateSession` is rewritten to drive
      // branch-by-branch via this op.
      TerminateBranch: ({ operation }) => svc.terminateSession(operation.sessionId),
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
