import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Option, Stream } from "effect"
import * as path from "node:path"
import { extractText } from "@gent/sdk"
import { type WorkerLifecycleState, WorkerSupervisorInternal } from "../src/worker/supervisor"
import {
  createTempDirFixture,
  createWorkerEnv,
  startWorkerWithClient,
  waitFor,
} from "../../../tests/seam-fixture"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-worker-")

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
          const worker = yield* startWorkerWithClient({
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
          const worker = yield* startWorkerWithClient({
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
          const worker = yield* startWorkerWithClient({
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
          const worker = yield* startWorkerWithClient({
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

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithClient({
            cwd: repoRoot,
            env: createWorkerEnv(root),
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

  test("restart with steer and follow-up queued converges to steer before follow-up", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithClient({
            cwd: repoRoot,
            startupTimeoutMs: 20_000,
            env: createWorkerEnv(root, { providerMode: "debug-slow" }),
          })

          const created = yield* worker.client.createSession({
            cwd: repoRoot,
            bypass: true,
          })

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "first turn",
          })

          yield* waitFor(
            worker.client.getSessionState({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (state) => state.isStreaming,
            10_000,
          )

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued follow-up",
          })

          yield* worker.client.steer({
            _tag: "Interject",
            sessionId: created.sessionId,
            branchId: created.branchId,
            message: "urgent steer",
          })

          const queuedBeforeRestart = yield* waitFor(
            worker.client.getQueuedMessages({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) =>
              snapshot.steering.some((entry) => entry.content.includes("urgent steer")) &&
              snapshot.followUp.some((entry) => entry.content.includes("queued follow-up")),
            10_000,
          )

          expect(queuedBeforeRestart.steering[0]?.content).toContain("urgent steer")
          expect(queuedBeforeRestart.followUp[0]?.content).toContain("queued follow-up")

          const pid = worker.pid()
          expect(pid).not.toBeNull()
          process.kill(pid!, "SIGKILL")

          yield* Effect.promise(() => waitForRunning(worker, 1))

          const messages = yield* waitFor(
            worker.client.listMessages(created.branchId),
            (items) => {
              const userTexts = items
                .filter((message) => message.role === "user")
                .map((message) => extractText(message.parts))
              return (
                userTexts.includes("first turn") &&
                userTexts.includes("urgent steer") &&
                userTexts.includes("queued follow-up")
              )
            },
            20_000,
          )

          const userTexts = messages
            .filter((message) => message.role === "user")
            .map((message) => extractText(message.parts))
            .filter((text) => ["first turn", "urgent steer", "queued follow-up"].includes(text))

          expect(userTexts).toEqual(["first turn", "urgent steer", "queued follow-up"])

          const settledQueue = yield* waitFor(
            worker.client.getQueuedMessages({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) => snapshot.steering.length === 0 && snapshot.followUp.length === 0,
            10_000,
          )

          expect(settledQueue.steering).toEqual([])
          expect(settledQueue.followUp).toEqual([])
        }),
      ),
    )
  }, 25_000)

  test("delivers live events after subscribeEvents is established", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithClient({
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
          const worker = yield* startWorkerWithClient({
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
