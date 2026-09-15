/**
 * `Gent.server` is the single server composition root. These tests pin the
 * options `apps/server/src/main.ts` needs from it — a fixed port, a caller
 * server id, and idle shutdown — so the launcher never rebuilds a second
 * root to get them back.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Random, Schema } from "effect"
import { Gent } from "../src/client"
import { makeTempDirectoryScoped } from "@gent/core-internal/test-utils/fixtures"

const ServerIdentity = Schema.Struct({
  serverId: Schema.String,
  pid: Schema.Finite,
  hostname: Schema.String,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
})

const fetchIdentity = (baseUrl: string) =>
  Effect.promise(() => Bun.fetch(`${baseUrl}/_gent/identity`)).pipe(
    Effect.andThen((response) => Effect.promise(() => response.json())),
    Effect.andThen(Schema.decodeUnknownEffect(ServerIdentity)),
  )

describe("Gent.server options", () => {
  it.live(
    "binds the requested port and publishes the caller server id",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-server-options-")
          const port = yield* Random.nextIntBetween(20_100, 21_000)
          const server = yield* Gent.server({
            cwd: dataDir,
            port,
            serverId: "launcher-owned-id",
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })

          expect(server.url).toBe(`http://127.0.0.1:${port}/rpc`)

          const identity = yield* fetchIdentity(`http://127.0.0.1:${port}`)
          expect(identity.serverId).toBe("launcher-owned-id")
        }).pipe(Effect.timeout("20 seconds")),
      ),
    30_000,
  )

  it.live(
    "idle shutdown completes awaitShutdown once no client is connected",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-server-options-")
          const server = yield* Gent.server({
            cwd: dataDir,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
            idleShutdown: { idleMs: 300 },
          })

          yield* Gent.awaitShutdown(server).pipe(Effect.timeout("15 seconds"))
        }),
      ),
    30_000,
  )

  it.live(
    "a server without idle shutdown keeps running",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-server-options-")
          const server = yield* Gent.server({
            cwd: dataDir,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })

          const stopped = yield* Gent.awaitShutdown(server).pipe(
            Effect.as(true),
            Effect.timeoutOption("700 millis"),
          )
          expect(stopped._tag).toBe("None")
        }),
      ),
    30_000,
  )
})
