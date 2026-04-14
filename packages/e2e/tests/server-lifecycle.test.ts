/**
 * Server lifecycle integration tests.
 *
 * Tests identity route, connection tracking, and idle shutdown.
 * Requires real subprocess workers — cannot be tested in-process.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import { Gent } from "@gent/sdk"
import { startWorkerSupervisor } from "@gent/sdk/supervisor"
import { createTempDirFixture } from "./seam-fixture"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-lifecycle-")

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

          const { client } = yield* Gent.connect({ url: supervisor.url })

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

    // Spawn server directly (without supervisor restart wrapper)
    const serverEntry = path.resolve(repoRoot, "apps/server/src/main.ts")
    const proc = Bun.spawn(["bun", serverEntry], {
      cwd: repoRoot,
      env: {
        ...Bun.env,
        GENT_PORT: String(port),
        GENT_SERVER_MODE: "worker",
        GENT_PERSISTENCE_MODE: "memory",
        GENT_PROVIDER_MODE: "debug-scripted",
        GENT_DATA_DIR: dataDir,
        GENT_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    try {
      // Wait for GENT_WORKER_READY from stdout
      const readyUrl = await new Promise<string>((resolve, reject) => {
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
      expect(readyUrl).toBeTruthy()

      // Verify the server is running via identity route
      const baseUrl = readyUrl.replace("/rpc", "")
      const identityResp = await fetch(`${baseUrl}/_gent/identity`)
      expect(identityResp.ok).toBe(true)

      // No WS clients — server should idle-shutdown after IDLE_TIMEOUT_MS
      const exitCode = await new Promise<number>((resolve) => {
        const timeout = setTimeout(() => resolve(-1), IDLE_TIMEOUT_MS + 5_000)
        const check = setInterval(() => {
          try {
            process.kill(proc.pid, 0)
          } catch {
            clearInterval(check)
            clearTimeout(timeout)
            resolve(0)
          }
        }, 200)
      })

      expect(exitCode).toBe(0)
    } finally {
      try {
        proc.kill()
      } catch {
        /* already dead */
      }
    }
  }, 15_000)
})
