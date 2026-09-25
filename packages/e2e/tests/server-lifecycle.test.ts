/**
 * Server lifecycle integration tests.
 * Tests the identity route, the ready bound, a signal stop, and reconnects.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit, Option, Random, Schedule, Scope } from "effect"
import { Gent } from "@gent/sdk"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import {
  killProcess,
  spawnServer,
  waitForProcessExit,
  waitUntil,
} from "../src/server-process-fixture"

const randomLifecyclePort = Random.nextIntBetween(19_000, 20_000)

/** Whether a server answers the identity route on `port` within `within`. */
const answersWithin = (port: number, within: `${number} seconds`) =>
  Effect.tryPromise(() => Bun.fetch(`http://localhost:${port}/_gent/identity`)).pipe(
    Effect.map((response) => response.ok),
    Effect.orElseSucceed(() => false),
    Effect.repeat({ schedule: Schedule.spaced("200 millis"), until: (ok) => ok }),
    Effect.timeoutOption(within),
    Effect.map(Option.isSome),
  )

describe("server lifecycle", () => {
  it.live(
    "a server that misses its ready bound is stopped",
    () =>
      Effect.gen(function* () {
        const port = yield* randomLifecyclePort
        const spawned = yield* Effect.scoped(
          Effect.gen(function* () {
            const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
            return yield* Effect.exit(spawnServer({ dataDir, port, readyWithin: "1 millis" }))
          }),
        )
        expect(Exit.isFailure(spawned)).toBe(true)
        // An orphaned server would come up on the port within this window.
        expect(yield* answersWithin(port, "8 seconds")).toBe(false)
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )

  it.live(
    "identity route returns server identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const port = yield* randomLifecyclePort
          const { url, proc } = yield* spawnServer({ dataDir, port })

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
      ).pipe(Effect.timeout("12 seconds")),
    15_000,
  )

  it.live(
    "a standalone server stops on SIGTERM",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const port = yield* randomLifecyclePort
          const { proc } = yield* spawnServer({ dataDir, port })
          yield* killProcess(proc, "SIGTERM")
          const exited = yield* waitForProcessExit(proc.pid, 5_000)
          expect(exited).toBe(true)
        }),
      ).pipe(Effect.timeout("12 seconds")),
    15_000,
  )

  it.live(
    "WS client reconnects after server kill and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const port = yield* randomLifecyclePort
          const first = yield* spawnServer({ dataDir, port })

          const clientScope = yield* Scope.make()
          const bundle = yield* Gent.client(first.url).pipe(
            Effect.provideService(Scope.Scope, clientScope),
          )
          yield* bundle.runtime.lifecycle.waitForReady

          // Typed by the lifecycle, so a renamed state fails to compile here
          // instead of failing in a suite the gate does not run.
          const states: Array<ReturnType<typeof bundle.runtime.lifecycle.getState>["_tag"]> = []
          bundle.runtime.lifecycle.subscribe((s) => states.push(s._tag))

          yield* bundle.client.session.list()
          expect(states).toContain("Connected")

          first.proc.kill("SIGKILL")
          yield* Effect.promise(() => first.proc.exited)

          const sawReconnecting = yield* waitUntil(() => states.includes("Reconnecting"), 5_000)
          expect(sawReconnecting).toBe(true)

          yield* spawnServer({ dataDir, port })

          const reconnected = yield* waitUntil(
            () => bundle.runtime.lifecycle.getState()._tag === "Connected",
            10_000,
          )
          expect(reconnected).toBe(true)

          yield* bundle.client.session.list()

          yield* Scope.close(clientScope, Exit.void)
        }),
      ).pipe(Effect.timeout("25 seconds")),
    30_000,
  )
})
