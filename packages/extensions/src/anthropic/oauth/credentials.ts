import { Effect, Option, Schema } from "effect"
import { ProviderAuthError } from "@gent/core/extensions/api"

const ClaudeCredentials = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Finite,
})

const ClaudeCredentialsWrapper = Schema.Struct({
  claudeAiOauth: ClaudeCredentials,
})

const CredentialBlobSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeCredentialBlob = Schema.decodeUnknownOption(Schema.fromJsonString(CredentialBlobSchema))

const OAuthTokenResponseSchema = Schema.Struct({
  access_token: Schema.OptionFromOptional(Schema.String),
  refresh_token: Schema.OptionFromOptional(Schema.String),
  expires_in: Schema.OptionFromOptional(Schema.Finite),
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
  Schema.decodeEffect(Schema.fromJsonString(ClaudeCredentialsWrapper))(raw).pipe(
    Effect.map((w) => w.claudeAiOauth),
    Effect.catchEager(() =>
      Schema.decodeEffect(Schema.fromJsonString(ClaudeCredentials))(raw).pipe(
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
 * doesn't blow away CLI state. Returns `None` if the blob isn't
 * valid JSON. Exported for testing.
 *
 * @internal
 */
export const updateCredentialBlob = (
  existingJson: string,
  newCreds: ClaudeCredentials,
): Option.Option<string> => {
  const decoded = decodeCredentialBlob(existingJson)
  if (Option.isNone(decoded)) return Option.none()
  const parsed = decoded.value
  const wrapperValue = parsed["claudeAiOauth"]
  const wrapper = Schema.decodeUnknownOption(CredentialBlobSchema)(wrapperValue)
  const credentialFields = {
    accessToken: newCreds.accessToken,
    refreshToken: newCreds.refreshToken,
    expiresAt: newCreds.expiresAt,
  }
  let next: typeof parsed = { ...parsed, ...credentialFields }
  if (Option.isSome(wrapper)) {
    next = { ...parsed, claudeAiOauth: { ...wrapper.value, ...credentialFields } }
  }
  return Option.some(Schema.encodeSync(Schema.fromJsonString(CredentialBlobSchema))(next))
}

/**
 * Parse a raw OAuth refresh response body into `ClaudeCredentials`.
 * Returns `None` if the body is not valid JSON, not an object,
 * or missing `access_token`. Defaults `expires_in` to 36 000s (10h) per
 * Anthropic's observed token lifetime. Exported for testing.
 *
 * @internal
 */
export const parseOAuthResponse = (
  raw: string,
  fallbackRefreshToken: string,
  now: number = 0,
): Option.Option<ClaudeCredentials> => {
  const decoded = decodeOAuthTokenResponse(raw)
  if (Option.isNone(decoded)) return Option.none()
  const data = decoded.value
  if (Option.isNone(data.access_token)) return Option.none()
  const expiresIn = Option.getOrElse(data.expires_in, () => 36_000)
  return Option.some({
    accessToken: data.access_token.value,
    refreshToken: Option.getOrElse(data.refresh_token, () => fallbackRefreshToken),
    expiresAt: now + expiresIn * 1000,
  })
}
