import { describe, expect, it } from "effect-bun-test"
import {
  type Cause,
  Clock,
  ConfigProvider,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Queue,
  References,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Rpc } from "effect/rpc"
import { TestClock } from "effect/testing"
import {
  ConfigService,
  type LinkMachines,
  RuntimeEnvironment,
  UserConfig,
} from "../../src/runtime/config"
import {
  GentPlatform,
  GentRelease,
  GentReleaseFacts,
  runProcess,
} from "../../src/runtime/gent-platform"
import {
  BunGentPlatformLive,
  DELETED_FILE,
  captureRelease,
  sourceRelease,
} from "../../src/runtime/gent-platform-bun"
import { type LaneReport, PoolFacts } from "../../src/domain/driver"
import { ProviderId } from "../../src/domain/agent"
import { CredentialSlot } from "../../src/domain/ids"
import {
  CredentialPlacement,
  type LaneScopeOf,
  makeCredentialPlacement,
} from "../../src/runtime/provider"
import { Links, linkContract, rpcContract } from "../../src/server/link"
import {
  BunTestServices,
  createRpcHarness,
  LanguageModelLayers,
  makeTempDirectoryScoped,
} from "../../src/test-utils/harness"
import { e2ePreset } from "../helpers/test-preset"

/** The test platform's host name: this server's machine name. */
const OWN = "test-host"
const encodeFacts = Schema.encodeSync(Schema.fromJsonString(PoolFacts))
/** A string as a quoted JSON (and TypeScript) literal. */
const encodeText = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const FAR_FACTS = encodeFacts({ boot: "far-boot", host: "far", seq: 0, providers: [] })

/**
 * The far end's argv: this bun running the fixture, as `gent ctl link` would
 * be run; its hello names the machine `facts` name.
 */
const farEnd = (contract: string, mode: string, log: string, facts = FAR_FACTS) =>
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
      facts,
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
 * This server's links over `machines`, with a placement of its own that
 * reads each provider's pool as `scopeOf` names it, until the scope closes.
 */
const linksOver = (machines: LinkMachines, scopeOf: LaneScopeOf = () => Effect.succeedNone) =>
  Effect.gen(function* () {
    const dir = yield* makeTempDirectoryScoped("gent-link-")
    const placement = yield* makeCredentialPlacement(Option.none())
    const context = yield* Layer.build(
      Links.Live(scopeOf).pipe(
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
        const far = () => report.peers?.find((peer) => peer.machine === "far")
        for (let tries = 0; tries < 250 && Predicate.isUndefined(far()?.heardAt); tries++) {
          yield* wallSleep(20)
          report = yield* placement.lanes(() => Effect.succeedNone, Option.none())
        }
        expect(report.peers).toMatchObject([{ machine: "far", down: [] }])
        expect(far()?.heardAt).toBeDefined()
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
        expect(report.peers).toMatchObject([{ machine: "far", down: ["own"] }])
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
    "a far end on another contract, with no hello, or answering as another machine is incompatible and gets no facts",
    () =>
      Effect.gen(function* () {
        const contract = yield* linkContract
        const dir = yield* makeTempDirectoryScoped("gent-link-far-")
        const otherLog = `${dir}/other.log`
        const olderLog = `${dir}/older.log`
        const elsewhereLog = `${dir}/elsewhere.log`
        const { links, placement } = yield* linksOver({
          other: yield* farEnd(`${contract}-other`, "serve", otherLog),
          older: yield* farEnd(contract, "nohello", olderLog),
          // Its hello names machine `far`: a command that reaches another machine.
          elsewhere: yield* farEnd(contract, "serve", elsewhereLog),
        })
        expect(
          yield* viewUntil(links, (view) => view.every((link) => link.state === "incompatible")),
        ).toEqual([
          { machine: "other", state: "incompatible" },
          { machine: "older", state: "incompatible" },
          { machine: "elsewhere", state: "incompatible" },
        ])
        // Past the first retry: each run asked for the hello and nothing else.
        yield* logUntil(otherLog, (lines) => starts(lines) >= 2)
        for (const log of [otherLog, olderLog, elsewhereLog]) {
          const lines = yield* logged(log)
          expect(lines.filter((line) => line !== "start")).toEqual(
            lines.filter((line) => line !== "start").map(() => `request link.hello origin=${OWN}`),
          )
        }
        const report = yield* placement.lanes(() => Effect.succeedNone, Option.none())
        // No line came from any of them: each is a link of this server, never heard.
        expect(report.peers?.map((peer) => Predicate.isUndefined(peer.heardAt))).toEqual([
          true,
          true,
          true,
        ])
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

  it.live(
    "a far end that stops reading after its hello, with its stdin full, ends with the link's scope within the force-kill window",
    () =>
      Effect.gen(function* () {
        const contract = yield* linkContract
        const dir = yield* makeTempDirectoryScoped("gent-link-far-")
        const log = `${dir}/far.log`
        const scope = yield* Scope.make()
        // A 1.5 MB machine name: each call's origin header and the facts
        // this server pushes carry it, past what the pipe and the far end's
        // read-ahead hold (about 1 MB under Bun).
        const { links } = yield* linksOver({ far: yield* farEnd(contract, "deaf", log) }).pipe(
          Scope.provide(scope),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { GENT_MACHINE: "m".repeat(1_500_000) } }),
            ),
          ),
        )
        yield* viewUntil(links, (view) => view[0]?.state === "connected")
        const lines = yield* logUntil(log, (found) =>
          found.some((line) => line.startsWith("deaf ")),
        )
        const pid = Number((lines.find((line) => line.startsWith("deaf ")) ?? "").slice(5))
        // The pool's request and the facts' push go out, and the pipe fills.
        yield* wallSleep(500)
        const alive = Effect.try(() => process.kill(pid, 0)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
        expect(yield* alive).toBe(true)
        // The far end outlives SIGTERM: the force kill after 2 s ends it.
        // The close runs apart, so one that hangs fails here at 6 s.
        const closing = yield* Effect.forkDetach(Effect.timed(Scope.close(scope, Exit.void)))
        const closed = yield* Fiber.await(closing).pipe(Effect.timeout("6 seconds"), Effect.option)
        const took = Option.match(closed, {
          onNone: () => Number.POSITIVE_INFINITY,
          onSome: (exit) =>
            Exit.match(exit, {
              onSuccess: ([duration]) => Duration.toMillis(duration),
              onFailure: () => Number.POSITIVE_INFINITY,
            }),
        })
        // Past the 2 s SIGTERM grace: the far end did outlive it.
        expect(took).toBeGreaterThanOrEqual(1_900)
        expect(took).toBeLessThan(3_500)
        expect(yield* alive).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(platformLayer)),
    15_000,
  )
})

// ── linked machines: each its own peer ──────────────────────────────────────

const DEFAULT = CredentialSlot.make("default")
/** The facts machine `host` streams: `count` runs on this server's account `default`. */
const runsOn = (host: string, count: number) =>
  encodeFacts({
    boot: `${host}-boot`,
    host,
    seq: 1,
    providers: [{ provider: "anthropic", runs: [{ accounts: [DEFAULT], count }], accounts: [] }],
  })

describe("linked machines", () => {
  it.live(
    "two linked machines keep their own facts: the lanes report each one's runs, and they add up",
    () =>
      Effect.gen(function* () {
        const contract = yield* linkContract
        const dir = yield* makeTempDirectoryScoped("gent-link-far-")
        const scopeOf: LaneScopeOf = () =>
          Effect.succeedSome([{ provider: ProviderId.make("anthropic"), slot: DEFAULT }])
        const { links, placement } = yield* linksOver(
          {
            b: yield* farEnd(contract, "serve", `${dir}/b.log`, runsOn("b", 2)),
            c: yield* farEnd(contract, "serve", `${dir}/c.log`, runsOn("c", 3)),
          },
          scopeOf,
        )
        yield* viewUntil(links, (view) => view.every((link) => link.state === "connected"))
        let report = yield* placement.lanes(scopeOf, Option.none())
        const heard = () =>
          (report.peers ?? []).filter((peer) => Predicate.isNotUndefined(peer.heardAt))
        for (let tries = 0; tries < 250 && heard().length < 2; tries++) {
          yield* wallSleep(20)
          report = yield* placement.lanes(scopeOf, Option.none())
        }
        expect(report.peers).toMatchObject([
          { machine: "b", runs: 2, silent: false, counted: true, down: [] },
          { machine: "c", runs: 3, silent: false, counted: true, down: [] },
        ])
        expect((report.peers ?? []).reduce((sum, peer) => sum + peer.runs, 0)).toBe(5)
      }).pipe(Effect.scoped, Effect.provide(platformLayer)),
    30_000,
  )

  it.live(
    "the server's lanes name each peer's own link: the link to the machine it is",
    () =>
      Effect.gen(function* () {
        // The server runs the Bun platform: its contract names this checkout's source.
        const contract = yield* linkContract.pipe(Effect.provide(BunGentPlatformLive))
        const dir = yield* makeTempDirectoryScoped("gent-link-far-")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          configServiceLayer: ConfigService.Test(
            new UserConfig({
              link: {
                machines: {
                  // The first link of the view: a peer of another contract.
                  c: yield* farEnd(`${contract}-other`, "serve", `${dir}/c.log`, runsOn("c", 0)),
                  b: yield* farEnd(contract, "serve", `${dir}/b.log`, runsOn("b", 0)),
                },
              },
            }),
          ),
        })
        // Wait for both links to settle: each link answers on its own time.
        const linked = (report: LaneReport) =>
          (report.peers?.some(
            (peer) =>
              peer.machine === "b" &&
              Predicate.isNotUndefined(peer.heardAt) &&
              peer.link?.state === "connected",
          ) ??
            false) &&
          (report.peers?.some(
            (peer) => peer.machine === "c" && peer.link?.state === "incompatible",
          ) ??
            false)
        let report = yield* client.accounts.lanes()
        for (let tries = 0; tries < 400 && !linked(report); tries++) {
          yield* wallSleep(20)
          report = yield* client.accounts.lanes()
        }
        expect(report.peers).toMatchObject([
          { machine: "b", link: { machine: "b", state: "connected" } },
          { machine: "c", link: { machine: "c", state: "incompatible" } },
        ])
      }).pipe(Effect.scoped, Effect.provide(platformLayer)),
    30_000,
  )
})

// ── the link's state machine, against a reference model ─────────────────────

/**
 * The reference model of one link, in this server's milliseconds. A run is
 * one start of the link's command; between runs the link waits its backoff.
 * The ping rule is the RPC client's: a tick every 30 s from the run's start
 * sends a ping, and a tick that finds the last ping unanswered with no frame
 * for more than 60 s ends the run, after 1 s for the command's exit code.
 */
const MODEL = {
  silent: 90_000,
  ping: 30_000,
  pingTimeout: 60_000,
  grace: 1_000,
  firstWait: 1_000,
  maxWait: 300_000,
  steady: 60_000,
}

interface ModelRun {
  readonly start: number
  /** The hello was answered with this server's contract. */
  connected: boolean
  helloPending: boolean
  /** The pinger's last frame, and whether its last ping is unanswered. */
  lastSeen: number
  awaiting: boolean
  /** A ping timeout ended the run here; it closes 1 s later. */
  endingSince: Option.Option<number>
}

interface Model {
  now: number
  lastFrame: number
  incompatible: boolean
  wait: number
  run: Option.Option<ModelRun>
  wakeAt: number
  /** Each wait between two runs, in order. */
  readonly gaps: Array<number>
  /** The runs started so far. */
  started: number
}

const modelAt = (now: number): Model => ({
  now,
  lastFrame: now,
  incompatible: false,
  wait: MODEL.firstWait,
  run: Option.some(newModelRun(now)),
  wakeAt: now,
  gaps: [],
  started: 1,
})

const newModelRun = (start: number): ModelRun => ({
  start,
  connected: false,
  helloPending: true,
  lastSeen: start,
  awaiting: false,
  endingSince: Option.none(),
})

const modelState = (model: Model) => {
  if (model.incompatible) return "incompatible"
  if (model.now - model.lastFrame >= MODEL.silent) return "silent"
  if (Option.exists(model.run, (run) => run.connected)) return "connected"
  return "connecting"
}

/** The run ends now: a steady connected run starts the wait over, any other doubles it. */
const endModelRun = (model: Model, run: ModelRun) => {
  if (run.connected && model.now - run.start >= MODEL.steady) model.wait = MODEL.firstWait
  model.gaps.push(model.wait)
  model.wakeAt = model.now + model.wait
  model.wait = Math.min(model.wait * 2, MODEL.maxWait)
  model.run = Option.none()
}

/** A frame from the far end: the link's last frame and the pinger's. */
const modelFrame = (model: Model, run: ModelRun) => {
  model.lastFrame = model.now
  run.lastSeen = model.now
  run.awaiting = false
}

/** The next time something happens on its own: a tick, a run's close, a wake. */
const nextModelEvent = (model: Model) =>
  Option.match(model.run, {
    onNone: () => model.wakeAt,
    onSome: (run) =>
      Option.match(run.endingSince, {
        onSome: (since) => since + MODEL.grace,
        onNone: () =>
          run.start + MODEL.ping * (Math.floor((model.now - run.start) / MODEL.ping) + 1),
      }),
  })

/** What happens at `model.now` on its own. */
const modelEventsNow = (model: Model) => {
  if (Option.isNone(model.run)) {
    if (model.now === model.wakeAt) {
      model.run = Option.some(newModelRun(model.now))
      model.started++
    }
    return
  }
  const run = model.run.value
  if (Option.isSome(run.endingSince)) {
    if (model.now === run.endingSince.value + MODEL.grace) endModelRun(model, run)
    return
  }
  if (model.now === run.start || (model.now - run.start) % MODEL.ping !== 0) return
  if (run.awaiting && model.now - run.lastSeen > MODEL.pingTimeout)
    run.endingSince = Option.some(model.now)
  else run.awaiting = true
}

/**
 * A step the far end, or time, takes. `seconds` is read by `idle` only.
 * `fragment` writes bytes that complete no frame: empty lines, or a part of
 * the next frame short of its newline, which the next frame's write ends.
 */
type LinkStep =
  | "hello-ok"
  | "hello-other"
  | "hello-none"
  | "frame"
  | "fragment"
  | "exit"
  | "idle"
  | "backoff"
interface LinkCommand {
  readonly step: LinkStep
  readonly seconds: number
}

/** The run the far end can still write to: started, not ending. */
const liveRun = (model: Model) => Option.filter(model.run, (run) => Option.isNone(run.endingSince))

/** The steps that apply to the model now, each with its weight. */
const stepsFor = (model: Model): ReadonlyArray<readonly [LinkStep, number]> => {
  const steps: Array<readonly [LinkStep, number]> = [["idle", 3]]
  const live = liveRun(model)
  if (Option.exists(live, (run) => run.helloPending))
    steps.push(["hello-ok", 4], ["hello-other", 1], ["hello-none", 1])
  if (Option.isSome(live)) steps.push(["frame", 3], ["fragment", 3])
  if (Option.isSome(model.run)) steps.push(["exit", 2])
  if (Option.isNone(model.run)) steps.push(["backoff", 5])
  return steps
}

const IDLE_SECONDS = [1, 10, 29, 30, 31, 59, 60, 61, 89, 90, 91, 120, 400]

/** A seeded generator (mulberry32): the same seed, the same sequences. */
const seeded = (seed: number) => {
  let state = seed >>> 0
  return (below: number) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below)
  }
}

const pickCommand = (model: Model, random: (below: number) => number): LinkCommand => {
  const steps = stepsFor(model)
  let roll = random(steps.reduce((total, [, weight]) => total + weight, 0))
  let step: LinkStep = "idle"
  for (const [name, weight] of steps) {
    if (roll < weight) {
      step = name
      break
    }
    roll -= weight
  }
  return { step, seconds: IDLE_SECONDS[random(IDLE_SECONDS.length)] ?? 1 }
}

// The far end as a fake child process: the test writes its stdout and reads its stdin.

const RequestId = Schema.Union([Schema.String, Schema.Finite])
const ClientFrame = Schema.Struct({
  _tag: Schema.String,
  id: Schema.optionalKey(RequestId),
  tag: Schema.optionalKey(Schema.String),
})
const decodeClientFrame = Schema.decodeUnknownOption(Schema.fromJsonString(ClientFrame))
const HelloValue = Schema.Struct({ machine: Schema.String, contract: Schema.String })
const Die = Schema.TaggedStruct("Die", { defect: Schema.String })
const HelloSuccess = Schema.TaggedStruct("Success", { value: HelloValue })
const HelloFailure = Schema.TaggedStruct("Failure", { cause: Schema.Array(Die) })
const ExitReply = Schema.TaggedStruct("Exit", {
  requestId: RequestId,
  exit: Schema.Union([HelloSuccess, HelloFailure]),
})
const Pong = Schema.TaggedStruct("Pong", {})
const ServerFrame = Schema.Union([ExitReply, Pong])
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(ServerFrame))
const frameEncoder = new TextEncoder()

/** One spawn of the fake command, as the far end and the oracle see it. */
interface FakeRun {
  readonly out: Queue.Queue<Uint8Array, Cause.Done>
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>
  readonly spawnedAt: number
  readonly requests: Array<{ readonly tag: string; readonly id: typeof RequestId.Type }>
  closedAt: Option.Option<number>
  /** How the far end answered the hello. */
  hello: "none" | "ours" | "other"
}

/** The stream a command reads as its stdin, when it is one. */
const stdinOf = (command: ChildProcess.Command) => {
  if (!ChildProcess.isStandardCommand(command)) return Option.none()
  const input = command.options.stdin
  if (Stream.isStream(input)) return Option.some(input)
  return Option.none()
}

/** A spawner whose every command is a fake far end; `runs` holds each spawn. */
const fakeSpawner = (runs: Array<FakeRun>) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const run: FakeRun = {
        out: yield* Queue.unbounded<Uint8Array, Cause.Done>(),
        exit: yield* Deferred.make<ChildProcessSpawner.ExitCode>(),
        spawnedAt: yield* Clock.currentTimeMillis,
        requests: [],
        closedAt: Option.none(),
        hello: "none",
      }
      runs.push(run)
      const stdin = stdinOf(command)
      if (Option.isSome(stdin))
        yield* stdin.value.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              const frame = decodeClientFrame(line)
              if (Option.isNone(frame) || frame.value._tag !== "Request") return
              run.requests.push({ tag: frame.value.tag ?? "", id: frame.value.id ?? 0 })
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        )
      yield* Effect.addFinalizer(() =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          run.closedAt = Option.some(now)
        }),
      )
      const ended = (code: number) =>
        Effect.andThen(
          Deferred.succeed(run.exit, ChildProcessSpawner.ExitCode(code)),
          Queue.end(run.out),
        )
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(runs.length),
        exitCode: Deferred.await(run.exit),
        isRunning: Effect.map(Deferred.isDone(run.exit), (done) => !done),
        kill: () => Effect.asVoid(ended(143)),
        stdin: Sink.drain,
        stdout: Stream.fromQueue(run.out),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    }),
  )

/** Lets every fiber the last step woke run to its next wait. */
const settleLong = Effect.gen(function* () {
  for (let turn = 0; turn < 200; turn++) yield* Effect.yieldNow
})

/** Which rules the sequences reached: the test fails on any one never reached. */
interface Reached {
  cap: boolean
  silent: boolean
  incompatible: boolean
  revived: boolean
  reset: boolean
}

/** One generated sequence against one link: the far end's runs, the model, the steps so far. */
interface Trial {
  readonly sequence: number
  readonly contract: string
  readonly links: Links["Service"]
  readonly runs: Array<FakeRun>
  readonly model: Model
  readonly done: Array<string>
  readonly reached: Reached
  readonly random: (below: number) => number
  /** This server's clock at the far end's last whole frame, on any run. */
  lastWrite: number
  /** The rest of a frame the far end began on a run's stdout: the next frame's write ends it. */
  pending: Option.Option<{ readonly run: FakeRun; readonly rest: string }>
}

const trialFail = (trial: Trial, why: string) =>
  Effect.die(`sequence ${trial.sequence}, after [${trial.done.join(", ")}]: ${why}`)

/** A run runs exactly while the model runs one. */
const runsProblem = (trial: Trial) => {
  const open = trial.runs.filter((run) => Option.isNone(run.closedAt)).length
  if (trial.runs.length === trial.model.started && open === Number(Option.isSome(trial.model.run)))
    return Option.none()
  return Option.some(`${trial.runs.length} runs (${open} open), the model's ${trial.model.started}`)
}

/** Nothing but the hello runs over an incompatible link. */
const incompatibleProblem = (trial: Trial, state: string) => {
  const last = trial.runs.at(-1)
  for (const run of trial.runs) {
    const incompatible = run.hello === "other" || (state === "incompatible" && run === last)
    if (incompatible && run.requests.some((request) => request.tag !== "link.hello"))
      return Option.some(
        `an incompatible run asked ${run.requests.map((request) => request.tag).join(", ")}`,
      )
  }
  return Option.none()
}

/**
 * The waits between runs, as the far end saw them: each at most 5 min, the
 * first 1 s, each next one doubled, but 1 s again after a connected run
 * that lived 60 s; and each the model's.
 */
const waitsProblem = (trial: Trial) => {
  const gaps: Array<number> = []
  for (let index = 1; index < trial.runs.length; index++) {
    const before = trial.runs[index - 1]
    const after = trial.runs[index]
    if (Predicate.isUndefined(before) || Predicate.isUndefined(after)) continue
    if (Option.isNone(before.closedAt)) return Option.some(`run ${index} ran beside the next`)
    const gap = after.spawnedAt - before.closedAt.value
    let expected = Math.min((gaps.at(-1) ?? MODEL.firstWait / 2) * 2, MODEL.maxWait)
    if (before.hello === "ours" && before.closedAt.value - before.spawnedAt >= MODEL.steady) {
      expected = MODEL.firstWait
      trial.reached.reset = true
    }
    if (gap > MODEL.maxWait) return Option.some(`a wait of ${gap} ms`)
    if (gap !== expected) return Option.some(`wait ${index} was ${gap} ms, not ${expected} ms`)
    if (gap === MODEL.maxWait) trial.reached.cap = true
    gaps.push(gap)
  }
  if (gaps.join() !== trial.model.gaps.slice(0, gaps.length).join())
    return Option.some(`waits ${gaps.join()}, the model's ${trial.model.gaps.join()}`)
  return Option.none()
}

/** The link's state is the model's, `silent` only 90 s past the far end's last frame. */
const stateProblem = (trial: Trial, state: string) => {
  const expected = modelState(trial.model)
  if (state !== expected) return Option.some(`state ${state}, the model's ${expected}`)
  if (state === "incompatible") trial.reached.incompatible = true
  if (state !== "silent") return Option.none()
  trial.reached.silent = true
  const quiet = trial.model.now - trial.lastWrite
  if (quiet < MODEL.silent) return Option.some(`silent ${quiet} ms after a frame`)
  return Option.none()
}

const linkStateOf = (trial: Trial) =>
  Effect.map(trial.links.view, (view) => view[0]?.state ?? "none")

/** Every invariant, now. */
const checkTrial = (trial: Trial) =>
  Effect.gen(function* () {
    const state = yield* linkStateOf(trial)
    const problem = Option.firstSomeOf([
      runsProblem(trial),
      stateProblem(trial, state),
      incompatibleProblem(trial, state),
      waitsProblem(trial),
    ])
    if (Option.isSome(problem)) return yield* trialFail(trial, problem.value)
  })

/** Moves both clocks to `target`, stopping at each of the model's own events. */
const advanceTrial = (trial: Trial, target: number) =>
  Effect.gen(function* () {
    while (trial.model.now < target) {
      const next = Math.min(target, nextModelEvent(trial.model))
      yield* TestClock.adjust(Duration.millis(next - trial.model.now))
      yield* settleLong
      trial.model.now = next
      modelEventsNow(trial.model)
      yield* checkTrial(trial)
    }
  })

/** Empty lines the far end may write between two frames: no frame. */
const NOISE = ["", "\n", "\r\n", "\n\n"]

/** The rest of a frame the run's stdout began, none on another run. */
const pendingOn = (trial: Trial, run: FakeRun) =>
  Option.match(
    Option.filter(trial.pending, (pending) => pending.run === run),
    { onNone: () => "", onSome: (pending) => pending.rest },
  )

/** Writes `text` on the run's stdout in one to three chunks, cut anywhere. */
const writeChunks = (trial: Trial, run: FakeRun, text: string) =>
  Effect.gen(function* () {
    const cuts = Array.from({ length: trial.random(3) }, () => trial.random(text.length + 1))
    const edges = [0, ...cuts.toSorted((left, right) => left - right), text.length]
    for (let index = 1; index < edges.length; index++) {
      const chunk = text.slice(edges[index - 1], edges[index])
      if (chunk.length > 0) yield* Queue.offer(run.out, frameEncoder.encode(chunk))
    }
    yield* settleLong
  })

/** The far end writes `frame` on the run's stdout: it ends the frame it began first. */
const writeFrame = (trial: Trial, run: FakeRun, frame: typeof ServerFrame.Type) =>
  Effect.gen(function* () {
    const before = pendingOn(trial, run) || (NOISE[trial.random(NOISE.length)] ?? "")
    trial.pending = Option.none()
    trial.lastWrite = trial.model.now
    yield* writeChunks(trial, run, `${before}${encodeServerFrame(frame)}\n`)
  })

/**
 * The far end writes bytes that complete no frame: empty lines and the start
 * of a frame, or more of the frame it began, short of its newline.
 */
const writeFragment = (trial: Trial, run: FakeRun) =>
  Effect.gen(function* () {
    const begun = pendingOn(trial, run)
    if (begun.length > 0) {
      // At least the newline stays unwritten.
      const cut = 1 + trial.random(begun.length - 1)
      if (begun.length > 1) yield* writeChunks(trial, run, begun.slice(0, cut))
      trial.pending = Option.some({ run, rest: begun.slice(Math.min(cut, begun.length - 1)) })
      return
    }
    const frame = `${encodeServerFrame(Pong.make({}))}\n`
    // 0: empty lines alone; at most the whole frame but its newline.
    const cut = trial.random(frame.length)
    const noise = NOISE[1 + trial.random(NOISE.length - 1)] ?? "\n"
    yield* writeChunks(trial, run, `${noise}${frame.slice(0, cut)}`)
    if (cut > 0) trial.pending = Option.some({ run, rest: frame.slice(cut) })
  })

/** The hello's answer for `step`: this contract, another, or the defect of a build with none. */
const helloExit = (step: LinkStep, contract: string): typeof ExitReply.Type.exit => {
  if (step === "hello-other")
    return HelloSuccess.make({ value: { machine: "far", contract: `${contract}-x` } })
  if (step === "hello-none")
    return HelloFailure.make({ cause: [Die.make({ defect: "no link.hello" })] })
  return HelloSuccess.make({ value: { machine: "far", contract } })
}

/** The far end answers the run's hello: the model's run connects, or the link is incompatible. */
const answerHello = (trial: Trial, real: FakeRun, run: ModelRun, step: LinkStep) =>
  Effect.gen(function* () {
    const hello = real.requests.find((request) => request.tag === "link.hello")
    if (Predicate.isUndefined(hello)) return yield* trialFail(trial, "the run sent no hello")
    real.hello = "other"
    if (step === "hello-ok") real.hello = "ours"
    yield* writeFrame(
      trial,
      real,
      ExitReply.make({ requestId: hello.id, exit: helloExit(step, trial.contract) }),
    )
    modelFrame(trial.model, run)
    run.helloPending = false
    trial.model.incompatible = step !== "hello-ok"
    if (step === "hello-ok") run.connected = true
    else endModelRun(trial.model, run)
  })

/** One step on the far end, or of time, on both the link and the model. */
const applyStep = (trial: Trial, command: LinkCommand) =>
  Effect.gen(function* () {
    const { model } = trial
    const real = trial.runs.at(-1)
    if (command.step === "idle") yield* advanceTrial(trial, model.now + command.seconds * 1_000)
    if (command.step === "backoff") yield* advanceTrial(trial, model.wakeAt)
    if (Predicate.isUndefined(real)) return yield* trialFail(trial, "no run was spawned")
    if (Option.isNone(model.run)) return
    const run = model.run.value
    if (command.step === "exit") {
      yield* Deferred.succeed(real.exit, ChildProcessSpawner.ExitCode(1))
      yield* Queue.end(real.out)
      yield* settleLong
      endModelRun(model, run)
    }
    if (command.step === "frame") {
      yield* writeFrame(trial, real, Pong.make({}))
      modelFrame(model, run)
    }
    if (command.step === "fragment") yield* writeFragment(trial, real)
    if (command.step.startsWith("hello-")) yield* answerHello(trial, real, run, command.step)
  })

/** One generated sequence of `STEPS` steps against a fresh link. */
const runSequence = (
  sequence: number,
  contract: string,
  random: (below: number) => number,
  reached: Reached,
) =>
  Effect.gen(function* () {
    const runs: Array<FakeRun> = []
    const { links } = yield* linksOver({ far: ["far-end"] }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner(runs)),
    )
    const model = modelAt(yield* Clock.currentTimeMillis)
    const trial: Trial = {
      sequence,
      contract,
      links,
      runs,
      model,
      done: [],
      reached,
      random,
      lastWrite: model.now,
      pending: Option.none(),
    }
    yield* settleLong
    yield* checkTrial(trial)
    for (let step = 0; step < STEPS; step++) {
      const command = pickCommand(model, random)
      trial.done.push(command.step)
      if (command.step === "idle") trial.done.push(`${command.seconds} s`)
      const wasSilent = modelState(model) === "silent"
      const framed = command.step === "frame" || command.step.startsWith("hello-")
      const live = Option.isSome(liveRun(model))
      yield* applyStep(trial, command)
      yield* checkTrial(trial)
      // A frame on a silent link ends the silence.
      if (!(wasSilent && framed && live)) continue
      if ((yield* linkStateOf(trial)) === "silent")
        return yield* trialFail(trial, "a frame left the link silent")
      if (command.step === "hello-ok") reached.revived = true
    }
  }).pipe(Effect.scoped)

const SEQUENCES = 150
const STEPS = 40
const SEED = 20_261_102

describe("the link's state machine", () => {
  it.effect("a part of a frame at 89 s leaves the link silent at 90 s", () =>
    Effect.gen(function* () {
      const contract = yield* linkContract
      const runs: Array<FakeRun> = []
      const { links } = yield* linksOver({ far: ["far-end"] }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner(runs)),
      )
      yield* settleLong
      const run = runs[0]
      const hello = run?.requests.find((request) => request.tag === "link.hello")
      if (Predicate.isUndefined(run) || Predicate.isUndefined(hello))
        return yield* Effect.die("the run sent no hello")
      const reply = ExitReply.make({ requestId: hello.id, exit: helloExit("hello-ok", contract) })
      yield* Queue.offer(run.out, frameEncoder.encode(`${encodeServerFrame(reply)}\n`))
      yield* settleLong
      yield* TestClock.adjust("89 seconds")
      yield* Queue.offer(run.out, frameEncoder.encode('\n{"_tag":'))
      yield* settleLong
      expect((yield* links.view)[0]?.state).toBe("connected")
      yield* TestClock.adjust("1 second")
      yield* settleLong
      expect((yield* links.view)[0]?.state).toBe("silent")
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(platformLayer, Layer.succeed(References.MinimumLogLevel, "None"))),
    ),
  )

  it.effect(
    `${SEQUENCES} generated sequences (seed ${SEED}) keep the link's state on the model's`,
    () =>
      Effect.gen(function* () {
        const contract = yield* linkContract
        const random = seeded(SEED)
        const reached: Reached = {
          cap: false,
          silent: false,
          incompatible: false,
          revived: false,
          reset: false,
        }
        for (let sequence = 0; sequence < SEQUENCES; sequence++)
          yield* runSequence(sequence, contract, random, reached)
        // The sequences reached each rule they check.
        expect(reached).toEqual({
          cap: true,
          silent: true,
          incompatible: true,
          revived: true,
          reset: true,
        })
      }).pipe(
        Effect.provide(
          Layer.merge(platformLayer, Layer.succeed(References.MinimumLogLevel, "None")),
        ),
      ),
    120_000,
  )
})

// ── the link's contract ─────────────────────────────────────────────────────

/** A schema change that changes what decodes, and a value only one side decodes. */
/** A schema that needs no service to decode or encode. */
type PlainCodec = Schema.Codec<unknown, unknown>

interface CodecChange {
  readonly before: PlainCodec
  readonly after: PlainCodec
  readonly witness: Schema.Json
  readonly name: string
}

/**
 * The leaf changes: each pair decodes the witness differently. Some JSON
 * Schema drops (a pattern's flags), some it keeps; the contract must see
 * each.
 */
const LEAF_CHANGES: ReadonlyArray<(random: (below: number) => number) => CodecChange> = [
  () => ({
    name: "pattern flags",
    before: Schema.String.check(Schema.isPattern(/^ab+c$/)),
    after: Schema.String.check(Schema.isPattern(/^ab+c$/i)),
    witness: "ABBC",
  }),
  () => ({
    name: "pattern source",
    before: Schema.String.check(Schema.isPattern(/^a+$/)),
    after: Schema.String.check(Schema.isPattern(/^b+$/)),
    witness: "aa",
  }),
  (random) => {
    const length = 1 + random(5)
    return {
      name: "minimum length",
      before: Schema.String.check(Schema.isMinLength(length)),
      after: Schema.String.check(Schema.isMinLength(length + 1)),
      witness: "x".repeat(length),
    }
  },
  (random) => {
    const bound = random(100)
    return {
      name: "lower bound",
      before: Schema.Finite.check(Schema.isGreaterThan(bound)),
      after: Schema.Finite.check(Schema.isGreaterThan(bound + 1)),
      witness: bound + 1,
    }
  },
  () => ({
    name: "integer check",
    before: Schema.Finite,
    after: Schema.Finite.check(Schema.isInt()),
    witness: 1.5,
  }),
  () => ({
    name: "literal",
    before: Schema.Literal("a"),
    after: Schema.Literal("b"),
    witness: "a",
  }),
  () => ({ name: "keyword", before: Schema.String, after: Schema.Finite, witness: "s" }),
  () => ({
    name: "optional key",
    before: Schema.Struct({ key: Schema.String }),
    after: Schema.Struct({ key: Schema.optionalKey(Schema.String) }),
    witness: {},
  }),
  () => ({
    name: "key name",
    before: Schema.Struct({ a: Schema.String }),
    after: Schema.Struct({ b: Schema.String }),
    witness: { a: "x" },
  }),
  () => ({
    name: "union member",
    before: Schema.Literals(["a", "b"]),
    after: Schema.Literals(["a", "b", "c"]),
    witness: "c",
  }),
  () => ({
    name: "tuple or array",
    before: Schema.Tuple([Schema.String]),
    after: Schema.Array(Schema.String),
    witness: ["a", "b"],
  }),
]

/** A wrapper around a change, keeping its witness the one value only one side decodes. */
const WRAPPERS: ReadonlyArray<(change: CodecChange) => CodecChange> = [
  ({ before, after, witness, name }) => ({
    name: `${name} in a struct`,
    before: Schema.Struct({ value: before, other: Schema.Boolean }),
    after: Schema.Struct({ value: after, other: Schema.Boolean }),
    witness: { value: witness, other: true },
  }),
  ({ before, after, witness, name }) => ({
    name: `${name} in an array`,
    before: Schema.Array(before),
    after: Schema.Array(after),
    witness: [witness],
  }),
  ({ before, after, witness, name }) => ({
    name: `${name} in a tuple`,
    before: Schema.Tuple([Schema.Boolean, before]),
    after: Schema.Tuple([Schema.Boolean, after]),
    witness: [true, witness],
  }),
  ({ before, after, witness, name }) => ({
    name: `${name} in a union with null`,
    before: Schema.NullOr(before),
    after: Schema.NullOr(after),
    witness,
  }),
  ({ before, after, witness, name }) => ({
    name: `${name} in a record`,
    before: Schema.Record(Schema.String, before),
    after: Schema.Record(Schema.String, after),
    witness: { key: witness },
  }),
]

/** A generated change: a leaf change under zero to three wrappers. */
const generateChange = (random: (below: number) => number): CodecChange => {
  let change = (LEAF_CHANGES[random(LEAF_CHANGES.length)] ?? LEAF_CHANGES[0]!)(random)
  for (let depth = random(4); depth > 0; depth--)
    change = (WRAPPERS[random(WRAPPERS.length)] ?? WRAPPERS[0]!)(change)
  return change
}

/** One RPC whose payload is `payload`: the contract of a group of one. */
const payloadContract = (payload: Schema.Top) =>
  rpcContract([Rpc.make("probe", { payload, success: Schema.Void })])

const decodes = (schema: PlainCodec, value: Schema.Json) =>
  Exit.isSuccess(Schema.decodeExit(Schema.toCodecJson(schema))(value))

/** The test platform with `release` as its source. */
/** The platform whose `source` reads the release with `source`. */
const withSource = (source: Effect.Effect<GentRelease>) =>
  Effect.provideServiceEffect(
    GentPlatform,
    Effect.gen(function* () {
      const platform = yield* GentPlatform
      return GentPlatform.of({ ...platform, source })
    }),
  )

const withRelease = (release: GentRelease) => Effect.succeed(release).pipe(withSource)

const CONTRACT_PAIRS = 400
const CONTRACT_SEED = 20_261_103

describe("the link's contract", () => {
  it.effect(
    `${CONTRACT_PAIRS} generated schema pairs that decode a value differently have different contracts`,
    () =>
      Effect.gen(function* () {
        const random = seeded(CONTRACT_SEED)
        const seen = new Set<string>()
        for (let pair = 0; pair < CONTRACT_PAIRS; pair++) {
          const change = generateChange(random)
          seen.add(change.name.split(" in ")[0] ?? "")
          // The premise: the two sides decode the witness differently.
          expect(
            [decodes(change.before, change.witness), decodes(change.after, change.witness)],
            change.name,
          ).not.toEqual([true, true])
          expect(decodes(change.before, change.witness), change.name).not.toBe(
            decodes(change.after, change.witness),
          )
          const before = yield* payloadContract(change.before)
          const after = yield* payloadContract(change.after)
          expect(before === after, change.name).toBe(false)
        }
        expect(seen.size).toBe(LEAF_CHANGES.length)
      }).pipe(Effect.provide(platformLayer)),
  )

  it.effect("one generated schema, built twice, has one contract", () =>
    Effect.gen(function* () {
      for (let pair = 0; pair < 50; pair++) {
        const first = generateChange(seeded(CONTRACT_SEED + pair))
        const second = generateChange(seeded(CONTRACT_SEED + pair))
        expect(yield* payloadContract(first.after)).toBe(yield* payloadContract(second.after))
      }
    }).pipe(Effect.provide(platformLayer)),
  )
})

// ── the release a contract names ────────────────────────────────────────────

type Random = (below: number) => number
type ReleaseFacts = typeof GentReleaseFacts.Type

const HEX = "0123456789abcdef"
const hex = (random: Random, length: number) =>
  Array.from({ length }, () => HEX[random(HEX.length)] ?? "0").join("")

/** A generated release: a commit, a tree hash, a lockfile hash and a Bun version. */
const generateRelease = (random: Random): ReleaseFacts => ({
  commit: hex(random, 40),
  tree: hex(random, 64),
  lock: hex(random, 64),
  bun: `1.${String(random(10))}.${String(random(20))}`,
})

const RELEASE_FACTS = ["commit", "tree", "lock", "bun"] as const

const releasedOf = (facts: ReleaseFacts) => GentRelease.cases.Released.make({ ...facts })

/** A compiled build's define, as `apps/tui/scripts/build.ts` encodes it. */
const encodeDefine = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      release: Schema.optionalKey(GentReleaseFacts),
    }),
  ),
)

/** The contract in a process of its own (`link-contract.ts`): one line per contract it prints. */
const contractsInProcess = (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
  defined: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const script = yield* path.fromFileUrl(new URL("./link-contract.ts", import.meta.url))
    const define = Option.match(defined, {
      onNone: () => [],
      onSome: (value) => ["--define", `__GENT_BUILD__:${value}`],
    })
    const { stdout, stderr, exitCode } = yield* runProcess(
      process.execPath,
      [...define, script, ...args],
      { env, extendEnv: true },
    )
    expect(exitCode, stderr).toBe(0)
    return stdout.trim().split("\n")
  })

/** Git with no user or system config, and one fixed date: one tree, one commit. */
const fixtureGit = (directory: string, args: ReadonlyArray<string>) =>
  runProcess("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], {
    cwd: directory,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: "2026-11-03T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-11-03T00:00:00Z",
    },
    extendEnv: true,
    stdout: "ignore",
  }).pipe(Effect.map(({ exitCode }) => expect(exitCode).toBe(0)))

/** The source file of a fixture checkout, holding `text`. */
const sourceText = (text: string) =>
  ["const first = 1", "", `console.log(${encodeText(text)})`, "", "const last = 2", ""].join("\n")

/**
 * A clean checkout at `directory`: a lockfile, a `.gitignore` naming
 * `cache/`, one source file holding `text`, and a file `old.ts` git can see
 * renamed, committed.
 */
const checkout = (directory: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(`${directory}/src`, { recursive: true })
    yield* fs.writeFileString(`${directory}/bun.lock`, '{ "lockfileVersion": 1 }\n')
    yield* fs.writeFileString(`${directory}/.gitignore`, "cache/\n")
    yield* fs.writeFileString(`${directory}/src/main.ts`, sourceText(text))
    yield* fs.writeFileString(`${directory}/src/old.ts`, `${sourceText("old").repeat(4)}`)
    yield* fixtureGit(directory, ["init", "-q"])
    yield* fixtureGit(directory, ["add", "-A"])
    yield* fixtureGit(directory, ["commit", "-q", "--no-verify", "-m", "fixture"])
  })

/** `directory`'s source file now holds `text`, committed. */
const commitText = (directory: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${directory}/src/main.ts`, sourceText(text))
    yield* fixtureGit(directory, ["commit", "-q", "--no-verify", "-a", "-m", text])
  })

/** The tree a checkout holds now. */
const treeOf = (directory: string) => captureRelease(directory).pipe(Effect.map(({ tree }) => tree))

/**
 * Local git options that change how git prints a diff: prefixes, color, an
 * external diff, renames, the algorithm, the context, the file order, path
 * quoting. The tree must not see them.
 */
const PRINT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["diff.noprefix", "true"],
  ["diff.mnemonicPrefix", "true"],
  ["color.ui", "always"],
  ["color.diff", "always"],
  ["diff.external", "/nonexistent/loop-probe-x"],
  ["diff.renames", "copies"],
  ["diff.algorithm", "histogram"],
  ["diff.indentHeuristic", "false"],
  ["diff.context", "9"],
  ["diff.interHunkContext", "5"],
  ["diff.orderFile", "/nonexistent/loop-probe-x"],
  ["diff.suppressBlankEmpty", "true"],
  ["diff.relative", "true"],
  ["core.quotePath", "false"],
]

/**
 * The same edits in a checkout: a tracked change, a rename, a deletion, a
 * mode change (no content, so no edit of the tree by itself), a binary file
 * and an untracked file with a name git quotes.
 */
const editCheckout = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${directory}/src/main.ts`, sourceText("edited"))
    yield* fixtureGit(directory, ["mv", "src/old.ts", "src/new.ts"])
    yield* fs.writeFile(`${directory}/src/blob.bin`, new Uint8Array([0, 1, 2, 255, 0, 7]))
    yield* fixtureGit(directory, ["add", "src/blob.bin"])
    yield* fs.chmod(`${directory}/bun.lock`, 0o755)
    yield* fs.writeFileString(`${directory}/src/naïve.ts`, "export {}\n")
  })

const RELEASES = 200
const RELEASE_SEED = 20_261_105
/** How many of the generated releases a process of its own computes too. */
const RELEASES_IN_PROCESS = 20

/** The Bun platform: its `hash` is the real SHA-256 a process of its own runs. */
const bunPlatformLayer = Layer.mergeAll(BunTestServices, BunGentPlatformLive)

/** A stopped child's force-kill window (`runProcess`), plus 1 s. */
const AFTER_CLOSE = Duration.seconds(3)

/**
 * How long the slow git waits before each call: half a second, so a read that
 * goes on after the close starts another git inside the watch; then longer
 * than the watch, so a git the close did not stop still runs at its end.
 */
const SLOW_GIT_WAITS = [Duration.millis(500), Duration.sum(AFTER_CLOSE, Duration.seconds(2))]

/**
 * A slow git: it logs its pid to `calls`, waits `wait`, then runs as `git`.
 * A SIGTERM during the wait ends the wait and the call.
 */
const slowGit = (calls: string, git: string, wait: Duration.Duration) =>
  [
    "#!/bin/sh",
    `echo $$ >> '${calls}'`,
    `trap 'kill "$waiting" 2>/dev/null; exit 143' TERM`,
    `/bin/sleep ${String(Duration.toMillis(wait) / 1000)} &`,
    "waiting=$!",
    'wait "$waiting"',
    `exec '${git}' "$@"`,
    "",
  ].join("\n")

/** The spawner in context, with each `git` it runs started as `git` instead: the real process path, the slow git. */
const gitAs = (git: string) =>
  Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command) && command.command === "git") {
        return spawner.spawn(ChildProcess.make(git, command.args, command.options))
      }
      return spawner.spawn(command)
    }),
  )

/**
 * The calls the slow git logged once `seen` grew, or by `deadline` (wall
 * clock millis) when it did not.
 */
const callsUntil = (calls: string, seen: number, deadline: number) =>
  Effect.gen(function* () {
    let lines = yield* logged(calls)
    while (lines.length === seen && (yield* Clock.currentTimeMillis) < deadline) {
      yield* wallSleep(50)
      lines = yield* logged(calls)
    }
    return lines
  })

/** Whether the process `pid` runs. */
const alive = (pid: string) =>
  runProcess("/bin/ps", ["-p", pid], { stdout: "ignore", stderr: "ignore" }).pipe(
    Effect.map(({ exitCode }) => exitCode === 0),
  )

describe("the release a contract names", () => {
  it.live(
    `${RELEASES} generated releases (seed ${RELEASE_SEED}): one release and one codec give one contract in any process; another commit, tree, lock, Bun or codec gives another`,
    () =>
      Effect.gen(function* () {
        const random = seeded(RELEASE_SEED)
        const changed = new Set<string>()
        const sample: Array<ReleaseFacts> = []
        const contracts: Array<string> = []
        for (let at = 0; at < RELEASES; at++) {
          const facts = generateRelease(random)
          const contract = yield* linkContract.pipe(withRelease(releasedOf(facts)))
          // The same facts, built again: one contract.
          expect(yield* linkContract.pipe(withRelease(releasedOf({ ...facts })))).toBe(contract)
          const fact = RELEASE_FACTS[random(RELEASE_FACTS.length)] ?? "commit"
          changed.add(fact)
          const other = { ...facts, [fact]: `${facts[fact]}1` }
          expect(yield* linkContract.pipe(withRelease(releasedOf(other))), fact).not.toBe(contract)
          // One release, a codec that decodes a value another way: another contract.
          const change = generateChange(random)
          expect(
            yield* payloadContract(change.before).pipe(withRelease(releasedOf(facts))),
            change.name,
          ).not.toBe(yield* payloadContract(change.after).pipe(withRelease(releasedOf(facts))))
          if (sample.length < RELEASES_IN_PROCESS) {
            sample.push(facts)
            contracts.push(contract)
          }
        }
        expect([...changed].sort()).toEqual([...RELEASE_FACTS].sort())
        // Two processes of their own compute the contracts this one did.
        const args = [
          "release",
          ...sample.flatMap(({ commit, tree, lock, bun }) => [commit, tree, lock, bun]),
        ]
        const [first, second] = yield* Effect.all(
          [contractsInProcess(args), contractsInProcess(args)],
          { concurrency: 2 },
        )
        expect(first).toEqual(contracts)
        expect(second).toEqual(contracts)
      }).pipe(Effect.provide(bunPlatformLayer)),
    60_000,
  )

  it.live(
    "two checkouts of one commit at two paths name one release and one contract in two processes; a new commit names another",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("gent-release-")
          const near = `${root}/near`
          const far = `${root}/far/at/another/depth`
          yield* checkout(near, "one")
          yield* checkout(far, "one")
          const release = yield* captureRelease(near)
          expect(release.tree).toMatch(/^[0-9a-f]{64}$/)
          expect(yield* captureRelease(far)).toEqual(release)
          // A checkout read from a directory inside it names the same release.
          expect(yield* captureRelease(`${far}/src`)).toEqual(release)
          const contract = yield* linkContract.pipe(withRelease(releasedOf(release)))
          const [atNear, atFar] = yield* Effect.all(
            [contractsInProcess(["checkout", near]), contractsInProcess(["checkout", far])],
            { concurrency: 2 },
          )
          expect(atNear).toEqual([contract])
          expect(atFar).toEqual([contract])
          yield* commitText(far, "two")
          const next = yield* captureRelease(far)
          expect(next.commit).not.toBe(release.commit)
          expect(yield* contractsInProcess(["checkout", far])).not.toEqual([contract])
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
    30_000,
  )

  it.live(
    "a dirty tree names its edits: one tree in any process and at any path, whatever git prints a diff with; another edit names another, an ignored file none",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* makeTempDirectoryScoped("gent-release-")
          const plain = `${root}/plain`
          const configured = `${root}/configured/at/depth`
          yield* checkout(plain, "one")
          yield* checkout(configured, "one")
          const clean = yield* captureRelease(plain)
          for (const [key, value] of PRINT_CONFIG) {
            yield* fixtureGit(configured, ["config", key, value])
          }
          // The config is the repository's, not its working files: one tree.
          expect(yield* treeOf(configured)).toBe(clean.tree)
          yield* editCheckout(plain)
          yield* editCheckout(configured)
          const dirty = yield* captureRelease(plain)
          expect(dirty.commit).toBe(clean.commit)
          expect(dirty.tree).toMatch(/^[0-9a-f]{64}$/)
          expect(yield* captureRelease(configured)).toEqual(dirty)
          // Two processes of their own, of either checkout, name one contract.
          const contract = yield* linkContract.pipe(withRelease(releasedOf(dirty)))
          expect(contract).not.toBe(yield* linkContract.pipe(withRelease(releasedOf(clean))))
          const [atPlain, atConfigured] = yield* Effect.all(
            [contractsInProcess(["checkout", plain]), contractsInProcess(["checkout", configured])],
            { concurrency: 2 },
          )
          expect(atPlain).toEqual([contract])
          expect(atConfigured).toEqual([contract])
          // An ignored file is no edit.
          yield* fs.makeDirectory(`${plain}/cache`)
          yield* fs.writeFileString(`${plain}/cache/built.js`, "ignored\n")
          expect(yield* treeOf(plain)).toBe(dirty.tree)
          // Each further edit names another tree.
          const seen = new Set([clean.tree, dirty.tree])
          const edits: ReadonlyArray<
            readonly [string, Effect.Effect<void, PlatformError.PlatformError>]
          > = [
            ["a tracked file", fs.writeFileString(`${plain}/src/main.ts`, sourceText("again"))],
            [
              "an untracked file's bytes",
              fs.writeFileString(`${plain}/src/naïve.ts`, "export {} \n"),
            ],
            ["a new untracked file", fs.writeFileString(`${plain}/src/added.ts`, "export {}\n")],
            [
              "an untracked file's name",
              fs.rename(`${plain}/src/added.ts`, `${plain}/src/other.ts`),
            ],
            ["an untracked file gone", fs.remove(`${plain}/src/naïve.ts`)],
          ]
          for (const [edit, apply] of edits) {
            yield* apply
            const tree = yield* treeOf(plain)
            expect(seen.has(tree), edit).toBe(false)
            seen.add(tree)
          }
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
    30_000,
  )

  it.live(
    "with no git, or outside a repository, a process names no release: its contract matches no other process's",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("gent-release-")
          const outside = yield* captureRelease(root).pipe(Effect.flip)
          expect(outside.reason).toStartWith("git rev-parse")
          yield* checkout(`${root}/clean`, "one")
          const clean = yield* captureRelease(`${root}/clean`)
          // The same clean checkout, read by processes whose PATH holds no git.
          const noGit = { PATH: "/nonexistent/loop-probe-x" }
          const [first, second] = yield* Effect.all(
            [
              contractsInProcess(["checkout", `${root}/clean`], noGit),
              contractsInProcess(["checkout", `${root}/clean`], noGit),
            ],
            { concurrency: 2 },
          )
          const released = yield* linkContract.pipe(withRelease(releasedOf(clean)))
          expect(new Set([released, ...first, ...second]).size).toBe(3)
          const [outsideFirst, outsideSecond] = yield* Effect.all(
            [contractsInProcess(["checkout", root]), contractsInProcess(["checkout", root])],
            { concurrency: 2 },
          )
          expect(new Set([...outsideFirst, ...outsideSecond]).size).toBe(2)
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
    30_000,
  )

  it.live(
    "a source run reads its release as the server starts: an edit and a commit made after the start do not change its contract",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* makeTempDirectoryScoped("gent-release-")
          yield* checkout(root, "one")
          const started = yield* captureRelease(root)
          const read = yield* Deferred.make<boolean>()
          const source = yield* Effect.cached(
            sourceRelease(root).pipe(
              Effect.tap(() => Deferred.succeed(read, true)),
              Effect.provideContext(
                yield* Effect.context<
                  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
                >(),
              ),
            ),
          )
          const { links } = yield* linksOver({}).pipe(withSource(source))
          // Nothing asked for the contract: the start read the release.
          yield* Deferred.await(read).pipe(Effect.timeout("10 seconds"))
          yield* fs.writeFileString(`${root}/src/main.ts`, sourceText("edited"))
          expect((yield* captureRelease(root)).tree).not.toBe(started.tree)
          yield* commitText(root, "two")
          expect((yield* captureRelease(root)).commit).not.toBe(started.commit)
          expect(yield* links.contract).toBe(
            yield* linkContract.pipe(withRelease(releasedOf(started))),
          )
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
    30_000,
  )

  it.live(
    "a server that stops while its release is read stops at once: its close never waits for the read",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<boolean>()
        const done = yield* Deferred.make<boolean>()
        // A read the server cannot cut short, as a git child that exits only
        // some time after its stop: it ends when the test lets it.
        const held = Effect.uninterruptible(
          Deferred.succeed(reading, true).pipe(
            Effect.andThen(Deferred.await(done)),
            Effect.as(releasedOf(generateRelease(seeded(RELEASE_SEED)))),
          ),
        )
        const server = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* linksOver({}).pipe(withSource(held))
            yield* Deferred.await(reading).pipe(Effect.timeout("10 seconds"))
          }),
        ).pipe(Effect.forkChild)
        // The server closed while the read still runs.
        const closed = yield* Fiber.await(server).pipe(Effect.timeout("5 seconds"), Effect.option)
        yield* Deferred.succeed(done, true)
        expect(Option.map(closed, Exit.isSuccess)).toEqual(Option.some(true))
      }).pipe(Effect.provide(bunPlatformLayer)),
    30_000,
  )

  it.live(
    "a server that stops while git reads its release stops the read: no git starts after the close, no git it started outlives the force-kill window, and the close takes less than that window plus 1 s",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* makeTempDirectoryScoped("gent-release-")
          const repo = `${root}/repo`
          yield* checkout(repo, "one")
          for (const [at, wait] of SLOW_GIT_WAITS.entries()) {
            const name = `git waits ${Duration.format(wait)}`
            const calls = `${root}/calls-${String(at)}`
            const bin = `${root}/bin-${String(at)}`
            yield* fs.makeDirectory(bin)
            yield* fs.writeFileString(
              `${bin}/git`,
              slowGit(calls, Bun.which("git") ?? "/usr/bin/git", wait),
            )
            yield* fs.chmod(`${bin}/git`, 0o755)
            const read = yield* Deferred.make<boolean>()
            const source = sourceRelease(repo).pipe(
              Effect.tap(() => Deferred.succeed(read, true)),
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                yield* gitAs(`${bin}/git`),
              ),
              Effect.provideContext(
                yield* Effect.context<
                  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
                >(),
              ),
            )
            const server = yield* Scope.make()
            yield* linksOver({}).pipe(withSource(source), Scope.provide(server))
            // The read waits in its first git call.
            yield* logUntil(calls, (lines) => lines.length > 0)
            const closing = yield* Clock.currentTimeMillis
            yield* Scope.close(server, Exit.void)
            const closedIn = (yield* Clock.currentTimeMillis) - closing
            const atClose = yield* logged(calls)
            // Watch the force-kill window plus 1 s for another git call.
            expect(
              yield* callsUntil(calls, atClose.length, closing + Duration.toMillis(AFTER_CLOSE)),
              name,
            ).toEqual(atClose)
            expect(yield* Deferred.isDone(read), name).toBe(false)
            for (const pid of atClose) expect(yield* alive(pid), `${name}: git ${pid}`).toBe(false)
            expect(closedIn, name).toBeLessThan(Duration.toMillis(AFTER_CLOSE))
          }
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
    30_000,
  )

  it.live(
    "a compiled gent names the release its build embedded; a build that embedded none names an id of its own process",
    () =>
      Effect.gen(function* () {
        const facts = generateRelease(seeded(RELEASE_SEED))
        const build = (release: Option.Option<ReleaseFacts>) =>
          encodeDefine({
            id: "build-id",
            version: "1.0.0",
            ...Option.match(release, {
              onNone: () => ({}),
              onSome: (value) => ({ release: value }),
            }),
          })
        const embedded = yield* contractsInProcess(
          ["platform"],
          {},
          Option.some(build(Option.some(facts))),
        )
        expect(embedded).toEqual([yield* linkContract.pipe(withRelease(releasedOf(facts)))])
        const none = Option.some(build(Option.none()))
        const [first, second] = yield* Effect.all(
          [contractsInProcess(["platform"], {}, none), contractsInProcess(["platform"], {}, none)],
          { concurrency: 2 },
        )
        expect(new Set([...first, ...second, ...embedded]).size).toBe(3)
      }).pipe(Effect.provide(bunPlatformLayer)),
    30_000,
  )
})

// ── the tree a release names ────────────────────────────────────────────────

const sha256Hex = (input: Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(input).digest("hex")
const utf8 = (text: string) => new TextEncoder().encode(text)
const pick = <A>(random: Random, from: ReadonlyArray<A>): A => from[random(from.length)] ?? from[0]!

const TreeEntry = Schema.TaggedUnion({
  File: { bytes: Schema.Uint8Array },
  Link: { target: Schema.String },
  Deleted: {},
})
type TreeEntry = typeof TreeEntry.Type

/** A listed entry of a generated checkout, including deleted tracked entries. */
interface ModelFile {
  readonly tracked: boolean
  readonly entry: TreeEntry
}

/**
 * Independent oracle: the model names the paths (never git); lstat reads
 * their kinds and readLink reads links themselves. Whole-file reads are
 * fine for these tiny fixtures; production must stream them.
 */
const modelTree = (directory: string, files: ReadonlyMap<string, ModelFile>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const lines: Array<string> = []
    for (const file of [...files.keys()].sort()) {
      const full = `${directory}/${file}`
      const stat = yield* fs.lstat(full).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
      )
      if (Option.isNone(stat)) lines.push(`${file}\0${DELETED_FILE}\n`)
      else if (stat.value.type === "SymbolicLink")
        lines.push(`${file}\0link\0${yield* fs.readLink(full)}\n`)
      else if (stat.value.type === "File")
        lines.push(`${file}\0file\0${sha256Hex(yield* fs.readFile(full))}\n`)
      else return Option.none<string>()
    }
    return Option.some(sha256Hex(lines.join("")))
  })

/** Pieces of a file's bytes: digits a clean filter hides, CRLF, a function line, bytes no UTF-8 names. */
const FRAGMENTS: ReadonlyArray<Uint8Array> = [
  utf8("export const value = 3\n"),
  utf8("export const value = 7\r\n"),
  utf8("function alpha() {\n"),
  utf8("  const x15 = 99\n"),
  utf8("// a comment\r\n"),
  utf8("no newline at the end"),
  new Uint8Array([0, 1, 2, 255]),
  new Uint8Array([0xc3, 0x28, 13, 10]),
]

const generateBytes = (random: Random) =>
  Uint8Array.from(
    Array.from({ length: random(4) }, () => pick(random, FRAGMENTS)).flatMap((part) => [...part]),
  )

/** The same bytes with one byte changed, or one byte for an empty file. */
const changeOneByte = (random: Random, bytes: Uint8Array) => {
  if (bytes.length === 0) return Uint8Array.of(65)
  const changed = Uint8Array.from(bytes)
  const at = random(changed.length)
  changed[at] = (changed[at] ?? 0) ^ 1
  return changed
}

const TRACKED_PATHS = [
  "src/main.ts",
  "src/value.ts",
  "notes/readme.txt",
  "notes/crlf.txt",
  "blob/data.dat",
  "top.ts",
]
const UNTRACKED_PATHS = ["src/added.ts", "notes/new.txt", "fresh/deep/file.dat"]
/** Files an edit leaves alone: the lock a release reads, and the ignore rules the model keeps. */
const FIXED_PATHS = new Set(["bun.lock", ".gitignore"])

/** `.gitattributes` lines: a clean filter, diff drivers, line-ending conversion. */
const ATTRIBUTES = [
  "*.ts filter=mask",
  "*.txt diff=demo",
  "*.ts diff=demo",
  "* text=auto",
  "*.dat -text",
  "*.txt text eol=crlf",
]
/** Clean filters, most of them many-to-one: git stores another blob than the working bytes. */
const CLEAN_FILTERS = [
  "LC_ALL=C sed 's/[0-9]/0/g'",
  "LC_ALL=C tr -d '\\r'",
  "LC_ALL=C sed 's/value = .*/value/'",
  "cat",
]
const XFUNCNAMES = ["^function", "^//", "^export"]
const AUTOCRLF = ["true", "false", "input"]

/** A local git config: the clean filter, the diff driver's hunk header and line-ending conversion. */
const generateConfig = (random: Random): ReadonlyArray<readonly [string, string]> => [
  ["filter.mask.clean", pick(random, CLEAN_FILTERS)],
  ["diff.demo.xfuncname", pick(random, XFUNCNAMES)],
  ["core.autocrlf", pick(random, AUTOCRLF)],
]

const configure = (directory: string, config: ReadonlyArray<readonly [string, string]>) =>
  Effect.forEach(config, ([key, value]) => fixtureGit(directory, ["config", key, value]), {
    discard: true,
  })

const writeBytes = (directory: string, file: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(`${directory}/${file}`), { recursive: true })
    yield* fs.writeFile(`${directory}/${file}`, bytes)
  })

const TREE_EDITS = [
  "a tracked file edited",
  "a tracked file deleted",
  "a tracked file emptied",
  "an untracked file added",
  "an untracked file removed",
  "an ignored file written",
  "a tracked link repointed",
  "an untracked link added",
  "an untracked link repointed",
  "a tracked link made dangling",
  "a dangling link re-dangled",
  "a link to a non-regular target",
  "a link replaced by a file",
] as const

/** One generated edit to the checkout at `directory` and to its model: the edit it made. */
const generateEdit = (
  directory: string,
  files: Map<string, ModelFile>,
  random: Random,
  selected = pick(random, TREE_EDITS),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const present = (tracked: boolean) => {
      const paths: Array<string> = []
      for (const [path, file] of files) {
        if (file.tracked === tracked && file.entry._tag === "File" && !FIXED_PATHS.has(path)) {
          paths.push(path)
        }
      }
      return paths
    }
    const put = (file: string, tracked: boolean, bytes: Uint8Array) =>
      writeBytes(directory, file, bytes).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            files.set(file, { tracked, entry: TreeEntry.cases.File.make({ bytes }) }),
          ),
        ),
      )
    const link = (file: string, tracked: boolean, target: string) =>
      Effect.gen(function* () {
        // exists follows links, so remove by the model, including dangling links.
        if (files.has(file)) yield* fs.remove(`${directory}/${file}`, { force: true })
        yield* fs.makeDirectory(`${directory}/fresh`, { recursive: true })
        yield* fs.symlink(target, `${directory}/${file}`)
        files.set(file, { tracked, entry: TreeEntry.cases.Link.make({ target }) })
      })
    let edit = selected
    const tracked = present(true)
    const untracked = present(false)
    if (tracked.length === 0 && edit.startsWith("a tracked")) edit = "an untracked file added"
    if (edit === "a tracked file edited")
      yield* put(pick(random, tracked), true, generateBytes(random))
    if (edit === "a tracked file emptied") yield* put(pick(random, tracked), true, new Uint8Array())
    if (edit === "a tracked file deleted") {
      const file = pick(random, tracked)
      yield* fs.remove(`${directory}/${file}`)
      files.set(file, { tracked: true, entry: TreeEntry.cases.Deleted.make({}) })
    }
    if (edit === "an untracked file added") {
      yield* put(pick(random, UNTRACKED_PATHS), false, generateBytes(random))
    }
    if (edit === "an untracked file removed") {
      if (untracked.length === 0) {
        yield* put("fresh/transient.ts", false, generateBytes(random))
        untracked.push("fresh/transient.ts")
      }
      const file = pick(random, untracked)
      yield* fs.remove(`${directory}/${file}`)
      files.delete(file)
    }
    if (edit === "an ignored file written") {
      yield* writeBytes(directory, `cache/${String(random(3))}.js`, generateBytes(random))
    }
    if (edit === "a tracked link repointed") yield* link("linked.ts", true, "src/old.ts")
    if (edit === "an untracked link added") yield* link("fresh/link.ts", false, "../src/main.ts")
    if (edit === "an untracked link repointed") yield* link("fresh/link.ts", false, "../src/old.ts")
    if (edit === "a tracked link made dangling") yield* link("linked.ts", true, "missing-one.ts")
    if (edit === "a dangling link re-dangled") {
      yield* link("linked.ts", true, "missing-one.ts")
      yield* link("linked.ts", true, "missing-two.ts")
    }
    if (edit === "a link to a non-regular target") {
      yield* fs.makeDirectory(`${directory}/cache`, { recursive: true })
      if (!(yield* fs.exists(`${directory}/cache/pipe`))) {
        expect((yield* runProcess("mkfifo", [`${directory}/cache/pipe`])).exitCode).toBe(0)
      }
      yield* link("linked.ts", true, "cache/pipe")
    }
    if (edit === "a link replaced by a file") {
      yield* link("linked.ts", true, "src/main.ts")
      yield* fs.remove(`${directory}/linked.ts`)
      yield* put("linked.ts", true, generateBytes(random))
    }
    return edit
  })

/**
 * A checkout of `main.ts` holding `source` under `attributes`, committed with
 * `config` set: the shape of the review's git-input probes.
 */
const attributedCheckout = (
  directory: string,
  attributes: string,
  source: string,
  config: ReadonlyArray<readonly [string, string]> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(directory, { recursive: true })
    yield* fs.writeFileString(`${directory}/bun.lock`, "lock fixture\n")
    yield* fs.writeFileString(`${directory}/.gitattributes`, attributes)
    yield* fs.writeFileString(`${directory}/main.ts`, source)
    yield* fixtureGit(directory, ["init", "-q"])
    yield* configure(directory, config)
    yield* fixtureGit(directory, ["add", "-A"])
    yield* fixtureGit(directory, ["commit", "-q", "--no-verify", "-m", "fixture"])
  })

/** What `git status` prints of a checkout: empty when git sees no change. */
const gitStatus = (directory: string) =>
  runProcess("git", ["-C", directory, "status", "--porcelain"]).pipe(
    Effect.map(({ stdout }) => stdout),
  )

const TREE_CASES = 16
const TREE_SEED = 20_261_106

/** Git prints canonical roots (/private/var on macOS), so boundary paths use them too. */
const treeDirectory = makeTempDirectoryScoped("gent-tree-").pipe(
  Effect.flatMap((directory) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(directory)),
  ),
)

/** Replace only git's path-list bytes; real git still owns its child and exit. */
const listedBytes = (bytes: Uint8Array) =>
  Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    ChildProcessSpawner.make((command) =>
      spawner.spawn(command).pipe(
        Effect.map((handle) => {
          if (ChildProcess.isStandardCommand(command) && command.args.includes("ls-files")) {
            return { ...handle, stdout: Stream.make(bytes) }
          }
          return handle
        }),
      ),
    ),
  )

describe("the tree a release names", () => {
  it.live(
    "a non-UTF-8 path from git names no release; a valid leading BOM in a path is preserved",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* treeDirectory
          yield* checkout(directory, "one")
          const invalid = yield* listedBytes(Uint8Array.of(0x63, 0x61, 0x66, 0xe9, 0))
          const failed = yield* captureRelease(directory).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, invalid),
            Effect.flip,
          )
          expect(failed._tag).toBe("NoRelease")
          expect(failed.reason).toContain("UTF-8")
          const file = "\ufeffentry.ts"
          yield* writeBytes(directory, file, utf8("content\n"))
          const valid = yield* listedBytes(utf8(`${file}\0`))
          const tree = yield* treeOf(directory).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, valid),
          )
          expect(tree).toBe(sha256Hex(`${file}\0file\0${sha256Hex("content\n")}\n`))
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
  )

  it.live("a listed directory or gitlink, FIFO, socket or device names no release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* treeDirectory
        yield* checkout(directory, "one")
        const kinds: ReadonlyArray<FileSystem.File.Type> = [
          "Directory",
          "FIFO",
          "Socket",
          "BlockDevice",
          "CharacterDevice",
          "Unknown",
        ]
        for (const type of kinds) {
          const boundary = FileSystem.FileSystem.of({
            ...fs,
            lstat: (file) =>
              fs.lstat(file).pipe(
                Effect.map((info) => {
                  if (file === `${directory}/src/main.ts`) return { ...info, type }
                  return info
                }),
              ),
          })
          const failed = yield* captureRelease(directory).pipe(
            Effect.provideService(FileSystem.FileSystem, boundary),
            Effect.flip,
          )
          expect(failed._tag, type).toBe("NoRelease")
          expect(failed.reason, type).toContain(`unsupported ${type}`)
        }
        // A real gitlink: git lists its directory, not the nested files.
        const { commit } = yield* captureRelease(directory)
        yield* fs.makeDirectory(`${directory}/submodule`)
        yield* fixtureGit(directory, [
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${commit},submodule`,
        ])
        expect((yield* captureRelease(directory).pipe(Effect.flip)).reason).toContain(
          "unsupported Directory",
        )
      }),
    ).pipe(Effect.provide(bunPlatformLayer)),
  )

  it.live(
    "a large file and bun.lock are hashed through bounded streams, never whole-file reads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* treeDirectory
          yield* checkout(directory, "one")
          const bytes = Uint8Array.from({ length: 8 * 1024 * 1024 }, (_, at) => at % 251)
          yield* fs.writeFile(`${directory}/large.bin`, bytes)
          const expected = yield* captureRelease(directory)
          const streams = new Set<string>()
          let chunks = 0
          let maxChunk = 0
          const boundary = FileSystem.FileSystem.of({
            ...fs,
            readFile: (file) => Effect.die(`whole-file read of ${file}`),
            stream: (file, options) =>
              fs.stream(file, options).pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    streams.add(file)
                    if (file === `${directory}/large.bin`) {
                      chunks++
                      maxChunk = Math.max(maxChunk, chunk.length)
                    }
                  }),
                ),
              ),
          })
          const actual = yield* captureRelease(directory).pipe(
            Effect.provideService(FileSystem.FileSystem, boundary),
          )
          expect(actual).toEqual(expected)
          expect(streams.has(`${directory}/bun.lock`)).toBe(true)
          expect(chunks).toBeGreaterThan(1)
          expect(maxChunk).toBeLessThanOrEqual(64 * 1024)
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
  )

  it.live(
    "one deadline bounds a hung entry read and the later lock read, leaving no git child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const directory = yield* treeDirectory
          yield* checkout(directory, "one")
          for (const phase of ["lstat", "file", "lock"] as const) {
            const children: Array<string> = []
            let lockReads = 0
            const held = yield* Deferred.make<boolean>()
            const never = Deferred.succeed(held, true).pipe(Effect.andThen(Effect.never))
            const boundary = FileSystem.FileSystem.of({
              ...fs,
              lstat: (file) => {
                if (phase === "lstat" && file.endsWith("/src/main.ts")) return never
                return fs.lstat(file)
              },
              stream: (file, options) => {
                if (phase === "file" && file.endsWith("/src/main.ts"))
                  return Stream.fromEffect(never)
                if (phase === "lock" && file.endsWith("/bun.lock")) {
                  lockReads++
                  if (lockReads === 2) return Stream.fromEffect(never)
                }
                return fs.stream(file, options)
              },
            })
            const observed = ChildProcessSpawner.make((command) =>
              spawner.spawn(command).pipe(
                Effect.tap((handle) =>
                  Effect.sync(() => {
                    children.push(String(handle.pid))
                  }),
                ),
              ),
            )
            const started = yield* Clock.currentTimeMillis
            const capture = yield* captureRelease(directory).pipe(
              Effect.provideService(FileSystem.FileSystem, boundary),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
              Effect.result,
              Effect.forkChild,
            )
            yield* Deferred.await(held).pipe(Effect.timeout("2 seconds"))
            const failed = yield* Fiber.join(capture).pipe(Effect.timeout("11 seconds"))
            expect(failed._tag, phase).toBe("Failure")
            if (failed._tag === "Failure") {
              expect(failed.failure._tag, phase).toBe("NoRelease")
              expect(failed.failure.reason, phase).toContain("10 seconds")
            }
            expect((yield* Clock.currentTimeMillis) - started, phase).toBeLessThan(11_000)
            expect(children.length, phase).toBeGreaterThan(0)
            for (const pid of children)
              expect(yield* alive(pid), `${phase}: git ${pid}`).toBe(false)
          }
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
    40_000,
  )

  it.live(
    "the release deadline reaps even a git child that ignores SIGTERM within one extra second",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* treeDirectory
          yield* checkout(directory, "one")
          const calls = `${directory}/calls`
          const git = `${directory}/git`
          yield* fs.writeFileString(
            git,
            [
              `#!${process.execPath}`,
              'import { appendFileSync } from "node:fs"',
              `appendFileSync(${encodeText(calls)}, String(process.pid) + "\\n")`,
              'process.on("SIGTERM", () => {})',
              "setInterval(() => {}, 1000)",
              "",
            ].join("\n"),
          )
          yield* fs.chmod(git, 0o755)
          const started = yield* Clock.currentTimeMillis
          const error = yield* captureRelease(directory).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, yield* gitAs(git)),
            Effect.flip,
            Effect.timeout("14 seconds"),
          )
          expect(error._tag).toBe("NoRelease")
          expect(error.reason).toContain("10 seconds")
          expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(11_000)
          const children = yield* logged(calls)
          expect(children.length).toBe(1)
          for (const pid of children) expect(yield* alive(pid), `git ${pid}`).toBe(false)
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
    16_000,
  )

  it.scoped(
    "the deadline is shared across git and the tree, rather than restarted for each read",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const directory = yield* treeDirectory
        yield* checkout(directory, "one")
        const gitEntered = yield* Deferred.make<boolean>()
        const gitContinue = yield* Deferred.make<boolean>()
        const treeEntered = yield* Deferred.make<boolean>()
        const completed = yield* Deferred.make<boolean>()
        const waiting = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command) && command.args.includes("--show-toplevel")) {
            return Deferred.succeed(gitEntered, true).pipe(
              Effect.andThen(Deferred.await(gitContinue)),
              Effect.andThen(spawner.spawn(command)),
            )
          }
          return spawner.spawn(command)
        })
        const boundary = FileSystem.FileSystem.of({
          ...fs,
          stream: (file, options) => {
            if (file.endsWith("/src/main.ts"))
              return Stream.fromEffect(
                Deferred.succeed(treeEntered, true).pipe(Effect.andThen(Effect.never)),
              )
            return fs.stream(file, options)
          },
        })
        const capture = yield* captureRelease(directory).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, waiting),
          Effect.provideService(FileSystem.FileSystem, boundary),
          Effect.result,
          Effect.tap(() => Deferred.succeed(completed, true)),
          Effect.forkChild,
        )
        yield* Deferred.await(gitEntered)
        yield* TestClock.adjust("6 seconds")
        yield* Deferred.succeed(gitContinue, true)
        yield* Deferred.await(treeEntered)
        yield* TestClock.adjust("4 seconds")
        expect(yield* Deferred.isDone(completed)).toBe(true)
        const failed = yield* Fiber.join(capture)
        expect(failed._tag).toBe("Failure")
        if (failed._tag === "Failure") expect(failed.failure._tag).toBe("NoRelease")
      }).pipe(Effect.provide(bunPlatformLayer)),
  )

  it.live("a tracked symlink repointed between identical entry bytes names another tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* treeDirectory
        yield* checkout(directory, "one")
        for (const name of ["a", "b"]) {
          yield* writeBytes(
            directory,
            `${name}/entry.ts`,
            utf8('export { value } from "./dep.ts"\n'),
          )
          yield* writeBytes(directory, `${name}/dep.ts`, utf8(`export const value = "${name}"\n`))
        }
        yield* fs.symlink("a/entry.ts", `${directory}/entry.ts`)
        yield* fixtureGit(directory, ["add", "-A"])
        yield* fixtureGit(directory, ["commit", "-q", "--no-verify", "-m", "links"])
        const before = yield* captureRelease(directory)
        yield* fs.remove(`${directory}/entry.ts`)
        yield* fs.symlink("b/entry.ts", `${directory}/entry.ts`)
        const after = yield* captureRelease(directory)
        expect(after.commit).toBe(before.commit)
        expect(after.tree).not.toBe(before.tree)
      }),
    ).pipe(Effect.provide(bunPlatformLayer)),
  )

  it.live(
    "a dangling tracked symlink names its target, distinct from another target and deletion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* treeDirectory
          yield* checkout(directory, "one")
          yield* fs.symlink("missing-one.ts", `${directory}/optional.ts`)
          yield* fixtureGit(directory, ["add", "optional.ts"])
          yield* fixtureGit(directory, ["commit", "-q", "--no-verify", "-m", "dangling"])
          const before = yield* treeOf(directory)
          yield* fs.remove(`${directory}/optional.ts`)
          yield* fs.symlink("missing-two.ts", `${directory}/optional.ts`)
          const repointed = yield* treeOf(directory)
          yield* fs.remove(`${directory}/optional.ts`)
          const deleted = yield* treeOf(directory)
          expect(new Set([before, repointed, deleted]).size).toBe(3)
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
  )

  it.live("an untracked symlink to a FIFO names the target without opening it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* treeDirectory
        yield* checkout(directory, "one")
        yield* fs.makeDirectory(`${directory}/cache`)
        const fifo = `${directory}/cache/pipe`
        expect((yield* runProcess("mkfifo", [fifo])).exitCode).toBe(0)
        yield* fs.symlink("cache/pipe", `${directory}/pipe.ts`)
        // A FileSystem boundary that refuses the blocking open also makes the
        // regression fail promptly, without leaving an OS thread in a FIFO.
        const safe = FileSystem.FileSystem.of({
          ...fs,
          readFile: (file) => {
            expect(file).not.toBe(`${directory}/pipe.ts`)
            return fs.readFile(file)
          },
          stream: (file, options) => {
            expect(file).not.toBe(`${directory}/pipe.ts`)
            return fs.stream(file, options)
          },
        })
        const before = yield* treeOf(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, safe),
          Effect.timeout("2 seconds"),
        )
        yield* fs.remove(`${directory}/pipe.ts`)
        yield* fs.symlink("cache/another-pipe", `${directory}/pipe.ts`)
        expect(yield* treeOf(directory)).not.toBe(before)
      }),
    ).pipe(Effect.provide(bunPlatformLayer)),
  )

  it.live(
    `${TREE_CASES} generated checkouts (seed ${TREE_SEED}): the tree changes iff a listed working entry changes, under any git config; unsupported entries name no release`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("gent-tree-")
          const random = seeded(TREE_SEED)
          const made = new Set<string>()
          for (let at = 0; at < TREE_CASES; at++) {
            const directory = `${root}/case-${String(at)}`
            const files = new Map<string, ModelFile>()
            const put = (file: string, bytes: Uint8Array) =>
              writeBytes(directory, file, bytes).pipe(
                Effect.tap(() =>
                  Effect.sync(() =>
                    files.set(file, { tracked: true, entry: TreeEntry.cases.File.make({ bytes }) }),
                  ),
                ),
              )
            const attributes = ATTRIBUTES.filter(() => random(2) === 0)
            yield* put(".gitattributes", utf8(attributes.map((line) => `${line}\n`).join("")))
            yield* put(".gitignore", utf8("cache/\n"))
            yield* put("bun.lock", utf8("lock\n"))
            yield* put("special.ts", utf8("regular before the special entry\n"))
            const fs = yield* FileSystem.FileSystem
            yield* fs.symlink("src/main.ts", `${directory}/linked.ts`)
            files.set("linked.ts", {
              tracked: true,
              entry: TreeEntry.cases.Link.make({ target: "src/main.ts" }),
            })
            for (const file of TRACKED_PATHS) {
              if (random(3) > 0) yield* put(file, generateBytes(random))
            }
            yield* fixtureGit(directory, ["init", "-q"])
            yield* configure(directory, generateConfig(random))
            yield* fixtureGit(directory, ["add", "-A"])
            yield* fixtureGit(directory, ["commit", "-q", "--no-verify", "-m", "fixture"])
            const edits = 2 + random(5)
            for (let edit = 0; edit < edits; edit++) {
              const before = yield* treeOf(directory)
              const expectedBefore = yield* modelTree(directory, files)
              let selected = pick(random, TREE_EDITS)
              if (edit === 0) selected = TREE_EDITS[at % TREE_EDITS.length]!
              made.add(yield* generateEdit(directory, files, random, selected))
              const expectedAfter = yield* modelTree(directory, files)
              const after = yield* treeOf(directory)
              expect(Option.some(after), `case ${at}: ${selected}`).toEqual(expectedAfter)
              expect(after === before, `case ${at}: ${selected}`).toBe(
                Option.getOrThrow(expectedAfter) === Option.getOrThrow(expectedBefore),
              )
            }
            const name = `case ${String(at)}: ${attributes.join(", ")}`
            const tree = yield* treeOf(directory)
            expect(Option.some(tree), name).toEqual(yield* modelTree(directory, files))
            // Another config over the same bytes: one tree.
            yield* configure(directory, generateConfig(random))
            expect(yield* treeOf(directory), name).toBe(tree)
            // One byte changed: another tree, the model's.
            let present: Array<readonly [string, ModelFile]> = [...files].filter(
              ([path, model]) => model.entry._tag === "File" && !FIXED_PATHS.has(path),
            )
            if (present.length === 0) {
              present = [
                [
                  "fresh/one.ts",
                  { tracked: false, entry: TreeEntry.cases.File.make({ bytes: new Uint8Array() }) },
                ],
              ]
            }
            const [file, model] = pick(random, present)
            let original: Uint8Array = new Uint8Array()
            if (model.entry._tag === "File") original = model.entry.bytes
            const bytes = changeOneByte(random, original)
            yield* writeBytes(directory, file, bytes)
            files.set(file, { tracked: model.tracked, entry: TreeEntry.cases.File.make({ bytes }) })
            const changed = yield* treeOf(directory)
            expect(changed, name).not.toBe(tree)
            expect(Option.some(changed), name).toEqual(yield* modelTree(directory, files))
            // Git still lists a tracked path replaced by a directory or FIFO.
            yield* fs.remove(`${directory}/special.ts`, { force: true })
            if (at % 2 === 0) yield* fs.makeDirectory(`${directory}/special.ts`)
            else expect((yield* runProcess("mkfifo", [`${directory}/special.ts`])).exitCode).toBe(0)
            expect(yield* modelTree(directory, files)).toEqual(Option.none())
            expect((yield* captureRelease(directory).pipe(Effect.flip))._tag).toBe("NoRelease")
          }
          expect([...made].sort()).toEqual([...TREE_EDITS].sort())
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
    60_000,
  )

  it.live(
    "a clean filter that hides an edit from git still names another tree and another contract",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = `${yield* makeTempDirectoryScoped("gent-tree-")}/repo`
          yield* attributedCheckout(
            directory,
            "main.ts filter=mask\n",
            "export const value = 0\n",
            [["filter.mask.clean", "sed 's/export const value = [0-9]/export const value = 0/'"]],
          )
          const before = yield* captureRelease(directory)
          const [beforeContract] = yield* contractsInProcess(["checkout", directory])
          yield* fs.writeFileString(`${directory}/main.ts`, "export const value = 1\n")
          // The premise: git sees no change.
          expect(yield* gitStatus(directory)).toBe("")
          const after = yield* captureRelease(directory)
          expect(after.commit).toBe(before.commit)
          expect(after.tree).not.toBe(before.tree)
          expect(yield* contractsInProcess(["checkout", directory])).not.toEqual([beforeContract])
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
    30_000,
  )

  it.live("a diff driver's hunk header names the same tree for the same bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = `${yield* makeTempDirectoryScoped("gent-tree-")}/repo`
        const source = [
          "function alpha() {",
          ...Array.from({ length: 20 }, (_, at) => `  const x${String(at)} = ${String(at)}`),
          "}\n",
        ].join("\n")
        yield* attributedCheckout(directory, "main.ts diff=demo\n", source)
        yield* fs.writeFileString(`${directory}/main.ts`, source.replace("x15 = 15", "x15 = 99"))
        yield* fixtureGit(directory, ["config", "diff.demo.xfuncname", "^function"])
        const before = yield* captureRelease(directory)
        yield* fixtureGit(directory, ["config", "diff.demo.xfuncname", "^//"])
        expect(yield* captureRelease(directory)).toEqual(before)
      }),
    ).pipe(Effect.provide(bunPlatformLayer)),
  )

  it.live("core.autocrlf names the same tree for the same CRLF bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = `${yield* makeTempDirectoryScoped("gent-tree-")}/repo`
        yield* attributedCheckout(directory, "", "export const value = 0\n")
        yield* fs.writeFileString(`${directory}/main.ts`, "export const value = 1\r\n")
        yield* fixtureGit(directory, ["config", "core.autocrlf", "false"])
        const before = yield* captureRelease(directory)
        yield* fixtureGit(directory, ["config", "core.autocrlf", "true"])
        expect(yield* captureRelease(directory)).toEqual(before)
      }),
    ).pipe(Effect.provide(bunPlatformLayer)),
  )
})
