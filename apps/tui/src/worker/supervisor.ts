import { Effect, Schema, type Scope } from "effect"
import { makeHttpGentClient, type GentClient } from "@gent/sdk"
import * as net from "node:net"

export class WorkerSupervisorError extends Schema.TaggedErrorClass<WorkerSupervisorError>()(
  "WorkerSupervisorError",
  {
    message: Schema.String,
  },
) {}

export type WorkerLifecycleState =
  | { readonly _tag: "starting" }
  | { readonly _tag: "running"; readonly port: number; readonly restartCount: number }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "crashed"; readonly exitCode: number | null }

export interface WorkerSupervisor {
  readonly client: GentClient
  readonly url: string
  readonly port: number
  readonly getState: () => WorkerLifecycleState
  readonly stop: Effect.Effect<void, never>
  readonly restart: Effect.Effect<void, WorkerSupervisorError>
}

export interface WorkerSupervisorOptions {
  readonly cwd: string
  readonly env?: Record<string, string | undefined>
  readonly startupTimeoutMs?: number
}

const SERVER_ENTRY_PATH = new URL("../../../server/src/main.ts", import.meta.url).pathname
const WORKER_HOST = "127.0.0.1"
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 3_000

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
        // worker not ready yet
      }
      await Bun.sleep(100)
      return poll()
    }
    const deadline = Date.now() + timeoutMs
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

const spawnWorkerProcess = (
  options: WorkerSupervisorOptions,
  port: number,
): Effect.Effect<{ readonly port: number; readonly url: string; readonly proc: Bun.Subprocess }> =>
  Effect.sync(() => {
    const env = {
      ...Bun.env,
      ...options.env,
      GENT_PORT: String(port),
      GENT_SERVER_MODE: "worker",
      GENT_TRACE_ID: `worker-${Bun.randomUUIDv7()}`,
    }
    const proc = Bun.spawn([process.execPath, SERVER_ENTRY_PATH], {
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
      let state: WorkerLifecycleState = { _tag: "starting" }
      let restartCount = 0
      const assignedPort = yield* Effect.promise(findOpenPort).pipe(
        Effect.mapError(
          (error) =>
            new WorkerSupervisorError({
              message: `failed to allocate worker port: ${String(error)}`,
            }),
        ),
      )
      let current = yield* spawnWorkerProcess(options, assignedPort)

      const trackCrash = (proc: Bun.Subprocess) => {
        void proc.exited.then(() => {
          if (state._tag === "stopped") return
          state = { _tag: "crashed", exitCode: proc.exitCode }
        })
      }
      trackCrash(current.proc)

      yield* waitForWorkerReady(current.url, startupTimeoutMs)
      state = { _tag: "running", port: current.port, restartCount }

      const stop = stopSubprocess(current.proc).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            state = { _tag: "stopped" }
          }),
        ),
      )

      const restart: Effect.Effect<void, WorkerSupervisorError> = Effect.gen(function* () {
        yield* stopSubprocess(current.proc)
        restartCount += 1
        state = { _tag: "starting" }
        current = yield* spawnWorkerProcess(options, assignedPort)
        trackCrash(current.proc)
        yield* waitForWorkerReady(current.url, startupTimeoutMs)
        state = { _tag: "running", port: current.port, restartCount }
      })

      const client = yield* makeHttpGentClient({ url: current.url })

      return {
        client,
        url: current.url,
        port: current.port,
        getState: () => state,
        stop,
        restart,
      } satisfies WorkerSupervisor
    }),
    (supervisor) => supervisor.stop,
  )
