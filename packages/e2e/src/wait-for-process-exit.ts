/**
 * Wait for a process to leave the process table.
 *
 * Both subprocess fixtures need the same answer — did this pid go away
 * before the deadline — so they ask it once here. The result is that
 * question and nothing more: `true` for exited, `false` for timed out. An
 * exit *code* is not on offer, because `process.kill(pid, 0)` never carried
 * one; the old `0`/`-1` sentinels only looked like exit codes.
 */
import { Clock, Effect } from "effect"

/** A pid that was never valid cannot be alive, and must not be probed. */
const isPidAlive = (pid: number): Effect.Effect<boolean> => {
  if (!Number.isInteger(pid) || pid <= 0) return Effect.succeed(false)
  return Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.catchEager(() => Effect.succeed(false)),
  )
}

/** `true` once the pid is gone; `false` if it outlived `timeoutMs`. */
export const waitForProcessExit = (pid: number, timeoutMs: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    const loop: Effect.Effect<boolean> = Effect.gen(function* () {
      if (!(yield* isPidAlive(pid))) return true
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) return false
      // gent/no-sleep: allow OS-level wait while polling for the kernel to reap the subprocess
      yield* Effect.sleep("50 millis")
      return yield* loop
    })
    return yield* loop
  })
