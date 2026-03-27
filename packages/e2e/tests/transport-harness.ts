import { Effect } from "effect"
import * as path from "node:path"
import { baseLocalLayer } from "@gent/core/test-utils/in-process-layer.js"
import { Gent, type GentClient } from "@gent/sdk"
import {
  createTempDirFixture,
  createWorkerEnv,
  registerWorkerCleanup,
  startWorkerWithClient,
} from "./seam-fixture"
export { waitFor } from "./seam-fixture"
export {
  baseLocalLayer,
  baseLocalLayerWithProvider,
} from "@gent/core/test-utils/in-process-layer.js"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-transport-worker-")
registerWorkerCleanup()

export interface TransportCase {
  readonly name: string
  readonly run: <A>(assertion: (client: GentClient) => Effect.Effect<A, Error>) => Promise<A>
}

type HarnessProviderMode = "debug-scripted" | "debug-slow"

const makeDirectCase = (providerMode: HarnessProviderMode = "debug-scripted"): TransportCase => ({
  name: "direct",
  run: (assertion) =>
    Effect.runPromise(
      Effect.scoped(Gent.test(baseLocalLayer(providerMode)).pipe(Effect.flatMap(assertion))),
    ),
})

const makeWorkerCase = (providerMode: HarnessProviderMode = "debug-scripted"): TransportCase => {
  return {
    name: "worker-http",
    run: (assertion) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const root = makeTempDir()
            const client = yield* startWorkerWithClient({
              cwd: repoRoot,
              startupTimeoutMs: 20_000,
              env: createWorkerEnv(root, { providerMode }),
            })
            return yield* assertion(client)
          }),
        ),
      ),
  }
}

const makeTransportCases = (providerMode: HarnessProviderMode = "debug-scripted") => [
  makeDirectCase(providerMode),
  makeWorkerCase(providerMode),
]

export const transportCases = makeTransportCases()
export const slowTransportCases = makeTransportCases("debug-slow")
export const queueTransportCases = [makeDirectCase("debug-slow"), makeWorkerCase("debug-slow")]
