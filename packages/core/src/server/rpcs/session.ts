import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { SessionId } from "../../domain/ids.js"
import { GentRpcError } from "../errors.js"
import {
  CreateSessionPayload,
  CreateSessionSuccess,
  SessionInfo,
  SessionTreeNodeSchema,
  GetChildSessionsPayload,
  GetSessionTreePayload,
  GetSessionSnapshotPayload,
  SessionSnapshot,
  UpdateSessionBypassPayload,
  UpdateSessionBypassSuccess,
  UpdateSessionReasoningLevelPayload,
  UpdateSessionReasoningLevelSuccess,
  SubscribeEventsPayload,
  EventEnvelope,
  WatchRuntimePayload,
  SessionRuntime,
} from "../transport-contract.js"

export class SessionRpcs extends RpcGroup.make(
  Rpc.make("create", {
    payload: CreateSessionPayload.fields,
    success: CreateSessionSuccess,
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
    payload: GetChildSessionsPayload.fields,
    success: Schema.Array(SessionInfo),
    error: GentRpcError,
  }),
  Rpc.make("getTree", {
    payload: GetSessionTreePayload.fields,
    success: SessionTreeNodeSchema,
    error: GentRpcError,
  }),
  Rpc.make("getSnapshot", {
    payload: GetSessionSnapshotPayload.fields,
    success: SessionSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("updateBypass", {
    payload: UpdateSessionBypassPayload.fields,
    success: UpdateSessionBypassSuccess,
    error: GentRpcError,
  }),
  Rpc.make("updateReasoningLevel", {
    payload: UpdateSessionReasoningLevelPayload.fields,
    success: UpdateSessionReasoningLevelSuccess,
    error: GentRpcError,
  }),
  Rpc.make("events", {
    payload: SubscribeEventsPayload.fields,
    success: EventEnvelope,
    stream: true,
    error: GentRpcError,
  }),
  Rpc.make("watchRuntime", {
    payload: WatchRuntimePayload.fields,
    success: SessionRuntime,
    stream: true,
    error: GentRpcError,
  }),
).prefix("session.") {}
