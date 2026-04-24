import { Cause, Clock, Effect, Exit, Schema, type Scope } from "effect"
import * as net from "node:net"
import { pathToFileURL } from "node:url"
import { runSupervisorBackoffRestart, runSupervisorCrashRestart } from "./supervisor-boundary.js"

export class WorkerSupervisorError extends Schema.TaggedErrorClass<WorkerSupervisorError>()(
  "@gent/sdk/WorkerSupervisorError",
  {
    message: Schema.String,
  },
) {}

export type WorkerLifecycleState =
  | { readonly _tag: "starting"; readonly port: number; readonly restartCount: number }
  | {
      readonly _tag: "running"
      readonly port: number
      readonly pid: number
      readonly restartCount: number
    }
  | {
      readonly _tag: "restarting"
      readonly port: number
      readonly restartCount: number
      readonly previousPid: number | undefined
      readonly exitCode: number | null
    }
  | { readonly _tag: "stopped"; readonly port: number; readonly restartCount: number }
  | {
      readonly _tag: "failed"
      readonly port: number
      readonly restartCount: number
      readonly message: string
      readonly exitCode: number | null
    }

export interface WorkerSupervisor {
  readonly url: string
  readonly port: number
  readonly pid: () => number | null
  readonly getState: () => WorkerLifecycleState
  readonly subscribe: (listener: (state: WorkerLifecycleState) => void) => () => void
  readonly stop: Effect.Effect<void, never>
  readonly restart: Effect.Effect<void, WorkerSupervisorError>
}

/** Restart limits for crash-loop prevention */
const MAX_RESTARTS_IN_WINDOW = 5
const RESTART_WINDOW_MS = 60_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 16_000

export interface WorkerSupervisorOptions {
  readonly cwd: string
  readonly env?: Record<string, string | undefined>
  readonly startupTimeoutMs?: number
  readonly mode?: "default" | "debug"
  /** Shared mode: exit code 0 = intentional idle shutdown (no restart).
   *  Non-zero = crash (restart). Also skips process.on("exit") SIGKILL. */
  readonly shared?: boolean
}

const SERVER_ENTRY_PATH = new URL("../../../apps/server/src/main.ts", import.meta.url).pathname
const WORKER_HOST = "127.0.0.1"
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 3_000
const WORKER_READY_PREFIX = "GENT_WORKER_READY "
const STARTUP_MAX_ATTEMPTS = 3
const STARTUP_RETRY_DELAY_MS = 250

const resolveWorkerLaunch = async (options?: {
  readonly sourceEntryPath?: string
  readonly execPath?: string
  readonly sourceExists?: (path: string) => Promise<boolean>
  readonly which?: (cmd: string) => string | null
}) => {
  const sourceEntryPath = options?.sourceEntryPath ?? SERVER_ENTRY_PATH
  const execPath = options?.execPath ?? process.execPath
  const sourceExists = options?.sourceExists ?? ((path: string) => Bun.file(path).exists())
  const which = options?.which ?? Bun.which

  const fallbackEntryPath = new URL("../../server/src/main.ts", pathToFileURL(execPath)).pathname
  const serverEntryPath =
    !sourceEntryPath.startsWith("/$bunfs/") && (await sourceExists(sourceEntryPath))
      ? sourceEntryPath
      : fallbackEntryPath

  return {
    runtimePath: execPath.endsWith("/bun") ? execPath : (which("bun") ?? execPath),
    serverEntryPath,
  }
}

export const findOpenPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, WORKER_HOST, () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate worker port")))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })

const waitForWorkerReady = (
  proc: Bun.Subprocess,
  timeoutMs: number,
): Effect.Effect<void, WorkerSupervisorError> =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const stdout = proc.stdout
        if (stdout === undefined || stdout === null || typeof stdout === "number") {
          reject(new WorkerSupervisorError({ message: "worker stdout unavailable during startup" }))
          return
        }

        const reader = (stdout as ReadableStream<Uint8Array>).getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        let settled = false
        let ready = false

        const fail = (error: WorkerSupervisorError) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          void reader.cancel().catch(() => undefined)
          reject(error)
        }

        const markReady = () => {
          if (settled) return
          settled = true
          ready = true
          clearTimeout(timeout)
          resolve()
        }

        const timeout = setTimeout(() => {
          fail(
            new WorkerSupervisorError({
              message: `worker did not become ready within ${timeoutMs}ms`,
            }),
          )
        }, timeoutMs)

        void proc.exited.then(() => {
          if (ready) return
          fail(
            new WorkerSupervisorError({
              message: `worker exited before ready${proc.exitCode !== null ? ` (${proc.exitCode})` : ""}`,
            }),
          )
        })

        const handleText = (text: string) => {
          buffer += text
          while (true) {
            const newline = buffer.indexOf("\n")
            if (newline === -1) return
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (line.startsWith(WORKER_READY_PREFIX)) {
              markReady()
            }
          }
        }

        const readLoop = (): void => {
          void reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                if (!ready) {
                  fail(new WorkerSupervisorError({ message: "worker stdout closed before ready" }))
                }
                return
              }
              handleText(decoder.decode(value, { stream: true }))
              readLoop()
            })
            .catch((error: unknown) => {
              if (ready) return
              fail(
                new WorkerSupervisorError({
                  message: `failed to read worker readiness: ${String(error)}`,
                }),
              )
            })
        }

        readLoop()
      }),
  ).pipe(
    Effect.mapError((error) => {
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { readonly message: unknown }).message)
          : String(error)
      return new WorkerSupervisorError({ message })
    }),
  )

const isRetryableStartupError = (error: WorkerSupervisorError): boolean =>
  error.message === "worker stdout closed before ready" ||
  error.message.startsWith("worker exited before ready") ||
  error.message.startsWith("failed to read worker readiness:")

const startupErrorFromCause = (
  cause: Cause.Cause<WorkerSupervisorError>,
): WorkerSupervisorError => {
  const squashed = Cause.squash(cause)
  return Schema.is(WorkerSupervisorError)(squashed)
    ? squashed
    : new WorkerSupervisorError({ message: String(squashed) })
}

interface StartedWorker<Proc extends { readonly pid: number }> {
  readonly port: number
  readonly url: string
  readonly proc: Proc
}

interface LaunchWorkerUntilReadyOptions<Proc extends { readonly pid: number }> {
  readonly maxAttempts?: number
  readonly retryDelayMs?: number
  readonly spawn: Effect.Effect<StartedWorker<Proc>, WorkerSupervisorError>
  readonly waitForReady: (
    launched: StartedWorker<Proc>,
  ) => Effect.Effect<void, WorkerSupervisorError>
  readonly stop: (proc: Proc) => Effect.Effect<void>
  readonly sleep: (delayMs: number) => Effect.Effect<void>
  readonly setCurrent: (proc: Proc | undefined) => void
  readonly isCurrent: (proc: Proc) => boolean
  readonly isStopped: () => boolean
  readonly logRetry: (input: {
    readonly attempt: number
    readonly pid: number
    readonly error: string
  }) => void
}

const launchWorkerUntilReady = <Proc extends { readonly pid: number }>(
  options: LaunchWorkerUntilReadyOptions<Proc>,
): Effect.Effect<StartedWorker<Proc> | undefined, WorkerSupervisorError> =>
  Effect.gen(function* () {
    const maxAttempts = options.maxAttempts ?? STARTUP_MAX_ATTEMPTS
    const retryDelayMs = options.retryDelayMs ?? STARTUP_RETRY_DELAY_MS
    let launched: StartedWorker<Proc> | undefined
    let startupError: WorkerSupervisorError | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      launched = yield* options.spawn
      options.setCurrent(launched.proc)
      const readyExit = yield* options.waitForReady(launched).pipe(Effect.exit)
      if (Exit.isSuccess(readyExit)) {
        startupError = undefined
        break
      }

      startupError = startupErrorFromCause(readyExit.cause)
      yield* options.stop(launched.proc)
      if (options.isCurrent(launched.proc)) options.setCurrent(undefined)
      if (
        options.isStopped() ||
        !isRetryableStartupError(startupError) ||
        attempt === maxAttempts
      ) {
        break
      }

      options.logRetry({
        attempt,
        pid: launched.proc.pid,
        error: startupError.message,
      })
      yield* options.sleep(retryDelayMs * attempt)
    }

    if (options.isStopped()) return undefined
    if (launched === undefined) {
      return yield* new WorkerSupervisorError({ message: "worker launch did not start" })
    }
    if (startupError !== undefined) {
      return yield* new WorkerSupervisorError({
        message: isRetryableStartupError(startupError)
          ? `worker did not become ready after ${maxAttempts} attempts: ${startupError.message}`
          : startupError.message,
      })
    }

    return launched
  })

// @effect-diagnostics-next-line nodeBuiltinImport:off
import { appendFileSync } from "node:fs"
import { getLogPaths } from "@gent/core/runtime/log-paths"

const shutdownLog = (msg: string, data?: Record<string, unknown>) => {
  const entry = { ts: new Date().toISOString(), level: "info", source: "supervisor", msg, ...data }
  try {
    appendFileSync(getLogPaths().client, JSON.stringify(entry) + "\n")
  } catch {}
}

const stopSubprocess = (proc: Bun.Subprocess): Effect.Effect<void> =>
  Effect.promise(async () => {
    shutdownLog("stop.start", { pid: proc.pid, exitCode: proc.exitCode })
    if (proc.exitCode !== null) return
    try {
      process.kill(proc.pid, "SIGTERM")
      shutdownLog("stop.sigterm", { pid: proc.pid })
    } catch {
      shutdownLog("stop.sigterm-failed", { pid: proc.pid })
      return
    }
    const exited = proc.exited.then(() => undefined)
    const timedOut = Bun.sleep(SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const)
    const result = await Promise.race([exited, timedOut])
    if (result === "timeout") {
      shutdownLog("stop.timeout", { pid: proc.pid })
      try {
        process.kill(proc.pid, "SIGKILL")
        shutdownLog("stop.sigkill", { pid: proc.pid })
      } catch {
        return
      }
      await proc.exited
      shutdownLog("stop.killed", { pid: proc.pid })
    } else {
      shutdownLog("stop.exited-gracefully", { pid: proc.pid })
    }
  }).pipe(Effect.catchEager(() => Effect.void))

const killSubprocessSync = (proc: Bun.Subprocess | undefined) => {
  if (proc === undefined || proc.exitCode !== null) return
  try {
    // SIGKILL — the parent is exiting and can't wait for graceful shutdown.
    // SIGTERM alone leaves orphans if the worker is busy (e.g. SQLite WAL checkpoint).
    process.kill(proc.pid, "SIGKILL")
  } catch {
    // Parent is already exiting. Best effort only.
  }
}

const spawnWorkerProcess = (
  options: WorkerSupervisorOptions,
  port: number,
): Effect.Effect<{ readonly port: number; readonly url: string; readonly proc: Bun.Subprocess }> =>
  Effect.promise(async () => {
    const mode = options.mode ?? "default"
    const launch = await resolveWorkerLaunch()
    const env = {
      ...Bun.env,
      ...options.env,
      GENT_PORT: String(port),
      GENT_SERVER_MODE: "worker",
      GENT_TRACE_ID: `worker-${Bun.randomUUIDv7()}`,
      ...(mode === "debug"
        ? {
            GENT_PERSISTENCE_MODE: "memory",
            GENT_PROVIDER_MODE: "debug-scripted",
            GENT_DEBUG_MODE: "1",
          }
        : {}),
    }
    const proc = Bun.spawn([launch.runtimePath, launch.serverEntryPath], {
      cwd: options.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    })
    return { port, url: `http://${WORKER_HOST}:${port}/rpc`, proc }
  })

export const waitForWorkerRunning = (
  worker: Pick<WorkerSupervisor, "getState" | "subscribe">,
): Effect.Effect<void, WorkerSupervisorError> =>
  Effect.callback<void, WorkerSupervisorError>((resume) => {
    const current = worker.getState()
    if (current._tag === "running") {
      resume(Effect.void)
      return
    }
    if (current._tag === "stopped" || current._tag === "failed") {
      resume(
        Effect.fail(
          new WorkerSupervisorError({
            message: `worker ${current._tag}${current._tag === "failed" ? `: ${current.message}` : ""}`,
          }),
        ),
      )
      return
    }

    const unsubscribe = worker.subscribe((state) => {
      if (state._tag === "running") {
        unsubscribe()
        resume(Effect.void)
      } else if (state._tag === "stopped" || state._tag === "failed") {
        unsubscribe()
        resume(
          Effect.fail(
            new WorkerSupervisorError({
              message: `worker ${state._tag}${state._tag === "failed" ? `: ${state.message}` : ""}`,
            }),
          ),
        )
      }
    })

    // Clean up subscription on fiber interrupt
    return Effect.sync(() => {
      unsubscribe()
    })
  })

export const startWorkerSupervisor = (
  options: WorkerSupervisorOptions,
): Effect.Effect<WorkerSupervisor, WorkerSupervisorError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const supervisorServices = yield* Effect.context<never>()
      const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
      const assignedPort = yield* Effect.promise(findOpenPort).pipe(
        Effect.mapError(
          (error) =>
            new WorkerSupervisorError({
              message: `failed to allocate worker port: ${String(error)}`,
            }),
        ),
      )
      const listeners = new Set<(state: WorkerLifecycleState) => void>()
      let restartCount = 0
      let stopped = false
      const restartTimestamps: number[] = []
      let current: Bun.Subprocess | undefined
      let restartPromise: Promise<void> | undefined
      let state: WorkerLifecycleState = {
        _tag: "starting",
        port: assignedPort,
        restartCount,
      }
      const isShared = options.shared === true
      const handleProcessExit = () => {
        killSubprocessSync(current)
      }
      const disarmProcessExit = () => {
        if (!isShared) process.off("exit", handleProcessExit)
      }

      // In shared mode, don't kill the server when the parent exits
      if (!isShared) {
        process.on("exit", handleProcessExit)
      }

      const emit = (next: WorkerLifecycleState) => {
        state = next
        for (const listener of listeners) listener(next)
      }

      const launchCurrent = Effect.gen(function* () {
        const readyWorker = yield* launchWorkerUntilReady({
          spawn: spawnWorkerProcess(options, assignedPort),
          waitForReady: (launched) => waitForWorkerReady(launched.proc, startupTimeoutMs),
          stop: stopSubprocess,
          sleep: (delayMs) => Effect.sleep(`${delayMs} millis`),
          setCurrent: (proc) => {
            current = proc
          },
          isCurrent: (proc) => current?.pid === proc.pid,
          isStopped: () => stopped,
          logRetry: (input) => {
            shutdownLog("launch.retry", {
              attempt: input.attempt,
              pid: input.pid,
              error: input.error,
            })
          },
        })
        if (readyWorker === undefined) return

        restartPromise = undefined
        emit({
          _tag: "running",
          port: readyWorker.port,
          pid: readyWorker.proc.pid,
          restartCount,
        })

        void readyWorker.proc.exited.then(() => {
          if (stopped) return
          if (current?.pid !== readyWorker.proc.pid) return

          // Shared mode: exit code 0 is intentional idle shutdown — don't restart
          if (isShared && readyWorker.proc.exitCode === 0) {
            stopped = true
            emit({ _tag: "stopped", port: assignedPort, restartCount })
            return
          }

          runSupervisorCrashRestart(
            supervisorServices,
            restartInternal({
              exitCode: readyWorker.proc.exitCode,
              previousPid: readyWorker.proc.pid,
            }),
          )
        })
      })

      const restartInternal = Effect.fn("WorkerSupervisor.restartInternal")(function* (input?: {
        exitCode: number | null
        previousPid: number | undefined
      }) {
        if (stopped) return
        if (restartPromise !== undefined) {
          const inFlight = restartPromise
          yield* Effect.promise(() => inFlight)
          return
        }

        restartCount += 1
        const isCrash = input !== undefined
        const now = yield* Clock.currentTimeMillis

        // Only track crash-triggered restarts for loop detection (not manual)
        if (isCrash) {
          restartTimestamps.push(now)

          // Prune timestamps outside the window
          while (
            restartTimestamps.length > 0 &&
            (restartTimestamps[0] ?? 0) < now - RESTART_WINDOW_MS
          ) {
            restartTimestamps.shift()
          }

          // Crash-loop detection: too many crash restarts in window → permanent failure
          if (restartTimestamps.length > MAX_RESTARTS_IN_WINDOW) {
            restartPromise = undefined
            emit({
              _tag: "failed",
              port: assignedPort,
              restartCount,
              message: `Crash loop: ${restartTimestamps.length} restarts in ${RESTART_WINDOW_MS / 1000}s`,
              exitCode: input.exitCode,
            })
            return
          }
        }

        emit({
          _tag: "restarting",
          port: assignedPort,
          restartCount,
          previousPid: input?.previousPid,
          exitCode: input?.exitCode ?? null,
        })

        // Exponential backoff only for crash restarts
        const backoffMs = isCrash
          ? Math.min(BACKOFF_BASE_MS * 2 ** (restartTimestamps.length - 1), BACKOFF_MAX_MS)
          : 0

        restartPromise = runSupervisorBackoffRestart(
          supervisorServices,
          Effect.gen(function* () {
            yield* Effect.sleep(`${backoffMs} millis`)
            const proc = current
            if (proc !== undefined) {
              yield* stopSubprocess(proc)
            }
            yield* launchCurrent
          }).pipe(
            Effect.catchEager((error) =>
              Effect.andThen(
                Effect.sync(() => {
                  restartPromise = undefined
                  emit({
                    _tag: "failed",
                    port: assignedPort,
                    restartCount,
                    message: error.message,
                    exitCode: input?.exitCode ?? current?.exitCode ?? null,
                  })
                }),
                Effect.fail(error),
              ),
            ),
          ),
        )

        const inFlight = restartPromise
        yield* Effect.promise(() => inFlight)
      })

      yield* launchCurrent.pipe(
        Effect.catchEager((error) =>
          Effect.gen(function* () {
            disarmProcessExit()
            const proc = current
            current = undefined
            if (proc !== undefined) yield* stopSubprocess(proc)
            return yield* error
          }),
        ),
      )

      const stop = Effect.gen(function* () {
        shutdownLog("supervisor.stop.enter")
        if (stopped) return
        stopped = true
        disarmProcessExit()
        const proc = current
        current = undefined
        if (proc !== undefined) yield* stopSubprocess(proc)
        emit({ _tag: "stopped", port: assignedPort, restartCount })
        shutdownLog("supervisor.stop.done")
      }).pipe(Effect.catchEager(() => Effect.void))

      return {
        url: `http://${WORKER_HOST}:${assignedPort}/rpc`,
        port: assignedPort,
        pid: () => (state._tag === "running" ? state.pid : null),
        getState: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          listener(state)
          return () => {
            listeners.delete(listener)
          }
        },
        stop,
        restart: restartInternal(),
      } satisfies WorkerSupervisor
    }),
    (supervisor) => supervisor.stop,
  )

export const WorkerSupervisorInternal = {
  isRetryableStartupError,
  launchWorkerUntilReady,
  resolveWorkerLaunch,
} as const
