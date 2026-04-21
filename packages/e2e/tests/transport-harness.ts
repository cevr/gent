import { Effect } from "effect"
import { afterAll } from "bun:test"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import {
  baseLocalLayer as _baseLocalLayer,
  baseLocalLayerWithProvider as _baseLocalLayerWithProvider,
  type InProcessLayerConfig,
} from "@gent/core/test-utils/in-process-layer.js"
import { Provider, type SignalProviderControls } from "@gent/core/providers/provider.js"
import { AllBuiltinAgents } from "@gent/extensions/all-agents.js"
import { GitReader } from "@gent/extensions/librarian/git-reader.js"
import { Gent, type GentClientBundle } from "@gent/sdk"
import { createWorkerEnv } from "./seam-fixture"
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
          const { layer, controls } = yield* Provider.Signal(reply)
          const bundle = yield* Gent.test(baseLocalLayerWithProvider(layer))
          return yield* assertion(bundle, controls)
        }),
      ),
    ),
})

// ---------------------------------------------------------------------------
// Shared worker — one process per provider mode, reused across all tests
// in a single test file. Killed in afterAll to prevent process leaks.
// ---------------------------------------------------------------------------

interface SharedWorker {
  url: string
  pid: number
  proc: Bun.Subprocess
  root: string
}

const sharedWorkers = new Map<string, Promise<SharedWorker>>()

const findOpenPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")))
        return
      }
      const { port } = address
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })

const resolveServerEntry = async () => {
  const serverEntry = path.resolve(repoRoot, "apps/server/src/main.ts")
  const bunPath = Bun.which("bun") ?? process.execPath
  return { runtimePath: bunPath, serverEntryPath: serverEntry }
}

const startSharedWorker = async (providerMode: HarnessProviderMode): Promise<SharedWorker> => {
  const port = await findOpenPort()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gent-shared-worker-"))
  const launch = await resolveServerEntry()
  const env = {
    ...Bun.env,
    ...createWorkerEnv(root, { providerMode }),
    GENT_PORT: String(port),
    GENT_SERVER_MODE: "worker",
    GENT_TRACE_ID: `shared-worker-${Bun.randomUUIDv7()}`,
    GENT_PERSISTENCE_MODE: "memory",
  }

  const proc = Bun.spawn([launch.runtimePath, launch.serverEntryPath], {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  })

  // Wait for GENT_WORKER_READY
  await new Promise<void>((resolve, reject) => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      void reader.cancel()
      try {
        process.kill(proc.pid, "SIGTERM")
      } catch {
        /* */
      }
      reject(new Error(`shared worker did not start within 20s (port ${port})`))
    }, 20_000)

    void proc.exited.then(() => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`worker exited before ready (code ${proc.exitCode})`))
    })

    const readLoop = (): void => {
      void reader
        .read()
        .then(({ done, value }) => {
          if (settled) return
          if (done) {
            settled = true
            clearTimeout(timeout)
            reject(new Error("worker stdout closed before ready"))
            return
          }
          buffer += decoder.decode(value, { stream: true })
          if (buffer.includes("GENT_WORKER_READY")) {
            settled = true
            clearTimeout(timeout)
            void reader.cancel().catch(() => undefined)
            resolve()
          } else {
            readLoop()
          }
        })
        .catch((err) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          reject(err)
        })
    }
    readLoop()
  })

  const url = `http://127.0.0.1:${port}/rpc`
  return { url, pid: proc.pid, proc, root }
}

const getOrStartWorker = (providerMode: HarnessProviderMode): Promise<SharedWorker> => {
  const existing = sharedWorkers.get(providerMode)
  if (existing !== undefined) return existing
  const promise = startSharedWorker(providerMode)
  sharedWorkers.set(providerMode, promise)
  return promise
}

const killAllWorkers = () => {
  for (const [, promise] of sharedWorkers) {
    promise
      .then((w) => {
        try {
          process.kill(w.pid, "SIGTERM")
        } catch {
          /* */
        }
        try {
          fs.rmSync(w.root, { recursive: true, force: true })
        } catch {
          /* */
        }
      })
      .catch(() => undefined)
  }
  sharedWorkers.clear()
}

// Kill workers when this bun test run finishes + on process exit as safety net
afterAll(killAllWorkers)
process.on("exit", killAllWorkers)

const WORKER_TIMEOUT = "25 seconds"

const makeWorkerCase = (providerMode: HarnessProviderMode = "debug-scripted"): TransportCase => ({
  name: "worker-http",
  run: async (assertion) => {
    const worker = await getOrStartWorker(providerMode)
    return Effect.runPromise(
      Effect.scoped(
        Gent.client({ url: worker.url }).pipe(
          Effect.mapError((e) => new Error(e.message)),
          Effect.tap((bundle) => bundle.runtime.lifecycle.waitForReady),
          Effect.flatMap(assertion),
          Effect.timeoutOrElse({
            duration: WORKER_TIMEOUT,
            orElse: () => Effect.fail(new Error("worker-http assertion timed out (scope cleanup)")),
          }),
        ),
      ),
    )
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
