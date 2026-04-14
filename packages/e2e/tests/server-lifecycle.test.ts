/**
 * Server lifecycle integration tests.
 *
 * Tests identity route, connection tracking, and idle shutdown.
 * Requires real subprocess workers — cannot be tested in-process.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import * as path from "node:path"
import { Gent } from "@gent/sdk"
import { startWorkerSupervisor } from "@gent/sdk/supervisor"
import { createTempDirFixture } from "./seam-fixture"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-lifecycle-")
const serverEntry = path.resolve(repoRoot, "apps/server/src/main.ts")

/** Spawn a raw server process with idle timeout. Returns url + pid + proc. */
const spawnIdleServer = async (opts: {
  dataDir: string
  idleTimeoutMs: number
  port: number
}): Promise<{ url: string; proc: Bun.Subprocess }> => {
  const proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...Bun.env,
      GENT_PORT: String(opts.port),
      GENT_SERVER_MODE: "worker",
      GENT_PERSISTENCE_MODE: "memory",
      GENT_PROVIDER_MODE: "debug-scripted",
      GENT_DATA_DIR: opts.dataDir,
      GENT_IDLE_TIMEOUT_MS: String(opts.idleTimeoutMs),
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server did not become ready")), 10_000)
    const chunks: string[] = []
    const decoder = new TextDecoder()
    const reader = proc.stdout.getReader()
    const pump = (): void => {
      reader.read().then(({ value, done }) => {
        if (done) {
          reject(new Error("stdout closed before ready"))
          return
        }
        chunks.push(decoder.decode(value))
        const all = chunks.join("")
        const match = all.match(/GENT_WORKER_READY (.+)/)
        if (match) {
          clearTimeout(timeout)
          reader.releaseLock()
          resolve(match[1]!.trim())
        } else {
          pump()
        }
      })
    }
    pump()
  })

  return { url: `${url}/rpc`, proc }
}

/** Wait for a process to exit. Returns 0 if dead within timeoutMs, -1 if still alive. */
const waitForExit = (pid: number, timeoutMs: number): Promise<number> =>
  new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(-1), timeoutMs)
    const check = setInterval(() => {
      try {
        process.kill(pid, 0)
      } catch {
        clearInterval(check)
        clearTimeout(timeout)
        resolve(0)
      }
    }, 200)
  })

/** Spawn a raw server on a fixed port. Returns url + proc. */
const spawnServerOnPort = async (opts: {
  dataDir: string
  port: number
}): Promise<{ url: string; proc: Bun.Subprocess }> => {
  const proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...Bun.env,
      GENT_PORT: String(opts.port),
      GENT_SERVER_MODE: "worker",
      GENT_PERSISTENCE_MODE: "memory",
      GENT_PROVIDER_MODE: "debug-scripted",
      GENT_DATA_DIR: opts.dataDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server did not become ready")), 10_000)
    const chunks: string[] = []
    const decoder = new TextDecoder()
    const reader = proc.stdout.getReader()
    const pump = (): void => {
      reader.read().then(({ value, done }) => {
        if (done) {
          reject(new Error("stdout closed before ready"))
          return
        }
        chunks.push(decoder.decode(value))
        const all = chunks.join("")
        const match = all.match(/GENT_WORKER_READY (.+)/)
        if (match) {
          clearTimeout(timeout)
          reader.releaseLock()
          resolve(match[1]!.trim())
        } else {
          pump()
        }
      })
    }
    pump()
  })

  return { url: `${url}/rpc`, proc }
}

/** Poll until a predicate is true or timeout. */
const waitUntil = (
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> =>
  new Promise((resolve) => {
    if (predicate()) {
      resolve(true)
      return
    }
    const deadline = Date.now() + timeoutMs
    const check = setInterval(() => {
      if (predicate()) {
        clearInterval(check)
        resolve(true)
      } else if (Date.now() >= deadline) {
        clearInterval(check)
        resolve(false)
      }
    }, intervalMs)
  })

describe("server lifecycle", () => {
  test("identity route returns server identity", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* startWorkerSupervisor({
            cwd: repoRoot,
            mode: "debug",
            env: { GENT_DATA_DIR: dataDir },
          })

          // Extract base URL from RPC URL (strip /rpc)
          const baseUrl = supervisor.url.replace("/rpc", "")

          // Validate identity route
          const response = yield* Effect.promise(() => fetch(`${baseUrl}/_gent/identity`))
          expect(response.ok).toBe(true)

          const identity = yield* Effect.promise(() => response.json())
          expect(identity.pid).toBe(supervisor.pid())
          expect(identity.hostname).toBeTruthy()
          expect(identity.dbPath).toBeTruthy()
          expect(identity.serverId).toBeTruthy()
          expect(identity.buildFingerprint).toBeTruthy()
          expect(identity.buildFingerprint).not.toBe("unknown")
        }),
      ),
    )
  }, 15_000)

  test("server.status RPC returns connection count and uptime", async () => {
    const dataDir = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* startWorkerSupervisor({
            cwd: repoRoot,
            mode: "debug",
            env: { GENT_DATA_DIR: dataDir },
          })

          const bundle = yield* Gent.client({ url: supervisor.url })
          yield* bundle.runtime.lifecycle.waitForReady
          const { client } = bundle

          // server.status should reflect our connection
          const status = yield* client.server
            .status()
            .pipe(Effect.mapError((e) => new Error(String(e))))

          expect(status.pid).toBe(supervisor.pid())
          expect(status.uptime).toBeGreaterThan(0)
          expect(status.connectionCount).toBeGreaterThanOrEqual(1)
          expect(status.buildFingerprint).toBeTruthy()
          expect(status.serverId).toBeTruthy()
        }),
      ),
    )
  }, 15_000)

  test("worker shuts down after idle timeout with no connections", async () => {
    const dataDir = makeTempDir()
    const IDLE_TIMEOUT_MS = 2_000
    const port = 19_000 + Math.floor(Math.random() * 1000)
    const { url, proc } = await spawnIdleServer({ dataDir, idleTimeoutMs: IDLE_TIMEOUT_MS, port })

    try {
      const baseUrl = url.replace("/rpc", "")
      const identityResp = await fetch(`${baseUrl}/_gent/identity`)
      expect(identityResp.ok).toBe(true)

      // No WS clients — server should idle-shutdown
      const exitCode = await waitForExit(proc.pid, IDLE_TIMEOUT_MS + 5_000)
      expect(exitCode).toBe(0)
    } finally {
      try {
        proc.kill()
      } catch {
        /* already dead */
      }
    }
  }, 15_000)

  test("two Gent.server calls with same dbPath share one server", async () => {
    const dataDir = makeTempDir()
    const dbPath = path.join(dataDir, "data.db")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // First server starts owned
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

          // Second server should attach via registry
          const server2 = yield* Gent.server({
            cwd: repoRoot,
            state: Gent.state.sqlite({ home: dataDir, dbPath }),
            provider: Gent.provider.mock(),
          })
          // Second server should attach — verify via tag and probing identity
          expect(server2._tag).toBe("attached")

          // Verify same server by probing identity endpoint (avoids WS lifecycle timing)
          const baseUrl = server2.url.replace("/rpc", "")
          const identity = yield* Effect.tryPromise(() =>
            fetch(`${baseUrl}/_gent/identity`).then((r) => r.json()),
          ).pipe(Effect.mapError((e) => new Error(String(e))))
          expect((identity as { pid: number }).pid).toBe(pid1)
        }),
      ),
    )
  }, 20_000)

  test("WS connection resets idle timer, shutdown triggers after disconnect", async () => {
    const dataDir = makeTempDir()
    const IDLE_TIMEOUT_MS = 3_000
    const port = 19_000 + Math.floor(Math.random() * 1000)
    const { url, proc } = await spawnIdleServer({ dataDir, idleTimeoutMs: IDLE_TIMEOUT_MS, port })

    try {
      // Wait past 60% of idle timeout — timer running, countdown in progress
      await new Promise((r) => setTimeout(r, IDLE_TIMEOUT_MS * 0.6))

      // Connect a WS client with a manually managed scope so we control disconnect timing
      const clientScope = Effect.runSync(Scope.make())
      const bundle = await Effect.runPromise(
        Gent.client({ url }).pipe(Effect.provideService(Scope.Scope, clientScope)),
      )

      // Wait for WS connection to establish
      await Effect.runPromise(bundle.runtime.lifecycle.waitForReady)

      // Verify connection registered
      const status = await Effect.runPromise(
        bundle.client.server.status().pipe(Effect.mapError((e) => new Error(String(e)))),
      )
      expect(status.connectionCount).toBeGreaterThanOrEqual(1)

      // Hold connection past 60% of idle timeout again — server should stay alive
      await new Promise((r) => setTimeout(r, IDLE_TIMEOUT_MS * 0.6))
      expect(() => process.kill(proc.pid, 0)).not.toThrow()

      // Disconnect by closing the scope — WS transport tears down, idle timer starts fresh
      await Effect.runPromise(Scope.close(clientScope, Exit.void))

      // Server should still be alive immediately after disconnect
      await new Promise((r) => setTimeout(r, 500))
      expect(() => process.kill(proc.pid, 0)).not.toThrow()

      // Server should shut down after full IDLE_TIMEOUT_MS from disconnect
      const exitCode = await waitForExit(proc.pid, IDLE_TIMEOUT_MS + 5_000)
      expect(exitCode).toBe(0)
    } finally {
      try {
        proc.kill()
      } catch {
        /* already dead */
      }
    }
  }, 20_000)

  test("WS client reconnects after server kill and restart", async () => {
    const dataDir = makeTempDir()
    const port = 19_000 + Math.floor(Math.random() * 1000)

    // Start initial server
    let server = await spawnServerOnPort({ dataDir, port })

    try {
      // Connect with auto-reconnecting WS client
      const clientScope = Effect.runSync(Scope.make())
      const bundle = await Effect.runPromise(
        Gent.client({ url: server.url }).pipe(Effect.provideService(Scope.Scope, clientScope)),
      )

      // Wait for WS connection to establish
      await Effect.runPromise(bundle.runtime.lifecycle.waitForReady)

      // Track lifecycle transitions
      const states: string[] = []
      bundle.runtime.lifecycle.subscribe((s) => states.push(s._tag))

      // Verify initial connection works
      const status1 = await Effect.runPromise(
        bundle.client.server.status().pipe(Effect.mapError((e) => new Error(String(e)))),
      )
      expect(status1.connectionCount).toBeGreaterThanOrEqual(1)
      expect(states).toContain("connected")

      // Kill the server
      server.proc.kill("SIGTERM")
      await server.proc.exited

      // Wait for client to detect disconnection and enter reconnecting
      const sawReconnecting = await waitUntil(() => states.includes("reconnecting"), 5_000)
      expect(sawReconnecting).toBe(true)

      // Restart server on the same port
      server = await spawnServerOnPort({ dataDir, port })

      // Wait for client to reconnect — lifecycle should return to connected
      const reconnected = await waitUntil(
        () => bundle.runtime.lifecycle.getState()._tag === "connected",
        10_000,
      )
      expect(reconnected).toBe(true)

      // Verify RPC works again through the same client handle
      const status2 = await Effect.runPromise(
        bundle.client.server.status().pipe(Effect.mapError((e) => new Error(String(e)))),
      )
      expect(status2.connectionCount).toBeGreaterThanOrEqual(1)

      // Clean up
      await Effect.runPromise(Scope.close(clientScope, Exit.void))
    } finally {
      try {
        server.proc.kill()
      } catch {
        /* already dead */
      }
    }
  }, 30_000)
})
