import {
  Context,
  type Duration,
  Effect,
  Layer,
  Option,
  type PlatformError,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import { causeMessage } from "../domain/guards.js"

// ── gent-platform ───────────────────────────────────────────────────────────

/**
 * `GentPlatform` — single Effect service that owns every Bun-API and host-OS
 * call gent relies on. Product code yields `GentPlatform` and uses
 * `platform.randomId`, `platform.osInfo`, `platform.pid`, etc., so the
 * runtime stays portable and the `Bun.*` and raw `process.*` references
 * live in exactly one file (`BunGentPlatformLive`).
 *
 * Surface (kept small — only what the codebase actually needs):
 *   - `randomId`         — UUIDv7 string for runtime-owned identifiers
 *   - `osInfo`           — `{ platform, arch, release, hostname, type }`
 *   - `pid`              — current process id
 *   - `execPath`         — absolute path to the running executable
 *   - `homeDirectory`    — current user home directory
 *   - `pathListSeparator`— PATH-like list separator (`;` on Windows, `:`
 *                          elsewhere)
 *   - `signal(pid, sig)` — deliver a POSIX signal (or `0` for liveness probe)
 *   - `hash(alg, input)` — content-addressed hex digest. `sha256` for durable
 *                          ids and cache keys; `md5` for non-cryptographic
 *                          memoization. Sync because content-addressed
 *                          SQLite chunking is sync.
 *
 * Random bytes come from Effect `Crypto`, and `file://` URLs become paths
 * through Effect `Path.fromFileUrl`; neither is a platform fact.
 *
 * The `GentPlatform.Test(prefix)` layer mints deterministic ids
 * (`${prefix}-00000001`, ...) and stubs the rest with safe defaults so
 * tests can use it as a drop-in replacement for the live platform.
 *
 * The `no-bun-outside-adapter` lint rule restricts `Bun.*` usage to
 * `GentPlatform.Live`'s implementation file (`gent-platform-bun.ts`).
 */

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
type GentPlatformSignal = string | 0

/**
 * `SignalError` is the typed failure for `GentPlatform.signal(pid, sig)`. The
 * supervisor-side classifier reads `code` (POSIX `ESRCH` / `EPERM` /
 * `EINVAL`) without parsing free-form `reason` text. `code` is `null` when
 * the underlying error did not carry a `code` property.
 */
export class SignalError extends Schema.TaggedError<SignalError>()("SignalError", {
  pid: Schema.Finite,
  signal: Schema.Union([Schema.String, Schema.Literal(0)]),
  code: Schema.NullOr(Schema.String),
  reason: Schema.String,
}) {}

type GentPlatformHashAlgorithm = "sha256" | "md5"

interface GentPlatformApi {
  readonly randomId: Effect.Effect<string>
  readonly osInfo: Effect.Effect<GentPlatformOsInfo>
  readonly pid: Effect.Effect<number>
  readonly execPath: Effect.Effect<string>
  readonly homeDirectory: Effect.Effect<string>
  readonly pathListSeparator: Effect.Effect<string>
  readonly signal: (pid: number, signal: GentPlatformSignal) => Effect.Effect<void, SignalError>
  readonly hash: (algorithm: GentPlatformHashAlgorithm, input: Uint8Array | string) => string
}

export class GentPlatform extends Context.Service<GentPlatform, GentPlatformApi>()(
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
          pathListSeparator: Effect.succeed(":"),
          signal: () => Effect.void,
          // Deterministic, content-derived stub: same input → same digest.
          // Length matches the real `sha256`/`md5` hex output (64/32) so
          // consumers that slice off a prefix observe the right shape.
          hash: (algorithm, input) => {
            let text = ""
            if (Predicate.isString(input)) text = input
            else text = new TextDecoder().decode(input)
            let h = 5381
            for (let i = 0; i < text.length; i += 1) h = (h * 33) ^ text.charCodeAt(i)
            const seed = (h >>> 0).toString(16).padStart(8, "0")
            let width = 32
            if (algorithm === "sha256") width = 64
            return seed.repeat(Math.ceil(width / 8)).slice(0, width)
          },
        })
      }),
    )
}

// ── run-process ─────────────────────────────────────────────────────────────

export class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  timedOut: Schema.optional(Schema.Boolean),
}) {}

interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

interface RunProcessOptions {
  readonly cwd?: string
  // oxlint-disable-next-line effect/noNullish -- Child-process environments use undefined to remove inherited variables.
  readonly env?: Record<string, string | undefined>
  /** Merge `env` over the inherited environment instead of replacing it. */
  readonly extendEnv?: boolean
  readonly timeout?: Duration.Duration
  readonly stdin?: "pipe" | "ignore" | "inherit"
  readonly stdout?: "pipe" | "ignore" | "inherit"
  readonly stderr?: "pipe" | "ignore" | "inherit"
}

const decodeUtf8 = (chunks: Iterable<Uint8Array>): string => {
  const decoder = new TextDecoder()
  let out = ""
  for (const chunk of chunks) out += decoder.decode(chunk)
  return out
}

/**
 * Run a child process to completion and collect its output.
 *
 * A free function over `ChildProcessSpawner`, not a service: there is one
 * implementation and nothing swaps it. Every caller already names the spawner
 * in its requirement union, so a deployment that forgets the platform stack
 * still fails to compile.
 */
export const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: RunProcessOptions = {},
): Effect.Effect<ProcessResult, ProcessError, ChildProcessSpawner.ChildProcessSpawner> => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const stdoutMode = options.stdout ?? "pipe"
      const stderrMode = options.stderr ?? "pipe"
      const spawn = ChildProcess.make(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        extendEnv: options.extendEnv,
        stdin: options.stdin,
        stdout: stdoutMode,
        stderr: stderrMode,
      })
      const handle = yield* spawn
      let collectStdout: Effect.Effect<
        Option.Option<ReadonlyArray<Uint8Array>>,
        PlatformError.PlatformError
      > = Effect.succeedNone
      if (stdoutMode === "pipe") {
        collectStdout = Stream.runCollect(handle.stdout).pipe(Effect.asSome)
      }
      let collectStderr: Effect.Effect<
        Option.Option<ReadonlyArray<Uint8Array>>,
        PlatformError.PlatformError
      > = Effect.succeedNone
      if (stderrMode === "pipe") {
        collectStderr = Stream.runCollect(handle.stderr).pipe(Effect.asSome)
      }
      const [exitCode, stdoutChunks, stderrChunks] = yield* Effect.all(
        [handle.exitCode, collectStdout, collectStderr],
        { concurrency: "unbounded" },
      )
      return {
        exitCode: Number(exitCode),
        stdout: Option.match(stdoutChunks, {
          onNone: () => "",
          onSome: decodeUtf8,
        }),
        stderr: Option.match(stderrChunks, {
          onNone: () => "",
          onSome: decodeUtf8,
        }),
      } satisfies ProcessResult
    }),
  ).pipe(
    Effect.mapError(
      (e) =>
        new ProcessError({
          command,
          message: `${command} failed: ${causeMessage(e)}`,
          cause: e,
        }),
    ),
  )

  return Option.fromUndefinedOr(options.timeout).pipe(
    Option.match({
      onNone: () => program,
      onSome: (timeout) =>
        program.pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new ProcessError({
                  command,
                  message: `${command} timed out`,
                  timedOut: true,
                }),
              ),
          }),
        ),
    }),
  )
}
