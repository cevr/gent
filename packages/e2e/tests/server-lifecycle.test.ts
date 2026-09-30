/**
 * Server lifecycle integration tests.
 * Tests the identity route, the ready bound, a signal stop, and reconnects.
 */
import { describe, expect, it } from "effect-bun-test"
import { hostname } from "node:os"
import { Effect, Exit, Option, Random, Schedule, Schema, Scope } from "effect"
import { Gent } from "@gent/sdk"
import { makeTempDirectoryScoped, waitFor } from "@gent/core/test-utils"
import {
  killProcess,
  spawnServer,
  stopProcess,
  waitForProcessExit,
} from "../src/server-process-fixture"

const randomLifecyclePort = Random.nextIntBetween(19_000, 20_000)

/** What `/_gent/identity` serves. */
const ServerIdentity = Schema.Struct({
  serverId: Schema.String,
  pid: Schema.Finite,
  hostname: Schema.String,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
})

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
    "a process that ignores SIGTERM is stopped with SIGKILL after the grace period",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // `exec` keeps the ignored SIGTERM, so the pid that prints "ready" ignores it.
          const proc = yield* Effect.acquireRelease(
            Effect.sync(() =>
              // oxlint-disable-next-line effect/noGlobals -- stopProcess takes the Bun.Subprocess spawnServer makes.
              Bun.spawn(["sh", "-c", 'trap "" TERM; echo ready; exec sleep 30'], {
                stdout: "pipe",
                stderr: "ignore",
              }),
            ),
            // Test cleanup when the stop under test failed to end it.
            (child) => killProcess(child, "SIGKILL"),
          )
          const reader = proc.stdout.getReader()
          const first = yield* Effect.promise(() => reader.read())
          expect(new TextDecoder().decode(first.value)).toContain("ready")
          reader.releaseLock()
          yield* stopProcess(proc, 300)
          expect(yield* waitForProcessExit(proc.pid, 2_000)).toBe(true)
        }),
      ).pipe(Effect.timeout("8 seconds")),
    10_000,
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

          const identity = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ServerIdentity)),
          )
          expect(identity.pid).toBe(proc.pid)
          expect(identity.hostname).toBe(hostname())
          // `--isolate` keeps state in memory: the server owns no database file.
          expect(identity.dbPath).toBe(":memory:")
          expect(identity.serverId).not.toBe("")
          expect(identity.buildFingerprint).toMatch(/^(src|bin)-/)
        }),
      ).pipe(Effect.timeout("12 seconds")),
    15_000,
  )

  it.live(
    "a standalone server stops on SIGTERM and exits 143",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const port = yield* randomLifecyclePort
          const { proc } = yield* spawnServer({ dataDir, port })
          yield* killProcess(proc, "SIGTERM")
          const exited = yield* waitForProcessExit(proc.pid, 5_000)
          expect(exited).toBe(true)
          // A shell chain after an interrupted server must not read success.
          expect(yield* Effect.promise(() => proc.exited)).toBe(143)
        }),
      ).pipe(Effect.timeout("12 seconds")),
    15_000,
  )

  it.live(
    "a standalone server interrupted by SIGINT exits 130",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-lifecycle-")
          const port = yield* randomLifecyclePort
          const { proc } = yield* spawnServer({ dataDir, port })
          yield* killProcess(proc, "SIGINT")
          expect(yield* Effect.promise(() => proc.exited)).toBe(130)
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

          // The client closes before the restarted server stops; a failed run closes it too.
          const clientScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          )
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

          yield* waitFor(
            Effect.succeed(states),
            (seen) => seen.includes("Reconnecting"),
            5_000,
            "the client to notice the lost server",
          )

          yield* spawnServer({ dataDir, port })

          yield* waitFor(
            Effect.sync(() => bundle.runtime.lifecycle.getState()._tag),
            (state) => state === "Connected",
            10_000,
            "the client to reconnect",
          )

          yield* bundle.client.session.list()

          yield* Scope.close(clientScope, Exit.void)
        }),
      ).pipe(Effect.timeout("25 seconds")),
    30_000,
  )
})
