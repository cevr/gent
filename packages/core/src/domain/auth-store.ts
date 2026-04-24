import { Context, Effect, Layer, Schema } from "effect"
import { AuthStorage } from "./auth-storage"
import { TaggedEnumClass } from "./schema-tagged-enum-class"

// Auth info — `_tag` is the substrate discriminator; the legacy `type:`
// payload field is preserved on each variant for backward compatibility
// with auth files written before the substrate migration.

export const AuthInfo = TaggedEnumClass("AuthInfo", {
  AuthApi: {
    type: Schema.Literal("api"),
    key: Schema.String,
  },
  AuthOauth: {
    type: Schema.Literal("oauth"),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
    accountId: Schema.optional(Schema.String),
  },
})
export type AuthInfo = Schema.Schema.Type<typeof AuthInfo>

export const AuthApi = AuthInfo.AuthApi
export type AuthApi = typeof AuthInfo.AuthApi.Type
export const AuthOauth = AuthInfo.AuthOauth
export type AuthOauth = typeof AuthInfo.AuthOauth.Type

export const AuthType = Schema.Literals(["api", "oauth"])
export type AuthType = typeof AuthType.Type

const LegacyAuthInfo = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("api"),
    key: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
    accountId: Schema.optional(Schema.String),
  }),
])
type LegacyAuthInfo = typeof LegacyAuthInfo.Type

const fromLegacyAuthInfo = (info: LegacyAuthInfo): AuthInfo =>
  info.type === "api"
    ? new AuthApi({ type: "api", key: info.key })
    : new AuthOauth({
        type: "oauth",
        access: info.access,
        refresh: info.refresh,
        expires: info.expires,
        ...(info.accountId !== undefined ? { accountId: info.accountId } : {}),
      })

// Auth store error

export class AuthStoreError extends Schema.TaggedErrorClass<AuthStoreError>()("AuthStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// Auth store service

export interface AuthStoreService {
  readonly get: (provider: string) => Effect.Effect<AuthInfo | undefined, AuthStoreError>
  readonly set: (provider: string, info: AuthInfo) => Effect.Effect<void, AuthStoreError>
  readonly remove: (provider: string) => Effect.Effect<void, AuthStoreError>
  readonly list: () => Effect.Effect<ReadonlyArray<string>, AuthStoreError>
  readonly listInfo: () => Effect.Effect<Record<string, AuthInfo>, AuthStoreError>
}

export class AuthStore extends Context.Service<AuthStore, AuthStoreService>()(
  "@gent/core/src/domain/auth-store/AuthStore",
) {
  static Live: Layer.Layer<AuthStore, never, AuthStorage> = Layer.effect(
    AuthStore,
    Effect.gen(function* () {
      const storage = yield* AuthStorage
      const AuthInfoJson = Schema.fromJsonString(AuthInfo)
      const LegacyAuthInfoJson = Schema.fromJsonString(LegacyAuthInfo)
      const UnknownJson = Schema.fromJsonString(Schema.Unknown)

      const decode = (raw: string): Effect.Effect<AuthInfo, AuthStoreError> =>
        Effect.gen(function* () {
          const current = yield* Effect.exit(Schema.decodeUnknownEffect(AuthInfoJson)(raw))
          if (current._tag === "Success") return current.value

          const legacy = yield* Effect.exit(Schema.decodeUnknownEffect(LegacyAuthInfoJson)(raw))
          if (legacy._tag === "Success") return fromLegacyAuthInfo(legacy.value)

          const parsedJson = yield* Effect.exit(Schema.decodeUnknownEffect(UnknownJson)(raw))
          if (parsedJson._tag === "Success") {
            return yield* new AuthStoreError({
              message: "Failed to decode auth info",
              cause: legacy.cause,
            })
          }

          return new AuthApi({ type: "api", key: raw })
        }).pipe(
          Effect.mapError((e) =>
            Schema.is(AuthStoreError)(e)
              ? e
              : new AuthStoreError({
                  message: "Failed to decode auth info",
                  cause: e,
                }),
          ),
        )

      const encode = (info: AuthInfo): Effect.Effect<string, AuthStoreError> =>
        Schema.encodeEffect(AuthInfoJson)(info).pipe(
          Effect.mapError(
            (e) =>
              new AuthStoreError({
                message: "Failed to encode auth info",
                cause: e,
              }),
          ),
        )

      return AuthStore.of({
        get: (provider) =>
          storage.get(provider).pipe(
            Effect.catchEager(() => Effect.sync(() => undefined as string | undefined)),
            Effect.flatMap((raw) =>
              raw !== undefined && raw.length > 0
                ? decode(raw)
                : Effect.sync(() => undefined as AuthInfo | undefined),
            ),
            Effect.withSpan("AuthStore.get"),
          ),

        set: (provider, info) =>
          encode(info).pipe(
            Effect.flatMap((raw) => storage.set(provider, raw)),
            Effect.mapError((e) =>
              Schema.is(AuthStoreError)(e)
                ? e
                : new AuthStoreError({ message: "Failed to persist auth info", cause: e }),
            ),
            Effect.withSpan("AuthStore.set"),
          ),

        remove: (provider) =>
          storage.delete(provider).pipe(
            Effect.mapError(
              (e) =>
                new AuthStoreError({
                  message: "Failed to remove auth info",
                  cause: e,
                }),
            ),
            Effect.withSpan("AuthStore.remove"),
          ),

        list: () =>
          storage.list().pipe(
            Effect.catchEager(() => Effect.succeed([])),
            Effect.withSpan("AuthStore.list"),
          ),

        listInfo: () =>
          storage.list().pipe(
            Effect.catchEager(() => Effect.succeed([] as readonly string[])),
            Effect.flatMap((providers) =>
              Effect.forEach(
                providers,
                (provider) =>
                  storage.get(provider).pipe(
                    Effect.catchEager(() => Effect.sync(() => undefined as string | undefined)),
                    Effect.flatMap((raw) =>
                      raw !== undefined && raw.length > 0
                        ? decode(raw).pipe(Effect.map((info) => [provider, info] as const))
                        : Effect.succeed(null),
                    ),
                  ),
                { concurrency: "unbounded" },
              ),
            ),
            Effect.map((entries) =>
              entries.reduce(
                (acc, entry) => {
                  if (entry !== null) acc[entry[0]] = entry[1]
                  return acc
                },
                {} as Record<string, AuthInfo>,
              ),
            ),
            Effect.withSpan("AuthStore.listInfo"),
          ),
      })
    }),
  )
}
