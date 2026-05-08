/**
 * Server lifecycle integration tests.
 * Tests identity route, connection tracking, idle shutdown, and reconnects.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit, Random, Scope } from "effect"
import { extractText, Gent } from "@gent/sdk"
import { createTempDirFixture } from "@gent/core-internal/test-utils/fixtures"
import { toTestFailure, waitFor } from "./transport-harness-boundary"
import {
  killProcess,
  spawnIdleServer,
  spawnServerOnPort,
  waitForExit,
  waitUntil,
} from "../src/server-process-fixture"

const repoRoot = decodeURIComponent(new URL("../../..", import.meta.url).pathname).replace(
  /\/$/,
  "",
)
const makeTempDir = createTempDirFixture("gent-lifecycle-")
const randomLifecyclePort = Random.nextIntBetween(19_000, 20_000)

describe("server lifecycle", () => {
  it.live(
    "identity route returns server identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = makeTempDir()
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
          const dataDir = makeTempDir()
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
          const dataDir = makeTempDir()
          const idleTimeoutMs = 500
          const port = yield* randomLifecyclePort
          const { url, proc } = yield* Effect.acquireRelease(
            spawnIdleServer({ dataDir, idleTimeoutMs, port }),
            ({ proc }) => killProcess(proc),
          )

          const baseUrl = url.replace("/rpc", "")
          const identityResp = yield* Effect.promise(() => Bun.fetch(`${baseUrl}/_gent/identity`))
          expect(identityResp.ok).toBe(true)

          const exitCode = yield* waitForExit(proc.pid, idleTimeoutMs + 3_000)
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
          const dbPath = `${dataDir}/data.db`

          const server1 = yield* Gent.server({
            cwd: repoRoot,
            state: Gent.state.sqlite({ home: dataDir, dbPath }),
            provider: Gent.provider.mock(),
          })
          const bundle1 = yield* Gent.client(server1)

          const status1 = yield* bundle1.client.runtime
            .status()
            .pipe(Effect.mapError(toTestFailure))
          const pid1 = status1.pid

          const server2 = yield* Gent.server({
            cwd: repoRoot,
            state: Gent.state.sqlite({ home: dataDir, dbPath }),
            provider: Gent.provider.mock(),
          })
          expect(server2._tag).toBe("attached")

          const baseUrl = server2.url.replace("/rpc", "")
          const response = yield* Effect.tryPromise(() =>
            Bun.fetch(`${baseUrl}/_gent/identity`),
          ).pipe(Effect.mapError(toTestFailure))
          const identity = yield* Effect.tryPromise(() => response.json()).pipe(
            Effect.mapError(toTestFailure),
          )
          expect((identity as { pid: number }).pid).toBe(pid1)
        }),
      ),
    20_000,
  )

  it.live(
    "single owned server isolates persisted session reads by client workspace",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwdA = makeTempDir()
          const cwdB = makeTempDir()
          const server = yield* Gent.server({
            cwd: cwdA,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })
          const clientA = (yield* Gent.client(server, { cwd: cwdA })).client
          const clientB = (yield* Gent.client(server, { cwd: cwdB })).client

          const created = yield* clientA.session
            .create({ name: "Workspace A", cwd: cwdA })
            .pipe(Effect.mapError(toTestFailure))
          yield* clientA.message
            .send({
              sessionId: created.sessionId,
              branchId: created.branchId,
              content: "workspace-a-message",
            })
            .pipe(Effect.mapError(toTestFailure))

          yield* waitFor(
            clientA.message
              .list({ branchId: created.branchId })
              .pipe(Effect.mapError(toTestFailure)),
            (messages) =>
              messages.some((message) => extractText(message.parts) === "workspace-a-message"),
          )

          const sessionsB = yield* clientB.session.list().pipe(Effect.mapError(toTestFailure))
          const sessionB = yield* clientB.session
            .get({ sessionId: created.sessionId })
            .pipe(Effect.mapError(toTestFailure))
          const branchesB = yield* clientB.branch
            .list({ sessionId: created.sessionId })
            .pipe(Effect.mapError(toTestFailure))
          const messagesB = yield* clientB.message
            .list({ branchId: created.branchId })
            .pipe(Effect.mapError(toTestFailure))
          const snapshotB = yield* Effect.result(
            clientB.session
              .getSnapshot({ sessionId: created.sessionId, branchId: created.branchId })
              .pipe(Effect.mapError(toTestFailure)),
          )

          expect(sessionsB.map((session) => session.id)).not.toContain(created.sessionId)
          expect(sessionB).toBeNull()
          expect(branchesB).toEqual([])
          expect(messagesB).toEqual([])
          expect(snapshotB._tag).toBe("Failure")
        }),
      ),
    15_000,
  )

  it.live(
    "WS connection resets idle timer, shutdown triggers after disconnect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = makeTempDir()
          const idleTimeoutMs = 750
          const port = yield* randomLifecyclePort
          const { url, proc } = yield* Effect.acquireRelease(
            spawnIdleServer({ dataDir, idleTimeoutMs, port }),
            ({ proc }) => killProcess(proc),
          )

          yield* Effect.sleep(`${idleTimeoutMs * 0.6} millis`)

          const clientScope = yield* Scope.make()
          const bundle = yield* Gent.client(url).pipe(
            Effect.provideService(Scope.Scope, clientScope),
          )
          yield* bundle.runtime.lifecycle.waitForReady

          const status = yield* bundle.client.runtime.status().pipe(Effect.mapError(toTestFailure))
          expect(status.connectionCount).toBeGreaterThanOrEqual(1)

          yield* Effect.sleep(`${idleTimeoutMs * 0.6} millis`)
          expect(() => process.kill(proc.pid, 0)).not.toThrow()

          yield* Scope.close(clientScope, Exit.void)
          yield* Effect.sleep("100 millis")
          expect(() => process.kill(proc.pid, 0)).not.toThrow()

          const exitCode = yield* waitForExit(proc.pid, idleTimeoutMs + 3_000)
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

          const states: string[] = []
          bundle.runtime.lifecycle.subscribe((s) => states.push(s._tag))

          const status1 = yield* bundle.client.runtime.status().pipe(Effect.mapError(toTestFailure))
          expect(status1.connectionCount).toBeGreaterThanOrEqual(1)
          expect(states).toContain("connected")

          serverRef.current.proc.kill("SIGKILL")
          yield* Effect.promise(() => serverRef.current.proc.exited)

          const sawReconnecting = yield* waitUntil(() => states.includes("reconnecting"), 5_000)
          expect(sawReconnecting).toBe(true)

          serverRef.current = yield* spawnServerOnPort({ dataDir, port })

          const reconnected = yield* waitUntil(
            () => bundle.runtime.lifecycle.getState()._tag === "connected",
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
