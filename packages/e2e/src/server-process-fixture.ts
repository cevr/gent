import { Clock, Effect, Schema } from "effect"
import * as Option from "effect/Option"

// ── wait-for-process-exit ───────────────────────────────────────────────────

/**
 * Wait for a process to leave the process table.
 *
 * Both subprocess fixtures need the same answer — did this pid go away
 * before the deadline — so they ask it once here. The result is that
 * question and nothing more: `true` for exited, `false` for timed out. An
 * exit *code* is not on offer, because `process.kill(pid, 0)` never carried
 * one; the old `0`/`-1` sentinels only looked like exit codes.
 */

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

// ── server-process-fixture ──────────────────────────────────────────────────

const repoRoot = decodeURIComponent(new URL("../../..", import.meta.url).pathname).replace(
  /\/$/,
  "",
)
const serverEntry = `${repoRoot}/apps/server/src/main.ts`

class ServerProcessFixtureError extends Schema.TaggedError<ServerProcessFixtureError>()(
  "@gent/e2e/src/server-process-fixture/ServerProcessFixtureError",
  { message: Schema.String },
) {}

const readReadyUrl = (proc: Bun.Subprocess): Effect.Effect<string, ServerProcessFixtureError> => {
  const ready = Effect.callback<string, ServerProcessFixtureError>((resume) => {
    const chunks: string[] = []
    const decoder = new TextDecoder()
    const stdout = proc.stdout
    // oxlint-disable-next-line effect/noNullish, effect/noRuntimeTypeof -- Bun stdout uses an external stream, fd, or absent union
    if (stdout === undefined || typeof stdout === "number") {
      resume(Effect.fail(new ServerProcessFixtureError({ message: "server stdout was not piped" })))
      return
    }
    const reader = stdout.getReader()
    const pump = (): void => {
      reader.read().then(({ value, done }) => {
        if (done) {
          resume(
            Effect.fail(new ServerProcessFixtureError({ message: "stdout closed before ready" })),
          )
          return
        }
        chunks.push(decoder.decode(value))
        const match = chunks.join("").match(/GENT_SERVER_READY (.+)/)
        if (match) {
          reader.releaseLock()
          const readyUrl = Option.fromNullishOr(match[1])
          if (Option.isNone(readyUrl)) {
            resume(
              Effect.fail(
                new ServerProcessFixtureError({
                  message: "server ready line did not include a url",
                }),
              ),
            )
            return
          }
          resume(Effect.succeed(readyUrl.value.trim()))
        } else {
          pump()
        }
      })
    }
    pump()
  })
  // gent/no-sleep: allow real-clock timeout fence for subprocess readiness probe
  const timeout = Effect.sleep("10 seconds").pipe(
    Effect.andThen(
      Effect.fail(new ServerProcessFixtureError({ message: "server did not become ready" })),
    ),
  )
  return Effect.race(ready, timeout)
}

/**
 * Spawn a shared-mode server subprocess on `port` and wait for its ready line.
 * Pass `idleTimeoutMs` to give the server an idle-shutdown deadline; omit it to
 * let the server run until it is killed.
 */
export const spawnServer = (opts: {
  dataDir: string
  port: number
  idleTimeoutMs?: number
}): Effect.Effect<{ url: string; proc: Bun.Subprocess }, ServerProcessFixtureError> =>
  Effect.gen(function* () {
    const idleTimeoutEnv = Option.match(Option.fromNullishOr(opts.idleTimeoutMs), {
      onNone: () => ({}),
      onSome: (ms) => ({ GENT_IDLE_TIMEOUT_MS: String(ms) }),
    })
    const proc = Bun.spawn(["bun", serverEntry], {
      cwd: repoRoot,
      env: {
        ...Bun.env,
        GENT_PORT: String(opts.port),
        GENT_SERVER_MODE: "shared",
        GENT_PERSISTENCE_MODE: "memory",
        GENT_PROVIDER_MODE: "debug-scripted",
        GENT_DATA_DIR: opts.dataDir,
        ...idleTimeoutEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const url = yield* readReadyUrl(proc)
    return { url: `${url}/rpc`, proc }
  })

export const waitUntil = (
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    const loop: Effect.Effect<boolean> = Effect.gen(function* () {
      if (predicate()) return true
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) return false
      // gent/no-sleep: allow real-clock polling primitive — predicate observes external subprocess state
      yield* Effect.sleep(`${intervalMs} millis`)
      return yield* loop
    })
    return yield* loop
  })

export const killProcess = (proc: Bun.Subprocess, signal?: NodeJS.Signals): Effect.Effect<void> =>
  Effect.sync(() => {
    proc.kill(signal)
  }).pipe(Effect.ignoreCause)
