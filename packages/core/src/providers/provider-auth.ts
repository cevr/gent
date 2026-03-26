import { ServiceMap, Effect, Layer, Ref, Schema } from "effect"
import { AuthApi, AuthOauth, AuthStore } from "../domain/auth-store.js"
import {
  AuthMethod,
  AuthAuthorization,
  type AuthAuthorizationMethod,
} from "../domain/auth-method.js"
import { SUPPORTED_PROVIDERS } from "../domain/model.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../runtime/extensions/registry.js"
import { authorizeOpenAI } from "./oauth/openai-oauth"
import { readClaudeCodeCredentials, refreshClaudeCodeCredentials } from "./oauth/anthropic-keychain"

export class ProviderAuthError extends Schema.TaggedErrorClass<ProviderAuthError>()(
  "ProviderAuthError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
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

const buildProviders = (
  setAuth: (provider: string, auth: AuthOauth) => Effect.Effect<void, ProviderAuthError>,
): Record<string, ProviderAuthProvider> => {
  const methodsDefault = [new AuthMethod({ type: "api", label: "Manually enter API key" })]

  const openaiMethods = [
    new AuthMethod({ type: "oauth", label: "ChatGPT Pro/Plus" }),
    new AuthMethod({ type: "api", label: "Manually enter API key" }),
  ]

  const anthropicMethods = [
    new AuthMethod({ type: "oauth", label: "Claude Code" }),
    new AuthMethod({ type: "api", label: "Manually enter API key" }),
  ]

  return {
    anthropic: {
      methods: anthropicMethods,
      authorize: (index) =>
        Effect.gen(function* () {
          if (index !== 0) return undefined
          let creds = yield* readClaudeCodeCredentials()
          if (creds.expiresAt < Date.now() + 60_000) {
            yield* refreshClaudeCodeCredentials().pipe(Effect.catchEager(() => Effect.void))
            creds = yield* readClaudeCodeCredentials()
          }
          yield* setAuth(
            "anthropic",
            new AuthOauth({
              type: "oauth",
              access: creds.accessToken,
              refresh: creds.refreshToken,
              expires: creds.expiresAt,
            }),
          )
          return {
            authorization: {
              url: "" as string,
              method: "done" as const,
            },
            callback: () =>
              Effect.succeed({
                type: "oauth" as const,
                access: creds.accessToken,
                refresh: creds.refreshToken,
                expires: creds.expiresAt,
              }),
          }
        }).pipe(
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: `Claude Code keychain: ${e instanceof Error ? e.message : String(e)}`,
                cause: e,
              }),
          ),
        ),
    },
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
    bedrock: {
      methods: methodsDefault,
      authorize: () =>
        Effect.sync(
          () =>
            undefined as
              | {
                  authorization: AuthorizationInput
                  callback: PendingCallback
                }
              | undefined,
        ),
    },
    google: {
      methods: methodsDefault,
      authorize: () =>
        Effect.sync(
          () =>
            undefined as
              | {
                  authorization: AuthorizationInput
                  callback: PendingCallback
                }
              | undefined,
        ),
    },
    mistral: {
      methods: methodsDefault,
      authorize: () =>
        Effect.sync(
          () =>
            undefined as
              | {
                  authorization: AuthorizationInput
                  callback: PendingCallback
                }
              | undefined,
        ),
    },
  } as const
}

export interface ProviderAuthService {
  readonly listMethods: () => Effect.Effect<Record<string, ReadonlyArray<typeof AuthMethod.Type>>>
  readonly authorize: (
    sessionId: string,
    provider: string,
    method: number,
  ) => Effect.Effect<typeof AuthAuthorization.Type | undefined, ProviderAuthError>
  readonly callback: (
    sessionId: string,
    provider: string,
    method: number,
    authorizationId: string,
    code?: string,
  ) => Effect.Effect<void, ProviderAuthError>
}

export class ProviderAuth extends ServiceMap.Service<ProviderAuth, ProviderAuthService>()(
  "@gent/core/src/providers/provider-auth/ProviderAuth",
) {
  static Live: Layer.Layer<ProviderAuth, never, AuthStore | ExtensionRegistry> = Layer.effect(
    ProviderAuth,
    Effect.gen(function* () {
      const authStore = yield* AuthStore
      const extensionRegistry = yield* ExtensionRegistry
      const setOauth = (provider: string, auth: AuthOauth) =>
        authStore.set(provider, auth).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAuthError({
                message: "Failed to store OAuth credentials",
                cause,
              }),
          ),
        )
      return yield* makeProviderAuth(buildProviders(setOauth), extensionRegistry)
    }),
  )

  static Test = (
    providers: Record<string, ProviderAuthProvider>,
  ): Layer.Layer<ProviderAuth, never, AuthStore> =>
    Layer.effect(
      ProviderAuth,
      Effect.gen(function* () {
        yield* AuthStore
        return yield* makeProviderAuth(providers, undefined)
      }),
    )
}

const makeProviderAuth = (
  providers: Record<string, ProviderAuthProvider>,
  extensionRegistry: ExtensionRegistryService | undefined,
): Effect.Effect<ProviderAuthService, never, AuthStore> =>
  Effect.gen(function* () {
    const authStore = yield* AuthStore
    const pending = yield* Ref.make<Map<string, PendingCallback>>(new Map())

    const listMethods = Effect.fn("ProviderAuth.listMethods")(function* () {
      const result: Record<string, ReadonlyArray<typeof AuthMethod.Type>> = {}

      if (extensionRegistry !== undefined) {
        // Derive from extension-registered providers
        const registeredProviders = yield* extensionRegistry.listProviders()
        for (const provider of registeredProviders) {
          if (provider.auth !== undefined && provider.auth.methods.length > 0) {
            result[provider.id] = provider.auth.methods
          } else {
            // Legacy fallback for providers registered without auth config
            const entry = providers[provider.id]
            result[provider.id] = entry?.methods ?? [
              new AuthMethod({ type: "api", label: "Manually enter API key" }),
            ]
          }
        }
      } else {
        // Test/fallback: use hardcoded provider list
        for (const provider of SUPPORTED_PROVIDERS) {
          const entry = providers[provider.id]
          result[provider.id] = entry?.methods ?? [
            new AuthMethod({ type: "api", label: "Manually enter API key" }),
          ]
        }
      }

      return result
    })

    const authorize = Effect.fn("ProviderAuth.authorize")(function* (
      sessionId: string,
      provider: string,
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
      provider: string,
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
