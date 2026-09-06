import { Context, Effect, Layer, Option, Predicate, Schema, type Scope } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { Auth, AuthOauth } from "../domain/auth.js"
import { ProviderAuthError, type ProviderAuthInfo, type ProviderHints } from "../domain/driver.js"
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
  // oxlint-disable-next-line effect/noNullish -- The optional assertion is test-only instrumentation at this service boundary.
  ((request: ResolveModelRequest) => Effect.Effect<void, ProviderError>) | undefined
>("@gent/core/src/providers/model-resolver/CurrentResolveModelAssertion", {
  // oxlint-disable-next-line effect/noNullish -- The optional assertion is test-only instrumentation.
  defaultValue: () => undefined,
})

export interface ModelResolverService {
  readonly resolve: (
    request: ResolveModelRequest,
  ) => Effect.Effect<LanguageModel.Service, ProviderError | ProviderAuthError, Scope.Scope>
}

const resolveModelDefect = (
  // oxlint-disable-next-line effect/noUnknownParameters -- Provider factories can defect with any thrown value.
  defect: unknown,
  providerName: string,
  modelId: ModelId | string,
): ProviderError | ProviderAuthError => {
  if (Schema.is(ProviderAuthError)(defect)) return defect
  let detail = String(defect)
  if (Predicate.isError(defect)) detail = defect.message
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
  let providerName: string = parsedProviderName
  if (!Predicate.isUndefined(request.driverId)) providerName = request.driverId
  const authStore = yield* Auth
  const defaultRegistry = yield* DriverRegistry
  let driverRegistry = defaultRegistry
  if (!Predicate.isUndefined(request.driverRegistry)) driverRegistry = request.driverRegistry

  const extensionProvider = yield* driverRegistry.getModel(providerName)
  if (Predicate.isUndefined(extensionProvider)) {
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
    Effect.map(Option.fromUndefinedOr),
  )
  let authParam: Option.Option<ProviderAuthInfo> = Option.none()
  if (Option.isSome(authInfo) && authInfo.value.type === "api") {
    authParam = Option.some({ type: "api", key: authInfo.value.key })
  } else if (Option.isSome(authInfo) && authInfo.value.type === "oauth") {
    authParam = Option.some({
      type: "oauth",
      access: authInfo.value.access,
      refresh: authInfo.value.refresh,
      expires: authInfo.value.expires,
      accountId: authInfo.value.accountId,
      persist: (updated) =>
        authStore
          .set(
            providerName,
            AuthOauth.make({
              type: "oauth",
              access: updated.access,
              refresh: updated.refresh,
              expires: updated.expires,
              accountId: updated.accountId,
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
    })
  }

  return yield* Effect.suspend(() =>
    extensionProvider.resolveModel(modelName, Option.getOrUndefined(authParam), request.hints),
  ).pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(resolveModelDefect(defect, providerName, request.modelId)),
    ),
  )
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
        return ModelResolver.of({
          resolve: (request) =>
            Effect.gen(function* () {
              if (!Predicate.isUndefined(assertRequest)) yield* assertRequest(request)
              return model
            }),
        })
      }),
    ).pipe(Layer.provide(layer))

  static Live: Layer.Layer<ModelResolver, never, Auth | DriverRegistry> = Layer.effect(
    ModelResolver,
    Effect.gen(function* () {
      const context = yield* Effect.context<Auth | DriverRegistry>()
      return ModelResolver.of({
        resolve: (request) =>
          Effect.gen(function* () {
            const resolved = yield* resolveProviderModel(request)
            const scope = yield* Effect.scope
            const built = yield* Layer.buildWithScope(resolved, scope)
            return Context.get(built, LanguageModel.LanguageModel)
          }).pipe(Effect.provideContext(context)),
      })
    }),
  )
}
