/**
 * AnthropicCredentialService — Effect-native credential loader.
 *
 * Replaces the Promise-callback `AnthropicCredentialLoader` shape that
 * existed only because the downstream consumer was a `typeof fetch`
 * adapter. With `@effect/ai-anthropic` the consumer is HttpClient
 * middleware reading creds via `mapRequestEffect`, so callbacks become
 * Effects.
 *
 * The cache shape (TTL 30s + 60s freshness margin + refresh-on-stale +
 * durable write-back via `authInfo.persist`) is a verbatim port from
 * the (now-deleted) `runtime-boundary.ts:loadCredentialsEffect`.
 * Persist failures are now typed auth failures instead of warning-only
 * side effects.
 *
 * Why typed errors instead of `Effect<ClaudeCredentials | null>`: the
 * old shape returned `null` to mean "no creds available" because the
 * fetcher then threw an Error string. With Effect-native middleware,
 * `Effect.catchTag("ProviderAuthError", ...)` is the idiomatic
 * short-circuit. Less plumbing, more type-system enforcement.
 */

import { Clock, Context, Effect, FileSystem, Layer, Path, Ref } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { ProviderAuthError, type ProviderAuthInfo } from "@gent/core/extensions/api"
import {
  freshEnoughForUse,
  PRIMARY_CLAUDE_SERVICE,
  readClaudeCodeCredentials,
  refreshClaudeCodeCredentials,
  type ClaudeCredentials,
} from "./oauth.js"

// ── Cache constants ──

const CREDENTIAL_CACHE_TTL_MS = 30_000

// ── Internal cache cell ──

export interface CredentialCacheCell {
  readonly creds: ClaudeCredentials | null
  readonly at: number
}

export const EMPTY_CREDENTIAL_CELL: CredentialCacheCell = { creds: null, at: 0 }

// ── Service interface ──

export interface AnthropicCredentialServiceShape {
  /**
   * Resolve cached/refreshed Claude Code credentials. Fails with
   * `ProviderAuthError` when keychain has no usable credentials and
   * refresh paths exhausted.
   */
  readonly getFresh: Effect.Effect<ClaudeCredentials, ProviderAuthError>
  /** Bust the cache so the next `getFresh` re-reads from keychain or forces a refresh. */
  readonly invalidate: Effect.Effect<void>
}

// ── IO seam ──

/**
 * IO operations the service depends on. Lifted out so tests can drive
 * them deterministically without spawning `security` or hitting the
 * keychain. `layer` wires the real implementations from `oauth.ts`;
 * `layerFromIO` accepts overrides.
 */
export interface AnthropicCredentialIO {
  /** Read currently-stored creds for the primary source. */
  readonly read: Effect.Effect<
    ClaudeCredentials,
    ProviderAuthError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >
  /** Refresh creds for the primary source via OAuth or CLI fallback. */
  readonly refresh: Effect.Effect<
    ClaudeCredentials,
    ProviderAuthError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >
}

const realIO: AnthropicCredentialIO = {
  read: readClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE),
  refresh: refreshClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE),
}

// ── Service tag ──

export class AnthropicCredentialService extends Context.Service<
  AnthropicCredentialService,
  AnthropicCredentialServiceShape
>()("@gent/extensions/src/anthropic/credential-service/AnthropicCredentialService") {
  /**
   * Build the credential service for the OAuth path. `authInfo.persist`
   * (when present) durably writes refreshed credentials back to Auth.
   * Write-back failures fail the credential load so callers never run with
   * refresh state that only exists in process memory.
   *
   * The PRIMARY_CLAUDE_SERVICE source is the only one wired here —
   * multi-account picker UI doesn't exist yet. Spelling out the source
   * so a future audit-grep finds every site that still assumes one
   * account.
   */
  static layer = (
    authInfo?: ProviderAuthInfo,
  ): Layer.Layer<
    AnthropicCredentialService,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > => AnthropicCredentialService.layerFromIO(realIO, authInfo)

  /**
   * Cache cell Ref provided externally so its lifetime is hoisted above the
   * per-`resolveModel` layer build. Without this, every model call reallocates
   * the Ref and effectively disables the cache.
   */
  static layerFromRef = (
    cellRef: Ref.Ref<CredentialCacheCell>,
    authInfo?: ProviderAuthInfo,
  ): Layer.Layer<
    AnthropicCredentialService,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > => AnthropicCredentialService.layerFromRefAndIO(cellRef, realIO, authInfo)

  /**
   * Test-friendly variant — accepts the IO seam as a parameter so tests
   * can drive read/refresh deterministically.
   */
  static layerFromIO = (
    io: AnthropicCredentialIO,
    authInfo?: ProviderAuthInfo,
  ): Layer.Layer<
    AnthropicCredentialService,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > =>
    Layer.effect(
      AnthropicCredentialService,
      Effect.gen(function* () {
        const cellRef = yield* Ref.make<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
        return yield* AnthropicCredentialService.buildShape(cellRef, io, authInfo)
      }),
    )

  static layerFromRefAndIO = (
    cellRef: Ref.Ref<CredentialCacheCell>,
    io: AnthropicCredentialIO,
    authInfo?: ProviderAuthInfo,
  ): Layer.Layer<
    AnthropicCredentialService,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > =>
    Layer.effect(
      AnthropicCredentialService,
      AnthropicCredentialService.buildShape(cellRef, io, authInfo),
    )

  private static buildShape = (
    cellRef: Ref.Ref<CredentialCacheCell>,
    io: AnthropicCredentialIO,
    authInfo: ProviderAuthInfo | undefined,
  ): Effect.Effect<
    AnthropicCredentialServiceShape,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const provideIO = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
        >,
      ): Effect.Effect<A, E> =>
        effect.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        )
      return yield* Effect.sync(() => {
        const persistRefreshed = (
          creds: ClaudeCredentials,
        ): Effect.Effect<void, ProviderAuthError> => {
          const persist = authInfo?.persist
          if (persist === undefined) return Effect.void
          return persist({
            access: creds.accessToken,
            refresh: creds.refreshToken,
            expires: creds.expiresAt,
          }).pipe(
            Effect.catchDefect((cause) =>
              Effect.fail(
                new ProviderAuthError({
                  message: `Failed to persist refreshed Anthropic credentials: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                  cause,
                }),
              ),
            ),
          )
        }

        const getFresh: Effect.Effect<ClaudeCredentials, ProviderAuthError> = Effect.gen(
          function* () {
            const now = yield* Clock.currentTimeMillis
            const cell = yield* Ref.get(cellRef)

            // Cache hit: still warm AND >60s before expiry
            if (
              cell.creds !== null &&
              now - cell.at < CREDENTIAL_CACHE_TTL_MS &&
              freshEnoughForUse(cell.creds, now)
            ) {
              return cell.creds
            }

            // Read from keychain. A read failure surfaces as
            // ProviderAuthError; the catch turns it into a refresh
            // attempt rather than failing immediately.
            const fromKeychain = yield* io.read.pipe(
              Effect.catchTag("ProviderAuthError", () => Effect.succeed(null)),
              provideIO,
            )

            if (fromKeychain !== null && freshEnoughForUse(fromKeychain, now)) {
              yield* Ref.set(cellRef, { creds: fromKeychain, at: now })
              return fromKeychain
            }

            // Either no keychain creds or they're expiring inside the
            // freshness window. Refresh — use the returned creds
            // directly; re-reading keychain after refresh would silently
            // lose direct-OAuth tokens whenever write-back failed.
            const refreshed = yield* io.refresh.pipe(
              Effect.catchTag("ProviderAuthError", () => Effect.succeed(null)),
              provideIO,
            )

            if (refreshed === null || !freshEnoughForUse(refreshed, now)) {
              yield* Ref.set(cellRef, EMPTY_CREDENTIAL_CELL)
              return yield* new ProviderAuthError({
                message:
                  "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
              })
            }

            yield* persistRefreshed(refreshed)
            yield* Ref.set(cellRef, { creds: refreshed, at: now })
            return refreshed
          },
        )

        const invalidate: Effect.Effect<void> = Ref.set(cellRef, EMPTY_CREDENTIAL_CELL)

        return AnthropicCredentialService.of({ getFresh, invalidate })
      })
    })
}
