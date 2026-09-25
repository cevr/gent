import {
  Config,
  Context,
  type Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Random,
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

/**
 * A module a file loaded at runtime may import: its exports, read when a file
 * first imports it. A promise lets the module be imported on first use.
 */
export type RuntimeModuleSource = () => object | Promise<object>

interface GentPlatformApi {
  /**
   * Resolve each bare specifier to the given module for every file loaded
   * after this call, whatever its directory. A specifier binds once per
   * process; a later bind of the same specifier is ignored.
   */
  readonly bindModules: (modules: ReadonlyMap<string, RuntimeModuleSource>) => Effect.Effect<void>
  readonly randomId: Effect.Effect<string>
  readonly osInfo: Effect.Effect<GentPlatformOsInfo>
  readonly pid: Effect.Effect<number>
  readonly execPath: Effect.Effect<string>
  readonly homeDirectory: Effect.Effect<string>
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
          bindModules: () => Effect.void,
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
          homeDirectory: Effect.succeed("/nonexistent/gent-test-home"),
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

/** One streaming decoder across the chunks: a character split between two chunks decodes whole. */
const decodeUtf8 = (chunks: Iterable<Uint8Array>): string => {
  const decoder = new TextDecoder()
  let out = ""
  for (const chunk of chunks) out += decoder.decode(chunk, { stream: true })
  return out + decoder.decode()
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

// ── write-file-atomic ───────────────────────────────────────────────────────

/**
 * Replaces the file at `path` with `content` through a staged sibling. A
 * string is written as UTF-8; bytes are written as given. The content lands in a temporary file in the target directory, which is then
 * renamed over the file, so a reader (or a crash) never sees a half-written
 * file. The one atomic write: core's config and every extension use it.
 *
 * A symlink at `path` is followed, as a plain write follows it: the file it
 * names is replaced (staged in that file's directory) and the link stays. A
 * config under ~/.gent can be a link into a dotfiles checkout.
 *
 * The staged file is synced to disk before the rename, so the rename never
 * publishes text the disk does not hold yet.
 *
 * The file keeps its permission bits: `options.mode` when given (a
 * credential passes 0600), else the mode of the file it replaces, else the
 * default for a new file.
 */
/** A string's UTF-8 bytes; bytes as given. */
const contentBytes = (content: string | Uint8Array): Uint8Array => {
  if (Predicate.isString(content)) return new TextEncoder().encode(content)
  return content
}

export const writeFileAtomic = Effect.fn("writeFileAtomic")(function* (
  path: string,
  content: string | Uint8Array,
  options?: { readonly mode?: number },
) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  // The file behind `path`: follow the link at the file itself (not the
  // directories above it), hop by hop, as the OS does, up to its 40-hop limit.
  // A path that is not a link is the file; a dangling link names the file to
  // create.
  const follow = (current: string, hops: number): Effect.Effect<string> =>
    fs.readLink(current).pipe(
      Effect.map((link) => pathService.resolve(pathService.dirname(current), link)),
      Effect.matchEffect({
        onFailure: () => Effect.succeed(current),
        onSuccess: (next) => {
          if (hops >= 40) return Effect.succeed(next)
          return follow(next, hops + 1)
        },
      }),
    )
  const target = yield* follow(path, 1)
  const mode = yield* Option.fromUndefinedOr(options?.mode).pipe(
    Option.match({
      onSome: (explicit) => Effect.succeedSome(explicit),
      onNone: () =>
        fs.stat(target).pipe(
          Effect.map((info) => Option.some(info.mode & 0o7777)),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(Option.none<number>()),
          ),
        ),
    }),
  )
  // Staged as a sibling file, not in a temp directory: a crash that skips the
  // cleanup leaves one hidden file beside the target, never a directory.
  const suffix = (yield* Random.nextIntBetween(0, 0xffffffff)).toString(16).padStart(8, "0")
  const staging = pathService.join(
    pathService.dirname(target),
    stagingName(pathService.basename(target), suffix),
  )
  // `wx` never reuses an existing file. A create that fails because the file
  // exists found another writer's staging file, which stays; any other failed
  // create may have left the file it opened, which is this write's. A mode is
  // set before the content lands, so a secret is never readable under the
  // default mode, even staged.
  const removeStaging = fs.remove(staging).pipe(Effect.ignore)
  yield* Effect.acquireUseRelease(
    fs
      .writeFileString(
        staging,
        "",
        Option.match(mode, {
          onNone: () => ({ flag: "wx" }),
          onSome: () => ({ flag: "wx", mode: 0o600 }),
        }),
      )
      .pipe(
        Effect.tapError((error) => {
          if (error.reason._tag === "AlreadyExists") return Effect.void
          return removeStaging
        }),
      ),
    () =>
      Effect.gen(function* () {
        if (Option.isSome(mode)) yield* fs.chmod(staging, mode.value)
        // The staged text reaches the disk before the rename publishes it, so
        // a power loss after the rename cannot leave the file empty.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(staging, { flag: "w" })
            const bytes = contentBytes(content)
            // An empty write reports zero bytes written, which writeAll fails; the staged file is already empty.
            if (bytes.length > 0) yield* file.writeAll(bytes)
            yield* file.sync
          }),
        )
        yield* fs.rename(staging, target)
      }),
    (_, exit) => {
      if (Exit.isSuccess(exit)) return Effect.void
      return removeStaging
    },
  )
})

/** The longest file name, in bytes, that the file systems gent runs on accept. */
const NAME_MAX_BYTES = 255
const STAGING_TAG = ".gent-write-"

/** The UTF-8 length of one code point. */
const utf8Bytes = (codePoint: number): number => {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/**
 * `.<basename>.gent-write-<suffix>`, with the basename clipped at a code point
 * so the whole name fits in NAME_MAX: a name a plain write accepts must not
 * fail only because it is staged.
 */
const stagingName = (basename: string, suffix: string): string => {
  let room = NAME_MAX_BYTES - 1 - STAGING_TAG.length - suffix.length
  let clipped = ""
  for (const char of basename) {
    const bytes = utf8Bytes(char.codePointAt(0) ?? 0)
    if (bytes > room) break
    room -= bytes
    clipped += char
  }
  return `.${clipped}${STAGING_TAG}${suffix}`
}

// ── data-directory ──────────────────────────────────────────────────────────

/**
 * Where gent keeps its durable state: `GENT_DATA_DIR` as given when set,
 * else `<home>/.gent`. The one rule: the server that opens the database, the
 * `doctor` and `storage reset` commands, and every extension that keeps files
 * beside the database resolve through here, so an isolated run never writes
 * into another run's directory. The caller makes the path absolute with its
 * own path service. A malformed value is no value: the fallback under `home`
 * still applies.
 */
export const resolveDataDir = (home: string): Effect.Effect<string> =>
  Config.option(Config.string("GENT_DATA_DIR")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map(Option.getOrElse(() => `${home}/.gent`)),
  )
