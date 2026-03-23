import { ServiceMap, Effect, Layer, Schema } from "effect"
import { AuthStorage } from "./auth-storage"

// Auth info

export class AuthApi extends Schema.TaggedClass<AuthApi>()("AuthApi", {
  type: Schema.Literal("api"),
  key: Schema.String,
}) {}

export class AuthOauth extends Schema.TaggedClass<AuthOauth>()("AuthOauth", {
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String),
}) {}

export const AuthInfo = Schema.Union([AuthApi, AuthOauth])
export type AuthInfo = typeof AuthInfo.Type

export const AuthType = Schema.Literals(["api", "oauth"])
export type AuthType = typeof AuthType.Type

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

export class AuthStore extends ServiceMap.Service<AuthStore, AuthStoreService>()(
  "@gent/core/src/domain/auth-store/AuthStore",
) {
  static Live: Layer.Layer<AuthStore, never, AuthStorage> = Layer.effect(
    AuthStore,
    Effect.gen(function* () {
      const storage = yield* AuthStorage
      const AuthInfoJson = Schema.fromJsonString(AuthInfo)

      const decode = (raw: string): Effect.Effect<AuthInfo, AuthStoreError> =>
        Schema.decodeUnknownEffect(AuthInfoJson)(raw).pipe(
          Effect.catchEager(() =>
            Effect.succeed(new AuthApi({ type: "api", key: raw }) as AuthInfo),
          ),
          Effect.mapError(
            (e) =>
              new AuthStoreError({
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
            Effect.catchEager((e) => Effect.logWarning("failed to remove auth key", e)),
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
