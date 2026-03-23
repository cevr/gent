import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { startWorkerSupervisor } from "../src/worker/supervisor"

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

describe("worker supervisor", () => {
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
})
