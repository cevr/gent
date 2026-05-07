import { Effect, Schema, type Config, type Layer } from "effect"
import {
  baseLocalLayer as _baseLocalLayer,
  baseLocalLayerWithProvider as _baseLocalLayerWithProvider,
  type InProcessLayerConfig,
} from "@gent/core/test-utils/in-process-layer.js"
import {
  LanguageModelLayers,
  type SignalLanguageModelControls,
} from "@gent/core/test-utils/language-model.js"
import type { StorageError } from "@gent/core/storage/sqlite-storage.js"
import { AllBuiltinAgents } from "@gent/extensions/all-agents.js"
import { GitReader } from "@gent/extensions/librarian/git-reader.js"
import { Gent, type GentClientBundle, type RpcHandlersContext } from "@gent/sdk"
export { waitFor } from "./seam-fixture"

export class TestFailure extends Schema.TaggedErrorClass<TestFailure>()(
  "@gent/e2e/tests/TestFailure",
  { message: Schema.String },
) {}

export const toTestFailure = (error: unknown) =>
  new TestFailure({ message: error instanceof Error ? error.message : String(error) })

const defaultConfig: InProcessLayerConfig = {
  agents: AllBuiltinAgents,
  extraLayers: [GitReader.Test],
}
type HarnessProviderMode = "debug-scripted" | "debug-slow"
type HarnessLayerError = Config.ConfigError | StorageError
export const baseLocalLayer = (providerMode: HarnessProviderMode = "debug-scripted") =>
  _baseLocalLayer(defaultConfig, providerMode) satisfies Layer.Layer<
    RpcHandlersContext,
    HarnessLayerError
  >
export const baseLocalLayerWithProvider = (
  providerLayer: Parameters<typeof _baseLocalLayerWithProvider>[0],
) =>
  _baseLocalLayerWithProvider(providerLayer, defaultConfig) satisfies Layer.Layer<
    RpcHandlersContext,
    HarnessLayerError
  >

export interface TransportCase {
  readonly name: string
  readonly run: <A>(assertion: (bundle: GentClientBundle) => Effect.Effect<A, Error>) => Promise<A>
}

export interface SignalTransportCase {
  readonly name: string
  readonly run: <A>(
    reply: string,
    assertion: (
      bundle: GentClientBundle,
      controls: SignalLanguageModelControls,
    ) => Effect.Effect<A, Error>,
  ) => Promise<A>
}

const makeDirectCase = (providerMode: HarnessProviderMode = "debug-scripted"): TransportCase => ({
  name: "direct",
  run: (assertion) =>
    Effect.runPromise(
      Effect.scoped(Gent.test(baseLocalLayer(providerMode)).pipe(Effect.flatMap(assertion))),
    ),
})

const makeDirectSignalCase = (): SignalTransportCase => ({
  name: "direct",
  run: (reply, assertion) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer, controls } = yield* LanguageModelLayers.signal(reply)
          const bundle = yield* Gent.test(baseLocalLayerWithProvider(layer))
          return yield* assertion(bundle, controls)
        }),
      ),
    ),
})

const makeTransportCases = (providerMode: HarnessProviderMode = "debug-scripted") => [
  makeDirectCase(providerMode),
]

export const transportCases = makeTransportCases()
// Lifecycle/queue assertions need streams paused mid-flight. Signal provider
// gates each chunk on a Queue — the test releases chunks via controls.emitAll()
// after observing the desired state, instead of paying real wall-clock per chunk.
// Direct-only: the worker subprocess can't share a controls handle with the test.
export const directSignalCase = makeDirectSignalCase()
