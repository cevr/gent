import { describe, expect, it } from "effect-bun-test"
import { Duration, Effect, Layer, Path } from "effect"
import { BunChildProcessSpawner, BunFileSystem } from "@effect/platform-bun"
import { runProcess, ProcessError } from "@gent/core/utils/run-process"
const makePlatformLayer = () =>
  Layer.mergeAll(
    BunFileSystem.layer,
    Path.layer,
    BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
  )
const provideBun = <A, E, R>(e: Effect.Effect<A, E, R>) =>
  Effect.provide(e, makePlatformLayer()) as Effect.Effect<A, E, never>

const processTestTimeout = 15_000
const withProcessTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout("10 seconds"))

describe("runProcess", () => {
  it.live(
    "surfaces nonzero exit code without failing the effect",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          // sh -c "exit 7" gives a deterministic nonzero without relying on
          // a specific binary's error semantics.
          const result = yield* provideBun(runProcess("/bin/sh", ["-c", "exit 7"]))
          expect(result.exitCode).toBe(7)
        }),
      ),
    processTestTimeout,
  )
  it.live(
    "captures stderr separately from stdout",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(
            runProcess("/bin/sh", ["-c", "printf out; printf err 1>&2"]),
          )
          expect(result.stdout).toBe("out")
          expect(result.stderr).toBe("err")
        }),
      ),
    processTestTimeout,
  )
  it.live(
    "respects cwd option",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(runProcess("pwd", [], { cwd: "/tmp" }))
          // /tmp may resolve to /private/tmp on macOS
          expect(result.stdout.trim()).toMatch(/\/tmp$/)
          expect(result.exitCode).toBe(0)
        }),
      ),
    processTestTimeout,
  )
  it.live(
    "respects env option",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          // PATH is included so `sh` resolves on systems where it isn't at a
          // hard-coded path; the marker var is what we actually assert on.
          const result = yield* provideBun(
            runProcess("/bin/sh", ["-c", 'printf %s "$RUN_PROCESS_TEST_VAR"'], {
              env: { PATH: "/usr/bin:/bin:/usr/local/bin", RUN_PROCESS_TEST_VAR: "marker-value" },
            }),
          )
          expect(result.stdout).toBe("marker-value")
        }),
      ),
    processTestTimeout,
  )
  it.live(
    "timeout fails with timedOut=true when command runs too long",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const failed = yield* provideBun(
            runProcess("/bin/sh", ["-c", "sleep 5"], { timeout: Duration.millis(100) }).pipe(
              Effect.flip,
            ),
          )
          expect(failed).toBeInstanceOf(ProcessError)
          expect(failed.timedOut).toBe(true)
          expect(failed.message).toContain("timed out")
        }),
      ),
    processTestTimeout,
  )
  it.live(
    "spawn failure for missing binary surfaces ProcessError",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const failed = yield* provideBun(
            runProcess("definitely-not-a-real-binary-xyz", []).pipe(Effect.flip),
          )
          expect(failed).toBeInstanceOf(ProcessError)
          expect(failed.command).toBe("definitely-not-a-real-binary-xyz")
        }),
      ),
    processTestTimeout,
  )
  it.live(
    "ignores stdout when stdout option is 'ignore'",
    () =>
      withProcessTimeout(
        Effect.gen(function* () {
          const result = yield* provideBun(
            runProcess("printf", ["should-not-appear"], { stdout: "ignore" }),
          )
          expect(result.exitCode).toBe(0)
          expect(result.stdout).toBe("")
        }),
      ),
    processTestTimeout,
  )
})
