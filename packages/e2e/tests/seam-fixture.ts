/**
 * Seam fixture — spawns real worker processes for cross-package integration tests.
 * Generic helpers live in @gent/core/test-utils/fixtures.
 */

import { afterEach } from "bun:test"
import { Effect, type Scope } from "effect"
import { Gent, GentConnectionError, type GentClientBundle } from "@gent/sdk"
import { startWorkerSupervisor, type WorkerSupervisorOptions } from "@gent/sdk/supervisor"

// Re-export generic fixtures from core
export { createTempDirFixture, createWorkerEnv, waitFor } from "@gent/core/test-utils/fixtures"

// ---------------------------------------------------------------------------
// PID reaper — belt-and-suspenders cleanup for orphaned worker processes.
// bun:test timeouts bypass Effect scope finalizers, so this afterEach hook
// SIGTERMs any child PIDs that are still alive after a test completes.
// ---------------------------------------------------------------------------

const trackedPids = new Set<number>()

const killIfAlive = (pid: number) => {
  try {
    process.kill(pid, 0) // check if alive
    process.kill(pid, "SIGTERM")
  } catch {
    // already dead — expected
  }
}

const cleanupOrphanedWorkers = () => {
  for (const pid of trackedPids) killIfAlive(pid)
  trackedPids.clear()
}

/** Register an afterEach hook that SIGTERMs any tracked worker PIDs still alive. Call once at module level. */
export const registerWorkerCleanup = () => {
  afterEach(() => cleanupOrphanedWorkers())
}

const trackSupervisorPid = (supervisor: { pid: () => number | null }) => {
  const pid = supervisor.pid()
  if (pid !== null) trackedPids.add(pid)
}

// ---------------------------------------------------------------------------
// Worker helpers
// ---------------------------------------------------------------------------

/** Start a worker and return a GentClientBundle. Tracks PID for orphan cleanup. */
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
    trackSupervisorPid(supervisor)
    return yield* Gent.connect({ url: supervisor.url })
  })

/** Start a raw supervisor — for tests that need lifecycle assertions. Tracks PID for orphan cleanup. */
export const startWorkerWithSupervisor = (options: WorkerSupervisorOptions) =>
  Effect.gen(function* () {
    const supervisor = yield* startWorkerSupervisor(options)
    trackSupervisorPid(supervisor)
    const bundle = yield* Gent.connect({ url: supervisor.url })
    return { ...supervisor, ...bundle }
  })
