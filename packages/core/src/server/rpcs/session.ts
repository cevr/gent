import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { BranchId, SessionId } from "../../domain/ids.js"
import { Branch, BranchTreeNode, Message, Session, SessionTreeNode } from "../../domain/message.js"
import { ReasoningEffort } from "../../domain/agent.js"
import { SessionRuntimeStateSchema } from "../../runtime/session-runtime.js"
import { GentRpcError } from "../errors.js"
import {
  CreateBranchInput,
  CreateSessionInput,
  ForkBranchInput,
  GetSessionSnapshotInput,
  QueueSnapshot,
  QueueTarget,
  QueueDrainInput,
  RespondInteractionInput,
  SendMessageInput,
  SessionSnapshot,
  SteerCommand,
  SubscribeEventsInput,
  SwitchBranchInput,
  UpdateSessionReasoningLevelInput,
  EventEnvelope,
} from "../transport-contract.js"

export class SessionRpcs extends RpcGroup.make(
  Rpc.make("session.create", {
    payload: CreateSessionInput.fields,
    success: Schema.Struct({
      sessionId: SessionId,
      branchId: BranchId,
      name: Schema.String,
    }),
    error: GentRpcError,
  }),
  Rpc.make("session.list", {
    success: Schema.Array(Session),
    error: GentRpcError,
  }),
  Rpc.make("session.get", {
    payload: { sessionId: SessionId },
    success: Schema.NullOr(Session),
    error: GentRpcError,
  }),
  Rpc.make("session.delete", {
    payload: { sessionId: SessionId },
    error: GentRpcError,
  }),
  Rpc.make("session.getChildren", {
    payload: { parentSessionId: SessionId },
    success: Schema.Array(Session),
    error: GentRpcError,
  }),
  Rpc.make("session.getTree", {
    payload: { sessionId: SessionId },
    success: SessionTreeNode,
    error: GentRpcError,
  }),
  Rpc.make("session.getSnapshot", {
    payload: GetSessionSnapshotInput.fields,
    success: SessionSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("session.updateReasoningLevel", {
    payload: UpdateSessionReasoningLevelInput.fields,
    success: Schema.Struct({
      reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
    }),
    error: GentRpcError,
  }),
  Rpc.make("session.events", {
    payload: SubscribeEventsInput.fields,
    success: EventEnvelope,
    stream: true,
    error: GentRpcError,
  }),
  Rpc.make("session.watchRuntime", {
    payload: { sessionId: SessionId, branchId: BranchId },
    success: SessionRuntimeStateSchema,
    stream: true,
    error: GentRpcError,
  }),
  Rpc.make("branch.list", {
    payload: { sessionId: SessionId },
    success: Schema.Array(Branch),
    error: GentRpcError,
  }),
  Rpc.make("branch.create", {
    payload: CreateBranchInput.fields,
    success: Schema.Struct({ branchId: BranchId }),
    error: GentRpcError,
  }),
  Rpc.make("branch.getTree", {
    payload: { sessionId: SessionId },
    success: Schema.Array(BranchTreeNode),
    error: GentRpcError,
  }),
  Rpc.make("branch.switch", {
    payload: SwitchBranchInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("branch.fork", {
    payload: ForkBranchInput.fields,
    success: Schema.Struct({ branchId: BranchId }),
    error: GentRpcError,
  }),
  Rpc.make("message.send", {
    payload: SendMessageInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("message.list", {
    payload: { branchId: BranchId },
    success: Schema.Array(Message),
    error: GentRpcError,
  }),
  Rpc.make("steer.command", {
    payload: { command: SteerCommand },
    error: GentRpcError,
  }),
  Rpc.make("queue.drain", {
    payload: QueueDrainInput.fields,
    success: QueueSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("queue.get", {
    payload: QueueTarget.fields,
    success: QueueSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("interaction.respondInteraction", {
    payload: RespondInteractionInput.fields,
    error: GentRpcError,
  }),
) {}
