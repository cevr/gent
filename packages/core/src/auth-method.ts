import { Schema } from "effect"

export const AuthMethodType = Schema.Literals(["oauth", "api"])
export type AuthMethodType = typeof AuthMethodType.Type

export class AuthMethod extends Schema.Class<AuthMethod>("AuthMethod")({
  type: AuthMethodType,
  label: Schema.String,
}) {}

export const AuthAuthorizationMethod = Schema.Literals(["auto", "code"])
export type AuthAuthorizationMethod = typeof AuthAuthorizationMethod.Type

export class AuthAuthorization extends Schema.Class<AuthAuthorization>("AuthAuthorization")({
  authorizationId: Schema.String,
  url: Schema.String,
  method: AuthAuthorizationMethod,
  instructions: Schema.optional(Schema.String),
}) {}
