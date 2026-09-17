/**
 * Server lifecycle integration tests.
 * Tests identity route, connection tracking, idle shutdown, and reconnects.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit, Random, Scope } from "effect"
import { Gent } from "@gent/sdk"
import { makeTempDirectoryScoped } from "@gent/core-internal/test-utils/fixtures"
import { toTestFailure } from "./test-failure-boundary"
import {
  killProcess,
  spawnIdleServer,
  spawnServerOnPort,
  waitUntil,
} from "../src/server-process-fixture"
import { waitForProcessExit } from "../src/wait-for-process-exit"

const randomLifecyclePort = Random.nextIntBetween(19_000, 20_000)

describe("server lifecycle", () => {
  it.live(
    "identity route returns server identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const port = yield* randomLifecyclePort
          const { url, proc } = yield* Effect.acquireRelease(
            spawnServerOnPort({ dataDir, port }),
            ({ proc }) => killProcess(proc),
          )

          const baseUrl = url.replace("/rpc", "")
          const response = yield* Effect.promise(() => Bun.fetch(`${baseUrl}/_gent/identity`))
          expect(response.ok).toBe(true)

          const identity = yield* Effect.promise(() => response.json())
          expect(identity.pid).toBe(proc.pid)
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
    "runtime.status RPC returns connection count and uptime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const port = yield* randomLifecyclePort
          const { url, proc } = yield* Effect.acquireRelease(
            spawnServerOnPort({ dataDir, port }),
            ({ proc }) => killProcess(proc),
          )

          const bundle = yield* Gent.client(url)
          yield* bundle.runtime.lifecycle.waitForReady
          const status = yield* bundle.client.runtime.status().pipe(Effect.mapError(toTestFailure))

          expect(status.pid).toBe(proc.pid)
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
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const idleTimeoutMs = 500
          const port = yield* randomLifecyclePort
          const { url, proc } = yield* Effect.acquireRelease(
            spawnIdleServer({ dataDir, idleTimeoutMs, port }),
            ({ proc }) => killProcess(proc),
          )

          const baseUrl = url.replace("/rpc", "")
          const identityResp = yield* Effect.promise(() => Bun.fetch(`${baseUrl}/_gent/identity`))
          expect(identityResp.ok).toBe(true)

          const exited = yield* waitForProcessExit(proc.pid, idleTimeoutMs + 3_000)
          expect(exited).toBe(true)
        }),
      ),
    15_000,
  )

  it.live(
    "WS connection resets idle timer, shutdown triggers after disconnect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const idleTimeoutMs = 750
          const port = yield* randomLifecyclePort
          const { url, proc } = yield* Effect.acquireRelease(
            spawnIdleServer({ dataDir, idleTimeoutMs, port }),
            ({ proc }) => killProcess(proc),
          )

          // gent/no-sleep: allow real-clock idle-timeout exercise — subject under test is wall-clock idle eviction
          yield* Effect.sleep(`${idleTimeoutMs * 0.6} millis`)

          const clientScope = yield* Scope.make()
          const bundle = yield* Gent.client(url).pipe(
            Effect.provideService(Scope.Scope, clientScope),
          )
          yield* bundle.runtime.lifecycle.waitForReady

          const status = yield* bundle.client.runtime.status().pipe(Effect.mapError(toTestFailure))
          expect(status.connectionCount).toBeGreaterThanOrEqual(1)

          // gent/no-sleep: allow real-clock idle-timeout exercise — verifies eviction has not fired before deadline
          yield* Effect.sleep(`${idleTimeoutMs * 0.6} millis`)
          expect(() => process.kill(proc.pid, 0)).not.toThrow()

          yield* Scope.close(clientScope, Exit.void)
          // gent/no-sleep: allow real-clock grace window after client scope close, before idle eviction
          yield* Effect.sleep("100 millis")
          expect(() => process.kill(proc.pid, 0)).not.toThrow()

          const exited = yield* waitForProcessExit(proc.pid, idleTimeoutMs + 3_000)
          expect(exited).toBe(true)
        }),
      ),
    20_000,
  )

  it.live(
    "WS client reconnects after server kill and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const port = yield* randomLifecyclePort
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

          // Typed by the lifecycle, so a renamed state fails to compile here
          // instead of failing in a suite the gate does not run.
          const states: Array<ReturnType<typeof bundle.runtime.lifecycle.getState>["_tag"]> = []
          bundle.runtime.lifecycle.subscribe((s) => states.push(s._tag))

          const status1 = yield* bundle.client.runtime.status().pipe(Effect.mapError(toTestFailure))
          expect(status1.connectionCount).toBeGreaterThanOrEqual(1)
          expect(states).toContain("Connected")

          serverRef.current.proc.kill("SIGKILL")
          yield* Effect.promise(() => serverRef.current.proc.exited)

          const sawReconnecting = yield* waitUntil(() => states.includes("Reconnecting"), 5_000)
          expect(sawReconnecting).toBe(true)

          serverRef.current = yield* spawnServerOnPort({ dataDir, port })

          const reconnected = yield* waitUntil(
            () => bundle.runtime.lifecycle.getState()._tag === "Connected",
            10_000,
          )
          expect(reconnected).toBe(true)

          const status2 = yield* bundle.client.runtime.status().pipe(Effect.mapError(toTestFailure))
          expect(status2.connectionCount).toBeGreaterThanOrEqual(1)

          yield* Scope.close(clientScope, Exit.void)
          yield* killProcess(serverRef.current.proc)
        }),
      ),
    30_000,
  )
})
