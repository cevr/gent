/**
 * Supervisor Promise edges.
 *
 * `supervisor.ts` needs to invoke supervised Effects from Promise-returning
 * callbacks (process exit handlers and coordinated restart state). The
 * Effect→Promise edges live here.
 *
 * Per `gent/no-runpromise-outside-boundary`, both Promise edges live in
 * a `*-boundary.ts` module. Each export NAMES the specific external seam
 * — there is no generic `runAnyEffect` trampoline. Both helpers consume
 * the supervisor's captured `services` ServiceMap and pin the Effect
 * shape so callers cannot launder additional Effects through them.
 */

import { Effect, type Context } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"

/**
 * Fire-and-forget a worker-supervisor restart triggered from a process
 * exit callback. The exit handler has nothing to catch a rejection, so
 * we collapse to `Exit` and discard. The caller — the OS process exit —
 * does not observe the result.
 *
 * Pinned to `Context.Context<ChildProcessSpawner>` because the supervisor
 * captures `BunServices` to spawn replacement workers from its restart
 * effect; the captured context must thread through to the boundary.
 */
export const runSupervisorCrashRestart = <A, E>(
  services: Context.Context<ChildProcessSpawner.ChildProcessSpawner>,
  restartInternal: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
): void => {
  void Effect.runPromiseExit(Effect.provide(restartInternal, services))
}

/**
 * Run the worker-supervisor's backoff-then-relaunch Effect on the
 * captured services and return a `Promise<void>` that the supervisor
 * stores on `restartPromise` to coordinate concurrent restart attempts.
 *
 * The Effect's body holds supervisor closure state (`restartPromise`,
 * `current`, etc.) — that's why this helper pins to `Effect<void, E, R>`
 * rather than rebuilding it inside the boundary. `E` is generic because
 * the launch path can fail with `WorkerSupervisorError`; the rejection
 * surfaces on the awaited promise.
 */
export const runSupervisorBackoffRestart = <E>(
  services: Context.Context<ChildProcessSpawner.ChildProcessSpawner>,
  effect: Effect.Effect<void, E, ChildProcessSpawner.ChildProcessSpawner>,
): Promise<void> => Effect.runPromiseWith(services)(effect)
