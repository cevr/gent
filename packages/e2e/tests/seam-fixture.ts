/**
 * Seam fixture — spawns real worker processes for cross-package integration tests.
 * Generic helpers live in @gent/core/test-utils/fixtures.
 */

import { Effect, type Scope } from "effect"
import { Gent, GentConnectionError, type GentClientBundle } from "@gent/sdk"
import { startWorkerSupervisor, type WorkerSupervisorOptions } from "@gent/sdk/supervisor"

// Re-export generic fixtures from core
export { createTempDirFixture, createWorkerEnv, waitFor } from "@gent/core/test-utils/fixtures"

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
    return yield* Gent.connect({ url: supervisor.url })
  })

/** Start a raw supervisor — for tests that need lifecycle assertions. */
export const startWorkerWithSupervisor = (options: WorkerSupervisorOptions) =>
  Effect.gen(function* () {
    const supervisor = yield* startWorkerSupervisor(options)
    const bundle = yield* Gent.connect({ url: supervisor.url })
    return { ...supervisor, ...bundle }
  })
