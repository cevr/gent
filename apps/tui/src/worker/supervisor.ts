import { Effect, Schema, type Scope } from "effect"
import { makeHttpGentClient, type GentClient } from "@gent/sdk"
import * as net from "node:net"
import { pathToFileURL } from "node:url"

export class WorkerSupervisorError extends Schema.TaggedErrorClass<WorkerSupervisorError>()(
  "WorkerSupervisorError",
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

export interface WorkerSupervisorOptions {
  readonly cwd: string
  readonly env?: Record<string, string | undefined>
  readonly startupTimeoutMs?: number
  readonly mode?: "default" | "debug"
}

export interface WorkerTransportTarget {
  readonly url: string
}

const SERVER_ENTRY_PATH = new URL("../../../server/src/main.ts", import.meta.url).pathname
const WORKER_HOST = "127.0.0.1"
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 3_000

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

const findOpenPort = (): Promise<number> =>
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
  url: string,
  timeoutMs: number,
): Effect.Effect<void, WorkerSupervisorError> =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMs
    const poll = async (): Promise<void> => {
      if (Date.now() >= deadline) {
        throw new WorkerSupervisorError({
          message: `worker did not become ready within ${timeoutMs}ms`,
        })
      }
      try {
        const response = await fetch(url.replace(/\/rpc$/, "/docs/openapi.json"))
        if (response.ok) return
      } catch {
        // still booting
      }
      await Bun.sleep(100)
      return poll()
    }
    return poll()
  }).pipe(
    Effect.mapError((error) => {
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { readonly message: unknown }).message)
          : String(error)
      return new WorkerSupervisorError({ message })
    }),
  )

const stopSubprocess = (proc: Bun.Subprocess): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (proc.exitCode !== null) return
    try {
      process.kill(proc.pid, "SIGTERM")
    } catch {
      return
    }
    const exited = proc.exited.then(() => undefined)
    const timedOut = Bun.sleep(SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const)
    const result = await Promise.race([exited, timedOut])
    if (result === "timeout") {
      try {
        process.kill(proc.pid, "SIGKILL")
      } catch {
        return
      }
      await proc.exited
    }
  }).pipe(Effect.catchEager(() => Effect.void))

const killSubprocessSync = (proc: Bun.Subprocess | undefined) => {
  if (proc === undefined || proc.exitCode !== null) return
  try {
    process.kill(proc.pid, "SIGTERM")
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
      stdout: "ignore",
      stderr: "inherit",
    })
    return { port, url: `http://${WORKER_HOST}:${port}/rpc`, proc }
  })

export const startWorkerSupervisor = (
  options: WorkerSupervisorOptions,
): Effect.Effect<WorkerSupervisor, WorkerSupervisorError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
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
      let current: Bun.Subprocess | undefined
      let restartPromise: Promise<void> | undefined
      let state: WorkerLifecycleState = {
        _tag: "starting",
        port: assignedPort,
        restartCount,
      }
      const handleProcessExit = () => {
        killSubprocessSync(current)
      }

      process.on("exit", handleProcessExit)

      const emit = (next: WorkerLifecycleState) => {
        state = next
        for (const listener of listeners) listener(next)
      }

      const launchCurrent = Effect.gen(function* () {
        const launched = yield* spawnWorkerProcess(options, assignedPort)
        current = launched.proc
        yield* waitForWorkerReady(launched.url, startupTimeoutMs)
        restartPromise = undefined
        emit({
          _tag: "running",
          port: launched.port,
          pid: launched.proc.pid,
          restartCount,
        })

        void launched.proc.exited.then(() => {
          if (stopped) return
          if (current?.pid !== launched.proc.pid) return
          void Effect.runPromiseExit(
            restartInternal({ exitCode: launched.proc.exitCode, previousPid: launched.proc.pid }),
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
        emit({
          _tag: "restarting",
          port: assignedPort,
          restartCount,
          previousPid: input?.previousPid,
          exitCode: input?.exitCode ?? null,
        })

        restartPromise = Effect.runPromise(
          Effect.gen(function* () {
            const proc = current
            if (proc !== undefined) {
              yield* stopSubprocess(proc)
            }
            yield* launchCurrent
          }).pipe(
            Effect.catchEager((error) =>
              Effect.sync(() => {
                restartPromise = undefined
                emit({
                  _tag: "failed",
                  port: assignedPort,
                  restartCount,
                  message: error.message,
                  exitCode: input?.exitCode ?? current?.exitCode ?? null,
                })
                throw error
              }),
            ),
          ),
        )

        const inFlight = restartPromise
        yield* Effect.promise(() => inFlight)
      })

      yield* launchCurrent

      const stop = Effect.gen(function* () {
        if (stopped) return
        stopped = true
        process.off("exit", handleProcessExit)
        const proc = current
        current = undefined
        if (proc !== undefined) yield* stopSubprocess(proc)
        emit({ _tag: "stopped", port: assignedPort, restartCount })
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

export const makeWorkerHttpClient = (
  target: WorkerTransportTarget,
): Effect.Effect<GentClient, never, Scope.Scope> => makeHttpGentClient({ url: target.url })

export const WorkerSupervisorInternal = {
  resolveWorkerLaunch,
} as const
