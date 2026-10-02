import { Effect, Layer, Option, Redacted, Schema } from "effect"
import type { HttpClient } from "effect/http"
import type { DecisionModel } from "effect/ai"
import {
  AuthMethod,
  type CatalogModel,
  defineExtension,
  ExtensionHost,
  type ModelDriverContribution,
  modelFromCatalog,
  ProviderAuthError,
} from "@gent/core/extensions/api"
import { apiKeyFrom, ModelHttpClient, readOptionalEnv } from "./providers.js"

// Test seam: only tests read buildTypeSafeModelDriver, which lets a test run
// the driver against a fake fetch.

/**
 * TypeSafe's classifier models (Jev): typed answers to classify, rate and
 * probability questions, the cell's `models.decide`. They run no turn. The
 * driver posts to TypeSafe itself; the OpenCode and Cloudflare drivers reuse
 * `typeSafeDecisionModel` for the decision models models.dev lists under them.
 *
 * Docs: docs.typesafe.ai and `@effect/ai-typesafe` (read 2026-10-01).
 */

// ── decision model ──────────────────────────────────────────────────────────

/** Where a Jev request goes and how it is signed. */
interface DecisionEndpoint {
  readonly apiKey: string
  /** The API root; the client posts to `${apiUrl}/systemone`. */
  readonly apiUrl: string
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient
}

/**
 * A Jev model as an Effect AI `DecisionModel`, on the host's `fetch`. The SDK
 * loads when the layer builds, not at launch.
 */
export const typeSafeDecisionModel = (
  model: string,
  endpoint: DecisionEndpoint,
): Layer.Layer<DecisionModel.DecisionModel> =>
  Layer.unwrap(
    Effect.map(
      // oxlint-disable-next-line effect/noDynamicImports -- the SDK loads at the first decision model build, not at launch
      Effect.promise(() => import("@effect/ai-typesafe")),
      ({ TypeSafeClient, TypeSafeDecisionModel }) =>
        TypeSafeDecisionModel.layer({ model }).pipe(
          Layer.provide(
            TypeSafeClient.layer({
              apiKey: Redacted.make(endpoint.apiKey),
              apiUrl: endpoint.apiUrl,
              transformClient: endpoint.transformClient,
            }),
          ),
          Layer.provide(ModelHttpClient),
        ),
    ),
  )

// ── driver ──────────────────────────────────────────────────────────────────

const DRIVER_ID = "typesafe"
const ENV_CREDENTIAL = "TYPESAFE_API_KEY"
const API_URL = "https://api.typesafe.ai/v1"

/**
 * The model ids `@effect/ai-typesafe` names (`TypeSafeDecisionModel.Model`),
 * as the TypeSafe docs list them. models.dev lists Jev only under gateways
 * (OpenCode Zen, nano-gpt, vivgrid), never TypeSafe's own API, so the driver
 * keeps these local entries in the catalog's shape. A cell that names no
 * model and has a TypeSafe key gets `jev-latest`: core's default picks a
 * `-latest` model in any position.
 */
const CLASSIFIERS: ReadonlyArray<CatalogModel> = [
  { id: "jev-latest", name: "Jev (latest)", decision: true },
  { id: "jev-preview", name: "Jev (preview)", decision: true },
  { id: "jev-1.13.0", name: "Jev 1.13.0", decision: true },
]

/** A chat turn asked for a model of a driver that serves only classifiers. */
class ClassifierOnlyDriver extends Schema.TaggedError<ClassifierOnlyDriver>(
  "@gent/extensions/src/typesafe/ClassifierOnlyDriver",
)("ClassifierOnlyDriver", {
  message: Schema.String,
}) {}

/** The TypeSafe driver. `envApiKey` is `TYPESAFE_API_KEY`, read at setup; a stored key wins over it. */
export const buildTypeSafeModelDriver = (
  envApiKey: Option.Option<string>,
): ModelDriverContribution => ({
  id: DRIVER_ID,
  name: "TypeSafe",
  envCredential: ENV_CREDENTIAL,
  resolveModel: (modelName) =>
    Effect.die(
      new ClassifierOnlyDriver({
        message: `${DRIVER_ID}/${modelName} is a classifier model: it runs no turn; a cell asks it with models.decide`,
      }),
    ),
  resolveDecisionModel: (modelName, authInfo) =>
    Effect.gen(function* () {
      const apiKey = apiKeyFrom(Option.fromNullishOr(authInfo), envApiKey)
      if (Option.isNone(apiKey)) {
        return yield* new ProviderAuthError({
          message: `TypeSafe credentials unavailable: no stored API key and no ${ENV_CREDENTIAL} env var`,
        })
      }
      return typeSafeDecisionModel(modelName, { apiKey: apiKey.value, apiUrl: API_URL })
    }),
  listModels: () => Effect.succeed(CLASSIFIERS.map((entry) => modelFromCatalog(DRIVER_ID, entry))),
  auth: {
    methods: [AuthMethod.make({ type: "api", label: "TypeSafe API key" })],
  },
})

export const TypeSafeExtension = defineExtension({
  id: "@gent/provider-typesafe",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    const envApiKey = yield* readOptionalEnv(ENV_CREDENTIAL)
    yield* host.register("modelDriver", buildTypeSafeModelDriver(envApiKey))
  }),
})
