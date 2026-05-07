import { Clock, Effect, Schema } from "effect"

const repoRoot = decodeURIComponent(new URL("../../..", import.meta.url).pathname).replace(
  /\/$/,
  "",
)
const serverEntry = `${repoRoot}/apps/server/src/main.ts`

class ServerProcessFixtureError extends Schema.TaggedErrorClass<ServerProcessFixtureError>()(
  "@gent/e2e/src/server-process-fixture/ServerProcessFixtureError",
  { message: Schema.String },
) {}

const readReadyUrl = (proc: Bun.Subprocess): Effect.Effect<string, ServerProcessFixtureError> => {
  const ready = Effect.callback<string, ServerProcessFixtureError>((resume) => {
    const chunks: string[] = []
    const decoder = new TextDecoder()
    const stdout = proc.stdout
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
        const match = chunks.join("").match(/GENT_WORKER_READY (.+)/)
        if (match) {
          reader.releaseLock()
          const readyUrl = match[1]
          if (readyUrl === undefined) {
            resume(
              Effect.fail(
                new ServerProcessFixtureError({
                  message: "server ready line did not include a url",
                }),
              ),
            )
            return
          }
          resume(Effect.succeed(readyUrl.trim()))
        } else {
          pump()
        }
      })
    }
    pump()
  })
  const timeout = Effect.sleep("10 seconds").pipe(
    Effect.andThen(
      Effect.fail(new ServerProcessFixtureError({ message: "server did not become ready" })),
    ),
  )
  return Effect.race(ready, timeout)
}

export const spawnIdleServer = (opts: {
  dataDir: string
  idleTimeoutMs: number
  port: number
}): Effect.Effect<{ url: string; proc: Bun.Subprocess }, ServerProcessFixtureError> =>
  Effect.gen(function* () {
    const proc = Bun.spawn(["bun", serverEntry], {
      cwd: repoRoot,
      env: {
        ...Bun.env,
        GENT_PORT: String(opts.port),
        GENT_SERVER_MODE: "worker",
        GENT_PERSISTENCE_MODE: "memory",
        GENT_PROVIDER_MODE: "debug-scripted",
        GENT_DATA_DIR: opts.dataDir,
        GENT_IDLE_TIMEOUT_MS: String(opts.idleTimeoutMs),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const url = yield* readReadyUrl(proc)
    return { url: `${url}/rpc`, proc }
  })

export const spawnServerOnPort = (opts: {
  dataDir: string
  port: number
}): Effect.Effect<{ url: string; proc: Bun.Subprocess }, ServerProcessFixtureError> =>
  Effect.gen(function* () {
    const proc = Bun.spawn(["bun", serverEntry], {
      cwd: repoRoot,
      env: {
        ...Bun.env,
        GENT_PORT: String(opts.port),
        GENT_SERVER_MODE: "worker",
        GENT_PERSISTENCE_MODE: "memory",
        GENT_PROVIDER_MODE: "debug-scripted",
        GENT_DATA_DIR: opts.dataDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const url = yield* readReadyUrl(proc)
    return { url: `${url}/rpc`, proc }
  })

export const waitForExit = (pid: number, timeoutMs: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    const loop: Effect.Effect<number> = Effect.gen(function* () {
      const alive = yield* Effect.sync(() => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      })
      if (!alive) return 0
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) return -1
      yield* Effect.sleep("50 millis")
      return yield* loop
    })
    return yield* loop
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
      yield* Effect.sleep(`${intervalMs} millis`)
      return yield* loop
    })
    return yield* loop
  })

export const killProcess = (proc: Bun.Subprocess, signal?: NodeJS.Signals): Effect.Effect<void> =>
  Effect.sync(() => {
    proc.kill(signal)
  }).pipe(Effect.catchCause(() => Effect.void))
