/**
 * Cached provider credential with single-flight refresh.
 *
 * One `SynchronizedRef` cell holds the credential. `getFresh` serves the
 * cell while it is warm (TTL 30s) and usable (expires more than 60s from
 * now), consults the provider's source of truth once the TTL lapses,
 * and refreshes when nothing usable remains. `SynchronizedRef.modifyEffect`
 * makes concurrent stale calls share one refresh.
 *
 * A refreshed credential is written back through `authInfo.persist`.
 * When that write fails the credential is kept as `PendingPersist`: the
 * caller sees the failure, the rotated refresh token survives, and the
 * next `getFresh` retries the write before serving anything.
 *
 * `invalidate` marks the cell so the next `getFresh` skips the cache
 * but keeps the held credential — its refresh token is the only copy a
 * provider without a keychain has.
 *
 * Providers own their Tag, credential schema, IO, and the three hooks
 * (`read`, `refresh`, `toPersisted`); this module owns the cache.
 */

import { Clock, Effect, Exit, Option, Schema, SynchronizedRef } from "effect"
import { ProviderAuthError, type ProviderAuthInfo } from "@gent/core/extensions/api"

const CREDENTIAL_CACHE_TTL_MS = 30_000

/**
 * A credential is "fresh enough to use" if it expires more than 60s
 * from now. Below that, callers should refresh before sending it on
 * the wire — provider auth gates reject a token in its last minute and
 * a refresh round-trip can take that long.
 */
const FRESH_ENOUGH_MS = 60_000

export const freshEnoughAt = (expiresAt: number, now: number): boolean =>
  expiresAt > now + FRESH_ENOUGH_MS

// ── Cache cell ──

export const CredentialCacheCell = <C>(credentials: Schema.Schema<C>) =>
  Schema.TaggedUnion({
    Empty: {},
    Durable: { creds: credentials, at: Schema.Finite, invalidated: Schema.Boolean },
    PendingPersist: { creds: credentials, at: Schema.Finite, invalidated: Schema.Boolean },
  })
export type CredentialCacheCell<C> = ReturnType<typeof CredentialCacheCell<C>>["Type"]
export type CredentialCacheCellRef<C> = SynchronizedRef.SynchronizedRef<CredentialCacheCell<C>>

export const EMPTY_CREDENTIAL_CELL = Schema.TaggedStruct("Empty", {}).make({})

// ── Cache ──

export interface CredentialCache<C> {
  /** Resolve cached/refreshed credentials. Fails with `ProviderAuthError` when no usable credential can be obtained. */
  readonly getFresh: Effect.Effect<C, ProviderAuthError>
  /** Skip the cache on the next `getFresh` without dropping the held credential. */
  readonly invalidate: Effect.Effect<void>
}

type PersistedCredentials = Parameters<NonNullable<ProviderAuthInfo["persist"]>>[0]

export interface CredentialCacheConfig<C> {
  /** Provider name used in persist failure messages. */
  readonly label: string
  readonly credentials: Schema.Schema<C>
  readonly cellRef: CredentialCacheCellRef<C>
  readonly authInfo: Option.Option<ProviderAuthInfo>
  /** Credentials placed in the cell at build time when it is still empty. */
  readonly seed: Option.Option<C>
  readonly expiresAt: (creds: C) => number
  /**
   * Source of truth consulted once the cache is older than the TTL.
   * Receives the cached credential while it is still trusted; a provider
   * without an external store returns it as-is.
   */
  readonly read: (cached: Option.Option<C>) => Effect.Effect<Option.Option<C>>
  /** Obtain new credentials. Receives the held credential (its refresh token is the most recently rotated one). */
  readonly refresh: (held: Option.Option<C>) => Effect.Effect<C, ProviderAuthError>
  readonly toPersisted: (creds: C) => PersistedCredentials
}

export const makeCredentialCache = <C>(
  config: CredentialCacheConfig<C>,
): Effect.Effect<CredentialCache<C>> =>
  Effect.gen(function* () {
    const Cell = CredentialCacheCell(config.credentials)
    const durable = (creds: C, at: number, invalidated: boolean): CredentialCacheCell<C> =>
      Cell.cases.Durable.make({ creds, at, invalidated })
    const pending = (creds: C, at: number): CredentialCacheCell<C> =>
      Cell.cases.PendingPersist.make({ creds, at, invalidated: false })

    // First-touch seed: externally-owned cells may already hold fresher
    // creds from a prior layer build within the same extension instance.
    yield* SynchronizedRef.update(config.cellRef, (cell) => {
      if (cell._tag !== "Empty" || Option.isNone(config.seed)) return cell
      return durable(config.seed.value, 0, false)
    })

    const persist = (creds: C): Effect.Effect<void, ProviderAuthError> => {
      const write = config.authInfo.pipe(
        Option.flatMap((info) => Option.fromNullishOr(info.persist)),
      )
      if (Option.isNone(write)) return Effect.void
      return write.value(config.toPersisted(creds)).pipe(
        Effect.catchDefect((cause) => {
          let message = String(cause)
          if (cause instanceof Error) message = cause.message
          return Effect.fail(
            new ProviderAuthError({
              message: `Failed to persist refreshed ${config.label} credentials: ${message}`,
              cause,
            }),
          )
        }),
      )
    }

    // A write-back that failed earlier is retried before anything is served.
    const settlePending = (
      cell: CredentialCacheCell<C>,
      now: number,
    ): Effect.Effect<CredentialCacheCell<C>, ProviderAuthError> => {
      if (cell._tag !== "PendingPersist") return Effect.succeed(cell)
      return persist(cell.creds).pipe(Effect.map(() => durable(cell.creds, now, cell.invalidated)))
    }

    const trusted = (cell: CredentialCacheCell<C>): Option.Option<C> => {
      if (cell._tag === "Durable" && !cell.invalidated) return Option.some(cell.creds)
      return Option.none()
    }

    const getFresh: Effect.Effect<C, ProviderAuthError> = SynchronizedRef.modifyEffect(
      config.cellRef,
      (
        cell,
      ): Effect.Effect<
        readonly [Exit.Exit<C, ProviderAuthError>, CredentialCacheCell<C>],
        ProviderAuthError
      > =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const current = yield* settlePending(cell, now)
          const cached = trusted(current)

          if (
            current._tag === "Durable" &&
            Option.isSome(cached) &&
            now - current.at < CREDENTIAL_CACHE_TTL_MS &&
            freshEnoughAt(config.expiresAt(cached.value), now)
          ) {
            return [Exit.succeed(cached.value), current]
          }

          const fromSource = yield* config.read(cached)
          if (Option.isSome(fromSource) && freshEnoughAt(config.expiresAt(fromSource.value), now)) {
            return [Exit.succeed(fromSource.value), durable(fromSource.value, now, false)]
          }

          // Refresh failure leaves the cell untouched: the held refresh
          // token survives so a retry can re-attempt with it.
          let held = Option.none<C>()
          if (current._tag !== "Empty") held = Option.some(current.creds)
          const refreshed = yield* config.refresh(held)
          const persisted = Exit.map(yield* Effect.exit(persist(refreshed)), () => refreshed)
          if (Exit.isFailure(persisted)) return [persisted, pending(refreshed, now)]
          return [persisted, durable(refreshed, now, false)]
        }),
    ).pipe(Effect.flatten)

    const invalidate: Effect.Effect<void> = SynchronizedRef.update(config.cellRef, (cell) => {
      if (cell._tag === "Empty") return cell
      return { ...cell, invalidated: true }
    })

    return { getFresh, invalidate }
  })
