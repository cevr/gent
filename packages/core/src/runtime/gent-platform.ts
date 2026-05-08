/**
 * `GentPlatform` — single Effect service that owns every Bun-API and host-OS
 * call gent relies on. Product code yields `GentPlatform` and uses
 * `platform.randomId`, `platform.osInfo`, `platform.exit`, etc., so the
 * runtime stays portable and the `Bun.*` and raw `process.*` references
 * live in exactly one file (`BunGentPlatformLive`).
 *
 * Surface (kept small — only what the codebase actually needs):
 *   - `randomId`         — UUIDv7 string for runtime-owned identifiers
 *   - `osInfo`           — `{ platform, arch, release, hostname, type }`
 *   - `pid`              — current process id
 *   - `execPath`         — absolute path to the running executable
 *   - `homeDirectory`    — current user home directory
 *   - `env`              — snapshot of parent process environment for child
 *                          process launches that must inherit shell config
 *   - `pathListSeparator`— PATH-like list separator (`;` on Windows, `:`
 *                          elsewhere)
 *   - `commandCandidates(command)` — platform-specific executable name
 *                          candidates for PATH lookup
 *   - `isPortFree(port)` — host TCP port probe on loopback
 *   - `signal(pid, sig)` — deliver a POSIX signal (or `0` for liveness probe)
 *   - `exit(code)`       — request the host to exit with `code`. NOT
 *                          finalizer-safe: `process.exit` is synchronous and
 *                          bypasses Effect finalizers. Code that needs
 *                          deterministic teardown should surface the exit
 *                          code through the Effect result and let
 *                          `BunRuntime.runMain` translate it.
 *   - `now`              — monotonic timestamp in milliseconds. Use for
 *                          relative measurements (supervisor backoff math),
 *                          NOT epoch-ish wall-clock comparisons.
 *
 * The `GentPlatform.Test(prefix)` layer mints deterministic ids
 * (`${prefix}-00000001`, ...) and stubs the rest with safe defaults so
 * tests can use it as a drop-in replacement for the live platform.
 *
 * The `no-bun-outside-adapter` lint rule restricts `Bun.*` usage to
 * `GentPlatform.Live`'s implementation file (`gent-platform-bun.ts`).
 */

import { Context, Effect, Layer, Ref, Schema } from "effect"

export interface GentPlatformOsInfo {
  readonly platform: string
  readonly arch: string
  readonly release: string
  readonly hostname: string
  readonly type: string
}

/**
 * `0` is the POSIX liveness probe — `kill(pid, 0)` checks reachability
 * without delivering a signal. Named signals are accepted via the
 * `NodeJS.Signals` string union.
 */
export type GentPlatformSignal = string | 0

/**
 * `SignalError` is the typed failure for `GentPlatform.signal(pid, sig)`. The
 * supervisor-side classifier reads `code` (POSIX `ESRCH` / `EPERM` /
 * `EINVAL`) without parsing free-form `reason` text. `code` is `null` when
 * the underlying error did not carry a `code` property.
 */
export class SignalError extends Schema.TaggedErrorClass<SignalError>()("SignalError", {
  pid: Schema.Number,
  signal: Schema.Union([Schema.String, Schema.Literal(0)]),
  code: Schema.NullOr(Schema.String),
  reason: Schema.String,
}) {}

export interface GentPlatformShape {
  readonly randomId: Effect.Effect<string>
  readonly osInfo: Effect.Effect<GentPlatformOsInfo>
  readonly pid: Effect.Effect<number>
  readonly execPath: Effect.Effect<string>
  readonly homeDirectory: Effect.Effect<string>
  readonly env: Effect.Effect<Record<string, string | undefined>>
  readonly pathListSeparator: Effect.Effect<string>
  readonly commandCandidates: (command: string) => ReadonlyArray<string>
  readonly isPortFree: (port: number) => Effect.Effect<boolean>
  readonly signal: (pid: number, signal: GentPlatformSignal) => Effect.Effect<void, SignalError>
  readonly exit: (code: number) => Effect.Effect<never>
  readonly now: Effect.Effect<number>
}

export class GentPlatform extends Context.Service<GentPlatform, GentPlatformShape>()(
  "@gent/core/src/runtime/gent-platform/GentPlatform",
) {
  /**
   * Deterministic test layer. `randomId` mints `${prefix}-00000001` etc.
   * Other methods return safe, no-op defaults — override the layer if a
   * specific test needs a different shape.
   */
  static Test = (prefix = "id"): Layer.Layer<GentPlatform> =>
    Layer.effect(
      GentPlatform,
      Effect.gen(function* () {
        const counter = yield* Ref.make(0)
        const clock = yield* Ref.make(0)
        return GentPlatform.of({
          randomId: Ref.updateAndGet(counter, (n) => n + 1).pipe(
            Effect.map((n) => `${prefix}-${String(n).padStart(8, "0")}`),
          ),
          osInfo: Effect.succeed({
            platform: "linux",
            arch: "x64",
            release: "test-release",
            hostname: "test-host",
            type: "Linux",
          }),
          pid: Effect.succeed(1),
          execPath: Effect.succeed("/usr/bin/node"),
          homeDirectory: Effect.succeed("/tmp"),
          env: Effect.succeed({}),
          pathListSeparator: Effect.succeed(":"),
          commandCandidates: (command) => [command],
          isPortFree: () => Effect.succeed(true),
          signal: () => Effect.void,
          // The default Test stub dies loudly: silent `Effect.never` would
          // make accidental `platform.exit(...)` calls in a test hang
          // forever, which is the worst possible failure mode. Tests that
          // *intend* to assert "exit was called with code N" override the
          // layer with a `Deferred` recorder.
          exit: (code) =>
            Effect.die(
              new Error(
                `GentPlatform.Test: platform.exit(${code}) called without a recorder override. Provide a layer that captures the intended exit code via Deferred.`,
              ),
            ),
          now: Ref.updateAndGet(clock, (n) => n + 1),
        })
      }),
    )
}
