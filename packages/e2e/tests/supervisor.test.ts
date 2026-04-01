/**
 * Worker supervisor lifecycle tests.
 *
 * Every test here MUST need real subprocess isolation (restart, SIGKILL,
 * process cleanup). Transport/runtime behavior that can be tested in-process
 * belongs in test:integration (event-stream-parity, watch-state-parity, etc).
 */
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Option, Stream } from "effect"
import * as path from "node:path"
import { extractText } from "@gent/sdk"
import { type WorkerLifecycleState, WorkerSupervisorInternal } from "@gent/sdk/supervisor"
import {
  createTempDirFixture,
  createWorkerEnv,
  startWorkerWithSupervisor,
  waitFor,
  waitForRpcReady,
} from "./seam-fixture"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-worker-")

const waitForRunning = async (
  worker: {
    getState: () => WorkerLifecycleState
    subscribe: (listener: (state: WorkerLifecycleState) => void) => () => void
  },
  expectedRestartCount: number,
  timeoutMs = 15_000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      const state = worker.getState()
      reject(
        new Error(
          `worker did not reach running state ${expectedRestartCount} within ${timeoutMs}ms (current: ${state._tag}, restartCount: ${"restartCount" in state ? state.restartCount : "N/A"})`,
        ),
      )
    }, timeoutMs)
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

  test("restarts the worker on the same transport url", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithSupervisor({
            cwd: repoRoot,
            env: { GENT_DATA_DIR: dataDir },
          })
          const originalUrl = worker.url

          const created = yield* worker.client.session.create({
            cwd: repoRoot,
            bypass: true,
          })

          yield* worker.restart
          yield* waitForRpcReady(worker.client)

          expect(worker.url).toBe(originalUrl)
          const state = worker.getState()
          expect(state._tag).toBe("running")
          if (state._tag === "running") expect(state.restartCount).toBe(1)

          const sessions = yield* worker.client.session.list()
          expect(sessions.some((session) => session.id === created.sessionId)).toBe(true)
        }),
      ),
    )
  }, 15_000)

  test("auto-restarts after worker death and keeps serving the same session state", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithSupervisor({
            cwd: repoRoot,
            startupTimeoutMs: 20_000,
            env: { GENT_DATA_DIR: dataDir },
          })

          const created = yield* worker.client.session.create({
            cwd: repoRoot,
            bypass: true,
          })
          const pid = worker.pid()

          expect(pid).not.toBeNull()
          process.kill(pid!, "SIGKILL")

          yield* Effect.promise(() => waitForRunning(worker, 1))
          yield* waitForRpcReady(worker.client)

          expect(worker.url).toBe(`http://127.0.0.1:${worker.port}/rpc`)

          const sessions = yield* worker.client.session.list()
          expect(sessions.some((session) => session.id === created.sessionId)).toBe(true)
        }),
      ),
    )
  })

  test("watchRuntime can resubscribe after worker restart", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithSupervisor({
            cwd: repoRoot,
            startupTimeoutMs: 20_000,
            env: { GENT_DATA_DIR: dataDir },
          })

          const created = yield* worker.client.session.create({
            cwd: repoRoot,
            bypass: true,
          })

          const pid = worker.pid()
          expect(pid).not.toBeNull()
          process.kill(pid!, "SIGKILL")

          yield* Effect.promise(() => waitForRunning(worker, 1, 20_000))
          yield* waitForRpcReady(worker.client)

          const states = yield* Deferred.make<string>()

          yield* Effect.forever(
            Effect.gen(function* () {
              yield* worker.client.session
                .watchRuntime({
                  sessionId: created.sessionId,
                  branchId: created.branchId,
                })
                .pipe(
                  Stream.runForEach((state) =>
                    state.status === "idle" && state.queue.followUp.length === 0
                      ? Deferred.succeed(states, created.sessionId).pipe(Effect.ignore)
                      : Effect.void,
                  ),
                  Effect.catchEager(() => Effect.void),
                )
              yield* Effect.sleep("100 millis")
            }),
          ).pipe(Effect.forkScoped)

          const sessionId = yield* Deferred.await(states).pipe(
            Effect.timeoutOption("10 seconds"),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new Error("watchRuntime did not resume after worker restart")),
                onSome: Effect.succeed,
              }),
            ),
          )

          expect(sessionId).toBe(created.sessionId)
        }),
      ),
    )
  }, 30_000)

  test("persists file-backed auth visibility through worker restart", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithSupervisor({
            cwd: repoRoot,
            startupTimeoutMs: 20_000,
            env: createWorkerEnv(root),
          })

          yield* worker.client.auth.setKey({ provider: "anthropic", key: "test-anthropic-key" })

          const beforeRestart = yield* waitFor(worker.client.auth.listProviders(), (providers) =>
            providers.some((provider) => provider.provider === "anthropic" && provider.hasKey),
          )
          expect(beforeRestart.find((provider) => provider.provider === "anthropic")).toMatchObject(
            { hasKey: true, source: "stored" },
          )

          yield* worker.restart
          yield* waitForRpcReady(worker.client)

          const afterRestart = yield* waitFor(
            worker.client.auth.listProviders(),
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
  }, 15_000)

  test("restart with steer and follow-up queued converges to steer before follow-up", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const logFile = `${root}/worker.log`
          const worker = yield* startWorkerWithSupervisor({
            cwd: repoRoot,
            startupTimeoutMs: 20_000,
            env: createWorkerEnv(root, {
              providerMode: "debug-slow",
              extra: { GENT_LOG_FILE: logFile },
            }),
          })

          const created = yield* worker.client.session.create({
            cwd: repoRoot,
            bypass: true,
          })

          yield* worker.client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "first turn",
          })

          yield* waitFor(
            worker.client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) => snapshot.followUp.length === 0 && snapshot.steering.length === 0,
            15_000,
            "first turn acceptance before restart setup",
          )

          yield* worker.client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued follow-up",
          })

          yield* worker.client.steer.command({
            command: {
              _tag: "Interject",
              sessionId: created.sessionId,
              branchId: created.branchId,
              message: "urgent steer",
            },
          })

          const queuedBeforeRestart = yield* waitFor(
            worker.client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) =>
              snapshot.steering.some((entry) => entry.content.includes("urgent steer")) &&
              snapshot.followUp.some((entry) => entry.content.includes("queued follow-up")),
            15_000,
            "queued steer and follow-up before worker restart",
          )

          expect(queuedBeforeRestart.steering[0]?.content).toContain("urgent steer")
          expect(queuedBeforeRestart.followUp[0]?.content).toContain("queued follow-up")

          const pid = worker.pid()
          expect(pid).not.toBeNull()
          process.kill(pid!, "SIGKILL")

          yield* Effect.promise(() => waitForRunning(worker, 1, 30_000))
          yield* waitForRpcReady(worker.client)

          yield* waitFor(
            worker.client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            () => true,
            10_000,
            "loop restoration trigger after restart",
          )

          const messages = yield* waitFor(
            worker.client.message.list({ branchId: created.branchId }),
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
            30_000,
            "replayed user message order after worker restart",
          )

          const userTexts = messages
            .filter((message) => message.role === "user")
            .map((message) => extractText(message.parts))
            .filter((text) => ["first turn", "urgent steer", "queued follow-up"].includes(text))

          expect(userTexts).toEqual(["first turn", "urgent steer", "queued follow-up"])

          const settledQueue = yield* waitFor(
            worker.client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) => snapshot.steering.length === 0 && snapshot.followUp.length === 0,
            15_000,
            "queue to drain after worker restart",
          )

          expect(settledQueue.steering).toEqual([])
          expect(settledQueue.followUp).toEqual([])
        }),
      ),
    )
  }, 60_000)

  test("streamEvents with latest cursor delivers future events after worker restart", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithSupervisor({
            cwd: repoRoot,
            startupTimeoutMs: 20_000,
            env: { GENT_DATA_DIR: dataDir },
          })

          const created = yield* worker.client.session.create({
            cwd: repoRoot,
            bypass: true,
          })

          yield* worker.restart
          yield* waitForRpcReady(worker.client)

          const snapshot = yield* worker.client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })

          const firstLiveEvent = yield* Deferred.make<string>()

          yield* worker.client.session
            .events({
              sessionId: created.sessionId,
              after: snapshot.lastEventId ?? undefined,
            })
            .pipe(
              Stream.runForEach((envelope) =>
                envelope.event._tag === "BranchCreated"
                  ? Deferred.succeed(firstLiveEvent, envelope.event._tag).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.forkScoped,
            )

          yield* worker.client.branch.create({
            sessionId: created.sessionId,
            name: "after-restart-live",
          })

          const tag = yield* Deferred.await(firstLiveEvent).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new Error("worker did not deliver a live-only event after restart")),
                onSome: Effect.succeed,
              }),
            ),
          )

          expect(tag).toBe("BranchCreated")
        }),
      ),
    )
  }, 15_000)

  test("stop tears down the spawned worker process", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithSupervisor({
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

  test("scope close cleans up worker — no orphan processes", async () => {
    const dataDir = makeTempDir()
    let capturedPid: number | null = null

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithSupervisor({
            cwd: repoRoot,
            env: { GENT_DATA_DIR: dataDir },
          })
          capturedPid = worker.pid()
          expect(capturedPid).not.toBeNull()
        }),
      ),
    )

    expect(capturedPid).not.toBeNull()
    await Bun.sleep(500)
    expect(() => process.kill(capturedPid!, 0)).toThrow()
  })
})
