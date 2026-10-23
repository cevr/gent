/**
 * The verify-gent helpers as a verifier runs them: real processes from a
 * shell, a scratch directory outside the checkout, the scripted model.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { GentPlatform } from "@gent/core/host"
import { BunPlatformLive } from "@gent/core/host-bun"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import {
  Clock,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { fileURLToPath } from "node:url"
import { DriveEnd, type DrivenPass, StepOutcome } from "../src/pty-fixture"
import { type CommandRun, runCommand as run } from "../src/server-process-fixture"
import { drivenPasses, runVerifyCli } from "../src/verify"

const VERIFY = fileURLToPath(new URL("../src/verify.ts", import.meta.url))
const CHECKOUT = fileURLToPath(new URL("../../..", import.meta.url))

const verify = (args: ReadonlyArray<string>, cwd: string, env: Record<string, string> = {}) =>
  run(process.execPath, [VERIFY, ...args], cwd, env)

const Launched = Schema.TaggedStruct("Launched", {
  gent: Schema.String,
  work: Schema.String,
  url: Schema.String,
  supervisorPid: Schema.Finite,
  serverPid: Schema.Finite,
})
const Healthy = Schema.TaggedStruct("Healthy", {})
const TurnEnded = Schema.TaggedStruct("TurnEnded", {
  sessionId: Schema.String,
})
const Stopped = Schema.TaggedStruct("Stopped", {
  removed: Schema.Boolean,
})
const Driven = Schema.TaggedStruct("Driven", {
  passes: Schema.Array(
    Schema.Struct({
      size: Schema.String,
      steps: Schema.Finite,
      end: Schema.Struct({ _tag: Schema.String }),
      captures: Schema.Array(Schema.String),
      recording: Schema.Struct({ file: Schema.String, seconds: Schema.Finite }),
    }),
  ),
})
const ErrorLine = Schema.Struct({
  _tag: Schema.String,
  step: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  problems: Schema.optionalKey(Schema.Array(Schema.String)),
})
const Pids = Schema.Struct({ supervisorPid: Schema.Finite, serverPid: Schema.Finite })

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const decodeLine = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))

/** The one tagged JSON error line a failed command printed, with nothing on stdout. */
const errorOf = (ran: CommandRun) =>
  Effect.gen(function* () {
    expect(ran.stdout).toBe("")
    expect(ran.stderr.trimEnd().split("\n")).toHaveLength(1)
    return yield* decodeLine(ErrorLine)(ran.stderr.trim())
  })

/** An error line's tag and step. */
const failureOf = (line: typeof ErrorLine.Type) => [line._tag, line.step]

/** Whether `pid` names a live process; signal 0 checks without sending one. */
const isAlive = (pid: number) => Result.isSuccess(Result.try(() => process.kill(pid, 0)))

/** Fails while `pid` lives, for up to five seconds. */
const goneWithin = (pid: number) =>
  Effect.suspend(() => {
    if (isAlive(pid)) return Effect.fail(`PID ${pid} is alive`)
    return Effect.void
  }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }))

/** Write `script` as JSON beside the run and drive it into `out`. */
const driveScript = (
  parent: string,
  dir: string,
  name: string,
  script: Schema.JsonObject,
  out: string,
  extra: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = `${parent}/${name}.json`
    yield* fs.writeFileString(file, encodeJson({ cols: 80, rows: 24, out: "x", ...script }))
    return yield* verify(["drive", "--dir", dir, "--script", file, "--out", out, ...extra], parent)
  })

describe("verify helpers", () => {
  it.scopedLive(
    "launch, doctor, a ctl turn, drives and stop leave no process and no scratch directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        // The helpers name paths as the file system resolves them: /var is /private/var here.
        const parent = yield* fs.realPath(yield* makeTempDirectoryScoped("gent-verify-"))
        const dir = `${parent}/run`
        // A scratch run stops by its receipt even when launch or an assertion below fails.
        yield* Effect.addFinalizer(() => verify(["stop", "--dir", dir], parent).pipe(Effect.ignore))

        // `--data` seeds an account ledger the server reads as it starts: one
        // window 30% used, two 2-point segments of 240k fuel, so 120k a point:
        // 60 points to the 90% stop over 2 h hold one run.
        const now = yield* Clock.currentTimeMillis
        const segment = (endedAt: number) => ({
          provider: "anthropic",
          slot: "default",
          window: "5h",
          endedAt,
          fuel: 240_000,
          deltaPct: 2,
          tokens: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 0 },
        })
        yield* fs.makeDirectory(`${parent}/evidence`)
        const ledger = `${parent}/evidence/credential-usage.json`
        yield* fs.writeFileString(
          ledger,
          encodeJson({
            buckets: [],
            readings: [
              {
                provider: "anthropic",
                slot: "default",
                window: "5h",
                utilization: 0.3,
                resetAt: now + 2 * 3_600_000,
                readAt: now - 60_000,
                rejected: false,
              },
            ],
            segments: [segment(now - 600_000), segment(now - 120_000)],
          }),
        )
        const launch = yield* verify(["launch", "--dir", dir, "--data", ledger], parent)
        expect(launch.code).toBe(0)
        const launched = yield* decodeLine(Launched)(launch.stdout.trim())

        const doctor = yield* verify(["doctor", "--dir", dir], parent)
        expect(doctor.code).toBe(0)
        yield* decodeLine(Healthy)(doctor.stdout.trim())

        // The server read the copy: its lanes are the ledger's, through the run's wrapper.
        const lanes = yield* run(launched.gent, ["ctl", "lanes", "--line"], launched.work)
        expect({ code: lanes.code, stdout: lanes.stdout }).toEqual({
          code: 0,
          stdout: "lanes anthropic 1/1 free · 5h 120k/% ±13% · out 0%\n",
        })

        // The run's wrapper reaches its own server, with the run's environment.
        const turn = yield* run(
          launched.gent,
          ["ctl", "send", "--new", "--wait", "debug think"],
          launched.work,
        )
        expect(turn.code).toBe(0)
        yield* decodeLine(TurnEnded)(turn.stdout.trim())

        // A drive: one compact line per step on stderr, captures in files, a recording that plays.
        const evidence = `${parent}/evidence`
        const drove = yield* driveScript(
          parent,
          dir,
          "turn",
          {
            command: ["gent"],
            steps: [
              ["waitFor", "ready · work", 30_000],
              ["send", "hello drive"],
              ["keys", "enter"],
              ["waitFor", "gent debug response", 15_000],
              ["cap", "answered"],
              ["fits"],
              ["sh", 'gent ctl snapshot --limit 2 > "$EVIDENCE/snapshot.json"'],
            ],
          },
          `${evidence}/turn`,
        )
        expect({ code: drove.code, stderr: drove.stderr }).toMatchObject({ code: 0 })
        const [driven, ...more] = (yield* decodeLine(Driven)(drove.stdout.trim())).passes
        expect(more).toEqual([])
        expect(driven?.size).toBe("80x24")
        expect(driven?.steps).toBe(7)
        expect(driven?.end._tag).toBe("Stopped")
        // Files are named from the evidence directory.
        expect(driven?.captures).toEqual(["answered.txt"])
        expect(driven?.recording.file).toBe("drive.cast")
        expect(driven?.recording.seconds).toBeGreaterThan(0)
        const lines = drove.stderr.trimEnd().split("\n")
        expect(lines).toHaveLength(8)
        expect(lines.at(-1)).toMatch(/^pass 7\/7 · stopped \d+ · /)
        expect(drove.stderr).not.toContain("001|")
        expect(yield* fs.readFileString(`${evidence}/turn/answered.txt`)).toContain(
          "gent debug response",
        )
        expect(yield* fs.readFileString(`${evidence}/turn/snapshot.json`)).toContain("hello drive")

        // A sweep runs the steps at each size and through a live resize, each
        // pass in a directory of its own, its recording checked at its size.
        const swept = yield* driveScript(
          parent,
          dir,
          "sweep",
          {
            command: ["gent"],
            sweep: [[60, 20]],
            steps: [["waitFor", "ready · work", 30_000], ["fits"]],
          },
          `${evidence}/sweep`,
        )
        expect({ code: swept.code, stderr: swept.stderr }).toMatchObject({ code: 0 })
        const sizes = (yield* decodeLine(Driven)(swept.stdout.trim())).passes
        expect(sizes.map((pass) => [pass.size, pass.recording.file, pass.captures])).toEqual([
          ["80x24", "80x24/drive.cast", []],
          ["60x20", "60x20/drive.cast", []],
          ["80x24-60x20", "80x24-60x20/drive.cast", ["80x24-60x20/resized.txt"]],
        ])
        expect(swept.stderr).toContain("== 80x24-60x20")
        expect(
          yield* fs.readFileString(`${evidence}/sweep/80x24-60x20/passed/resized.txt`),
        ).toContain("# resized 60x20")

        // A step that misses fails the drive, after the script ran to its end.
        const missed = yield* driveScript(
          parent,
          dir,
          "missed",
          {
            command: ["gent"],
            steps: [
              ["waitFor", "ready · work", 30_000],
              ["waitFor", "never drawn", 300],
              ["sh", "exit 4"],
            ],
          },
          `${evidence}/missed`,
          ["--no-record"],
        )
        expect(missed.code).toBe(1)
        const missLine = yield* decodeLine(ErrorLine)(missed.stderr.trimEnd().split("\n").at(-1))
        expect(missLine._tag).toBe("DriveFailed")
        expect(missLine.problems).toEqual([
          'miss waitFor "never drawn" 300',
          'fail sh "exit 4": exit 4',
        ])
        expect(yield* fs.exists(`${evidence}/missed/drive.cast`)).toBe(false)

        // A script that could reach past the run is refused before anything runs.
        const refusals: ReadonlyArray<readonly [string, Schema.JsonObject, string]> = [
          ["cwd-outside", { command: ["gent"], cwd: parent, steps: [] }, "outside the run"],
          ["env-home", { command: ["gent"], env: { HOME: parent }, steps: [] }, "HOME"],
          [
            "env-data",
            { command: ["gent"], env: { GENT_DATA_DIR: parent }, steps: [] },
            "GENT_DATA_DIR",
          ],
          ["other-gent", { command: ["/usr/local/bin/gent"], steps: [] }, "command[0]"],
          ["shell", { command: ["/bin/sh", "-c", "true"], steps: [] }, "command[0]"],
          ["escape", { command: ["gent"], steps: [["cap", "../escaped"]] }, "capture name"],
          ["regex", { command: ["gent"], steps: [["waitFor", "["]] }, "not a regular expression"],
        ]
        for (const [name, script, reason] of refusals) {
          const refused = yield* driveScript(parent, dir, name, script, `${evidence}/${name}`)
          expect(refused.code).toBe(1)
          const error = yield* errorOf(refused)
          expect(failureOf(error)).toEqual(["VerifyFailed", "script"])
          expect(error.message).toContain(reason)
        }
        expect(yield* fs.exists(`${parent}/escaped.txt`)).toBe(false)
        // An evidence directory inside the checkout is refused under a symlinked name too.
        yield* fs.symlink(CHECKOUT, `${parent}/checkout-alias`)
        const aliased = yield* driveScript(
          parent,
          dir,
          "aliased",
          { command: ["gent"], steps: [] },
          `${parent}/checkout-alias/.verify-evidence`,
        )
        expect(aliased.code).toBe(1)
        expect(failureOf(yield* errorOf(aliased))).toEqual(["VerifyFailed", "out"])
        expect(yield* fs.exists(`${CHECKOUT}/.verify-evidence`)).toBe(false)

        // A flag the parser refuses is one usage line and exit 2.
        const usage = yield* verify(["doctor", "--dir", dir, "--bogus"], parent)
        expect(usage.code).toBe(2)
        expect((yield* errorOf(usage))._tag).toBe("VerifyUsage")

        // A defect is one VerifyFailed line; its whole cause goes to the run's verify.log.
        const err = yield* Ref.make("")
        const defect = yield* runVerifyCli(["doctor", "--dir", dir]).pipe(
          Effect.provide(
            Layer.mergeAll(
              BunPlatformLive,
              Stdio.layerTest({
                stdout: () => Sink.die("stdout closed"),
                stderr: () =>
                  Sink.forEach((chunk: string | Uint8Array) =>
                    Ref.update(err, (text) => text + String(chunk)),
                  ),
              }),
            ),
          ),
          Effect.exit,
        )
        expect(Exit.isFailure(defect)).toBe(true)
        const defectLine = yield* decodeLine(ErrorLine)((yield* Ref.get(err)).trim())
        expect(failureOf(defectLine)).toEqual(["VerifyFailed", "defect"])
        expect(defectLine.message).toContain(`${dir}/verify.log`)
        expect(yield* fs.readFileString(`${dir}/verify.log`)).toContain("stdout closed")

        // A second launch into the same directory is refused: one run per directory.
        const again = yield* verify(["launch", "--dir", dir], parent)
        expect(again.code).toBe(1)

        // Without `ps` a stop cannot show the run is gone: it fails and keeps the receipt.
        const blind = yield* verify(["stop", "--dir", dir, "--remove"], parent, {
          PATH: "/var/empty",
        })
        expect(blind.code).toBe(1)
        expect((yield* errorOf(blind))._tag).toBe("StopFailed")
        expect(yield* fs.exists(`${dir}/pids.json`)).toBe(true)
        expect(isAlive(launched.serverPid)).toBe(true)

        const stop = yield* verify(["stop", "--dir", dir, "--remove"], parent)
        expect(stop.code).toBe(0)
        expect(yield* decodeLine(Stopped)(stop.stdout.trim())).toMatchObject({ removed: true })
        expect(isAlive(launched.supervisorPid)).toBe(false)
        expect(isAlive(launched.serverPid)).toBe(false)
        expect(yield* fs.exists(dir)).toBe(false)
      }).pipe(Effect.timeout("170 seconds"), Effect.provide(BunServices.layer)),
    180_000,
  )

  it.scopedLive(
    "a launch interrupted before its server answers leaves no process",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const parent = yield* makeTempDirectoryScoped("gent-verify-")
        const dir = `${parent}/run`
        yield* Effect.addFinalizer(() => verify(["stop", "--dir", dir], parent).pipe(Effect.ignore))
        const launch = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [VERIFY, "launch", "--dir", dir], {
            cwd: parent,
            stdout: "pipe",
            forceKillAfter: "20 seconds",
          }),
        )
        // The receipt names the server as soon as the supervisor spawns it, before it answers.
        const pids = yield* Effect.flatMap(fs.readFileString(`${dir}/pids.json`), (text) =>
          decodeLine(Pids)(text.trim()),
        ).pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 1_000 }))
        expect(yield* fs.exists(`${dir}/run.json`)).toBe(false)
        yield* launch.kill({ killSignal: "SIGINT" }).pipe(Effect.ignore)
        expect(yield* launch.stdout.pipe(Stream.decodeText, Stream.mkString)).toBe("")
        yield* goneWithin(pids.supervisorPid)
        yield* goneWithin(pids.serverPid)
      }).pipe(Effect.timeout("60 seconds"), Effect.provide(BunServices.layer)),
    70_000,
  )

  it.scopedLive("launch refuses data outside its fixture roots, including symlink escapes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const parent = yield* fs.realPath(yield* makeTempDirectoryScoped("gent-verify-"))
      const outside = `${parent}/private.json`
      yield* fs.writeFileString(outside, "private fixture")
      yield* fs.makeDirectory(`${parent}/evidence`)
      yield* fs.symlink(outside, `${parent}/evidence/alias.json`)
      yield* fs.symlink(parent, `${parent}/evidence/escape`)
      // Only harmless fixtures are opened, including for the real-home deny rule below.
      for (const [index, source] of [
        outside,
        `${parent}/evidence/alias.json`,
        `${parent}/evidence/escape/private.json`,
      ].entries()) {
        const dir = `${parent}/run-${index}`
        yield* Effect.addFinalizer(() => verify(["stop", "--dir", dir], parent).pipe(Effect.ignore))
        const result = yield* verify(["launch", "--dir", dir, "--data", source], parent)
        expect(result.code).toBe(1)
        expect(failureOf(yield* errorOf(result))).toEqual(["VerifyFailed", "data"])
        expect(yield* fs.exists(`${dir}/data/private.json`)).toBe(false)
        expect(yield* fs.exists(`${dir}/pids.json`)).toBe(false)
      }
    }).pipe(Effect.timeout("30 seconds"), Effect.provide(BunServices.layer)),
  )

  it.scopedLive("launch refuses the real home's .gent even inside an allowed evidence root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const platform = yield* GentPlatform
      const parent = yield* fs.realPath(yield* makeTempDirectoryScoped("gent-verify-"))
      const home = `${parent}/evidence`
      yield* fs.makeDirectory(`${home}/.gent`, { recursive: true })
      yield* fs.writeFileString(`${home}/.gent/private.json`, "harmless stand-in")
      yield* fs.symlink(`${home}/.gent/private.json`, `${home}/alias.json`)
      for (const source of [`${home}/.gent/private.json`, `${home}/alias.json`]) {
        const err = yield* Ref.make("")
        const exit = yield* runVerifyCli([
          "launch",
          "--dir",
          `${parent}/run`,
          "--data",
          source,
        ]).pipe(
          Effect.provideService(GentPlatform, { ...platform, homeDirectory: Effect.succeed(home) }),
          Effect.provide(
            Stdio.layerTest({
              stdout: () => Sink.die("a refused launch prints no result"),
              stderr: () =>
                Sink.forEach((chunk: string | Uint8Array) =>
                  Ref.update(err, (text) => text + String(chunk)),
                ),
            }),
          ),
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        const error = yield* decodeLine(ErrorLine)((yield* Ref.get(err)).trim())
        expect(failureOf(error)).toEqual(["VerifyFailed", "data"])
        expect(error.message).toContain("real home's .gent")
        expect(yield* fs.exists(`${parent}/run/pids.json`)).toBe(false)
      }
    }).pipe(Effect.timeout("30 seconds"), Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("a scratch directory inside the checkout is refused, under any name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const parent = yield* makeTempDirectoryScoped("gent-verify-")
      yield* fs.symlink(CHECKOUT, `${parent}/checkout-alias`)
      for (const inside of [
        `${CHECKOUT}/.verify-refused`,
        `${parent}/checkout-alias/.verify-refused`,
      ]) {
        const launch = yield* verify(["launch", "--dir", inside], "/")
        expect(launch.code).toBe(1)
        expect(failureOf(yield* errorOf(launch))).toEqual(["VerifyFailed", "dir"])
      }
      expect(yield* fs.exists(`${CHECKOUT}/.verify-refused`)).toBe(false)
    }).pipe(Effect.timeout("30 seconds"), Effect.provide(BunServices.layer)),
  )

  it.scopedLive(
    "a size whose recording does not play fails the drive, and each other size keeps its pass",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const out = yield* makeTempDirectoryScoped("gent-verify-")
        const pass = (cols: number, rows: number, cast: string) =>
          Effect.gen(function* () {
            const dir = `${out}/${cols}x${rows}`
            yield* fs.makeDirectory(dir)
            yield* fs.writeFileString(`${dir}/home.txt`, "# home\n")
            yield* fs.writeFileString(`${dir}/drive.cast`, cast)
            const driven: DrivenPass = {
              size: `${cols}x${rows}`,
              script: {
                command: ["true"],
                cwd: out,
                cols,
                rows,
                out: dir,
                steps: [["cap", "home"]],
              },
              outcome: {
                steps: [
                  StepOutcome.cases.Ok.make({
                    at: 0,
                    step: "cap home",
                    ms: 1,
                    file: `${dir}/home.txt`,
                  }),
                ],
                end: DriveEnd.cases.Stopped.make({ code: 0 }),
                recording: Option.some(`${dir}/drive.cast`),
              },
            }
            return driven
          })
        const passes = [
          yield* pass(80, 24, ""),
          yield* pass(60, 20, '{"version": 2, "width": 60, "height": 20}\n[0.5, "o", "home"]\n'),
        ]
        const error = yield* Effect.flip(drivenPasses(out, passes))
        // The empty recording fails alone; the other plays.
        expect([error._tag, error.message]).toEqual([
          "VerifyFailed",
          "header: Expected a valid JSON string",
        ])
        expect(yield* fs.exists(`${out}/80x24/passed`)).toBe(false)
        expect(yield* fs.readFileString(`${out}/60x20/passed/home.txt`)).toBe("# home\n")
      }).pipe(Effect.timeout("30 seconds"), Effect.provide(BunServices.layer)),
  )
})
