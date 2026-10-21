/**
 * The verify-gent helpers as a verifier runs them: real processes from a
 * shell, a scratch directory outside the checkout, the scripted model.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import { Effect, FileSystem, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { runCommand as run } from "../src/server-process-fixture"

const VERIFY = fileURLToPath(new URL("../src/verify.ts", import.meta.url))

const verify = (args: ReadonlyArray<string>, cwd: string) => run("bun", [VERIFY, ...args], cwd)

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
  alive: Schema.Array(Schema.Finite),
  removed: Schema.Boolean,
})

const decodeLine = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))

/** Whether `pid` is still a process: `ps` prints nothing for a gone one. */
const isAlive = (pid: number) =>
  run("ps", ["-o", "pid=", "-p", String(pid)], "/").pipe(
    Effect.map((ran) => ran.stdout.trim().length > 0),
  )

describe("verify helpers", () => {
  it.scopedLive(
    "launch, doctor, a ctl turn and stop leave no process and no scratch directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const parent = yield* makeTempDirectoryScoped("gent-verify-")
        const dir = `${parent}/run`

        const launch = yield* verify(["launch", "--dir", dir], parent)
        expect(launch.code).toBe(0)
        const launched = yield* decodeLine(Launched)(launch.stdout.trim())
        // A scratch run stops by its recorded PIDs even when an assertion below fails.
        yield* Effect.addFinalizer(() => verify(["stop", "--dir", dir], parent).pipe(Effect.ignore))

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

        // A second launch into the same directory is refused: one run per directory.
        const again = yield* verify(["launch", "--dir", dir], parent)
        expect(again.code).toBe(1)

        const stop = yield* verify(["stop", "--dir", dir, "--remove"], parent)
        expect(stop.code).toBe(0)
        const stopped = yield* decodeLine(Stopped)(stop.stdout.trim())
        expect(stopped).toMatchObject({ alive: [], removed: true })
        expect(yield* isAlive(launched.supervisorPid)).toBe(false)
        expect(yield* isAlive(launched.serverPid)).toBe(false)
        expect(yield* fs.exists(dir)).toBe(false)
      }).pipe(Effect.timeout("100 seconds"), Effect.provide(BunServices.layer)),
    120_000,
  )

  it.scopedLive("a scratch directory inside the checkout is refused", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const inside = fileURLToPath(new URL("../.verify-refused", import.meta.url))
      const launch = yield* verify(["launch", "--dir", inside], "/")
      expect(launch.code).toBe(1)
      expect(launch.stdout).toBe("")
      expect(yield* fs.exists(inside)).toBe(false)
    }).pipe(Effect.timeout("30 seconds"), Effect.provide(BunServices.layer)),
  )
})
