import { describe, expect, it } from "effect-bun-test"
import {
  Clock,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Predicate,
  References,
  Schema,
} from "effect"
import { TestClock } from "effect/testing"
import {
  ConfigService,
  type LinkMachines,
  RuntimeEnvironment,
  UserConfig,
} from "../../src/runtime/config"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { PoolFacts } from "../../src/domain/driver"
import { CredentialPlacement, makeCredentialPlacement } from "../../src/runtime/provider"
import { Links, linkContract } from "../../src/server/link"
import { BunTestServices, makeTempDirectoryScoped } from "../../src/test-utils/harness"

/** The test platform's host name: this server's machine name. */
const OWN = "test-host"
const encodeFacts = Schema.encodeSync(Schema.fromJsonString(PoolFacts))
const FAR_FACTS = encodeFacts({ boot: "far-boot", host: "far-host", seq: 0, providers: [] })

/** The far end's argv: this bun running the fixture, as `gent ctl link` would be run. */
const farEnd = (contract: string, mode: string, log: string) =>
  Effect.map(
    Effect.flatMap(Path.Path, (path) =>
      path.fromFileUrl(new URL("./link-far-end.ts", import.meta.url)),
    ),
    (script): readonly [string, ...Array<string>] => [
      process.execPath,
      script,
      contract,
      mode,
      log,
      FAR_FACTS,
    ],
  )

/** The lines the far end logged, none before its first run. */
const logged = (log: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(log).pipe(
      Effect.map((text) => text.split("\n").filter((line) => line.length > 0)),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    ),
  )

/** `link.ended` as each link logs it: its machine and its error. */
const ends = () => {
  const seen: Array<{ readonly machine: string; readonly error: string }> = []
  const logger = Logger.make(({ message, fiber }) => {
    let text = String(message)
    if (Array.isArray(message)) text = message.map((part) => String(part)).join(" ")
    if (text !== "link.ended") return
    const annotations = fiber.getRef(References.CurrentLogAnnotations)
    seen.push({ machine: String(annotations["machine"]), error: String(annotations["error"]) })
  })
  return {
    seen,
    // The test preload turns logs off.
    layer: Layer.merge(Logger.layer([logger]), Layer.succeed(References.MinimumLogLevel, "Warn")),
  }
}

/**
 * This server's links over `machines`, with a placement of its own, until
 * the scope closes.
 */
const linksOver = (machines: LinkMachines) =>
  Effect.gen(function* () {
    const dir = yield* makeTempDirectoryScoped("gent-link-")
    const placement = yield* makeCredentialPlacement(Option.none())
    const context = yield* Layer.build(
      Links.Live(() => Effect.succeedNone).pipe(
        Layer.provide(
          Layer.mergeAll(
            ConfigService.Test(new UserConfig({ link: { machines } })),
            Layer.succeed(CredentialPlacement, placement),
            RuntimeEnvironment.Live({ cwd: dir, home: dir }),
          ),
        ),
      ),
    )
    return { links: Context.get(context, Links), placement, dir }
  })

const encodeDiagnostic = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** A wait on the wall clock, under the test clock too: the far end runs in real time. */
const wallSleep = (millis: number) =>
  Effect.sleep(Duration.millis(millis)).pipe(
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
  )

/** The links' view once `done` holds of it, read every 20 ms on the wall clock. */
const viewUntil = (
  links: Links["Service"],
  done: (view: ReadonlyArray<{ readonly machine: string; readonly state: string }>) => boolean,
) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 500; tries++) {
      const view = yield* links.view
      if (done(view)) return view
      yield* wallSleep(20)
    }
    return yield* Effect.die(
      `the links never reached the state: ${encodeDiagnostic(yield* links.view)}`,
    )
  })

/** The far end's log once `done` holds of it, read every 20 ms on the wall clock. */
const logUntil = (log: string, done: (lines: ReadonlyArray<string>) => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 500; tries++) {
      const lines = yield* logged(log)
      if (done(lines)) return lines
      yield* wallSleep(20)
    }
    return yield* Effect.die(`the far end never logged it: ${encodeDiagnostic(yield* logged(log))}`)
  })

const starts = (lines: ReadonlyArray<string>) => lines.filter((line) => line === "start").length

/** Lets the fibers a clock step woke run to their next wait. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
})

/**
 * Moves the test clock a second at a time, each step given 100 ms of wall
 * time for the far end to answer, until `done` holds: the seconds it took.
 * The far end runs in real time, so a wait on the test clock and a run of
 * its command interleave.
 */
const secondsUntil = <R>(done: Effect.Effect<boolean, never, R>, most = 20) =>
  Effect.gen(function* () {
    let seconds = 0
    while (!(yield* done) && seconds < most) {
      yield* TestClock.adjust("1 second")
      yield* settle
      yield* wallSleep(100)
      seconds++
    }
    return seconds
  })

const platformLayer = Layer.mergeAll(BunTestServices, GentPlatform.Test())

describe("links", () => {
  it.live(
    "a link to a machine on this contract connects, and the pool's facts cross both ways",
    () =>
      Effect.gen(function* () {
        const contract = yield* linkContract
        const dir = yield* makeTempDirectoryScoped("gent-link-far-")
        const log = `${dir}/far.log`
        const ownLog = `${dir}/own.log`
        const { links, placement } = yield* linksOver({
          far: yield* farEnd(contract, "serve", log),
          // The file is the same on both machines: this machine's own entry never runs.
          [OWN]: yield* farEnd(contract, "serve", ownLog),
        })
        expect(yield* viewUntil(links, (view) => view[0]?.state === "connected")).toEqual([
          { machine: "far", state: "connected" },
        ])
        // The far end's facts reached this server's lanes, on this server's own link.
        let report = yield* placement.lanes(() => Effect.succeedNone, Option.none())
        for (let tries = 0; tries < 250 && Predicate.isUndefined(report.peer?.heard); tries++) {
          yield* wallSleep(20)
          report = yield* placement.lanes(() => Effect.succeedNone, Option.none())
        }
        const peer = report.peer
        expect(peer).toMatchObject({ heard: { host: "far-host" }, down: [] })
        // This server's facts reached the far end, and each call names this machine.
        const lines = yield* logUntil(log, (found) =>
          found.some((line) => line.startsWith("note ")),
        )
        expect(lines.slice(0, 2)).toEqual(["start", `request link.hello origin=${OWN}`])
        expect(lines).toContain(`request accounts.pool origin=${OWN}`)
        const note = lines.find((line) => line.startsWith("note ")) ?? ""
        expect(note).toContain(`"host":"${OWN}"`)
        expect(yield* logged(ownLog)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(platformLayer)),
    30_000,
  )

  it.effect(
    "a link with no frame for 90 s turns silent, and its command runs again",
    () =>
      Effect.gen(function* () {
        const contract = yield* linkContract
        const dir = yield* makeTempDirectoryScoped("gent-link-far-")
        const log = `${dir}/far.log`
        // The far end answers the hello and nothing more: a machine asleep.
        const { links, placement } = yield* linksOver({
          far: yield* farEnd(contract, "quiet", log),
        })
        yield* viewUntil(links, (view) => view[0]?.state === "connected")
        yield* settle
        yield* TestClock.adjust("89 seconds")
        yield* settle
        expect(yield* links.view).toEqual([{ machine: "far", state: "connected" }])
        yield* TestClock.adjust("1 second")
        yield* settle
        expect(yield* links.view).toEqual([{ machine: "far", state: "silent" }])
        // The lanes name this server's own link down.
        const report = yield* placement.lanes(() => Effect.succeedNone, Option.none())
        expect(report.peer).toMatchObject({ down: ["own"] })
        // The pings went unanswered: the run ended, and the next one connects.
        yield* secondsUntil(Effect.map(logged(log), (lines) => starts(lines) === 2))
        expect(yield* viewUntil(links, (view) => view[0]?.state === "connected")).toEqual([
          { machine: "far", state: "connected" },
        ])
      }).pipe(Effect.scoped, Effect.provide(platformLayer)),
    30_000,
  )

  // The waits between runs (1 s, doubling to 5 min) are the state machine test's,
  // on a fake far end: a real command's exit races the test clock.
  it.live(
    "a link whose command dies after its hello logs its exit code and stderr, and runs it again",
    () => {
      const logs = ends()
      return Effect.gen(function* () {
        const contract = yield* linkContract
        const dir = yield* makeTempDirectoryScoped("gent-link-far-")
        const log = `${dir}/far.log`
        const { links } = yield* linksOver({ far: yield* farEnd(contract, "exit", log) })
        yield* logUntil(log, (lines) => starts(lines) >= 2)
        expect(logs.seen[0]?.machine).toBe("far")
        expect(logs.seen.map((end) => end.error).join("\n")).toContain("exit code 3: far end gone")
        expect((yield* links.view)[0]?.machine).toBe("far")
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(platformLayer, logs.layer)))
    },
    30_000,
  )

  it.live(
    "a far end on another contract, or with no hello, is incompatible and gets no facts",
    () =>
      Effect.gen(function* () {
        const contract = yield* linkContract
        const dir = yield* makeTempDirectoryScoped("gent-link-far-")
        const otherLog = `${dir}/other.log`
        const olderLog = `${dir}/older.log`
        const { links, placement } = yield* linksOver({
          other: yield* farEnd(`${contract}-other`, "serve", otherLog),
          older: yield* farEnd(contract, "nohello", olderLog),
        })
        expect(
          yield* viewUntil(links, (view) => view.every((link) => link.state === "incompatible")),
        ).toEqual([
          { machine: "other", state: "incompatible" },
          { machine: "older", state: "incompatible" },
        ])
        // Past the first retry: each run asked for the hello and nothing else.
        yield* logUntil(otherLog, (lines) => starts(lines) >= 2)
        for (const log of [otherLog, olderLog]) {
          const lines = yield* logged(log)
          expect(lines.filter((line) => line !== "start")).toEqual(
            lines.filter((line) => line !== "start").map(() => `request link.hello origin=${OWN}`),
          )
        }
        const report = yield* placement.lanes(() => Effect.succeedNone, Option.none())
        expect(report.peer?.heard).toBeUndefined()
      }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  )

  it.live(
    "a line that is no frame, or a stdout closed while the command runs, ends the run",
    () => {
      const logs = ends()
      return Effect.gen(function* () {
        const contract = yield* linkContract
        const dir = yield* makeTempDirectoryScoped("gent-link-far-")
        const { links } = yield* linksOver({
          garbage: yield* farEnd(contract, "garbage", `${dir}/garbage.log`),
          // An ssh whose remote end closed its output and kept running.
          closed: ["sh", "-c", "exec sleep 600 > /dev/null"],
        })
        const ended = (machine: string) => logs.seen.some((end) => end.machine === machine)
        for (let tries = 0; tries < 250 && !(ended("garbage") && ended("closed")); tries++)
          yield* wallSleep(20)
        const byMachine = new Map(logs.seen.map((end) => [end.machine, end.error]))
        expect(byMachine.get("garbage")).toContain("exit code none (it still ran)")
        expect(byMachine.get("closed")).toContain("exit code none (it still ran)")
        // The garbage never connected; the closed one did, before its stdout closed.
        const view = new Map((yield* links.view).map((link) => [link.machine, link.state]))
        expect(view.get("garbage")).toBe("connecting")
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(platformLayer, logs.layer)))
    },
  )
})
