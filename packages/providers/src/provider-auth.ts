import { Context, Effect, Layer, Ref, Schema } from "effect"
import {
  AuthApi,
  AuthAuthorization,
  AuthMethod,
  AuthOauth,
  AuthStore,
  SUPPORTED_PROVIDERS,
  type AuthAuthorizationMethod,
  type AuthStoreService,
  type ProviderId,
} from "@gent/core"
import { authorizeOpenAI } from "./oauth/openai-oauth"

export class ProviderAuthError extends Schema.TaggedError<ProviderAuthError>()(
  "ProviderAuthError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

type AuthResult =
  | { type: "api"; key: string }
  | { type: "oauth"; access: string; refresh: string; expires: number; accountId?: string }
  | { type: "failed" }

type PendingCallback = (code?: string) => Effect.Effect<AuthResult, ProviderAuthError>

type AuthorizationInput = {
  url: string
  method: AuthAuthorizationMethod
  instructions?: string
}

export interface ProviderAuthProvider {
  readonly methods: ReadonlyArray<typeof AuthMethod.Type>
  readonly authorize: (
    index: number,
  ) => Effect.Effect<
    { authorization: AuthorizationInput; callback: PendingCallback } | undefined,
    ProviderAuthError
  >
}

const buildProviders = (): Record<ProviderId, ProviderAuthProvider> => {
  const methodsDefault = [new AuthMethod({ type: "api", label: "Manually enter API key" })]

  const openaiMethods = [
    new AuthMethod({ type: "oauth", label: "ChatGPT Pro/Plus" }),
    new AuthMethod({ type: "api", label: "Manually enter API key" }),
  ]

  return {
    anthropic: { methods: methodsDefault, authorize: () => Effect.succeed(undefined) },
    openai: {
      methods: openaiMethods,
      authorize: (index) =>
        Effect.tryPromise({
          try: async () => {
            if (index !== 0) return undefined
            const { authorization, callback } = await authorizeOpenAI()
            return {
              authorization,
              callback: (code?: string) =>
                Effect.tryPromise({
                  try: async () => callback(code),
                  catch: (e) =>
                    new ProviderAuthError({
                      message: "OpenAI OAuth callback failed",
                      cause: e,
                    }),
                }),
            }
          },
          catch: (e) =>
            new ProviderAuthError({
              message: "OpenAI OAuth authorize failed",
              cause: e,
            }),
        }),
    },
    bedrock: { methods: methodsDefault, authorize: () => Effect.succeed(undefined) },
    google: { methods: methodsDefault, authorize: () => Effect.succeed(undefined) },
    mistral: { methods: methodsDefault, authorize: () => Effect.succeed(undefined) },
  } as const
}

export interface ProviderAuthService {
  readonly listMethods: () => Effect.Effect<Record<string, ReadonlyArray<typeof AuthMethod.Type>>>
  readonly authorize: (
    sessionId: string,
    provider: ProviderId,
    method: number,
  ) => Effect.Effect<typeof AuthAuthorization.Type | undefined, ProviderAuthError>
  readonly callback: (
    sessionId: string,
    provider: ProviderId,
    method: number,
    authorizationId: string,
    code?: string,
  ) => Effect.Effect<void, ProviderAuthError>
}

export class ProviderAuth extends Context.Tag("@gent/providers/src/provider-auth/ProviderAuth")<
  ProviderAuth,
  ProviderAuthService
>() {
  static Live: Layer.Layer<ProviderAuth, never, AuthStore> = Layer.effect(
    ProviderAuth,
    Effect.gen(function* () {
      const authStore = yield* AuthStore
      return yield* makeProviderAuth(authStore, buildProviders())
    }),
  )

  static Test = (
    providers: Record<ProviderId, ProviderAuthProvider>,
  ): Layer.Layer<ProviderAuth, never, AuthStore> =>
    Layer.effect(
      ProviderAuth,
      Effect.gen(function* () {
        const authStore = yield* AuthStore
        return yield* makeProviderAuth(authStore, providers)
      }),
    )
}

const makeProviderAuth = (
  authStore: AuthStoreService,
  providers: Record<ProviderId, ProviderAuthProvider>,
): Effect.Effect<ProviderAuthService, never> =>
  Effect.gen(function* () {
    const pending = yield* Ref.make<Map<string, PendingCallback>>(new Map())

    const listMethods = Effect.fn("ProviderAuth.listMethods")(() =>
      Effect.sync(() => {
        const result: Record<string, ReadonlyArray<typeof AuthMethod.Type>> = {}
        for (const provider of SUPPORTED_PROVIDERS) {
          const entry = providers[provider.id as ProviderId]
          result[provider.id] = entry?.methods ?? [
            new AuthMethod({ type: "api", label: "Manually enter API key" }),
          ]
        }
        return result
      }),
    )

    const authorize = Effect.fn("ProviderAuth.authorize")(function* (
      sessionId: string,
      provider: ProviderId,
      method: number,
    ) {
      const entry = providers[provider]
      if (entry === undefined) {
        return yield* new ProviderAuthError({
          message: `Unknown provider: ${provider}`,
        })
      }
      const auth = yield* entry.authorize(method)
      if (auth === undefined) return undefined

      const authorizationId = Bun.randomUUIDv7()
      const key = `${sessionId}:${provider}:${method}:${authorizationId}`
      yield* Ref.update(pending, (map) => {
        const next = new Map(map)
        next.set(key, auth.callback)
        return next
      })

      return new AuthAuthorization({
        authorizationId,
        url: auth.authorization.url,
        method: auth.authorization.method,
        ...(auth.authorization.instructions !== undefined
          ? { instructions: auth.authorization.instructions }
          : {}),
      })
    })

    const callback = Effect.fn("ProviderAuth.callback")(function* (
      sessionId: string,
      provider: ProviderId,
      method: number,
      authorizationId: string,
      code?: string,
    ) {
      const key = `${sessionId}:${provider}:${method}:${authorizationId}`
      const map = yield* Ref.get(pending)
      const cb = map.get(key)
      if (cb === undefined) {
        return yield* new ProviderAuthError({
          message: `Missing pending OAuth for ${provider}`,
        })
      }

      yield* Ref.update(pending, (current) => {
        const next = new Map(current)
        next.delete(key)
        return next
      })

      const result = yield* cb(code)
      if (result.type === "failed") {
        return yield* new ProviderAuthError({ message: "OAuth failed" })
      }

      if (result.type === "api") {
        yield* authStore.set(provider, new AuthApi({ type: "api", key: result.key })).pipe(
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: "Failed to store API key",
                cause: e,
              }),
          ),
        )
        return
      }

      yield* authStore
        .set(
          provider,
          new AuthOauth({
            type: "oauth",
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
            ...(result.accountId !== undefined && result.accountId.length > 0
              ? { accountId: result.accountId }
              : {}),
          }),
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: "Failed to store OAuth credentials",
                cause: e,
              }),
          ),
        )
    })

    return ProviderAuth.of({
      listMethods,
      authorize,
      callback,
    })
  })
