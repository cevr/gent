/**
 * Seam fixture — spawns real worker processes for cross-package integration tests.
 * Generic helpers live in @gent/core/test-utils/fixtures.
 */

import { Effect, type Scope } from "effect"
import { Gent, GentConnectionError, type GentClientBundle } from "@gent/sdk"
import { startWorkerSupervisor, type WorkerSupervisorOptions } from "@gent/sdk/supervisor"

// Re-export generic fixtures from core
export { createTempDirFixture, createWorkerEnv, waitFor } from "@gent/core/test-utils/fixtures"

/**
 * Poll until the RPC client can reach the worker after a restart.
 *
 * After supervisor restart, the WebSocket retry loop needs time to
 * reconnect. The RPC client's `currentError` blocks all `send()` calls
 * until `onOpen` fires on the new socket. This helper probes with a
 * cheap RPC until it succeeds.
 */
export const waitForRpcReady = (
  client: { session: { list: () => Effect.Effect<unknown, unknown> } },
  timeoutMs = 10_000,
): Effect.Effect<void, Error> => {
  const deadline = Date.now() + timeoutMs
  const loop: Effect.Effect<void, Error> = Effect.gen(function* () {
    const result = yield* client.session.list().pipe(Effect.exit)
    if (result._tag === "Success") return
    if (Date.now() >= deadline) {
      return yield* Effect.fail(new Error("RPC client did not reconnect after restart"))
    }
    yield* Effect.sleep("50 millis")
    return yield* loop
  })
  return loop
}

// ---------------------------------------------------------------------------
// Worker helpers
// ---------------------------------------------------------------------------

/** Start a worker and return a GentClientBundle. */
export const startWorkerWithClient = (options: {
  cwd: string
  env?: Record<string, string>
  startupTimeoutMs?: number
  mode?: "default" | "debug"
}): Effect.Effect<GentClientBundle, GentConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const supervisor = yield* startWorkerSupervisor(options).pipe(
      Effect.mapError((e) => new GentConnectionError({ message: e.message })),
    )
    return yield* Gent.client({ url: supervisor.url })
  })

/** Start a raw supervisor — for tests that need lifecycle assertions. */
export const startWorkerWithSupervisor = (options: WorkerSupervisorOptions) =>
  Effect.gen(function* () {
    const supervisor = yield* startWorkerSupervisor(options)
    const bundle = yield* Gent.client({ url: supervisor.url })
    return { ...supervisor, ...bundle }
  })
