import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  baseLocalLayer as _baseLocalLayer,
  baseLocalLayerWithProvider as _baseLocalLayerWithProvider,
  type InProcessLayerConfig,
} from "@gent/core/test-utils/in-process-layer.js"
import { createSignalProvider, type SignalProviderControls } from "@gent/core/debug/provider.js"
import { AllBuiltinAgents } from "@gent/extensions/all-agents.js"
import { GitReader } from "@gent/extensions/librarian/git-reader.js"
import { Gent, type GentClientBundle } from "@gent/sdk"
import { createWorkerEnv, startWorkerWithClient } from "./seam-fixture"
export { waitFor } from "./seam-fixture"

const defaultConfig: InProcessLayerConfig = {
  agents: AllBuiltinAgents,
  extraLayers: [GitReader.Test],
}
type HarnessProviderMode = "debug-scripted" | "debug-slow"
export const baseLocalLayer = (providerMode: HarnessProviderMode = "debug-scripted") =>
  _baseLocalLayer(defaultConfig, providerMode)
export const baseLocalLayerWithProvider = (
  providerLayer: Parameters<typeof _baseLocalLayerWithProvider>[0],
) => _baseLocalLayerWithProvider(providerLayer, defaultConfig)

const repoRoot = path.resolve(import.meta.dir, "../../..")

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
      controls: SignalProviderControls,
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
          const { layer, controls } = yield* createSignalProvider(reply)
          const bundle = yield* Gent.test(baseLocalLayerWithProvider(layer))
          return yield* assertion(bundle, controls)
        }),
      ),
    ),
})

const WORKER_TIMEOUT = "25 seconds"

const makeWorkerCase = (providerMode: HarnessProviderMode = "debug-scripted"): TransportCase => ({
  name: "worker-http",
  run: async (assertion) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gent-worker-http-"))
    try {
      return await Effect.runPromise(
        Effect.scoped(
          startWorkerWithClient({
            cwd: repoRoot,
            env: createWorkerEnv(root, { providerMode }),
          }).pipe(
            Effect.mapError((e) => new Error(e.message)),
            Effect.flatMap(assertion),
            Effect.timeoutOrElse({
              duration: WORKER_TIMEOUT,
              orElse: () =>
                Effect.fail(new Error("worker-http assertion timed out (scope cleanup)")),
            }),
          ),
        ),
      )
    } finally {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* */
      }
    }
  },
})

const makeTransportCases = (providerMode: HarnessProviderMode = "debug-scripted") => [
  makeDirectCase(providerMode),
  makeWorkerCase(providerMode),
]

export const transportCases = makeTransportCases()
// Lifecycle/queue assertions need streams paused mid-flight. Signal provider
// gates each chunk on a Queue — the test releases chunks via controls.emitAll()
// after observing the desired state, instead of paying real wall-clock per chunk.
// Direct-only: the worker subprocess can't share a controls handle with the test.
export const directSignalCase = makeDirectSignalCase()
