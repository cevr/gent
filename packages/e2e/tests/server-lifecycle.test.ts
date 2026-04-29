/**
 * Server lifecycle integration tests.
 * Tests identity route, connection tracking, idle shutdown, and reconnects.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit, Scope } from "effect"
import * as path from "node:path"
import { Gent } from "@gent/sdk"
import { startWorkerSupervisor } from "@gent/sdk/supervisor"
import { createTempDirFixture } from "./seam-fixture"
import { fromPromise, ignoreSyncDefect, sleepMillis } from "../src/effect-test-adapters"
import {
  killProcess,
  spawnIdleServer,
  spawnServerOnPort,
  waitForExit,
  waitUntil,
} from "../src/server-process-fixture"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-lifecycle-")
const randomLifecyclePort = () => 19_000 + Math.floor(Math.random() * 1000)

describe("server lifecycle", () => {
  it.live(
    "identity route returns server identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = makeTempDir()
          const supervisor = yield* startWorkerSupervisor({
            cwd: repoRoot,
            mode: "debug",
            env: { GENT_DATA_DIR: dataDir },
          })

          const baseUrl = supervisor.url.replace("/rpc", "")
          const response = yield* fromPromise(() => fetch(`${baseUrl}/_gent/identity`))
          expect(response.ok).toBe(true)

          const identity = yield* fromPromise(() => response.json())
          expect(identity.pid).toBe(supervisor.pid())
          expect(identity.hostname).toBeTruthy()
          expect(identity.dbPath).toBeTruthy()
          expect(identity.serverId).toBeTruthy()
          expect(identity.buildFingerprint).toBeTruthy()
          expect(identity.buildFingerprint).not.toBe("unknown")
        }),
      ),
    15_000,
  )

  it.live(
    "server.status RPC returns connection count and uptime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = makeTempDir()
          const supervisor = yield* startWorkerSupervisor({
            cwd: repoRoot,
            mode: "debug",
            env: { GENT_DATA_DIR: dataDir },
          })

          const bundle = yield* Gent.client(supervisor.url)
          yield* bundle.runtime.lifecycle.waitForReady
          const status = yield* bundle.client.server
            .status()
            .pipe(Effect.mapError((e) => new Error(String(e))))

          expect(status.pid).toBe(supervisor.pid() as never)
          expect(status.uptime).toBeGreaterThan(0)
          expect(status.connectionCount).toBeGreaterThanOrEqual(1)
          expect(status.buildFingerprint).toBeTruthy()
          expect(status.serverId).toBeTruthy()
        }),
      ),
    15_000,
  )

  it.live(
    "worker shuts down after idle timeout with no connections",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = makeTempDir()
          const idleTimeoutMs = 2_000
          const { url, proc } = yield* Effect.acquireRelease(
            spawnIdleServer({ dataDir, idleTimeoutMs, port: randomLifecyclePort() }),
            ({ proc }) => killProcess(proc),
          )

          const baseUrl = url.replace("/rpc", "")
          const identityResp = yield* fromPromise(() => fetch(`${baseUrl}/_gent/identity`))
          expect(identityResp.ok).toBe(true)

          const exitCode = yield* waitForExit(proc.pid, idleTimeoutMs + 5_000)
          expect(exitCode).toBe(0)
        }),
      ),
    15_000,
  )

  it.live(
    "two Gent.server calls with same dbPath share one server",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = makeTempDir()
          const dbPath = path.join(dataDir, "data.db")

          const server1 = yield* Gent.server({
            cwd: repoRoot,
            state: Gent.state.sqlite({ home: dataDir, dbPath }),
            provider: Gent.provider.mock(),
          })
          const bundle1 = yield* Gent.client(server1)

          const status1 = yield* bundle1.client.server
            .status()
            .pipe(Effect.mapError((e) => new Error(String(e))))
          const pid1 = status1.pid

          const server2 = yield* Gent.server({
            cwd: repoRoot,
            state: Gent.state.sqlite({ home: dataDir, dbPath }),
            provider: Gent.provider.mock(),
          })
          expect(server2._tag).toBe("attached")

          const baseUrl = server2.url.replace("/rpc", "")
          const response = yield* Effect.tryPromise(() => fetch(`${baseUrl}/_gent/identity`)).pipe(
            Effect.mapError((e) => new Error(String(e))),
          )
          const identity = yield* Effect.tryPromise(() => response.json()).pipe(
            Effect.mapError((e) => new Error(String(e))),
          )
          expect((identity as { pid: number }).pid).toBe(pid1)
        }),
      ),
    20_000,
  )

  it.live(
    "WS connection resets idle timer, shutdown triggers after disconnect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = makeTempDir()
          const idleTimeoutMs = 3_000
          const { url, proc } = yield* Effect.acquireRelease(
            spawnIdleServer({ dataDir, idleTimeoutMs, port: randomLifecyclePort() }),
            ({ proc }) => killProcess(proc),
          )

          yield* sleepMillis(idleTimeoutMs * 0.6)

          const clientScope = yield* Scope.make()
          const bundle = yield* Gent.client(url).pipe(
            Effect.provideService(Scope.Scope, clientScope),
          )
          yield* bundle.runtime.lifecycle.waitForReady

          const status = yield* bundle.client.server
            .status()
            .pipe(Effect.mapError((e) => new Error(String(e))))
          expect(status.connectionCount).toBeGreaterThanOrEqual(1)

          yield* sleepMillis(idleTimeoutMs * 0.6)
          expect(() => process.kill(proc.pid, 0)).not.toThrow()

          yield* Scope.close(clientScope, Exit.void)
          yield* sleepMillis(500)
          expect(() => process.kill(proc.pid, 0)).not.toThrow()

          const exitCode = yield* waitForExit(proc.pid, idleTimeoutMs + 5_000)
          expect(exitCode).toBe(0)
        }),
      ),
    20_000,
  )

  it.live(
    "WS client reconnects after server kill and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = makeTempDir()
          const port = randomLifecyclePort()
          const serverRef = yield* Effect.acquireRelease(
            spawnServerOnPort({ dataDir, port }).pipe(
              Effect.map((server) => ({ current: server })),
            ),
            (ref) => killProcess(ref.current.proc),
          )

          const clientScope = yield* Scope.make()
          const bundle = yield* Gent.client(serverRef.current.url).pipe(
            Effect.provideService(Scope.Scope, clientScope),
          )
          yield* bundle.runtime.lifecycle.waitForReady

          const states: string[] = []
          bundle.runtime.lifecycle.subscribe((s) => states.push(s._tag))

          const status1 = yield* bundle.client.server
            .status()
            .pipe(Effect.mapError((e) => new Error(String(e))))
          expect(status1.connectionCount).toBeGreaterThanOrEqual(1)
          expect(states).toContain("connected")

          serverRef.current.proc.kill("SIGTERM")
          yield* fromPromise(() => serverRef.current.proc.exited)

          const sawReconnecting = yield* waitUntil(() => states.includes("reconnecting"), 5_000)
          expect(sawReconnecting).toBe(true)

          serverRef.current = yield* spawnServerOnPort({ dataDir, port })

          const reconnected = yield* waitUntil(
            () => bundle.runtime.lifecycle.getState()._tag === "connected",
            10_000,
          )
          expect(reconnected).toBe(true)

          const status2 = yield* bundle.client.server
            .status()
            .pipe(Effect.mapError((e) => new Error(String(e))))
          expect(status2.connectionCount).toBeGreaterThanOrEqual(1)

          yield* Scope.close(clientScope, Exit.void)
          yield* ignoreSyncDefect(() => serverRef.current.proc.kill())
        }),
      ),
    30_000,
  )
})
