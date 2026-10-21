/**
 * The verify-gent helpers as a verifier runs them: real processes from a
 * shell, a scratch directory outside the checkout, the scripted model.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { BunPlatformLive } from "@gent/core/host-bun"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
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
import { type CommandRun, runCommand as run } from "../src/server-process-fixture"
import { runVerifyCli } from "../src/verify"

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
  steps: Schema.Finite,
  end: Schema.Struct({ _tag: Schema.String }),
  captures: Schema.Array(Schema.String),
  recording: Schema.Struct({ file: Schema.String, seconds: Schema.Finite }),
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

        const launch = yield* verify(["launch", "--dir", dir], parent)
        expect(launch.code).toBe(0)
        const launched = yield* decodeLine(Launched)(launch.stdout.trim())

        const doctor = yield* verify(["doctor", "--dir", dir], parent)
        expect(doctor.code).toBe(0)
        yield* decodeLine(Healthy)(doctor.stdout.trim())

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
              ["sh", 'gent ctl snapshot --limit 2 > "$EVIDENCE/snapshot.json"'],
            ],
          },
          `${evidence}/turn`,
        )
        expect({ code: drove.code, stderr: drove.stderr }).toMatchObject({ code: 0 })
        const driven = yield* decodeLine(Driven)(drove.stdout.trim())
        expect(driven.steps).toBe(6)
        expect(driven.end._tag).toBe("Stopped")
        expect(driven.captures).toEqual([`${evidence}/turn/answered.txt`])
        expect(driven.recording.file).toBe(`${evidence}/turn/drive.cast`)
        expect(driven.recording.seconds).toBeGreaterThan(0)
        expect(drove.stderr.trimEnd().split("\n")).toHaveLength(6)
        expect(drove.stderr).not.toContain("001|")
        expect(yield* fs.readFileString(`${evidence}/turn/answered.txt`)).toContain(
          "gent debug response",
        )
        expect(yield* fs.readFileString(`${evidence}/turn/snapshot.json`)).toContain("hello drive")

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
})
