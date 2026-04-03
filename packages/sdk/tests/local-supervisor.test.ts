import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Gent } from "../src/index"

const tempDirs: string[] = []
const repoRoot = path.resolve(import.meta.dir, "../../..")

const makeTempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gent-local-supervisor-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe("Gent.local", () => {
  test("restarts the in-process runtime and keeps the client facade alive", async () => {
    const dataDir = makeTempDir()
    const states: string[] = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bundle = yield* Gent.local({
            cwd: repoRoot,
            home: dataDir,
            dataDir,
            persistenceMode: "memory",
            providerMode: "debug-scripted",
          })

          const unsubscribe = bundle.runtime.lifecycle.subscribe((state) => {
            states.push(state._tag)
          })

          const createdBeforeRestart = yield* bundle.client.session.create({ cwd: repoRoot })
          expect(createdBeforeRestart.sessionId).toBeDefined()
          expect(bundle.runtime.lifecycle.getState()).toEqual({
            _tag: "connected",
            generation: 0,
          })

          yield* bundle.runtime.lifecycle.restart
          yield* bundle.runtime.lifecycle.waitForReady

          const createdAfterRestart = yield* bundle.client.session.create({ cwd: repoRoot })
          expect(createdAfterRestart.sessionId).toBeDefined()
          expect(bundle.runtime.lifecycle.getState()).toEqual({
            _tag: "connected",
            generation: 1,
          })

          unsubscribe()
        }),
      ),
    )

    expect(states).toContain("connected")
    expect(states).toContain("reconnecting")
  })
})
