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
import type { LaneReport } from "@gent/core/protocol"
import { makeTempDirectoryScoped, serveModelCatalogFixture } from "@gent/core/test-utils"
import { Gent } from "@gent/sdk"
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Path,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { ChildProcess } from "effect/process"

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

/** This checkout's apps/tui. */
const appDirectory = Effect.flatMap(Path.Path, (path) =>
  Effect.map(path.fromFileUrl(new URL("..", import.meta.url)), (dir) => path.resolve(dir)),
)

/** B's `gent ctl link` from this checkout, as `ssh <b> gent ctl link` runs it there. */
const ctlLinkOf = (home: string) =>
  Effect.gen(function* () {
    const appDir = yield* appDirectory
    return [
      "env",
      `HOME=${home}`,
      process.execPath,
      "--preload",
      `${appDir}/scripts/dev-preload-boundary.ts`,
      `${appDir}/src/main.tsx`,
      "ctl",
      "link",
    ]
  })

describe("linked machines", () => {
  // B is its own process here, killed with no shutdown: no stream of its
  // ends and no close frame goes out, so only the relay's own end of its
  // socket ends A's run.
  it.live(
    "a linked server killed while its relay's stdin stays open ends the link's run at once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const bHome = yield* makeTempDirectoryScoped("gent-link-b-")
          yield* fs.makeDirectory(`${bHome}/.gent`, { recursive: true })
          const appDir = yield* appDirectory
          const b = yield* ChildProcess.make(
            process.execPath,
            [
              "--preload",
              `${appDir}/scripts/dev-preload-boundary.ts`,
              `${appDir}/src/main.tsx`,
              "server",
              "start",
              "--mock",
              "--port",
              "0",
            ],
            {
              cwd: bHome,
              env: {
                HOME: bHome,
                GENT_MACHINE: "b",
                GENT_MODEL_CATALOG_URL: yield* serveModelCatalogFixture,
              },
              extendEnv: true,
              stdout: "pipe",
              stderr: "ignore",
              forceKillAfter: "2 seconds",
            },
          )
          yield* b.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.takeUntil((line) => line.startsWith("Gent server ready")),
            Stream.runDrain,
            Effect.timeout("20 seconds"),
          )
          const a = yield* serveMachine("a", { link: { machines: { b: yield* ctlLinkOf(bHome) } } })
          yield* until(a.client.link.machines(), (machines) =>
            machines.links.some((link) => link.state === "connected"),
          )
          yield* b.kill({ killSignal: "SIGKILL" })
          // B's relay ends with its socket and A's run with it: well before
          // the 60 s past a ping that a relay still running would take.
          const view = yield* a.client.link.machines().pipe(
            Effect.repeat({
              until: (machines) => machines.links.every((link) => link.state !== "connected"),
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("10 seconds"),
          )
          expect(view.links).toEqual([{ machine: "b", state: "connecting" }])
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("50 seconds")),
      ),
    60_000,
  )

  it.live(
    "a server links another through its ctl link: connected, and the pool's facts cross both ways",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const b = yield* serveMachine("b", {})
          // One file for both machines, as the owner keeps it: A runs every entry but its own.
          const a = yield* serveMachine("a", {
            link: {
              machines: {
                a: ["false"],
                b: yield* ctlLinkOf(b.home),
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
          // A pulled B's facts: its one peer is B, over its own link.
          const heard = (report: LaneReport, machine: string) =>
            report.peers?.some(
              (peer) => peer.machine === machine && Predicate.isNotUndefined(peer.heardAt),
            ) ?? false
          const aPeer = yield* until(a.client.accounts.lanes(), (report) => heard(report, "b"))
          expect(aPeer.peers).toMatchObject([
            { machine: "b", silent: false, down: [], link: { machine: "b", state: "connected" } },
          ])
          // A pushed its facts to B: B's one peer is A, and B runs no link of its own.
          const bPeer = yield* until(b.client.accounts.lanes(), (report) => heard(report, "a"))
          expect(bPeer.peers).toMatchObject([{ machine: "a", silent: false }])
          expect(bPeer.peers?.[0]?.link).toBeUndefined()
          expect((yield* b.client.link.machines()).machine).toBe("b")
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("40 seconds")),
      ),
    60_000,
  )
})
