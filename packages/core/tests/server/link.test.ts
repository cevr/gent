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
import { GentPlatform, runProcess } from "../../src/runtime/gent-platform"
import { BunGentPlatformLive, programSource } from "../../src/runtime/gent-platform-bun"
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

/** The test platform with `source` as its source: a checkout's name, or none. */
const withSource = (source: Option.Option<string>) =>
  Effect.provideServiceEffect(
    GentPlatform,
    Effect.gen(function* () {
      const platform = yield* GentPlatform
      return GentPlatform.of({ ...platform, source: Effect.succeed(source) })
    }),
  )

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

  it.effect(
    "code in a codec binds the contract to the source; with no source it matches no other",
    () =>
      Effect.gen(function* () {
        // A transformation is code: only the source names it.
        const coded = Schema.Struct({ count: Schema.FiniteFromString })
        const atA = yield* payloadContract(coded).pipe(withSource(Option.some("a")))
        const atAAgain = yield* payloadContract(coded).pipe(withSource(Option.some("a")))
        const atB = yield* payloadContract(coded).pipe(withSource(Option.some("b")))
        expect(atA).toBe(atAAgain)
        expect(atA).not.toBe(atB)
        const unnamed = yield* payloadContract(coded).pipe(withSource(Option.none()))
        const unnamedAgain = yield* payloadContract(coded).pipe(withSource(Option.none()))
        expect(unnamed).not.toBe(unnamedAgain)
        // Every RPC holds code (its exit, its defect): a payload of data names no source either.
        const data = Schema.Struct({ count: Schema.Number.check(Schema.isInt()) })
        expect(yield* payloadContract(data).pipe(withSource(Option.none()))).not.toBe(
          yield* payloadContract(data).pipe(withSource(Option.none())),
        )
        // A check Effect does not name is code too.
        const custom = Schema.String.check(Schema.makeFilter((text: string) => text.length > 1))
        expect(yield* payloadContract(custom).pipe(withSource(Option.some("a")))).not.toBe(
          yield* payloadContract(custom).pipe(withSource(Option.some("b"))),
        )
      }).pipe(Effect.provide(platformLayer)),
  )

  it.live(
    "two fresh processes of one program compute one contract; this test's program has another",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const script = yield* path.fromFileUrl(new URL("./link-contract.ts", import.meta.url))
        const own = yield* linkContract.pipe(Effect.provide(BunGentPlatformLive))
        const fresh = yield* Effect.forEach(
          [1, 2],
          () =>
            runProcess(process.execPath, [script]).pipe(
              Effect.map(({ stdout, exitCode }) => ({ contract: stdout.trim(), exitCode })),
            ),
          { concurrency: 2 },
        )
        expect(fresh[0]).toEqual(fresh[1])
        expect(fresh[0]?.exitCode).toBe(0)
        expect(fresh[0]?.contract).not.toBe(own)
      }).pipe(Effect.provide(BunTestServices)),
    30_000,
  )
})

// ── the program a contract names ────────────────────────────────────────────

/** A check of a generated program: a pattern, its flags, a bound. */
interface ProgramRule {
  readonly pattern: string
  readonly flags: string
  readonly min: number
}

/**
 * A generated program. `rules` are the checks of its own modules, `table` a
 * generated module that git ignores and the program imports, `installed` the
 * check of an installed package it imports. `docs` (tracked) and `cache`
 * (ignored) are files the program does not import. `configured` sets git
 * options that change how git prints a diff.
 */
interface ProgramParts {
  readonly rules: ReadonlyArray<ProgramRule>
  readonly table: string
  readonly installed: ProgramRule
  readonly docs: string
  readonly cache: string
  readonly configured: boolean
}

type Random = (below: number) => number

const PROGRAM_FLAGS = ["", "i", "m", "s", "u"]
const PROGRAM_WORDS = ["alpha", "beta", "gamma", "delta", "omega"]
const programWord = (random: Random) =>
  `${PROGRAM_WORDS[random(PROGRAM_WORDS.length)] ?? "alpha"}${String(random(1000))}`
const programRule = (random: Random): ProgramRule => ({
  pattern: programWord(random),
  flags: PROGRAM_FLAGS[random(PROGRAM_FLAGS.length)] ?? "",
  min: random(100),
})
/** A flag set other than `flags`. */
const otherFlags = (flags: string, random: Random) => {
  const others = PROGRAM_FLAGS.filter((flag) => flag !== flags)
  return others[random(others.length)] ?? "g"
}

const generateProgram = (random: Random): ProgramParts => ({
  rules: Array.from({ length: 1 + random(4) }, () => programRule(random)),
  table: programWord(random),
  installed: programRule(random),
  docs: programWord(random),
  cache: programWord(random),
  configured: false,
})

const ruleText = (rule: ProgramRule) =>
  `export const rule = { pattern: /${rule.pattern}/${rule.flags}, min: ${String(rule.min)} }\n`

/** The files of `parts`, each path under the program's directory with its text. */
const programFiles = (parts: ProgramParts): ReadonlyArray<readonly [string, string]> => [
  [".gitignore", "node_modules/\ngen/\nignored/\n"],
  ["package.json", '{ "name": "fixture", "private": true }\n'],
  ...parts.rules.map((rule, index) => [`src/rule-${String(index)}.ts`, ruleText(rule)] as const),
  [
    "src/main.ts",
    [
      ...parts.rules.map(
        (_, index) => `import { rule as rule${String(index)} } from "./rule-${String(index)}.ts"`,
      ),
      'import { table } from "../gen/table.ts"',
      'import { rule as installed } from "@fixture/checks"',
      `console.log([${parts.rules.map((_, index) => `rule${String(index)}`).join(", ")}], table, installed)`,
      "",
    ].join("\n"),
  ],
  ["gen/table.ts", `export const table = "${parts.table}"\n`],
  [
    "node_modules/@fixture/checks/package.json",
    '{ "name": "@fixture/checks", "version": "1.0.0", "main": "index.js" }\n',
  ],
  ["node_modules/@fixture/checks/index.js", ruleText(parts.installed)],
  ["docs/notes.md", `# ${parts.docs}\n`],
  ["ignored/cache.txt", `${parts.cache}\n`],
]

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

/** Writes `parts` into `directory` over what is there. */
const writeProgram = (directory: string, parts: ProgramParts) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    for (const [file, text] of programFiles(parts)) {
      yield* fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true })
      yield* fs.writeFileString(path.join(directory, file), text)
    }
    if (parts.configured) {
      yield* fixtureGit(directory, ["config", "diff.noprefix", "true"])
      yield* fixtureGit(directory, ["config", "diff.mnemonicPrefix", "true"])
      yield* fixtureGit(directory, ["config", "core.quotePath", "false"])
    }
  })

/** A checkout of `parts` at `directory`, committed; `dirty` leaves a change to it uncommitted. */
const checkoutProgram = (directory: string, parts: ProgramParts, dirty: boolean) =>
  Effect.gen(function* () {
    yield* writeProgram(directory, parts)
    yield* fixtureGit(directory, ["init", "-q"])
    yield* fixtureGit(directory, ["add", "-A"])
    yield* fixtureGit(directory, ["commit", "-q", "--no-verify", "-m", "fixture"])
    if (!dirty) return parts
    const [first, ...rest] = parts.rules
    const working = { ...parts, rules: [{ ...first!, min: first!.min + 1000 }, ...rest] }
    yield* writeProgram(directory, working)
    return working
  })

/** A change to a program; `same` when the changed program loads the same code. */
interface ProgramChange {
  readonly name: string
  readonly same: boolean
  readonly apply: (parts: ProgramParts, random: Random) => ProgramParts
}

/** `parts` with its rule at a generated index changed by `change`. */
const changeRule = (
  parts: ProgramParts,
  random: Random,
  change: (rule: ProgramRule) => ProgramRule,
) => {
  const at = random(parts.rules.length)
  const rules = [...parts.rules]
  rules[at] = change(parts.rules[at]!)
  return { ...parts, rules }
}

const PROGRAM_CHANGES: ReadonlyArray<ProgramChange> = [
  {
    name: "a schema's check",
    same: false,
    apply: (parts, random) =>
      changeRule(parts, random, (rule) => ({ ...rule, flags: otherFlags(rule.flags, random) })),
  },
  {
    name: "a tracked file",
    same: false,
    apply: (parts, random) => changeRule(parts, random, (rule) => ({ ...rule, min: rule.min + 1 })),
  },
  {
    name: "a bundled file git ignores",
    same: false,
    apply: (parts) => ({ ...parts, table: `${parts.table}x` }),
  },
  {
    name: "an installed package's contents",
    same: false,
    apply: (parts, random) => ({
      ...parts,
      installed: { ...parts.installed, flags: otherFlags(parts.installed.flags, random) },
    }),
  },
  {
    name: "an ignored file",
    same: true,
    apply: (parts) => ({ ...parts, cache: `${parts.cache}x` }),
  },
  {
    name: "a doc outside the bundle",
    same: true,
    apply: (parts) => ({ ...parts, docs: `${parts.docs}x` }),
  },
  {
    name: "the git config",
    same: true,
    apply: (parts) => ({ ...parts, configured: true }),
  },
]

const PROGRAMS = 40
const PROGRAM_SEED = 20_261_104

/** The contract of the program at `directory`, run from `src/main.ts`; its source must be named. */
const programContract = (directory: string) =>
  Effect.gen(function* () {
    const source = yield* programSource(`${directory}/src/main.ts`)
    expect(Option.isSome(source), directory).toBe(true)
    return yield* linkContract.pipe(withSource(source))
  })

/**
 * Two copies of one generated program, at two paths: `changes` applied to
 * the second. Each case is a checkout at the first path, copied to the
 * second, and changed there.
 */
const comparePrograms = (
  parts: ProgramParts,
  dirty: boolean,
  changes: ReadonlyArray<ProgramChange>,
  random: Random,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* makeTempDirectoryScoped("gent-program-")
      const first = `${root}/first`
      const second = `${root}/second/at/another/depth`
      const working = yield* checkoutProgram(first, parts, dirty)
      yield* fs.makeDirectory(second, { recursive: true })
      yield* fs.copy(first, second, { overwrite: true })
      yield* writeProgram(
        second,
        changes.reduce((changed, change) => change.apply(changed, random), working),
      )
      return [yield* programContract(first), yield* programContract(second)] as const
    }),
  )

/** Writes the module `main` imports, `local.ts` beside it, holding `text`. */
const writeLocal = (main: string, text: string) =>
  Effect.flatMap(Path.Path, (path) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.writeFileString(
        path.join(path.dirname(main), "local.ts"),
        `export const local = "${text}"\n`,
      ),
    ),
  )

/**
 * A program in a scratch directory: a `main.ts` that imports its `local.ts`
 * and runs `link-contract.ts`, so the contract it prints names it. Its path.
 */
const contractProgram = (local: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* makeTempDirectoryScoped("gent-loaded-")
    const helper = yield* path.fromFileUrl(new URL("./link-contract.ts", import.meta.url))
    const main = path.join(directory, "main.ts")
    yield* fs.writeFileString(
      main,
      `export { local } from "./local.ts"\nimport ${encodeText(helper)}\n`,
    )
    yield* writeLocal(main, local)
    return main
  })

/** `main` running in `mode` (`link-contract.ts`): its next line, and a line sent to it. */
const runContractProgram = (main: string, mode: string) =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array>()
    const lines = yield* Queue.unbounded<string>()
    const child = yield* ChildProcess.make(process.execPath, [main, mode], {
      stdin: Stream.fromQueue(input),
      stdout: "pipe",
      stderr: "ignore",
      forceKillAfter: "2 seconds",
    })
    yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Queue.offer(lines, line)),
      Effect.forkScoped,
    )
    return {
      line: Queue.take(lines).pipe(Effect.timeout("20 seconds")),
      send: Queue.offer(input, new TextEncoder().encode("go\n")),
    }
  })

/** The contracts two fresh processes of `main` print. */
const freshContracts = (main: string) =>
  Effect.forEach(
    [1, 2],
    () => Effect.map(runProcess(process.execPath, [main]), ({ stdout }) => stdout.trim()),
    { concurrency: 2 },
  )

describe("the program a contract names", () => {
  it.live(
    `${PROGRAMS} generated programs (seed ${PROGRAM_SEED}): a change to the loaded code changes the contract, any other change does not`,
    () =>
      Effect.gen(function* () {
        const random = seeded(PROGRAM_SEED)
        const reached = new Set<string>()
        const same = PROGRAM_CHANGES.filter((change) => change.same)
        const different = PROGRAM_CHANGES.filter((change) => !change.same)
        for (let program = 0; program < PROGRAMS; program++) {
          const parts = generateProgram(random)
          const changes = Array.from(
            { length: random(3) },
            () => same[random(same.length)] ?? same[0]!,
          )
          if (random(2) === 1) changes.push(different[random(different.length)] ?? different[0]!)
          const names = changes.map((change) => change.name)
          for (const name of names) reached.add(name)
          const [first, second] = yield* comparePrograms(parts, random(2) === 1, changes, random)
          expect(first === second, `program ${String(program)}: ${names.join(", ")}`).toBe(
            changes.every((change) => change.same),
          )
        }
        expect([...reached].sort()).toEqual(PROGRAM_CHANGES.map((change) => change.name).sort())
      }).pipe(Effect.provide(Layer.mergeAll(BunTestServices, BunGentPlatformLive))),
    120_000,
  )

  it.live(
    "an installed package whose check differs by a regex flag, on one commit, changes the contract",
    () =>
      Effect.gen(function* () {
        const parts = generateProgram(seeded(PROGRAM_SEED))
        const flagged: ProgramChange = {
          name: "the installed check's flag",
          same: false,
          apply: () => ({
            ...parts,
            installed: { ...parts.installed, flags: otherFlags(parts.installed.flags, seeded(1)) },
          }),
        }
        const [first, second] = yield* comparePrograms(parts, false, [flagged], seeded(1))
        expect(first).not.toBe(second)
      }).pipe(Effect.provide(Layer.mergeAll(BunTestServices, BunGentPlatformLive))),
    30_000,
  )

  it.live(
    "a package built for one platform is no part of the program; a portable one is",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* makeTempDirectoryScoped("gent-platform-package-")
          /** A program that imports one package, whose `package.json` names `os`. */
          const nativeProgram = (directory: string, os: string, body: string) =>
            Effect.gen(function* () {
              const native = `${directory}/node_modules/@fixture/native`
              yield* fs.makeDirectory(native, { recursive: true })
              yield* fs.writeFileString(
                `${directory}/main.ts`,
                'import { body } from "@fixture/native"\nconsole.log(body)\n',
              )
              yield* fs.writeFileString(
                `${native}/package.json`,
                `{ "name": "@fixture/native", "version": "1.0.0", "main": "index.js", "os": ${os} }\n`,
              )
              yield* fs.writeFileString(`${native}/index.js`, `export const body = "${body}"\n`)
              return yield* programSource(`${directory}/main.ts`)
            })
          const one = '["darwin"]'
          const two = '["darwin", "linux"]'
          const darwin = yield* nativeProgram(`${root}/a`, one, "darwin build")
          expect(Option.isSome(darwin)).toBe(true)
          expect(yield* nativeProgram(`${root}/b`, one, "linux build")).toEqual(darwin)
          expect(yield* nativeProgram(`${root}/c`, two, "one build")).not.toEqual(
            yield* nativeProgram(`${root}/d`, two, "another build"),
          )
        }),
      ).pipe(Effect.provide(BunTestServices)),
    30_000,
  )

  it.live(
    "a process names the program it loaded: an edit after it started moves a fresh process's contract, not its own",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const main = yield* contractProgram("loaded")
          const held = yield* runContractProgram(main, "hold")
          const loaded = yield* held.line
          yield* writeLocal(main, "edited")
          yield* held.send
          expect(yield* held.line).toBe(loaded)
          const fresh = yield* freshContracts(main)
          expect(fresh[0]).toBe(fresh[1])
          expect(fresh[0]).not.toBe(loaded)
        }),
      ).pipe(Effect.provide(BunTestServices)),
    60_000,
  )

  it.live(
    "a process that reads its program after an edit names none: it matches neither program",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const main = yield* contractProgram("loaded")
          const before = yield* freshContracts(main)
          const lazy = yield* runContractProgram(main, "lazy")
          expect(yield* lazy.line).toBe("started")
          yield* writeLocal(main, "edited")
          yield* lazy.send
          const answered = yield* lazy.line
          const after = yield* freshContracts(main)
          expect(before[0]).toBe(before[1])
          expect(after[0]).toBe(after[1])
          expect([before[0], after[0]]).not.toContain(answered)
        }),
      ).pipe(Effect.provide(BunTestServices)),
    60_000,
  )

  it.live("the links read the program's name as the server starts, before any hello", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const read = yield* Deferred.make<boolean>()
        yield* linksOver({}).pipe(
          Effect.provideServiceEffect(
            GentPlatform,
            Effect.gen(function* () {
              const platform = yield* GentPlatform
              return GentPlatform.of({
                ...platform,
                source: Effect.as(Deferred.succeed(read, true), Option.some("program")),
              })
            }),
          ),
        )
        expect(yield* Deferred.await(read).pipe(Effect.timeout("5 seconds"))).toBe(true)
      }),
    ).pipe(Effect.provide(platformLayer)),
  )
})
