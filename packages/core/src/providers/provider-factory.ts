import { ServiceMap, Effect, Layer, Schema } from "effect"
import type { LanguageModel } from "ai"
import { AuthOauth, AuthStore, type AuthInfo } from "../domain/auth-store.js"
import type { ProviderAuthInfo } from "../domain/extension.js"
import { BUILTIN_PROVIDER_IDS } from "../domain/model.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { ProviderError } from "./provider"

// Provider info for listing
export class ProviderInfo extends Schema.Class<ProviderInfo>("ProviderInfo")({
  id: Schema.String,
  name: Schema.String,
  isCustom: Schema.Boolean,
}) {}

// Service interface
export interface ProviderFactoryService {
  /** Get a language model by full model ID (provider/model-name) */
  readonly getModel: (modelId: string) => Effect.Effect<LanguageModel, ProviderError>
  /** List all available providers */
  readonly listProviders: () => Effect.Effect<readonly ProviderInfo[]>
}

// Test auth storage (no-op)
const testAuthStorage = {
  get: () => Effect.sync(() => undefined as AuthInfo | undefined),
  set: () => Effect.void,
  remove: () => Effect.void,
  list: () => Effect.succeed([] as ReadonlyArray<string>),
  listInfo: () => Effect.succeed({} as Record<string, AuthInfo>),
}

// Parse model ID into provider and model name
const parseModelId = (modelId: string): [string, string] | undefined => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return undefined
  return [modelId.slice(0, slash), modelId.slice(slash + 1)]
}

// Service tag
export class ProviderFactory extends ServiceMap.Service<ProviderFactory, ProviderFactoryService>()(
  "@gent/core/src/providers/provider-factory/ProviderFactory",
) {
  static Live: Layer.Layer<ProviderFactory, never, AuthStore | ExtensionRegistry> = Layer.effect(
    ProviderFactory,
    makeProviderFactory(),
  )

  static Test: Layer.Layer<ProviderFactory> = Layer.provide(
    Layer.effect(ProviderFactory, makeProviderFactory()),
    Layer.merge(Layer.succeed(AuthStore, testAuthStorage), ExtensionRegistry.Test()),
  )
}

// Factory implementation — all dispatch through ExtensionRegistry
function makeProviderFactory(): Effect.Effect<
  ProviderFactoryService,
  never,
  AuthStore | ExtensionRegistry
> {
  return Effect.gen(function* () {
    const authStore = yield* AuthStore
    const extensionRegistry = yield* ExtensionRegistry
    const resolveAuthFromStore = (providerName: string) =>
      authStore
        .get(providerName)
        .pipe(Effect.catchEager(() => Effect.sync(() => undefined as AuthInfo | undefined)))

    return {
      getModel: Effect.fn("ProviderFactory.getModel")(function* (modelId: string) {
        const parsed = parseModelId(modelId)
        if (parsed === undefined) {
          return yield* new ProviderError({
            message: "Invalid model id (expected provider/model)",
            model: modelId,
          })
        }
        const [providerName, modelName] = parsed
        const services = yield* Effect.services<never>()

        const extensionProvider = yield* extensionRegistry.getProvider(providerName)
        if (extensionProvider === undefined) {
          return yield* new ProviderError({
            message: `Unknown provider: ${providerName}`,
            model: modelId,
          })
        }

        // Build auth context from stored credentials
        const authInfo = yield* resolveAuthFromStore(providerName)
        let authParam: ProviderAuthInfo | undefined
        if (authInfo?.type === "api") {
          authParam = { type: "api", key: authInfo.key }
        } else if (authInfo?.type === "oauth") {
          authParam = {
            type: "oauth",
            access: authInfo.access,
            refresh: authInfo.refresh,
            expires: authInfo.expires,
            accountId: authInfo.accountId,
            persist: (updated) =>
              Effect.runPromiseWith(services)(
                authStore
                  .set(
                    providerName,
                    new AuthOauth({
                      type: "oauth",
                      access: updated.access,
                      refresh: updated.refresh,
                      expires: updated.expires,
                      ...(updated.accountId !== undefined ? { accountId: updated.accountId } : {}),
                    }),
                  )
                  .pipe(Effect.catchEager(() => Effect.void)),
              ),
          }
        }

        return yield* Effect.try({
          try: () => extensionProvider.resolveModel(modelName, authParam) as LanguageModel,
          catch: (e) =>
            new ProviderError({
              message: `Extension provider "${providerName}" failed: ${e instanceof Error ? e.message : String(e)}`,
              model: modelId,
            }),
        })
      }),

      listProviders: () =>
        extensionRegistry.listProviders().pipe(
          Effect.map((extProviders) =>
            extProviders.map(
              (p) =>
                new ProviderInfo({
                  id: p.id,
                  name: p.name,
                  isCustom: !BUILTIN_PROVIDER_IDS.has(p.id),
                }),
            ),
          ),
        ),
    }
  })
}
