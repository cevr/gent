/**
 * Two real servers linked as two machines are: A's `link.machines` names B,
 * and A runs B's `gent ctl link` from this checkout, as `ssh <b> gent ctl
 * link` runs it on the other machine. Each server is its own `gent server
 * start` process from this checkout's `main.tsx`, on its own scratch home,
 * data directory and machine name (`GENT_MACHINE`), so the link joins the
 * program to itself, as two machines on one build do. The link's command is
 * a real child process that finds B's server through B's data directory. No
 * network and no ssh: the link crosses stdio and loopback.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import type { LaneReport } from "@gent/core/protocol"
import { GentReleaseFacts } from "@gent/core/host"
import { makeTempDirectoryScoped, serveModelCatalogFixture } from "@gent/core/test-utils"
import { Gent } from "@gent/sdk"
import { Effect, FileSystem, Option, Path, Predicate, Schedule, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"

/** This checkout's apps/tui. */
const appDirectory = Effect.flatMap(Path.Path, (path) =>
  Effect.map(path.fromFileUrl(new URL("..", import.meta.url)), (dir) => path.resolve(dir)),
)

const encodeBuild = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      release: GentReleaseFacts,
    }),
  ),
)

/**
 * The process boundary supplies one clean build's metadata. These tests
 * exercise transport and shutdown even when the checkout running them is
 * dirty; source capture and dev-build refusal have their own link tests.
 */
const mainOf = Effect.gen(function* () {
  const appDir = yield* appDirectory
  const path = yield* Path.Path
  return [
    "--define",
    `__GENT_BUILD__:${encodeBuild({
      id: "link-integration",
      version: "0.0.0",
      release: {
        commit: "link-integration-commit",
        clean: true,
        checkout: path.resolve(appDir, "../.."),
      },
    })}`,
    "--preload",
    `${appDir}/scripts/dev-preload-boundary.ts`,
    `${appDir}/src/main.tsx`,
  ]
})

const READY_PREFIX = "Gent server ready on "

/**
 * `gent server start --mock` on a scratch home named `machine`, with `config`
 * as its user file: the process, its home and data directory, and a client of
 * it. The server and its client belong to the caller's scope.
 */
const serveMachine = (machine: string, config: Schema.Json) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const home = yield* makeTempDirectoryScoped(`gent-link-${machine}-`)
    const dataDir = `${home}/data`
    yield* fs.makeDirectory(`${home}/.gent`, { recursive: true })
    yield* fs.writeFileString(
      `${home}/.gent/config.json`,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(config),
    )
    const server = yield* ChildProcess.make(
      process.execPath,
      [...(yield* mainOf), "server", "start", "--mock", "--port", "0"],
      {
        cwd: home,
        env: {
          HOME: home,
          GENT_DATA_DIR: dataDir,
          GENT_MACHINE: machine,
          GENT_MODEL_CATALOG_URL: yield* serveModelCatalogFixture,
        },
        extendEnv: true,
        stdout: "pipe",
        stderr: "ignore",
        forceKillAfter: "2 seconds",
      },
    )
    const url = yield* server.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.startsWith(READY_PREFIX)),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die(`${machine}'s server closed its stdout before it was ready`),
          onSome: (line) => Effect.succeed(line.slice(READY_PREFIX.length).trim()),
        }),
      ),
      Effect.timeout("20 seconds"),
    )
    const { client } = yield* Gent.client(`${url}/rpc`, { cwd: home })
    return { home, dataDir, server, client }
  })

/** Reads `read` until `done` holds, at most 20 s: a link's child starts from source. */
const until = <A, E, R>(read: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  read.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("100 millis") }),
    Effect.timeout("20 seconds"),
  )

/** B's `gent ctl link` from this checkout, as `ssh <b> gent ctl link` runs it there. */
const ctlLinkOf = (b: { readonly home: string; readonly dataDir: string }) =>
  Effect.map(mainOf, (main) => [
    "env",
    `HOME=${b.home}`,
    `GENT_DATA_DIR=${b.dataDir}`,
    process.execPath,
    ...main,
    "ctl",
    "link",
  ])

describe("linked machines", () => {
  // B is killed with no shutdown: no stream of its ends and no close frame
  // goes out, so only the relay's own end of its socket ends A's run.
  it.live(
    "a linked server killed while its relay's stdin stays open ends the link's run at once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const b = yield* serveMachine("b", {})
          const a = yield* serveMachine("a", { link: { machines: { b: yield* ctlLinkOf(b) } } })
          yield* until(a.client.link.machines(), (machines) =>
            machines.links.some((link) => link.state === "connected"),
          )
          yield* b.server.kill({ killSignal: "SIGKILL" })
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
                b: yield* ctlLinkOf(b),
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
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("50 seconds")),
      ),
    60_000,
  )
})
