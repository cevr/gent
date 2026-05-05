/**
 * Locks the GentPlatform service contract end-to-end.
 *
 * `BunGentPlatformLive` is the only file in the repo allowed to call `Bun.*`,
 * so this is the only place we can assert the live wiring works. The Test
 * layer's deterministic `randomId` and stub semantics are also covered so
 * downstream tests can rely on it without re-checking each method.
 */
import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Exit, Layer, Scope } from "effect"
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

    it.live("readFileText returns text for an existing file, null for missing", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        // `/etc/hosts` is a well-known readable file on darwin/linux CI.
        const present = yield* platform.readFileText("/etc/hosts")
        expect(present).not.toBeNull()
        expect(typeof present).toBe("string")
        const missing = yield* platform.readFileText("/tmp/__gent-platform-test-missing__")
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

    it.scopedLive(
      "serve binds an ephemeral port and serves requests for the scope's lifetime",
      () =>
        Effect.gen(function* () {
          const platform = yield* GentPlatform
          const scope = yield* Scope.make()
          const listener = yield* platform
            .serve({
              fetch: () => new Response("hi", { status: 200 }),
            })
            .pipe(Scope.provide(scope))

          expect(typeof listener.port).toBe("number")
          expect(listener.port).toBeGreaterThan(0)

          // Round-trip: the listener actually accepts requests while the
          // scope is open. Using the global fetch is intentional here — the
          // test exercises a freshly-bound socket on a discovered port, not
          // a service consumed via HttpClient.
          // @effect-diagnostics-next-line globalFetchInEffect:off
          const res = yield* Effect.promise(() => fetch(`http://127.0.0.1:${listener.port}/`))
          const body = yield* Effect.promise(() => res.text())
          expect(body).toBe("hi")

          // Scope close MUST run the release finalizer without erroring —
          // the underlying Bun.serve `.stop()` is invoked. We don't assert
          // immediate port release because Bun's TCP listener tear-down is
          // asynchronous; what we DO assert is that finalization itself is
          // wired (no leaked-scope warning, no error).
          const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit)
          expect(closeExit._tag).toBe("Success")
        }).pipe(Effect.provide(BunGentPlatformLive)),
    )

    it.live("inspect produces a human-readable string", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const out = platform.inspect({ a: 1, b: ["x", "y"] })
        expect(out).toContain("a")
        expect(out).toContain("1")
        expect(out).toContain("x")
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

    it.live("signal returns a SignalError for a non-numeric / unreachable target", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        // `process.kill` with a clearly unreachable pid (out of pid_max
        // territory) raises ESRCH on every POSIX host. We assert the typed
        // `SignalError` is on the failure channel, not the defect channel.
        const failure = yield* Effect.flip(platform.signal(2 ** 31 - 1, 0))
        expect(failure).toBeInstanceOf(SignalError)
        expect(failure.pid).toBe(2 ** 31 - 1)
        expect(failure.signal).toBe(0)
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

    it.live("which/readFileText return null and spawnSync returns 0 by default", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        expect(yield* platform.which("anything")).toBeNull()
        expect(yield* platform.readFileText("/anywhere")).toBeNull()
        const r = yield* platform.spawnSync(["true"])
        expect(r.exitCode).toBe(0)
      }).pipe(Effect.provide(GentPlatform.Test())),
    )

    it.scopedLive("serve returns port 0 and is a no-op listener", () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const scope = yield* Scope.make()
        const listener = yield* platform
          .serve({ fetch: () => new Response("ignored") })
          .pipe(Scope.provide(scope))
        expect(listener.port).toBe(0)
        yield* Scope.close(scope, Exit.void)
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

    // The Test layer's default `exit` returns `Effect.never` — calling it
    // would hang. Tests that need to assert "exit was called with code N"
    // override the layer with a `Deferred` recorder. This locks that
    // pattern as the documented usage.
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
