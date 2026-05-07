import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { BranchId, SessionId } from "../../domain/ids.js"
import { Session, SessionTreeNode } from "../../domain/message.js"
import { ReasoningEffort } from "../../domain/agent.js"
import { SessionRuntimeStateSchema } from "../../runtime/session-runtime.js"
import { GentRpcError } from "../errors.js"
import {
  CreateSessionInput,
  GetSessionSnapshotInput,
  SessionSnapshot,
  UpdateSessionReasoningLevelInput,
  SubscribeEventsInput,
  EventEnvelope,
} from "../transport-contract.js"

export class SessionRpcs extends RpcGroup.make(
  Rpc.make("create", {
    payload: CreateSessionInput.fields,
    success: Schema.Struct({
      sessionId: SessionId,
      branchId: BranchId,
      name: Schema.String,
    }),
    error: GentRpcError,
  }),
  Rpc.make("list", {
    success: Schema.Array(Session),
    error: GentRpcError,
  }),
  Rpc.make("get", {
    payload: { sessionId: SessionId },
    success: Schema.NullOr(Session),
    error: GentRpcError,
  }),
  Rpc.make("delete", {
    payload: { sessionId: SessionId },
    error: GentRpcError,
  }),
  Rpc.make("getChildren", {
    payload: { parentSessionId: SessionId },
    success: Schema.Array(Session),
    error: GentRpcError,
  }),
  Rpc.make("getTree", {
    payload: { sessionId: SessionId },
    success: SessionTreeNode,
    error: GentRpcError,
  }),
  Rpc.make("getSnapshot", {
    payload: GetSessionSnapshotInput.fields,
    success: SessionSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("updateReasoningLevel", {
    payload: UpdateSessionReasoningLevelInput.fields,
    success: Schema.Struct({
      reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
    }),
    error: GentRpcError,
  }),
  Rpc.make("events", {
    payload: SubscribeEventsInput.fields,
    success: EventEnvelope,
    stream: true,
    error: GentRpcError,
  }),
  Rpc.make("watchRuntime", {
    payload: { sessionId: SessionId, branchId: BranchId },
    success: SessionRuntimeStateSchema,
    stream: true,
    error: GentRpcError,
  }),
).prefix("session.") {}
