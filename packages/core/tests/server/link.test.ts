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
  Result,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process"
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
import { Links, linkContract, rpcContract, linkMismatch } from "../../src/server/link"
import {
  BunTestServices,
  createRpcHarness,
  LanguageModelLayers,
  makeTempDirectoryScoped,
} from "../../src/test-utils/harness"
import { LinkHello } from "../../src/server/rpc"
import { e2ePreset } from "../helpers/test-preset"

/** The test platform's host name: this server's machine name. */
const OWN = "test-host"
const encodeFacts = Schema.encodeSync(Schema.fromJsonString(PoolFacts))
/** A string as a quoted JSON (and TypeScript) literal. */
const encodeText = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const FAR_FACTS = encodeFacts({ boot: "far-boot", host: "far", seq: 0, providers: [] })
const encodeHello = Schema.encodeSync(Schema.fromJsonString(LinkHello))

/**
 * The far end's argv: this bun running the fixture, as `gent ctl link` would
 * be run; its hello names the machine `facts` name.
 */
const farEnd = (
  contract: string,
  mode: string,
  log: string,
  facts = FAR_FACTS,
  hello: Option.Option<LinkHello> = Option.none(),
) =>
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
      ...Option.match(hello, { onNone: () => [], onSome: (value) => [encodeHello(value)] }),
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
        const oldReleaseLog = `${dir}/old-release.log`
        const elsewhereLog = `${dir}/elsewhere.log`
        const { links, placement } = yield* linksOver({
          other: yield* farEnd(`${contract}-other`, "serve", otherLog),
          older: yield* farEnd(contract, "nohello", olderLog),
          oldrelease: yield* farEnd(contract, "oldrelease", oldReleaseLog),
          // Its hello names machine `far`: a command that reaches another machine.
          elsewhere: yield* farEnd(contract, "serve", elsewhereLog),
        })
        expect(
          yield* viewUntil(links, (view) => view.every((link) => link.state === "incompatible")),
        ).toMatchObject([
          { machine: "other", state: "incompatible" },
          { machine: "older", state: "incompatible" },
          { machine: "oldrelease", state: "incompatible" },
          { machine: "elsewhere", state: "incompatible" },
        ])
        const view = yield* links.view
        expect(view.find((link) => link.machine === "oldrelease")?.reason).toContain(
          "has no link.hello this server reads",
        )
        expect(view.find((link) => link.machine === "older")?.reason).toContain(
          "has no link.hello this server reads",
        )
        expect(view.find((link) => link.machine === "other")?.reason).toContain(
          "decodes RPCs differently",
        )
        // Past the first retry: each run asked for the hello and nothing else.
        yield* logUntil(otherLog, (lines) => starts(lines) >= 2)
        for (const log of [otherLog, olderLog, oldReleaseLog, elsewhereLog]) {
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
const HelloValue = LinkHello
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
    return HelloSuccess.make({
      value: new LinkHello({
        machine: "far",
        release: cleanRelease("test-commit"),
        checkout: "/nonexistent/far",
        contract: `${contract}-x`,
      }),
    })
  if (step === "hello-none")
    return HelloFailure.make({ cause: [Die.make({ defect: "no link.hello" })] })
  return HelloSuccess.make({
    value: new LinkHello({
      machine: "far",
      contract,
      release: cleanRelease("test-commit"),
      checkout: "/nonexistent/far",
    }),
  })
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

const withRelease = (release: GentRelease, processId = "test-process") =>
  Effect.provideServiceEffect(
    GentPlatform,
    Effect.map(GentPlatform, (platform) =>
      GentPlatform.of({
        ...platform,
        source: Effect.succeed(release),
        processId: Effect.succeed(processId),
      }),
    ),
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
})

// ── release identity and repair ─────────────────────────────────────────────

type Random = (below: number) => number
type ReleaseFacts = typeof GentReleaseFacts.Type

const HEX = "0123456789abcdef"
const hex = (random: Random, length: number) =>
  Array.from({ length }, () => HEX[random(HEX.length)] ?? "0").join("")
const generateRelease = (random: Random): ReleaseFacts => ({
  commit: hex(random, 40),
  clean: true,
  checkout: "/nonexistent/gent checkout",
})
const releasedOf = ({ commit, clean }: ReleaseFacts) =>
  GentRelease.cases.Released.make({ commit, clean })
const RELEASE_SEED = 20_261_105

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

/** Git fixture with one fixed identity and date: the same commit at either path. */
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
 * A clean checkout at `directory`: a `.gitignore` naming `cache/` and one
 * source file holding `text`, committed.
 */
const checkout = (directory: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(`${directory}/src`, { recursive: true })
    yield* fs.writeFileString(`${directory}/.gitignore`, "cache/\n")
    yield* fs.writeFileString(`${directory}/src/main.ts`, sourceText(text))
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
    `echo $ >> '${calls}'`,
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

/** Parse the displayed command as a shell would, without executing any part of it. */
const wordsOf = (text: string) => {
  const parsed = CommandLine.template(Object.assign([text], { raw: [text] }))
  expect(Result.isSuccess(parsed), text).toBe(true)
  return Result.getOrElse(parsed, () => []).map(String)
}

const assertUpdate = (text: string, checkout: string, far: boolean) => {
  let shell = text
  if (far) {
    const argv = wordsOf(text)
    expect(argv.slice(0, -1)).toEqual(["ssh", "-p", "2222", "fixture@far"])
    shell = argv.at(-1) ?? ""
  }
  const [cd = "", ...rest] = shell.split(" && ")
  expect(wordsOf(cd)).toEqual(["cd", checkout])
  expect(rest).toEqual([
    "git pull --ff-only",
    "bun install --frozen-lockfile",
    "bun run install:global",
  ])
}

const helloOf = (machine: string, release: GentRelease, checkout = "/nonexistent/gent checkout") =>
  new LinkHello({ machine, contract: "fixture-contract", release, checkout })
const UPDATE_ARGV = ["ssh", "-p", "2222", "fixture@far", "gent", "ctl", "link"]
const cleanRelease = (commit: string) => GentRelease.cases.Released.make({ commit, clean: true })

/** Generated witnesses cover each release case, including two dirty and two unreleased processes. */
const releasePair = (random: Random, kind: number): readonly [GentRelease, GentRelease] => {
  const commit = hex(random, 40)
  const clean = cleanRelease(commit)
  const dirty = GentRelease.cases.Released.make({ commit, clean: false })
  const changedDirty = GentRelease.cases.Released.make({ commit: hex(random, 40), clean: false })
  const absent = GentRelease.cases.Unreleased.make({ process: "unreleased-process" })
  switch (kind) {
    case 1:
      return [clean, cleanRelease(hex(random, 40))]
    case 2:
      return [clean, changedDirty]
    case 3:
      return [changedDirty, clean]
    case 4:
      return [clean, absent]
    case 5:
      return [absent, clean]
    case 6:
      return [dirty, dirty]
    case 7:
      return [absent, absent]
    case 8:
      return [absent, dirty]
    case 9:
      return [dirty, absent]
    default:
      return [clean, clean]
  }
}

/** Expected remediation for the witnesses, independent of the formatter. */
const REASONS = [
  { phrase: "decodes RPCs differently (another Bun?)", side: "both" },
  { phrase: "Update both", side: "both" },
  { phrase: "far runs a dev build", side: "far" },
  { phrase: "This machine runs a dev build", side: "local" },
  { phrase: "far runs a build with no release (no git checkout)", side: "far" },
  { phrase: "This machine runs a build with no release (no git checkout)", side: "local" },
  { phrase: "far runs a dev build", side: "far" },
  { phrase: "far runs a build with no release (no git checkout)", side: "far" },
  { phrase: "far runs a dev build", side: "far" },
  { phrase: "This machine runs a dev build", side: "local" },
] as const

const assertReason = (reason: string, local: LinkHello, far: LinkHello, kind: number) => {
  expect(reason).not.toMatch(/[\r\n]/)
  const expected = REASONS[kind] ?? REASONS[0]!
  expect(reason).toContain(expected.phrase)
  const one = local.release
  const two = far.release
  if (two._tag === "Released" && !two.clean) {
    expect(reason).toContain(`uncommitted changes in ${far.checkout}`)
  } else if (one._tag === "Released" && !one.clean) {
    expect(reason).toContain(`uncommitted changes in ${local.checkout}`)
  }
  if (one._tag === "Released" && two._tag === "Released" && one.commit !== two.commit) {
    expect(reason).toContain(one.commit.slice(0, 8))
    expect(reason).toContain(two.commit.slice(0, 8))
  }
  const commands = reason.slice(reason.lastIndexOf(": ") + 2).split("; ")
  if (expected.side === "far") {
    expect(commands.length).toBe(1)
    assertUpdate(commands[0] ?? "", far.checkout ?? "<gent checkout>", true)
    return
  }
  if (expected.side === "local") {
    expect(commands.length).toBe(1)
    assertUpdate(commands[0] ?? "", local.checkout ?? "<gent checkout>", false)
    return
  }
  expect(commands.length).toBe(2)
  assertUpdate(commands[0] ?? "", local.checkout ?? "<gent checkout>", false)
  assertUpdate(commands[1] ?? "", far.checkout ?? "<gent checkout>", true)
}

describe("the release a contract names", () => {
  it.live(
    "generated release pairs match iff both are clean, their commits equal and their codecs equal",
    () =>
      Effect.gen(function* () {
        const random = seeded(RELEASE_SEED)
        const reached = new Set<string>()
        for (let at = 0; at < 240; at++) {
          const kind = at % 10
          const [one, two] = releasePair(random, kind)
          const sameCodec = random(2) === 0
          let after: Schema.Top = Schema.Finite
          if (sameCodec) after = Schema.String
          const first = yield* payloadContract(Schema.String).pipe(withRelease(one, "left-process"))
          const second = yield* payloadContract(after).pipe(withRelease(two, "right-process"))
          const match =
            one._tag === "Released" &&
            one.clean &&
            two._tag === "Released" &&
            two.clean &&
            one.commit === two.commit &&
            sameCodec
          expect(first === second, `pair ${at}`).toBe(match)
          reached.add(`${kind}:${String(sameCodec)}`)
        }
        expect(reached.size).toBe(20)
        const sample = Array.from({ length: 20 }, () => generateRelease(random))
        const args = ["release", ...sample.flatMap(({ commit }) => [commit, "clean"])]
        const first = yield* contractsInProcess(args)
        const second = yield* contractsInProcess(args)
        expect(first).toEqual(second)
        expect(first).toEqual(
          yield* Effect.forEach(sample, (facts) =>
            linkContract.pipe(withRelease(releasedOf(facts))),
          ),
        )
      }).pipe(Effect.provide(bunPlatformLayer)),
    30_000,
  )

  it.live(
    "a clean commit at two paths names one release and contract; ignored files stay clean and untracked or tracked edits are dirty",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* makeTempDirectoryScoped("gent-release-")
        const near = `${root}/near`
        const far = `${root}/far with a space`
        yield* checkout(near, "one")
        yield* checkout(far, "one")
        const before = yield* captureRelease(near)
        expect(before.clean).toBe(true)
        const other = yield* captureRelease(`${far}/src`)
        expect(other.commit).toBe(before.commit)
        expect(other.clean).toBe(true)
        expect(other.checkout).toBe(yield* fs.realPath(far))
        expect(before.checkout).toBe(yield* fs.realPath(near))
        const clean = yield* contractsInProcess(["checkout", near])
        expect(yield* contractsInProcess(["checkout", far])).toEqual(clean)
        yield* fs.makeDirectory(`${near}/cache`)
        yield* fs.writeFileString(`${near}/cache/ignored`, "ignored")
        expect((yield* captureRelease(near)).clean).toBe(true)
        yield* fs.writeFileString(`${near}/untracked`, "untracked")
        expect(yield* captureRelease(near)).toEqual({ ...before, clean: false })
        const dirty = yield* contractsInProcess(["checkout", near])
        expect(dirty).not.toEqual(clean)
        expect(yield* contractsInProcess(["checkout", near])).not.toEqual(dirty)
        yield* fixtureGit(near, ["add", "untracked"])
        expect((yield* captureRelease(near)).clean).toBe(false)
        yield* commitText(far, "two")
        expect((yield* captureRelease(far)).commit).not.toBe(before.commit)
        yield* fs.writeFileString(`${far}/src/main.ts`, sourceText("dirty"))
        expect((yield* captureRelease(far)).clean).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(bunPlatformLayer)),
    30_000,
  )

  it.live("capturing a clean release never refreshes the repository index", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* makeTempDirectoryScoped("gent-release-")
      yield* checkout(root, "one")
      const index = yield* fs.readFile(`${root}/.git/index`)
      // Same working bytes, another stat: status may refresh the index unless optional locks are off.
      yield* fs.writeFileString(`${root}/src/main.ts`, sourceText("one"))
      yield* fs.utimes(`${root}/src/main.ts`, 1, 1)
      expect((yield* captureRelease(root)).clean).toBe(true)
      expect(yield* fs.readFile(`${root}/.git/index`)).toEqual(index)
    }).pipe(Effect.scoped, Effect.provide(bunPlatformLayer)),
  )

  it.live(
    "no git, no checkout or a failed git read names no release, and another process never matches",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("gent-release-")
        const repo = `${root}/repo`
        yield* checkout(repo, "one")
        // ChildProcessSpawner resolves git from the host's PATH: this boundary supplies a missing executable instead.
        expect(
          (yield* sourceRelease(repo).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              yield* gitAs(`${root}/missing-git`),
            ),
          ))._tag,
        ).toBe("Unreleased")
        expect((yield* sourceRelease(root))._tag).toBe("Unreleased")
        const first = yield* contractsInProcess(["checkout", root])
        expect(yield* contractsInProcess(["checkout", root])).not.toEqual(first)
        yield* fixtureGit(repo, ["update-ref", "-d", "HEAD"])
        expect((yield* sourceRelease(repo))._tag).toBe("Unreleased")
      }).pipe(Effect.scoped, Effect.provide(bunPlatformLayer)),
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
          expect((yield* captureRelease(root)).clean).toBe(false)
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
        const dirty = Option.some(build(Option.some({ ...facts, clean: false })))
        const dirtyFirst = yield* contractsInProcess(["platform"], {}, dirty)
        expect(yield* contractsInProcess(["platform"], {}, dirty)).not.toEqual(dirtyFirst)
        expect(dirtyFirst).not.toEqual(embedded)
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

describe("release mismatch messages", () => {
  it.live(
    "generated pairs name the release case and both differing commits, with commands that parse back to the right checkout",
    () =>
      Effect.gen(function* () {
        const random = seeded(RELEASE_SEED + 1)
        const paths = [
          "/nonexistent/near checkout",
          "/nonexistent/it's-a-checkout",
          "/nonexistent/with-$dollar",
          "/nonexistent/with-(parens)",
        ]
        const cases = new Set<string>()
        for (let at = 0; at < 120; at++) {
          const localPath = paths[at % paths.length] ?? ""
          const farPath = `${paths[(at + 1) % paths.length] ?? ""}/far`
          const kind = at % 10
          const [one, two] = releasePair(random, kind)
          const local = helloOf("near", one, localPath)
          const far = helloOf("far", two, farPath)
          const reason = yield* linkMismatch(local, far, UPDATE_ARGV)
          cases.add(String(kind))
          assertReason(reason, local, far, kind)
        }
        expect(cases.size).toBe(10)
      }).pipe(Effect.provide(bunPlatformLayer)),
    30_000,
  )

  it.live(
    "wired hellos keep both checkout commands and resolve the update side from local ancestry",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("gent-link-release-")
        const repo = `${root}/local checkout`
        yield* checkout(repo, "one")
        const local = yield* captureRelease(repo)
        yield* commitText(repo, "two")
        const next = yield* captureRelease(repo)
        const platform = yield* GentPlatform
        const localPlatform = GentPlatform.of({
          ...platform,
          source: Effect.succeed(releasedOf(local)),
          checkout: Effect.succeedSome(local.checkout),
        })
        const farCheckout = "/nonexistent/far checkout"
        for (const { name, commit } of [
          { name: "both", commit: local.commit },
          { name: "behind", commit: next.commit },
        ]) {
          yield* Effect.gen(function* () {
            const far = helloOf("far", cleanRelease(commit), farCheckout)
            const command = yield* farEnd(
              far.contract,
              "serve",
              `${root}/${name}.log`,
              FAR_FACTS,
              Option.some(far),
            )
            const { links } = yield* linksOver({ far: command })
            const view = yield* viewUntil(links, (view) => view[0]?.state === "incompatible")
            const reason = view[0]?.reason ?? ""
            if (name === "both") {
              expect(reason).toContain("reinstall both:")
              const [here = "", there = ""] = reason.split("reinstall both: ")[1]?.split("; ") ?? []
              assertUpdate(here, local.checkout, false)
              // The configured command really runs the fixture, so that is also
              // the prefix the displayed far update must preserve.
              const argv = wordsOf(there)
              expect(argv.slice(0, -1)).toEqual([...command])
              assertUpdate(argv.at(-1) ?? "", farCheckout, false)
            } else {
              expect(reason).toContain("Update this machine:")
              expect(reason).toContain(local.commit.slice(0, 8))
              expect(reason).toContain(next.commit.slice(0, 8))
              assertUpdate(reason.split("Update this machine: ")[1] ?? "", local.checkout, false)
            }
          }).pipe(Effect.scoped, Effect.provideService(GentPlatform, localPlatform))
        }
      }).pipe(Effect.scoped, Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    20_000,
  )

  it.live(
    "behind and ahead use local ancestry; diverged or missing commits give both commands, including a path with a space",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped("gent-release-")
        const repo = `${root}/a checkout`
        yield* checkout(repo, "one")
        const first = (yield* captureRelease(repo)).commit
        yield* commitText(repo, "two")
        const second = (yield* captureRelease(repo)).commit
        const local = helloOf("near", cleanRelease(first), repo)
        const far = helloOf("far", cleanRelease(second), "/nonexistent/far checkout")
        const behind = yield* linkMismatch(local, far, UPDATE_ARGV)
        expect(behind).toContain("Update this machine:")
        assertUpdate(behind.slice(behind.lastIndexOf(": ") + 2), repo, false)
        const ahead = yield* linkMismatch(
          helloOf("near", cleanRelease(second), repo),
          helloOf("far", cleanRelease(first), far.checkout),
          UPDATE_ARGV,
        )
        expect(ahead).toContain("Update far:")
        assertUpdate(ahead.slice(ahead.lastIndexOf(": ") + 2), far.checkout ?? "", true)
        yield* fixtureGit(repo, ["checkout", "-q", "-b", "diverged", first])
        yield* commitText(repo, "three")
        const third = (yield* captureRelease(repo)).commit
        expect(
          yield* linkMismatch(helloOf("near", cleanRelease(third), repo), far, UPDATE_ARGV),
        ).toContain("Update both")
        expect(
          yield* linkMismatch(local, helloOf("far", cleanRelease("a".repeat(40))), UPDATE_ARGV),
        ).toContain("Update both")
        const absent = new LinkHello({
          machine: "far",
          contract: "",
          release: GentRelease.cases.Unreleased.make({ process: "far" }),
        })
        const missing = yield* linkMismatch(local, absent, UPDATE_ARGV)
        expect(missing).toContain("no release (no git checkout)")
        assertUpdate(missing.slice(missing.lastIndexOf(": ") + 2), "<gent checkout>", true)
      }).pipe(Effect.scoped, Effect.provide(bunPlatformLayer)),
    30_000,
  )
})

const PAST_DEADLINE = Duration.seconds(3)

describe("release capture deadlines", () => {
  it.live(
    "a hung git ends the capture in NoRelease within the deadline plus 1 s, leaving no git child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* makeTempDirectoryScoped("gent-release-")
          yield* checkout(directory, "one")
          const calls = `${directory}/calls`
          yield* fs.writeFileString(
            `${directory}/git`,
            slowGit(calls, Bun.which("git") ?? "/usr/bin/git", Duration.seconds(30)),
          )
          yield* fs.chmod(`${directory}/git`, 0o755)
          const started = yield* Clock.currentTimeMillis
          const error = yield* captureRelease(directory).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              yield* gitAs(`${directory}/git`),
            ),
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

  it.live(
    "the release deadline reaps even a git child that ignores SIGTERM, within the force-kill window plus 1 s",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* makeTempDirectoryScoped("gent-release-")
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
            Effect.timeout("16 seconds"),
          )
          expect(error._tag).toBe("NoRelease")
          expect(error.reason).toContain("10 seconds")
          expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(
            10_000 + Duration.toMillis(PAST_DEADLINE),
          )
          const children = yield* logged(calls)
          expect(children.length).toBe(1)
          for (const pid of children) expect(yield* alive(pid), `git ${pid}`).toBe(false)
        }),
      ).pipe(Effect.provide(bunPlatformLayer)),
    18_000,
  )

  it.scoped("one deadline spans every git call of a capture, rather than restarting for each", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* makeTempDirectoryScoped("gent-release-")
      yield* checkout(directory, "one")
      const firstEntered = yield* Deferred.make<boolean>()
      const firstContinue = yield* Deferred.make<boolean>()
      const addEntered = yield* Deferred.make<boolean>()
      const completed = yield* Deferred.make<boolean>()
      const waiting = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command) && command.args.includes("rev-parse")) {
          return Deferred.succeed(firstEntered, true).pipe(
            Effect.andThen(Deferred.await(firstContinue)),
            Effect.andThen(spawner.spawn(command)),
          )
        }
        if (ChildProcess.isStandardCommand(command) && command.args.includes("status")) {
          return Deferred.succeed(addEntered, true).pipe(Effect.andThen(Effect.never))
        }
        return spawner.spawn(command)
      })
      const capture = yield* captureRelease(directory).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, waiting),
        Effect.result,
        Effect.tap(() => Deferred.succeed(completed, true)),
        Effect.forkChild,
      )
      yield* Deferred.await(firstEntered)
      yield* TestClock.adjust("6 seconds")
      yield* Deferred.succeed(firstContinue, true)
      yield* Deferred.await(addEntered)
      yield* TestClock.adjust("4 seconds")
      const acknowledged = yield* Deferred.await(completed).pipe(
        Effect.timeoutOption("1 second"),
        Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
      )
      expect(Option.isSome(acknowledged)).toBe(true)
      const failed = yield* Fiber.join(capture)
      expect(failed._tag).toBe("Failure")
      if (failed._tag === "Failure") expect(failed.failure._tag).toBe("NoRelease")
    }).pipe(Effect.provide(bunPlatformLayer)),
  )
})
