/**
 * AnthropicCredentialService — Claude Code credentials behind the shared
 * credential cache (`../provider-credentials.ts`).
 *
 * The keychain is the source of truth: once the cache TTL lapses the
 * service re-reads it, and only refreshes (OAuth or CLI fallback) when
 * the keychain holds nothing usable. Refreshed credentials are returned
 * directly — re-reading the keychain after refresh would silently lose
 * direct-OAuth tokens whenever write-back failed.
 */

import {
  Clock,
  Context,
  Effect,
  type FileSystem,
  Layer,
  Option,
  type Path,
  SynchronizedRef,
} from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { ProviderAuthError, type ProviderAuthInfo } from "@gent/core/extensions/api"
import { readClaudeCodeCredentials } from "./oauth/accounts.js"
import { ClaudeCredentials, freshEnoughForUse } from "./oauth/credentials.js"
import { PRIMARY_CLAUDE_SERVICE } from "./oauth/keychain.js"
import { refreshClaudeCodeCredentials } from "./oauth/refresh.js"
import type { AnthropicPlatform } from "./platform-adapter.js"
import {
  EMPTY_CREDENTIAL_CELL,
  makeCredentialCache,
  type CredentialCache,
  type CredentialCacheCell,
  type CredentialCacheCellRef,
} from "../provider-credentials.js"

// ── IO seam ──

export type AnthropicCredentialIORequirements =
  | AnthropicPlatform
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path

type CredentialIO = Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError,
  AnthropicCredentialIORequirements
>

/** IO the service depends on, lifted out so tests can drive it without spawning `security` or touching the keychain. */
export interface AnthropicCredentialIO {
  /** Read currently-stored creds for the primary source. */
  readonly read: CredentialIO
  /** Refresh creds for the primary source via OAuth or CLI fallback. */
  readonly refresh: CredentialIO
}

// PRIMARY_CLAUDE_SERVICE is the only source wired here — the multi-account
// picker UI doesn't exist yet. Spelled out so an audit-grep finds every site.
const realIO: AnthropicCredentialIO = {
  read: readClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE),
  refresh: refreshClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE),
}

// ── Service tag ──

export class AnthropicCredentialService extends Context.Service<
  AnthropicCredentialService,
  CredentialCache<ClaudeCredentials>
>()("@gent/extensions/src/anthropic/credential-service/AnthropicCredentialService") {
  /**
   * Production layer. The cache cell is provided externally so its
   * lifetime is hoisted above the per-`resolveModel` layer build; a Ref
   * allocated per build would disable the cache. `authInfo.persist`
   * (when present) durably writes refreshed credentials back to Auth.
   */
  static layerFromRef = (
    cellRef: CredentialCacheCellRef<ClaudeCredentials>,
    authInfo?: ProviderAuthInfo,
  ) => Layer.effect(AnthropicCredentialService, build(cellRef, realIO, authInfo))

  /** Test-friendly variant — accepts the IO seam so tests can drive read/refresh deterministically. */
  static layerFromIO = (io: AnthropicCredentialIO, authInfo?: ProviderAuthInfo) =>
    Layer.effect(
      AnthropicCredentialService,
      SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL).pipe(
        Effect.flatMap((cellRef) => build(cellRef, io, authInfo)),
      ),
    )
}

const build = (
  cellRef: CredentialCacheCellRef<ClaudeCredentials>,
  io: AnthropicCredentialIO,
  authInfo?: ProviderAuthInfo,
): Effect.Effect<CredentialCache<ClaudeCredentials>, never, AnthropicCredentialIORequirements> =>
  Effect.gen(function* () {
    const ioContext = yield* Effect.context<AnthropicCredentialIORequirements>()
    const read = io.read.pipe(Effect.provideContext(ioContext))
    const refresh = io.refresh.pipe(Effect.provideContext(ioContext))
    const cache = yield* makeCredentialCache({
      label: "Anthropic",
      credentials: ClaudeCredentials,
      cellRef,
      authInfo: Option.fromNullishOr(authInfo),
      seed: Option.none(),
      expiresAt: (creds) => creds.expiresAt,
      // A keychain miss surfaces as ProviderAuthError; swallowing it
      // turns the miss into a refresh attempt instead of a failure.
      read: () => Effect.option(read),
      refresh: () =>
        Effect.gen(function* () {
          const refreshed = yield* Effect.option(refresh)
          const now = yield* Clock.currentTimeMillis
          if (Option.isSome(refreshed) && freshEnoughForUse(refreshed.value, now)) {
            return refreshed.value
          }
          return yield* new ProviderAuthError({
            message:
              "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
          })
        }),
      toPersisted: (creds) => ({
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
      }),
    })
    return AnthropicCredentialService.of(cache)
  })
