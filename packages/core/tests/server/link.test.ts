import { describe, expect, it } from "effect-bun-test"
import {
  type Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Predicate,
  Queue,
  References,
  Schema,
  Sink,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
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

/** A step the far end, or time, takes. `seconds` is read by `idle` only. */
type LinkStep = "hello-ok" | "hello-other" | "hello-none" | "frame" | "exit" | "idle" | "backoff"
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
  if (Option.isSome(live)) steps.push(["frame", 3])
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
  /** This server's clock at the far end's last frame, on any run. */
  lastWrite: number
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

/** The far end writes `frame` on the run's stdout. */
const writeFrame = (trial: Trial, run: FakeRun, frame: typeof ServerFrame.Type) =>
  Effect.gen(function* () {
    trial.lastWrite = trial.model.now
    yield* Queue.offer(run.out, frameEncoder.encode(`${encodeServerFrame(frame)}\n`))
    yield* settleLong
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
      lastWrite: model.now,
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
