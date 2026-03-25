/**
 * Seam fixture — spawns real worker processes for cross-package integration tests.
 * Generic helpers live in @gent/core/test-utils/fixtures.
 */

import { Effect } from "effect"
import { Gent } from "@gent/sdk"
import { startWorkerSupervisor, type WorkerSupervisorOptions } from "@gent/sdk/supervisor"

// Re-export generic fixtures from core
export { createTempDirFixture, createWorkerEnv, waitFor } from "@gent/core/test-utils/fixtures"

/** Start a worker using Gent.spawn — returns a unified GentClient */
export const startWorkerWithClient = (options: {
  cwd: string
  env?: Record<string, string>
  startupTimeoutMs?: number
  mode?: "default" | "debug"
}) => Gent.spawn(options)

/** Start a raw supervisor — for tests that need lifecycle assertions */
export const startWorkerWithSupervisor = (options: WorkerSupervisorOptions) =>
  Effect.gen(function* () {
    const supervisor = yield* startWorkerSupervisor(options)
    const client = yield* Gent.connect({ url: supervisor.url })
    return { ...supervisor, client }
  })
