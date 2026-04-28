import { describe, expect, it } from "effect-bun-test"
import { Duration, Effect, Layer, Path } from "effect"
import { BunFileSystem, BunChildProcessSpawner } from "@effect/platform-bun"
import { runProcess, ProcessError } from "@gent/core/utils/run-process"
const platformLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
)
const provideBun = <A, E, R>(e: Effect.Effect<A, E, R>) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test boundary, R is platform services we provide here
  Effect.provide(e, platformLayer) as Effect.Effect<A, E, never>
describe("runProcess", () => {
  it.live("captures stdout from a successful command", () =>
    Effect.gen(function* () {
      const result = yield* provideBun(runProcess("printf", ["hello"]))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("hello")
      expect(result.stderr).toBe("")
    }),
  )
  it.live("surfaces nonzero exit code without failing the effect", () =>
    Effect.gen(function* () {
      // sh -c "exit 7" gives a deterministic nonzero without relying on
      // a specific binary's error semantics.
      const result = yield* provideBun(runProcess("sh", ["-c", "exit 7"]))
      expect(result.exitCode).toBe(7)
    }),
  )
  it.live("captures stderr separately from stdout", () =>
    Effect.gen(function* () {
      const result = yield* provideBun(runProcess("sh", ["-c", "printf out; printf err 1>&2"]))
      expect(result.stdout).toBe("out")
      expect(result.stderr).toBe("err")
    }),
  )
  it.live("respects cwd option", () =>
    Effect.gen(function* () {
      const result = yield* provideBun(runProcess("pwd", [], { cwd: "/tmp" }))
      // /tmp may resolve to /private/tmp on macOS
      expect(result.stdout.trim()).toMatch(/\/tmp$/)
      expect(result.exitCode).toBe(0)
    }),
  )
  it.live("respects env option", () =>
    Effect.gen(function* () {
      // PATH is included so `sh` resolves on systems where it isn't at a
      // hard-coded path; the marker var is what we actually assert on.
      const result = yield* provideBun(
        runProcess("sh", ["-c", 'printf %s "$RUN_PROCESS_TEST_VAR"'], {
          env: { PATH: "/usr/bin:/bin:/usr/local/bin", RUN_PROCESS_TEST_VAR: "marker-value" },
        }),
      )
      expect(result.stdout).toBe("marker-value")
    }),
  )
  it.live("timeout fails with timedOut=true when command runs too long", () =>
    Effect.gen(function* () {
      const failed = yield* provideBun(
        runProcess("sh", ["-c", "sleep 5"], { timeout: Duration.millis(100) }).pipe(Effect.flip),
      )
      expect(failed).toBeInstanceOf(ProcessError)
      expect(failed.timedOut).toBe(true)
      expect(failed.message).toContain("timed out")
    }),
  )
  it.live("spawn failure for missing binary surfaces ProcessError", () =>
    Effect.gen(function* () {
      const failed = yield* provideBun(
        runProcess("definitely-not-a-real-binary-xyz", []).pipe(Effect.flip),
      )
      expect(failed).toBeInstanceOf(ProcessError)
      expect(failed.command).toBe("definitely-not-a-real-binary-xyz")
    }),
  )
  it.live("ignores stdout when stdout option is 'ignore'", () =>
    Effect.gen(function* () {
      const result = yield* provideBun(
        runProcess("printf", ["should-not-appear"], { stdout: "ignore" }),
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("")
    }),
  )
})
