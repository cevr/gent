// @effect-diagnostics asyncFunction:off — worker supervisor process launch helpers are Promise entry boundaries
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Schema,
  Schedule,
  Scope,
  Stream,
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
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
      readonly previousPid?: number
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
const UNKNOWN_WORKER_PORT = 0

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
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 3_000
const WORKER_READY_PREFIX = "GENT_WORKER_READY "
const STARTUP_MAX_ATTEMPTS = 5
const STARTUP_RETRY_DELAY_MS = 500

const resolveWorkerLaunch = async (options?: {
  readonly sourceEntryPath?: string
  readonly execPath?: string
  readonly sourceExists?: (path: string) => boolean | Promise<boolean>
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

/**
 * Drain stdout of a `ChildProcessHandle` line by line. Settle the
 * provided `ready` Deferred when a `WORKER_READY_PREFIX` line is seen,
 * or fail it if stdout closes / errors before that.
 */
const watchReadiness = (
  proc: WorkerProcess,
  ready: Deferred.Deferred<string, WorkerSupervisorError>,
): Effect.Effect<void> =>
  proc.handle.stdout.pipe(
    Stream.decodeText(),
    splitLines,
    Stream.tap((line) =>
      line.startsWith(WORKER_READY_PREFIX)
        ? Deferred.succeed(ready, line.slice(WORKER_READY_PREFIX.length).trim())
        : Effect.void,
    ),
    Stream.takeUntilEffect(() => Deferred.isDone(ready)),
    Stream.runDrain,
    Effect.matchEffect({
      onFailure: (err) =>
        Deferred.fail(
          ready,
          new WorkerSupervisorError({
            message: `failed to read worker readiness: ${String(err)}`,
          }),
        ),
      onSuccess: () =>
        Deferred.fail(
          ready,
          new WorkerSupervisorError({ message: "worker stdout closed before ready" }),
        ),
    }),
    Effect.asVoid,
  )

const splitLines = <E>(stream: Stream.Stream<string, E>): Stream.Stream<string, E> => {
  let buffer = ""
  return stream.pipe(
    Stream.flatMap((chunk) => {
      buffer += chunk
      const parts = buffer.split("\n")
      buffer = parts.pop() ?? ""
      return Stream.fromIterable(parts.map((p) => p.trim()).filter((p) => p.length > 0))
    }),
  )
}

const waitForWorkerReady = (
  proc: WorkerProcess,
  timeoutMs: number,
): Effect.Effect<WorkerEndpoint, WorkerSupervisorError> =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<string, WorkerSupervisorError>()
    const watcherFiber = yield* Effect.forkChild(watchReadiness(proc, ready))
    const exitWatcherFiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        const exitCode = yield* proc.handle.exitCode.pipe(Effect.orElseSucceed(() => null))
        yield* Deferred.fail(
          ready,
          new WorkerSupervisorError({
            message: `worker exited before ready${exitCode === null ? "" : ` (${String(exitCode)})`}`,
          }),
        )
      }),
    )
    const readyUrl = yield* Deferred.await(ready).pipe(
      Effect.timeout(Duration.millis(timeoutMs)),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new WorkerSupervisorError({
            message: `worker did not become ready within ${timeoutMs}ms`,
          }),
        ),
      ),
      Effect.ensuring(Fiber.interrupt(watcherFiber)),
      Effect.ensuring(Fiber.interrupt(exitWatcherFiber)),
    )
    return yield* parseWorkerReadyUrl(readyUrl)
  })

const isRetryableStartupError = (error: WorkerSupervisorError): boolean =>
  error.message === "worker stdout closed before ready" ||
  error.message.startsWith("worker exited before ready") ||
  error.message.startsWith("failed to read worker readiness:")

const parseWorkerReadyUrl = (
  baseUrl: string,
): Effect.Effect<WorkerEndpoint, WorkerSupervisorError> =>
  Effect.try({
    try: () => {
      const parsed = new URL(baseUrl)
      const port = Number(parsed.port)
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`worker ready URL did not include a concrete port: ${baseUrl}`)
      }
      const hostname = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname
      const host = hostname.includes(":") ? `[${hostname}]` : hostname
      return { port, url: `${parsed.protocol}//${host}:${port}/rpc` }
    },
    catch: (error) =>
      new WorkerSupervisorError({
        message: `invalid worker ready URL: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })

const startupErrorFromCause = (
  cause: Cause.Cause<WorkerSupervisorError>,
): WorkerSupervisorError => {
  const squashed = Cause.squash(cause)
  return Schema.is(WorkerSupervisorError)(squashed)
    ? squashed
    : new WorkerSupervisorError({ message: String(squashed) })
}

interface WorkerEndpoint {
  readonly port: number
  readonly url: string
}

interface SpawnedWorker<Proc extends { readonly pid: number }> {
  readonly proc: Proc
}

interface StartedWorker<Proc extends { readonly pid: number }> extends WorkerEndpoint {
  readonly proc: Proc
}

interface LaunchWorkerUntilReadyOptions<Proc extends { readonly pid: number }, R = never> {
  readonly maxAttempts?: number
  readonly retryDelayMs?: number
  readonly spawn: Effect.Effect<SpawnedWorker<Proc>, WorkerSupervisorError, R>
  readonly waitForReady: (
    launched: SpawnedWorker<Proc>,
  ) => Effect.Effect<WorkerEndpoint, WorkerSupervisorError>
  readonly stop: (proc: Proc) => Effect.Effect<void>
  readonly setCurrent: (proc: Proc | undefined) => void
  readonly isCurrent: (proc: Proc) => boolean
  readonly isStopped: () => boolean
  readonly logRetry: (input: {
    readonly attempt: number
    readonly pid: number
    readonly error: string
  }) => void
}

const launchWorkerUntilReady = <Proc extends { readonly pid: number }, R = never>(
  options: LaunchWorkerUntilReadyOptions<Proc, R>,
): Effect.Effect<StartedWorker<Proc> | undefined, WorkerSupervisorError, R> =>
  Effect.gen(function* () {
    const maxAttempts = options.maxAttempts ?? STARTUP_MAX_ATTEMPTS
    const retryDelayMs = options.retryDelayMs ?? STARTUP_RETRY_DELAY_MS
    let lastFailure: { readonly pid: number; readonly error: WorkerSupervisorError } | undefined
    const retryPolicy = Schedule.fromStepWithMetadata<
      WorkerSupervisorError,
      number,
      never,
      never,
      never,
      never
    >(
      Effect.succeed((meta: Schedule.InputMetadata<WorkerSupervisorError>) => {
        if (meta.attempt >= maxAttempts || !isRetryableStartupError(meta.input)) {
          return Cause.done(meta.attempt)
        }
        options.logRetry({
          attempt: meta.attempt,
          pid: lastFailure?.pid ?? 0,
          error: meta.input.message,
        })
        return Effect.succeed([meta.attempt, Duration.millis(retryDelayMs * meta.attempt)] as [
          number,
          Duration.Duration,
        ])
      }),
    )

    const launchWithCleanup: Effect.Effect<
      StartedWorker<Proc> | undefined,
      WorkerSupervisorError,
      R
    > = Effect.gen(function* () {
      const launched = yield* options.spawn
      options.setCurrent(launched.proc)
      const readyExit = yield* options.waitForReady(launched).pipe(Effect.exit)
      if (Exit.isSuccess(readyExit)) return { ...readyExit.value, proc: launched.proc }

      const startupError = startupErrorFromCause(readyExit.cause)
      lastFailure = { pid: launched.proc.pid, error: startupError }
      yield* options.stop(launched.proc)
      if (options.isCurrent(launched.proc)) options.setCurrent(undefined)

      if (options.isStopped()) return undefined
      return yield* startupError
    })

    return yield* Effect.retry(launchWithCleanup, {
      schedule: retryPolicy,
      while: isRetryableStartupError,
    }).pipe(
      Effect.mapError(
        (startupError) =>
          new WorkerSupervisorError({
            message: isRetryableStartupError(startupError)
              ? `worker did not become ready after ${maxAttempts} attempts: ${startupError.message}`
              : startupError.message,
          }),
      ),
    )
  })

import { getLogPaths } from "@gent/core/runtime/log-paths"

const ShutdownLogJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const shutdownLog = (msg: string, data?: Record<string, unknown>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ts = (yield* DateTime.nowAsDate).toISOString()
    const fs = yield* FileSystem.FileSystem
    const entry = { ts, level: "info", source: "supervisor", msg, ...data }
    yield* fs
      .writeFileString(getLogPaths().client, ShutdownLogJson(entry) + "\n", { flag: "a" })
      .pipe(Effect.ignore)
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off shutdown logging seam, isolated FS effect
    Effect.provide(BunFileSystem.layer),
  )

/** A live worker subprocess: handle + per-handle scope + last observed exit code. */
interface WorkerProcess {
  readonly pid: number
  readonly handle: ChildProcessSpawner.ChildProcessHandle
  readonly handleScope: Scope.Closeable
  readonly exitCodeRef: { exitCode: number | null }
  readonly exitWatcher: Fiber.Fiber<void, never>
}

/**
 * Stop a worker subprocess. SIGTERM first, then SIGKILL after
 * `SHUTDOWN_TIMEOUT_MS` if the process is still alive.
 *
 * NOTE: `handle.kill({ forceKillAfter })` from `effect/unstable/process`
 * applies the timeout to the *signal-send* operation, not to the wait
 * for the process to exit. Workers that trap SIGTERM (e.g. for graceful
 * shutdown) would hang `handle.kill` indefinitely. We bound the wait
 * ourselves and fall back to a raw `process.kill(pid, "SIGKILL")`.
 */
const stopWorker = (proc: WorkerProcess): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* shutdownLog("stop.start", { pid: proc.pid, exitCode: proc.exitCodeRef.exitCode })
    if (proc.exitCodeRef.exitCode !== null) {
      yield* Scope.close(proc.handleScope, Exit.void).pipe(Effect.ignore)
      return
    }

    // SIGTERM via the handle; bound the exit-wait so trapped workers can be force-killed.
    const sigterm = proc.handle.kill({ killSignal: "SIGTERM" }).pipe(
      Effect.timeout(Duration.millis(SHUTDOWN_TIMEOUT_MS)),
      Effect.catchTag("TimeoutError", () =>
        Effect.gen(function* () {
          yield* shutdownLog("stop.timeout", { pid: proc.pid })
          // Direct SIGKILL — bypass the handle so we don't re-await the same Deferred
          yield* Effect.sync(() => {
            try {
              process.kill(proc.pid, "SIGKILL")
            } catch {}
          })
          // Now wait for exit, bounded again
          yield* proc.handle.exitCode.pipe(
            Effect.timeout(Duration.millis(SHUTDOWN_TIMEOUT_MS)),
            Effect.catchTag("TimeoutError", () => Effect.void),
            Effect.catchEager(() => Effect.void),
          )
        }),
      ),
      Effect.catchEager((err) =>
        shutdownLog("stop.kill-failed", { pid: proc.pid, error: String(err) }),
      ),
    )
    yield* sigterm
    yield* shutdownLog("stop.killed", { pid: proc.pid })
    yield* Fiber.interrupt(proc.exitWatcher).pipe(Effect.ignore)
    yield* Scope.close(proc.handleScope, Exit.void).pipe(Effect.ignore)
  }).pipe(Effect.catchEager(() => Effect.void))

const killWorkerSync = (proc: WorkerProcess | undefined) => {
  if (proc === undefined || proc.exitCodeRef.exitCode !== null) return
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
  port: number | undefined,
): Effect.Effect<
  SpawnedWorker<WorkerProcess>,
  WorkerSupervisorError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const mode = options.mode ?? "default"
    const launch = yield* Effect.promise(() => resolveWorkerLaunch())
    const env = {
      ...process.env,
      ...options.env,
      GENT_PORT: String(port ?? 0),
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
    const handleScope = yield* Scope.make()
    const handle = yield* ChildProcess.make(launch.runtimePath, [launch.serverEntryPath], {
      cwd: options.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    })
      .asEffect()
      .pipe(
        Scope.provide(handleScope),
        Effect.mapError(
          (err) => new WorkerSupervisorError({ message: `failed to spawn worker: ${String(err)}` }),
        ),
        Effect.tapError(() => Scope.close(handleScope, Exit.void).pipe(Effect.ignore)),
      )

    const exitCodeRef = { exitCode: null as number | null }
    const exitWatcher = yield* Effect.forkDetach(
      handle.exitCode.pipe(
        Effect.tap((code) =>
          Effect.sync(() => {
            exitCodeRef.exitCode = Number(code)
          }),
        ),
        Effect.asVoid,
        Effect.catchEager(() => Effect.void),
      ),
    )

    const proc: WorkerProcess = {
      pid: Number(handle.pid),
      handle,
      handleScope,
      exitCodeRef,
      exitWatcher,
    }
    return { proc }
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
      const supervisorServices = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>()
      const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
      const listeners = new Set<(state: WorkerLifecycleState) => void>()
      let restartCount = 0
      let stopped = false
      const restartTimestamps: number[] = []
      let current: WorkerProcess | undefined
      let endpoint: WorkerEndpoint | undefined
      let restartPromise: Promise<void> | undefined
      let state: WorkerLifecycleState = {
        _tag: "starting",
        port: UNKNOWN_WORKER_PORT,
        restartCount,
      }
      const isShared = options.shared === true
      const handleProcessExit = () => {
        killWorkerSync(current)
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

      const launchCurrent: Effect.Effect<
        void,
        WorkerSupervisorError,
        ChildProcessSpawner.ChildProcessSpawner
      > = Effect.gen(function* () {
        const readyWorker = yield* launchWorkerUntilReady<
          WorkerProcess,
          ChildProcessSpawner.ChildProcessSpawner
        >({
          spawn: spawnWorkerProcess(options, endpoint?.port),
          waitForReady: (launched) => waitForWorkerReady(launched.proc, startupTimeoutMs),
          stop: stopWorker,
          setCurrent: (proc) => {
            current = proc
          },
          isCurrent: (proc) => current?.pid === proc.pid,
          isStopped: () => stopped,
          logRetry: (input) =>
            shutdownLog("launch.retry", {
              attempt: input.attempt,
              pid: input.pid,
              error: input.error,
            }),
        })
        if (readyWorker === undefined) return

        endpoint = { port: readyWorker.port, url: readyWorker.url }
        restartPromise = undefined
        emit({
          _tag: "running",
          port: endpoint.port,
          pid: readyWorker.proc.pid,
          restartCount,
        })

        // Watch for unexpected exits to trigger restart. Forked detached so
        // the supervisor's acquireRelease body completes; the watcher is
        // interrupted when the supervisor scope closes.
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const code = yield* readyWorker.proc.handle.exitCode.pipe(
              Effect.orElseSucceed(() => null as number | null),
            )
            if (stopped) return
            if (current?.pid !== readyWorker.proc.pid) return

            // Shared mode: exit code 0 is intentional idle shutdown — don't restart
            if (isShared && code === 0) {
              stopped = true
              emit({
                _tag: "stopped",
                port: endpoint?.port ?? UNKNOWN_WORKER_PORT,
                restartCount,
              })
              return
            }

            yield* Effect.sync(() =>
              runSupervisorCrashRestart(
                supervisorServices,
                restartInternal({
                  exitCode: code === null ? null : Number(code),
                  previousPid: readyWorker.proc.pid,
                }),
              ),
            )
          }),
        )
      })

      const restartInternal: (input?: {
        exitCode: number | null
        previousPid: number | undefined
      }) => Effect.Effect<void, WorkerSupervisorError, ChildProcessSpawner.ChildProcessSpawner> =
        Effect.fn("WorkerSupervisor.restartInternal")(function* (input?: {
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
                port: endpoint?.port ?? UNKNOWN_WORKER_PORT,
                restartCount,
                message: `Crash loop: ${restartTimestamps.length} restarts in ${RESTART_WINDOW_MS / 1000}s`,
                exitCode: input.exitCode,
              })
              return
            }
          }

          emit({
            _tag: "restarting",
            port: endpoint?.port ?? UNKNOWN_WORKER_PORT,
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
                yield* stopWorker(proc)
              }
              yield* launchCurrent
            }).pipe(
              Effect.catchEager((error) =>
                Effect.andThen(
                  Effect.sync(() => {
                    restartPromise = undefined
                    emit({
                      _tag: "failed",
                      port: endpoint?.port ?? UNKNOWN_WORKER_PORT,
                      restartCount,
                      message: error.message,
                      exitCode: input?.exitCode ?? current?.exitCodeRef.exitCode ?? null,
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
            if (proc !== undefined) yield* stopWorker(proc)
            return yield* error
          }),
        ),
      )

      const stop = Effect.gen(function* () {
        yield* shutdownLog("supervisor.stop.enter")
        if (stopped) return
        stopped = true
        disarmProcessExit()
        const proc = current
        current = undefined
        if (proc !== undefined) yield* stopWorker(proc)
        emit({
          _tag: "stopped",
          port: endpoint?.port ?? UNKNOWN_WORKER_PORT,
          restartCount,
        })
        yield* shutdownLog("supervisor.stop.done")
      }).pipe(Effect.catchEager(() => Effect.void))

      return {
        get url() {
          return endpoint?.url ?? "http://127.0.0.1:0/rpc"
        },
        get port() {
          return endpoint?.port ?? UNKNOWN_WORKER_PORT
        },
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
        restart: Effect.provide(restartInternal(), supervisorServices),
      } satisfies WorkerSupervisor
    }),
    (supervisor) => supervisor.stop,
    // Provide BunServices so callers don't have to wire ChildProcessSpawner
    // explicitly. Matches the `Gent.server` ergonomics — the SDK is the
    // platform-bun edge.
    // @effect-diagnostics-next-line strictEffectProvide:off
  ).pipe(Effect.provide(BunServices.layer))

export const WorkerSupervisorInternal = {
  isRetryableStartupError,
  launchWorkerUntilReady,
  resolveWorkerLaunch,
} as const
