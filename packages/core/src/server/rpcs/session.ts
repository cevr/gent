import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { SessionId } from "../../domain/ids.js"
import { GentRpcError } from "../errors.js"
import {
  CreateSessionInput,
  CreateSessionResult,
  SessionInfo,
  SessionTreeNodeSchema,
  GetChildSessionsInput,
  GetSessionTreeInput,
  GetSessionSnapshotInput,
  SessionSnapshot,
  UpdateSessionReasoningLevelInput,
  UpdateSessionReasoningLevelResult,
  SubscribeEventsInput,
  EventEnvelope,
  WatchRuntimeInput,
  SessionRuntime,
} from "../transport-contract.js"

export class SessionRpcs extends RpcGroup.make(
  Rpc.make("create", {
    payload: CreateSessionInput.fields,
    success: CreateSessionResult,
    error: GentRpcError,
  }),
  Rpc.make("list", {
    success: Schema.Array(SessionInfo),
    error: GentRpcError,
  }),
  Rpc.make("get", {
    payload: { sessionId: SessionId },
    success: Schema.NullOr(SessionInfo),
    error: GentRpcError,
  }),
  Rpc.make("delete", {
    payload: { sessionId: SessionId },
    error: GentRpcError,
  }),
  Rpc.make("getChildren", {
    payload: GetChildSessionsInput.fields,
    success: Schema.Array(SessionInfo),
    error: GentRpcError,
  }),
  Rpc.make("getTree", {
    payload: GetSessionTreeInput.fields,
    success: SessionTreeNodeSchema,
    error: GentRpcError,
  }),
  Rpc.make("getSnapshot", {
    payload: GetSessionSnapshotInput.fields,
    success: SessionSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("updateReasoningLevel", {
    payload: UpdateSessionReasoningLevelInput.fields,
    success: UpdateSessionReasoningLevelResult,
    error: GentRpcError,
  }),
  Rpc.make("events", {
    payload: SubscribeEventsInput.fields,
    success: EventEnvelope,
    stream: true,
    error: GentRpcError,
  }),
  Rpc.make("watchRuntime", {
    payload: WatchRuntimeInput.fields,
    success: SessionRuntime,
    stream: true,
    error: GentRpcError,
  }),
).prefix("session.") {}
