import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { GentRpcError } from "../errors.js"
import {
  AuthProviderInfo,
  SetAuthKeyPayload,
  DeleteAuthKeyPayload,
  ListAuthMethodsSuccess,
  AuthorizeAuthPayload,
  AuthorizeAuthSuccess,
  CallbackAuthPayload,
} from "../transport-contract.js"

export class AuthRpcs extends RpcGroup.make(
  Rpc.make("listProviders", {
    success: Schema.Array(AuthProviderInfo),
    error: GentRpcError,
  }),
  Rpc.make("setKey", {
    payload: SetAuthKeyPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("deleteKey", {
    payload: DeleteAuthKeyPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("listMethods", {
    success: ListAuthMethodsSuccess,
    error: GentRpcError,
  }),
  Rpc.make("authorize", {
    payload: AuthorizeAuthPayload.fields,
    success: AuthorizeAuthSuccess,
    error: GentRpcError,
  }),
  Rpc.make("callback", {
    payload: CallbackAuthPayload.fields,
    error: GentRpcError,
  }),
).prefix("auth.") {}
