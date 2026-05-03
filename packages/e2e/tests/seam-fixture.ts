/**
 * Seam fixture — spawns real worker processes for cross-package integration tests.
 * Generic helpers live in @gent/core/test-utils/fixtures.
 */

import { Clock, Effect, Schema, type Scope } from "effect"
import { Gent, GentConnectionError, type GentClientBundle } from "@gent/sdk"
import { startWorkerSupervisor, type WorkerSupervisorOptions } from "@gent/sdk/supervisor"

// Re-export generic fixtures from core
export { createTempDirFixture, createWorkerEnv, waitFor } from "@gent/core/test-utils/fixtures"

class RpcReadyFailure extends Schema.TaggedErrorClass<RpcReadyFailure>()(
  "@gent/e2e/tests/seam-fixture/RpcReadyFailure",
  { message: Schema.String },
) {}

/**
 * Poll until the RPC client can reach the worker after a restart.
 *
 * After supervisor restart, the WebSocket retry loop needs time to
 * reconnect. The RPC client's `currentError` blocks all `send()` calls
 * until `onOpen` fires on the new socket. This helper probes with a
 * cheap RPC until it succeeds.
 */
export const waitForRpcReady = <E>(
  client: { session: { list: () => Effect.Effect<ReadonlyArray<unknown>, E> } },
  timeoutMs = 10_000,
): Effect.Effect<void, RpcReadyFailure> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const deadline = startedAt + timeoutMs
    return yield* loop()
    function loop(): Effect.Effect<void, RpcReadyFailure> {
      return Effect.gen(function* () {
        const result = yield* client.session.list().pipe(Effect.exit)
        if (result._tag === "Success") return
        const now = yield* Clock.currentTimeMillis
        if (now >= deadline) {
          return yield* new RpcReadyFailure({
            message: "RPC client did not reconnect after restart",
          })
        }
        yield* Effect.sleep("50 millis")
        return yield* loop()
      })
    }
  })

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
    const bundle = yield* Gent.client(supervisor.url)
    yield* bundle.runtime.lifecycle.waitForReady
    return bundle
  })

/** Start a raw supervisor — for tests that need lifecycle assertions. */
export const startWorkerWithSupervisor = (options: WorkerSupervisorOptions) =>
  Effect.gen(function* () {
    const supervisor = yield* startWorkerSupervisor(options)
    const bundle = yield* Gent.client(supervisor.url)
    yield* bundle.runtime.lifecycle.waitForReady
    return { ...supervisor, ...bundle }
  })
