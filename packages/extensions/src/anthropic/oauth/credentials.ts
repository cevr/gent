import { Effect, Option, Schema } from "effect"
import { ProviderAuthError } from "@gent/core/extensions/api"

const ClaudeCredentials = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
})

const ClaudeCredentialsWrapper = Schema.Struct({
  claudeAiOauth: ClaudeCredentials,
})

const CredentialBlobSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeCredentialBlob = Schema.decodeUnknownOption(Schema.fromJsonString(CredentialBlobSchema))

const OAuthTokenResponseSchema = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})
const decodeOAuthTokenResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(OAuthTokenResponseSchema),
)

export type ClaudeCredentials = typeof ClaudeCredentials.Type

/**
 * A credential is "fresh enough to use" if it expires more than 60s
 * from now. Below that, callers should refresh before sending it on
 * the wire — the Anthropic auth gate rejects a token in its last
 * minute and a refresh round-trip can take that long.
 */
const FRESH_ENOUGH_MS = 60_000

export const freshEnoughForUse = (creds: ClaudeCredentials, now: number): boolean =>
  creds.expiresAt > now + FRESH_ENOUGH_MS

export const decodeCredentials = (
  raw: string,
): Effect.Effect<ClaudeCredentials, ProviderAuthError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeCredentialsWrapper))(raw).pipe(
    Effect.map((w) => w.claudeAiOauth),
    Effect.catchEager(() =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeCredentials))(raw).pipe(
        Effect.mapError(
          (e) =>
            new ProviderAuthError({
              message: "Invalid Claude credentials JSON",
              cause: e,
            }),
        ),
      ),
    ),
  )

/**
 * Splice fresh credentials into an existing keychain blob, preserving
 * any other fields (e.g. `subscriptionType`, `mcpOAuth`) so a write-back
 * doesn't blow away CLI state. Returns `undefined` if the blob isn't
 * valid JSON. Exported for testing.
 *
 * @internal
 */
export const updateCredentialBlob = (
  existingJson: string,
  newCreds: ClaudeCredentials,
): string | undefined => {
  const decoded = decodeCredentialBlob(existingJson)
  if (Option.isNone(decoded)) return undefined
  const parsed = decoded.value
  const wrapperValue = parsed["claudeAiOauth"]
  const wrapper = isRecord(wrapperValue) ? wrapperValue : undefined
  const target = wrapper ?? parsed
  target["accessToken"] = newCreds.accessToken
  target["refreshToken"] = newCreds.refreshToken
  target["expiresAt"] = newCreds.expiresAt
  return JSON.stringify(parsed)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Parse a raw OAuth refresh response body into `ClaudeCredentials`.
 * Returns `undefined` if the body is not valid JSON, not an object,
 * or missing `access_token`. Defaults `expires_in` to 36 000s (10h) per
 * Anthropic's observed token lifetime. Exported for testing.
 *
 * @internal
 */
export const parseOAuthResponse = (
  raw: string,
  fallbackRefreshToken: string,
  now: number = 0,
): ClaudeCredentials | undefined => {
  const decoded = decodeOAuthTokenResponse(raw)
  if (Option.isNone(decoded)) return undefined
  const data = decoded.value
  if (data.access_token === undefined) return undefined
  const expiresIn = data.expires_in ?? 36_000
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? fallbackRefreshToken,
    expiresAt: now + expiresIn * 1000,
  }
}
