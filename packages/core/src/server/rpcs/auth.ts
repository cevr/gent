import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { GentRpcError } from "../errors.js"
import {
  AuthProviderInfo,
  ListAuthProvidersInput,
  SetAuthKeyInput,
  DeleteAuthKeyInput,
  ListAuthMethodsSuccess,
  AuthorizeAuthInput,
  AuthorizeAuthSuccess,
  CallbackAuthInput,
} from "../transport-contract.js"

export class AuthRpcs extends RpcGroup.make(
  Rpc.make("listProviders", {
    payload: ListAuthProvidersInput.fields,
    success: Schema.Array(AuthProviderInfo),
    error: GentRpcError,
  }),
  Rpc.make("setKey", {
    payload: SetAuthKeyInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("deleteKey", {
    payload: DeleteAuthKeyInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("listMethods", {
    success: ListAuthMethodsSuccess,
    error: GentRpcError,
  }),
  Rpc.make("authorize", {
    payload: AuthorizeAuthInput.fields,
    success: AuthorizeAuthSuccess,
    error: GentRpcError,
  }),
  Rpc.make("callback", {
    payload: CallbackAuthInput.fields,
    error: GentRpcError,
  }),
).prefix("auth.") {}
