import { Effect } from "effect"
import * as path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const serverEntry = path.resolve(repoRoot, "apps/server/src/main.ts")

const readReadyUrl = (proc: Bun.Subprocess): Promise<string> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server did not become ready")), 10_000)
    const chunks: string[] = []
    const decoder = new TextDecoder()
    const stdout = proc.stdout
    if (stdout === undefined || typeof stdout === "number") {
      reject(new Error("server stdout was not piped"))
      return
    }
    const reader = stdout.getReader()
    const pump = (): void => {
      reader.read().then(({ value, done }) => {
        if (done) {
          reject(new Error("stdout closed before ready"))
          return
        }
        chunks.push(decoder.decode(value))
        const match = chunks.join("").match(/GENT_WORKER_READY (.+)/)
        if (match) {
          clearTimeout(timeout)
          reader.releaseLock()
          const readyUrl = match[1]
          if (readyUrl === undefined) {
            reject(new Error("server ready line did not include a url"))
            return
          }
          resolve(readyUrl.trim())
        } else {
          pump()
        }
      })
    }
    pump()
  })

export const spawnIdleServer = (opts: {
  dataDir: string
  idleTimeoutMs: number
  port: number
}): Effect.Effect<{ url: string; proc: Bun.Subprocess }> =>
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
    const url = yield* Effect.promise(() => readReadyUrl(proc))
    return { url: `${url}/rpc`, proc }
  })

export const spawnServerOnPort = (opts: {
  dataDir: string
  port: number
}): Effect.Effect<{ url: string; proc: Bun.Subprocess }> =>
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
    const url = yield* Effect.promise(() => readReadyUrl(proc))
    return { url: `${url}/rpc`, proc }
  })

export const waitForExit = (pid: number, timeoutMs: number): Effect.Effect<number> =>
  Effect.promise(
    () =>
      new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(-1), timeoutMs)
        const check = setInterval(() => {
          try {
            process.kill(pid, 0)
          } catch {
            clearInterval(check)
            clearTimeout(timeout)
            resolve(0)
          }
        }, 200)
      }),
  )

export const waitUntil = (
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Effect.Effect<boolean> =>
  Effect.promise(
    () =>
      new Promise((resolve) => {
        if (predicate()) {
          resolve(true)
          return
        }
        const deadline = Date.now() + timeoutMs
        const check = setInterval(() => {
          if (predicate()) {
            clearInterval(check)
            resolve(true)
          } else if (Date.now() >= deadline) {
            clearInterval(check)
            resolve(false)
          }
        }, intervalMs)
      }),
  )

export const killProcess = (proc: Bun.Subprocess, signal?: NodeJS.Signals): Effect.Effect<void> =>
  Effect.sync(() => {
    proc.kill(signal)
  }).pipe(Effect.catchCause(() => Effect.void))
