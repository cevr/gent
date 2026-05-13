import { Schema } from "effect"
import { Actor } from "effect-encore"
import { AgentName, RunSpecSchema, type RunSpec } from "../../domain/agent.js"
import { Message } from "../../domain/message.js"
import { QueueSnapshot } from "../../domain/queue.js"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  InteractionRequestId,
  SessionId,
  ToolCallId,
  ToolName,
} from "../../domain/ids.js"
import { SteerCommand } from "../../domain/steer.js"
import { WorkspaceId } from "../../server/workspace-rpc.js"
import { entityIdOf } from "./agent-loop.entity-id.js"
import {
  AgentLoopError,
  SessionRuntimeMetrics,
  SessionRuntimeStateSchema,
} from "./agent-loop.state.js"

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

const SteerFields = {
  ...WorkspaceFields,
  commandId: ActorCommandId,
  command: SteerCommand,
}

const InterruptFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const RespondInteractionFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  requestId: InteractionRequestId,
}

const DrainQueueFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const GetQueueFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const GetStateFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const GetMetricsFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

const RecordToolResultFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: Schema.optional(ActorCommandId),
  toolCallId: ToolCallId,
  toolName: ToolName,
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
}

const InvokeToolFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
  toolName: ToolName,
  input: Schema.Unknown,
}

const ExtensionRequestInputEnvelope = Schema.TaggedUnion({
  Present: { value: Schema.Unknown },
  Missing: {},
})
type ExtensionRequestInputEnvelope = Schema.Schema.Type<typeof ExtensionRequestInputEnvelope>

const RequestExtensionFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
  extensionId: ExtensionId,
  capabilityId: Schema.String,
  input: ExtensionRequestInputEnvelope,
}

/**
 * `TerminateBranch` shuts down a single branch's loop. Distinct from
 * generic `Interrupt` (which only flushes pending mailbox items) because
 * session termination semantically closes branch resources and must run
 * inside the entity's own scope. Used by `AgentLoopSessionGovernance`-driven
 * `terminateSession` sweeps.
 */
const TerminateBranchFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

export type MessageType = Schema.Schema.Type<typeof Message>
export type SteerCommandType = Schema.Schema.Type<typeof SteerCommand>

type WorkspaceInput = {
  readonly workspaceId: WorkspaceId
}
export type TurnSubmissionInput = WorkspaceInput & {
  readonly message: MessageType
  readonly agentOverride?: AgentName
  readonly runSpec?: RunSpec
  readonly interactive?: boolean
}
export type SteerInput = WorkspaceInput & {
  readonly commandId: ActorCommandId
  readonly command: SteerCommandType
}
export type InterruptInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
export type RespondInteractionInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly requestId: InteractionRequestId
}
export type DrainQueueInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
export type GetQueueInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
export type GetStateInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
export type GetMetricsInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
export type RecordToolResultInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId?: ActorCommandId
  readonly toolCallId: ToolCallId
  readonly toolName: ToolName
  readonly output: unknown
  readonly isError?: boolean
}
export type InvokeToolInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
  readonly toolName: ToolName
  readonly input: unknown
}
export type RequestExtensionInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
  readonly extensionId: ExtensionId
  readonly capabilityId: string
  readonly input: ExtensionRequestInputEnvelope
}
export type TerminateBranchInput = {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
}
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
      id: (p: TurnSubmissionInput) => ({
        entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
        primaryKey: p.message.id,
      }),
    },
    SubmitAndWait: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: (p: TurnSubmissionInput) => ({
        entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
        primaryKey: p.message.id,
      }),
    },
    SubmitDurable: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AgentLoopError,
      persisted: true,
      id: (p: TurnSubmissionInput) => ({
        entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
        primaryKey: p.message.id,
      }),
    },
    Run: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: (p: TurnSubmissionInput) => ({
        entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
        primaryKey: p.message.id,
      }),
    },
    QueueFollowUp: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: (p: TurnSubmissionInput) => ({
        entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
        primaryKey: p.message.id,
      }),
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
    Interrupt: {
      payload: InterruptFields,
      success: Schema.Void,
      error: AgentLoopError,
      persisted: true,
      id: (p: InterruptInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
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
      payload: DrainQueueFields,
      success: QueueSnapshot,
      error: AgentLoopError,
      persisted: true,
      id: (p: DrainQueueInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.commandId,
      }),
    },
    GetQueue: {
      payload: GetQueueFields,
      success: QueueSnapshot,
      error: AgentLoopError,
      id: (p: GetQueueInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.commandId,
      }),
    },
    GetState: {
      payload: GetStateFields,
      success: SessionRuntimeStateSchema,
      error: AgentLoopError,
      id: (p: GetStateInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.commandId,
      }),
    },
    GetMetrics: {
      payload: GetMetricsFields,
      success: SessionRuntimeMetrics,
      error: AgentLoopError,
      id: (p: GetMetricsInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.commandId,
      }),
    },
    // Mid-turn tool result. Dedup by toolCallId — replays of the same tool
    // call must collapse to one effect.
    RecordToolResult: {
      payload: RecordToolResultFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: (p: RecordToolResultInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.toolCallId,
      }),
    },
    // Programmatic tool invocation (server-driven). commandId is required
    // here (vs optional in the legacy command schema) because the actor
    // execution id needs a deterministic primary key — callers that previously
    // elided commandId now generate one before sending.
    InvokeTool: {
      payload: InvokeToolFields,
      success: Schema.Void,
      error: AgentLoopError,
      persisted: true,
      id: (p: InvokeToolInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.commandId,
      }),
    },
    RequestExtension: {
      payload: RequestExtensionFields,
      success: Schema.Unknown,
      error: AgentLoopError,
      id: (p: RequestExtensionInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.commandId,
      }),
    },
    // Branch-local shutdown. Used by session terminate sweeps to close a
    // single branch's loop resources from inside the entity's own scope.
    TerminateBranch: {
      payload: TerminateBranchFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: (p: TerminateBranchInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.commandId,
      }),
    },
  },
  {
    state: {
      schema: SessionRuntimeStateSchema,
      error: AgentLoopError,
    },
  },
)
