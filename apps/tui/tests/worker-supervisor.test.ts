import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  startWorkerSupervisor,
  type WorkerLifecycleState,
  WorkerSupervisorInternal,
} from "../src/worker/supervisor"

const repoRoot = path.resolve(import.meta.dir, "../../..")

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
  }
})

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-worker-"))
  tempDirs.push(dir)
  return dir
}

const waitForRunning = async (
  worker: {
    getState: () => WorkerLifecycleState
    subscribe: (listener: (state: WorkerLifecycleState) => void) => () => void
  },
  expectedRestartCount: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`worker did not reach running state ${expectedRestartCount}`))
    }, 10_000)
    const unsubscribe = worker.subscribe((state) => {
      if (state._tag !== "running" || state.restartCount !== expectedRestartCount) return
      clearTimeout(timeout)
      unsubscribe()
      resolve()
    })
  })

describe("worker supervisor", () => {
  test("compiled binary launch resolves bun runtime and on-disk server entry", async () => {
    const launch = await WorkerSupervisorInternal.resolveWorkerLaunch({
      sourceEntryPath: "/$bunfs/root/apps/server/src/main.ts",
      execPath: "/repo/apps/tui/bin/gent",
      sourceExists: async (candidate) => candidate === "/repo/apps/server/src/main.ts",
      which: () => "/usr/local/bin/bun",
    })

    expect(launch.runtimePath).toBe("/usr/local/bin/bun")
    expect(launch.serverEntryPath).toBe("/repo/apps/server/src/main.ts")
  })

  test("boots worker and serves the shared client contract", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerSupervisor({
            cwd: repoRoot,
            env: { GENT_DATA_DIR: dataDir },
          })

          expect(worker.getState()._tag).toBe("running")

          const initial = yield* worker.client.listSessions()
          expect(initial).toEqual([])

          const created = yield* worker.client.createSession({
            cwd: repoRoot,
            bypass: true,
          })

          const sessions = yield* worker.client.listSessions()
          expect(sessions.some((session) => session.id === created.sessionId)).toBe(true)
        }),
      ),
    )
  })

  test("restarts the worker on the same transport url", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerSupervisor({
            cwd: repoRoot,
            env: { GENT_DATA_DIR: dataDir },
          })
          const originalUrl = worker.url

          const created = yield* worker.client.createSession({
            cwd: repoRoot,
            bypass: true,
          })

          yield* worker.restart

          expect(worker.url).toBe(originalUrl)
          const state = worker.getState()
          expect(state._tag).toBe("running")
          if (state._tag === "running") expect(state.restartCount).toBe(1)

          const sessions = yield* worker.client.listSessions()
          expect(sessions.some((session) => session.id === created.sessionId)).toBe(true)
        }),
      ),
    )
  })

  test("auto-restarts after worker death and keeps serving the same session state", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerSupervisor({
            cwd: repoRoot,
            env: { GENT_DATA_DIR: dataDir },
          })

          const created = yield* worker.client.createSession({
            cwd: repoRoot,
            bypass: true,
          })
          const pid = worker.pid()

          expect(pid).not.toBeNull()
          process.kill(pid!, "SIGKILL")

          yield* Effect.promise(() => waitForRunning(worker, 1))

          expect(worker.url).toBe(`http://127.0.0.1:${worker.port}/rpc`)

          const sessions = yield* worker.client.listSessions()
          expect(sessions.some((session) => session.id === created.sessionId)).toBe(true)
        }),
      ),
    )
  })

  test("debug mode keeps the worker transport seam with ephemeral runtime state", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerSupervisor({
            cwd: repoRoot,
            mode: "debug",
          })

          const sessions = yield* worker.client.listSessions()
          expect(sessions.length).toBeGreaterThanOrEqual(1)
          expect(sessions.some((session) => session.name === "debug scenario")).toBe(true)
        }),
      ),
    )
  }, 15_000)

  test("stop tears down the spawned worker process", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerSupervisor({
            cwd: repoRoot,
            env: { GENT_DATA_DIR: dataDir },
          })

          const pid = worker.pid()
          expect(pid).not.toBeNull()

          yield* worker.stop

          expect(worker.getState()._tag).toBe("stopped")
          expect(() => process.kill(pid!, 0)).toThrow()
        }),
      ),
    )
  })
})
