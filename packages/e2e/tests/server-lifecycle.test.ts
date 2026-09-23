/**
 * Server lifecycle integration tests.
 * Tests the identity route, a signal stop, and reconnects.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit, Random, Scope } from "effect"
import { Gent } from "@gent/sdk"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import {
  killProcess,
  spawnServer,
  waitForProcessExit,
  waitUntil,
} from "../src/server-process-fixture"

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
            spawnServer({ dataDir, port }),
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
    "a standalone server stops on SIGTERM",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const port = yield* randomLifecyclePort
          const { proc } = yield* Effect.acquireRelease(
            spawnServer({ dataDir, port }),
            ({ proc }) => killProcess(proc),
          )
          yield* killProcess(proc, "SIGTERM")
          const exited = yield* waitForProcessExit(proc.pid, 5_000)
          expect(exited).toBe(true)
        }),
      ),
    15_000,
  )

  it.live(
    "WS client reconnects after server kill and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const port = yield* randomLifecyclePort
          const serverRef = yield* Effect.acquireRelease(
            spawnServer({ dataDir, port }).pipe(Effect.map((server) => ({ current: server }))),
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

          yield* bundle.client.session.list()
          expect(states).toContain("Connected")

          serverRef.current.proc.kill("SIGKILL")
          yield* Effect.promise(() => serverRef.current.proc.exited)

          const sawReconnecting = yield* waitUntil(() => states.includes("Reconnecting"), 5_000)
          expect(sawReconnecting).toBe(true)

          serverRef.current = yield* spawnServer({ dataDir, port })

          const reconnected = yield* waitUntil(
            () => bundle.runtime.lifecycle.getState()._tag === "Connected",
            10_000,
          )
          expect(reconnected).toBe(true)

          yield* bundle.client.session.list()

          yield* Scope.close(clientScope, Exit.void)
          yield* killProcess(serverRef.current.proc)
        }),
      ),
    30_000,
  )
})
