/**
 * OpenAICredentialService — ChatGPT OAuth (Codex) credentials behind the
 * shared credential cache (`../provider-credentials.ts`).
 *
 * There is no keychain: the initial credentials come from `authInfo` and
 * the cache cell is the sole copy of the rotated refresh token until
 * persist write-back lands. The refresh path therefore always prefers
 * the held credential's refresh token over the bootstrap one — the OAuth
 * server may have revoked the bootstrap token when it issued the rotation.
 */

import { Context, Effect, Layer, Option, Schema, SynchronizedRef } from "effect"
import { ProviderAuthError, type ProviderAuthInfo } from "@gent/core/extensions/api"
import { refreshOpenAIOauth } from "./oauth.js"
import {
  EMPTY_CREDENTIAL_CELL,
  makeCredentialCache,
  type CredentialCache,
  type CredentialCacheCell,
  type CredentialCacheCellRef,
} from "../providers.js"

// ── Credential shape (matches AuthOauth) ──

export interface OpenAICredentials {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId: Option.Option<string>
}

const OpenAICredentials: Schema.Schema<OpenAICredentials> = Schema.Struct({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Finite,
  accountId: Schema.OptionFromOptional(Schema.String),
})

// ── IO seam ──

/** IO the service depends on, lifted out so tests can drive it without hitting `auth.openai.com`. */
export interface OpenAICredentialIO {
  /** Refresh creds against the OpenAI token endpoint. */
  readonly refresh: (refreshToken: string) => Effect.Effect<OpenAICredentials, ProviderAuthError>
}

const realIO: OpenAICredentialIO = {
  refresh: (refreshToken: string) =>
    refreshOpenAIOauth(refreshToken).pipe(
      Effect.map((credentials) => ({
        ...credentials,
        accountId: Option.fromNullishOr(credentials.accountId),
      })),
      Effect.mapError(
        (cause) =>
          new ProviderAuthError({
            message: `Failed to refresh ChatGPT OAuth credentials: ${cause.message}`,
            cause,
          }),
      ),
    ),
}

// ── Service tag ──

export class OpenAICredentialService extends Context.Service<
  OpenAICredentialService,
  CredentialCache<OpenAICredentials>
>()("@gent/extensions/src/openai/credential-service/OpenAICredentialService") {
  /**
   * Production layer. The cache cell is provided externally so its
   * lifetime is hoisted above the per-`resolveModel` layer build; a Ref
   * allocated per build would disable the cache and the rotated
   * refresh-token contract. `authInfo.persist` (when present) durably
   * writes refreshed credentials back to Auth.
   */
  static layerFromRef = (
    cellRef: CredentialCacheCellRef<OpenAICredentials>,
    authInfo: ProviderAuthInfo,
  ) => OpenAICredentialService.layerFromRefAndIO(cellRef, realIO, authInfo)

  /** Test-friendly variant — accepts the IO seam so tests can drive `refresh` deterministically. */
  static layerFromIO = (io: OpenAICredentialIO, authInfo: ProviderAuthInfo) =>
    Layer.effect(
      OpenAICredentialService,
      SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL).pipe(
        Effect.flatMap((cellRef) => build(cellRef, io, authInfo)),
      ),
    )

  static layerFromRefAndIO = (
    cellRef: CredentialCacheCellRef<OpenAICredentials>,
    io: OpenAICredentialIO,
    authInfo: ProviderAuthInfo,
  ) => Layer.effect(OpenAICredentialService, build(cellRef, io, authInfo))
}

const seedFromAuthInfo = (authInfo: ProviderAuthInfo): Option.Option<OpenAICredentials> => {
  const access = Option.getOrElse(Option.fromNullishOr(authInfo.access), () => "")
  const refresh = Option.getOrElse(Option.fromNullishOr(authInfo.refresh), () => "")
  if (access.length === 0 && refresh.length === 0) return Option.none()
  return Option.some({
    access,
    refresh,
    expires: Option.getOrElse(Option.fromNullishOr(authInfo.expires), () => 0),
    accountId: Option.fromNullishOr(authInfo.accountId),
  })
}

const build = (
  cellRef: CredentialCacheCellRef<OpenAICredentials>,
  io: OpenAICredentialIO,
  authInfo: ProviderAuthInfo,
): Effect.Effect<CredentialCache<OpenAICredentials>> =>
  makeCredentialCache({
    label: "OpenAI",
    credentials: OpenAICredentials,
    cellRef,
    authInfo: Option.some(authInfo),
    seed: seedFromAuthInfo(authInfo),
    expiresAt: (creds) => creds.expires,
    read: (cached) => Effect.succeed(cached),
    refresh: (held) => {
      // The held token is the most recently rotated one; the bootstrap
      // `authInfo.refresh` only applies before any rotation.
      const refreshToken = held.pipe(
        Option.map((creds) => creds.refresh),
        Option.orElse(() => Option.fromNullishOr(authInfo.refresh)),
      )
      if (Option.isNone(refreshToken) || refreshToken.value.length === 0) {
        return Effect.fail(
          new ProviderAuthError({
            message:
              "ChatGPT OAuth credentials are unavailable. Re-run authorization from the auth picker.",
          }),
        )
      }
      // Carry the prior accountId forward when the refresh response omits it.
      const previousAccountId = held.pipe(Option.flatMap((creds) => creds.accountId))
      return io.refresh(refreshToken.value).pipe(
        Effect.map((refreshed) => ({
          ...refreshed,
          accountId: Option.orElse(refreshed.accountId, () => previousAccountId),
        })),
      )
    },
    toPersisted: (creds) => ({
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      accountId: Option.getOrUndefined(creds.accountId),
    }),
  }).pipe(Effect.map(OpenAICredentialService.of))
