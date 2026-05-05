/**
 * `GentPlatform` — single Effect service that owns every Bun-API and host-OS
 * call gent relies on. Product code yields `GentPlatform` and uses
 * `platform.randomId`, `platform.osInfo`, `platform.exit`, etc., so the
 * runtime stays portable and the `Bun.*` and raw `process.*` references
 * live in exactly one file (`BunGentPlatformLive`).
 *
 * Surface (kept small — only what the codebase actually needs):
 *   - `randomId`         — UUIDv7 string (replaces the standalone `IdService`)
 *   - `which(cmd)`       — resolve a binary on PATH, `null` if missing
 *   - `inspect(value)`   — human-readable string for arbitrary JS values
 *   - `serve(opts)`      — scoped HTTP listener; auto-stops when the scope closes
 *   - `readFileText(p)`  — read a file as UTF-8 text, `null` if missing
 *   - `spawnSync(cmd)`   — synchronous subprocess; returns exit code
 *   - `osInfo`           — `{ platform, arch, release, hostname, type }`
 *   - `pid`              — current process id
 *   - `execPath`         — absolute path to the running executable
 *   - `signal(pid, sig)` — deliver a POSIX signal (or `0` for liveness probe)
 *   - `exit(code)`       — request the host to exit with `code`
 *   - `now`              — monotonic timestamp in milliseconds
 *
 * The `GentPlatform.Test(prefix)` layer mints deterministic ids
 * (`${prefix}-00000001`, ...) and stubs the rest with safe defaults so
 * tests can use it as a drop-in replacement for the live platform.
 *
 * The `no-bun-outside-adapter` lint rule restricts `Bun.*` usage to
 * `GentPlatform.Live`'s implementation file (`gent-platform-bun.ts`).
 */

import { Context, Effect, Layer, Ref, Schema, type Scope } from "effect"

export interface GentPlatformServeOptions {
  readonly fetch: (request: Request) => Response | Promise<Response>
}

export interface GentPlatformListener {
  readonly port: number
}

export interface GentPlatformSpawnSyncOptions {
  readonly stdout?: "pipe" | "ignore" | "inherit"
  readonly stderr?: "pipe" | "ignore" | "inherit"
}

export interface GentPlatformSpawnSyncResult {
  readonly exitCode: number
}

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
export type GentPlatformSignal = NodeJS.Signals | 0

export class SignalError extends Schema.TaggedErrorClass<SignalError>()("SignalError", {
  pid: Schema.Number,
  signal: Schema.Union([Schema.String, Schema.Literal(0)]),
  reason: Schema.String,
}) {}

export interface GentPlatformShape {
  readonly randomId: Effect.Effect<string>
  readonly which: (command: string) => Effect.Effect<string | null>
  readonly inspect: (value: unknown) => string
  readonly serve: (
    options: GentPlatformServeOptions,
  ) => Effect.Effect<GentPlatformListener, never, Scope.Scope>
  readonly readFileText: (path: string) => Effect.Effect<string | null>
  readonly spawnSync: (
    command: ReadonlyArray<string>,
    options?: GentPlatformSpawnSyncOptions,
  ) => Effect.Effect<GentPlatformSpawnSyncResult>
  readonly osInfo: Effect.Effect<GentPlatformOsInfo>
  readonly pid: Effect.Effect<number>
  readonly execPath: Effect.Effect<string>
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
          which: () => Effect.succeed(null),
          inspect: (value) => {
            try {
              return JSON.stringify(value)
            } catch {
              return String(value)
            }
          },
          serve: () => Effect.succeed({ port: 0 }),
          readFileText: () => Effect.succeed(null),
          spawnSync: () => Effect.succeed({ exitCode: 0 }),
          osInfo: Effect.succeed({
            platform: "linux",
            arch: "x64",
            release: "test-release",
            hostname: "test-host",
            type: "Linux",
          }),
          pid: Effect.succeed(1),
          execPath: Effect.succeed("/usr/bin/node"),
          signal: () => Effect.void,
          exit: () => Effect.never,
          now: Ref.updateAndGet(clock, (n) => n + 1),
        })
      }),
    )
}
