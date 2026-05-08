import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { Auth, AuthOauth, type AuthService } from "../domain/auth.js"
import {
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderHints,
  type ProviderResolution,
} from "../domain/driver.js"
import type { AgentName } from "../domain/agent.js"
import { parseModelId, type ModelId } from "../domain/model.js"
import { ProviderError } from "../domain/provider-error.js"
import {
  DriverRegistry,
  type DriverRegistryService,
} from "../runtime/extensions/driver-registry.js"

export interface ResolveModelRequest {
  readonly modelId: ModelId | string
  readonly agentName?: AgentName
  readonly hints?: ProviderHints
  /**
   * Per-turn driver registry override. Used when a session profile supplies
   * cwd-scoped drivers.
   */
  readonly driverRegistry?: DriverRegistryService
  /** Per-agent model driver override from `agent.driver`. */
  readonly driverId?: string
}

export const CurrentResolveModelAssertion = Context.Reference<
  ((request: ResolveModelRequest) => Effect.Effect<void, ProviderError>) | undefined
>("@gent/core/src/providers/model-resolver/CurrentResolveModelAssertion", {
  defaultValue: () => undefined,
})

export interface ModelResolverService {
  readonly resolve: (
    request: ResolveModelRequest,
  ) => Effect.Effect<LanguageModel.Service, ProviderError | ProviderAuthError, Scope.Scope>
}

export const resolveProviderModel = Effect.fn("ModelResolver.resolveProviderModel")(function* (
  authStore: AuthService,
  defaultRegistry: DriverRegistryService,
  request: ResolveModelRequest,
) {
  const parsed = parseModelId(request.modelId)
  if (parsed === undefined) {
    return yield* new ProviderError({
      message: "Invalid model id (expected provider/model)",
      model: request.modelId,
    })
  }
  const [parsedProviderName, modelName] = parsed
  const providerName = request.driverId ?? parsedProviderName
  const driverRegistry = request.driverRegistry ?? defaultRegistry

  const extensionProvider = yield* driverRegistry.getModel(providerName)
  if (extensionProvider === undefined) {
    return yield* new ProviderError({
      message: `Unknown provider: ${providerName}`,
      model: request.modelId,
    })
  }

  const authInfo = yield* authStore.get(providerName).pipe(
    Effect.mapError(
      (e) =>
        new ProviderError({
          message: `Failed to read auth for provider "${providerName}"`,
          model: request.modelId,
          cause: e,
        }),
    ),
  )
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
          .pipe(
            Effect.mapError(
              (e) =>
                new ProviderAuthError({
                  message: `Failed to persist refreshed auth for provider "${providerName}"`,
                  cause: e,
                }),
            ),
          ),
    }
  }

  return yield* Effect.try({
    try: (): ProviderResolution =>
      extensionProvider.resolveModel(modelName, authParam, request.hints),
    catch: (e): ProviderError | ProviderAuthError => {
      if (Schema.is(ProviderAuthError)(e)) return e
      return new ProviderError({
        message: `Extension provider "${providerName}" failed: ${e instanceof Error ? e.message : String(e)}`,
        model: request.modelId,
        cause: e,
      })
    },
  })
})

export class ModelResolver extends Context.Service<ModelResolver, ModelResolverService>()(
  "@gent/core/src/providers/model-resolver/ModelResolver",
) {
  static fromLanguageModel = (
    layer: Layer.Layer<LanguageModel.LanguageModel>,
  ): Layer.Layer<ModelResolver> =>
    Layer.effect(
      ModelResolver,
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel
        const assertRequest = yield* CurrentResolveModelAssertion
        return {
          resolve: (request) =>
            Effect.gen(function* () {
              if (assertRequest !== undefined) yield* assertRequest(request)
              return model
            }),
        }
      }),
    ).pipe(Layer.provide(layer))

  static Live: Layer.Layer<ModelResolver, never, Auth | DriverRegistry> = Layer.effect(
    ModelResolver,
    Effect.gen(function* () {
      const authStore = yield* Auth
      const registry = yield* DriverRegistry

      return {
        resolve: (request) =>
          Effect.gen(function* () {
            const resolved = yield* resolveProviderModel(authStore, registry, request)
            const scope = yield* Effect.scope
            const context = yield* Layer.buildWithScope(resolved, scope)
            return Context.get(context, LanguageModel.LanguageModel)
          }),
      } satisfies ModelResolverService
    }),
  )
}
