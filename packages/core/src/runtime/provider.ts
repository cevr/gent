import {
  Array as Arr,
  Cause,
  Clock,
  Config,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Predicate,
  Random,
  Ref,
  Result,
  Schedule,
  Schema,
  type Scope,
  Semaphore,
  Stream,
  Struct,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ModelCatalogSnapshotStorage } from "../storage/storage.js"
import { type ExtensionModelsService, ExtensionServiceError } from "../domain/extension.js"
import {
  AgentName,
  byReleaseDateDesc,
  calculateCost,
  Model,
  ModelId,
  type ModelPricing,
  parseModelId,
  ProviderId,
} from "../domain/agent.js"
import { CredentialSlot, DEFAULT_CREDENTIAL_SLOT, SessionId, ToolCallId } from "../domain/ids.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "./extension-host.js"
import { causeMessage, type JsonRecord, omitUndefined } from "../domain/guards.js"
import { wireToolName } from "../domain/capability.js"
import {
  AuthAuthorizationMethod,
  AuthMetadata,
  AuthMethod,
  type AuthPrompt,
  CatalogLimit,
  type ApiClassContribution,
  apiClassFor,
  type ApiEndpoint,
  type CatalogModel,
  catalogModelEntry,
  type CatalogProvider,
  DEFAULT_RETRY_POLICY,
  DriverError,
  DriverFailureId,
  type ModelCatalogView,
  type ModelDriverContribution,
  type ModelRouterContribution,
  modelFromCatalog,
  ReasoningOption,
  HeldRotation,
  HeldRotationUndecodable,
  type LockSourceRotation,
  type PendingRotation,
  type PersistAuth,
  authMethodAppliesTo,
  type CredentialFailureReason,
  credentialFailureMessage,
  credentialFailureReason,
  CredentialStoreBusy,
  type CredentialReceipt,
  ProviderAuthError,
  ProviderAuthInfo,
  type ProviderHints,
  type ProviderResolution,
  type LaneAccount,
  type LaneReport,
  LaneUnavailable,
  type LaneWindow,
  type ProviderLanes,
  type QuotaReading,
  type RetryPolicy,
  type StoredOAuthCredentials,
  type VirtualModel,
} from "../domain/driver.js"
import { GentPlatform, resolveDataDir, writeFileAtomic } from "./gent-platform.js"
import { type ProviderConfig, type ProviderConfigEntry, RuntimeEnvironment } from "./config.js"
import { DecisionModel, LanguageModel } from "effect/ai"
import { ProviderError } from "../domain/errors.js"
import * as AiError from "effect/ai/AiError"
import type { ProviderOptions } from "effect/ai/LanguageModel"
import * as Prompt from "effect/ai/Prompt"
import * as Response from "effect/ai/Response"
import * as AiTool from "effect/ai/Tool"
import type * as AiToolkit from "effect/ai/Toolkit"

// ── auth ────────────────────────────────────────────────────────────────────

/**
 * Every auth concept gent uses beyond the driver's own sign-in methods
 * (`AuthMethod`, in domain/driver.ts): the authorization, the store, its persistence,
 * and the guard.
 * Each provider's auth blob is one URL-encoded JSON file under the configured
 * directory (default `~/.gent/auth/`), mode 0600, replaced atomically. The
 * schema is `AuthInfo`, a tagged enum with `Api | Oauth` variants.
 */

// ── auth authorization wire type ────────────────────────────────────────────

export class AuthAuthorization extends Schema.Class<
  AuthAuthorization,
  { readonly brand: unique symbol }
>("AuthAuthorization")({
  authorizationId: Schema.String,
  url: Schema.String,
  method: AuthAuthorizationMethod,
  instructions: Schema.optional(Schema.String),
}) {}

// ── stored auth ─────────────────────────────────────────────────────────────

/**
 * `AuthInfo`: the variants persisted in the store.
 *
 * - `Api`   — bearer/API key; presented to the model driver as `key`, with
 *             the answers to its method's prompts as `metadata` (absent in a
 *             record stored without any).
 * - `Oauth` — refreshable bearer token + expiry; driver may rotate. Its
 *             `metadata` is what its sign-in stored beside the tokens (a
 *             linked directory), absent in a record stored without any; a
 *             refresh and a rename keep it.
 *
 * `signedInAt` is when the credential was signed in or replaced, stamped by
 * the store's `set` (a refresh through `update` keeps it). A record stored
 * before the stamp has none.
 *
 * There is no "ambient auth owned by the driver" variant. Drivers that own
 * auth out-of-band (e.g. Claude Code SDK reading the OS keychain) bypass the
 * auth store entirely; add the variant when a caller needs a persisted
 * presence marker for one.
 */
export const AuthInfo = Schema.TaggedUnion({
  Api: {
    type: Schema.Literal("api"),
    key: Schema.String,
    metadata: Schema.optional(AuthMetadata),
    signedInAt: Schema.optional(Schema.Finite),
  },
  Oauth: {
    type: Schema.Literal("oauth"),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Finite,
    accountId: Schema.optional(Schema.String),
    metadata: Schema.optional(AuthMetadata),
    signedInAt: Schema.optional(Schema.Finite),
  },
})
export type AuthInfo = Schema.Schema.Type<typeof AuthInfo>

export const AuthApi = AuthInfo.cases.Api
export type AuthApi = typeof AuthInfo.cases.Api.Type
const AuthOauth = AuthInfo.cases.Oauth
type AuthOauth = typeof AuthInfo.cases.Oauth.Type

// ── auth guard wire types ───────────────────────────────────────────────────

/** Where a provider's credential comes from: the auth store, or the driver's env variable. */
const AuthSource = Schema.Literals(["none", "stored", "env"])
type AuthSource = typeof AuthSource.Type

export const AuthProviderInfo = Schema.Struct({
  provider: ProviderId,
  credentials: Schema.optional(
    Schema.Array(
      Schema.Struct({
        slot: CredentialSlot,
        hasKey: Schema.Boolean,
        source: AuthSource,
        authType: Schema.optional(AuthMethod.fields.type),
        missing: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
  /** The driver's display name ("OpenCode"); a client shows it in place of the id. */
  name: Schema.optional(Schema.String),
  /** The sign-in is ready: a credential, and an answer to each prompt it needs. */
  hasKey: Schema.Boolean,
  source: Schema.optional(AuthSource),
  authType: Schema.optional(AuthMethod.fields.type),
  required: Schema.Boolean,
  /**
   * The labels of the prompts a credential still lacks (an `AuthPrompt` that
   * is not `optional`, with no stored answer and no variable set). Present
   * only on a credential that is not ready for it: `hasKey` is false.
   */
  missing: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The `providers` config entries that name different `authOrder` lists
   * for this sign-in. Present only when they conflict: the sign-in runs no
   * turn and `hasKey` is false until they agree.
   */
  orderConflict: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The order a turn walks the credentials in, first to last: the config's
   * `authOrder`, else the default alone. Present with `credentials`; a
   * conflicting order reads as the default alone.
   */
  authOrder: Schema.optional(Schema.Array(CredentialSlot)),
})
export type AuthProviderInfo = typeof AuthProviderInfo.Type

/**
 * Public RPC payload for `auth.listProviders`, read in the session's profile.
 * `agentName` adds that agent's model to the providers that need auth; an
 * unknown `sessionId` fails.
 */
export const ListAuthProvidersPayload = Schema.Struct({
  agentName: Schema.optional(AgentName),
  sessionId: SessionId,
})
export type ListAuthProvidersPayload = typeof ListAuthProvidersPayload.Type

// ── auth service ────────────────────────────────────────────────────────────

export class AuthError extends Schema.TaggedError<AuthError, { readonly brand: unique symbol }>()(
  "AuthError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    /**
     * The provider's lock stayed held by another holder for the whole wait:
     * nothing ran under it, and a later attempt may pass. Only a lock's
     * acquisition sets it.
     */
    lockBusy: Schema.optional(Schema.Boolean),
  },
) {}

/** A stored entry that does not decode: a corrupt file, or one an older writer tore. */
class AuthEntryInvalid extends Schema.TaggedError<
  AuthEntryInvalid,
  { readonly brand: unique symbol }
>()("AuthEntryInvalid", {
  cause: Schema.Defect(),
}) {}

/** The raw store under `serializeAuthStore`; it neither locks nor discards. */
interface AuthStoreAccess {
  /** The slots `provider` stores a credential in, the default first. */
  readonly listSlots: (provider: string) => Effect.Effect<ReadonlyArray<CredentialSlot>, AuthError>
  readonly get: (
    provider: string,
    slot?: CredentialSlot,
    // oxlint-disable-next-line effect/noNullish -- Auth lookup uses undefined when a provider has no stored credentials.
  ) => Effect.Effect<AuthInfo | undefined, AuthError | AuthEntryInvalid>
  readonly set: (
    provider: string,
    info: AuthInfo,
    slot?: CredentialSlot,
  ) => Effect.Effect<void, AuthError>
  readonly remove: (provider: string, slot?: CredentialSlot) => Effect.Effect<void, AuthError>
  /** The provider ids an entry is stored under, decoded or not. */
  readonly list: Effect.Effect<ReadonlyArray<string>, AuthError>
  /**
   * What `provider`'s driver holds for `source` (`HeldRotation`); none when it
   * holds none. A file that does not decode fails `HeldRotationUndecodable`.
   */
  readonly getRotation: (
    provider: string,
    source: string,
  ) => Effect.Effect<Option.Option<HeldRotation>, AuthError | HeldRotationUndecodable>
  /** Hold `next` for `source`, or remove what is held. */
  readonly setRotation: (
    provider: string,
    source: string,
    next: Option.Option<PendingRotation>,
  ) => Effect.Effect<void, AuthError>
  /**
   * Move the file held for `source` aside to a sibling and return its path,
   * keeping the record of it with `base` at its place (none: nothing).
   */
  readonly moveRotationAside: (
    provider: string,
    source: string,
    base: Option.Option<string>,
  ) => Effect.Effect<string, AuthError>
}

export interface AuthService {
  readonly listSlots: (provider: string) => Effect.Effect<ReadonlyArray<CredentialSlot>, AuthError>
  /**
   * The provider ids an entry is stored under: what tells a generic provider
   * with a stored key from the rest without one read per provider.
   */
  readonly list: Effect.Effect<ReadonlyArray<string>, AuthError>
  readonly get: (
    provider: string,
    slot?: CredentialSlot,
    // oxlint-disable-next-line effect/noNullish -- Auth lookup uses undefined when a provider has no stored credentials.
  ) => Effect.Effect<AuthInfo | undefined, AuthError>
  readonly set: (
    provider: string,
    info: AuthInfo,
    slot?: CredentialSlot,
    /** Runs exactly once after successful persistence under the commit mask. */
    onPersisted?: Effect.Effect<void, never, never>,
  ) => Effect.Effect<void, AuthError>
  readonly remove: (provider: string, slot?: CredentialSlot) => Effect.Effect<void, AuthError>
  /**
   * Move a credential to another slot under the provider's lock: the same
   * credential, sign-in stamp and all, under the new label. Fails when
   * `from` holds none or `to` holds one already.
   */
  readonly rename: (
    provider: string,
    from: CredentialSlot,
    to: CredentialSlot,
  ) => Effect.Effect<void, AuthError>
  /**
   * Read, then maybe write, one provider's credential. `f` receives what the
   * store holds now and returns a result plus the credential to write (none
   * leaves the store as it is). `set`, `remove` and `update` for one
   * provider run one at a time, so a sign-in and a token refresh in any
   * profile never interleave.
   */
  readonly update: <A, E>(
    provider: string,
    f: (
      current: Option.Option<AuthInfo>,
    ) => Effect.Effect<readonly [A, Option.Option<AuthInfo>], E>,
    slot?: CredentialSlot,
  ) => Effect.Effect<A, E | AuthError>
  /**
   * Run `use` with the rotation `provider`'s driver holds for `source`, under
   * the provider's lock: the lock of `set`, `remove` and `update`, so two
   * refreshes of one source, in any profile or any process over the store,
   * never interleave. A rotation is no credential of a label: no listing
   * shows it, and a rename or a removal leaves it.
   *
   * A `write` the disk does not take still succeeds: the store holds the
   * rotation in its memory, and `read` returns it, until a later write lands
   * or a forget clears it (a forget then leaves the disk as it is). Only this
   * store sees it, and only while the process runs.
   *
   * A file that does not decode is never discarded: `read` fails naming it,
   * and `moveAside` moves its bytes to a sibling and keeps the record of it
   * (`QuarantinedRotation`) at its place, in one locked step.
   */
  readonly withRotation: <A, E>(
    provider: string,
    source: string,
    use: (held: {
      readonly read: Effect.Effect<Option.Option<HeldRotation>, AuthError | HeldRotationUndecodable>
      readonly write: (next: Option.Option<PendingRotation>) => Effect.Effect<void, AuthError>
      readonly moveAside: (base: Option.Option<string>) => Effect.Effect<string, AuthError>
    }) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | AuthError>
}

/** Wraps one provider's store operation in a lock every store of the directory honors. */
type StoreExclusion = (
  provider: string,
) => <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | AuthError>

/**
 * One owner for a credential store: every write for one provider takes that
 * provider's lock. All profiles of a process share the store, and each
 * profile's drivers hold their own caches, so the store is the only place
 * where their writes can be ordered. A store on disk is also shared by every
 * gent process on the machine (a gamut run, a rift binary, a second data
 * directory); `crossProcess` orders those, inside the in-process lock so one
 * fiber per process waits on it.
 *
 * A read runs without the lock. An entry that does not decode is read again
 * under the lock and removed only if it still does not decode, so a write in
 * flight in another process is never taken for corruption.
 */
export const serializeAuthStore = (
  store: AuthStoreAccess,
  crossProcess: StoreExclusion = () => (effect) => effect,
): AuthService => {
  const locks = new Map<string, Semaphore.Semaphore>()
  const exclusive =
    (provider: string) =>
    <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | AuthError> =>
      Effect.suspend(() => {
        let lock = locks.get(provider)
        if (Predicate.isUndefined(lock)) {
          lock = Semaphore.makeUnsafe(1)
          locks.set(provider, lock)
        }
        return crossProcess(provider)(effect).pipe(lock.withPermits(1))
      })
  // Runs under the provider's lock only: no writer can be mid-write here.
  const getOrDiscard = (provider: string, slot?: CredentialSlot) =>
    store.get(provider, slot).pipe(
      Effect.catchTag("AuthEntryInvalid", (invalid) =>
        Effect.logWarning("discarded invalid auth info").pipe(
          Effect.annotateLogs({ provider, cause: String(invalid.cause) }),
          Effect.andThen(store.remove(provider, slot)),
          Effect.catchTag("AuthError", (deleteCause) =>
            Effect.logWarning("failed to discard invalid auth info").pipe(
              Effect.annotateLogs({ provider, deleteCause: String(deleteCause) }),
            ),
          ),
          // oxlint-disable-next-line effect/noNullish -- Invalid stored credentials are discarded as an absent auth record.
          Effect.as(undefined),
        ),
      ),
    )
  // A rotation the disk would not take, held in this store's memory until a
  // write lands or it is forgotten: a refresh spent the only other copy, so
  // the rotation outlives a failed write for as long as the process does.
  // Keyed by provider and source; read and written only under the provider's
  // lock, inside `withRotation`. Another store, in this process or another,
  // sees only the disk.
  const unsaved = new Map<string, PendingRotation>()
  // A provider id holds no NUL, so the key names one provider and one source.
  const unsavedKey = (provider: string, source: string) => `${provider}\u0000${source}`
  const heldRotation = (provider: string, source: string) => {
    const key = unsavedKey(provider, source)
    return {
      read: Effect.suspend(
        (): Effect.Effect<Option.Option<HeldRotation>, AuthError | HeldRotationUndecodable> => {
          const inMemory = unsaved.get(key)
          if (Predicate.isNotUndefined(inMemory)) return Effect.succeedSome(inMemory)
          return store.getRotation(provider, source)
        },
      ),
      moveAside: (base: Option.Option<string>) => store.moveRotationAside(provider, source, base),
      write: (next: Option.Option<PendingRotation>) =>
        Effect.suspend((): Effect.Effect<void, AuthError> => {
          if (Option.isNone(next)) {
            // Forgetting an unsaved rotation leaves the disk alone: it holds
            // nothing, an older rotation the next settle forgets, or another
            // process's newer one, which must stay.
            if (unsaved.delete(key)) return Effect.void
            return store.setRotation(provider, source, next)
          }
          unsaved.set(key, next.value)
          return store.setRotation(provider, source, next).pipe(
            Effect.tap(() => Effect.sync(() => unsaved.delete(key))),
            Effect.catchTag("AuthError", (error) =>
              Effect.logWarning("auth.rotation-held-in-memory").pipe(
                Effect.annotateLogs({ provider, source, error: String(error) }),
              ),
            ),
          )
        }),
    }
  }
  return {
    list: store.list,
    listSlots: store.listSlots,
    get: (provider, slot) =>
      store
        .get(provider, slot)
        .pipe(
          Effect.catchTag("AuthEntryInvalid", () =>
            exclusive(provider)(getOrDiscard(provider, slot)),
          ),
        ),
    // A sign-in or a replacement is a new credential: the stamp says when,
    // so a cache the old one wrote is never taken for this one's.
    set: (provider, info, slot, onPersisted) => {
      let write = stamped(info).pipe(Effect.flatMap((next) => store.set(provider, next, slot)))
      if (Predicate.isNotUndefined(onPersisted)) {
        write = write.pipe(Effect.andThen(onPersisted), Effect.uninterruptible)
      }
      // Acquisition retains caller interruptibility; only the committed write is masked.
      return exclusive(provider)(write)
    },
    remove: (provider, slot) => exclusive(provider)(store.remove(provider, slot)),
    rename: (provider, from, to) =>
      exclusive(provider)(
        Effect.gen(function* () {
          const moved = yield* getOrDiscard(provider, from)
          if (Predicate.isUndefined(moved))
            return yield* new AuthError({ message: `No credential "${from}" for "${provider}"` })
          if (Predicate.isNotUndefined(yield* getOrDiscard(provider, to)))
            return yield* new AuthError({
              message: `Credential "${to}" for "${provider}" already exists`,
            })
          // The new entry lands before the old one goes: a crash between
          // them leaves the credential under both labels, never under none.
          yield* store.set(provider, moved, to)
          yield* store.remove(provider, from)
        }),
      ),
    // A refresh is the same credential: it keeps the stamp of its sign-in.
    update: (provider, f, slot) =>
      exclusive(provider)(
        Effect.gen(function* () {
          const current = Option.fromUndefinedOr(yield* getOrDiscard(provider, slot))
          const [result, next] = yield* f(current)
          if (Option.isSome(next)) {
            const signedInAt = Option.flatMap(current, (held) =>
              Option.fromUndefinedOr(held.signedInAt),
            )
            yield* store.set(provider, keepStamp(next.value, signedInAt), slot)
          }
          return result
        }),
      ),
    withRotation: (provider, source, use) =>
      exclusive(provider)(use(heldRotation(provider, source))),
  }
}

/** `info` stamped now, unless it carries its sign-in stamp already (a moved credential). */
const stamped = (info: AuthInfo): Effect.Effect<AuthInfo> => {
  if (Predicate.isNotUndefined(info.signedInAt)) return Effect.succeed(info)
  return Effect.map(Clock.currentTimeMillis, (signedInAt) => ({ ...info, signedInAt }))
}

/** A refreshed credential with the stamp of the sign-in it refreshes, when it has none. */
const keepStamp = (next: AuthInfo, signedInAt: Option.Option<number>): AuthInfo => {
  if (Predicate.isNotUndefined(next.signedInAt) || Option.isNone(signedInAt)) return next
  return { ...next, signedInAt: signedInAt.value }
}

// ── provider lock ───────────────────────────────────────────────────────────

/** The lock of one provider in one credential store, as `ProviderLock` gives it. */
interface ProviderLockService {
  /**
   * Run `effect` while no other writer of `provider` in the store at
   * `directory` runs: another store over the same directory, in this process
   * or in another one the host can see.
   */
  readonly exclusive: (
    directory: string,
    provider: string,
  ) => <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | AuthError>
}

/**
 * The lock a credential store takes around each write of one provider, so
 * every store over one directory orders its writes with the others. The host
 * provides it. On Bun it is a lock file per provider that every gent process
 * on the machine honors (`BunProviderLockLive`, `gent-platform-bun.ts`, part
 * of `BunPlatformLive`). `InProcess` orders the stores of one process only;
 * a host whose process is the only writer of its store (a Durable Object)
 * needs no file system for it.
 */
export class ProviderLock extends Context.Service<ProviderLock, ProviderLockService>()(
  "@gent/core/src/runtime/provider/ProviderLock",
) {
  static InProcess: Layer.Layer<ProviderLock> = Layer.sync(ProviderLock)(() => {
    const locks = new Map<string, Semaphore.Semaphore>()
    return {
      exclusive: (directory, provider) => (effect) =>
        Effect.suspend(() => {
          // A path holds no NUL, so the key names one directory and one provider.
          const key = `${directory}\u0000${provider}`
          let lock = locks.get(key)
          if (Predicate.isUndefined(lock)) {
            lock = Semaphore.makeUnsafe(1)
            locks.set(key, lock)
          }
          return lock.withPermits(1)(effect)
        }),
    }
  })
}

export class Auth extends Context.Service<Auth, AuthService>()(
  "@gent/core/src/runtime/provider/Auth",
) {
  /**
   * File-system-backed live layer. One file per provider (URL-encoded
   * key) under `directory`. Stale or corrupt entries are discarded and
   * logged so a single broken file can't brick startup. Each write of a
   * provider takes the host's `ProviderLock` for this directory.
   */
  static Live = (
    directory: string,
  ): Layer.Layer<Auth, never, FileSystem.FileSystem | Path.Path | ProviderLock> =>
    Layer.effect(
      Auth,
      Effect.gen(function* () {
        const providerLock = yield* ProviderLock
        const fs = yield* FileSystem.FileSystem
        const pathService = yield* Path.Path
        const codec = Schema.fromJsonString(Schema.toCodecJson(AuthInfo))
        const decode = Schema.decodeEffect(codec)
        const encode = Schema.encodeEffect(codec)
        const wrap = (message: string) => (cause: unknown) => new AuthError({ message, cause })
        const slotsDirectory = pathService.join(directory, ".slots")
        const providerDirectory = (provider: string) => {
          const encoded = encodeURIComponent(provider)
          // URI encoding leaves dot segments bare; they must not move a named entry.
          if (encoded === "." || encoded === "..") {
            return pathService.join(slotsDirectory, encoded.replaceAll(".", "%2E"))
          }
          return pathService.join(slotsDirectory, encoded)
        }
        const fileOf = (provider: string, slot: CredentialSlot = DEFAULT_CREDENTIAL_SLOT) => {
          if (slot === DEFAULT_CREDENTIAL_SLOT)
            return pathService.join(directory, encodeURIComponent(provider))
          return pathService.join(providerDirectory(provider), encodeURIComponent(slot))
        }
        // Held rotations sit beside the entries, under a dot directory no
        // listing reads, so an older gent never sees one.
        const segment = (name: string) => {
          const encoded = encodeURIComponent(name)
          if (encoded === "." || encoded === "..") return encoded.replaceAll(".", "%2E")
          return encoded
        }
        // Absolute, so a failure that names the file names it wherever it is read.
        const rotationFileOf = (provider: string, source: string) =>
          pathService.resolve(directory, ".rotations", segment(provider), segment(source))
        const rotationCodec = Schema.fromJsonString(Schema.toCodecJson(HeldRotation))
        const decodeRotation = Schema.decodeEffect(rotationCodec)
        const encodeRotation = Schema.encodeEffect(rotationCodec)
        const movedAsideFailure = "Failed to move a held token rotation aside"
        // A name `<file>.undecodable-…` beside `file` that is already the same
        // file (its device and inode): a link an earlier move made before its
        // record failed to land, or before its process ended.
        const linkedAside = (file: string) =>
          Effect.gen(function* () {
            const info = yield* fs.stat(file)
            if (Option.isNone(info.ino)) return Option.none<string>()
            const inode = info.ino.value
            const directory = pathService.dirname(file)
            const prefix = `${pathService.basename(file)}.undecodable-`
            for (const name of yield* fs.readDirectory(directory)) {
              if (!name.startsWith(prefix)) continue
              const aside = pathService.join(directory, name)
              const sibling = yield* Effect.option(fs.stat(aside))
              const same = Option.exists(
                sibling,
                (found) => found.dev === info.dev && Option.contains(found.ino, inode),
              )
              if (same) return Option.some(aside)
            }
            return Option.none<string>()
          }).pipe(Effect.mapError(wrap(movedAsideFailure)))
        // A second name for `file` beside it: the one a link already made, so
        // a move that is retried leaves one name; else `<file>.undecodable-<epoch ms>`,
        // counted on when a name of that millisecond is taken.
        const linkAside = (file: string) =>
          Effect.gen(function* () {
            const made = yield* linkedAside(file)
            if (Option.isSome(made)) return made.value
            const stamp = `${file}.undecodable-${yield* Clock.currentTimeMillis}`
            const attempt = (n: number): Effect.Effect<string, AuthError> => {
              let aside = stamp
              if (n > 0) aside = `${stamp}-${n}`
              return fs.link(file, aside).pipe(
                Effect.as(aside),
                Effect.catchIf(
                  (error) => error.reason._tag === "AlreadyExists" && n < 100,
                  () => attempt(n + 1),
                ),
                Effect.mapError(wrap(movedAsideFailure)),
              )
            }
            return yield* attempt(0)
          })
        // Staged and renamed over the file, owner-only from the first byte.
        const writeRotation = (file: string, held: HeldRotation) =>
          encodeRotation(held).pipe(
            Effect.tap(() => fs.makeDirectory(pathService.dirname(file), { recursive: true })),
            Effect.flatMap((text) => writeFileAtomic(file, text, { mode: 0o600 })),
            Effect.mapError(wrap("Failed to hold a token rotation")),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, pathService),
          )
        const namesIn = (dir: string) =>
          fs.readDirectory(dir).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.succeed([]),
            ),
            Effect.mapError(wrap("Failed to list auth info")),
          )
        // A named-slot directory that cannot be read hides only the named
        // credentials under it: the default ones still list.
        const namedIn = (dir: string) =>
          namesIn(dir).pipe(
            Effect.catchTag("AuthError", (error) =>
              Effect.logWarning("auth.named-slots-unreadable").pipe(
                Effect.annotateLogs({ error: String(error.cause) }),
                Effect.as<ReadonlyArray<string>>([]),
              ),
            ),
          )
        const listSlots = (provider: string) =>
          Effect.gen(function* () {
            const named = yield* namedIn(providerDirectory(provider))
            const slots = named
              .flatMap((name) => Option.toArray(Schema.decodeOption(CredentialSlot)(name)))
              .filter((slot) => slot !== DEFAULT_CREDENTIAL_SLOT)
            const legacy = yield* fs.stat(fileOf(provider)).pipe(
              Effect.asSome,
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeedNone,
              ),
              Effect.mapError(wrap("Failed to list auth info")),
            )
            const hasDefault = Option.exists(legacy, (info) => info.type === "File")
            if (hasDefault) return [DEFAULT_CREDENTIAL_SLOT, ...slots.sort()]
            return slots.sort()
          })
        return serializeAuthStore(
          {
            listSlots,
            get: (provider, slot) =>
              Effect.gen(function* () {
                const text = yield* fs.readFileString(fileOf(provider, slot)).pipe(
                  Effect.asSome,
                  Effect.catchIf(
                    (error) => error.reason._tag === "NotFound",
                    () => Effect.succeedNone,
                  ),
                  Effect.mapError(wrap("Failed to read auth info")),
                )
                // oxlint-disable-next-line effect/noNullish -- Auth lookup uses undefined when a provider has no stored credentials.
                if (Option.isNone(text)) return undefined
                return yield* decode(text.value).pipe(
                  Effect.mapError((cause) => new AuthEntryInvalid({ cause })),
                )
              }),
            // A staged file renamed over the entry: a reader in another
            // process sees the old credential or the new one, never an
            // empty file.
            set: (provider, info, slot) =>
              encode(info).pipe(
                Effect.tap(() =>
                  fs.makeDirectory(pathService.dirname(fileOf(provider, slot)), {
                    recursive: true,
                  }),
                ),
                Effect.flatMap((text) =>
                  writeFileAtomic(fileOf(provider, slot), text, { mode: 0o600 }),
                ),
                Effect.mapError(wrap("Failed to persist auth info")),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, pathService),
              ),
            remove: (provider, slot) =>
              fs
                .remove(fileOf(provider, slot), { force: true })
                .pipe(Effect.mapError(wrap("Failed to remove auth info"))),
            // A dot file (the lock directory, a staged write) is no entry.
            list: Effect.gen(function* () {
              const legacy = (yield* namesIn(directory))
                .filter((name) => !name.startsWith("."))
                .map(decodeURIComponent)
              const named = yield* Effect.filter(
                (yield* namedIn(slotsDirectory)).map(decodeURIComponent),
                (provider) => listSlots(provider).pipe(Effect.map((slots) => slots.length > 0)),
              )
              return [...new Set([...legacy, ...named])]
            }),
            // A held rotation that does not decode is never discarded: it may
            // be the only live token of a login. The read fails naming it.
            getRotation: (provider, source) =>
              fs.readFileString(rotationFileOf(provider, source)).pipe(
                Effect.asSome,
                Effect.catchIf(
                  (error) => error.reason._tag === "NotFound",
                  () => Effect.succeedNone,
                ),
                Effect.mapError(wrap("Failed to read a held token rotation")),
                Effect.flatMap((text) =>
                  Option.match(text, {
                    onNone: () => Effect.succeedNone,
                    onSome: (raw) =>
                      decodeRotation(raw).pipe(
                        Effect.asSome,
                        Effect.mapError(
                          () =>
                            new HeldRotationUndecodable({ file: rotationFileOf(provider, source) }),
                        ),
                      ),
                  }),
                ),
              ),
            setRotation: (provider, source, next) =>
              Option.match(next, {
                onNone: () =>
                  fs
                    .remove(rotationFileOf(provider, source), { force: true })
                    .pipe(Effect.mapError(wrap("Failed to remove a held token rotation"))),
                onSome: (rotation) => writeRotation(rotationFileOf(provider, source), rotation),
              }),
            // The bytes get a second name first, and the record is then
            // renamed over the first: no step leaves the place empty, where
            // the next read would find nothing held and spend the login the
            // bytes may have replaced. A link that fails changes nothing; a
            // record that fails leaves the bytes under both names, and the
            // next move takes that sibling again rather than a new one. A link
            // never replaces a name, so an earlier sibling is never lost.
            moveRotationAside: (provider, source, base) =>
              Effect.gen(function* () {
                const file = rotationFileOf(provider, source)
                const aside = yield* linkAside(file)
                if (Option.isNone(base)) {
                  yield* fs.remove(file).pipe(Effect.mapError(wrap(movedAsideFailure)))
                  return aside
                }
                yield* writeRotation(file, { quarantined: { base: base.value, file: aside } })
                return aside
              }),
          },
          (provider) => providerLock.exclusive(directory, provider),
        )
      }),
    )

  /**
   * In-memory test layer. Optionally seeded with a starting record.
   */
  static Test = (initial: Record<string, AuthInfo> = {}): Layer.Layer<Auth> =>
    Layer.sync(Auth)(() => {
      const map = new Map(
        Object.entries(initial).map(([provider, info]) => [
          provider,
          new Map([[DEFAULT_CREDENTIAL_SLOT, info]]),
        ]),
      )
      // A path holds no NUL, so the key names one provider and one source.
      const rotations = new Map<string, PendingRotation>()
      const rotationKey = (provider: string, source: string) => `${provider}\u0000${source}`
      return serializeAuthStore({
        getRotation: (provider, source) =>
          Effect.sync(() => Option.fromUndefinedOr(rotations.get(rotationKey(provider, source)))),
        setRotation: (provider, source, next) =>
          Effect.sync(() => {
            if (Option.isSome(next)) rotations.set(rotationKey(provider, source), next.value)
            else rotations.delete(rotationKey(provider, source))
          }),
        // Memory holds only what decodes: nothing is ever there to move aside.
        moveRotationAside: () =>
          Effect.fail(new AuthError({ message: "An in-memory store holds no rotation file" })),
        list: Effect.sync(() => {
          const providers: string[] = []
          for (const [provider, slots] of map) if (slots.size > 0) providers.push(provider)
          return providers
        }),
        listSlots: (provider) => Effect.sync(() => [...(map.get(provider)?.keys() ?? [])]),
        get: (provider, slot = DEFAULT_CREDENTIAL_SLOT) =>
          Effect.sync(() => map.get(provider)?.get(slot)),
        set: (provider, info, slot = DEFAULT_CREDENTIAL_SLOT) =>
          Effect.sync(() => {
            const slots = map.get(provider) ?? new Map<CredentialSlot, AuthInfo>()
            slots.set(slot, info)
            map.set(provider, slots)
          }),
        remove: (provider, slot = DEFAULT_CREDENTIAL_SLOT) =>
          Effect.sync(() => {
            map.get(provider)?.delete(slot)
          }),
      })
    })
}

// ── shared sign-in ──────────────────────────────────────────────────────────
//
// A driver may use another driver's sign-in (`credentialFrom`): one account
// that serves two drivers is one sign-in, stored once, under the owner's id.
// Sharing is one hop, so every credential has one owner.

type ModelDrivers = ReadonlyMap<string, ModelDriverContribution>

/**
 * The driver that owns `driverId`'s sign-in: the driver its `credentialFrom`
 * names when the profile registers it and it names none itself, else the
 * driver itself. A chain or a cycle leaves each driver in it its own owner.
 */
const credentialOwner = (drivers: ModelDrivers, driverId: string): string =>
  Option.fromUndefinedOr(drivers.get(driverId)).pipe(
    Option.flatMap((driver) => Option.fromUndefinedOr(driver.credentialFrom)),
    Option.filter((owner) =>
      Option.exists(Option.fromUndefinedOr(drivers.get(owner)), (named) =>
        Predicate.isUndefined(named.credentialFrom),
      ),
    ),
    Option.getOrElse(() => driverId),
  )

/**
 * The store keys `driverId`'s credential is read from, first found wins: its
 * sign-in owner's, then the own id of each driver that shares the sign-in (a
 * credential stored before it shared). Signing out removes them all.
 */
const credentialKeys = (drivers: ModelDrivers, driverId: string): ReadonlyArray<string> => {
  const owner = credentialOwner(drivers, driverId)
  const sharers = [...drivers.keys()].filter(
    (id) => id !== owner && credentialOwner(drivers, id) === owner,
  )
  return [owner, ...sharers]
}

/**
 * One sign-in's ordered credentials: the owner they are stored under, and
 * the slots to try, first to last. `pool` is the slots its unpinned runs are
 * spread over (`authSpread`); none without one, and for a pinned run.
 */
interface CredentialOrder {
  readonly provider: string
  readonly slots: Arr.NonEmptyReadonlyArray<CredentialSlot>
  readonly pool: Option.Option<Arr.NonEmptyReadonlyArray<CredentialSlot>>
}

/** The `providers` fields that name a list of a sign-in's credentials. */
type CredentialListField = "authOrder" | "authSpread"

/** The config entries that name `field` for `provider`'s sign-in, as `[id, slots]`. */
const configuredOrders = (
  drivers: ModelDrivers,
  config: ProviderConfig,
  provider: string,
  field: CredentialListField = "authOrder",
): ReadonlyArray<readonly [string, ReadonlyArray<CredentialSlot>]> => {
  const owner = credentialOwner(drivers, provider)
  return Object.entries(config.providers ?? {}).flatMap(([id, entry]) => {
    const slots = entry[field]
    if (Predicate.isUndefined(slots) || credentialOwner(drivers, id) !== owner) return []
    return [[id, slots] as const]
  })
}

/** The entries of `orders` that disagree, sorted; none when they agree. */
const disagreeing = (
  orders: ReadonlyArray<readonly [string, ReadonlyArray<CredentialSlot>]>,
): ReadonlyArray<string> => {
  const first = orders[0]
  if (Predicate.isUndefined(first)) return []
  const [, slots] = first
  const agree = orders.every(
    ([, other]) =>
      other.length === slots.length && other.every((slot, index) => slot === slots[index]),
  )
  if (agree) return []
  return orders.map(([id]) => id).sort()
}

/** The first list `field` names for `provider`'s sign-in. */
const configuredList = (
  drivers: ModelDrivers,
  config: ProviderConfig,
  provider: string,
  field: CredentialListField,
): Option.Option<Arr.NonEmptyReadonlyArray<CredentialSlot>> =>
  Option.flatMap(
    Option.fromUndefinedOr(configuredOrders(drivers, config, provider, field)[0]),
    ([, slots]) => Option.liftPredicate(slots, Arr.isReadonlyArrayNonEmpty),
  )

/** The order `provider`'s sign-in walks as its config names it: its `authOrder`, else the default alone. */
const configuredOrder = (
  drivers: ModelDrivers,
  config: ProviderConfig,
  provider: string,
): Arr.NonEmptyReadonlyArray<CredentialSlot> =>
  Option.getOrElse(
    configuredList(drivers, config, provider, "authOrder"),
    (): Arr.NonEmptyReadonlyArray<CredentialSlot> => [DEFAULT_CREDENTIAL_SLOT],
  )

/**
 * The credentials `provider`'s pool names that its order does not; none
 * when it has no pool or every one is in the order. A pool spreads a run
 * over credentials of its order: without an `authOrder` the order is the
 * default alone, so a pool there would walk to the default (which can be a
 * billed environment key) once every pool account refused.
 */
const poolOutsideOrder = (
  drivers: ModelDrivers,
  config: ProviderConfig,
  provider: string,
): ReadonlyArray<CredentialSlot> => {
  const order = configuredOrder(drivers, config, provider)
  return Option.match(configuredList(drivers, config, provider, "authSpread"), {
    onNone: () => [],
    onSome: (pool) => pool.filter((slot) => !order.includes(slot)),
  })
}

/**
 * The config entries that name different orders or different pools for
 * `provider`'s sign-in (an alias and its owner), or a pool that names a
 * credential its order does not (each entry that names the order or the
 * pool), sorted; none when they agree. Only that sign-in fails: a conflict
 * never stops the others.
 */
const orderConflict = (
  drivers: ModelDrivers,
  config: ProviderConfig,
  provider: string,
): ReadonlyArray<string> => {
  const orders = configuredOrders(drivers, config, provider)
  const pools = configuredOrders(drivers, config, provider, "authSpread")
  // A pool outside its order: every entry that names the order or the pool.
  const outside = Arr.match(poolOutsideOrder(drivers, config, provider), {
    onEmpty: () => [],
    onNonEmpty: () => [...orders, ...pools].map(([id]) => id),
  })
  return [...new Set([...disagreeing(orders), ...disagreeing(pools), ...outside])].sort()
}

/**
 * The credential order of `provider`'s sign-in: its config `authOrder`, read
 * through aliases to the owner, else the default credential alone, and its
 * `authSpread` pool. Config entries that name different orders or pools for
 * one sign-in fail it, never by which entry comes first, and so does a pool
 * that names a credential the order does not.
 */
const credentialOrder = Effect.fn("CredentialOrder.of")(function* (
  drivers: ModelDrivers,
  config: ProviderConfig,
  provider: string,
) {
  const owner = credentialOwner(drivers, provider)
  const conflict = [
    ...new Set([
      ...disagreeing(configuredOrders(drivers, config, provider)),
      ...disagreeing(configuredOrders(drivers, config, provider, "authSpread")),
    ]),
  ]
  if (conflict.length > 0) {
    return yield* new ProviderAuthError({
      message: `Conflicting credential orders for provider "${owner}": providers ${conflict.sort().join(", ")} name different authOrder or authSpread lists`,
    })
  }
  const outside = poolOutsideOrder(drivers, config, provider)
  if (outside.length > 0) {
    return yield* new ProviderAuthError({
      message: `The authSpread of provider "${owner}" names ${outside.map((slot) => `"${slot}"`).join(", ")}, which its authOrder does not: a pool spreads runs over credentials of the order`,
    })
  }
  return {
    provider: owner,
    slots: configuredOrder(drivers, config, provider),
    pool: configuredList(drivers, config, provider, "authSpread"),
  } satisfies CredentialOrder
})

interface StoredCredential {
  /** The store key the credential sits under. */
  readonly key: string
  readonly slot: CredentialSlot
  readonly info: AuthInfo
}

/** The credential `driverId`'s sign-in has stored; none when no key holds one. */
const storedCredential = Effect.fn("storedCredential")(function* (
  auth: AuthService,
  drivers: ModelDrivers,
  driverId: string,
  slot: CredentialSlot = DEFAULT_CREDENTIAL_SLOT,
) {
  for (const key of credentialKeys(drivers, driverId)) {
    const info = yield* auth.get(key, slot)
    if (Predicate.isNotUndefined(info)) return Option.some<StoredCredential>({ key, slot, info })
  }
  return Option.none<StoredCredential>()
})

/** The stored credential `driverId` receives, as a driver sees it. */
const driverAuthInfo = (
  auth: AuthService,
  drivers: ModelDrivers,
  driverId: string,
  slot: CredentialSlot = DEFAULT_CREDENTIAL_SLOT,
): Effect.Effect<Option.Option<ProviderAuthInfo>, AuthError> =>
  storedCredential(auth, drivers, driverId, slot).pipe(
    Effect.map(Option.map((found) => toProviderAuthInfo(auth, found.key, found.info, found.slot))),
  )

/**
 * The credentials `driverId` lists its models with, in its credential order:
 * the default as a turn reads it (what is stored, else the driver's own
 * variable), and each named slot that holds one. An order its config makes
 * conflict lists with the default alone. `pinned` holds the owner it names to
 * that one slot: the credential one request went out with.
 */
const catalogAuths = Effect.fn("CredentialOrder.catalogAuths")(function* (
  auth: AuthService,
  drivers: ModelDrivers,
  config: ProviderConfig,
  driverId: string,
  pinned: Option.Option<CredentialReceipt>,
) {
  const owner = credentialOwner(drivers, driverId)
  const slots = yield* Option.match(
    Option.filter(pinned, (credential) => credential.provider === owner),
    {
      onSome: (credential): Effect.Effect<ReadonlyArray<CredentialSlot>> =>
        Effect.succeed([credential.slot]),
      onNone: () =>
        credentialOrder(drivers, config, driverId).pipe(
          Effect.map((order): ReadonlyArray<CredentialSlot> => order.slots),
          Effect.orElseSucceed((): ReadonlyArray<CredentialSlot> => [DEFAULT_CREDENTIAL_SLOT]),
        ),
    },
  )
  const auths: Array<Option.Option<ProviderAuthInfo>> = []
  for (const slot of slots) {
    const info = yield* driverAuthInfo(auth, drivers, driverId, slot)
    if (Option.isSome(info) || slot === DEFAULT_CREDENTIAL_SLOT) auths.push(info)
  }
  if (auths.length === 0) return [Option.none<ProviderAuthInfo>()]
  return auths
})

/**
 * Sign out of `provider`'s sign-in: remove every credential it reads, in the
 * profile of the `ExtensionRegistry` in context.
 */
export const removeSignIn = Effect.fn("removeSignIn")(function* (
  provider: string,
  slot?: CredentialSlot,
) {
  const auth = yield* Auth
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  for (const key of credentialKeys(modelDrivers, provider)) yield* auth.remove(key, slot)
})

/**
 * Give a named credential of `provider`'s sign-in another label, in the
 * profile of the `ExtensionRegistry` in context: the same credential under
 * the key it is stored at. The default slot keeps its label, and no label
 * becomes it.
 */
export const renameSignIn = Effect.fn("renameSignIn")(function* (
  provider: string,
  from: CredentialSlot,
  to: CredentialSlot,
) {
  if (from === DEFAULT_CREDENTIAL_SLOT || to === DEFAULT_CREDENTIAL_SLOT) {
    return yield* new AuthError({ message: `The "${DEFAULT_CREDENTIAL_SLOT}" label is fixed` })
  }
  const auth = yield* Auth
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  const stored = yield* storedCredential(auth, modelDrivers, provider, from)
  if (Option.isNone(stored)) {
    return yield* new AuthError({ message: `No credential "${from}" for "${provider}"` })
  }
  // A label held under another key of the sign-in is in use as well: the
  // store refuses only a label under the key it moves within.
  if (Option.isSome(yield* storedCredential(auth, modelDrivers, provider, to))) {
    return yield* new AuthError({ message: `"${to}" is in use for "${provider}"` })
  }
  yield* auth.rename(stored.value.key, from, to)
})

/**
 * The config entries of `provider`'s sign-in, in the profile of the
 * `ExtensionRegistry` in context: the owner its credential order is written
 * under, and every driver id that shares the sign-in (`keys`, the owner's
 * first), each of which can name an order.
 */
export const signInEntries = Effect.fn("CredentialOrder.signInEntries")(function* (
  provider: string,
) {
  const drivers = (yield* ExtensionRegistry).getResolved().modelDrivers
  return { owner: credentialOwner(drivers, provider), keys: credentialKeys(drivers, provider) }
})

/**
 * Store a credential for `provider`'s sign-in under its owner, in the profile
 * of the `ExtensionRegistry` in context. Reads try the owner's key first, so
 * a key stored under a sharing driver's own id would sit behind it. An API
 * key for a generic provider is stored only when its base URL answers pass
 * the rule a turn applies (`checkBaseUrlAnswers`). A sign-in whose config
 * names conflicting credential orders stores nothing.
 */
export const storeSignIn = Effect.fn("storeSignIn")(function* (
  provider: string,
  info: AuthInfo,
  slot?: CredentialSlot,
) {
  const auth = yield* Auth
  const registry = yield* ExtensionRegistry
  const { modelDrivers } = registry.getResolved()
  yield* credentialOrder(modelDrivers, yield* registry.providerConfig, provider)
  if (info.type === "api" && !modelDrivers.has(provider)) {
    yield* checkBaseUrlAnswers(provider, info)
  }
  yield* auth.set(credentialOwner(modelDrivers, provider), info, slot)
})

// ── auth guard ──────────────────────────────────────────────────────────────

/** True when the named env variable holds a non-empty value. */
const envCredentialSet = (name: Option.Option<string>): Effect.Effect<boolean> =>
  Option.match(name, {
    onNone: () => Effect.succeed(false),
    onSome: (envName) =>
      Config.option(Config.NonEmptyString(envName)).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      ),
  })

/**
 * True when the driver's own env variable is set: the fallback the driver
 * reads when nothing is stored. A driver that shares a sign-in reads only
 * its own variable, so readiness is per driver.
 */
const driverEnvReady = (driver: ModelDriverContribution): Effect.Effect<boolean> =>
  envCredentialSet(Option.fromUndefinedOr(driver.envCredential))

/**
 * Every sign-in of the registered model drivers and of the active generic
 * providers (`servedProfile`), with its stored auth: one
 * row per driver, except a driver that uses another's sign-in
 * (`credentialFrom`), whose owner's row stands for both. A row is `required`
 * when one of `requiredDriverIds` uses it: the drivers the caller's turns
 * route through, resolved as the turn resolves them (`effectiveModelDriver`).
 * With nothing stored, a row is ready from env only when every driver that
 * needs it (the required ones, else the owner) has its own variable set. A
 * generic provider that stores a key only in a named slot has a row too, so
 * its credentials show, though its models wait for an order to name them.
 */
export const listAuthProviders = Effect.fn("listAuthProviders")(function* (
  requiredDriverIds: ReadonlyArray<string>,
) {
  const auth = yield* Auth
  const stored = yield* storedProviders(auth)
  const drivers = (yield* servedProfile(auth, [...requiredDriverIds, ...stored])).modelDrivers
  const required = new Set(requiredDriverIds.map((id) => credentialOwner(drivers, id)))
  const providers: AuthProviderInfo[] = []
  for (const driver of drivers.values()) {
    if (credentialOwner(drivers, driver.id) !== driver.id) continue
    if (Predicate.isNotUndefined(driver.credentialFrom) && drivers.has(driver.credentialFrom)) {
      yield* Effect.logWarning("credentialFrom names a driver that shares a sign-in").pipe(
        Effect.annotateLogs({ driver: driver.id, credentialFrom: driver.credentialFrom }),
      )
    }
    const provider = ProviderId.make(driver.id)
    const name = driver.name
    const stored = yield* storedCredential(auth, drivers, driver.id)
    if (Option.isNone(stored)) {
      // Drivers try a stored credential first, then their own env variable.
      const group = credentialKeys(drivers, driver.id).flatMap((id) =>
        Option.toArray(Option.fromUndefinedOr(drivers.get(id))),
      )
      const requiredUsers = requiredDriverIds.flatMap((id) =>
        group.filter((member) => member.id === id),
      )
      let users = requiredUsers
      if (users.length === 0) users = [driver]
      const notReady = yield* Effect.findFirst(users, (user) =>
        Effect.map(driverEnvReady(user), (ready) => !ready),
      )
      if (Option.isNone(notReady)) {
        providers.push({
          provider,
          name,
          source: "env",
          required: required.has(driver.id),
          ...readiness(yield* unansweredPrompts(driver, Option.none())),
        })
        continue
      }
      providers.push({ provider, name, hasKey: false, required: required.has(driver.id) })
      continue
    }
    const info = stored.value.info
    let missing: ReadonlyArray<string> = []
    if (info.type === "api")
      missing = yield* unansweredPrompts(driver, Option.fromUndefinedOr(info.metadata))
    providers.push({
      provider,
      name,
      source: "stored",
      authType: info.type,
      required: required.has(driver.id),
      ...readiness(missing),
    })
  }
  const config = yield* (yield* ExtensionRegistry).providerConfig
  const rows = yield* Effect.forEach(providers, (row) =>
    Effect.gen(function* () {
      const driver = drivers.get(row.provider)
      if (Predicate.isUndefined(driver)) return row
      // A conflicting order is reported below; its row reads the default alone.
      const order = yield* credentialOrder(drivers, config, row.provider).pipe(
        Effect.map((found): ReadonlyArray<CredentialSlot> => found.slots),
        Effect.orElseSucceed((): ReadonlyArray<CredentialSlot> => [DEFAULT_CREDENTIAL_SLOT]),
      )
      const slots = new Set<CredentialSlot>([DEFAULT_CREDENTIAL_SLOT, ...order])
      for (const key of credentialKeys(drivers, row.provider)) {
        for (const slot of yield* auth.listSlots(key)) slots.add(slot)
      }
      if (slots.size === 1) return row
      const credentials = yield* Effect.forEach([...slots], (slot) =>
        Effect.gen(function* () {
          if (slot === DEFAULT_CREDENTIAL_SLOT)
            return {
              slot,
              hasKey: row.hasKey,
              source: row.source ?? "none",
              ...omitUndefined({ authType: row.authType, missing: row.missing }),
            }
          const stored = yield* storedCredential(auth, drivers, row.provider, slot)
          if (Option.isNone(stored)) return { slot, hasKey: false, source: "none" as const }
          let missing: ReadonlyArray<string> = []
          if (stored.value.info.type === "api") {
            missing = yield* unansweredPrompts(
              driver,
              Option.fromUndefinedOr(stored.value.info.metadata),
            )
          }
          return {
            slot,
            source: "stored" as const,
            authType: stored.value.info.type,
            ...readiness(missing),
          }
        }),
      )
      // A turn walks its order: the sign-in is ready when one credential of
      // it is, and the row reads as the first one a turn would use.
      const ordered = order.flatMap((slot) =>
        credentials.filter((credential) => credential.slot === slot),
      )
      const serving = Option.orElse(
        Option.fromUndefinedOr(ordered.find((credential) => credential.hasKey)),
        () => Option.fromUndefinedOr(ordered[0]),
      )
      if (Option.isNone(serving)) return { ...row, credentials, authOrder: order }
      const { hasKey, source, authType, missing } = serving.value
      return {
        provider: row.provider,
        required: row.required,
        hasKey,
        credentials,
        authOrder: order,
        ...omitUndefined({
          name: row.name,
          source: Option.getOrUndefined(Option.liftPredicate(source, (from) => from !== "none")),
          authType,
          missing,
        }),
      }
    }),
  )
  // Config entries that name different orders fail that sign-in only: its
  // own row names them, and every other row stays as it is.
  return rows.map((row): AuthProviderInfo => {
    const conflict = orderConflict(drivers, config, row.provider)
    if (conflict.length === 0) return row
    return { ...row, hasKey: false, orderConflict: conflict }
  })
})

/**
 * Whether `driverId`'s sign-in is ready, as `/auth` lists it: the row
 * `listAuthProviders` marks required for the driver has a key. A driver that
 * no row serves, or an auth store that fails to read, has none.
 */
export const signInReady = Effect.fn("signInReady")(function* (driverId: string) {
  const rows = yield* listAuthProviders([driverId]).pipe(
    Effect.catch((error) =>
      Effect.logWarning("auth.sign-in-read-failed").pipe(
        Effect.annotateLogs({ driver: driverId, error: error.message }),
        Effect.as<ReadonlyArray<AuthProviderInfo>>([]),
      ),
    ),
  )
  return rows.some((row) => row.required && row.hasKey)
})

/**
 * The labels of the prompts `driver`'s API sign-in cannot run without that
 * `metadata` leaves unanswered and whose variable is not set: the driver
 * reads the variable when the stored key has no answer. A driver's API
 * methods are alternatives (a personal or a business sign-in), and the
 * stored key does not name the method that wrote it: the key is ready when
 * any one method has every needed prompt. Otherwise the labels are those of
 * the method the stored answers fill most, then of the one that lacks the
 * fewest, then of the first declared.
 */
const unansweredPrompts = (
  driver: ModelDriverContribution,
  metadata: Option.Option<AuthMetadata>,
): Effect.Effect<ReadonlyArray<string>> => {
  const methods = Option.match(Option.fromUndefinedOr(driver.auth), {
    onNone: (): ReadonlyArray<AuthMethod> => [],
    onSome: (contribution) => contribution.methods,
  })
  const hasAnswer = (prompt: AuthPrompt) =>
    Option.exists(metadata, (answers) =>
      Option.exists(Option.fromUndefinedOr(answers[prompt.key]), (answer) => answer.length > 0),
    )
  const methodGaps = (method: AuthMethod) => {
    const needed = Option.getOrElse(Option.fromUndefinedOr(method.prompts), () => []).filter(
      (prompt) => prompt.optional !== true,
    )
    return Effect.filter(needed, (prompt) => {
      if (hasAnswer(prompt)) return Effect.succeed(false)
      return Effect.map(envCredentialSet(Option.fromUndefinedOr(prompt.env)), (set) => !set)
    }).pipe(
      Effect.map((unanswered) => ({
        answered: needed.filter(hasAnswer).length,
        missing: [...new Set(unanswered.map((prompt) => prompt.label))],
      })),
    )
  }
  const closest = Order.combine(
    Order.mapInput(Order.Number, (gaps: MethodGaps) => -gaps.answered),
    Order.mapInput(Order.Number, (gaps: MethodGaps) => gaps.missing.length),
  )
  return Effect.forEach(
    methods.filter((method) => method.type === "api"),
    methodGaps,
  ).pipe(
    Effect.map((perMethod) => {
      if (perMethod.some((gaps) => gaps.missing.length === 0)) return []
      return Arr.match(perMethod, {
        onEmpty: (): ReadonlyArray<string> => [],
        onNonEmpty: (gaps) => Arr.min(gaps, closest).missing,
      })
    }),
  )
}

/** How far stored answers and env variables fill one API sign-in method. */
interface MethodGaps {
  readonly answered: number
  readonly missing: ReadonlyArray<string>
}

/** A credential is ready when no prompt it needs is missing; a row that is not names them. */
const readiness = (
  missing: ReadonlyArray<string>,
): Pick<AuthProviderInfo, "hasKey" | "missing"> => {
  if (missing.length === 0) return { hasKey: true }
  return { hasKey: false, missing }
}

// ── provider-auth ───────────────────────────────────────────────────────────

const authValue = (auth: Parameters<PersistAuth>[0]): AuthApi | AuthOauth => {
  if (auth.type === "api") return AuthApi.make({ type: "api", key: auth.key })
  return AuthOauth.make({
    type: "oauth",
    access: auth.access,
    refresh: auth.refresh,
    expires: auth.expires,
    accountId: auth.accountId,
    ...omitUndefined({ metadata: auth.metadata }),
  })
}

/** Build a PersistAuth callback for a provider — writes credentials to Auth. */
const persistAuthTo =
  (authStore: AuthService, providerId: string, slot?: CredentialSlot): PersistAuth =>
  (auth, onPersisted) =>
    authStore.set(providerId, authValue(auth), slot, onPersisted).pipe(
      Effect.mapError(
        (e) =>
          new ProviderAuthError({
            message: `Failed to persist auth for provider "${providerId}"`,
            cause: e,
          }),
      ),
    )

/**
 * A stored credential as a driver sees it. An OAuth credential carries an
 * `update` that reads and writes the stored credential under the store's
 * per-provider lock. A write through `update` is the same sign-in: it keeps
 * the `metadata` of the record it replaces (the store keeps its stamp), so a
 * refresh never drops what the sign-in stored.
 */
const toProviderAuthInfo = (
  authStore: AuthService,
  providerId: string,
  info: AuthInfo,
  slot: CredentialSlot = DEFAULT_CREDENTIAL_SLOT,
): ProviderAuthInfo => {
  if (info.type === "api") {
    if (Predicate.isUndefined(info.metadata)) {
      return ProviderAuthInfo.cases.Api.make({ key: info.key, slot })
    }
    return ProviderAuthInfo.cases.Api.make({ key: info.key, metadata: info.metadata, slot })
  }
  return ProviderAuthInfo.cases.Oauth.make({
    slot,
    ...omitUndefined({ signedInAt: info.signedInAt, metadata: info.metadata }),
    update: <A, E>(
      f: (
        stored: Option.Option<StoredOAuthCredentials>,
      ) => Effect.Effect<readonly [A, Option.Option<StoredOAuthCredentials>], E>,
    ) =>
      authStore
        .update(
          providerId,
          (current) =>
            Effect.map(
              f(Option.flatMap(current, storedOAuthFields)),
              (pair): readonly [A, Option.Option<AuthInfo>] => [
                pair[0],
                Option.map(pair[1], (fields) =>
                  authValue({
                    type: "oauth",
                    ...fields,
                    ...omitUndefined({
                      metadata: Option.getOrUndefined(heldOAuthMetadata(current)),
                    }),
                  }),
                ),
              ],
            ),
          slot,
        )
        .pipe(
          Effect.catchIf(Schema.is(AuthError), (cause) =>
            Effect.fail(
              new ProviderAuthError({
                message: `Failed to persist auth for provider "${providerId}"`,
                cause,
              }),
            ),
          ),
        ),
    lockSourceRotation: sourceRotationLock(authStore, providerId),
  })
}

/**
 * The rotations `providerId`'s driver holds for sources other programs keep,
 * as a driver reaches them (`LockSourceRotation`): keyed by source, under
 * the provider's lock, with the store's faults as `ProviderAuthError`, and a
 * lock another holder kept for the whole wait as `CredentialStoreBusy`.
 */
const sourceRotationLock =
  (authStore: AuthService, providerId: string): LockSourceRotation =>
  (source) =>
  (use) => {
    const asAuthFailure = (cause: AuthError) =>
      new ProviderAuthError({
        message: `${cause.message} (provider "${providerId}")`,
        cause,
      })
    const asStoreFailure = (cause: AuthError): ProviderAuthError | CredentialStoreBusy => {
      if (cause.lockBusy === true) return new CredentialStoreBusy({ provider: providerId })
      return asAuthFailure(cause)
    }
    return authStore
      .withRotation(providerId, source, (held) =>
        use({
          read: held.read.pipe(
            Effect.catchTag("AuthError", (cause) => Effect.fail(asAuthFailure(cause))),
          ),
          write: (next) => held.write(next).pipe(Effect.mapError(asAuthFailure)),
          moveAside: (base) => held.moveAside(base).pipe(Effect.mapError(asAuthFailure)),
        }),
      )
      .pipe(Effect.catchIf(Schema.is(AuthError), (cause) => Effect.fail(asStoreFailure(cause))))
  }

/** The OAuth fields of a stored credential; none for an API key. */
const storedOAuthFields = (stored: AuthInfo): Option.Option<StoredOAuthCredentials> => {
  if (stored.type !== "oauth") return Option.none()
  const fields = { access: stored.access, refresh: stored.refresh, expires: stored.expires }
  if (Predicate.isUndefined(stored.accountId)) return Option.some(fields)
  return Option.some({ ...fields, accountId: stored.accountId })
}

/** The `metadata` of the OAuth record the store holds; none for an API key or a record without any. */
const heldOAuthMetadata = (current: Option.Option<AuthInfo>): Option.Option<AuthMetadata> =>
  Option.flatMap(current, (held) => {
    if (held.type !== "oauth") return Option.none()
    return Option.fromUndefinedOr(held.metadata)
  })

// ── provider login ──────────────────────────────────────────────────────────
//
// Login reads the drivers of the `ExtensionRegistry` in context: the caller
// provides the registry of the session's own profile.

/**
 * The method as `/auth` asks it: a prompt whose variable is set is left out,
 * since the driver reads the variable when the stored key has no answer.
 */
const askedMethod = (method: AuthMethod): Effect.Effect<AuthMethod> => {
  if (Predicate.isUndefined(method.prompts)) return Effect.succeed(method)
  return Effect.filter(method.prompts, (prompt) =>
    Effect.map(envCredentialSet(Option.fromUndefinedOr(prompt.env)), (set) => !set),
  ).pipe(Effect.map((prompts) => AuthMethod.make({ ...method, prompts })))
}

/** The login methods of each driver that has one, active generic providers included. */
export const listAuthMethods = Effect.fn("ProviderLogin.listMethods")(function* () {
  const { modelDrivers } = yield* servedProfile(yield* Auth)
  const result: Record<string, ReadonlyArray<AuthMethod>> = {}
  for (const provider of modelDrivers.values()) {
    // A driver that uses another's sign-in signs in through that one.
    if (credentialOwner(modelDrivers, provider.id) !== provider.id) continue
    if (!Predicate.isUndefined(provider.auth) && provider.auth.methods.length > 0) {
      result[provider.id] = yield* Effect.forEach(provider.auth.methods, askedMethod)
    }
  }
  return result
})

/** Immutable login address and original answers, held by the RPC lease. */
export interface ProviderLoginTarget {
  readonly owner: string
  readonly provider: string
  readonly method: number
  readonly slot: CredentialSlot
  readonly inputs?: AuthMetadata
  readonly persist: PersistAuth
}

export const captureProviderLogin = Effect.fn("ProviderLogin.capture")(function* (
  provider: string,
  method: number,
  slot: CredentialSlot = DEFAULT_CREDENTIAL_SLOT,
  inputs?: AuthMetadata,
) {
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  yield* credentialOrder(modelDrivers, yield* (yield* ExtensionRegistry).providerConfig, provider)
  const owner = credentialOwner(modelDrivers, provider)
  const auth = yield* Auth
  const target: ProviderLoginTarget = {
    provider,
    owner,
    method,
    slot,
    persist: persistAuthTo(auth, owner, slot),
  }
  if (Predicate.isNotUndefined(inputs)) return { ...target, inputs: { ...inputs } }
  return target
})

/** Start a driver's login; none when the method completed without a link. */
export const authorizeProvider = Effect.fn("ProviderLogin.authorize")(function* (
  sessionId: SessionId,
  provider: string,
  method: number,
  target?: ProviderLoginTarget,
) {
  const binding = target ?? (yield* captureProviderLogin(provider, method))
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  const platform = yield* GentPlatform
  const extProvider = modelDrivers.get(binding.provider)
  if (Predicate.isUndefined(extProvider?.auth?.authorize)) {
    return yield* new ProviderAuthError({
      message: `Provider "${provider}" does not support authorize`,
    })
  }
  const selectedMethod = extProvider.auth.methods[binding.method]
  if (Predicate.isUndefined(selectedMethod) || !authMethodAppliesTo(selectedMethod, binding.slot)) {
    return yield* new ProviderAuthError({
      message: "Sign-in method unavailable for this credential target",
    })
  }
  const authorizationId = yield* platform.randomId
  const extResult = yield* extProvider.auth
    .authorize({
      sessionId,
      methodIndex: binding.method,
      authorizationId,
      slot: binding.slot,
      inputs: binding.inputs,
      persist: binding.persist,
    })
    .pipe(
      Effect.catchDefect((e) =>
        Effect.fail(
          new ProviderAuthError({
            message: `Provider auth failed: ${causeMessage(e)}`,
            cause: e,
          }),
        ),
      ),
    )
  if (Option.isNone(extResult)) return Option.none()
  return Option.some(
    new AuthAuthorization({
      authorizationId,
      url: extResult.value.url,
      method: extResult.value.method,
      instructions: extResult.value.instructions,
    }),
  )
})

/** Finish a driver's login with the code the user brings back. */
export const completeProviderAuth = Effect.fn("ProviderLogin.callback")(function* (
  sessionId: SessionId,
  provider: string,
  method: number,
  authorizationId: string,
  code?: string,
  target?: ProviderLoginTarget,
) {
  const binding = target ?? (yield* captureProviderLogin(provider, method))
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  const extProvider = modelDrivers.get(binding.provider)
  // A driver without a callback finished its login in authorize (a "done" method).
  if (Predicate.isUndefined(extProvider?.auth?.callback)) return
  yield* extProvider.auth
    .callback({
      sessionId,
      methodIndex: binding.method,
      authorizationId,
      slot: binding.slot,
      inputs: binding.inputs,
      persist: binding.persist,
      code,
    })
    .pipe(
      Effect.catchDefect((e) =>
        Effect.fail(
          new ProviderAuthError({
            message: `Provider auth callback failed: ${causeMessage(e)}`,
            cause: e,
          }),
        ),
      ),
    )
})

// ── model catalog source ────────────────────────────────────────────────────

/*
 * models.dev is the model catalog, and core reads it. The owner's direction
 * (Pass 30), which replaces the rule that core fetches nothing: "models.dev is
 * integral to discovery of models via providers so we don't really need to
 * hardcode anything, only limiting factor is classes of api's we support",
 * and "snapshotting will be good so we don't constantly ping … we can put that
 * in our sqlite db".
 *
 * Two sources: `api.json` (the chat models) and `api.json?type=decision` (the
 * decision models, which `api.json` leaves out). Each is stored as served in
 * `model_catalog_snapshots`, with its ETag.
 *
 * - A read serves the snapshot in memory, or the stored row, at once.
 * - A read that finds the snapshot checked more than an hour ago starts one
 *   background revalidation: a GET with `If-None-Match`. A 304 moves
 *   `checked_at` only; a 200 replaces the row; any failure changes nothing.
 *   One revalidation runs at a time per process; there is no timer.
 * - With no row, the first read fetches and waits (10 s). It is the only
 *   blocking fetch. A source that could not be fetched is tried again in the
 *   background a minute later, so an offline start never waits twice.
 * - A body that does not parse is not stored.
 *
 * The catalog parses once per process and decodes a provider only when one is
 * read, field by field: an odd field drops itself, never the model.
 */

const MODELS_DEV_ORIGIN = "https://models.dev"
/**
 * Where the catalog is fetched: models.dev, or a mirror `GENT_MODEL_CATALOG_URL`
 * names. The test preload points it at a closed local port, so a test server
 * that forgets the fixture client never reaches the network.
 */
const catalogOrigin = Config.option(Config.NonEmptyString("GENT_MODEL_CATALOG_URL")).pipe(
  Effect.map((url) => Option.getOrElse(url, () => MODELS_DEV_ORIGIN).replace(/\/+$/, "")),
  Effect.orElseSucceed(() => MODELS_DEV_ORIGIN),
)
/** The two models.dev sources, as `model_catalog_snapshots.source` names them. */
const CATALOG_SOURCES = ["api.json", "api.json?type=decision"] as const
type CatalogSourceName = (typeof CATALOG_SOURCES)[number]
const CATALOG_FETCH_TIMEOUT = Duration.seconds(10)
const CATALOG_REVALIDATE_AFTER = Duration.hours(1)
/** How soon a source that could not be fetched at all is tried again. */
const CATALOG_RETRY_MISSING_AFTER = Duration.minutes(1)
/** A snapshot older than this is reported as a catalog failure. */
const CATALOG_OFFLINE_NOTICE_AFTER = Duration.days(7)

const decodeCatalogBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const RawCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
})
const decodeReasoningOption = Schema.decodeUnknownOption(ReasoningOption)
const decodeRawEffortOption = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("effort"), values: Schema.Array(Schema.Json) }),
)
const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

/** One field of a raw entry, decoded alone; none when it is absent or odd. */
const field = <A>(
  raw: JsonRecord,
  key: string,
  schema: Schema.Codec<A, unknown, never, never>,
): Option.Option<A> => Schema.decodeUnknownOption(schema)(raw[key])

/** The object under `key`, or an empty one when it is absent or not an object. */
const objectField = (raw: JsonRecord, key: string): JsonRecord =>
  Option.getOrElse(field(raw, key, JsonObject), () => ({}))

/** One `reasoning_options` entry; an effort list's `null` becomes `"none"`. */
const parseReasoningOption = (value: Schema.Json): Option.Option<ReasoningOption> =>
  Option.match(decodeRawEffortOption(value), {
    onNone: () => decodeReasoningOption(value),
    onSome: (effort) =>
      Option.some(
        ReasoningOption.cases.effort.make({
          type: "effort",
          values: effort.values.flatMap((each) => {
            if (Predicate.isString(each)) return [each]
            if (Predicate.isNull(each)) return ["none"]
            return []
          }),
        }),
      ),
  })

/**
 * The model `id` of a raw models.dev `models` object as a `CatalogModel`;
 * none when it is not an object. The models.dev field names
 * (`release_date`, `cache_read`, the `provider` override, `interleaved.field`,
 * `type`) are read here and only here.
 */
const parseCatalogModel = (models: JsonRecord, id: string): Option.Option<CatalogModel> =>
  Option.map(field(models, id, JsonObject), (raw) => {
    const override = objectField(raw, "provider")
    const cost = Option.map(field(raw, "cost", RawCost), (each) => ({
      input: each.input,
      output: each.output,
      ...omitUndefined({ cacheRead: each.cache_read, cacheWrite: each.cache_write }),
    }))
    const reasoningOptions = Option.map(
      field(raw, "reasoning_options", Schema.Array(Schema.Json)),
      (values) => values.flatMap((each) => Option.toArray(parseReasoningOption(each))),
    )
    const decision = field(raw, "type", Schema.String).pipe(
      Option.filter((type) => type === "decision"),
      Option.as(true),
    )
    return {
      id,
      name: Option.getOrElse(field(raw, "name", Schema.String), () => id),
      ...omitUndefined({
        cost: Option.getOrUndefined(cost),
        limit: Option.getOrUndefined(field(raw, "limit", CatalogLimit)),
        releaseDate: Option.getOrUndefined(field(raw, "release_date", Schema.String)),
        toolCall: Option.getOrUndefined(field(raw, "tool_call", Schema.Boolean)),
        reasoning: Option.getOrUndefined(field(raw, "reasoning", Schema.Boolean)),
        temperature: Option.getOrUndefined(field(raw, "temperature", Schema.Boolean)),
        reasoningOptions: Option.getOrUndefined(reasoningOptions),
        reasoningField: Option.getOrUndefined(
          field(objectField(raw, "interleaved"), "field", Schema.String),
        ),
        npm: Option.getOrUndefined(field(override, "npm", Schema.String)),
        api: Option.getOrUndefined(field(override, "api", Schema.String)),
        protocol: Option.getOrUndefined(field(override, "shape", Schema.String)),
        decision: Option.getOrUndefined(decision),
        imageInput: Option.getOrUndefined(
          Option.map(
            field(objectField(raw, "modalities"), "input", Schema.Array(Schema.String)),
            (inputs) => inputs.includes("image"),
          ),
        ),
      }),
    } satisfies CatalogModel
  })

/** The provider `id` of a raw models.dev body as a `CatalogProvider`; none when it is not an object. */
const parseCatalogProvider = (body: JsonRecord, id: string): Option.Option<CatalogProvider> =>
  Option.map(field(body, id, JsonObject), (raw) => {
    const models = objectField(raw, "models")
    return {
      id,
      name: Option.getOrElse(field(raw, "name", Schema.String), () => id),
      env: Option.getOrElse(field(raw, "env", Schema.Array(Schema.String)), () => []),
      ...omitUndefined({
        npm: Option.getOrUndefined(field(raw, "npm", Schema.String)),
        api: Option.getOrUndefined(field(raw, "api", Schema.String)),
      }),
      models: Object.keys(models).flatMap((modelId) =>
        Option.toArray(parseCatalogModel(models, modelId)),
      ),
    } satisfies CatalogProvider
  })

/** One parsed source: the raw providers, decoded one at a time on first read. */
interface ParsedCatalogSource {
  readonly raw: JsonRecord
  readonly decoded: Map<string, Option.Option<CatalogProvider>>
}

const parsedCatalogSource = (raw: JsonRecord): ParsedCatalogSource => ({
  raw,
  decoded: new Map(),
})

const sourceProvider = (
  source: ParsedCatalogSource,
  id: string,
): Option.Option<CatalogProvider> => {
  const cached = source.decoded.get(id)
  if (Predicate.isNotUndefined(cached)) return cached
  let decoded = Option.none<CatalogProvider>()
  if (Object.hasOwn(source.raw, id)) decoded = parseCatalogProvider(source.raw, id)
  source.decoded.set(id, decoded)
  return decoded
}

/** What the process holds of one source: the parsed body, its ETag, when it was last confirmed. */
interface HeldCatalogSource {
  readonly parsed: ParsedCatalogSource
  readonly etag: Option.Option<string>
  readonly checkedAt: number
}

/** Each source held, or the time a fetch of a source with no row last failed. */
interface HeldCatalog {
  readonly sources: Readonly<Partial<Record<CatalogSourceName, HeldCatalogSource>>>
  readonly missingSince: Readonly<Partial<Record<CatalogSourceName, number>>>
}

/**
 * The models.dev catalog as one read sees it: each provider (its chat models,
 * then its decision models), every provider id, and why the catalog may be
 * missing or old.
 */
export interface LoadedModelCatalog extends ModelCatalogView {
  readonly providerIds: ReadonlyArray<string>
  /** `models.dev catalog N days old, offline`, or unavailable; none when fresh enough. */
  readonly failure: Option.Option<string>
}

const loadedModelCatalog = (held: HeldCatalog, now: number): LoadedModelCatalog => {
  const chat = Option.fromUndefinedOr(held.sources["api.json"])
  const decision = Option.fromUndefinedOr(held.sources["api.json?type=decision"])
  const provider = (id: string): Option.Option<CatalogProvider> => {
    const fromChat = Option.flatMap(chat, (source) => sourceProvider(source.parsed, id))
    const fromDecision = Option.flatMap(decision, (source) => sourceProvider(source.parsed, id))
    if (Option.isNone(fromDecision)) return fromChat
    if (Option.isNone(fromChat)) return fromDecision
    return Option.some({
      ...fromChat.value,
      models: [...fromChat.value.models, ...fromDecision.value.models],
    })
  }
  const providerIds = [
    ...new Set([
      ...Option.match(chat, {
        onNone: () => [],
        onSome: (source) => Object.keys(source.parsed.raw),
      }),
      ...Option.match(decision, {
        onNone: () => [],
        onSome: (source) => Object.keys(source.parsed.raw),
      }),
    ]),
  ]
  const failure = Option.match(chat, {
    onNone: () =>
      Option.some("models.dev catalog unavailable: no snapshot stored and models.dev unreachable"),
    onSome: (source) => {
      const age = now - source.checkedAt
      if (age <= Duration.toMillis(CATALOG_OFFLINE_NOTICE_AFTER)) return Option.none<string>()
      const days = Math.floor(age / Duration.toMillis(Duration.days(1)))
      return Option.some(`models.dev catalog ${days} days old, offline`)
    },
  })
  return { provider, providerIds, failure }
}

/**
 * The catalog of two bodies as served, confirmed now: what a driver test hands
 * a driver's `listModels` or `resolveModel` without a server.
 */
export const modelCatalogFromBodies = (bodies: {
  readonly chat: string
  readonly decision: string
}): LoadedModelCatalog => {
  const held = (body: string): Option.Option<HeldCatalogSource> =>
    Option.map(decodeCatalogBody(body), (raw) => ({
      parsed: parsedCatalogSource(raw),
      etag: Option.none(),
      checkedAt: 0,
    }))
  const sources: Partial<Record<CatalogSourceName, HeldCatalogSource>> = omitUndefined({
    "api.json": Option.getOrUndefined(held(bodies.chat)),
    "api.json?type=decision": Option.getOrUndefined(held(bodies.decision)),
  })
  return loadedModelCatalog({ sources, missingSince: {} }, 0)
}

/**
 * A source to revalidate now: confirmed over an hour ago, or missing and
 * last tried over a minute ago. A source with neither a snapshot nor a failed
 * try is still in its first load, which its own fetch serves.
 */
const sourceDue = (held: HeldCatalog, source: CatalogSourceName, now: number): boolean => {
  const kept = held.sources[source]
  if (Predicate.isNotUndefined(kept)) {
    return now - kept.checkedAt > Duration.toMillis(CATALOG_REVALIDATE_AFTER)
  }
  const missingSince = held.missingSince[source]
  if (Predicate.isUndefined(missingSince)) return false
  return now - missingSince > Duration.toMillis(CATALOG_RETRY_MISSING_AFTER)
}

/** A body that arrived: the text as served and its ETag. */
interface ArrivedCatalogBody {
  readonly body: string
  readonly etag: Option.Option<string>
}

interface ModelCatalogSourceService {
  /**
   * The catalog once the chat source (`api.json`) is loaded: its snapshot at
   * once, or with no row its first fetch. The decision source joins once its
   * own load is done, so a stored chat snapshot never waits on it. Never
   * fails: with no snapshot and no network it is empty and says why in
   * `failure`.
   */
  readonly read: Effect.Effect<LoadedModelCatalog>
  /** `read` once the decision source is loaded too: for a reader of decision models. */
  readonly readWithDecisions: Effect.Effect<LoadedModelCatalog>
}

export class ModelCatalogSource extends Context.Service<
  ModelCatalogSource,
  ModelCatalogSourceService
>()("@gent/core/src/runtime/provider/ModelCatalogSource") {
  static Live: Layer.Layer<
    ModelCatalogSource,
    never,
    ModelCatalogSnapshotStorage | HttpClient.HttpClient
  > = Layer.effect(
    ModelCatalogSource,
    Effect.gen(function* () {
      const storage = yield* ModelCatalogSnapshotStorage
      const http = yield* HttpClient.HttpClient
      const origin = yield* catalogOrigin
      const scope = yield* Effect.scope
      const held = yield* Ref.make<HeldCatalog>({ sources: {}, missingSince: {} })
      const loadLock = yield* Semaphore.make(1)
      const loading = yield* Ref.make(Option.none<Record<CatalogSourceName, Fiber.Fiber<void>>>())
      const revalidating = yield* Ref.make(false)

      /** The source's body, or none on a 304; fails on any other answer or after 10 s. */
      const fetchSource = Effect.fn("ModelCatalogSource.fetch")(function* (
        source: CatalogSourceName,
        etag: Option.Option<string>,
      ) {
        let request = HttpClientRequest.get(`${origin}/${source}`).pipe(
          HttpClientRequest.setHeader("user-agent", "gent"),
        )
        if (Option.isSome(etag)) {
          request = HttpClientRequest.setHeader(request, "if-none-match", etag.value)
        }
        const response = yield* http.execute(request)
        if (response.status === 304) return Option.none<ArrivedCatalogBody>()
        if (response.status !== 200) {
          return yield* Effect.fail(`models.dev answered ${response.status}`)
        }
        const body = yield* response.text
        return Option.some({
          body,
          etag: Option.fromUndefinedOr(response.headers["etag"]),
        } satisfies ArrivedCatalogBody)
      }, Effect.timeout(CATALOG_FETCH_TIMEOUT))

      /** Store a body that parses; none when it does not. */
      const storeArrived = Effect.fn("ModelCatalogSource.store")(function* (
        source: CatalogSourceName,
        arrived: ArrivedCatalogBody,
      ) {
        const parsed = decodeCatalogBody(arrived.body)
        if (Option.isNone(parsed)) {
          yield* Effect.logWarning("model-catalog.unparsable-body").pipe(
            Effect.annotateLogs({ source }),
          )
          return Option.none<HeldCatalogSource>()
        }
        const now = yield* Clock.currentTimeMillis
        yield* storage
          .put({
            source,
            body: arrived.body,
            etag: arrived.etag,
            fetched_at: now,
            checked_at: now,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("model-catalog.store-failed").pipe(
                Effect.annotateLogs({ source, error: error.message }),
              ),
            ),
          )
        return Option.some({
          parsed: parsedCatalogSource(parsed.value),
          etag: arrived.etag,
          checkedAt: now,
        } satisfies HeldCatalogSource)
      })

      /** The stored row of a source, parsed; none when absent, unreadable or unparsable. */
      const storedSource = Effect.fn("ModelCatalogSource.stored")(function* (
        source: CatalogSourceName,
      ) {
        const row = yield* storage
          .get(source)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("model-catalog.read-failed").pipe(
                Effect.annotateLogs({ source, error: error.message }),
                Effect.as(Option.none()),
              ),
            ),
          )
        return Option.flatMap(row, (stored) =>
          Option.map(decodeCatalogBody(stored.body), (parsed) => ({
            parsed: parsedCatalogSource(parsed),
            etag: stored.etag,
            checkedAt: stored.checked_at,
          })),
        )
      })

      /**
       * One source brought up to date: a 304 confirms what is held, a 200 that
       * parses replaces it, and a failure keeps it (or, with nothing held,
       * records when it failed).
       */
      const refreshSource = Effect.fn("ModelCatalogSource.refresh")(function* (
        source: CatalogSourceName,
        kept: Option.Option<HeldCatalogSource>,
      ) {
        const etag = Option.flatMap(kept, (each) => each.etag)
        const answer = yield* fetchSource(source, etag).pipe(
          Effect.asSome,
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            return Effect.logWarning("model-catalog.fetch-failed").pipe(
              Effect.annotateLogs({ source, error: causeMessage(Cause.squash(cause)) }),
              Effect.as(Option.none<Option.Option<ArrivedCatalogBody>>()),
            )
          }),
        )
        if (Option.isNone(answer)) return kept
        const arrived = answer.value
        if (Option.isSome(arrived)) {
          const stored = yield* storeArrived(source, arrived.value)
          return Option.orElse(stored, () => kept)
        }
        if (Option.isNone(kept)) return kept
        const now = yield* Clock.currentTimeMillis
        yield* storage
          .confirm(source, now)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("model-catalog.confirm-failed").pipe(
                Effect.annotateLogs({ source, error: error.message }),
              ),
            ),
          )
        return Option.some({ ...kept.value, checkedAt: now })
      })

      /** Fold one source's outcome into what the process holds. */
      const holdSource = (
        current: HeldCatalog,
        source: CatalogSourceName,
        outcome: Option.Option<HeldCatalogSource>,
        now: number,
      ): HeldCatalog =>
        Option.match(outcome, {
          onSome: (kept) => ({
            sources: { ...current.sources, [source]: kept },
            missingSince: Object.fromEntries(
              Object.entries(current.missingSince).filter(([name]) => name !== source),
            ),
          }),
          onNone: () => {
            if (Predicate.isNotUndefined(current.sources[source])) return current
            return { ...current, missingSince: { ...current.missingSince, [source]: now } }
          },
        })

      const revalidate = Effect.gen(function* () {
        const before = yield* Ref.get(held)
        const now = yield* Clock.currentTimeMillis
        const due = CATALOG_SOURCES.filter((source) => sourceDue(before, source, now))
        const outcomes = yield* Effect.forEach(
          due,
          (source) =>
            Effect.map(
              refreshSource(source, Option.fromUndefinedOr(before.sources[source])),
              (outcome) => [source, outcome] as const,
            ),
          { concurrency: CATALOG_SOURCES.length },
        )
        const after = yield* Clock.currentTimeMillis
        yield* Ref.update(held, (current) =>
          outcomes.reduce(
            (next, [source, outcome]) => holdSource(next, source, outcome, after),
            current,
          ),
        )
      }).pipe(Effect.ensuring(Ref.set(revalidating, false)))

      /** Start one background revalidation unless one is running. */
      const startRevalidation = Effect.gen(function* () {
        const start = yield* Ref.modify(revalidating, (running) => [!running, true] as const)
        if (start) yield* Effect.forkIn(revalidate, scope)
      })

      /** Load one source's stored row, else fetch it, and hold the outcome. */
      const loadSource = (source: CatalogSourceName) =>
        Effect.gen(function* () {
          let outcome = yield* storedSource(source)
          if (Option.isNone(outcome)) outcome = yield* refreshSource(source, Option.none())
          const now = yield* Clock.currentTimeMillis
          yield* Ref.update(held, (current) => holdSource(current, source, outcome, now))
        })

      /**
       * Each source's one load, started at most once as a fiber of the
       * layer's scope; the two run apart, so a source with a row never waits
       * on the other's fetch. A reader that is stopped (an Esc during the
       * first fetch) stops only its wait: the load goes on, and the next
       * reader joins it.
       */
      const startLoads = Effect.gen(function* () {
        const running = yield* Ref.get(loading)
        if (Option.isSome(running)) return running.value
        const fibers: Record<CatalogSourceName, Fiber.Fiber<void>> = {
          "api.json": yield* Effect.forkIn(loadSource("api.json"), scope),
          "api.json?type=decision": yield* Effect.forkIn(
            loadSource("api.json?type=decision"),
            scope,
          ),
        }
        yield* Ref.set(loading, Option.some(fibers))
        return fibers
      }).pipe(loadLock.withPermits(1))

      /** The catalog once the loads of `waitFor` are done; the other sources as far as they are. */
      const readAfter = (waitFor: ReadonlyArray<CatalogSourceName>) =>
        Effect.gen(function* () {
          const fibers = yield* startLoads
          yield* Effect.forEach(waitFor, (source) => Fiber.join(fibers[source]), {
            discard: true,
          })
          const loaded = yield* Ref.get(held)
          const now = yield* Clock.currentTimeMillis
          if (CATALOG_SOURCES.some((source) => sourceDue(loaded, source, now))) {
            yield* startRevalidation
          }
          return loadedModelCatalog(loaded, now)
        })

      return ModelCatalogSource.of({
        read: readAfter(["api.json"]).pipe(Effect.withSpan("ModelCatalogSource.read")),
        readWithDecisions: readAfter(CATALOG_SOURCES).pipe(
          Effect.withSpan("ModelCatalogSource.readWithDecisions"),
        ),
      })
    }),
  )

  /** A catalog that never changes and fetches nothing: a host that brings its own snapshot. */
  static fixed = (catalog: LoadedModelCatalog): Layer.Layer<ModelCatalogSource> =>
    Layer.succeed(
      ModelCatalogSource,
      ModelCatalogSource.of({
        read: Effect.succeed(catalog),
        readWithDecisions: Effect.succeed(catalog),
      }),
    )
}

// ── driver composition ──────────────────────────────────────────────────────
//
// A model driver is the adapter of one models.dev provider. Core composes the
// catalog entry, the API class that speaks it and the adapter's endpoint into
// a model, and lists the provider's models a class speaks, unless the driver
// resolves or lists them itself.

/** The drivers and the API classes of one profile. */
interface DriverProfile {
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly apiClasses: ReadonlyMap<string, ApiClassContribution>
}

/** The models.dev provider `driver` serves. */
const catalogProviderOf = (driver: ModelDriverContribution): string =>
  driver.catalogProvider ?? driver.id

/**
 * The one name `driver` serves `modelName` as: the name its alias stands
 * for, else itself. A name the driver's view of `catalog` lists is never
 * an alias: the real model wins over an alias of the same name. The turn's
 * model metadata (`ModelRegistry`), its dispatch (`resolveDriverModel`) and
 * the classifier match all read this, so metadata and dispatch name one model.
 */
const currentModelName = (
  catalog: ModelCatalogView,
  driver: ModelDriverContribution,
  modelName: string,
): string => {
  const listed = catalogModelEntry(
    driverCatalogView(catalog, driver),
    catalogProviderOf(driver),
    modelName,
  )
  if (Option.isSome(listed)) return modelName
  return Option.fromUndefinedOr(driver.aliases).pipe(
    Option.filter((aliases) => Object.hasOwn(aliases, modelName)),
    Option.flatMap((aliases) => Option.fromUndefinedOr(aliases[modelName])),
    Option.getOrElse(() => modelName),
  )
}

/** `provider/model` with the one name its driver serves it as; an id no driver serves stays. */
const currentModelId = (
  catalog: ModelCatalogView,
  drivers: ModelDrivers,
  modelId: string,
): string =>
  Option.flatMap(parseModelId(modelId), ([providerId, modelName]) =>
    Option.map(
      Option.fromUndefinedOr(drivers.get(providerId)),
      (driver) => `${providerId}/${currentModelName(catalog, driver, modelName)}`,
    ),
  ).pipe(Option.getOrElse(() => modelId))

/** The catalog as `driver` reads it: its catalog provider's entries with its overrides applied. */
const driverCatalogView = (
  catalog: ModelCatalogView,
  driver: ModelDriverContribution,
): ModelCatalogView => {
  const overrides = driver.overrides ?? []
  if (overrides.length === 0) return catalog
  const own = catalogProviderOf(driver)
  return {
    provider: (id) =>
      Option.map(catalog.provider(id), (provider) => {
        if (id !== own) return provider
        return {
          ...provider,
          models: provider.models.map((entry) =>
            overrides.reduce((patched, override) => {
              if (!override.match.test(patched.id)) return patched
              return override.patch(patched)
            }, entry),
          ),
        }
      }),
  }
}

/**
 * The models core lists for a driver with an endpoint: its catalog
 * provider's entries the agent loop can drive (tool calling, not a decision
 * model) that some class speaks, each with the class's cache lifetime, then
 * the provider's decision models when the driver resolves classifiers.
 */
const catalogDriverModels = (
  apiClasses: ReadonlyMap<string, ApiClassContribution>,
  driver: ModelDriverContribution,
  catalog: ModelCatalogView,
): ReadonlyArray<Model> => {
  const providerId = catalogProviderOf(driver)
  const entries = Option.match(catalog.provider(providerId), {
    onNone: (): ReadonlyArray<CatalogModel> => [],
    onSome: (provider) => provider.models,
  })
  const chat = entries.flatMap((raw) => {
    if (raw.toolCall === false || raw.decision === true) return []
    const entry = catalogModelEntry(catalog, providerId, raw.id)
    const apiClass = Option.flatMap(entry, (value) => apiClassFor(apiClasses.values(), value))
    return Option.toArray(
      Option.map(apiClass, (speaker) => {
        const model = modelFromCatalog(driver.id, raw, speaker)
        return Option.match(speaker.promptCacheTtl, {
          onNone: () => model,
          onSome: (ttl) => Model.make({ ...model, promptCacheTtlMs: Duration.toMillis(ttl) }),
        })
      }),
    )
  })
  if (Predicate.isUndefined(driver.resolveDecisionModel)) return chat
  const classifiers = entries
    .filter((entry) => entry.decision === true)
    .map((entry) => modelFromCatalog(driver.id, entry))
  return [...chat, ...classifiers]
}

/** The driver's models: its own list over its catalog view, else core's. */
const driverModels = (
  apiClasses: ReadonlyMap<string, ApiClassContribution>,
  driver: ModelDriverContribution,
  catalog: ModelCatalogView,
  auth: Option.Option<ProviderAuthInfo>,
): Effect.Effect<ReadonlyArray<Model>, DriverError | ProviderAuthError> => {
  const view = driverCatalogView(catalog, driver)
  const listModels = driver.listModels
  if (Predicate.isNotUndefined(listModels)) {
    return Effect.suspend(() => listModels(view, Option.getOrUndefined(auth)))
  }
  return Effect.sync(() => catalogDriverModels(apiClasses, driver, view))
}

/** Whether a driver lists models: its own list, or core's for a driver with an endpoint. */
const listsModels = (driver: ModelDriverContribution): boolean =>
  Predicate.isNotUndefined(driver.listModels) || Predicate.isNotUndefined(driver.endpoint)

const driverFailure = (driver: ModelDriverContribution, reason: string): DriverError =>
  new DriverError({ driver: DriverFailureId.make(driver.id), reason })

/** One model a driver resolves: the request core or a test hands `resolveDriverModel`. */
interface DriverModelRequest {
  readonly driver: ModelDriverContribution
  readonly apiClasses: ReadonlyMap<string, ApiClassContribution>
  readonly modelName: string
  readonly auth: Option.Option<ProviderAuthInfo>
  readonly hints: Option.Option<ProviderHints>
  readonly catalog: ModelCatalogView
}

/**
 * Resolve one model of a driver, an alias as the name it stands for: the
 * driver's own `resolveModel` over its catalog view, else core's
 * composition: the catalog entry, the class that speaks it and the driver's
 * endpoint. A decision model fails with
 * `DriverError` on either path; with core's composition, so do a model with
 * no entry and a model no registered class speaks.
 */
export const resolveDriverModel = (
  request: DriverModelRequest,
): Effect.Effect<ProviderResolution, ProviderAuthError | DriverError> =>
  Effect.gen(function* () {
    const { driver } = request
    const modelName = currentModelName(request.catalog, driver, request.modelName)
    const view = driverCatalogView(request.catalog, driver)
    const entry = catalogModelEntry(view, catalogProviderOf(driver), modelName)
    if (Option.exists(entry, (value) => value.decision === true)) {
      return yield* driverFailure(
        driver,
        `${driver.id}/${modelName} is a classifier model: it runs no turn; a cell asks it with models.decide`,
      )
    }
    const own = driver.resolveModel
    if (Predicate.isNotUndefined(own)) {
      return yield* own(
        modelName,
        Option.getOrUndefined(request.auth),
        Option.getOrUndefined(request.hints),
        view,
      )
    }
    const endpointFor = driver.endpoint
    if (Predicate.isUndefined(endpointFor)) {
      return yield* driverFailure(driver, `${driver.name} names no endpoint and no resolveModel`)
    }
    if (Option.isNone(entry)) {
      return yield* driverFailure(
        driver,
        `${driver.name} model "${modelName}" has no entry in the models.dev catalog`,
      )
    }
    const apiClass = apiClassFor(request.apiClasses.values(), entry.value)
    if (Option.isNone(apiClass)) {
      const npm = Option.getOrElse(Option.fromUndefinedOr(entry.value.npm), () => "no AI SDK")
      return yield* driverFailure(
        driver,
        `${driver.name} model "${modelName}" speaks the ${npm} wire format, which gent does not support`,
      )
    }
    const endpoint = yield* endpointFor(
      modelName,
      Option.getOrUndefined(request.auth),
      Option.getOrUndefined(request.hints),
    )
    return yield* apiClass.value.resolveModel({
      providerId: driver.id,
      model: entry.value,
      hints: request.hints,
      apiKey: endpoint.apiKey,
      baseUrl: Option.orElse(endpoint.baseUrl, () => Option.fromUndefinedOr(entry.value.api)),
      transformClient: endpoint.transformClient,
    })
  })

/** A model driver whose catalog could not be read; its models are left out. */
export interface ModelCatalogFailure {
  readonly driverId: string
  readonly error: string
}

const decodeModelList = Schema.decodeUnknownOption(Schema.Array(Model))
const isDriverError = Schema.is(DriverError)

/**
 * Every model driver's list, built from the catalog core read. A driver whose
 * list fails (an error, a defect, or a list that does not decode) is skipped
 * and reported, so one driver never hides the models of the others. An auth
 * store that cannot be read is not one driver's failure: it fails the whole
 * list as a `ProviderAuthError`. A catalog that is missing or old is reported
 * under each driver that lists models.
 *
 * `resolveAuths` names the credentials each driver lists with, in its
 * credential order: a model any of them serves is listed once, as the first
 * credential that lists it sees it (its own subset and prices). With none,
 * a driver lists with no credential.
 */
export const listModelCatalog = Effect.fn("ModelCatalog.list")(function* (
  profile: DriverProfile,
  catalog: LoadedModelCatalog,
  resolveAuths?: (
    driverId: string,
  ) => Effect.Effect<ReadonlyArray<Option.Option<ProviderAuthInfo>>, ProviderAuthError>,
) {
  const models: Array<Model> = []
  const failures: Array<ModelCatalogFailure> = []
  for (const driver of profile.modelDrivers.values()) {
    if (!listsModels(driver)) continue
    if (Option.isSome(catalog.failure)) {
      failures.push({ driverId: driver.id, error: catalog.failure.value })
    }
    let auths: ReadonlyArray<Option.Option<ProviderAuthInfo>> = [Option.none()]
    if (Predicate.isNotUndefined(resolveAuths)) auths = yield* resolveAuths(driver.id)
    const seen = new Set<string>()
    let failed = false
    for (const auth of auths) {
      const listed = yield* Effect.suspend(() =>
        driverModels(profile.apiClasses, driver, catalog, auth),
      ).pipe(
        Effect.flatMap((list) =>
          Effect.fromOption(decodeModelList(list)).pipe(
            Effect.mapError(
              () =>
                new DriverError({
                  driver: DriverFailureId.make(driver.id),
                  reason: `Model driver "${driver.id}" returned an invalid model catalog`,
                }),
            ),
          ),
        ),
        Effect.asSome,
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
          const squashed = Cause.squash(cause)
          let error = causeMessage(squashed)
          if (isDriverError(squashed)) error = squashed.reason
          if (!failed) failures.push({ driverId: driver.id, error })
          failed = true
          return Effect.logWarning("Model driver catalog failed; its models are skipped").pipe(
            Effect.annotateLogs({ driver: driver.id, error }),
            Effect.as(Option.none<ReadonlyArray<Model>>()),
          )
        }),
      )
      if (Option.isNone(listed)) continue
      for (const model of listed.value) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        models.push(model)
      }
    }
  }
  return { models, failures }
})

// ── generic providers ───────────────────────────────────────────────────────
//
// Any models.dev provider whose models a registered API class speaks works
// with a key and no code: core builds its driver from the catalog entry. The
// owner's rule: "models.dev is integral to discovery of models via providers
// so we don't really need to hardcode anything, only limiting factor is
// classes of api's we support".
//
// - A provider an adapter serves (a registered driver's id or catalog
//   provider), a provider no class speaks, and a `disabledProviders` id get
//   no generic driver.
// - A generic provider is active, and lists its models and its `/auth` row,
//   when it has a `providers` config entry, a stored key under its id, or a
//   key variable of its `env` set. The rest are found by the `/auth` search.
// - The key comes from the store, then the first key variable set. Each
//   `${VAR}` in the base URL is a prompt of the sign-in (`key` and `env` the
//   variable's name), filled from the stored answer, then the variable.

const URL_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Each `${VAR}` a base URL names, in order, once each. */
const urlVariables = (api: string): ReadonlyArray<string> => [
  ...new Set(
    [...api.matchAll(URL_VARIABLE)].flatMap((match) =>
      Option.toArray(Option.fromUndefinedOr(match[1])),
    ),
  ),
]

/** The variables a provider's base URL names; none when it names no URL. */
const providerUrlVariables = (provider: CatalogProvider): ReadonlyArray<string> =>
  urlVariables(provider.api ?? "")

/** The variables of a provider's `env` that hold its key: those its base URL does not name. */
const keyVariables = (provider: CatalogProvider): ReadonlyArray<string> => {
  const inUrl = providerUrlVariables(provider)
  return provider.env.filter((name) => !inUrl.includes(name))
}

/** The non-empty value of an env variable. */
const envValue = (name: string): Effect.Effect<Option.Option<string>> =>
  Config.option(Config.NonEmptyString(name)).pipe(Effect.orElseSucceed(() => Option.none<string>()))

/** The first of `names` whose variable is set, with its value. */
const firstEnvValue = (
  names: ReadonlyArray<string>,
): Effect.Effect<Option.Option<readonly [string, string]>> =>
  Effect.reduce(
    names,
    () => Option.none<readonly [string, string]>(),
    (found, name) => {
      if (Option.isSome(found)) return Effect.succeed(found)
      return Effect.map(
        envValue(name),
        Option.map((value) => [name, value] as const),
      )
    },
  )

/**
 * `model` as `apiClass` speaks it: its first protocol (a protocol wins over
 * a package), else its first package with the model's own protocol dropped.
 */
const spokenBy =
  (apiClass: ApiClassContribution) =>
  (model: CatalogModel): CatalogModel => {
    const protocol = Option.fromUndefinedOr(apiClass.protocols[0])
    if (Option.isSome(protocol)) return { ...model, protocol: protocol.value }
    return { ...Struct.omit(model, ["protocol"]), ...omitUndefined({ npm: apiClass.npm[0] }) }
  }

/**
 * The catalog provider `id` with its `providers` config entry applied: the
 * entry's `name`, `api` and `env` replace the catalog's, each of its
 * `models` patches the catalog model of that id field by field (or adds
 * one), and its `class` makes that API class speak every model. With no
 * catalog provider the entry is a new provider.
 */
const configuredProvider = (
  base: Option.Option<CatalogProvider>,
  id: string,
  entry: ProviderConfigEntry,
  apiClasses: ReadonlyMap<string, ApiClassContribution>,
): CatalogProvider => {
  const current = Option.getOrElse(base, (): CatalogProvider => ({
    id,
    name: id,
    env: [],
    models: [],
  }))
  const patches = entry.models ?? {}
  const patched = current.models.map((model) =>
    Option.match(parseCatalogModel(patches, model.id), {
      onNone: () => model,
      onSome: (patch) => {
        let name = model.name
        if (Object.hasOwn(patches[model.id] ?? {}, "name")) name = patch.name
        return { ...model, ...patch, name }
      },
    }),
  )
  const added = Object.keys(patches)
    .filter((modelId) => !current.models.some((model) => model.id === modelId))
    .flatMap((modelId) => Option.toArray(parseCatalogModel(patches, modelId)))
  const speak = Option.match(
    Option.flatMap(Option.fromUndefinedOr(entry.class), (classId) =>
      Option.fromUndefinedOr(apiClasses.get(classId)),
    ),
    { onNone: () => (model: CatalogModel) => model, onSome: spokenBy },
  )
  return {
    ...current,
    ...omitUndefined({ name: entry.name, api: entry.api, env: entry.env }),
    models: [...patched, ...added].map(speak),
  }
}

/** The catalog with the config's `providers` entries applied (`configuredProvider`). */
const configuredCatalog = (
  catalog: LoadedModelCatalog,
  config: ProviderConfig,
  apiClasses: ReadonlyMap<string, ApiClassContribution>,
): LoadedModelCatalog => {
  const entries = config.providers ?? {}
  const configured = Object.keys(entries)
  if (configured.length === 0) return catalog
  const provider = (id: string): Option.Option<CatalogProvider> => {
    const entry = Option.liftPredicate(entries[id], Predicate.isNotUndefined)
    if (!Object.hasOwn(entries, id) || Option.isNone(entry)) return catalog.provider(id)
    return Option.some(configuredProvider(catalog.provider(id), id, entry.value, apiClasses))
  }
  return {
    ...catalog,
    provider,
    providerIds: [...new Set([...catalog.providerIds, ...configured])],
  }
}

/** Whether some registered class speaks a model of `provider` the agent loop can drive. */
const providerServable = (
  apiClasses: ReadonlyMap<string, ApiClassContribution>,
  catalog: ModelCatalogView,
  provider: CatalogProvider,
): boolean =>
  provider.models.some((model) => {
    if (model.toolCall === false || model.decision === true) return false
    return Option.isSome(
      Option.flatMap(catalogModelEntry(catalog, provider.id, model.id), (entry) =>
        apiClassFor(apiClasses.values(), entry),
      ),
    )
  })

/** The answer stored with an API sign-in for `key`, when it is not empty. */
const storedPromptAnswer = (authInfo: Option.Option<ProviderAuthInfo>, key: string) =>
  authInfo.pipe(
    Option.flatMap((auth) => {
      if (auth._tag !== "Api") return Option.none()
      return Option.fromUndefinedOr(auth.metadata?.[key])
    }),
    Option.filter((answer) => answer.trim() !== ""),
  )

/** The value of a base URL's `${name}`: the stored answer, then the variable. */
const urlVariableValue = (
  provider: CatalogProvider,
  name: string,
  authInfo: Option.Option<ProviderAuthInfo>,
): Effect.Effect<string, ProviderAuthError> =>
  Option.match(storedPromptAnswer(authInfo, name), {
    onSome: (answer) => Effect.succeed(answer),
    onNone: () =>
      Effect.flatMap(envValue(name), (value) =>
        Effect.fromOption(value).pipe(
          Effect.mapError(
            () =>
              new ProviderAuthError({
                message: `${provider.name} needs ${name}: none stored with the sign-in and no ${name} env var; sign in again with /auth`,
              }),
          ),
        ),
      ),
  })

/** A variable that begins a base URL (Neon's `${NEON_AI_GATEWAY_BASE_URL}/v1`): it holds the URL's origin. */
const LEADING_URL_VARIABLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/

const parseUrl = Option.liftThrowable((value: string) => new URL(value))

/** Whether a URL carries a user or a password, which would sign the request as someone else's. */
const hasCredentials = (url: URL): boolean => url.username !== "" || url.password !== ""

/**
 * `api` with each `${VAR}` filled from the stored answer, then the variable.
 * A variable that begins the URL holds its origin and path prefix: an
 * absolute https URL with no user, password, query or fragment (no `?` or
 * `#` at all, a bare one included), kept as the user typed it. Any other
 * variable fills one component, percent-encoded, so its value cannot add a
 * host, a user, a path or a query, and is never `.` or `..`, so it cannot
 * leave the path: the key goes only to a host and path the catalog and the
 * user typed. The filled URL must parse, with no user or password.
 */
const filledBaseUrl = (
  provider: CatalogProvider,
  api: string,
  authInfo: Option.Option<ProviderAuthInfo>,
): Effect.Effect<string, ProviderAuthError> =>
  Effect.gen(function* () {
    const leading = Option.fromNullishOr(LEADING_URL_VARIABLE.exec(api))
    let prefix = ""
    let rest = api
    if (Option.isSome(leading)) {
      const [placeholder, name = ""] = leading.value
      const value = yield* urlVariableValue(provider, name, authInfo)
      // A bare trailing `?` or `#` parses as an empty query or fragment, so
      // the raw value must hold neither.
      const origin = yield* Effect.fromOption(
        Option.filter(
          parseUrl(value),
          (url) =>
            url.protocol === "https:" &&
            !hasCredentials(url) &&
            !value.includes("?") &&
            !value.includes("#"),
        ),
      ).pipe(
        Effect.mapError(
          () =>
            new ProviderAuthError({
              message: `${provider.name} needs ${name} as an https URL with no user, password, query or fragment; sign in again with /auth`,
            }),
        ),
      )
      prefix = origin.href.replace(/\/+$/, "")
      rest = api.slice(placeholder.length)
    }
    const names = urlVariables(rest)
    for (const name of names) {
      const value = yield* urlVariableValue(provider, name, authInfo)
      // Percent-encoding leaves dots, and a `.` or `..` segment moves the path.
      if (value === "." || value === "..") {
        return yield* new ProviderAuthError({
          message: `${provider.name} needs ${name} as one URL component, not "${value}"; sign in again with /auth`,
        })
      }
      rest = rest.replaceAll(`\${${name}}`, encodeURIComponent(value))
    }
    const filled = `${prefix}${rest}`
    if (Option.exists(parseUrl(filled), (url) => !hasCredentials(url))) return filled
    return yield* new ProviderAuthError({
      message: `${provider.name} base URL ${api} is no valid URL once ${names.join(", ")} is filled; sign in again with /auth`,
    })
  })

/**
 * Refuse an API sign-in to the catalog provider `providerId` whose answers a
 * turn would refuse: each base URL with a variable (the provider's and each
 * model's own) is filled as a turn fills it (`filledBaseUrl`), with the
 * answers being signed in, so the sign-in fails with the turn's message. A
 * URL with a variable that has no answer and no env var is not checked: the
 * auth listing names that prompt as missing.
 */
const checkBaseUrlAnswers = Effect.fn("GenericProvider.checkBaseUrlAnswers")(function* (
  providerId: string,
  info: AuthApi,
) {
  const registry = yield* ExtensionRegistry
  const config = yield* registry.providerConfig
  const source = yield* (yield* ModelCatalogSource).read
  const provider = configuredCatalog(source, config, registry.getResolved().apiClasses).provider(
    providerId,
  )
  if (Option.isNone(provider)) return
  const auth = Option.some(
    ProviderAuthInfo.cases.Api.make({
      key: info.key,
      ...omitUndefined({ metadata: info.metadata }),
    }),
  )
  const urls = new Set(
    [provider.value.api, ...provider.value.models.map((model) => model.api)].filter(
      (url): url is string => Predicate.isString(url) && urlVariables(url).length > 0,
    ),
  )
  for (const url of urls) {
    const values = yield* Effect.forEach(urlVariables(url), (name) =>
      Option.match(storedPromptAnswer(auth, name), {
        onSome: () => Effect.succeed(true),
        onNone: () => Effect.map(envValue(name), Option.isSome),
      }),
    )
    if (values.every(Boolean)) yield* filledBaseUrl(provider.value, url, auth)
  }
})

/** Sends the config's `headers` with every request. */
const withHeaders =
  (headers: Readonly<Record<string, string>>) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(client, HttpClientRequest.setHeaders(headers))

/**
 * The driver core builds for a catalog provider: an API key from the store,
 * then the first key variable set (`envCredential` names it, else the first
 * key variable); one sign-in method that asks each `${VAR}` of the base URL.
 */
const genericDriver = Effect.fn("GenericProvider.driver")(function* (
  provider: CatalogProvider,
  headers: Option.Option<Readonly<Record<string, string>>>,
) {
  const keys = keyVariables(provider)
  const setKey = yield* firstEnvValue(keys)
  const envCredential = Option.orElse(
    Option.map(setKey, ([name]) => name),
    () => Option.fromUndefinedOr(keys[0]),
  )
  const prompts = providerUrlVariables(provider).map((name) => ({
    key: name,
    label: name,
    env: name,
  }))
  let keyHint = "no stored API key"
  if (keys.length > 0) keyHint = `no stored API key and no ${keys.join(" or ")} env var`
  return {
    id: provider.id,
    name: provider.name,
    ...omitUndefined({ envCredential: Option.getOrUndefined(envCredential) }),
    endpoint: (modelName, authInfo) =>
      Effect.gen(function* () {
        const auth = Option.fromUndefinedOr(authInfo)
        if (
          Option.isSome(auth) &&
          auth.value._tag !== "Api" &&
          Predicate.isNotUndefined(auth.value.slot) &&
          auth.value.slot !== DEFAULT_CREDENTIAL_SLOT
        ) {
          return yield* new ProviderAuthError({
            message: "Named credential unavailable for an API-only provider; sign in with /auth",
            credentialFailure: "Unavailable",
          })
        }
        const stored = Option.flatMap(auth, (each) => {
          if (each._tag !== "Api") return Option.none<string>()
          return Option.some(each.key)
        })
        const fromEnv = yield* Option.match(stored, {
          onSome: () => Effect.succeed(Option.none<string>()),
          onNone: () =>
            Effect.map(
              firstEnvValue(keys),
              Option.map(([, value]) => value),
            ),
        })
        const apiKey = yield* Effect.fromOption(Option.orElse(stored, () => fromEnv)).pipe(
          Effect.mapError(
            () =>
              new ProviderAuthError({
                message: `${provider.name} credentials unavailable: ${keyHint}; sign in with /auth`,
                credentialFailure: "Unavailable",
              }),
          ),
        )
        // The model's own base URL, else the provider's; one with a variable is filled here.
        const api = Option.fromUndefinedOr(
          provider.models.find((model) => model.id === modelName)?.api ?? provider.api,
        ).pipe(Option.filter((url) => urlVariables(url).length > 0))
        const baseUrl = yield* Effect.transposeOption(
          Option.map(api, (url) => filledBaseUrl(provider, url, auth)),
        )
        return {
          apiKey: Option.some(apiKey),
          baseUrl,
          transformClient: Option.map(headers, withHeaders),
        } satisfies ApiEndpoint
      }),
    auth: {
      methods: [
        AuthMethod.make({
          type: "api",
          label: `${provider.name} API key`,
          ...omitUndefined({
            prompts: Option.getOrUndefined(
              Option.liftPredicate(prompts, (each) => each.length > 0),
            ),
          }),
        }),
      ],
    },
  } satisfies ModelDriverContribution
})

/** The catalog providers no registered driver serves and the config does not disable. */
const genericCandidates = (
  resolved: ResolvedProfile,
  config: ProviderConfig,
  catalog: LoadedModelCatalog,
): ReadonlyArray<string> => {
  const adapted = new Set(
    [...resolved.modelDrivers.values()].flatMap((driver) => [driver.id, catalogProviderOf(driver)]),
  )
  const disabled = new Set(config.disabledProviders ?? [])
  return catalog.providerIds.filter((id) => !adapted.has(id) && !disabled.has(id))
}

/** A generic provider's driver: the catalog provider, servable, built with the config's headers. */
const genericProviderDriver = (
  resolved: ResolvedProfile,
  config: ProviderConfig,
  catalog: LoadedModelCatalog,
  id: string,
): Effect.Effect<Option.Option<ModelDriverContribution>> =>
  Option.match(
    Option.filter(catalog.provider(id), (provider) =>
      providerServable(resolved.apiClasses, catalog, provider),
    ),
    {
      onNone: () => Effect.succeedNone,
      onSome: (provider) =>
        Effect.asSome(
          genericDriver(provider, Option.fromUndefinedOr(config.providers?.[id]?.headers)),
        ),
    },
  )

/**
 * Whether a generic provider is active: a config entry, a default key, or a
 * key variable set. A key stored only in a named slot serves a turn only
 * once the provider's config entry names it in `authOrder`, and that entry
 * makes the provider active.
 */
const genericActive = (
  config: ProviderConfig,
  storesDefault: (id: string) => Effect.Effect<boolean>,
  catalog: LoadedModelCatalog,
  id: string,
): Effect.Effect<boolean> => {
  if (Object.hasOwn(config.providers ?? {}, id)) return Effect.succeed(true)
  return Effect.flatMap(storesDefault(id), (stored) => {
    if (stored) return Effect.succeed(true)
    return Option.match(catalog.provider(id), {
      onNone: () => Effect.succeed(false),
      onSome: (provider) => Effect.map(firstEnvValue(keyVariables(provider)), Option.isSome),
    })
  })
}

/** The provider ids the auth store holds a credential for, in any slot; none when it cannot be listed. */
const storedProviders = (auth: AuthService): Effect.Effect<ReadonlySet<string>> =>
  auth.list.pipe(
    Effect.map((ids) => new Set(ids)),
    Effect.catch((error) =>
      Effect.logWarning("generic-provider.auth-list-failed").pipe(
        Effect.annotateLogs({ error: error.message }),
        Effect.as(new Set<string>()),
      ),
    ),
  )

/**
 * What one profile serves: its registered drivers plus a driver for each
 * active generic provider, its API classes, and the catalog with its config
 * applied. `alsoActive` names providers to serve as active whatever their
 * key: those a turn of the caller routes through, so `/auth` lists them as
 * required. An auth store that cannot be listed counts as no stored key.
 */
interface ServedProfile extends DriverProfile {
  readonly catalog: LoadedModelCatalog
}

const servedProfile = Effect.fn("GenericProvider.servedProfile")(function* (
  auth: AuthService,
  alsoActive: ReadonlyArray<string> = [],
) {
  const registry = yield* ExtensionRegistry
  const resolved = registry.getResolved()
  const config = yield* registry.providerConfig
  const source = yield* (yield* ModelCatalogSource).read
  const catalog = configuredCatalog(source, config, resolved.apiClasses)
  const stored = yield* storedProviders(auth)
  const storesDefault = (id: string): Effect.Effect<boolean> => {
    if (!stored.has(id)) return Effect.succeed(false)
    return auth.listSlots(id).pipe(
      Effect.map((slots) => slots.includes(DEFAULT_CREDENTIAL_SLOT)),
      Effect.catch((error) =>
        Effect.logWarning("generic-provider.auth-slots-failed").pipe(
          Effect.annotateLogs({ provider: id, error: error.message }),
          Effect.as(false),
        ),
      ),
    )
  }
  const active = yield* Effect.filter(genericCandidates(resolved, config, catalog), (id) => {
    if (alsoActive.includes(id)) return Effect.succeed(true)
    return genericActive(config, storesDefault, catalog, id)
  })
  const generic = yield* Effect.forEach(active, (id) =>
    genericProviderDriver(resolved, config, catalog, id),
  )
  const modelDrivers = new Map(resolved.modelDrivers)
  for (const driver of generic.flatMap(Option.toArray)) modelDrivers.set(driver.id, driver)
  return {
    modelDrivers,
    apiClasses: resolved.apiClasses,
    catalog,
  } satisfies ServedProfile
})

/**
 * The generic providers the `/auth` search offers: each servable one that is
 * not active, with its sign-in methods.
 */
export const listCatalogProviders = Effect.fn("GenericProvider.listCatalogProviders")(function* () {
  const auth = yield* Auth
  const served = yield* servedProfile(auth)
  const registry = yield* ExtensionRegistry
  const resolved = registry.getResolved()
  const config = yield* registry.providerConfig
  const providers: AuthProviderInfo[] = []
  const methods: Record<string, ReadonlyArray<AuthMethod>> = {}
  for (const id of genericCandidates(resolved, config, served.catalog)) {
    if (served.modelDrivers.has(id)) continue
    const driver = yield* genericProviderDriver(resolved, config, served.catalog, id)
    if (Option.isNone(driver)) continue
    providers.push({
      provider: ProviderId.make(id),
      name: driver.value.name,
      hasKey: false,
      required: false,
    })
    methods[id] = yield* Effect.forEach(driver.value.auth?.methods ?? [], askedMethod)
  }
  return { providers, methods }
})

// ── model-resolver ──────────────────────────────────────────────────────────

export interface ResolveModelRequest {
  readonly modelId: ModelId | string
  readonly hints?: ProviderHints
  /** Per-agent model driver override from `agent.driver`. */
  readonly driverId?: string
  readonly credentialSlot?: CredentialSlot
}

interface ModelResolverService {
  readonly resolve: (
    request: ResolveModelRequest,
  ) => Effect.Effect<
    LanguageModel.LanguageModel,
    ProviderError | ProviderAuthError,
    Scope.Scope | ExtensionRegistry
  >
  /**
   * Whether a turn can run on `driverId`'s models: its sign-in is ready, as
   * `/auth` lists it (`signInReady`), in the profile of `registry`, the
   * calling turn's. A resolver that serves a scripted model needs no sign-in.
   */
  readonly signedIn: (
    driverId: string,
    registry: ExtensionRegistryService,
  ) => Effect.Effect<boolean>
  /**
   * Whether the driver `request` dispatches through, in the profile of
   * `registry`, carries the effort change its hints name inside the
   * conversation (`ModelDriverContribution.carriesEffort`). False for a
   * driver that does not say, or a failure to read the catalog.
   */
  readonly carriesEffort: (
    request: ResolveModelRequest,
    registry: ExtensionRegistryService,
  ) => Effect.Effect<boolean>
}

/**
 * `ModelResolver.carriesEffort` for any resolver: the registered driver the
 * request dispatches through (its `driverId`, else the provider segment),
 * asked over its catalog view when `catalogSource` serves one, by the name
 * the driver serves the model as. A generic catalog provider carries none.
 */
export const driverCarriesEffort = (
  request: ResolveModelRequest,
  registry: ExtensionRegistryService,
  catalogSource: Option.Option<ModelCatalogSourceService>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const parsed = parseModelId(request.modelId)
    if (Option.isNone(parsed)) return false
    const [provider, modelName] = parsed.value
    const resolved = registry.getResolved()
    const driver = Option.fromUndefinedOr(
      resolved.modelDrivers.get(
        Option.getOrElse(Option.fromUndefinedOr(request.driverId), () => provider),
      ),
    )
    if (Option.isNone(driver)) return false
    const carries = driver.value.carriesEffort
    if (Predicate.isUndefined(carries)) return false
    const hints = Option.getOrElse(Option.fromUndefinedOr(request.hints), (): ProviderHints => ({}))
    if (Option.isNone(catalogSource)) return carries(modelName, hints)
    const catalog = configuredCatalog(
      yield* catalogSource.value.read,
      yield* registry.providerConfig,
      resolved.apiClasses,
    )
    return carries(
      currentModelName(catalog, driver.value, modelName),
      hints,
      driverCatalogView(catalog, driver.value),
    )
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      return Effect.logWarning("model-resolver.carries-effort-failed").pipe(
        Effect.annotateLogs({ model: String(request.modelId), error: String(Cause.squash(cause)) }),
        Effect.as(false),
      )
    }),
  )

/**
 * The credential order a turn walks for `request`: that of the sign-in the
 * request dispatches through (its `driverId`, else the provider segment), in
 * the profile of `registry`. None for a model id with no provider segment,
 * which no sign-in serves. Config entries that name conflicting orders fail
 * it, as they fail the request's resolution. A run pinned to a credential
 * (`pin`, the run spec's `credentialSlot`) walks that slot alone, whatever
 * the `authOrder`: the account it names pays, or the turn fails. An
 * unpinned run of a sign-in with a pool (`authSpread`) walks the pool first,
 * then the rest of its `authOrder`; the turn's placement rotates it
 * (`placementWalk`).
 */
export const requestCredentialOrder = Effect.fn("CredentialOrder.ofRequest")(function* (
  request: ResolveModelRequest,
  registry: ExtensionRegistryService,
  pin: Option.Option<CredentialSlot>,
) {
  const provider = Option.orElse(Option.fromUndefinedOr(request.driverId), () =>
    Option.map(parseModelId(request.modelId), ([segment]) => segment),
  )
  if (Option.isNone(provider)) return Option.none<CredentialOrder>()
  const order = yield* credentialOrder(
    registry.getResolved().modelDrivers,
    yield* registry.providerConfig,
    provider.value,
  )
  if (Option.isSome(pin)) {
    return Option.some<CredentialOrder>({
      provider: order.provider,
      slots: [pin.value],
      pool: Option.none(),
    })
  }
  return Option.some(
    Option.match(order.pool, {
      onNone: () => order,
      onSome: (pool): CredentialOrder => ({
        ...order,
        slots: Arr.appendAll(
          pool,
          order.slots.filter((slot) => !pool.includes(slot)),
        ),
      }),
    }),
  )
})

/**
 * Whether `provider`'s sign-in spreads its unpinned runs over a pool
 * (`authSpread`). A sign-in whose order cannot be read does not.
 */
export const spreadsRuns = Effect.fn("CredentialOrder.spreads")(
  function* (provider: string, registry: ExtensionRegistryService) {
    const order = yield* credentialOrder(
      registry.getResolved().modelDrivers,
      yield* registry.providerConfig,
      provider,
    )
    return Option.isSome(order.pool)
  },
  Effect.orElseSucceed(() => false),
)

/**
 * The sign-in a run of `driverId` spends from (its owner) and the accounts
 * its lane is counted over: a pinned run's pin (`pin`), else the pool
 * (`authSpread`), else the first credential of its order. Each account
 * carries the stamp of the sign-in the store holds under it now
 * (`ModelRegistry.stamp`), so placement reads the quota state of that
 * sign-in alone. None when its order cannot be read.
 */
export const credentialLane = Effect.fn("CredentialOrder.lane")(
  function* (
    driverId: string,
    pin: Option.Option<CredentialSlot>,
    registry: ExtensionRegistryService,
  ) {
    const order = yield* credentialOrder(
      registry.getResolved().modelDrivers,
      yield* registry.providerConfig,
      driverId,
    )
    const slots = Option.getOrElse(
      Option.orElse(Option.map(pin, Arr.of), () => order.pool),
      () => Arr.of(Arr.headNonEmpty(order.slots)),
    )
    const modelRegistry = yield* ModelRegistry
    const provider = ProviderId.make(order.provider)
    const stamp = (slot: CredentialSlot) => modelRegistry.stamp({ provider, slot }, registry)
    const scope: Arr.NonEmptyReadonlyArray<CredentialReceipt> = [
      yield* stamp(slots[0]),
      ...(yield* Effect.forEach(slots.slice(1), stamp)),
    ]
    return Option.some({ provider: order.provider, scope })
  },
  Effect.orElseSucceed(() =>
    Option.none<{
      readonly provider: string
      readonly scope: Arr.NonEmptyReadonlyArray<CredentialReceipt>
    }>(),
  ),
)

const resolveModelDefect = (
  // oxlint-disable-next-line effect/noUnknownParameters -- Provider factories can defect with any thrown value.
  defect: unknown,
  providerName: string,
  modelId: ModelId | string,
): ProviderError | ProviderAuthError => {
  if (Schema.is(ProviderAuthError)(defect)) return defect
  const detail = causeMessage(defect)
  return new ProviderError({
    message: `Extension provider "${providerName}" failed: ${detail}`,
    model: modelId,
    cause: defect,
  })
}

const resolveProviderModel = Effect.fn("ModelResolver.resolveProviderModel")(function* (
  request: ResolveModelRequest,
) {
  const parsed = parseModelId(request.modelId)
  if (Option.isNone(parsed)) {
    return yield* new ProviderError({
      message: "Invalid model id (expected provider/model)",
      model: request.modelId,
    })
  }
  const [parsedProviderName, modelName] = parsed.value
  // The loop passes the effective driver id; a bare request routes by the provider segment.
  const providerName: string = Option.getOrElse(
    Option.fromUndefinedOr(request.driverId),
    () => parsedProviderName,
  )
  const authStore = yield* Auth
  // The registry of the running turn's profile: its cwd-scoped drivers resolve here.
  const extensionRegistry = yield* ExtensionRegistry
  const resolved = extensionRegistry.getResolved()
  const catalogSource = yield* ModelCatalogSource
  const source = yield* catalogSource.read
  // A registered driver, else the generic driver of a servable catalog
  // provider, active or not: one with no key fails and names /auth.
  const config = yield* extensionRegistry.providerConfig
  yield* credentialOrder(resolved.modelDrivers, config, providerName)
  const catalog = configuredCatalog(source, config, resolved.apiClasses)
  const extensionProvider = yield* Option.match(
    Option.fromUndefinedOr(resolved.modelDrivers.get(providerName)),
    {
      onSome: (driver) => Effect.succeedSome(driver),
      onNone: () => {
        if (!genericCandidates(resolved, config, catalog).includes(providerName)) {
          return Effect.succeedNone
        }
        return genericProviderDriver(resolved, config, catalog, providerName)
      },
    },
  )
  if (Option.isNone(extensionProvider)) {
    return yield* new ProviderError({
      message: `Unknown provider: ${providerName}`,
      model: request.modelId,
    })
  }

  const authParam = yield* driverAuthInfo(
    authStore,
    resolved.modelDrivers,
    providerName,
    request.credentialSlot,
  ).pipe(
    Effect.mapError(
      (e) =>
        new ProviderError({
          message: `Failed to read auth for provider "${providerName}"`,
          model: request.modelId,
          cause: e,
        }),
    ),
  )

  if (
    Predicate.isNotUndefined(request.credentialSlot) &&
    request.credentialSlot !== DEFAULT_CREDENTIAL_SLOT &&
    Option.isNone(authParam)
  ) {
    return yield* new ProviderAuthError({
      message: `Credential "${request.credentialSlot}" of provider "${providerName}" holds no sign-in: it was removed in /auth or never signed in. Sign it in again in /auth, or move another credential into the order`,
      credentialFailure: "Unavailable",
    })
  }

  // A model the chat catalog lacks can be a classifier: the decision source tells.
  const driver = extensionProvider.value
  const chatEntry = catalogModelEntry(
    driverCatalogView(catalog, driver),
    catalogProviderOf(driver),
    currentModelName(catalog, driver, modelName),
  )
  const turnCatalog = yield* Option.match(chatEntry, {
    onSome: () => Effect.succeed(catalog),
    onNone: () =>
      Effect.map(catalogSource.readWithDecisions, (full) =>
        configuredCatalog(full, config, resolved.apiClasses),
      ),
  })

  return yield* Effect.suspend(() =>
    resolveDriverModel({
      driver,
      apiClasses: resolved.apiClasses,
      modelName,
      auth: authParam,
      hints: Option.fromUndefinedOr(request.hints),
      catalog: turnCatalog,
    }),
  ).pipe(
    Effect.catchTag("DriverError", (error) =>
      Effect.fail(
        new ProviderError({
          message: `Extension provider "${providerName}" failed: ${error.reason}`,
          model: request.modelId,
          cause: error,
        }),
      ),
    ),
    Effect.catchDefect((defect) =>
      Effect.fail(resolveModelDefect(defect, providerName, request.modelId)),
    ),
  )
})

export class ModelResolver extends Context.Service<ModelResolver, ModelResolverService>()(
  "@gent/core/src/runtime/provider/ModelResolver",
) {
  static fromLanguageModel = (
    layer: Layer.Layer<LanguageModel.LanguageModel>,
  ): Layer.Layer<ModelResolver> =>
    Layer.effect(
      ModelResolver,
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel
        // The drivers still say what their wire carries, over the catalog
        // when the host serves one.
        const catalogSource = yield* Effect.serviceOption(ModelCatalogSource)
        return ModelResolver.of({
          resolve: () => Effect.succeed(model),
          signedIn: () => Effect.succeed(true),
          carriesEffort: (request, registry) =>
            driverCarriesEffort(request, registry, catalogSource),
        })
      }),
    ).pipe(Layer.provide(layer))

  static Live: Layer.Layer<ModelResolver, never, Auth | ModelCatalogSource> = Layer.effect(
    ModelResolver,
    Effect.gen(function* () {
      const auth = yield* Auth
      const catalogSource = yield* ModelCatalogSource
      return ModelResolver.of({
        resolve: (request) =>
          Effect.gen(function* () {
            const resolved = yield* resolveProviderModel(request)
            const scope = yield* Effect.scope
            const built = yield* Layer.buildWithScope(resolved, scope)
            return Context.get(built, LanguageModel.LanguageModel)
          }).pipe(
            Effect.provideService(Auth, auth),
            Effect.provideService(ModelCatalogSource, catalogSource),
          ),
        signedIn: (driverId, registry) =>
          signInReady(driverId).pipe(
            Effect.provideService(Auth, auth),
            Effect.provideService(ModelCatalogSource, catalogSource),
            Effect.provideService(ExtensionRegistry, registry),
          ),
        carriesEffort: (request, registry) =>
          driverCarriesEffort(request, registry, Option.some(catalogSource)),
      })
    }),
  )
}

// ── credential placement ────────────────────────────────────────────────────
//
// A sign-in with a pool (`authSpread`) spreads its unpinned runs over the
// pool's accounts. A prompt cache belongs to one account, so the turn places
// a run only where its cache starts over anyway (turn.ts decides where) and
// keeps it there while the cache is warm. The ranking reads only what gent
// records: quota pace and weekly resets, the price of each account's steps
// over the last 7 days, and the sessions whose cache lives on each account
// now. It makes no model call and polls nothing. The provider's own refusal is the limit signal: a
// refused account is held until its reset.
//
// The same state reads each account's quota windows from the responses
// (`ProviderReport.quota`) and sizes the lanes they leave: how many runs the
// accounts can carry until each window resets (`lanes`).

/** The preferred account stays until another scores lower by more than this many sessions. */
const PLACEMENT_HYSTERESIS_SESSIONS = 1
/** How far back recorded usage counts. */
const PLACEMENT_WINDOW_MS = 7 * 24 * 3_600_000
/** How long a refused account is held when its failure names no reset. */
const PLACEMENT_REFUSAL_HOLD_MS = 5 * 60_000
/** Usage is kept in buckets of one hour. */
const PLACEMENT_BUCKET_MS = 3_600_000
/** The usage ledger's file in gent's data directory: numbers and labels, never a credential. */
const PLACEMENT_LEDGER_FILE = "credential-usage.json"
/**
 * Fuel is a step's list price in units of one reference input token: the
 * input price of Claude Opus 4.5 and later, $5 per million. Every class and
 * model keeps its price ratio (lanes r3's prior weights: input 1, cache read
 * 0.1, a 5-minute cache write 1.25, output 5, for that model).
 */
const FUEL_REFERENCE_USD_PER_MILLION = 5
/**
 * The fuel one run burns in an hour on the provider, before gent has
 * measured an hour of its own lanes: the bridge reading of 2026-10-20
 * (lanes.md, r3), about 3.4 M per agent-hour.
 */
const FUEL_PER_LANE_HOUR_PRIOR = 3_400_000
/** The lane-hours a provider's measured burn needs before it replaces the prior. */
const LANE_BURN_MIN_HOURS = 1
/** A lane's weight in the measured burn halves for each this many lane-hours after it. */
const LANE_BURN_HALF_LIFE_HOURS = 24
/** A quota window moves in 1% steps; a step this size closes a segment. */
const QUOTA_STEP = 0.01
/** A reading this long after the last one of its window drops the fuel between them. */
const QUOTA_GAP_MS = 15 * 60_000
/** A reset time that moves more than this starts a new reset epoch. */
const QUOTA_RESET_TOLERANCE_MS = 60_000
/** The shortest time to a reset a window is sized over, so a window about to reset is not read as huge. */
const QUOTA_MIN_HORIZON_MS = 15 * 60_000
/** Segments kept per account window. */
const QUOTA_SEGMENTS_KEPT = 500
/** A segment's weight halves for each this many active hours after it. */
const QUOTA_HALF_LIFE_ACTIVE_HOURS = 24
/**
 * Percentage points a segment's move may pass what its fuel explains before
 * it reads as spend outside gent (Claude Code, claude.ai): three widths of
 * the 1% step the provider reports in.
 */
const QUOTA_OUTSIDE_POINTS = 3
/**
 * How long an admitted start holds its lane before its turn opens. Its turn
 * opening, a turn it joins, or its caller's refusal frees it first; past it,
 * a start whose send was lost frees the lane. A guess.
 */
const LANE_RESERVATION_MS = 2 * 60_000
/** When a run refused for a busy lane checks again: no run says when it ends. A guess. */
const LANE_BUSY_RETRY_MS = 60_000

/** What placement reads of one pool account. */
interface PlacementSlot {
  readonly slot: CredentialSlot
  /** The recorded price of its steps in the window, USD. */
  readonly load: number
  /** Sessions whose newest placement or step is on it and whose cache still lives, the placed one left out. */
  readonly live: number
  /** Refused until its reset, or warmed by a fresh sibling: not placed on now. */
  readonly held: boolean
  /** Runs this account can sustain: the minimum over its quota windows, when known. */
  readonly sustainable?: number
  /** Its weekly window's reset, when read. Other windows never set placement priority. */
  readonly weeklyResetAt?: number
}

/** One placement's table: the accounts it may choose in config order, and who prefers what. */
interface PlacementTable {
  readonly slots: Arr.NonEmptyReadonlyArray<PlacementSlot>
  /**
   * The recorded price of the provider's steps in the window, USD, on every
   * account: the unit's numerator, whichever accounts the table may choose.
   */
  readonly spent: number
  /** Distinct sessions with a priced step on the provider in the window. */
  readonly sessions: number
  /** Where the run's cache or its parent's lives, on the same model. */
  readonly preferred: Option.Option<CredentialSlot>
}

/**
 * Where a run goes, as the pool walk its turn takes: the choice first, then
 * eligible accounts below their sustainable live load by weekly reset
 * (missing weekly readings last), then the others by score, then held
 * accounts in pool order. Equal resets or scores keep pool order.
 * `score = load / unit + live`, where a unit is the mean recorded price of a
 * session on the provider (`spent / sessions`; with no recorded price, or no
 * session counted, the score is the live sessions alone).
 * The preferred account stays only below pace and within one session of
 * the first eligible account's score. With no known pace, the stage-0 score
 * and preference rules stay unchanged. With none eligible, the preferred
 * account, else the pool's first.
 */
export const rankPlacement = (table: PlacementTable): Arr.NonEmptyReadonlyArray<CredentialSlot> => {
  // None when nothing priced was recorded, or no session counted: the score
  // is then the live sessions alone. Never an infinite or zero unit.
  const unit = Option.liftPredicate(
    table.spent / table.sessions,
    (mean) => mean > 0 && Number.isFinite(mean),
  )
  const score = (entry: PlacementSlot) =>
    Option.match(unit, { onNone: () => 0, onSome: (mean) => entry.load / mean }) + entry.live
  const underPace = (entry: PlacementSlot) =>
    Predicate.isNotUndefined(entry.sustainable) && entry.live < entry.sustainable
  const paced = table.slots.some((entry) => Predicate.isNotUndefined(entry.sustainable))
  const eligible = table.slots
    .filter((entry) => !entry.held)
    .sort((left, right) => {
      const leftUnder = underPace(left)
      const rightUnder = underPace(right)
      if (leftUnder && !rightUnder) return -1
      if (!leftUnder && rightUnder) return 1
      if (leftUnder && rightUnder) {
        // Infinity puts a missing weekly reading last. Equal resets (including
        // two missing readings) keep pool order without subtracting infinities.
        const leftReset = left.weeklyResetAt ?? Infinity
        const rightReset = right.weeklyResetAt ?? Infinity
        if (leftReset === rightReset) return 0
        if (leftReset < rightReset) return -1
        return 1
      }
      return score(left) - score(right)
    })
  const preferred = Option.flatMap(table.preferred, (slot) =>
    Option.fromUndefinedOr(eligible.find((entry) => entry.slot === slot)),
  )
  const lowest = Option.fromUndefinedOr(eligible[0])
  const choice: CredentialSlot = Option.match(lowest, {
    onNone: () => Option.getOrElse(table.preferred, () => table.slots[0].slot),
    onSome: (low) =>
      Option.match(preferred, {
        onNone: () => low.slot,
        onSome: (kept) => {
          if (
            (!paced || underPace(kept)) &&
            score(kept) <= score(low) + PLACEMENT_HYSTERESIS_SESSIONS
          )
            return kept.slot
          return low.slot
        },
      }),
  })
  const rest = [
    ...eligible.map((entry) => entry.slot),
    ...table.slots.filter((entry) => entry.held).map((entry) => entry.slot),
  ].filter((slot) => slot !== choice)
  return [choice, ...rest]
}

/** A run to place. */
interface PlacementRequest {
  readonly provider: string
  readonly pool: Arr.NonEmptyReadonlyArray<CredentialSlot>
  /** The run's model: an account held for it alone (`refuse`) is not placed on. */
  readonly model: ModelId
  readonly sessionId: SessionId
  readonly preferred: Option.Option<CredentialSlot>
  /**
   * The session that spawned a fresh child: an account other than the
   * starter's (`preferred`) where a sibling was placed and has not ended its
   * first step is not placed on, so a burst pays one cold start per account.
   */
  readonly starter: Option.Option<SessionId>
  /** The accounts this turn left: never placed on again in it. */
  readonly left: ReadonlySet<CredentialSlot>
  /**
   * How long the placed session's cache lives from now; none when the model
   * names no lifetime: it never goes cold (`cacheWarm`, turn.ts), so it
   * counts live there until the session moves.
   */
  readonly ttlMs: Option.Option<number>
}

/** A priced request on a pool's account: a step, or a handoff summary. */
interface PlacementSpend {
  readonly provider: string
  readonly slot: CredentialSlot
  readonly sessionId: SessionId
  /** The request's price; none when unpriced. */
  readonly costUsd: Option.Option<number>
}

/** A step that ended on a pool's account: its price counts, and its session's cache lives there. */
interface PlacementStep extends PlacementSpend {
  /** How long the session's cache lives from now; none: it never goes cold. */
  readonly ttlMs: Option.Option<number>
}

/** What a refusal holds: the whole account, or the account for one model. */
interface PlacementRefusal {
  readonly provider: string
  readonly slot: CredentialSlot
  /** The sign-in the refused request went out with (`CredentialReceipt.signedInAt`). */
  readonly signedInAt: Option.Option<number>
  /** Some: only `model`'s runs avoid the account (`refusalHoldsModel`); none: every run does. */
  readonly model: Option.Option<ModelId>
  /** The reset the failure names; none: held for 5 minutes. */
  readonly retryAt: Option.Option<number>
}

interface CredentialPlacementService {
  /** Place a run: the pool walk its turn takes, the choice first. One decision at a time. */
  readonly place: (
    request: PlacementRequest,
  ) => Effect.Effect<Arr.NonEmptyReadonlyArray<CredentialSlot>>
  /** A step ended on `slot`: its price counts, its session's cache lives there now. */
  readonly noteStep: (step: PlacementStep) => Effect.Effect<void>
  /** A request that keeps no cache (a handoff summary) was priced on `slot`: its price counts. */
  readonly noteSpend: (spend: PlacementSpend) => Effect.Effect<void>
  /**
   * `slot` refused: held, for one model or all, until `retryAt`, else for 5
   * minutes. A refusal of a sign-in the label no longer holds holds nothing.
   */
  readonly refuse: (refusal: PlacementRefusal) => Effect.Effect<void>
  /**
   * Whether any account of `pool` is eligible for `model` now: not held by
   * a refusal or a rejected quota window, and not `left` by the turn. A run
   * outside the pool returns to it only then.
   */
  readonly open: (params: {
    readonly provider: string
    readonly pool: ReadonlyArray<CredentialSlot>
    readonly model: ModelId
    readonly left: ReadonlySet<CredentialSlot>
  }) => Effect.Effect<boolean>
  /** The session's turn ended: its lane and a warming guard it holds are released. */
  readonly release: (sessionId: SessionId) => Effect.Effect<void>
  /**
   * Admit a run to a lane of `provider` over `scope`: refused when the runs
   * holding a lane there (turns open on those accounts, and starts admitted
   * whose turn has not opened, the asker's own turn left out) reach the
   * scope's capacity. An admitted start holds its lane, under `key`, until
   * its turn opens, `freeReservation` names it, or 2 minutes pass. With no
   * capacity read, every run is admitted.
   */
  readonly admitLane: (request: LaneRequest) => Effect.Effect<void, LaneUnavailable>
  /** The session's turn opened on `provider`: it holds a lane until it ends, and the start admitted under `key` no longer does. */
  readonly openLane: (lane: OpenLane) => Effect.Effect<void>
  /**
   * The start admitted under `key` opens no turn of its own: its message
   * joined a turn that holds its session's lane already, or its caller's
   * admission failed after the lane admitted it. Its lane frees now.
   */
  readonly freeReservation: (key: string) => Effect.Effect<void>
  /**
   * While the scope is open, the start admitted under `key` keeps its lane
   * past its 2 minutes: a caller preparing the run's place holds it through.
   * When the last hold on that admission closes, its 2 minutes start again;
   * a hold's end never touches a later admission under the key. A key with
   * no lane held is a no-op.
   */
  readonly holdReservation: (key: string) => Effect.Effect<void, never, Scope.Scope>
  /**
   * The store renamed `provider`'s label `from` to `to`, sign-in and all
   * (`renameSignIn`): the quota state, holds and sign-in of `from` move to
   * `to`, whose own go, and a late report under `from` of that sign-in
   * counts on `to`.
   */
  readonly renameLabel: (rename: {
    readonly provider: string
    readonly from: CredentialSlot
    readonly to: CredentialSlot
  }) => Effect.Effect<void>
  /**
   * A response on `slot` named its quota windows: each is the window's
   * latest reading, and a move of 1% closes a segment of the fuel spent on
   * the account since the window's last reading. A rejected window holds the
   * account until its reset. A response of a sign-in the label no longer
   * holds is dropped, and one of a sign-in renamed since is read on its
   * new label.
   */
  readonly noteQuota: (quota: PlacementQuota) => Effect.Effect<void>
  /**
   * A request was priced on `slot`: its fuel counts toward the account's
   * open segments, as `noteQuota` names its sign-in, and toward the burn of
   * the lane its session holds.
   */
  readonly noteFuel: (fuel: PlacementFuel) => Effect.Effect<void>
  /**
   * The lanes of every provider gent read a quota window of: each account's
   * windows, fuel per percent and sustainable runs, and the provider's
   * capacity over the accounts `scopeOf` names (its unpinned runs' accounts).
   */
  readonly lanes: (scopeOf: LaneScopeOf) => Effect.Effect<LaneReport>
  /** Write the usage ledger now, when anything was recorded since the last write. */
  readonly flush: Effect.Effect<void>
}

/**
 * The accounts a lane is counted over, as the credential store holds them
 * now: each label with the sign-in under it (`signedInAt`, absent for an
 * unstamped credential). Placement reads a label's quota state only for
 * that sign-in: a new sign-in on the label starts with none, and a renamed
 * one keeps its own.
 */
type LaneScope = Arr.NonEmptyReadonlyArray<CredentialReceipt>

/** A run that asks for a lane: the accounts its turns spend from, and the message whose turn takes it. */
interface LaneRequest {
  readonly provider: string
  readonly scope: LaneScope
  readonly key: string
  /** The session that asks: its own open turn holds no lane against it. */
  readonly asker: Option.Option<SessionId>
}

/** A turn that opened on a provider's accounts. */
interface OpenLane {
  readonly sessionId: SessionId
  readonly key: string
  readonly provider: string
  readonly scope: LaneScope
}

/** The quota windows one response named, on the account its request went out on. */
interface PlacementQuota {
  readonly provider: string
  readonly slot: CredentialSlot
  /** The sign-in the request went out with (`CredentialReceipt.signedInAt`). */
  readonly signedInAt: Option.Option<number>
  readonly readings: ReadonlyArray<QuotaReading>
}

/** A step's or a summary's token counts, as its usage reports them; input counts cached tokens too. */
interface FuelUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** A priced request on an account: its list price, and the tokens it spent. */
interface PlacementFuel {
  readonly provider: string
  readonly slot: CredentialSlot
  /** The sign-in the request went out with (`CredentialReceipt.signedInAt`). */
  readonly signedInAt: Option.Option<number>
  /** The session whose turn spent it: its lane's burn counts it. */
  readonly sessionId: SessionId
  /** None when unpriced: the open segments and the lane it falls in drop. */
  readonly costUsd: Option.Option<number>
  readonly usage: Option.Option<FuelUsage>
}

/**
 * The accounts a provider's unpinned run spends from: its pool, else the
 * first of its order. None when the sign-in's order cannot be read.
 */
type LaneScopeOf = (provider: string) => Effect.Effect<Option.Option<LaneScope>>

/**
 * Whether a refusal holds its account for the refused model alone: a
 * credential a driver proved does not serve the model (`UnsupportedModel`),
 * or a rate limit, which providers set per model. Any other refusal (a
 * credential that is gone or refused, an exhausted quota) holds the
 * account for every model.
 */
// oxlint-disable-next-line effect/noUnknownParameters -- Model streams expose provider-specific error values.
export const refusalHoldsModel = (error: unknown): boolean => {
  if (Option.contains(credentialFailureReason(error), "UnsupportedModel")) return true
  return AiError.isAiError(error) && error.reason._tag === "RateLimitError"
}

const UsageBucket = Schema.Struct({
  provider: Schema.String,
  slot: CredentialSlot,
  /** Epoch hours. */
  hour: Schema.Int,
  costUsd: Schema.Finite,
  /**
   * The sessions whose latest priced request on the provider fell in this
   * hour, counted on the account it first fell on. Kept by id, so a session
   * that goes on after a restart moves its count instead of adding one.
   */
  sessions: Schema.Array(SessionId),
})
type UsageBucket = typeof UsageBucket.Type

/** The tokens a segment spent, by class: input counts only the uncached ones. */
const FuelTokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
})
type FuelTokens = typeof FuelTokens.Type

/**
 * The latest reading of one account's quota window. `signedInAt` names the
 * sign-in it was read for, absent for an unstamped credential: a restart
 * reads the label's sign-in from it.
 */
const WindowReading = Schema.Struct({
  provider: Schema.String,
  slot: CredentialSlot,
  signedInAt: Schema.optionalKey(Schema.Finite),
  window: Schema.String,
  utilization: Schema.Finite,
  /** Epoch ms. */
  resetAt: Schema.Finite,
  /** When gent read it, epoch ms. */
  readAt: Schema.Finite,
  rejected: Schema.Boolean,
})
type WindowReading = typeof WindowReading.Type

/**
 * The fuel gent spent on one account between two readings of one window in
 * one reset epoch, and how far the window moved in that time (percentage
 * points). A reset, a gap over 15 minutes or an unpriced request drops the
 * fuel instead.
 */
const FuelSegment = Schema.Struct({
  provider: Schema.String,
  slot: CredentialSlot,
  signedInAt: Schema.optionalKey(Schema.Finite),
  window: Schema.String,
  /** Epoch ms of the reading that closed it. */
  endedAt: Schema.Finite,
  fuel: Schema.Finite,
  deltaPct: Schema.Finite,
  tokens: FuelTokens,
})
type FuelSegment = typeof FuelSegment.Type

/**
 * The fuel one provider's lanes burn per lane-hour, as gent measured it:
 * `fuel` and `hours` are sums over the lanes that ended, each lane's weight
 * halved for every 24 lane-hours after it (`fuel / hours` is the rate), and
 * `seen` the lane-hours measured in all.
 */
const LaneBurn = Schema.Struct({
  provider: Schema.String,
  fuel: Schema.Finite,
  hours: Schema.Finite,
  seen: Schema.Finite,
})
type LaneBurn = typeof LaneBurn.Type

/**
 * The ledger file. `segments`, `readings` and `burn` are optional: a file
 * an older gent wrote has none, and an older gent drops them when it reads
 * them.
 */
const PlacementLedger = Schema.fromJsonString(
  Schema.Struct({
    buckets: Schema.Array(UsageBucket),
    segments: Schema.optionalKey(Schema.Array(FuelSegment)),
    readings: Schema.optionalKey(Schema.Array(WindowReading)),
    burn: Schema.optionalKey(Schema.Array(LaneBurn)),
  }),
)
type PlacementLedgerValue = typeof PlacementLedger.Type

// ── lanes ──

/** A window's length from its name (`5h`, `7d`); none for a name with no unit. */
const windowLengthMs = (window: string): Option.Option<number> => {
  const match = /^(\d+)([hd])$/.exec(window)
  if (Predicate.isNull(match)) return Option.none()
  const count = Number(match[1])
  if (match[2] === "h") return Option.some(count * 3_600_000)
  return Option.some(count * 24 * 3_600_000)
}

/** One scoped account's weekly fuel and its next reset, in plain hours. */
interface PoolWeek {
  readonly account: LaneAccount
  readonly full: number
  readonly remaining: number
  readonly hours: number
}

const quotaRoom = (window: LaneWindow, full: number): number => {
  if (window.rejected) return 0
  return Math.max(0, 1 - window.utilization) * full
}

const quotaHours = (window: LaneWindow, now: number, length: number): number => {
  if (window.resetAt <= now) return length
  return Math.max((window.resetAt - now) / 3_600_000, QUOTA_MIN_HORIZON_MS / 3_600_000)
}

/** In-hand expiry floor and rolling seven-day supply, under each weekly prefix ceiling. */
const weeklyPoolPace = (weeks: ReadonlyArray<PoolWeek>) => {
  let expiring = 0
  let floor = 0
  let fuel = weeks.reduce((sum, week) => sum + week.remaining, 0)
  let ceiling = Infinity
  // Same-deadline refills cannot lower the ceiling after the first check;
  // the floor reaches its maximum after all their quota is counted.
  for (const week of [...weeks].sort((left, right) => left.hours - right.hours)) {
    ceiling = Math.min(ceiling, fuel / week.hours)
    expiring += week.remaining
    floor = Math.max(floor, expiring / week.hours)
    fuel += week.full - week.remaining
  }
  const rolling =
    weeks.reduce(
      (sum, week) => sum + week.remaining + (week.full * Math.max(0, 168 - week.hours)) / 168,
      0,
    ) / 168
  return { sustainable: Math.max(floor, rolling), ceiling }
}

/** Short-window fuel opens only where the same account has weekly room. */
const fiveHourPoolCeiling = (
  weeks: ReadonlyArray<PoolWeek>,
  now: number,
): Option.Option<number> => {
  let fuel = 0
  const refills: Array<{ readonly hours: number; readonly gain: number }> = []
  let hasShort = false
  for (const week of weeks) {
    const short = week.account.windows.find((window) => window.window === "5h")
    if (Predicate.isUndefined(short)) continue
    if (Predicate.isUndefined(short.fuelPerPct)) return Option.none()
    hasShort = true
    const full = 100 * short.fuelPerPct
    const remaining = quotaRoom(short, full)
    const hours = quotaHours(short, now, 5)
    if (week.remaining > 0) {
      // Complementary windows on two accounts cannot combine into fuel: an
      // account's fuel is the lesser of its weekly and short supply so far.
      // A weekly reset before the short one lifts the weekly cap first.
      const before = Math.min(week.remaining, remaining)
      fuel += before
      let weekly = week.remaining
      let reached = before
      if (week.hours < hours) {
        weekly = week.remaining + week.full
        const lifted = Math.min(weekly, remaining)
        refills.push({ hours: week.hours, gain: lifted - reached })
        reached = lifted
      }
      refills.push({ hours, gain: Math.max(0, Math.min(weekly, full) - reached) })
    } else if (week.hours <= 5) {
      // A spent week opens fresh short room unless an independent 5h hold
      // outlasts that weekly reset. That hold clears only at its own reset.
      let room = full
      if (hours > week.hours) room = remaining
      refills.push({ hours: week.hours, gain: Math.min(week.full, room) })
      if (hours > week.hours)
        refills.push({
          hours,
          gain: Math.max(0, Math.min(week.full, full) - Math.min(week.full, room)),
        })
    }
  }
  let ceiling = Infinity
  for (const refill of refills.sort((left, right) => left.hours - right.hours)) {
    ceiling = Math.min(ceiling, fuel / refill.hours)
    fuel += refill.gain
  }
  if (hasShort) ceiling = Math.min(ceiling, fuel / 5)
  return Option.some(ceiling)
}

/** A request's fuel: none when its price or usage is unknown, or a priced request lists no price. */
const fuelOf = (
  costUsd: Option.Option<number>,
  usage: Option.Option<FuelUsage>,
): Option.Option<{ readonly fuel: number; readonly tokens: FuelTokens }> =>
  Option.flatMap(Option.all([costUsd, usage]), ([cost, counts]) => {
    const cacheRead = counts.cacheReadTokens ?? 0
    const cacheWrite = counts.cacheWriteTokens ?? 0
    const tokens: FuelTokens = {
      input: Math.max(0, counts.inputTokens - cacheRead - cacheWrite),
      output: counts.outputTokens,
      cacheRead,
      cacheWrite,
    }
    const spent = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
    // A credential whose catalog lists no price (a subscription view) says
    // nothing of the fuel its tokens burn: unknown, never zero.
    if (!Number.isFinite(cost) || cost < 0 || (cost === 0 && spent > 0)) return Option.none()
    return Option.some({ fuel: (cost * 1_000_000) / FUEL_REFERENCE_USD_PER_MILLION, tokens })
  })

/** A window's fuel per percentage point, read from its segments. */
interface WindowFit {
  readonly fuelPerPct: Option.Option<number>
  readonly band: Option.Option<number>
  /** The segments the rate reads: those spend outside gent did not move. */
  readonly kept: ReadonlyArray<FuelSegment>
  readonly outsideShare: number
}

/**
 * `Σ fuel / Σ points` over the segments, each weighted by half for every
 * 24 active hours (hours with a segment) after it; none with no points.
 */
const weightedRate = (segments: ReadonlyArray<FuelSegment>): Option.Option<number> => {
  const hourOf = (segment: FuelSegment) => Math.floor(segment.endedAt / 3_600_000)
  const hours = [...new Set(segments.map(hourOf))].sort((left, right) => right - left)
  let fuel = 0
  let points = 0
  for (const segment of segments) {
    const after = hours.findIndex((hour) => hour <= hourOf(segment))
    const weight = 0.5 ** (Math.max(0, after) / QUOTA_HALF_LIFE_ACTIVE_HOURS)
    fuel += weight * segment.fuel
    points += weight * segment.deltaPct
  }
  return Option.liftPredicate(fuel / points, (rate) => points > 0 && Number.isFinite(rate))
}

/**
 * Fits one window. A segment that spent no fuel, or whose move passes what
 * its fuel explains by more than three 1% steps, is spend outside gent; the
 * rate reads the rest. Each segment is judged against the plain rate of the
 * other kept segments, never one it is part of: outside spend in a segment
 * lowers the rate it would be judged by. The judging repeats until the kept
 * set holds still. A segment with no other kept segment to judge it by is
 * kept. The band is `±0.5 / Σ points` of the kept segments (lanes r3): the
 * half-step of the 1% quantization over the move they span.
 */
const fitWindow = (segments: ReadonlyArray<FuelSegment>): WindowFit => {
  const totalPoints = segments.reduce((sum, segment) => sum + segment.deltaPct, 0)
  let kept: ReadonlyArray<FuelSegment> = segments.filter((segment) => segment.fuel > 0)
  // Each pass drops or restores at least one segment, or holds still.
  for (let pass = 0; pass <= segments.length; pass += 1) {
    const keptFuel = kept.reduce((sum, segment) => sum + segment.fuel, 0)
    const keptPointsNow = kept.reduce((sum, segment) => sum + segment.deltaPct, 0)
    const keptNow = new Set(kept)
    const outside = (segment: FuelSegment) => {
      if (segment.fuel <= 0) return true
      // The rate of the other kept segments: this one left out.
      const own = Option.liftPredicate(segment, (candidate) => keptNow.has(candidate))
      const otherFuel = keptFuel - Option.match(own, { onNone: () => 0, onSome: (it) => it.fuel })
      const otherPoints =
        keptPointsNow - Option.match(own, { onNone: () => 0, onSome: (it) => it.deltaPct })
      const others = otherFuel / otherPoints
      if (!(otherPoints > 0) || !(others > 0) || !Number.isFinite(others)) return false
      return segment.deltaPct - segment.fuel / others > QUOTA_OUTSIDE_POINTS
    }
    const next = segments.filter((segment) => !outside(segment))
    const same = next.length === kept.length && next.every((segment) => keptNow.has(segment))
    kept = next
    if (same) break
  }
  const keptPoints = kept.reduce((sum, segment) => sum + segment.deltaPct, 0)
  let outsideShare = 0
  if (totalPoints > 0) outsideShare = (totalPoints - keptPoints) / totalPoints
  return {
    fuelPerPct: weightedRate(kept),
    band: Option.liftPredicate(0.5 / keptPoints, () => keptPoints > 0),
    kept,
    outsideShare,
  }
}

/** Keys of the placement state's maps: fields joined by NUL, which no label or id holds. */
const placementKey = (...parts: ReadonlyArray<string | number>) => parts.join("\u0000")

/** Where the ledger persists: read once at start, replaced whole. Neither fails. */
interface PlacementLedgerStore {
  readonly load: Effect.Effect<PlacementLedgerValue>
  /** True when the ledger was written; a failed write is logged, never raised. */
  readonly save: (ledger: PlacementLedgerValue) => Effect.Effect<boolean>
}

const EMPTY_LEDGER: PlacementLedgerValue = { buckets: [] }

/**
 * The ledger as the file `file`: numbers, labels and session ids, never a
 * credential. A missing or undecodable file reads as no usage and is
 * replaced at the next write; a write that fails is logged. The ledger
 * never fails a turn.
 */
const placementLedgerFile = Effect.fn("CredentialPlacement.ledgerFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const platform = yield* GentPlatform
  const load = Effect.fn("CredentialPlacement.ledgerLoad")(
    function* () {
      return yield* Schema.decodeEffect(PlacementLedger)(yield* fs.readFileString(file))
    },
    Effect.catch((cause) =>
      Effect.logDebug("credential-placement.ledger-unread").pipe(
        Effect.annotateLogs({ error: String(cause) }),
        Effect.as(EMPTY_LEDGER),
      ),
    ),
  )
  const save = Effect.fn("CredentialPlacement.ledgerSave")(
    function* (ledger: PlacementLedgerValue) {
      const text = yield* Schema.encodeEffect(PlacementLedger)(ledger)
      yield* fs.makeDirectory(pathService.dirname(file), { recursive: true })
      yield* writeFileAtomic(file, text, { mode: 0o600 })
      return true
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, pathService),
    Effect.provideService(GentPlatform, platform),
    Effect.catch((cause) =>
      Effect.logWarning("credential-placement.ledger-write-failed").pipe(
        Effect.annotateLogs({ error: String(cause) }),
        Effect.as(false),
      ),
    ),
  )
  return { load: load(), save } satisfies PlacementLedgerStore
})

/** A bucket as the placement state keeps it: its sessions as a set. */
interface HeldBucket extends Omit<UsageBucket, "sessions"> {
  readonly sessions: ReadonlySet<SessionId>
}

/**
 * The placement state of one server: usage buckets (loaded from `ledger`
 * when one is named, and written back to it on `flush`: as each hour
 * closes and at shutdown, `CredentialPlacement.Live`), live caches, held
 * accounts and warming guards (in memory).
 */
export const makeCredentialPlacement = Effect.fn("CredentialPlacement.make")(function* (
  ledger: Option.Option<PlacementLedgerStore>,
) {
  const lock = yield* Semaphore.make(1)
  const writeLock = yield* Semaphore.make(1)
  const buckets = new Map<string, HeldBucket>()
  /** provider, session → the bucket (provider, slot, hour) the session is counted in. */
  const counted = new Map<string, { readonly bucket: string; readonly hour: number }>()
  /** provider, session → where its cache lives and until when (none: it never goes cold). */
  const live = new Map<
    string,
    {
      readonly provider: string
      readonly slot: CredentialSlot
      readonly until: Option.Option<number>
    }
  >()
  /** provider, slot (and a model, for a hold of one model) → held until. */
  const held = new Map<string, number>()
  /** provider, starter, slot → the fresh children warming it. */
  const warming = new Map<string, Set<SessionId>>()
  /** provider, slot, window → the window's latest reading. */
  const readings = new Map<string, WindowReading>()
  /**
   * provider, slot, window → the segment open on the window: the
   * utilization it opened at, and the fuel spent on the account since then,
   * none once an unpriced request fell in it.
   */
  const openSegments = new Map<
    string,
    {
      readonly from: number
      readonly fuel: Option.Option<number>
      readonly tokens: FuelTokens
    }
  >()
  /** provider, slot, window → its closed segments, oldest first. */
  const segments = new Map<string, ReadonlyArray<FuelSegment>>()
  /**
   * session → the provider and accounts its open turn spends from, when it
   * opened, and the fuel it spent since (none once an unpriced request fell
   * in it): its lane, and that lane's burn.
   */
  const running = new Map<
    SessionId,
    {
      readonly provider: string
      readonly scope: ReadonlyArray<CredentialSlot>
      readonly openedAt: number
      readonly fuel: Option.Option<number>
    }
  >()
  /** provider → the burn its ended lanes measured. */
  const burns = new Map<string, LaneBurn>()
  /**
   * provider, slot → the sign-in the label's quota state and holds belong
   * to (`signedInAt`), as the credential store or a newer report last named
   * it. A label with no entry has only unstamped state.
   */
  const signIns = new Map<
    string,
    { readonly provider: string; readonly slot: CredentialSlot; readonly signedInAt: number }
  >()
  /**
   * provider, old label → where the store renamed the sign-in `signedInAt`
   * to (`renameLabel`): a late report under the old label counts there. Two
   * labels can hold sign-ins of one stamp, so a stamp alone never names a
   * rename. Cleared when the old label holds another sign-in.
   */
  const renamed = new Map<string, { readonly to: CredentialSlot; readonly signedInAt: number }>()
  /**
   * message key → a start admitted to a lane whose turn has not opened, until
   * `until`, or while any of its `holders` holds it through its preparation.
   * `admission` tells one admission under a key from a later one, so a hold
   * releases only the reservation it held.
   */
  const reserved = new Map<
    string,
    {
      readonly provider: string
      readonly scope: ReadonlyArray<CredentialSlot>
      readonly until: number
      readonly holders: number
      readonly admission: number
    }
  >()
  let lastAdmission = 0
  const reserving = (entry: { readonly until: number; readonly holders: number }, now: number) =>
    entry.holders > 0 || entry.until > now
  /**
   * The runs holding a lane on `provider` that share an account with
   * `scope`; `asker`'s own open turn is left out.
   */
  const laneLoad = (
    provider: string,
    scope: ReadonlyArray<CredentialSlot>,
    asker: Option.Option<SessionId>,
    now: number,
  ) => {
    const shares = (held: {
      readonly provider: string
      readonly scope: ReadonlyArray<CredentialSlot>
    }) => held.provider === provider && held.scope.some((slot) => scope.includes(slot))
    let load = 0
    for (const [sessionId, held] of running) {
      if (Option.contains(asker, sessionId)) continue
      if (shares(held)) load += 1
    }
    for (const held of reserved.values()) if (reserving(held, now) && shares(held)) load += 1
    return load
  }
  /**
   * Whether a quota window of `slot` read rejected and has not reset: the
   * readings are the one record of it, so a restart that loads them holds
   * the account as the server before it did.
   */
  const quotaHeld = (provider: string, slot: CredentialSlot, now: number) =>
    readings
      .values()
      .some(
        (reading) =>
          reading.provider === provider &&
          reading.slot === slot &&
          reading.rejected &&
          reading.resetAt > now,
      )
  /**
   * Whether `slot` of `provider` is held for `model`'s runs: by a refusal
   * for all or for that model, or by a rejected quota window.
   */
  const isHeld = (provider: string, slot: CredentialSlot, model: ModelId, now: number) =>
    held.has(placementKey(provider, slot)) ||
    held.has(placementKey(provider, slot, model)) ||
    quotaHeld(provider, slot, now)
  /** Whether `key` of a quota map, or a hold of one model, names `provider`'s `slot`. */
  const ofLabel = (key: string, provider: string, slot: CredentialSlot) =>
    key.startsWith(placementKey(provider, slot, ""))
  /** A label's quota readings, segments and holds go: the sign-in they were for left it. */
  const forget = (provider: string, slot: CredentialSlot) => {
    for (const key of [...readings.keys()]) if (ofLabel(key, provider, slot)) readings.delete(key)
    for (const key of [...openSegments.keys()])
      if (ofLabel(key, provider, slot)) openSegments.delete(key)
    for (const key of [...segments.keys()]) if (ofLabel(key, provider, slot)) segments.delete(key)
    for (const key of [...held.keys()])
      if (key === placementKey(provider, slot) || ofLabel(key, provider, slot)) held.delete(key)
  }
  /** A label's quota state and holds move to `to`, whose own go: its sign-in was renamed. */
  const relabel = (provider: string, from: CredentialSlot, to: CredentialSlot) => {
    forget(provider, to)
    const prefix = placementKey(provider, from, "")
    const moved = (key: string) => placementKey(provider, to, key.slice(prefix.length))
    for (const [key, reading] of [...readings]) {
      if (!ofLabel(key, provider, from)) continue
      readings.delete(key)
      readings.set(moved(key), { ...reading, slot: to })
    }
    for (const [key, open] of [...openSegments]) {
      if (!ofLabel(key, provider, from)) continue
      openSegments.delete(key)
      openSegments.set(moved(key), open)
    }
    for (const [key, list] of [...segments]) {
      if (!ofLabel(key, provider, from)) continue
      segments.delete(key)
      segments.set(
        moved(key),
        list.map((segment) => ({ ...segment, slot: to })),
      )
    }
    for (const [key, until] of [...held]) {
      if (key === placementKey(provider, from)) {
        held.delete(key)
        held.set(placementKey(provider, to), until)
      } else if (ofLabel(key, provider, from)) {
        held.delete(key)
        held.set(moved(key), until)
      }
    }
  }
  /**
   * `slot` holds the sign-in `stamp` now: the label's state is that
   * sign-in's. A label that held another sign-in drops its state: a new
   * sign-in starts with no reading. Under the lock.
   */
  const bind = (provider: string, slot: CredentialSlot, stamp: number) => {
    const key = placementKey(provider, slot)
    const current = Option.fromUndefinedOr(signIns.get(key))
    if (Option.exists(current, (entry) => entry.signedInAt === stamp)) return
    // The binding itself is not kept: a load reads it back from the readings.
    if (Option.isSome(current)) {
      forget(provider, slot)
      version += 1
    }
    renamed.delete(key)
    signIns.set(key, { provider, slot, signedInAt: stamp })
  }
  /** The scope as the credential store holds it now: each stamped label is bound to its sign-in. */
  const settle = (provider: string, scope: LaneScope) => {
    for (const account of scope)
      if (Predicate.isNotUndefined(account.signedInAt))
        bind(provider, account.slot, account.signedInAt)
  }
  /**
   * The label a report of a request on `slot` with the sign-in `stamp`
   * counts on: its own while it holds that sign-in, the label the store
   * renamed that sign-in to, none for a sign-in the label replaced since (a
   * late report, dropped). A stamp newer than the label's is a new sign-in
   * on it. An unstamped report counts on its label. Under the lock.
   */
  const reportedOn = (
    provider: string,
    slot: CredentialSlot,
    stamp: Option.Option<number>,
  ): Option.Option<CredentialSlot> => {
    if (Option.isNone(stamp)) return Option.some(slot)
    const current = Option.fromUndefinedOr(signIns.get(placementKey(provider, slot)))
    if (Option.exists(current, (entry) => entry.signedInAt === stamp.value))
      return Option.some(slot)
    const moved = Option.filter(
      Option.fromUndefinedOr(renamed.get(placementKey(provider, slot))),
      (rename) => rename.signedInAt === stamp.value,
    )
    if (Option.isSome(moved)) return reportedOn(provider, moved.value.to, stamp)
    if (Option.exists(current, (entry) => entry.signedInAt > stamp.value)) return Option.none()
    bind(provider, slot, stamp.value)
    return Option.some(slot)
  }
  /** The sign-in a label's state belongs to now; none for unstamped state. */
  const signedInOf = (provider: string, slot: CredentialSlot) =>
    Option.map(
      Option.fromUndefinedOr(signIns.get(placementKey(provider, slot))),
      (entry) => entry.signedInAt,
    )
  /**
   * A lane ended at `now`: its fuel over its hours adds to its provider's
   * burn, the burn before it halved for every 24 lane-hours it ran. A lane an
   * unpriced request fell in adds nothing: its fuel is unknown, never zero.
   * Nor does a lane of a provider gent read no quota window of.
   */
  const burnLane = (
    lane: {
      readonly provider: string
      readonly openedAt: number
      readonly fuel: Option.Option<number>
    },
    now: number,
  ) => {
    const hours = (now - lane.openedAt) / 3_600_000
    if (!(hours > 0) || Option.isNone(lane.fuel)) return
    // The burn sizes the lanes of a provider whose windows gent reads; with
    // none read, it would only write a ledger nothing needs.
    if (!readings.values().some((reading) => reading.provider === lane.provider)) return
    const before = burns.get(lane.provider) ?? {
      provider: lane.provider,
      fuel: 0,
      hours: 0,
      seen: 0,
    }
    const decay = 0.5 ** (hours / LANE_BURN_HALF_LIFE_HOURS)
    burns.set(lane.provider, {
      provider: lane.provider,
      fuel: before.fuel * decay + lane.fuel.value,
      hours: before.hours * decay + hours,
      seen: before.seen + hours,
    })
    version += 1
  }
  /** The fuel one of `provider`'s runs burns in an hour: measured once it saw a lane-hour, else the prior. */
  const fuelPerHourOf = (provider: string) =>
    Option.getOrElse(
      Option.flatMap(
        Option.filter(
          Option.fromUndefinedOr(burns.get(provider)),
          (burn) => burn.seen >= LANE_BURN_MIN_HOURS,
        ),
        (burn) =>
          Option.liftPredicate(
            burn.fuel / burn.hours,
            (rate) => burn.hours > 0 && rate > 0 && Number.isFinite(rate),
          ),
      ),
      () => FUEL_PER_LANE_HOUR_PRIOR,
    )
  /** The session's first step ended, or its turn did: it warms nothing now. */
  const unguard = (sessionId: SessionId) => {
    for (const [key, children] of warming) {
      children.delete(sessionId)
      if (children.size === 0) warming.delete(key)
    }
  }
  /**
   * Each change of the buckets counts up `version`; `written` is the version
   * the ledger last saved. A write that fails, or is cut off at shutdown,
   * leaves them apart, so the next write saves the buckets again.
   */
  let version = 0
  let written = 0
  /** One read or change of the state at a time: a burst of placements reads each earlier one. */
  const locked = <A>(body: () => A) => Effect.sync(body).pipe(lock.withPermits(1))
  const windowStart = (now: number) => Math.floor((now - PLACEMENT_WINDOW_MS) / PLACEMENT_BUCKET_MS)
  /**
   * Drops what the window no longer holds. A dropped bucket, reading or
   * segment changes the ledger, so the next write leaves it off the file.
   */
  const trim = (now: number) => {
    const first = windowStart(now)
    let pruned = false
    for (const [key, bucket] of buckets)
      if (bucket.hour < first) {
        buckets.delete(key)
        pruned = true
      }
    for (const [key, entry] of counted) if (entry.hour < first) counted.delete(key)
    for (const [key, entry] of live)
      if (Option.exists(entry.until, (until) => until <= now)) live.delete(key)
    for (const [key, until] of held) if (until <= now) held.delete(key)
    if (trimQuota(now - PLACEMENT_WINDOW_MS)) pruned = true
    if (pruned) version += 1
  }
  /** Drops the readings and segments older than `kept`; whether any went. */
  const trimQuota = (kept: number) => {
    let pruned = false
    for (const [key, reading] of readings)
      if (reading.readAt < kept) {
        readings.delete(key)
        pruned = true
      }
    for (const [key, list] of segments) {
      const recent = list.filter((segment) => segment.endedAt >= kept).slice(-QUOTA_SEGMENTS_KEPT)
      if (recent.length === list.length) continue
      pruned = true
      if (recent.length === 0) segments.delete(key)
      else segments.set(key, recent)
    }
    return pruned
  }
  const lifetimeEnd = (now: number, ttlMs: Option.Option<number>) =>
    Option.map(ttlMs, (lifetime) => now + lifetime)
  /**
   * A priced request of `spend.sessionId` at `hour`: its price adds to its
   * account's bucket, and the session counts once in the window, in the
   * hour of its latest priced request (a request in a later hour moves its
   * count there, so a session that runs for days still counts while the
   * window holds it). Runs under the lock.
   */
  const record = (spend: PlacementSpend, costUsd: number, hour: number) => {
    const key = placementKey(spend.provider, spend.slot, hour)
    const bucket: HeldBucket = buckets.get(key) ?? {
      provider: spend.provider,
      slot: spend.slot,
      hour,
      costUsd: 0,
      sessions: new Set(),
    }
    const sessionKey = placementKey(spend.provider, spend.sessionId)
    const earlier = counted.get(sessionKey)
    let sessions = bucket.sessions
    if (Predicate.isUndefined(earlier) || earlier.hour < hour) {
      if (Predicate.isNotUndefined(earlier)) {
        const before = buckets.get(earlier.bucket)
        if (Predicate.isNotUndefined(before)) {
          const kept = new Set(before.sessions)
          kept.delete(spend.sessionId)
          buckets.set(earlier.bucket, { ...before, sessions: kept })
        }
      }
      counted.set(sessionKey, { bucket: key, hour })
      sessions = new Set([...sessions, spend.sessionId])
    }
    buckets.set(key, { ...bucket, costUsd: bucket.costUsd + costUsd, sessions })
    version += 1
  }
  /**
   * The quota state a ledger kept: readings, segments and burns, and each
   * label's sign-in, the one its newest stamped reading names.
   */
  const loadQuotaState = (stored: PlacementLedgerValue) => {
    // Oldest reading first: a later reading of a label names its sign-in now.
    const storedReadings = [...(stored.readings ?? [])].sort(
      (left, right) => left.readAt - right.readAt,
    )
    for (const reading of storedReadings) {
      readings.set(placementKey(reading.provider, reading.slot, reading.window), reading)
      if (Predicate.isNotUndefined(reading.signedInAt))
        signIns.set(placementKey(reading.provider, reading.slot), {
          provider: reading.provider,
          slot: reading.slot,
          signedInAt: reading.signedInAt,
        })
    }
    for (const segment of stored.segments ?? []) {
      const key = placementKey(segment.provider, segment.slot, segment.window)
      segments.set(key, [...(segments.get(key) ?? []), segment])
    }
    for (const burn of stored.burn ?? []) burns.set(burn.provider, burn)
  }
  if (Option.isSome(ledger)) {
    const now = yield* Clock.currentTimeMillis
    const first = windowStart(now)
    const stored = yield* ledger.value.load
    loadQuotaState(stored)
    trim(now)
    // Oldest hour first: a session two buckets name counts in the latest.
    const loaded = [...stored.buckets].sort((left, right) => left.hour - right.hour)
    for (const bucket of loaded) {
      if (bucket.hour < first) continue
      const key = placementKey(bucket.provider, bucket.slot, bucket.hour)
      for (const sessionId of bucket.sessions) {
        const sessionKey = placementKey(bucket.provider, sessionId)
        const earlier = counted.get(sessionKey)
        const before = Option.flatMap(Option.fromUndefinedOr(earlier), (entry) =>
          Option.fromUndefinedOr(buckets.get(entry.bucket)),
        )
        if (Option.isSome(before) && Predicate.isNotUndefined(earlier)) {
          const kept = new Set(before.value.sessions)
          kept.delete(sessionId)
          buckets.set(earlier.bucket, { ...before.value, sessions: kept })
        }
        counted.set(sessionKey, { bucket: key, hour: bucket.hour })
      }
      buckets.set(key, { ...bucket, sessions: new Set(bucket.sessions) })
    }
  }
  const write = Option.match(ledger, {
    onNone: () => Effect.void,
    onSome: Effect.fn("CredentialPlacement.flush")(function* (store: PlacementLedgerStore) {
      // Nothing recorded since the last write: the file already holds it.
      const kept = yield* locked(() =>
        Option.liftPredicate(
          {
            version,
            ledger: {
              buckets: [...buckets.values()].map((bucket): UsageBucket => ({
                ...bucket,
                sessions: [...bucket.sessions],
              })),
              // Absent rather than empty, so a server that reads no quota
              // writes the file a stage-0 gent wrote.
              ...omitUndefined({
                segments: Option.getOrUndefined(
                  Option.liftPredicate([...segments.values()].flat(), Arr.isReadonlyArrayNonEmpty),
                ),
                readings: Option.getOrUndefined(
                  Option.liftPredicate([...readings.values()], Arr.isReadonlyArrayNonEmpty),
                ),
                burn: Option.getOrUndefined(
                  Option.liftPredicate([...burns.values()], Arr.isReadonlyArrayNonEmpty),
                ),
              }),
            },
          },
          () => version !== written,
        ),
      )
      if (Option.isNone(kept)) return
      if (!(yield* store.save(kept.value.ledger))) return
      yield* locked(() => {
        written = kept.value.version
      })
    }, writeLock.withPermits(1)),
  })
  const liveOn = (provider: string, slot: CredentialSlot, except: SessionId) => {
    let count = 0
    for (const [key, entry] of live)
      if (
        entry.provider === provider &&
        entry.slot === slot &&
        key !== placementKey(provider, except)
      )
        count += 1
    return count
  }
  /**
   * One reading of a window of the account on `slot`, under the lock. A move
   * of at least 1% from where the open segment opened closes it with the
   * fuel spent since then; a reset (its time moved, or the window fell), a
   * gap over 15 minutes or a refusal drops that fuel instead; a smaller move
   * keeps adding to it. A rejected reading holds the account until its reset
   * (`quotaHeld`).
   */
  const read = (provider: string, slot: CredentialSlot, reading: QuotaReading, now: number) => {
    const key = placementKey(provider, slot, reading.window)
    const last = Option.fromUndefinedOr(readings.get(key))
    const signedInAt = Option.getOrUndefined(signedInOf(provider, slot))
    readings.set(key, {
      provider,
      slot,
      window: reading.window,
      utilization: reading.utilization,
      resetAt: reading.resetAt,
      readAt: now,
      rejected: reading.rejected,
      ...omitUndefined({ signedInAt }),
    })
    version += 1
    const fresh = {
      from: reading.utilization,
      fuel: Option.some(0),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    const open = Option.fromUndefinedOr(openSegments.get(key))
    const continues = Option.exists(
      last,
      (previous) =>
        !reading.rejected &&
        !previous.rejected &&
        Math.abs(reading.resetAt - previous.resetAt) <= QUOTA_RESET_TOLERANCE_MS &&
        reading.utilization >= previous.utilization &&
        now - previous.readAt <= QUOTA_GAP_MS,
    )
    if (!continues || Option.isNone(open) || Option.isNone(last)) {
      openSegments.set(key, fresh)
      return
    }
    const moved = reading.utilization - open.value.from
    // A move under 1%: the segment stays open from where it opened, and the
    // gap counts from now.
    if (moved < QUOTA_STEP - 1e-9) return
    openSegments.set(key, fresh)
    if (Option.isNone(open.value.fuel)) return
    segments.set(key, [
      ...(segments.get(key) ?? []),
      {
        provider,
        slot,
        window: reading.window,
        ...omitUndefined({ signedInAt }),
        endedAt: now,
        fuel: open.value.fuel.value,
        deltaPct: moved * 100,
        tokens: open.value.tokens,
      },
    ])
  }
  const spendAt = Effect.fn("CredentialPlacement.spendAt")(function* (
    spend: PlacementSpend,
    cache: Option.Option<{ readonly ttlMs: Option.Option<number> }>,
  ) {
    const now = yield* Clock.currentTimeMillis
    const hour = Math.floor(now / PLACEMENT_BUCKET_MS)
    yield* locked(() => {
      trim(now)
      if (Option.isSome(cache)) {
        unguard(spend.sessionId)
        live.set(placementKey(spend.provider, spend.sessionId), {
          provider: spend.provider,
          slot: spend.slot,
          until: lifetimeEnd(now, cache.value.ttlMs),
        })
      }
      if (Option.isSome(spend.costUsd)) record(spend, spend.costUsd.value, hour)
    })
  })
  /**
   * The lanes of one provider over `scope`, under the lock. Account pace
   * remains quota in hand over time to its own reset, for placement. Pool
   * admission takes max(expiring weekly floor, rolling seven-day supply),
   * capped before each weekly and 5h refill, then floors once in lane units.
   * A window with no rate of its own reads the provider's over every account.
   */
  const providerLanes = (
    provider: string,
    scope: ReadonlyArray<CredentialSlot>,
    now: number,
  ): ProviderLanes => {
    const fuelPerHour = fuelPerHourOf(provider)
    const own = new Map<string, WindowFit>()
    const pooled = new Map<string, Array<FuelSegment>>()
    for (const [key, list] of segments) {
      const first = list[0]
      if (Predicate.isUndefined(first) || first.provider !== provider) continue
      const fit = fitWindow(list)
      own.set(key, fit)
      pooled.set(first.window, [...(pooled.get(first.window) ?? []), ...fit.kept])
    }
    const poolRate = new Map(
      [...pooled].map(([window, kept]) => [window, weightedRate(kept)] as const),
    )
    const slots = new Set<CredentialSlot>(scope)
    for (const reading of readings.values())
      if (reading.provider === provider) slots.add(reading.slot)
    const accounts = [...slots].map((slot): LaneAccount => {
      const accountHeld = held.has(placementKey(provider, slot)) || quotaHeld(provider, slot, now)
      const windows = readings
        .values()
        .filter((reading) => reading.provider === provider && reading.slot === slot)
        .map((reading): LaneWindow => {
          const key = placementKey(provider, slot, reading.window)
          const fit = Option.fromUndefinedOr(own.get(key))
          const ownRate = Option.flatMap(fit, (found) => found.fuelPerPct)
          const fuelPerPct = Option.orElse(ownRate, () =>
            Option.flatten(Option.fromUndefinedOr(poolRate.get(reading.window))),
          )
          // A window whose reset passed is full again, for its whole length.
          const reset = reading.resetAt <= now
          let horizon = Option.some(Math.max(reading.resetAt - now, QUOTA_MIN_HORIZON_MS))
          let utilization = reading.utilization
          if (reset) {
            horizon = windowLengthMs(reading.window)
            utilization = 0
          }
          // A rejected window carries no run until it resets, rate or not.
          const sustainable = Option.flatMap(horizon, (ms) => {
            if (reading.rejected && !reset) return Option.some(0)
            const remaining = Math.max(0, 1 - utilization) * 100
            return Option.map(
              fuelPerPct,
              (rate) => (remaining * rate * 3_600_000) / (fuelPerHour * ms),
            )
          })
          return {
            window: reading.window,
            utilization,
            resetAt: reading.resetAt,
            readAt: reading.readAt,
            rejected: reading.rejected && !reset,
            samples: Option.match(fit, { onNone: () => 0, onSome: (found) => found.kept.length }),
            outsideShare: Option.match(fit, {
              onNone: () => 0,
              onSome: (found) => found.outsideShare,
            }),
            ...omitUndefined({
              fuelPerPct: Option.getOrUndefined(fuelPerPct),
              band: Option.getOrUndefined(Option.flatMap(fit, (found) => found.band)),
              sustainable: Option.getOrUndefined(sustainable),
            }),
          }
        })
        .toArray()
      const each = windows.map((window) => Option.fromUndefinedOr(window.sustainable))
      const fewest = Option.map(
        Option.filter(Option.all(each), () => windows.length > 0),
        (values) => Math.min(...values),
      )
      // A held account carries no run, whatever its windows read.
      let sustainable = fewest
      if (accountHeld) sustainable = Option.some(0)
      return {
        slot,
        windows,
        held: accountHeld,
        ...omitUndefined({ sustainable: Option.getOrUndefined(sustainable) }),
      }
    })
    const scoped = accounts.filter((account) => scope.includes(account.slot))
    const accountCapacity = Option.map(
      Option.all(scoped.map((account) => Option.fromUndefinedOr(account.sustainable))),
      (values) => values.reduce((sum, value) => sum + value, 0),
    )
    // Placement keeps each account's current pace. Admission paces the pool:
    // accounts whose weeks are spent can refill it later without being
    // eligible for a request now. Unknown windows keep capacity unknown.
    const weeks = scoped
      .values()
      .filter((account) => !held.has(placementKey(provider, account.slot)))
      .map((account) => {
        const week = account.windows.find((window) => window.window === "7d")
        if (Predicate.isUndefined(week) || Predicate.isUndefined(week.fuelPerPct))
          return Option.none()
        const full = 100 * week.fuelPerPct
        return Option.some({
          account,
          full,
          remaining: quotaRoom(week, full),
          hours: quotaHours(week, now, 168),
        })
      })
    const rollingCapacity = Option.flatMap(Option.all(weeks), (due) => {
      if (due.length === 0) return Option.none()
      // Explicit credential refusals were left out: they predict no refill.
      // A quota rejection alone does: its own window still supplies a reset.
      if (
        due.some(({ account }) =>
          account.windows.some((window) => Predicate.isUndefined(window.sustainable)),
        )
      )
        return Option.none()
      const weekly = weeklyPoolPace(due)
      const short = fiveHourPoolCeiling(due, now)
      if (Option.isNone(short)) return Option.none()
      // Other driver windows retain their current ceiling.
      const otherWindows = new Map<string, number>()
      for (const account of scoped)
        for (const window of account.windows)
          if (window.window !== "7d" && window.window !== "5h")
            otherWindows.set(
              window.window,
              (otherWindows.get(window.window) ?? 0) + (window.sustainable ?? 0),
            )
      return Option.some(
        Math.max(
          0,
          Math.min(
            weekly.sustainable / fuelPerHour,
            weekly.ceiling / fuelPerHour,
            short.value / fuelPerHour,
            ...otherWindows.values(),
          ),
        ),
      )
    })
    let sustainable = accountCapacity
    if (scoped.some((account) => account.windows.some((window) => window.window === "7d")))
      sustainable = rollingCapacity
    if (scoped.length > 0 && scoped.every((account) => account.held)) sustainable = Option.some(0)
    const capacity = Option.map(sustainable, (value) => Math.floor(value + 1e-9))
    return {
      provider,
      scope: [...scope],
      accounts,
      load: laneLoad(provider, scope, Option.none(), now),
      fuelPerHour,
      laneHours: burns.get(provider)?.seen ?? 0,
      ...omitUndefined({
        capacity: Option.getOrUndefined(Option.filter(capacity, () => scoped.length > 0)),
      }),
    }
  }
  /**
   * When a spent scope can carry a run again: the soonest account whose
   * hold ends and whose windows short of a run have all reset.
   */
  const spentUntil = (lanes: ProviderLanes, now: number) => {
    const ready = lanes.accounts
      .filter((account) => lanes.scope.includes(account.slot))
      .map((account) =>
        Math.max(
          held.get(placementKey(lanes.provider, account.slot)) ?? now,
          ...account.windows
            .filter((window) => (window.sustainable ?? 1) < 1)
            .map((window) => window.resetAt),
        ),
      )
    return Math.min(...ready)
  }
  return {
    place: Effect.fn("CredentialPlacement.place")(function* (request: PlacementRequest) {
      const now = yield* Clock.currentTimeMillis
      return yield* locked((): Arr.NonEmptyReadonlyArray<CredentialSlot> => {
        trim(now)
        const open = request.pool.filter((slot) => !request.left.has(slot))
        if (!Arr.isReadonlyArrayNonEmpty(open)) return request.pool
        const first = windowStart(now)
        // The unit reads every account of the provider, the ones the turn left included.
        let sessions = 0
        let spent = 0
        const load = new Map<CredentialSlot, number>()
        for (const bucket of buckets.values()) {
          if (bucket.provider !== request.provider || bucket.hour < first) continue
          sessions += bucket.sessions.size
          spent += bucket.costUsd
          load.set(bucket.slot, (load.get(bucket.slot) ?? 0) + bucket.costUsd)
        }
        const warmedBySibling = (slot: CredentialSlot) =>
          Option.exists(
            request.starter,
            (starter) =>
              !Option.contains(request.preferred, slot) &&
              (warming.get(placementKey(request.provider, starter, slot))?.size ?? 0) > 0,
          )
        // A held account can report sustainable 0 with no reading. It is
        // not quota pace: an unread pool keeps the stage-0 ranking.
        const accounts = providerLanes(request.provider, open, now).accounts.filter(
          (account) => account.windows.length > 0,
        )
        const walk = rankPlacement({
          slots: Arr.map(open, (slot) => {
            const account = accounts.find((account) => account.slot === slot)
            return {
              slot,
              load: load.get(slot) ?? 0,
              live: liveOn(request.provider, slot, request.sessionId),
              held: isHeld(request.provider, slot, request.model, now) || warmedBySibling(slot),
              ...omitUndefined({
                sustainable: account?.sustainable,
                weeklyResetAt: account?.windows.find((window) => window.window === "7d")?.resetAt,
              }),
            }
          }),
          spent,
          sessions,
          preferred: Option.filter(request.preferred, (slot) => !request.left.has(slot)),
        })
        const choice = walk[0]
        // Live from the decision on, so a burst of placements reads each earlier one.
        live.set(placementKey(request.provider, request.sessionId), {
          provider: request.provider,
          slot: choice,
          until: lifetimeEnd(now, request.ttlMs),
        })
        if (Option.isSome(request.starter) && !Option.contains(request.preferred, choice)) {
          const key = placementKey(request.provider, request.starter.value, choice)
          const children = warming.get(key) ?? new Set<SessionId>()
          children.add(request.sessionId)
          warming.set(key, children)
        }
        return walk
      })
    }),
    noteStep: Effect.fn("CredentialPlacement.noteStep")(function* (step: PlacementStep) {
      yield* spendAt(step, Option.some({ ttlMs: step.ttlMs }))
    }),
    noteSpend: Effect.fn("CredentialPlacement.noteSpend")(function* (spend: PlacementSpend) {
      yield* spendAt(spend, Option.none())
    }),
    refuse: Effect.fn("CredentialPlacement.refuse")(function* (refusal: PlacementRefusal) {
      const now = yield* Clock.currentTimeMillis
      const until = Option.getOrElse(refusal.retryAt, () => now + PLACEMENT_REFUSAL_HOLD_MS)
      yield* locked(() => {
        // A refusal of a sign-in the label replaced since holds nothing.
        const slot = reportedOn(refusal.provider, refusal.slot, refusal.signedInAt)
        if (Option.isNone(slot)) return
        const key = Option.match(refusal.model, {
          onNone: () => placementKey(refusal.provider, slot.value),
          onSome: (model) => placementKey(refusal.provider, slot.value, model),
        })
        held.set(key, until)
      })
    }),
    open: Effect.fn("CredentialPlacement.open")(function* (params: {
      readonly provider: string
      readonly pool: ReadonlyArray<CredentialSlot>
      readonly model: ModelId
      readonly left: ReadonlySet<CredentialSlot>
    }) {
      const now = yield* Clock.currentTimeMillis
      return yield* locked(() => {
        trim(now)
        return params.pool.some(
          (slot) => !params.left.has(slot) && !isHeld(params.provider, slot, params.model, now),
        )
      })
    }),
    release: Effect.fn("CredentialPlacement.release")(function* (sessionId: SessionId) {
      const now = yield* Clock.currentTimeMillis
      yield* locked(() => {
        unguard(sessionId)
        const lane = Option.fromUndefinedOr(running.get(sessionId))
        running.delete(sessionId)
        if (Option.isSome(lane)) burnLane(lane.value, now)
      })
    }),
    admitLane: Effect.fn("CredentialPlacement.admitLane")(function* (request: LaneRequest) {
      const now = yield* Clock.currentTimeMillis
      const refusal = yield* locked((): Option.Option<LaneUnavailable> => {
        trim(now)
        for (const [key, held] of reserved) if (!reserving(held, now)) reserved.delete(key)
        // A start admitted again under its key keeps the lane it holds.
        if (reserved.has(request.key)) return Option.none()
        settle(request.provider, request.scope)
        const scope = request.scope.map((account) => account.slot)
        const lanes = providerLanes(request.provider, scope, now)
        const load = laneLoad(request.provider, scope, request.asker, now)
        const capacity = Option.fromUndefinedOr(lanes.capacity)
        if (Option.isSome(capacity) && load >= capacity.value) {
          let reason: LaneUnavailable["reason"] = "Busy"
          let retryAt = now + LANE_BUSY_RETRY_MS
          let message = `No lane on ${request.provider}: ${load} of ${capacity.value} lanes are running; one frees when a run ends`
          if (capacity.value === 0) {
            reason = "Spent"
            retryAt = Math.max(spentUntil(lanes, now), retryAt)
            message = `No lane on ${request.provider}: its quota windows carry no run before ${DateTime.formatIso(DateTime.makeUnsafe(retryAt))}`
          }
          return Option.some(
            new LaneUnavailable({
              message,
              provider: request.provider,
              reason,
              capacity: capacity.value,
              load,
              retryAt,
            }),
          )
        }
        reserved.set(request.key, {
          provider: request.provider,
          scope,
          until: now + LANE_RESERVATION_MS,
          holders: 0,
          admission: (lastAdmission += 1),
        })
        return Option.none()
      })
      if (Option.isSome(refusal)) return yield* refusal.value
    }),
    openLane: Effect.fn("CredentialPlacement.openLane")(function* (lane: OpenLane) {
      const now = yield* Clock.currentTimeMillis
      yield* locked(() => {
        reserved.delete(lane.key)
        settle(lane.provider, lane.scope)
        // A turn that opens while its session's lane is open goes on in it.
        const before = Option.filter(
          Option.fromUndefinedOr(running.get(lane.sessionId)),
          (open) => open.provider === lane.provider,
        )
        running.set(lane.sessionId, {
          provider: lane.provider,
          scope: lane.scope.map((account) => account.slot),
          openedAt: Option.match(before, { onNone: () => now, onSome: (open) => open.openedAt }),
          fuel: Option.match(before, { onNone: () => Option.some(0), onSome: (open) => open.fuel }),
        })
      })
    }),
    freeReservation: Effect.fn("CredentialPlacement.freeReservation")(function* (key: string) {
      yield* locked(() => {
        reserved.delete(key)
      })
    }),
    holdReservation: (key: string) => {
      // The last holder out starts the 2 minutes again.
      const mark = (admission: Option.Option<number>, holders: 1 | -1) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          locked(() => {
            const entry = Option.filter(
              Option.fromUndefinedOr(reserved.get(key)),
              (found) =>
                reserving(found, now) &&
                Option.getOrElse(
                  Option.map(admission, (held) => held === found.admission),
                  () => true,
                ),
            )
            if (Option.isNone(entry)) return Option.none<number>()
            reserved.set(key, {
              ...entry.value,
              holders: entry.value.holders + holders,
              until: now + LANE_RESERVATION_MS,
            })
            return Option.some(entry.value.admission)
          }),
        )
      return Effect.acquireRelease(mark(Option.none(), 1), (held) =>
        Effect.asVoid(
          Option.match(held, {
            onNone: () => Effect.void,
            onSome: (admission) => mark(Option.some(admission), -1),
          }),
        ),
      ).pipe(Effect.withSpan("CredentialPlacement.holdReservation"))
    },
    renameLabel: Effect.fn("CredentialPlacement.renameLabel")(function* (rename) {
      yield* locked(() => {
        const fromKey = placementKey(rename.provider, rename.from)
        const toKey = placementKey(rename.provider, rename.to)
        const signIn = Option.fromUndefinedOr(signIns.get(fromKey))
        relabel(rename.provider, rename.from, rename.to)
        signIns.delete(fromKey)
        signIns.delete(toKey)
        renamed.delete(toKey)
        if (Option.isSome(signIn)) {
          signIns.set(toKey, { ...signIn.value, slot: rename.to })
          renamed.set(fromKey, { to: rename.to, signedInAt: signIn.value.signedInAt })
        }
        version += 1
      })
    }),
    noteQuota: Effect.fn("CredentialPlacement.noteQuota")(function* (quota: PlacementQuota) {
      const now = yield* Clock.currentTimeMillis
      yield* locked(() => {
        trim(now)
        const slot = reportedOn(quota.provider, quota.slot, quota.signedInAt)
        if (Option.isNone(slot)) return
        for (const reading of quota.readings) read(quota.provider, slot.value, reading, now)
      })
    }),
    noteFuel: Effect.fn("CredentialPlacement.noteFuel")(function* (spend: PlacementFuel) {
      const priced = fuelOf(spend.costUsd, spend.usage)
      yield* locked(() => {
        // The lane's burn counts what its turn spent, whichever sign-in served it.
        const lane = running.get(spend.sessionId)
        if (Predicate.isNotUndefined(lane) && lane.provider === spend.provider)
          running.set(spend.sessionId, {
            ...lane,
            fuel: Option.flatMap(lane.fuel, (fuel) =>
              Option.map(priced, (cost) => fuel + cost.fuel),
            ),
          })
        const slot = reportedOn(spend.provider, spend.slot, spend.signedInAt)
        if (Option.isNone(slot)) return
        for (const [key, open] of openSegments) {
          if (!key.startsWith(placementKey(spend.provider, slot.value, ""))) continue
          openSegments.set(
            key,
            Option.match(priced, {
              // An unpriced request drops the segment it falls in.
              onNone: () => ({ ...open, fuel: Option.none() }),
              onSome: (cost) => ({
                ...open,
                fuel: Option.map(open.fuel, (fuel) => fuel + cost.fuel),
                tokens: {
                  input: open.tokens.input + cost.tokens.input,
                  output: open.tokens.output + cost.tokens.output,
                  cacheRead: open.tokens.cacheRead + cost.tokens.cacheRead,
                  cacheWrite: open.tokens.cacheWrite + cost.tokens.cacheWrite,
                },
              }),
            }),
          )
        }
      })
    }),
    lanes: Effect.fn("CredentialPlacement.lanes")(function* (scopeOf: LaneScopeOf) {
      const now = yield* Clock.currentTimeMillis
      const providers = yield* locked(() => {
        trim(now)
        return [...new Set([...readings.values()].map((reading) => reading.provider))].sort()
      })
      const scopes = yield* Effect.forEach(providers, (provider) =>
        Effect.map(scopeOf(provider), (scope) => [provider, scope] as const),
      )
      return yield* locked((): LaneReport => {
        for (const [provider, scope] of scopes)
          if (Option.isSome(scope)) settle(provider, scope.value)
        return {
          providers: scopes.map(([provider, scope]) =>
            providerLanes(
              provider,
              Option.match(scope, {
                onNone: () => [],
                onSome: (accounts) => accounts.map((account) => account.slot),
              }),
              now,
            ),
          ),
        }
      })
    }),
    flush: write,
  } satisfies CredentialPlacementService
})

/**
 * The server's credential placement: one per server, so every session of
 * every workspace reads one usage table. Its ledger lives in gent's data
 * directory (`credential-usage.json`), not per workspace, as accounts are
 * not. `Memory` keeps the table in memory alone, with no ledger: a root
 * with no data directory to write to (a test's actor).
 */
export class CredentialPlacement extends Context.Service<
  CredentialPlacement,
  CredentialPlacementService
>()("@gent/core/src/runtime/provider/CredentialPlacement") {
  static Live = Layer.effect(
    CredentialPlacement,
    Effect.gen(function* () {
      const { home } = yield* RuntimeEnvironment
      const pathService = yield* Path.Path
      const dataDir = pathService.resolve(yield* resolveDataDir(home))
      const ledger = yield* placementLedgerFile(pathService.join(dataDir, PLACEMENT_LEDGER_FILE))
      const placement = yield* makeCredentialPlacement(Option.some(ledger))
      // A shutdown keeps the hour still open.
      yield* Effect.addFinalizer(() => placement.flush)
      // Each hour is written as it closes, whether or not a step follows it.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            yield* Effect.sleep(Duration.millis(PLACEMENT_BUCKET_MS - (now % PLACEMENT_BUCKET_MS)))
            yield* placement.flush
          }),
        ),
      )
      return placement
    }),
  )

  static Memory = Layer.effect(CredentialPlacement, makeCredentialPlacement(Option.none()))
}

// ── decision-model-resolver ─────────────────────────────────────────────────

/**
 * Why no classifier model answered: none has a credential (`NoProvider`), the
 * named one is not a classifier the profile's drivers list (`UnknownModel`),
 * or its driver failed to build it (`ProviderFailed`).
 */
class DecisionModelError extends Schema.TaggedError<
  DecisionModelError,
  { readonly brand: unique symbol }
>()("DecisionModelError", {
  reason: Schema.Literals(["NoProvider", "UnknownModel", "ProviderFailed"]),
  message: Schema.String,
}) {}

/**
 * One credential a classifier call may use: its slot, and the model the
 * driver builds with it. The build fails with the driver's own error, so a
 * call tells a proved credential failure from any other.
 */
interface ClassifierCandidate {
  readonly slot: CredentialSlot
  readonly model: Effect.Effect<DecisionModel.DecisionModel, ProviderAuthError, Scope.Scope>
}

/**
 * A classifier model ready to answer, the catalog entry it resolved to, and
 * the credentials of its sign-in's order after the one it was built with: a
 * call whose credential fails with a proved credential failure tries them,
 * first to last. `slot` is the credential the model was built with, `retry`
 * the driver's same-credential retries, and `entryFor` the model's entry as
 * one credential lists it (an OAuth subset and its prices, or the API's):
 * a call is priced by the credential that answered.
 */
interface ResolvedDecisionModel {
  readonly modelId: ModelId
  readonly entry: Model
  readonly model: DecisionModel.DecisionModel
  readonly slot: CredentialSlot
  readonly later: ReadonlyArray<ClassifierCandidate>
  readonly retry: RetryPolicy
  readonly entryFor: (slot: CredentialSlot) => Effect.Effect<Model>
}

/** The classifier models of one profile: the drivers of its `ExtensionRegistry`. */
interface ProfileClassifiers {
  /**
   * The named classifier model (`provider/model`), or with none a classifier
   * whose driver has a credential of its order: a `-latest` alias first,
   * else the first the profile's drivers list.
   */
  readonly resolve: (
    modelId: Option.Option<string>,
  ) => Effect.Effect<ResolvedDecisionModel, DecisionModelError, Scope.Scope>
  /**
   * Whether some driver that serves classifiers (it declares
   * `resolveDecisionModel`) has a credential of its order, stored or (for
   * the default) from env, so a call that names no model has one to
   * resolve. It reads no catalog. An auth store that fails to read counts as
   * none.
   */
  readonly hasCredential: Effect.Effect<boolean>
  /** The classifier models whose driver has a credential, cheapest first; unpriced ones last. */
  readonly usable: Effect.Effect<ReadonlyArray<Model>, DecisionModelError>
}

interface DecisionModelResolverService {
  /** The classifiers of the caller's profile, read from its `ExtensionRegistry`. */
  readonly profile: Effect.Effect<ProfileClassifiers, never, ExtensionRegistry>
}

/** The model-name suffix of an alias that tracks its provider's newest model. */
const LATEST_ALIAS = "-latest"

/** One classifier entry with the driver that resolves it. */
interface ClassifierEntry {
  readonly model: Model
  readonly driver: ModelDriverContribution
}

/** The drivers and the provider config of the profile a classifier call runs in. */
interface ClassifierProfile {
  readonly drivers: ModelDrivers
  readonly config: ProviderConfig
}

/** A failed auth read, as a classifier call reports it. */
const classifierAuthFailure = (driverId: string) => (cause: AuthError) =>
  new DecisionModelError({
    reason: "ProviderFailed",
    message: `Failed to read auth for provider "${driverId}": ${causeMessage(cause)}`,
  })

/** The drivers that serve classifiers: each declares `resolveDecisionModel`. */
const classifierDrivers = (allDrivers: ModelDrivers): ModelDrivers =>
  new Map(
    [...allDrivers].filter(([, driver]) => Predicate.isNotUndefined(driver.resolveDecisionModel)),
  )

/**
 * The credential `driverId`'s order reaches first that can serve: a stored
 * one, or the default the driver reads from its own variable. None when no
 * slot of the order can.
 */
const classifierCredentialReady = Effect.fn("DecisionModelResolver.credentialReady")(function* (
  auth: AuthService,
  profile: ClassifierProfile,
  driver: ModelDriverContribution,
) {
  const slots = yield* credentialOrder(profile.drivers, profile.config, driver.id).pipe(
    Effect.map((order): ReadonlyArray<CredentialSlot> => order.slots),
    Effect.orElseSucceed((): ReadonlyArray<CredentialSlot> => [DEFAULT_CREDENTIAL_SLOT]),
  )
  for (const slot of slots) {
    const stored = yield* driverAuthInfo(auth, profile.drivers, driver.id, slot)
    if (Option.isSome(stored)) return true
    if (slot === DEFAULT_CREDENTIAL_SLOT && (yield* driverEnvReady(driver))) return true
  }
  return false
})

/**
 * The classifier models the profile's classifier drivers list, and the
 * catalogs that failed; a failed one leaves its models out.
 */
const classifierCatalog = Effect.fn("DecisionModelResolver.catalog")(function* (
  auth: AuthService,
  catalogSource: ModelCatalogSourceService,
  profile: ClassifierProfile,
) {
  const drivers = classifierDrivers(profile.drivers)
  const source = yield* catalogSource.readWithDecisions
  // A classifier needs no API class: with none, core lists only the decision models.
  const listing: DriverProfile = { modelDrivers: drivers, apiClasses: new Map() }
  const catalog = yield* listModelCatalog(listing, source, (driverId) =>
    catalogAuths(auth, profile.drivers, profile.config, driverId, Option.none()).pipe(
      Effect.mapError(
        (error) =>
          new ProviderAuthError({ message: classifierAuthFailure(driverId)(error).message }),
      ),
    ),
  ).pipe(
    Effect.mapError(
      (error) => new DecisionModelError({ reason: "ProviderFailed", message: error.message }),
    ),
  )
  const classifiers: ReadonlyArray<ClassifierEntry> = catalog.models.flatMap((model) => {
    const driver = drivers.get(model.provider)
    if (model.kind !== "classifier" || Predicate.isUndefined(driver)) return []
    return [{ model, driver }]
  })
  return { drivers, catalog: source, classifiers, failures: catalog.failures }
})

/**
 * Whether some driver that serves classifiers has a credential of its order.
 * A driver declares `resolveDecisionModel` only when it can serve a
 * classifier, so no catalog is read. A failed read counts as none.
 */
const classifierAvailable = Effect.fn("DecisionModelResolver.hasCredential")(
  function* (auth: AuthService, profile: ClassifierProfile) {
    for (const driver of classifierDrivers(profile.drivers).values()) {
      if (yield* classifierCredentialReady(auth, profile, driver)) return true
    }
    return false
  },
  Effect.catch((error) =>
    Effect.logWarning("classifier.availability-read-failed").pipe(
      Effect.annotateLogs({ error: error.message }),
      Effect.as(false),
    ),
  ),
)

/**
 * The credentials a call to `driver`'s classifier tries, in its order: the
 * default (what is stored, else the driver's own variable) and each named
 * slot that holds one. A named slot with none is skipped, never served by
 * the default or the environment.
 */
const classifierCandidates = Effect.fn("DecisionModelResolver.candidates")(function* (
  auth: AuthService,
  profile: ClassifierProfile,
  driver: ModelDriverContribution,
  modelId: ModelId,
  modelName: string,
  resolveFor: NonNullable<ModelDriverContribution["resolveDecisionModel"]>,
) {
  const order = yield* credentialOrder(profile.drivers, profile.config, driver.id).pipe(
    Effect.mapError(
      (error) => new DecisionModelError({ reason: "ProviderFailed", message: error.message }),
    ),
  )
  const candidates: Array<ClassifierCandidate> = []
  for (const slot of order.slots) {
    const authInfo = yield* driverAuthInfo(auth, profile.drivers, driver.id, slot).pipe(
      Effect.mapError(classifierAuthFailure(driver.id)),
    )
    if (Option.isNone(authInfo) && slot !== DEFAULT_CREDENTIAL_SLOT) continue
    // Resolving, building and reading the driver's model all run driver
    // code: a defect in any of them fails this call, never the cell's host.
    const model = Effect.gen(function* () {
      const scope = yield* Effect.scope
      return yield* Effect.suspend(() =>
        resolveFor(modelName, Option.getOrUndefined(authInfo)),
      ).pipe(
        Effect.flatMap((layer) => Layer.buildWithScope(layer, scope)),
        Effect.map((built) => Context.get(built, DecisionModel.DecisionModel)),
        Effect.catchDefect((defect) =>
          Effect.fail(new ProviderAuthError({ message: causeMessage(defect) })),
        ),
      )
    })
    candidates.push({ slot, model })
  }
  if (Arr.isReadonlyArrayNonEmpty(candidates)) return candidates
  return yield* new DecisionModelError({
    reason: "NoProvider",
    message: `${modelId}: no credential of its order is signed in; sign in with /auth`,
  })
})

const resolveDecisionModel = Effect.fn("DecisionModelResolver.resolve")(function* (
  auth: AuthService,
  catalogSource: ModelCatalogSourceService,
  profile: ClassifierProfile,
  requested: Option.Option<string>,
) {
  // A call that cannot resolve a classifier names each catalog that failed.
  const { drivers, catalog, classifiers, failures } = yield* classifierCatalog(
    auth,
    catalogSource,
    profile,
  )
  let failed = ""
  if (failures.length > 0)
    failed = `. Classifier catalogs that failed: ${failures.map((failure) => `${failure.driverId} (${failure.error})`).join(", ")}`
  const chosen = yield* Option.match(requested, {
    onSome: (id) =>
      Option.match(
        Option.fromUndefinedOr(
          classifiers.find((entry) => entry.model.id === currentModelId(catalog, drivers, id)),
        ),
        {
          onSome: Effect.succeed,
          onNone: () => {
            let known = "none"
            if (classifiers.length > 0)
              known = classifiers.map((entry) => entry.model.id).join(", ")
            return Effect.fail(
              new DecisionModelError({
                reason: "UnknownModel",
                message: `Unknown classifier model "${id}". Classifier models: ${known}${failed}`,
              }),
            )
          },
        },
      ),
    onNone: () =>
      Effect.gen(function* () {
        const usable = yield* credentialedClassifiers(auth, profile, classifiers)
        // A `-latest` alias tracks its provider's newest model, so it wins
        // over a pinned version wherever the driver order puts it.
        const chosenEntry = Option.orElse(
          Option.fromUndefinedOr(usable.find((entry) => entry.model.id.endsWith(LATEST_ALIAS))),
          () => Option.fromUndefinedOr(usable[0]),
        )
        if (Option.isSome(chosenEntry)) return chosenEntry.value
        const variables = [...drivers.values()].flatMap((driver) =>
          Option.toArray(Option.fromUndefinedOr(driver.envCredential)),
        )
        let hint = "no driver serves one"
        if (variables.length > 0)
          hint = `set ${[...new Set(variables)].join(" or ")}, or sign in with /auth`
        return yield* new DecisionModelError({
          reason: "NoProvider",
          message: `No classifier model has a credential: ${hint}${failed}`,
        })
      }),
  })
  const resolveFor = Option.fromUndefinedOr(chosen.driver.resolveDecisionModel)
  const modelName = Option.map(parseModelId(chosen.model.id), ([, name]) => name)
  if (Option.isNone(resolveFor) || Option.isNone(modelName)) {
    return yield* new DecisionModelError({
      reason: "UnknownModel",
      message: `Classifier model "${chosen.model.id}" has no provider/model id`,
    })
  }
  const candidates = yield* classifierCandidates(
    auth,
    profile,
    chosen.driver,
    chosen.model.id,
    modelName.value,
    resolveFor.value,
  )
  // The first credential of the order that builds the model serves the call;
  // one a proved credential failure stops moves on to the next.
  const [first, ...rest] = candidates
  let current = first
  let later: ReadonlyArray<ClassifierCandidate> = rest
  const driver = chosen.driver
  const owner = credentialOwner(profile.drivers, driver.id)
  // One driver's listing as one credential sees it; the union entry when
  // that credential's view does not list the model, or its listing fails.
  const entryFor = (slot: CredentialSlot): Effect.Effect<Model> =>
    listModelCatalog(
      { modelDrivers: new Map([[driver.id, driver]]), apiClasses: new Map() },
      catalog,
      (driverId) =>
        catalogAuths(
          auth,
          profile.drivers,
          profile.config,
          driverId,
          Option.some({ provider: ProviderId.make(owner), slot }),
        ).pipe(Effect.mapError((error) => new ProviderAuthError({ message: error.message }))),
    ).pipe(
      Effect.map(
        (listed) => listed.models.find((model) => model.id === chosen.model.id) ?? chosen.model,
      ),
      Effect.orElseSucceed(() => chosen.model),
    )
  for (;;) {
    const built = yield* Effect.exit(current.model)
    if (Exit.isSuccess(built)) {
      return {
        modelId: chosen.model.id,
        entry: chosen.model,
        model: built.value,
        slot: current.slot,
        later,
        retry: driver.retry ?? DEFAULT_RETRY_POLICY,
        entryFor,
      }
    }
    const failure = Cause.findErrorOption(built.cause)
    const [next, ...after] = later
    if (Predicate.isUndefined(next) || Option.isNone(Option.flatMap(failure, credentialRefusal))) {
      return yield* new DecisionModelError({
        reason: "ProviderFailed",
        message: `${chosen.model.id}: ${Option.match(failure, {
          onNone: () => Cause.pretty(built.cause),
          onSome: (error) => error.message,
        })}`,
      })
    }
    current = next
    later = after
  }
})

/** The classifier entries whose driver has a credential of its order, in catalog order. */
const credentialedClassifiers = (
  auth: AuthService,
  profile: ClassifierProfile,
  classifiers: ReadonlyArray<ClassifierEntry>,
) =>
  Effect.filter(classifiers, (entry) =>
    classifierCredentialReady(auth, profile, entry.driver).pipe(
      Effect.mapError(classifierAuthFailure(entry.driver.id)),
    ),
  )

/** A classifier's price per million tokens, input and output together; none when unpriced. */
const classifierPrice = (model: Model): Option.Option<number> =>
  Option.map(Option.fromUndefinedOr(model.pricing), (pricing) => pricing.input + pricing.output)

/** Cheapest first; an unpriced model sorts after every priced one. */
const byClassifierPrice: Order.Order<Model> = (left, right) => {
  const leftPrice = classifierPrice(left)
  const rightPrice = classifierPrice(right)
  if (Option.isNone(leftPrice) && Option.isNone(rightPrice)) return 0
  if (Option.isNone(leftPrice)) return 1
  if (Option.isNone(rightPrice)) return -1
  return Order.Number(leftPrice.value, rightPrice.value)
}

const usableClassifiers = Effect.fn("DecisionModelResolver.usable")(function* (
  auth: AuthService,
  catalogSource: ModelCatalogSourceService,
  profile: ClassifierProfile,
) {
  const { classifiers } = yield* classifierCatalog(auth, catalogSource, profile)
  const usable = yield* credentialedClassifiers(auth, profile, classifiers)
  return Arr.sort(
    usable.map((entry) => entry.model),
    byClassifierPrice,
  )
})

/**
 * Resolves classifier models through the drivers of the `ExtensionRegistry`
 * in scope, as `ModelResolver` resolves chat models. It holds the auth store,
 * so a host that reaches it never reads credentials itself.
 */
export class DecisionModelResolver extends Context.Service<
  DecisionModelResolver,
  DecisionModelResolverService
>()("@gent/core/src/runtime/provider/DecisionModelResolver") {
  static Live: Layer.Layer<DecisionModelResolver, never, Auth | ModelCatalogSource> = Layer.effect(
    DecisionModelResolver,
    Effect.gen(function* () {
      const auth = yield* Auth
      const catalogSource = yield* ModelCatalogSource
      return DecisionModelResolver.of({
        profile: Effect.gen(function* () {
          const registry = yield* ExtensionRegistry
          const profile: ClassifierProfile = {
            drivers: registry.getResolved().modelDrivers,
            config: yield* registry.providerConfig,
          }
          return {
            resolve: (modelId) => resolveDecisionModel(auth, catalogSource, profile, modelId),
            hasCredential: classifierAvailable(auth, profile),
            usable: usableClassifiers(auth, catalogSource, profile),
          }
        }),
      })
    }),
  )
}

// ── extension-models ────────────────────────────────────────────────────────

/**
 * The most one `Models.decide` may take, from resolving the model to its
 * answer. Nothing else bounds a classifier call: the provider's HTTP client
 * has no deadline of its own. A call may ask for less.
 */
const DECIDE_DEADLINE_MS = 60_000

const modelsError = (operation: string, message: string) =>
  new ExtensionServiceError({ service: "ExtensionModels", operation, message })

/** A token count a provider bills: a whole, non-negative number; none otherwise. */
const billableCount = (count: Option.Option<number>): Option.Option<number> =>
  Option.filter(count, (value) => Number.isSafeInteger(value) && value >= 0)

/**
 * The `ExtensionContext.Models` facet over the runtime's classifier models.
 * The resolver is the runtime's; the drivers are those of the caller's
 * profile, read from the `ExtensionRegistry` an extension leaf runs under.
 * A runtime or a caller without them answers that no classifier is there.
 */
export const makeExtensionModels: Effect.Effect<ExtensionModelsService> = Effect.gen(function* () {
  const resolver = yield* Effect.serviceOption(DecisionModelResolver)
  const profile = Effect.gen(function* () {
    const registry = yield* Effect.serviceOption(ExtensionRegistry)
    if (Option.isNone(resolver) || Option.isNone(registry)) return Option.none()
    return Option.some(
      yield* resolver.value.profile.pipe(Effect.provideService(ExtensionRegistry, registry.value)),
    )
  })
  const decide: ExtensionModelsService["decide"] = (params) =>
    Effect.gen(function* () {
      const classifiers = yield* profile
      if (Option.isNone(classifiers))
        return yield* modelsError("decide", "models.decide is not available in this runtime")
      const deadlineMs = Option.match(Option.fromUndefinedOr(params.timeoutMs), {
        onNone: () => DECIDE_DEADLINE_MS,
        onSome: (asked) => Math.min(Math.max(Math.round(asked), 1), DECIDE_DEADLINE_MS),
      })
      const named = params.model ?? "default classifier"
      const endsAt = (yield* Clock.currentTimeMillis) + deadlineMs
      return yield* Effect.gen(function* () {
        const resolved = yield* classifiers.value
          .resolve(Option.fromUndefinedOr(params.model))
          .pipe(
            Effect.mapError((error) => modelsError("decide", `models.decide: ${error.message}`)),
          )
        // The credentials of the classifier's order, first to last: a proved
        // credential failure moves the call to the next one, any other
        // failure (or the last credential's) ends it. A classifier streams
        // nothing, so no output is lost by the move.
        const askOnce = (model: DecisionModel.DecisionModel) =>
          model.decide(params.definition, { input: params.input })
        // A rate limit the provider says clears within the driver's retry cap
        // gets one more try on the same credential first, as a turn's request
        // gets its retries. One that resets later, or that leaves the retry
        // less of the caller's deadline than the wait itself, moves on at
        // once: a wait would end the call with no answer where the next
        // credential can give one. The refused request says nothing of how
        // long an answer takes, so the margin is the wait: the deadline the
        // caller chose (8 s for a route) is its bound for a whole call.
        const ask = (model: DecisionModel.DecisionModel) =>
          askOnce(model).pipe(
            Effect.catchIf(
              (error) => AiError.isAiError(error) && error.reason._tag === "RateLimitError",
              (error) =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis
                  const waitMs = Option.match(resolved.retry.retryAt(error, now), {
                    onNone: () => resolved.retry.initialDelay,
                    onSome: (reset) => Math.max(0, reset - now),
                  })
                  if (waitMs > resolved.retry.maxDelay || now + 2 * waitMs >= endsAt)
                    return yield* error
                  yield* Effect.sleep(Duration.millis(waitMs))
                  return yield* askOnce(model)
                }),
            ),
          )
        let answered = resolved.slot
        let outcome: Exit.Exit<
          Effect.Success<ReturnType<typeof askOnce>>,
          AiError.AiError | ProviderAuthError
        > = yield* Effect.exit(ask(resolved.model))
        for (const candidate of resolved.later) {
          if (Exit.isSuccess(outcome)) break
          const refusal = Option.flatMap(Cause.findErrorOption(outcome.cause), credentialRefusal)
          if (Option.isNone(refusal)) break
          yield* Effect.logInfo("classifier.credential-moved").pipe(
            Effect.annotateLogs({
              model: resolved.modelId,
              next: candidate.slot,
              reason: refusal.value,
            }),
          )
          outcome = yield* Effect.exit(Effect.flatMap(candidate.model, ask))
          answered = candidate.slot
        }
        const response = yield* Effect.mapError(outcome, (error) =>
          modelsError("decide", `models.decide (${resolved.modelId}) failed: ${error.message}`),
        )
        const usage = omitUndefined({
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        })
        // The call is priced as the credential that answered lists the model:
        // a subscription sign-in's subset can price it apart from an API key.
        const entry = yield* resolved.entryFor(answered)
        // A price needs both billable counts: a count the reply leaves out, or
        // one no provider bills, leaves the price unknown, never a partial sum.
        const costUsd = Option.all({
          pricing: Option.fromUndefinedOr(entry.pricing),
          inputTokens: billableCount(Option.fromUndefinedOr(usage.inputTokens)),
          outputTokens: billableCount(Option.fromUndefinedOr(usage.outputTokens)),
        }).pipe(Option.map(({ pricing, ...counts }) => calculateCost(counts, Option.some(pricing))))
        return {
          model: resolved.modelId,
          answers: response.answers,
          usage,
          ...omitUndefined({ costUsd: Option.getOrUndefined(costUsd) }),
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(deadlineMs),
          orElse: () =>
            Effect.fail(
              modelsError(
                "decide",
                `models.decide (${named}) gave no answer within ${deadlineMs} ms`,
              ),
            ),
        }),
        Effect.scoped,
      )
    })
  return {
    decide,
    available: Effect.flatMap(profile, (classifiers) =>
      Option.match(classifiers, {
        onNone: () => Effect.succeed(false),
        onSome: (found) => found.hasCredential,
      }),
    ),
    classifiers: Effect.flatMap(profile, (classifiers) =>
      Option.match(classifiers, {
        onNone: () => Effect.succeed([]),
        onSome: (found) =>
          found.usable.pipe(Effect.mapError((error) => modelsError("classifiers", error.message))),
      }),
    ),
  } satisfies ExtensionModelsService
})

// ── model-registry ──────────────────────────────────────────────────────────

/**
 * Explicit capability used by the deterministic registry test layer. It is
 * not a production model fallback and is never used by `ModelRegistry.Live`.
 */
export const TEST_MODEL_CONTEXT_LIMIT_TOKENS = 128_000

/**
 * The window `ModelRegistry.Scripted` gives a model the catalog does not
 * list: 1M, the window of the current Claude models, so a scripted turn
 * with no catalog hands its window off where one with the catalog does.
 */
const SCRIPTED_MODEL_CONTEXT_LIMIT_TOKENS = 1_000_000

/** A catalog entry made up from `modelId` alone: its provider segment, the given window and prices. */
const madeUpModel = (
  modelId: string,
  contextLength: number,
  pricing: Option.Option<ModelPricing>,
): Model =>
  Model.make({
    id: ModelId.make(modelId),
    name: modelId,
    provider: Option.getOrElse(
      Option.map(parseModelId(modelId), ([providerId]) => providerId),
      () => ProviderId.make("test"),
    ),
    contextLength,
    pricing: Option.getOrUndefined(pricing),
  })

type ResolvedProfile = ReturnType<ExtensionRegistryService["getResolved"]>

interface ModelCatalogRecordService {
  /** Keep the failures of the catalog run that just finished for this profile. */
  readonly record: (
    profile: ResolvedProfile,
    failures: ReadonlyArray<ModelCatalogFailure>,
  ) => Effect.Effect<void>
  /** The failures of this profile's last catalog run; none when it never ran. */
  readonly lastFailures: (
    profile: ResolvedProfile,
  ) => Effect.Effect<Option.Option<ReadonlyArray<ModelCatalogFailure>>>
}

/**
 * The failures of each profile's last catalog run, written where the catalog
 * runs (a turn's model lookup, `model.list`) and read by extension health, so
 * a health read never lists every driver again. Keyed weakly by the profile's
 * resolved extensions: a profile the cache drops takes its record with it.
 */
export class ModelCatalogRecord extends Context.Service<
  ModelCatalogRecord,
  ModelCatalogRecordService
>()("@gent/core/src/runtime/provider/ModelCatalogRecord") {
  static Live: Layer.Layer<ModelCatalogRecord> = Layer.sync(ModelCatalogRecord, () => {
    const byProfile = new WeakMap<ResolvedProfile, ReadonlyArray<ModelCatalogFailure>>()
    return ModelCatalogRecord.of({
      record: (profile, failures) => Effect.sync(() => void byProfile.set(profile, failures)),
      lastFailures: (profile) => Effect.sync(() => Option.fromUndefinedOr(byProfile.get(profile))),
    })
  })
}

/**
 * Every model the caller's profile can run, newest release first: each model
 * driver's list over the models.dev catalog core holds, read with each
 * credential of its order (`catalogAuths`), and each active generic
 * provider's. The drivers
 * come from the `ExtensionRegistry` in
 * scope, so a turn reads its own profile's and a server read the requesting
 * session's; a catalog captured once at launch missed every project-scoped
 * driver and ignored `disabledExtensions`.
 */
export const modelCatalog = Effect.fn("ModelRegistry.modelCatalog")(function* () {
  const { models, failures } = yield* servedModelCatalog()
  return { models, failures }
})

/**
 * `modelCatalog`, and the drivers and catalog it was listed from. `pinned`
 * lists its owner with that one credential: the view one request had.
 */
const servedModelCatalog = Effect.fn("ModelRegistry.servedModelCatalog")(function* (
  pinned: Option.Option<CredentialReceipt> = Option.none(),
) {
  const authStore = yield* Auth
  const catalogRecord = yield* ModelCatalogRecord
  const registry = yield* ExtensionRegistry
  const profile = registry.getResolved()
  const config = yield* registry.providerConfig
  const served = yield* servedProfile(authStore)
  const catalog = yield* listModelCatalog(served, served.catalog, (providerId) =>
    catalogAuths(authStore, served.modelDrivers, config, providerId, pinned).pipe(
      Effect.mapError(
        (e) =>
          new ProviderAuthError({
            message: `Failed to read auth for provider "${providerId}"`,
            cause: e,
          }),
      ),
    ),
  )
  const virtual = virtualModelCatalog(profile)
  const failures = [...catalog.failures, ...virtual.failures]
  yield* catalogRecord.record(profile, failures)
  return {
    served,
    models: [...byReleaseDateDesc(catalog.models), ...virtual.models],
    failures,
  }
})

// ── virtual models ──────────────────────────────────────────────────────────

/** A virtual model the profile serves: its router and its definition. */
export interface ServedVirtualModel {
  readonly router: ModelRouterContribution
  readonly model: VirtualModel
}

/** Why `<router>/<name>` cannot be served; none when it can. */
const virtualModelProblem = (
  profile: Pick<ResolvedProfile, "modelDrivers" | "modelRouters">,
  model: VirtualModel,
): Option.Option<string> => {
  const routed = model.choices.flatMap((choice) =>
    Option.toArray(Option.fromUndefinedOr(choice.model)),
  )
  const nested = routed.find((id) =>
    Option.exists(
      parseModelId(id),
      ([provider]) => profile.modelRouters.has(provider) && !profile.modelDrivers.has(provider),
    ),
  )
  if (Predicate.isNotUndefined(nested))
    return Option.some(`a router cannot route to a router: choice "${nested}"`)
  if (model.choices.length === 0) return Option.some("it has no choices")
  if (model.fallback < 0 || model.fallback >= model.choices.length)
    return Option.some(`its default choice ${model.fallback} is not one of its choices`)
  return Option.none()
}

/** Why a router's effort router (`ModelRouterContribution.effort`) cannot serve; none when it can. */
const effortRouterProblem = (model: VirtualModel): Option.Option<string> => {
  if (model.choices.length === 0) return Option.some("it has no choices")
  const named = model.choices.findIndex((choice) => Predicate.isNotUndefined(choice.model))
  if (named >= 0)
    return Option.some(`choice ${named + 1} names a model; an effort choice sets only an effort`)
  const unset = model.choices.findIndex((choice) => Predicate.isUndefined(choice.effort))
  if (unset >= 0) return Option.some(`choice ${unset + 1} sets no effort`)
  if (model.fallback < 0 || model.fallback >= model.choices.length)
    return Option.some(`its default choice ${model.fallback} is not one of its choices`)
  return Option.none()
}

/**
 * The effort router `/effort auto` runs: the first router's of the profile
 * that has one (a router whose id a model driver holds serves nothing), or
 * why it cannot run; none when no router has one.
 */
export const servedEffortRouter = (
  profile: Pick<ResolvedProfile, "modelDrivers" | "modelRouters">,
): Option.Option<Result.Result<ServedVirtualModel, string>> =>
  Option.fromUndefinedOr(
    [...profile.modelRouters.values()].find(
      (router) => Predicate.isNotUndefined(router.effort) && !profile.modelDrivers.has(router.id),
    ),
  ).pipe(
    Option.flatMap((router) =>
      Option.map(Option.fromUndefinedOr(router.effort), (model) =>
        Option.match(effortRouterProblem(model), {
          onNone: () => Result.succeed({ router, model }),
          onSome: (problem) =>
            Result.fail(`Effort router "${router.id}/${model.name}": ${problem}`),
        }),
      ),
    ),
  )

/**
 * The profile's routers' virtual models as catalog entries (`kind:
 * "virtual"`), and each one refused as a catalog failure under its router.
 * A virtual model none of whose choices names a model only sets an effort:
 * it is not a model, so it is not listed. A router whose id a model driver
 * holds serves nothing: the driver wins the id.
 */
const virtualModelCatalog = (profile: Pick<ResolvedProfile, "modelDrivers" | "modelRouters">) => {
  const models: Array<Model> = []
  const failures: Array<ModelCatalogFailure> = []
  for (const router of profile.modelRouters.values()) {
    if (profile.modelDrivers.has(router.id)) {
      failures.push({
        driverId: router.id,
        error: `router id "${router.id}" is a model driver's id; the driver serves it`,
      })
      continue
    }
    for (const problem of router.problems ?? [])
      failures.push({
        driverId: router.id,
        error: `${router.id}/${problem.name}: ${problem.reason}`,
      })
    // The effort router is not a model: listed only when it cannot serve.
    const effort = Option.fromUndefinedOr(router.effort)
    const effortProblem = Option.flatMap(effort, effortRouterProblem)
    if (Option.isSome(effort) && Option.isSome(effortProblem))
      failures.push({
        driverId: router.id,
        error: `${router.id}/${effort.value.name}: ${effortProblem.value}`,
      })
    for (const model of router.models) {
      if (!model.choices.some((choice) => Predicate.isNotUndefined(choice.model))) continue
      const problem = virtualModelProblem(profile, model)
      if (Option.isSome(problem)) {
        failures.push({
          driverId: router.id,
          error: `${router.id}/${model.name}: ${problem.value}`,
        })
        continue
      }
      models.push(
        Model.make({
          id: ModelId.make(`${router.id}/${model.name}`),
          name: model.label,
          provider: ProviderId.make(router.id),
          kind: "virtual",
        }),
      )
    }
  }
  return { models, failures }
}

/**
 * The virtual model `modelId` names, or why it cannot run; none when the id
 * is no router's (a driver with the router's id wins).
 */
export const servedVirtualModel = (
  profile: Pick<ResolvedProfile, "modelDrivers" | "modelRouters">,
  modelId: string,
): Option.Option<Result.Result<ServedVirtualModel, string>> =>
  Option.flatMap(parseModelId(modelId), ([provider, name]) => {
    const router = profile.modelRouters.get(provider)
    if (Predicate.isUndefined(router) || profile.modelDrivers.has(provider)) return Option.none()
    const model = router.models.find((entry) => entry.name === name)
    if (Predicate.isUndefined(model)) {
      const problem = (router.problems ?? []).find((entry) => entry.name === name)
      if (Predicate.isNotUndefined(problem))
        return Option.some(Result.fail(`Model router "${modelId}": ${problem.reason}`))
      return Option.some(
        Result.fail(
          `Unknown virtual model "${modelId}": router "${router.id}" serves no "${name}"`,
        ),
      )
    }
    const problem = virtualModelProblem(profile, model)
    if (Option.isSome(problem))
      return Option.some(Result.fail(`Model router "${modelId}": ${problem.value}`))
    return Option.some(Result.succeed({ router, model }))
  })

/**
 * The model a virtual model runs on when its router does not choose: its
 * default choice's, else the first model a choice names.
 */
export const virtualDefaultModel = (model: VirtualModel): Option.Option<ModelId> =>
  Option.orElse(Option.fromUndefinedOr(model.choices[model.fallback]?.model), () =>
    Option.fromUndefinedOr(
      model.choices.find((choice) => Predicate.isNotUndefined(choice.model))?.model,
    ),
  )

/**
 * One model of the caller's profile catalog: the turn's context limit and
 * pricing. With `credential`, its sign-in lists the model as that one
 * credential sees it (an OAuth subset and its prices, or the API's), so a
 * request is priced by the credential it went out with; without, as the
 * first credential of its order that lists it.
 */
interface ModelRegistryService {
  readonly get: (
    modelId: string,
    credential?: CredentialReceipt,
  ) => Effect.Effect<Option.Option<Model>, ProviderAuthError, ExtensionRegistry>
  /**
   * `credential` with the moment its stored credential was signed in
   * (`AuthInfo.signedInAt`), read through the drivers of `registry`, the
   * calling turn's profile: what tells a new sign-in on the slot from the one
   * a cache was written with. As it is for a credential with no stamp, none
   * stored, or a store that fails to read.
   */
  readonly stamp: (
    credential: CredentialReceipt,
    registry: ExtensionRegistryService,
  ) => Effect.Effect<CredentialReceipt>
}

export class ModelRegistry extends Context.Service<ModelRegistry, ModelRegistryService>()(
  "@gent/core/src/runtime/provider/ModelRegistry",
) {
  static Live: Layer.Layer<ModelRegistry, never, Auth | ModelCatalogRecord | ModelCatalogSource> =
    Layer.effect(
      ModelRegistry,
      Effect.gen(function* () {
        const authStore = yield* Auth
        const catalogRecord = yield* ModelCatalogRecord
        const catalogSource = yield* ModelCatalogSource
        return ModelRegistry.of({
          // An alias id reads the model it stands for, as its dispatch resolves it.
          get: (modelId, credential) =>
            servedModelCatalog(Option.fromUndefinedOr(credential)).pipe(
              Effect.provideService(Auth, authStore),
              Effect.provideService(ModelCatalogRecord, catalogRecord),
              Effect.provideService(ModelCatalogSource, catalogSource),
              Effect.map(({ served, models }) => {
                const current = currentModelId(served.catalog, served.modelDrivers, modelId)
                return Option.fromUndefinedOr(models.find((model) => model.id === current))
              }),
            ),
          stamp: (credential, registry) => stampCredential(authStore, credential, registry),
        })
      }),
    )

  /**
   * The registry a scripted model (`ScriptedLanguageModel`) runs on: the
   * catalog's entry when the catalog lists the id (its window, prices and
   * cache lifetime), else an entry made up from the id with
   * `SCRIPTED_MODEL_CONTEXT_LIMIT_TOKENS`. A scripted turn sends nothing to a
   * provider, so it runs with no catalog: offline, with none stored.
   */
  static Scripted: Layer.Layer<
    ModelRegistry,
    never,
    Auth | ModelCatalogRecord | ModelCatalogSource
  > = Layer.effect(
    ModelRegistry,
    Effect.gen(function* () {
      const catalog = yield* ModelRegistry
      return ModelRegistry.of({
        get: (modelId, credential) =>
          Effect.map(
            catalog.get(modelId, credential),
            Option.orElse(() =>
              Option.some(madeUpModel(modelId, SCRIPTED_MODEL_CONTEXT_LIMIT_TOKENS, Option.none())),
            ),
          ),
        stamp: catalog.stamp,
      })
    }),
  ).pipe(Layer.provide(ModelRegistry.Live))

  /**
   * A registry of `models`, or, with none, one that knows every id. `pricing`
   * prices each model the second form makes up; without it they are free.
   */
  static Test = (
    models: readonly Model[] = [],
    pricing: Option.Option<ModelPricing> = Option.none(),
  ): Layer.Layer<ModelRegistry> =>
    Layer.succeed(
      ModelRegistry,
      ModelRegistry.of({
        get: (modelId) => {
          const existing = Option.fromUndefinedOr(models.find((model) => model.id === modelId))
          if (Option.isSome(existing)) return Effect.succeedSome(existing.value)
          if (models.length > 0) return Effect.succeedNone
          return Effect.succeedSome(madeUpModel(modelId, TEST_MODEL_CONTEXT_LIMIT_TOKENS, pricing))
        },
        stamp: (credential) => Effect.succeed(credential),
      }),
    )
}

/** `credential` with its stored credential's sign-in stamp, read through `registry`'s drivers. */
const stampCredential = (
  authStore: AuthService,
  credential: CredentialReceipt,
  registry: ExtensionRegistryService,
): Effect.Effect<CredentialReceipt> =>
  Effect.gen(function* () {
    const drivers = registry.getResolved().modelDrivers
    const stored = yield* storedCredential(authStore, drivers, credential.provider, credential.slot)
    const signedInAt = Option.flatMap(stored, (found) =>
      Option.fromUndefinedOr(found.info.signedInAt),
    )
    if (Option.isNone(signedInAt)) return credential
    return { ...credential, signedInAt: signedInAt.value }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("credential.stamp-read-failed").pipe(
        Effect.annotateLogs({ error: error.message }),
        Effect.as(credential),
      ),
    ),
  )

// ── retry ───────────────────────────────────────────────────────────────────

/**
 * The policy of the driver a turn will call, by its effective driver id
 * (`effectiveModelDriver` in `domain/agent.ts`). A driver without a policy,
 * or no driver at all, retries under `DEFAULT_RETRY_POLICY`.
 */
export const driverRetryPolicy = Effect.fn("Retry.driverRetryPolicy")(function* (
  driverId: Option.Option<string>,
) {
  if (Option.isNone(driverId)) return DEFAULT_RETRY_POLICY
  const driver = (yield* ExtensionRegistry).getResolved().modelDrivers.get(driverId.value)
  if (Predicate.isUndefined(driver) || Predicate.isUndefined(driver.retry)) {
    return DEFAULT_RETRY_POLICY
  }
  return driver.retry
})

/**
 * A response's cache writes split by lifetime, as the driver a turn called
 * reads them from its finish part's metadata; empty for a driver that does
 * not split them, or no driver at all.
 */
export const driverCacheWritesByLifetime = Effect.fn("Provider.driverCacheWritesByLifetime")(
  function* (driverId: Option.Option<string>, metadata: Response.ProviderMetadata) {
    if (Option.isNone(driverId)) return []
    const driver = (yield* ExtensionRegistry).getResolved().modelDrivers.get(driverId.value)
    if (Predicate.isUndefined(driver) || Predicate.isUndefined(driver.cacheWritesByLifetime)) {
      return []
    }
    return driver.cacheWritesByLifetime(metadata)
  },
)

type ProviderOrAuthError = ProviderError | ProviderAuthError

/**
 * When a usage limit resets: the time the driver reads from the failure
 * (`RetryPolicy.retryAt`) when it lies further than `maxDelay` from
 * `nowMs`, so no retry inside the cap can clear it. None for any other
 * failure: one the loop retries, or one that names no time.
 */
export const limitResetAt = (
  policy: RetryPolicy,
  error: ProviderError,
  nowMs: number,
): Option.Option<number> =>
  Option.filter(policy.retryAt(error.cause, nowMs), (at) => at - nowMs > policy.maxDelay)

/**
 * Only a transient `ProviderError` is retried; a credential failure escapes.
 * A failure that resets later than `maxDelay` from now (a usage limit that
 * resets in hours) escapes too: no retry inside the cap can succeed. A
 * request the provider accepted can still end with an error event inside the
 * stream; the driver's policy names the wire shapes that count.
 */
const isRetryable = (
  policy: RetryPolicy,
  error: ProviderOrAuthError,
  nowMs: number,
): error is ProviderError => {
  if (!Schema.is(ProviderError)(error)) return false
  if (Option.isSome(limitResetAt(policy, error, nowMs))) return false
  if (AiError.isAiError(error.cause)) return error.cause.isRetryable
  return Schema.is(policy.transientStreamEvent)(error.cause)
}

/**
 * What a retry notice says: a credential failure a driver attached to the
 * `AiError` as its own text (`credentialFailureMessage`: a store that is
 * busy, a token endpoint that is down), with no reason prefix such as
 * `Internal provider error: `; else the provider's reason when an `AiError`
 * carries it (`Rate limit exceeded`), without the SDK's module and method
 * prefix; else the error's own message.
 */
export const retryReason = (error: ProviderError): string => {
  const cause = error.cause
  if (!AiError.isAiError(cause)) return error.message
  return Option.getOrElse(credentialFailureMessage(cause), () => cause.reason.message)
}

/** What a proved credential failure says, by its reason. */
const CREDENTIAL_FAILURE_TEXT: Record<CredentialFailureReason, string> = {
  Unavailable: "has no credential",
  Rejected: "was refused",
  UnsupportedModel: "does not serve this model",
}

/**
 * Why a request's credential failed, when the failure is typed and proved:
 * a credential failure a driver proved (`ProviderAuthError.credentialFailure`
 * or its AiError metadata), an authentication refusal the provider answered
 * over HTTP, an exhausted quota, or a rate limit. Only such a failure moves
 * a turn to the next credential of its order; a rate limit gets there only
 * once the same-credential retries gave up. None for anything else: a
 * network fault, a defect, an overload, any other refusal, or an
 * authentication error with no response behind it.
 */
// oxlint-disable-next-line effect/noUnknownParameters -- Model streams expose provider-specific error values.
export const credentialRefusal = (error: unknown): Option.Option<string> => {
  const proved = credentialFailureReason(error)
  if (Option.isSome(proved)) return Option.some(CREDENTIAL_FAILURE_TEXT[proved.value])
  if (!AiError.isAiError(error)) return Option.none()
  const reason = error.reason
  if (reason._tag === "QuotaExhaustedError") return Option.some("is out of quota")
  if (reason._tag === "RateLimitError") return Option.some("is rate limited")
  if (
    reason._tag === "AuthenticationError" &&
    reason.kind !== "MissingKey" &&
    reason.kind !== "Unknown" &&
    Predicate.isNotUndefined(reason.http?.response)
  ) {
    return Option.some("was refused")
  }
  return Option.none()
}

/** Upper bound of the random spread added to a backoff delay, as a fraction of it. */
const JITTER_FRACTION = 0.25

/**
 * `attempt` counts completed failures; `jitter` is a uniform sample in [0, 1).
 * The time the failure names wins over the backoff; a retried failure's time
 * is within `maxDelay` of `nowMs` (`isRetryable`).
 */
const retryDelay = (
  attempt: number,
  error: ProviderError,
  config: RetryPolicy,
  jitter: number,
  nowMs: number,
): number =>
  Option.match(config.retryAt(error.cause, nowMs), {
    onSome: (at) => Math.max(0, Math.ceil(at - nowMs)),
    onNone: () => {
      const base = config.initialDelay * config.backoffFactor ** attempt
      return Math.min(Math.round(base * (1 + JITTER_FRACTION * jitter)), config.maxDelay)
    },
  })

interface RetryAttemptInfo {
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  readonly error: ProviderError
}

interface RetryProviderCallOptions<R2> {
  readonly onRetry?: (info: RetryAttemptInfo) => Effect.Effect<void, never, R2>
  readonly stop?: Effect.Effect<void>
}

/**
 * Retry a provider call on transient failure under the driver's policy. The
 * attempt fails with its own error; `failureOf` reads the provider failure
 * inside it (a step's request fails with it, a handoff summary's compactor
 * with `ModelCompactionError`), and only that failure decides a retry: none
 * ends the retries. The time the failure names (`RetryPolicy.retryAt`) wins
 * over the backoff; the backoff is capped at `maxDelay`, and a time past it
 * ends the retries. `onRetry` runs before each wait with the delay the
 * schedule will take. `stop` ends a wait early: once it completes, no
 * further attempt runs and the last failure is the result.
 */
export const retryProviderCall =
  <E, R2 = never>(
    config: RetryPolicy,
    failureOf: (error: E) => Option.Option<ProviderOrAuthError>,
    options?: RetryProviderCallOptions<R2>,
  ): (<A, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | R2>) =>
  <A, R>(effect: Effect.Effect<A, E, R>) => {
    // meta.attempt is 1-indexed: 1 after the first failure, 2 after the second.
    const schedule = Schedule.fromStepWithMetadata<E, number, R2, never, never, never>(
      Effect.succeed((meta: Schedule.InputMetadata<E>) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          const failure = failureOf(meta.input)
          if (meta.attempt >= config.maxAttempts || Option.isNone(failure)) {
            return yield* Cause.done(meta.attempt)
          }
          const error = failure.value
          if (!isRetryable(config, error, nowMs)) return yield* Cause.done(meta.attempt)
          const jitter = yield* Random.next
          const delayMs = retryDelay(meta.attempt - 1, error, config, jitter, nowMs)
          if (!Predicate.isUndefined(options?.onRetry)) {
            yield* options.onRetry({
              attempt: meta.attempt,
              maxAttempts: config.maxAttempts,
              delayMs,
              error,
            })
          }
          const stop = options?.stop
          if (Predicate.isUndefined(stop)) {
            return [meta.attempt, Duration.millis(delayMs)] satisfies [number, Duration.Duration]
          }
          // The wait runs here, not in the schedule, so a stop can cut it
          // short instead of holding the caller for the whole delay.
          const stopped = yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as(false)),
            stop.pipe(Effect.as(true)),
          )
          if (stopped) return yield* Cause.done(meta.attempt)
          return [meta.attempt, Duration.zero] satisfies [number, Duration.Duration]
        }),
      ),
    )

    // The schedule alone decides: a failure it does not retry ends it.
    return Effect.retry(effect, { schedule }).pipe(Effect.withSpan("provider.retry"))
  }

// ── scripted-model ──────────────────────────────────────────────────────────

/**
 * Language models that answer from a script instead of a provider.
 *
 * `ScriptedLanguageModel.debug` drives the real agent loop with canned
 * replies (and a deterministic 429 retry budget), or with a multi-step tool
 * turn when the message asks for it (`DEBUG_SCENARIOS`), and `empty` finishes every
 * step with nothing. `Gent.provider.mock()` ships both; the test harness
 * builds its gated and sequenced models from the same stream-part helpers.
 */

type LanguageModelToolMap = Record<string, AiTool.Any>
export type LanguageModelStreamPart<Tools extends LanguageModelToolMap = LanguageModelToolMap> =
  Response.StreamPart<Tools>

let _streamPartIdCounter = 0
const makeStreamPartId = (prefix: string) => `${prefix}-${++_streamPartIdCounter}`

export const textDeltaPart = (
  text: string,
  id = makeStreamPartId("text"),
): LanguageModelStreamPart => Response.makePart("text-delta", { id, delta: text })

/** A model's call of the tool `toolName` names, as a provider sends it: under its wire name. */
export const toolCallPart = (
  toolName: string,
  // oxlint-disable-next-line effect/noUnknownParameters -- Tool arguments enter the Effect AI codec as unknown JSON data.
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): LanguageModelStreamPart =>
  Response.makePart("tool-call", {
    id: options?.toolCallId ?? ToolCallId.make(makeStreamPartId("tool")),
    name: wireToolName(toolName),
    params: input,
    providerExecuted: false,
  })

export const reasoningDeltaPart = (
  text: string,
  id = makeStreamPartId("reasoning"),
): LanguageModelStreamPart => Response.makePart("reasoning-delta", { id, delta: text })

export const finishPart = (params: {
  finishReason: Response.FinishReason
  /** The provider metadata the finish part carries, as a driver's own usage detail. */
  metadata?: Response.ProviderMetadata
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
}): LanguageModelStreamPart =>
  Response.makePart("finish", {
    reason: params.finishReason,
    usage: new Response.Usage({
      inputTokens: {
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        uncached: undefined,
        total: params.usage?.inputTokens,
        cacheRead: params.usage?.cacheReadTokens,
        cacheWrite: params.usage?.cacheWriteTokens,
      },
      outputTokens: {
        total: params.usage?.outputTokens,
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        text: undefined,
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        reasoning: undefined,
      },
    }),
    // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent response in this wire fixture.
    response: undefined,
    metadata: params.metadata ?? {},
  })

const makeEncodingToolkit = <Tools extends Record<string, AiTool.Any>>(
  tools: Tools,
): AiToolkit.WithHandler<Tools> => ({
  tools,
  handle: (name) =>
    Effect.fail(
      AiError.make({
        module: "LanguageModelLayers",
        method: "makeEncodingToolkit.handle",
        reason: new AiError.ToolConfigurationError({
          toolName: String(name),
          description: "language model response encoding does not execute tool handlers",
        }),
      }),
    ),
})

/**
 * The tools a scripted part encodes against: the request's, and the tool a
 * call names when the request did not declare it. A model can call a tool it
 * read about but was not given, and a provider sends that name as it is.
 * A scripted call holds its input as a provider sends it, whatever the
 * model wrote, so it encodes as it is: input the tool's parameters refuse
 * reaches the tool runner, as it does from a provider.
 */
const toolkitForPart = (
  options: ProviderOptions,
  part: LanguageModelStreamPart | Response.Part<LanguageModelToolMap>,
): AiToolkit.WithHandler<LanguageModelToolMap> => {
  const toolsRecord: LanguageModelToolMap = {}
  for (const tool of options.tools) {
    toolsRecord[tool.name] = tool.setParameters(Schema.Unknown)
  }
  if (part.type === "tool-call" && !options.tools.some((tool) => tool.name === part.name)) {
    toolsRecord[part.name] = AiTool.dynamic(part.name, { parameters: Schema.Unknown })
  }
  return makeEncodingToolkit(toolsRecord)
}

const encodePart = (
  options: ProviderOptions,
  part: Response.Part<LanguageModelToolMap>,
): Response.PartEncoded =>
  Schema.encodeUnknownSync(Response.Part(toolkitForPart(options, part)))(part)

const encodeStreamPart = (
  options: ProviderOptions,
  part: LanguageModelStreamPart,
): Response.StreamPartEncoded =>
  Schema.encodeUnknownSync(Response.StreamPart(toolkitForPart(options, part)))(part)

export const aiError = (method: string, message: string) =>
  AiError.make({
    module: "LanguageModelLayers",
    method,
    reason: new AiError.UnknownError({ description: message }),
  })

/**
 * The debug model's injected 429: the rate-limit reason, which core's retry
 * honours like a real provider's. It names a short wait, so a scripted run
 * shows the retry without the default backoff.
 */
const debugRateLimit = (method: string) =>
  AiError.make({
    module: "LanguageModelLayers",
    method,
    reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(1) }),
  })

/** A user message holding it makes the debug model answer with a usage limit. */
const USAGE_LIMIT_PHRASE = "debug usage limit"

/** `debug usage limit 2m`: the reset the message names, in seconds, minutes or hours. */
const USAGE_LIMIT_RESET = /debug usage limit (\d+)([smh])\b/

const usageLimitReset = (text: string): Duration.Duration => {
  const match = Option.fromNullishOr(USAGE_LIMIT_RESET.exec(text))
  if (Option.isNone(match)) return Duration.hours(5)
  const amount = Number(match.value[1])
  if (match.value[2] === "s") return Duration.seconds(amount)
  if (match.value[2] === "m") return Duration.minutes(amount)
  return Duration.hours(amount)
}

/**
 * The debug model's usage limit: a 429 whose limit resets in five hours, or
 * when the message says (`debug usage limit 2m`). Past every retry cap (a
 * reset more than 30 s away), the turn fails at once and names the reset
 * time; a shorter one is retried as any rate limit is.
 */
const debugUsageLimit = (method: string, text: string) =>
  AiError.make({
    module: "LanguageModelLayers",
    method,
    reason: new AiError.RateLimitError({ retryAfter: usageLimitReset(text) }),
  })

const extractLatestUserText = (promptInput: Prompt.RawInput): string => {
  const latest = [...Prompt.make(promptInput).content]
    .reverse()
    .find((message) => message.role === "user")
  if (Predicate.isUndefined(latest)) return ""
  return latest.content
    .filter((part): part is Prompt.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

const retryBudgetFor = (text: string): number => {
  if (text.trim().length === 0) return 0
  const hash = [...text].reduce((total, ch) => total + ch.charCodeAt(0), 0)
  if (hash % 3 === 0) return 2
  if (hash % 2 === 0) return 1
  return 0
}

const buildReply = (latestUserText: string): string =>
  [
    "gent debug response.",
    `Latest user message: ${latestUserText || "(empty)"}.`,
    "This turn is flowing through the real agent loop with a scripted language model.",
  ].join(" ")

/** The stream with `delayMs` before each part; none at 0. */
const paced = <A, E>(stream: Stream.Stream<A, E>, delayMs: number): Stream.Stream<A, E> => {
  if (delayMs <= 0) return stream
  return stream.pipe(
    Stream.flatMap((chunk) =>
      Stream.fromEffect(Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as(chunk))),
    ),
  )
}

/** The plain reply, sentence by sentence; its request writes its prompt to the cache. */
const makeReplyStream = (latestUserText: string, reply: string, delayMs = 0) => {
  const parts = reply.split(/(?<=[.!?])\s+/).filter((chunk) => chunk.length > 0)
  const inputTokens = Math.max(1, Math.ceil(latestUserText.length / 4))
  const stream = Stream.fromIterable([
    ...parts.map((text) => textDeltaPart(`${text} `)),
    finishPart({
      finishReason: "stop",
      usage: {
        inputTokens,
        outputTokens: Math.max(1, Math.ceil(reply.length / 4)),
        cacheWriteTokens: inputTokens,
      },
    }),
  ])
  return paced(stream, delayMs)
}

export const makeLanguageModelLayer = (params: {
  readonly streamText: (
    options: ProviderOptions,
  ) => Stream.Stream<LanguageModelStreamPart, AiError.AiError>
  readonly generateText: (options: ProviderOptions) => Effect.Effect<string, AiError.AiError>
}): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) =>
        params
          .generateText(options)
          .pipe(Effect.map((text) => [encodePart(options, Response.makePart("text", { text }))])),
      streamText: (options) =>
        params.streamText(options).pipe(Stream.map((part) => encodeStreamPart(options, part))),
    }),
  )

// ── scripted steps ──────────────────────────────────────────────────────────

/** One model step as stream parts: what one `streamText` call emits. */
export interface ScriptedStep {
  readonly parts: ReadonlyArray<LanguageModelStreamPart>
}

let _stepCallIdCounter = 0
const makeStepToolCallId = () => ToolCallId.make(`step-tc-${++_stepCallIdCounter}`)

export const textStep = (text: string): ScriptedStep => ({
  parts: [
    textDeltaPart(text),
    finishPart({
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(text.length / 4)) },
    }),
  ],
})

export const toolCallStep = (
  toolName: string,
  // oxlint-disable-next-line effect/noUnknownParameters -- Tool arguments enter the Effect AI codec as unknown JSON data.
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): ScriptedStep => ({
  parts: [
    toolCallPart(toolName, input, { toolCallId: options?.toolCallId ?? makeStepToolCallId() }),
    finishPart({
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  ],
})

export const multiToolCallStep = (
  ...calls: ReadonlyArray<{ toolName: string; input: unknown; toolCallId?: ToolCallId }>
): ScriptedStep => ({
  parts: [
    ...calls.map((call) =>
      toolCallPart(call.toolName, call.input, {
        toolCallId: call.toolCallId ?? makeStepToolCallId(),
      }),
    ),
    finishPart({
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 20 * calls.length },
    }),
  ],
})

// ── debug tool scenario ─────────────────────────────────────────────────────

/**
 * A user message holding a scenario's phrase plays that scenario's turn.
 *
 * `debug tools` plays six steps that call the real tools in the session's directory. Step 1 writes
 * three files under `gent-debug-tools/` with bash, then the steps read the
 * three at once, grep them, edit one, and run a bash command that exits 2.
 * Each step opens with reasoning; the last answers. The two bash commands
 * sleep, so the run stays open long enough to resize or scroll during it.
 *
 * `debug ask` asks one background question with `ask_user_async`, works on
 * its assumption in a bash step that sleeps, and answers. The sleep keeps
 * the turn open long enough to answer the question while it runs.
 *
 * `debug threads` starts two threads with `thread.start` (one plays `debug
 * tools`, one answers at once), lists them with `thread.list`, and answers.
 * `debug delegate` starts one `delegate` thread with `thread.start` and
 * `notify: "starter"` (it plays `debug tools`) and answers; the thread's
 * round end arrives later as a message.
 * `debug handoff` calls `handoff`; on a yes the new session continues the
 * thread, so the Sessions pane shows one row with two sessions.
 *
 * `debug think` opens each step's reasoning with a bold heading, as a model's
 * summaries do, runs one bash step, then thinks four seconds before it
 * answers, so the live line names the first step's heading while it waits.
 *
 * `debug usage limit` (not a scenario) fails the step with a rate limit that
 * resets in five hours, or when the message says (`debug usage limit 2m`;
 * `debugUsageLimit`), so a scripted run shows the error row that names the
 * reset time, and an auto-resume that fires inside the run.
 *
 * A step calls the tools the request advertises: each op as its own call, or,
 * on a turn narrowed to `cell`, one `cell` call whose code awaits the ops.
 */

const SCENARIO_DIR = "gent-debug-tools"

/** One host tool call of the scenario. */
interface ScenarioOp {
  readonly tool: string
  readonly input: Schema.JsonObject
}

interface ScenarioStep {
  readonly reasoning: string
  /** The ops of a tool step, run together; none on the answer step. */
  readonly ops: ReadonlyArray<ScenarioOp>
  /** How long the step thinks before its first part, as a slow model does; none by default. */
  readonly thinkMs?: number
}

interface Scenario {
  readonly phrase: string
  readonly steps: ReadonlyArray<ScenarioStep>
  readonly answer: string
}

const scenarioFile = (name: string) => `${SCENARIO_DIR}/${name}`

const TOOL_STEPS: ReadonlyArray<ScenarioStep> = [
  {
    reasoning: "Set up a scratch fixture to work on.",
    ops: [
      {
        tool: "bash",
        input: {
          command: [
            `mkdir -p ${SCENARIO_DIR}`,
            `printf 'export const greeting = "hello"\\n// TODO: say goodbye\\n' > ${scenarioFile("a.ts")}`,
            `printf 'export const count = 3\\n' > ${scenarioFile("b.ts")}`,
            `printf '// TODO: wire count into greeting\\nexport {}\\n' > ${scenarioFile("c.ts")}`,
            "sleep 1",
          ].join(" && "),
        },
      },
    ],
  },
  {
    reasoning: "Read the three files together.",
    ops: ["a.ts", "b.ts", "c.ts"].map((name) => ({
      tool: "read",
      input: { path: scenarioFile(name) },
    })),
  },
  {
    reasoning: "Find the open TODOs.",
    ops: [{ tool: "grep", input: { pattern: "TODO", path: SCENARIO_DIR } }],
  },
  {
    reasoning: "Widen the greeting.",
    ops: [
      {
        tool: "edit",
        input: { path: scenarioFile("a.ts"), oldString: '"hello"', newString: '"hello, world"' },
      },
    ],
  },
  {
    reasoning: "Check for the file the TODO wants; it does not exist yet.",
    // `|| exit 2`: a missing file is 2 for GNU ls, 1 for BSD ls (macOS).
    ops: [{ tool: "bash", input: { command: `sleep 2; ls ${scenarioFile("d.ts")} || exit 2` } }],
  },
  { reasoning: "Summarize.", ops: [] },
]

const ASK_STEPS: ReadonlyArray<ScenarioStep> = [
  {
    reasoning: "The backend is the user's call; ask in the background and go on.",
    ops: [
      {
        tool: "ask_user_async",
        input: {
          questions: [
            {
              header: "cache",
              question: "Which cache backend do you want in production?",
              options: [
                { label: "in-memory LRU" },
                { label: "Redis", description: "shared across instances" },
                { label: "SQLite file", description: "survives a restart" },
              ],
              assume: "in-memory LRU",
            },
          ],
        },
      },
    ],
  },
  {
    reasoning: "Wire the assumed cache in meanwhile.",
    ops: [{ tool: "bash", input: { command: "sleep 20; echo cache wired" } }],
  },
  { reasoning: "Summarize.", ops: [] },
]

const THREAD_STEPS: ReadonlyArray<ScenarioStep> = [
  {
    reasoning: "Two jobs apart from this one; each gets a thread of its own.",
    ops: [
      { tool: "thread.start", input: { task: "debug tools", name: "widen the greeting" } },
      {
        tool: "thread.start",
        input: { task: "Draft the release notes.", name: "draft release notes" },
      },
    ],
  },
  { reasoning: "See how they run.", ops: [{ tool: "thread.list", input: {} }] },
  { reasoning: "Summarize.", ops: [] },
]

const DELEGATE_STEPS: ReadonlyArray<ScenarioStep> = [
  {
    reasoning: "The file check is apart from this; a delegate thread does it.",
    // The thread's round holds `debug tools`, so the thread plays that scenario.
    ops: [
      {
        tool: "thread.start",
        input: {
          task: "Check the greeting files (debug tools).",
          agent: "delegate",
          notify: "starter",
        },
      },
    ],
  },
  { reasoning: "Summarize.", ops: [] },
]

const HANDOFF_STEPS: ReadonlyArray<ScenarioStep> = [
  {
    reasoning: "The user asked to hand off.",
    ops: [
      {
        tool: "handoff",
        input: {
          context: `Go on with the greeting in ${scenarioFile("a.ts")}.`,
          reason: "debug handoff",
        },
      },
    ],
  },
  { reasoning: "Summarize.", ops: [] },
]

/** The machine `debug machine` defines: one 45-second command, then its end. */
const SCENARIO_MACHINE = {
  name: "soak",
  threads: {},
  start: "check",
  states: {
    check: { kind: "run", run: "sleep 45", on: { pass: "done", fail: "done" } },
    done: { kind: "final" },
  },
}

const MACHINE_STEPS: ReadonlyArray<ScenarioStep> = [
  {
    reasoning: "A slow check runs apart from this turn; a machine runs it.",
    ops: [{ tool: "machine.define", input: { definition: SCENARIO_MACHINE } }],
  },
  {
    reasoning: "Start it; it needs no turn of mine.",
    ops: [{ tool: "machine.start", input: { machine: SCENARIO_MACHINE.name } }],
  },
  { reasoning: "Summarize.", ops: [] },
]

// Reasoning as a model's summaries arrive: a bold heading, then prose.
const THINK_STEPS: ReadonlyArray<ScenarioStep> = [
  {
    reasoning: "**Investigating rendering code**\n\nCompare the two chrome paths first.",
    ops: [{ tool: "bash", input: { command: "echo two chrome paths" } }],
  },
  { reasoning: "**Summarizing the findings**\n\nBoth paths draw once.", ops: [], thinkMs: 4_000 },
]

const DEBUG_SCENARIOS: ReadonlyArray<Scenario> = [
  {
    phrase: "debug tools",
    steps: TOOL_STEPS,
    answer: `Read three files in ${SCENARIO_DIR}, found two TODOs, widened the greeting in a.ts. The check for d.ts failed: it does not exist yet.`,
  },
  {
    phrase: "debug ask",
    steps: ASK_STEPS,
    answer:
      "Wired an in-memory LRU cache. The backend question is still open; I assumed in-memory LRU.",
  },
  {
    phrase: "debug threads",
    steps: THREAD_STEPS,
    answer: "Started two threads; the Sessions pane shows them under this session.",
  },
  {
    phrase: "debug delegate",
    steps: DELEGATE_STEPS,
    answer: "Started one child; its result arrives as a message.",
  },
  {
    phrase: "debug handoff",
    steps: HANDOFF_STEPS,
    answer: "Handed off.",
  },
  {
    phrase: "debug machine",
    steps: MACHINE_STEPS,
    answer: "Started the soak machine; its run shows under the status line for 45 s.",
  },
  {
    phrase: "debug think",
    steps: THINK_STEPS,
    answer: "Both chrome paths draw once.",
  },
]

const encodeOpInput = Schema.encodeSync(Schema.fromJsonString(Schema.JsonObject))

/** The `cell` code that awaits a step's ops: one call, or all of them together. */
const cellCode = (ops: ReadonlyArray<ScenarioOp>): string => {
  const calls = ops.map((op) => `tools.${op.tool}(${encodeOpInput(op.input)})`)
  if (calls.length === 1) return `await ${calls[0]}`
  return `await Promise.all([${calls.join(", ")}])`
}

/** Scenario step `index` as the request's tool surface takes it; none past the last. */
const scenarioStep = (
  scenario: Scenario,
  index: number,
  viaCell: boolean,
  callId: (call: number) => ToolCallId,
): Option.Option<ScriptedStep> =>
  Option.map(Option.fromUndefinedOr(scenario.steps[index]), ({ reasoning, ops }) => {
    let scripted = textStep(scenario.answer)
    if (viaCell && ops.length > 0) {
      scripted = toolCallStep("cell", { code: cellCode(ops) }, { toolCallId: callId(0) })
    } else if (ops.length > 0) {
      scripted = multiToolCallStep(
        ...ops.map((op, call) => ({
          toolName: op.tool,
          input: op.input,
          toolCallId: callId(call),
        })),
      )
    }
    return { parts: [reasoningDeltaPart(reasoning), ...scripted.parts] }
  })

/** The steps the prompt already holds since its latest user message: one assistant message each. */
const stepsSinceLatestUser = (promptInput: Prompt.RawInput): number => {
  const content = Prompt.make(promptInput).content
  let count = 0
  for (let i = content.length - 1; i >= 0; i--) {
    const message = content[i]
    if (message?.role === "user") break
    if (message?.role === "assistant") count++
  }
  return count
}

/**
 * The step's usage, as a provider that caches explicitly reports it: the
 * first step writes the prompt to the cache, a later one reads it. The cache
 * timer counts from a request that reported cache activity.
 */
const withCacheUsage = (step: ScriptedStep, index: number, inputTokens: number): ScriptedStep => ({
  parts: step.parts.map((part) => {
    if (part.type !== "finish") return part
    let cacheWriteTokens = inputTokens
    let cacheReadTokens = 0
    if (index > 0) {
      cacheWriteTokens = 0
      cacheReadTokens = inputTokens
    }
    return finishPart({
      finishReason: part.reason,
      usage: {
        inputTokens,
        outputTokens: part.usage.outputTokens.total ?? 1,
        cacheWriteTokens,
        cacheReadTokens,
      },
    })
  }),
})

const scenarioStream = (
  scenario: Scenario,
  options: ProviderOptions,
  latestUserText: string,
  delayMs: number,
) =>
  Effect.gen(function* () {
    const index = stepsSinceLatestUser(options.prompt)
    const advertised = new Set(options.tools.map((tool) => tool.name))
    const viaCell = advertised.has("cell") && !advertised.has("read")
    // Ids unique across runs: a resumed session may already hold an earlier run's.
    const run = (yield* Clock.currentTimeMillis).toString(36)
    const step = scenarioStep(scenario, index, viaCell, (call) =>
      ToolCallId.make(`debug-${run}-${index}-${call}`),
    )
    const inputTokens = Math.max(1, Math.ceil(latestUserText.length / 4))
    const thinkMs = scenario.steps[index]?.thinkMs ?? 0
    return Option.match(step, {
      // Past the last step the turn is over; answer as the plain debug reply does.
      onNone: () => makeReplyStream(latestUserText, buildReply(latestUserText), delayMs),
      onSome: (scripted) =>
        Stream.fromEffect(Effect.sleep(Duration.millis(thinkMs))).pipe(
          Stream.drain,
          Stream.concat(
            paced(Stream.fromIterable(withCacheUsage(scripted, index, inputTokens).parts), delayMs),
          ),
        ),
    })
  })

const debug = (options?: { delayMs?: number; retries?: boolean }) => {
  const delayMs = options?.delayMs ?? 0
  const retries = options?.retries ?? delayMs === 0
  const attempts = new Map<string, number>()

  return makeLanguageModelLayer({
    streamText: (modelOptions) =>
      Effect.suspend(() => {
        const latestUserText = extractLatestUserText(modelOptions.prompt)
        const lowered = latestUserText.toLowerCase()
        if (lowered.includes(USAGE_LIMIT_PHRASE)) {
          return Effect.fail(debugUsageLimit("Debug.streamText", lowered))
        }
        const scenario = Option.fromUndefinedOr(
          DEBUG_SCENARIOS.find((entry) => latestUserText.toLowerCase().includes(entry.phrase)),
        )
        if (Option.isSome(scenario)) {
          return scenarioStream(scenario.value, modelOptions, latestUserText, delayMs)
        }
        const seen = attempts.get(latestUserText) ?? 0
        let retryBudget = 0
        if (retries) retryBudget = retryBudgetFor(latestUserText)

        if (seen < retryBudget) {
          attempts.set(latestUserText, seen + 1)
          return Effect.fail(debugRateLimit("Debug.streamText"))
        }

        attempts.delete(latestUserText)
        return Effect.succeed(makeReplyStream(latestUserText, buildReply(latestUserText), delayMs))
      }).pipe(Stream.unwrap),
    generateText: () => Effect.succeed("debug scenario"),
  })
}

/**
 * A model that finishes every step having produced nothing — no text, no
 * tool calls. Real providers are trained not to do this on request, so a
 * live prompt cannot reproduce the unanswered turn; this layer can, in a
 * real process, through `Gent.provider.mock({ empty: true })`.
 */
const emptyLayer = makeLanguageModelLayer({
  streamText: () =>
    Stream.make(finishPart({ finishReason: "stop", usage: { inputTokens: 1, outputTokens: 0 } })),
  generateText: () => Effect.succeed(""),
})

export const ScriptedLanguageModel = {
  debug,
  /**
   * The model a headless run on a scripted server names when the caller
   * names none: the scripted model answers every id, and gent ships no
   * default model (`NoModelError`).
   */
  modelId: ModelId.make("scripted/debug"),
  get empty() {
    return emptyLayer
  },
}
