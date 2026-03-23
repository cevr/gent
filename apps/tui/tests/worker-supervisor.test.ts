import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Option, Stream } from "effect"
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

const waitFor = <A>(
  effect: Effect.Effect<A, unknown>,
  predicate: (value: A) => boolean,
  timeoutMs = 5_000,
): Effect.Effect<A, Error> => {
  const deadline = Date.now() + timeoutMs

  const loop: Effect.Effect<A, Error> = Effect.gen(function* () {
    const value = yield* effect.pipe(Effect.mapError((error) => new Error(String(error))))
    if (predicate(value)) return value
    if (Date.now() >= deadline) return yield* Effect.fail(new Error("timed out waiting"))
    yield* Effect.sleep("100 millis")
    return yield* loop
  })

  return loop
}

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
          const debugSession = sessions.find((session) => session.name === "debug scenario")

          expect(sessions.length).toBeGreaterThanOrEqual(1)
          expect(debugSession).toBeDefined()
          expect(worker.url).toBe(`http://127.0.0.1:${worker.port}/rpc`)

          const state = yield* waitFor(
            worker.client.getSessionState({
              sessionId: debugSession!.id,
              branchId: debugSession!.branchId!,
            }),
            (sessionState) => sessionState.messages.length > 0,
            15_000,
          )

          expect(state.sessionId).toBe(debugSession!.id)
          expect(state.branchId).toBe(debugSession!.branchId)
          expect(state.messages.length).toBeGreaterThan(0)
        }),
      ),
    )
  }, 15_000)

  test("persists file-backed auth visibility through worker restart", async () => {
    const root = makeTempDir()
    const dataDir = path.join(root, "data")
    fs.mkdirSync(dataDir, { recursive: true })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerSupervisor({
            cwd: repoRoot,
            env: {
              GENT_DATA_DIR: dataDir,
              GENT_AUTH_FILE_PATH: path.join(root, "auth.enc"),
              GENT_AUTH_KEY_PATH: path.join(root, "auth.key"),
            },
          })

          yield* worker.client.setAuthKey("anthropic", "test-anthropic-key")

          const beforeRestart = yield* waitFor(worker.client.listAuthProviders(), (providers) =>
            providers.some((provider) => provider.provider === "anthropic" && provider.hasKey),
          )
          expect(beforeRestart.find((provider) => provider.provider === "anthropic")).toMatchObject(
            { hasKey: true, source: "stored" },
          )

          yield* worker.restart

          const afterRestart = yield* waitFor(
            worker.client.listAuthProviders(),
            (providers) =>
              providers.some((provider) => provider.provider === "anthropic" && provider.hasKey),
            10_000,
          )
          expect(afterRestart.find((provider) => provider.provider === "anthropic")).toMatchObject({
            hasKey: true,
            source: "stored",
          })
        }),
      ),
    )
  })

  test("restart preserves queued follow-up visibility while the active turn is retrying", async () => {
    const root = makeTempDir()
    const dataDir = path.join(root, "data")
    fs.mkdirSync(dataDir, { recursive: true })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerSupervisor({
            cwd: repoRoot,
            startupTimeoutMs: 20_000,
            env: {
              GENT_DATA_DIR: dataDir,
              GENT_PROVIDER_MODE: "debug-scripted",
              GENT_AUTH_FILE_PATH: path.join(root, "auth.enc"),
              GENT_AUTH_KEY_PATH: path.join(root, "auth.key"),
            },
          })

          const created = yield* worker.client.createSession({
            cwd: repoRoot,
            bypass: true,
          })

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "first",
          })

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued follow-up",
          })

          const queuedBeforeRestart = yield* waitFor(
            worker.client.getQueuedMessages({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) =>
              snapshot.followUp.some((entry) => entry.content.includes("queued follow-up")),
            10_000,
          )
          expect(queuedBeforeRestart.followUp).toHaveLength(1)

          const pid = worker.pid()
          expect(pid).not.toBeNull()
          process.kill(pid!, "SIGKILL")

          yield* Effect.promise(() => waitForRunning(worker, 1))

          const queuedAfterRestart = yield* waitFor(
            worker.client.getQueuedMessages({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) =>
              snapshot.followUp.some((entry) => entry.content.includes("queued follow-up")),
            10_000,
          )
          expect(queuedAfterRestart.followUp).toHaveLength(1)
          expect(queuedAfterRestart.followUp[0]?.content).toContain("queued follow-up")
        }),
      ),
    )
  }, 25_000)

  test("delivers live events after subscribeEvents is established", async () => {
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

          const firstLiveEvent = yield* Deferred.make<string>()

          yield* worker.client
            .subscribeEvents({
              sessionId: created.sessionId,
              branchId: created.branchId,
            })
            .pipe(
              Stream.runForEach((envelope) =>
                envelope.event._tag === "MessageReceived" || envelope.event._tag === "StreamStarted"
                  ? Deferred.succeed(firstLiveEvent, envelope.event._tag).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.forkScoped,
            )

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "hello",
          })

          const tag = yield* Deferred.await(firstLiveEvent).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new Error("worker did not deliver a live event after sendMessage")),
                onSome: Effect.succeed,
              }),
            ),
          )

          expect(["MessageReceived", "StreamStarted"]).toContain(tag)
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
