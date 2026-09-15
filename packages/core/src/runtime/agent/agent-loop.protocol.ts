import { Schema } from "effect"
import { Actor } from "effect-encore"
import { AgentName, RunSpecSchema } from "../../domain/agent.js"
import { Message } from "../../domain/message.js"
import { QueueSnapshot } from "../../domain/queue.js"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  SessionId,
} from "../../domain/ids.js"
import { SteerCommand } from "../../domain/steer.js"
import { WorkspaceId } from "../../server/workspace-rpc.js"
import { entityIdOf } from "./agent-loop.entity-id.js"

/** Route a branch-scoped command to its loop entity, keyed by the command id. */
const branchTarget = (p: BranchCommandInput) => ({
  entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
  primaryKey: p.commandId,
})

/** Route a message-carrying command to its loop entity, keyed by the message id. */
const messageTarget = (p: TurnSubmissionInput | QueueFollowUpInput) => ({
  entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
  primaryKey: p.message.id,
})

/** Follow-up admission is idempotent by source: the message id is the durable key. */
export const followUpMessageIdForSource = (input: {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly sourceId: string
}) =>
  MessageId.make(
    `follow-up:${input.workspaceId}:${input.sessionId}:${input.branchId}:${input.sourceId}`,
  )
import { AgentLoopError, SessionRuntimeStateSchema } from "./agent-loop.state.js"

const WorkspaceFields = {
  workspaceId: WorkspaceId,
}

const TurnSubmissionFields = {
  ...WorkspaceFields,
  message: Message,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
}

const QueueFollowUpFields = {
  ...WorkspaceFields,
  message: Message,
  /** Start a turn for this item even on a branch with no prior history. */
  wake: Schema.optional(Schema.Boolean),
}

const SteerFields = {
  ...WorkspaceFields,
  commandId: ActorCommandId,
  command: SteerCommand,
}

const RespondInteractionFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  requestId: InteractionRequestId,
}

/** One command addressed to a branch: drain, read, terminate. */
const BranchCommandFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const RemoveFollowUpFields = {
  ...BranchCommandFields,
  messageId: MessageId,
}

const ExtensionRequestInputEnvelope = Schema.TaggedUnion({
  Present: { value: Schema.Unknown },
  Missing: {},
})
type ExtensionRequestInputEnvelope = Schema.Schema.Type<typeof ExtensionRequestInputEnvelope>

const RequestExtensionFields = {
  ...BranchCommandFields,
  extensionId: ExtensionId,
  capabilityId: Schema.String,
  input: ExtensionRequestInputEnvelope,
}

export type MessageType = Schema.Schema.Type<typeof Message>
export type SteerCommandType = Schema.Schema.Type<typeof SteerCommand>

type FieldsInput<F extends Schema.Struct.Fields> = Schema.Struct<F>["Type"]
export type TurnSubmissionInput = FieldsInput<typeof TurnSubmissionFields>
export type QueueFollowUpInput = FieldsInput<typeof QueueFollowUpFields>
export type SteerInput = FieldsInput<typeof SteerFields>
export type RespondInteractionInput = FieldsInput<typeof RespondInteractionFields>
export type BranchCommandInput = FieldsInput<typeof BranchCommandFields>
export type RemoveFollowUpInput = FieldsInput<typeof RemoveFollowUpFields>
export type RequestExtensionInput = FieldsInput<typeof RequestExtensionFields>
export type HandlerRequest<Operation> = {
  readonly operation: Operation & { readonly _tag: string }
}

export const AgentLoop = Actor.fromEntity(
  "AgentLoop",
  {
    Submit: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: messageTarget,
    },
    SubmitAndWait: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: messageTarget,
    },
    SubmitDurable: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AgentLoopError,
      persisted: true,
      id: messageTarget,
    },
    QueueFollowUp: {
      payload: QueueFollowUpFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: messageTarget,
    },
    Steer: {
      payload: SteerFields,
      success: Schema.Void,
      error: AgentLoopError,
      persisted: true,
      id: (p: SteerInput) => ({
        entityId: entityIdOf(p.workspaceId, p.command.sessionId, p.command.branchId),
        primaryKey: p.commandId,
      }),
    },
    RespondInteraction: {
      payload: RespondInteractionFields,
      success: Schema.Void,
      error: AgentLoopError,
      persisted: true,
      id: (p: RespondInteractionInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.requestId,
      }),
    },
    // Queue drain is a mutating state transition; route it through the
    // branch-local actor so it serializes with the actor-owned queue.
    DrainQueue: {
      payload: BranchCommandFields,
      success: QueueSnapshot,
      error: AgentLoopError,
      persisted: true,
      id: branchTarget,
    },
    // Removing one queued follow-up mutates the queue too; same actor route.
    RemoveFollowUp: {
      payload: RemoveFollowUpFields,
      success: Schema.Boolean,
      error: AgentLoopError,
      persisted: true,
      id: branchTarget,
    },
    GetQueue: {
      payload: BranchCommandFields,
      success: QueueSnapshot,
      error: AgentLoopError,
      id: branchTarget,
    },
    GetState: {
      payload: BranchCommandFields,
      success: SessionRuntimeStateSchema,
      error: AgentLoopError,
      id: branchTarget,
    },
    RequestExtension: {
      payload: RequestExtensionFields,
      success: Schema.Unknown,
      error: AgentLoopError,
      id: branchTarget,
    },
    // Branch-local shutdown. Used by session terminate sweeps to close a
    // single branch's loop resources from inside the entity's own scope.
    /**
     * `TerminateBranch` shuts down a single branch's loop. Distinct from
     * generic `Interrupt` (which only flushes pending mailbox items) because
     * session termination semantically closes branch resources and must run
     * inside the entity's own scope. Used by `AgentLoopSessionGovernance`-driven
     * `terminateSession` sweeps.
     */
    TerminateBranch: {
      payload: BranchCommandFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: branchTarget,
    },
  },
  {
    state: {
      schema: SessionRuntimeStateSchema,
      error: AgentLoopError,
    },
  },
)
