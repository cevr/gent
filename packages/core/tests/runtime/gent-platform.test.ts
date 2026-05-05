/**
 * Locks the GentPlatform service contract end-to-end.
 *
 * `BunGentPlatformLive` is the only file in the repo allowed to call `Bun.*`,
 * so this is the only place we can assert the live wiring works. The Test
 * layer's deterministic `randomId` and stub semantics are also covered so
 * downstream tests can rely on it without re-checking each method.
 */
import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Layer } from "effect"
import { BunGentPlatformLive } from "../../src/runtime/gent-platform-bun"
import { GentPlatform, SignalError } from "../../src/runtime/gent-platform"

describe("GentPlatform", () => {
  describe("BunGentPlatformLive", () => {
    it.live("randomId mints unique UUIDv7 strings", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const a = yield* platform.randomId
        const b = yield* platform.randomId
        expect(a).not.toBe(b)
        // UUIDv7 canonical form: 8-4-4-4-12 hex with v7 in the version nibble.
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("which returns absolute path for known binary, null for missing", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const sh = yield* platform.which("sh")
        expect(typeof sh).toBe("string")
        expect(sh).toMatch(/\/sh$/)
        const missing = yield* platform.which("definitely-not-a-real-binary-xyz")
        expect(missing).toBeNull()
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("spawnSync surfaces the child exit code", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const ok = yield* platform.spawnSync(["sh", "-c", "exit 0"], {
          stdout: "ignore",
          stderr: "ignore",
        })
        expect(ok.exitCode).toBe(0)
        const fail = yield* platform.spawnSync(["sh", "-c", "exit 7"], {
          stdout: "ignore",
          stderr: "ignore",
        })
        expect(fail.exitCode).toBe(7)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("osInfo reports the live host shape", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const info = yield* platform.osInfo
        // Spot-check shape — values are runtime-dependent. Each field must be
        // a non-empty string. `platform` is one of the documented Node values.
        expect(typeof info.platform).toBe("string")
        expect(info.platform.length).toBeGreaterThan(0)
        expect(typeof info.arch).toBe("string")
        expect(info.arch.length).toBeGreaterThan(0)
        expect(typeof info.release).toBe("string")
        expect(typeof info.hostname).toBe("string")
        expect(typeof info.type).toBe("string")
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("pid and execPath match the live host process", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const pid = yield* platform.pid
        const execPath = yield* platform.execPath
        expect(pid).toBe(process.pid)
        expect(typeof pid).toBe("number")
        expect(pid).toBeGreaterThan(0)
        expect(execPath).toBe(process.execPath)
        expect(execPath.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("signal(pid, 0) succeeds for self-pid (liveness probe)", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const pid = yield* platform.pid
        // Probe own process — must succeed without delivering a signal.
        yield* platform.signal(pid, 0)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("signal returns a typed SignalError for an unreachable pid", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        // POSIX pid_max is bounded well below 2^31-1 on every documented
        // host (darwin: ~99999, linux default: 4194304). `process.kill`
        // therefore raises ESRCH for this pid on every CI runner we
        // support. We assert the typed `SignalError` is on the failure
        // channel — not on the defect channel — and that `code` is
        // populated (supervisor classification reads `code`, not `reason`).
        const failure = yield* Effect.flip(platform.signal(2 ** 31 - 1, 0))
        expect(failure).toBeInstanceOf(SignalError)
        expect(failure.pid).toBe(2 ** 31 - 1)
        expect(failure.signal).toBe(0)
        expect(failure.code).toBe("ESRCH")
        expect(typeof failure.reason).toBe("string")
        expect(failure.reason.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("now returns monotonically non-decreasing milliseconds", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const a = yield* platform.now
        const b = yield* platform.now
        expect(typeof a).toBe("number")
        expect(typeof b).toBe("number")
        expect(b).toBeGreaterThanOrEqual(a)
      }).pipe(Effect.provide(BunGentPlatformLive)),
    )
  })

  describe("GentPlatform.Test", () => {
    it.live("randomId mints monotonically with the configured prefix", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const a = yield* platform.randomId
        const b = yield* platform.randomId
        const c = yield* platform.randomId
        expect(a).toBe("t-00000001")
        expect(b).toBe("t-00000002")
        expect(c).toBe("t-00000003")
      }).pipe(Effect.provide(GentPlatform.Test("t"))),
    )

    it.live("which returns null and spawnSync returns 0 by default", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        expect(yield* platform.which("anything")).toBeNull()
        const r = yield* platform.spawnSync(["true"])
        expect(r.exitCode).toBe(0)
      }).pipe(Effect.provide(GentPlatform.Test())),
    )

    it.live("osInfo / pid / execPath / now return Test stub values", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const info = yield* platform.osInfo
        expect(info.platform).toBe("linux")
        expect(info.arch).toBe("x64")
        expect(info.release).toBe("test-release")
        expect(info.hostname).toBe("test-host")
        expect(info.type).toBe("Linux")
        expect(yield* platform.pid).toBe(1)
        expect(yield* platform.execPath).toBe("/usr/bin/node")
        // `now` increments on each call in the Test layer, starting at 1.
        expect(yield* platform.now).toBe(1)
        expect(yield* platform.now).toBe(2)
      }).pipe(Effect.provide(GentPlatform.Test())),
    )

    it.live("signal is a Test no-op (succeeds with void)", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        yield* platform.signal(123, "SIGTERM")
        yield* platform.signal(123, 0)
      }).pipe(Effect.provide(GentPlatform.Test())),
    )

    // Default Test stub for `exit` dies loudly so accidental calls are
    // visible failures rather than silent test hangs.
    it.live("exit dies loudly in the default Test layer", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const exit = yield* platform.exit(3).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          // It must be a defect (Die), not a typed Failure — exit is
          // declared `Effect<never>`, so any failure is a defect by shape.
          // The error message must mention the captured exit code so
          // misuse is greppable in test output.
          const pretty = String(exit.cause)
          expect(pretty).toContain("3")
          expect(pretty).toContain("recorder")
        }
      }).pipe(Effect.provide(GentPlatform.Test())),
    )

    // Tests that need to assert "exit was called with code N" override
    // the layer with a `Deferred` recorder. This locks that pattern as
    // the documented usage.
    it.live("exit captures intended code via a Deferred recorder layer", () =>
      Effect.gen(function* () {
        const captured = yield* Deferred.make<number>()
        const recorder = Layer.effect(
          GentPlatform,
          Effect.gen(function* () {
            const base = yield* GentPlatform
            return GentPlatform.of({
              ...base,
              exit: (code) => Deferred.succeed(captured, code).pipe(Effect.andThen(Effect.never)),
            })
          }).pipe(Effect.provide(GentPlatform.Test())),
        )
        yield* Effect.gen(function* () {
          const platform = yield* GentPlatform
          yield* Effect.race(platform.exit(7), Deferred.await(captured))
        }).pipe(Effect.provide(recorder))
        expect(yield* Deferred.await(captured)).toBe(7)
      }),
    )
  })
})
