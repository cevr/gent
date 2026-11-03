/**
 * Two real servers linked as two machines are: A's `link.machines` names B,
 * and A runs B's `gent ctl link` from this checkout, as `ssh <b> gent ctl
 * link` runs it on the other machine. Each server runs in this process on its
 * own scratch home and its own machine name (`GENT_MACHINE`); the link's
 * command is a real child process that finds B's server through B's data
 * directory. No network and no ssh: the link crosses stdio and loopback.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { BuiltinExtensions } from "@gent/extensions"
import { makeTempDirectoryScoped, serveModelCatalogFixture } from "@gent/core/test-utils"
import { Gent } from "@gent/sdk"
import { ConfigProvider, Effect, FileSystem, Path, Schedule, Schema } from "effect"

/** A server on a scratch home named `machine`, with `config` as its user file. */
const serveMachine = (machine: string, config: Schema.Json) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const home = yield* makeTempDirectoryScoped(`gent-link-${machine}-`)
    yield* fs.makeDirectory(`${home}/.gent`, { recursive: true })
    yield* fs.writeFileString(
      `${home}/.gent/config.json`,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(config),
    )
    const server = yield* Gent.server({
      cwd: home,
      state: Gent.state.sqlite({ home }),
      provider: Gent.provider.mock(),
      extensions: BuiltinExtensions,
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              HOME: home,
              GENT_MACHINE: machine,
              GENT_MODEL_CATALOG_URL: yield* serveModelCatalogFixture,
            },
          }),
        ),
      ),
    )
    const { client } = yield* Gent.client(server, { cwd: home })
    return { home, client }
  })

/** Reads `read` until `done` holds, at most 20 s: a link's child starts from source. */
const until = <A, E, R>(read: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  read.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("100 millis") }),
    Effect.timeout("20 seconds"),
  )

describe("linked machines", () => {
  it.live(
    "a server links another through its ctl link: connected, and the pool's facts cross both ways",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* Path.Path
          const appDir = path.resolve(yield* path.fromFileUrl(new URL("..", import.meta.url)))
          const b = yield* serveMachine("b", {})
          // One file for both machines, as the owner keeps it: A runs every entry but its own.
          const a = yield* serveMachine("a", {
            link: {
              machines: {
                a: ["false"],
                b: [
                  "env",
                  `HOME=${b.home}`,
                  process.execPath,
                  "--preload",
                  `${appDir}/scripts/dev-preload-boundary.ts`,
                  `${appDir}/src/main.tsx`,
                  "ctl",
                  "link",
                ],
              },
            },
          })
          const view = yield* until(a.client.link.machines(), (machines) =>
            machines.links.some((link) => link.state === "connected"),
          )
          expect({ machine: view.machine, links: view.links }).toEqual({
            machine: "a",
            links: [{ machine: "b", state: "connected" }],
          })
          // A pulled B's facts: its peer is B, over its own link.
          const aPeer = yield* until(
            a.client.accounts.lanes(),
            (report) => report.peer?.heard?.host === "b",
          )
          expect(aPeer.peer).toMatchObject({
            heard: { host: "b" },
            silent: false,
            down: [],
            link: { machine: "b", state: "connected" },
          })
          // A pushed its facts to B: B's peer is A, and B runs no link of its own.
          const bPeer = yield* until(
            b.client.accounts.lanes(),
            (report) => report.peer?.heard?.host === "a",
          )
          expect(bPeer.peer).toMatchObject({ heard: { host: "a" }, silent: false })
          expect(bPeer.peer?.link).toBeUndefined()
          expect((yield* b.client.link.machines()).machine).toBe("b")
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("40 seconds")),
      ),
    60_000,
  )
})
