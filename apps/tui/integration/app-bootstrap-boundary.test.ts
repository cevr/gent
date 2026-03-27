import { afterEach, describe, expect, test } from "bun:test"
import { Duration, Effect, Option } from "effect"
import * as path from "node:path"
import { resolveInitialState } from "../src/app-bootstrap"
import { createTempDirFixture, createWorkerEnv } from "@gent/core/test-utils/fixtures"
import { Gent } from "@gent/sdk"
import { startWorkerSupervisor } from "@gent/sdk/supervisor"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-bootstrap-")

// PID reaper — SIGTERM any orphaned workers after each test
const trackedPids = new Set<number>()
afterEach(() => {
  for (const pid of trackedPids) {
    try {
      process.kill(pid, 0)
      process.kill(pid, "SIGTERM")
    } catch {
      // already dead
    }
  }
  trackedPids.clear()
})

const spawnWithTracking = (options: { cwd: string; env?: Record<string, string> }) =>
  Effect.gen(function* () {
    const supervisor = yield* startWorkerSupervisor(options).pipe(
      Effect.mapError((e) => new Error(e.message)),
    )
    const pid = supervisor.pid()
    if (pid !== null) trackedPids.add(pid)
    yield* Effect.addFinalizer(() => supervisor.stop)
    const client = yield* Gent.connect({ url: supervisor.url })
    return client
  })

describe("app bootstrap boundary", () => {
  test("continue mode resumes the latest worker-backed session for cwd", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* spawnWithTracking({
            cwd: repoRoot,
            env: createWorkerEnv(root, { providerMode: "debug-scripted" }),
          })

          const first = yield* client.createSession({ cwd: repoRoot, bypass: true })
          yield* Effect.sleep("5 millis")
          const second = yield* client.createSession({ cwd: repoRoot, bypass: false })

          const state = yield* resolveInitialState({
            client: client,
            cwd: repoRoot,
            session: Option.none(),
            continue_: true,
            headless: false,
            prompt: Option.none(),
            promptArg: Option.none(),
            bypass: true,
          })

          expect(state._tag).toBe("session")
          if (state._tag !== "session") return
          expect(state.session.id).toBe(second.sessionId)
          expect(state.session.id).not.toBe(first.sessionId)
        }).pipe(Effect.timeout(Duration.seconds(10))),
      ),
    )
  }, 15_000)

  test("continue mode creates a worker-backed session from prompt when none exists", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* spawnWithTracking({
            cwd: repoRoot,
            env: createWorkerEnv(root, { providerMode: "debug-scripted" }),
          })

          const state = yield* resolveInitialState({
            client: client,
            cwd: repoRoot,
            session: Option.none(),
            continue_: true,
            headless: false,
            prompt: Option.some("bootstrap prompt"),
            promptArg: Option.none(),
            bypass: true,
          })

          expect(state._tag).toBe("session")
          if (state._tag !== "session") return
          expect(state.prompt).toBe("bootstrap prompt")
          expect(state.session.branchId).toBeDefined()
        }).pipe(Effect.timeout(Duration.seconds(10))),
      ),
    )
  }, 15_000)
})
