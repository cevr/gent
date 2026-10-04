import {
  Array as Arr,
  Cause,
  Clock,
  Config,
  Context,
  Duration,
  Effect,
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
  Scope,
  Semaphore,
  Stream,
  Struct,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Database } from "bun:sqlite"
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
import { SessionId, ToolCallId } from "../domain/ids.js"
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
  type PersistAuth,
  ProviderAuthError,
  ProviderAuthInfo,
  type ProviderHints,
  type ProviderResolution,
  type RetryPolicy,
  type StoredOAuthCredentials,
  type VirtualModel,
} from "../domain/driver.js"
import { GentPlatform, writeFileAtomic } from "./gent-platform.js"
import type { ProviderConfig, ProviderConfigEntry } from "./config.js"
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

export class AuthAuthorization extends Schema.Class<AuthAuthorization>("AuthAuthorization")({
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
 * - `Oauth` — refreshable bearer token + expiry; driver may rotate.
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
  },
  Oauth: {
    type: Schema.Literal("oauth"),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Finite,
    accountId: Schema.optional(Schema.String),
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

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A stored entry that does not decode: a corrupt file, or one an older writer tore. */
class AuthEntryInvalid extends Schema.TaggedError<AuthEntryInvalid>()("AuthEntryInvalid", {
  cause: Schema.Defect(),
}) {}

/** The raw store under `serializeAuthStore`; it neither locks nor discards. */
interface AuthStoreAccess {
  readonly get: (
    provider: string,
    // oxlint-disable-next-line effect/noNullish -- Auth lookup uses undefined when a provider has no stored credentials.
  ) => Effect.Effect<AuthInfo | undefined, AuthError | AuthEntryInvalid>
  readonly set: (provider: string, info: AuthInfo) => Effect.Effect<void, AuthError>
  readonly remove: (provider: string) => Effect.Effect<void, AuthError>
  /** The provider ids an entry is stored under, decoded or not. */
  readonly list: Effect.Effect<ReadonlyArray<string>, AuthError>
}

export interface AuthService {
  /**
   * The provider ids an entry is stored under: what tells a generic provider
   * with a stored key from the rest without one read per provider.
   */
  readonly list: Effect.Effect<ReadonlyArray<string>, AuthError>
  // oxlint-disable-next-line effect/noNullish -- Auth lookup uses undefined when a provider has no stored credentials.
  readonly get: (provider: string) => Effect.Effect<AuthInfo | undefined, AuthError>
  readonly set: (provider: string, info: AuthInfo) => Effect.Effect<void, AuthError>
  readonly remove: (provider: string) => Effect.Effect<void, AuthError>
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
  ) => Effect.Effect<A, E | AuthError>
}

/** Wraps one provider's store operation in a lock another process also honors. */
type ProviderLock = (
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
  crossProcess: ProviderLock = () => (effect) => effect,
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
  const getOrDiscard = (provider: string) =>
    store.get(provider).pipe(
      Effect.catchTag("AuthEntryInvalid", (invalid) =>
        Effect.logWarning("discarded invalid auth info").pipe(
          Effect.annotateLogs({ provider, cause: String(invalid.cause) }),
          Effect.andThen(store.remove(provider)),
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
  return {
    list: store.list,
    get: (provider) =>
      store
        .get(provider)
        .pipe(
          Effect.catchTag("AuthEntryInvalid", () => exclusive(provider)(getOrDiscard(provider))),
        ),
    set: (provider, info) => exclusive(provider)(store.set(provider, info)),
    remove: (provider) => exclusive(provider)(store.remove(provider)),
    update: (provider, f) =>
      exclusive(provider)(
        Effect.gen(function* () {
          const current = Option.fromUndefinedOr(yield* getOrDiscard(provider))
          const [result, next] = yield* f(current)
          if (Option.isSome(next)) yield* store.set(provider, next.value)
          return result
        }),
      ),
  }
}

// ── auth file lock ──────────────────────────────────────────────────────────

/** SQLite reports a lock another connection holds as `SQLITE_BUSY`. */
const isSqliteBusy = Schema.is(Schema.Struct({ code: Schema.Literal("SQLITE_BUSY") }))

/** Another connection holds the provider's lock file; try again shortly. */
class AuthLockBusy extends Schema.TaggedError<AuthLockBusy>()("AuthLockBusy", {}) {}

/** A writer polls a busy lock this often, this many times (about 30 seconds). */
const AUTH_LOCK_POLL = Duration.millis(20)
const AUTH_LOCK_POLLS = 1500

/**
 * An exclusive SQLite transaction on one lock file per provider. The OS drops
 * the lock when its process exits, so a crash never leaves a held lock (the
 * same kind of lock the server kernel uses). Taking it never blocks the event
 * loop: a busy file is polled.
 */
const fileProviderLock =
  (lockDirectory: string, pathService: Path.Path, fs: FileSystem.FileSystem): ProviderLock =>
  (provider) =>
  (effect) => {
    const file = pathService.join(lockDirectory, `${encodeURIComponent(provider)}.lock.db`)
    const lockError = (cause: unknown) =>
      new AuthError({ message: `Failed to take the auth lock for "${provider}"`, cause })
    const open = Effect.try({
      try: () => new Database(file, { create: true }),
      catch: lockError,
    })
    const take = (db: Database) =>
      Effect.try({
        try: () => {
          db.exec("PRAGMA busy_timeout = 0")
          db.exec("BEGIN EXCLUSIVE")
        },
        catch: (cause) => {
          if (isSqliteBusy(cause)) return new AuthLockBusy()
          return lockError(cause)
        },
      })
    const close = (db: Database) =>
      Effect.sync(() => {
        db.close()
      })
    // One open-and-take attempt is the uninterruptible acquire; the poll
    // between attempts is not, so a cancel ends the wait at once. Only a
    // held lock outlives an interrupt, and its release always runs.
    const attempt = Effect.acquireRelease(
      fs.makeDirectory(lockDirectory, { recursive: true }).pipe(
        Effect.mapError(lockError),
        Effect.andThen(open),
        Effect.flatMap((db) =>
          take(db).pipe(
            Effect.onError(() => close(db)),
            Effect.as(db),
          ),
        ),
      ),
      close,
    )
    const held = attempt.pipe(
      Effect.retry({
        while: (error) => error._tag === "AuthLockBusy",
        schedule: Schedule.spaced(AUTH_LOCK_POLL),
        times: AUTH_LOCK_POLLS,
      }),
      Effect.catchTag("AuthLockBusy", () =>
        Effect.fail(
          new AuthError({ message: `Timed out waiting for the auth lock for "${provider}"` }),
        ),
      ),
    )
    // The held lock lives in a private scope, so `effect` never runs inside
    // it: a scope of the caller's stays the caller's, whatever `effect` needs.
    return Effect.acquireUseRelease(
      Scope.make(),
      (lockScope) => held.pipe(Scope.provide(lockScope), Effect.andThen(effect)),
      (lockScope, exit) => Scope.close(lockScope, exit),
    )
  }

export class Auth extends Context.Service<Auth, AuthService>()(
  "@gent/core/src/runtime/provider/Auth",
) {
  /**
   * File-system-backed live layer. One file per provider (URL-encoded
   * key) under `directory`. Stale or corrupt entries are discarded and
   * logged so a single broken file can't brick startup.
   */
  static Live = (directory: string): Layer.Layer<Auth, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      Auth,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathService = yield* Path.Path
        const codec = Schema.fromJsonString(Schema.toCodecJson(AuthInfo))
        const decode = Schema.decodeEffect(codec)
        const encode = Schema.encodeEffect(codec)
        const wrap = (message: string) => (cause: unknown) => new AuthError({ message, cause })
        const fileOf = (provider: string) =>
          pathService.join(directory, encodeURIComponent(provider))
        // A dot directory inside the store: no provider id starts with a dot,
        // so it never reads as a credential, and it goes with the store.
        const lockDirectory = pathService.join(directory, ".locks")
        return serializeAuthStore(
          {
            get: (provider) =>
              Effect.gen(function* () {
                const text = yield* fs.readFileString(fileOf(provider)).pipe(
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
            set: (provider, info) =>
              encode(info).pipe(
                Effect.tap(() => fs.makeDirectory(directory, { recursive: true })),
                Effect.flatMap((text) => writeFileAtomic(fileOf(provider), text, { mode: 0o600 })),
                Effect.mapError(wrap("Failed to persist auth info")),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, pathService),
              ),
            remove: (provider) =>
              fs
                .remove(fileOf(provider), { force: true })
                .pipe(Effect.mapError(wrap("Failed to remove auth info"))),
            // A dot file (the lock directory, a staged write) is no entry.
            list: fs.readDirectory(directory).pipe(
              Effect.map((names) =>
                names.filter((name) => !name.startsWith(".")).map(decodeURIComponent),
              ),
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed([]),
              ),
              Effect.mapError(wrap("Failed to list auth info")),
            ),
          },
          fileProviderLock(lockDirectory, pathService, fs),
        )
      }),
    )

  /**
   * In-memory test layer. Optionally seeded with a starting record.
   */
  static Test = (initial: Record<string, AuthInfo> = {}): Layer.Layer<Auth> =>
    Layer.sync(Auth)(() => {
      const map = new Map(Object.entries(initial))
      return serializeAuthStore({
        list: Effect.sync(() => [...map.keys()]),
        get: (provider) => Effect.sync(() => map.get(provider)),
        set: (provider, info) =>
          Effect.sync(() => {
            map.set(provider, info)
          }),
        remove: (provider) =>
          Effect.sync(() => {
            map.delete(provider)
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

interface StoredCredential {
  /** The store key the credential sits under. */
  readonly key: string
  readonly info: AuthInfo
}

/** The credential `driverId`'s sign-in has stored; none when no key holds one. */
const storedCredential = Effect.fn("storedCredential")(function* (
  auth: AuthService,
  drivers: ModelDrivers,
  driverId: string,
) {
  for (const key of credentialKeys(drivers, driverId)) {
    const info = yield* auth.get(key)
    if (Predicate.isNotUndefined(info)) return Option.some<StoredCredential>({ key, info })
  }
  return Option.none<StoredCredential>()
})

/** The stored credential `driverId` receives, as a driver sees it. */
const driverAuthInfo = (
  auth: AuthService,
  drivers: ModelDrivers,
  driverId: string,
): Effect.Effect<Option.Option<ProviderAuthInfo>, AuthError> =>
  storedCredential(auth, drivers, driverId).pipe(
    Effect.map(Option.map((found) => toProviderAuthInfo(auth, found.key, found.info))),
  )

/**
 * Sign out of `provider`'s sign-in: remove every credential it reads, in the
 * profile of the `ExtensionRegistry` in context.
 */
export const removeSignIn = Effect.fn("removeSignIn")(function* (provider: string) {
  const auth = yield* Auth
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  for (const key of credentialKeys(modelDrivers, provider)) yield* auth.remove(key)
})

/**
 * Store a credential for `provider`'s sign-in under its owner, in the profile
 * of the `ExtensionRegistry` in context. Reads try the owner's key first, so
 * a key stored under a sharing driver's own id would sit behind it. An API
 * key for a generic provider is stored only when its base URL answers pass
 * the rule a turn applies (`checkBaseUrlAnswers`).
 */
export const storeSignIn = Effect.fn("storeSignIn")(function* (provider: string, info: AuthInfo) {
  const auth = yield* Auth
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  if (info.type === "api" && !modelDrivers.has(provider)) {
    yield* checkBaseUrlAnswers(provider, info)
  }
  yield* auth.set(credentialOwner(modelDrivers, provider), info)
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
 * needs it (the required ones, else the owner) has its own variable set.
 */
export const listAuthProviders = Effect.fn("listAuthProviders")(function* (
  requiredDriverIds: ReadonlyArray<string>,
) {
  const auth = yield* Auth
  const drivers = (yield* servedProfile(auth, requiredDriverIds)).modelDrivers
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
  return providers
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
  })
}

/** Build a PersistAuth callback for a provider — writes credentials to Auth. */
const persistAuthTo =
  (authStore: AuthService, providerId: string): PersistAuth =>
  (auth) =>
    authStore.set(providerId, authValue(auth)).pipe(
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
 * per-provider lock.
 */
const toProviderAuthInfo = (
  authStore: AuthService,
  providerId: string,
  info: AuthInfo,
): ProviderAuthInfo => {
  if (info.type === "api") {
    if (Predicate.isUndefined(info.metadata)) {
      return ProviderAuthInfo.cases.Api.make({ key: info.key })
    }
    return ProviderAuthInfo.cases.Api.make({ key: info.key, metadata: info.metadata })
  }
  return ProviderAuthInfo.cases.Oauth.make({
    update: <A, E>(
      f: (
        stored: Option.Option<StoredOAuthCredentials>,
      ) => Effect.Effect<readonly [A, Option.Option<StoredOAuthCredentials>], E>,
    ) =>
      authStore
        .update(providerId, (current) =>
          Effect.map(
            f(Option.flatMap(current, storedOAuthFields)),
            (pair): readonly [A, Option.Option<AuthInfo>] => [
              pair[0],
              Option.map(pair[1], (fields) => authValue({ type: "oauth", ...fields })),
            ],
          ),
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
  })
}

/** The OAuth fields of a stored credential; none for an API key. */
const storedOAuthFields = (stored: AuthInfo): Option.Option<StoredOAuthCredentials> => {
  if (stored.type !== "oauth") return Option.none()
  const fields = { access: stored.access, refresh: stored.refresh, expires: stored.expires }
  if (Predicate.isUndefined(stored.accountId)) return Option.some(fields)
  return Option.some({ ...fields, accountId: stored.accountId })
}

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

/** Start a driver's login; none when the method completed without a link. */
export const authorizeProvider = Effect.fn("ProviderLogin.authorize")(function* (
  sessionId: SessionId,
  provider: string,
  method: number,
) {
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  const authStore = yield* Auth
  const platform = yield* GentPlatform
  const extProvider = modelDrivers.get(provider)
  if (Predicate.isUndefined(extProvider?.auth?.authorize)) {
    return yield* new ProviderAuthError({
      message: `Provider "${provider}" does not support authorize`,
    })
  }
  const authorizationId = yield* platform.randomId
  const extResult = yield* extProvider.auth
    .authorize({
      sessionId,
      methodIndex: method,
      authorizationId,
      persist: persistAuthTo(authStore, credentialOwner(modelDrivers, provider)),
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
) {
  const { modelDrivers } = (yield* ExtensionRegistry).getResolved()
  const authStore = yield* Auth
  const extProvider = modelDrivers.get(provider)
  // A driver without a callback finished its login in authorize (a "done" method).
  if (Predicate.isUndefined(extProvider?.auth?.callback)) return
  yield* extProvider.auth
    .callback({
      sessionId,
      methodIndex: method,
      authorizationId,
      persist: persistAuthTo(authStore, credentialOwner(modelDrivers, provider)),
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
        const model = modelFromCatalog(driver.id, raw, speaker.efforts)
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
 */
export const listModelCatalog = Effect.fn("ModelCatalog.list")(function* (
  profile: DriverProfile,
  catalog: LoadedModelCatalog,
  resolveAuth?: (
    driverId: string,
  ) => Effect.Effect<Option.Option<ProviderAuthInfo>, ProviderAuthError>,
) {
  const models: Array<Model> = []
  const failures: Array<ModelCatalogFailure> = []
  for (const driver of profile.modelDrivers.values()) {
    if (!listsModels(driver)) continue
    if (Option.isSome(catalog.failure)) {
      failures.push({ driverId: driver.id, error: catalog.failure.value })
    }
    let auth = Option.none<ProviderAuthInfo>()
    if (Predicate.isNotUndefined(resolveAuth)) auth = yield* resolveAuth(driver.id)
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
        failures.push({ driverId: driver.id, error })
        return Effect.logWarning("Model driver catalog failed; its models are skipped").pipe(
          Effect.annotateLogs({ driver: driver.id, error }),
          Effect.as(Option.none<ReadonlyArray<Model>>()),
        )
      }),
    )
    if (Option.isSome(listed)) models.push(...listed.value)
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

/** Whether a generic provider is active: a config entry, a stored key, or a key variable set. */
const genericActive = (
  config: ProviderConfig,
  stored: ReadonlySet<string>,
  catalog: LoadedModelCatalog,
  id: string,
): Effect.Effect<boolean> => {
  if (Object.hasOwn(config.providers ?? {}, id) || stored.has(id)) return Effect.succeed(true)
  return Option.match(catalog.provider(id), {
    onNone: () => Effect.succeed(false),
    onSome: (provider) => Effect.map(firstEnvValue(keyVariables(provider)), Option.isSome),
  })
}

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
  const stored = new Set(
    yield* auth.list.pipe(
      Effect.catch((error) =>
        Effect.logWarning("generic-provider.auth-list-failed").pipe(
          Effect.annotateLogs({ error: error.message }),
          Effect.as<ReadonlyArray<string>>([]),
        ),
      ),
    ),
  )
  const active = yield* Effect.filter(genericCandidates(resolved, config, catalog), (id) => {
    if (alsoActive.includes(id)) return Effect.succeed(true)
    return genericActive(config, stored, catalog, id)
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

  const authParam = yield* driverAuthInfo(authStore, resolved.modelDrivers, providerName).pipe(
    Effect.mapError(
      (e) =>
        new ProviderError({
          message: `Failed to read auth for provider "${providerName}"`,
          model: request.modelId,
          cause: e,
        }),
    ),
  )

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

// ── decision-model-resolver ─────────────────────────────────────────────────

/**
 * Why no classifier model answered: none has a credential (`NoProvider`), the
 * named one is not a classifier the profile's drivers list (`UnknownModel`),
 * or its driver failed to build it (`ProviderFailed`).
 */
class DecisionModelError extends Schema.TaggedError<DecisionModelError>()("DecisionModelError", {
  reason: Schema.Literals(["NoProvider", "UnknownModel", "ProviderFailed"]),
  message: Schema.String,
}) {}

/** A classifier model ready to answer, and the catalog entry it resolved to. */
interface ResolvedDecisionModel {
  readonly modelId: ModelId
  readonly entry: Model
  readonly model: DecisionModel.DecisionModel
}

/** The classifier models of one profile: the drivers of its `ExtensionRegistry`. */
interface ProfileClassifiers {
  /**
   * The named classifier model (`provider/model`), or with none a classifier
   * whose driver has a stored or env credential: a `-latest` alias first,
   * else the first the profile's drivers list.
   */
  readonly resolve: (
    modelId: Option.Option<string>,
  ) => Effect.Effect<ResolvedDecisionModel, DecisionModelError, Scope.Scope>
  /**
   * Whether some driver that serves classifiers (it declares
   * `resolveDecisionModel`) has a stored or env credential, so a call that
   * names no model has one to resolve. It reads no catalog. An auth store
   * that fails to read counts as none.
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

/** The credential `driverId` reads, as a classifier call reports a failed read. */
const classifierAuth = (auth: AuthService, allDrivers: ModelDrivers, driverId: string) =>
  driverAuthInfo(auth, allDrivers, driverId).pipe(
    Effect.mapError(
      (cause) =>
        new DecisionModelError({
          reason: "ProviderFailed",
          message: `Failed to read auth for provider "${driverId}": ${causeMessage(cause)}`,
        }),
    ),
  )

/** The drivers that serve classifiers: each declares `resolveDecisionModel`. */
const classifierDrivers = (allDrivers: ModelDrivers): ModelDrivers =>
  new Map(
    [...allDrivers].filter(([, driver]) => Predicate.isNotUndefined(driver.resolveDecisionModel)),
  )

/**
 * The classifier models the profile's classifier drivers list, and the
 * catalogs that failed; a failed one leaves its models out.
 */
const classifierCatalog = Effect.fn("DecisionModelResolver.catalog")(function* (
  auth: AuthService,
  catalogSource: ModelCatalogSourceService,
  allDrivers: ModelDrivers,
) {
  const drivers = classifierDrivers(allDrivers)
  const source = yield* catalogSource.readWithDecisions
  // A classifier needs no API class: with none, core lists only the decision models.
  const profile: DriverProfile = { modelDrivers: drivers, apiClasses: new Map() }
  const catalog = yield* listModelCatalog(profile, source, (driverId) =>
    classifierAuth(auth, allDrivers, driverId).pipe(
      Effect.mapError((error) => new ProviderAuthError({ message: error.message })),
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
 * Whether some driver that serves classifiers has a stored or env
 * credential. A driver declares `resolveDecisionModel` only when it can
 * serve a classifier, so no catalog is read. A failed read counts as none.
 */
const classifierAvailable = Effect.fn("DecisionModelResolver.hasCredential")(
  function* (auth: AuthService, allDrivers: ModelDrivers) {
    for (const [driverId, driver] of classifierDrivers(allDrivers)) {
      const stored = yield* classifierAuth(auth, allDrivers, driverId)
      if (Option.isSome(stored) || (yield* driverEnvReady(driver))) return true
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

const resolveDecisionModel = Effect.fn("DecisionModelResolver.resolve")(function* (
  auth: AuthService,
  catalogSource: ModelCatalogSourceService,
  allDrivers: ModelDrivers,
  requested: Option.Option<string>,
) {
  const storedAuth = (driverId: string) => classifierAuth(auth, allDrivers, driverId)
  // A call that cannot resolve a classifier names each catalog that failed.
  const { drivers, catalog, classifiers, failures } = yield* classifierCatalog(
    auth,
    catalogSource,
    allDrivers,
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
        const usable = yield* credentialedClassifiers(auth, allDrivers, classifiers)
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
  const authInfo = yield* storedAuth(chosen.driver.id)
  const scope = yield* Effect.scope
  // Resolving, building and reading the driver's model all run driver code:
  // a defect in any of them fails this call, never the cell's host.
  const model = yield* Effect.suspend(() =>
    resolveFor.value(modelName.value, Option.getOrUndefined(authInfo)),
  ).pipe(
    Effect.flatMap((layer) => Layer.buildWithScope(layer, scope)),
    Effect.map((built) => Context.get(built, DecisionModel.DecisionModel)),
    Effect.catchDefect((defect) =>
      Effect.fail(new ProviderAuthError({ message: causeMessage(defect) })),
    ),
    Effect.mapError(
      (error) =>
        new DecisionModelError({
          reason: "ProviderFailed",
          message: `${chosen.model.id}: ${error.message}`,
        }),
    ),
  )
  return { modelId: chosen.model.id, entry: chosen.model, model }
})

/** The classifier entries whose driver has a stored or env credential, in catalog order. */
const credentialedClassifiers = (
  auth: AuthService,
  allDrivers: ModelDrivers,
  classifiers: ReadonlyArray<ClassifierEntry>,
) =>
  Effect.filter(classifiers, (entry) =>
    Effect.gen(function* () {
      const stored = yield* classifierAuth(auth, allDrivers, entry.driver.id)
      const fromEnv = yield* driverEnvReady(entry.driver)
      return Option.isSome(stored) || fromEnv
    }),
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
  allDrivers: ModelDrivers,
) {
  const { classifiers } = yield* classifierCatalog(auth, catalogSource, allDrivers)
  const usable = yield* credentialedClassifiers(auth, allDrivers, classifiers)
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
        profile: Effect.map(ExtensionRegistry, (registry) => {
          const drivers = registry.getResolved().modelDrivers
          return {
            resolve: (modelId) => resolveDecisionModel(auth, catalogSource, drivers, modelId),
            hasCredential: classifierAvailable(auth, drivers),
            usable: usableClassifiers(auth, catalogSource, drivers),
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
      return yield* Effect.gen(function* () {
        const resolved = yield* classifiers.value
          .resolve(Option.fromUndefinedOr(params.model))
          .pipe(
            Effect.mapError((error) => modelsError("decide", `models.decide: ${error.message}`)),
          )
        const response = yield* resolved.model
          .decide(params.definition, { input: params.input })
          .pipe(
            Effect.mapError((error) =>
              modelsError("decide", `models.decide (${resolved.modelId}) failed: ${error.message}`),
            ),
          )
        const usage = omitUndefined({
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        })
        // A price needs both billable counts: a count the reply leaves out, or
        // one no provider bills, leaves the price unknown, never a partial sum.
        const costUsd = Option.all({
          pricing: Option.fromUndefinedOr(resolved.entry.pricing),
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
 * list: the 1M of the default model (Claude Sonnet 5), so a scripted turn
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
 * driver's list over the models.dev catalog core holds, read with the auth
 * stored for that driver, and each active generic provider's. The drivers
 * come from the `ExtensionRegistry` in
 * scope, so a turn reads its own profile's and a server read the requesting
 * session's; a catalog captured once at launch missed every project-scoped
 * driver and ignored `disabledExtensions`.
 */
export const modelCatalog = Effect.fn("ModelRegistry.modelCatalog")(function* () {
  const { models, failures } = yield* servedModelCatalog()
  return { models, failures }
})

/** `modelCatalog`, and the drivers and catalog it was listed from. */
const servedModelCatalog = Effect.fn("ModelRegistry.servedModelCatalog")(function* () {
  const authStore = yield* Auth
  const catalogRecord = yield* ModelCatalogRecord
  const profile = (yield* ExtensionRegistry).getResolved()
  const served = yield* servedProfile(authStore)
  const catalog = yield* listModelCatalog(served, served.catalog, (providerId) =>
    driverAuthInfo(authStore, served.modelDrivers, providerId).pipe(
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

/** One model of the caller's profile catalog: the turn's context limit and pricing. */
interface ModelRegistryService {
  readonly get: (
    modelId: string,
  ) => Effect.Effect<Option.Option<Model>, ProviderAuthError, ExtensionRegistry>
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
          get: (modelId) =>
            servedModelCatalog().pipe(
              Effect.provideService(Auth, authStore),
              Effect.provideService(ModelCatalogRecord, catalogRecord),
              Effect.provideService(ModelCatalogSource, catalogSource),
              Effect.map(({ served, models }) => {
                const current = currentModelId(served.catalog, served.modelDrivers, modelId)
                return Option.fromUndefinedOr(models.find((model) => model.id === current))
              }),
            ),
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
        get: (modelId) =>
          Effect.map(
            catalog.get(modelId),
            Option.orElse(() =>
              Option.some(madeUpModel(modelId, SCRIPTED_MODEL_CONTEXT_LIMIT_TOKENS, Option.none())),
            ),
          ),
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
      }),
    )
}

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
 * What a retry notice says: the provider's reason when an `AiError` carries
 * it (`Rate limit exceeded`), without the SDK's module and method prefix;
 * else the error's own message.
 */
export const retryReason = (error: ProviderError): string => {
  if (AiError.isAiError(error.cause)) return error.cause.reason.message
  return error.message
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

/**
 * Retry a provider call on transient failure under the driver's policy. The
 * time the failure names (`RetryPolicy.retryAt`) wins over the backoff; the
 * backoff is capped at `maxDelay`, and a time past it ends the retries.
 * `onRetry` runs before each wait with the delay the schedule will take.
 * `stop` ends a wait early: once it completes, no further attempt runs and
 * the last failure is the result.
 */
export const retryProviderCall =
  <R2 = never>(
    config: RetryPolicy,
    options?: {
      readonly onRetry?: (info: RetryAttemptInfo) => Effect.Effect<void, never, R2>
      readonly stop?: Effect.Effect<void>
    },
  ): (<A, R>(
    effect: Effect.Effect<A, ProviderOrAuthError, R>,
  ) => Effect.Effect<A, ProviderOrAuthError, R | R2>) =>
  <A, R>(effect: Effect.Effect<A, ProviderOrAuthError, R>) => {
    // meta.attempt is 1-indexed: 1 after the first failure, 2 after the second.
    const schedule = Schedule.fromStepWithMetadata<
      ProviderOrAuthError,
      number,
      R2,
      never,
      never,
      never
    >(
      Effect.succeed((meta: Schedule.InputMetadata<ProviderOrAuthError>) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          const error = meta.input
          if (meta.attempt >= config.maxAttempts || !isRetryable(config, error, nowMs)) {
            return yield* Cause.done(meta.attempt)
          }
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
 */
const toolkitForPart = (
  options: ProviderOptions,
  part: LanguageModelStreamPart | Response.Part<LanguageModelToolMap>,
): AiToolkit.WithHandler<LanguageModelToolMap> => {
  const toolsRecord: LanguageModelToolMap = {}
  for (const tool of options.tools) {
    toolsRecord[tool.name] = tool
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
 * `debug handoff` calls `handoff`; on a yes the new session continues the
 * thread, so the Sessions pane shows one row with two sessions.
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
    ops: [{ tool: "bash", input: { command: `sleep 2; ls ${scenarioFile("d.ts")}` } }],
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
    phrase: "debug handoff",
    steps: HANDOFF_STEPS,
    answer: "Handed off.",
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
    return Option.match(step, {
      // Past the last step the turn is over; answer as the plain debug reply does.
      onNone: () => makeReplyStream(latestUserText, buildReply(latestUserText), delayMs),
      onSome: (scripted) =>
        paced(Stream.fromIterable(withCacheUsage(scripted, index, inputTokens).parts), delayMs),
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
  get empty() {
    return emptyLayer
  },
}
