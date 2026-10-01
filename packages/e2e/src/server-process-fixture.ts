import { Duration, Effect, Filter, Option, Schema, type Scope, Stream } from "effect"
import { fileURLToPath } from "node:url"

// ── process exit ────────────────────────────────────────────────────────────

/**
 * The exit code of a process that exits within `within`, or none if it
 * outlives it. Both subprocess fixtures ask this one question. The answer
 * comes from the process's own exit promise (`Bun.Subprocess.exited`, a
 * pty's `exited`), so a pid the kernel has given to another process cannot
 * answer for it.
 */
export const exitWithin = (
  exited: Promise<number>,
  within: Duration.Input,
): Effect.Effect<Option.Option<number>> =>
  Effect.promise(() => exited).pipe(Effect.timeoutOption(within))

// ── server-process-fixture ──────────────────────────────────────────────────

// The TUI binary owns `gent server start`; it runs from its package, whose
// bunfig preloads the JSX transform.
export const tuiDirectory = fileURLToPath(new URL("../../../apps/tui", import.meta.url))

class ServerProcessFixtureError extends Schema.TaggedError<ServerProcessFixtureError>()(
  "@gent/e2e/src/server-process-fixture/ServerProcessFixtureError",
  { message: Schema.String },
) {}

const READY_PREFIX = "Gent server ready on "
const READY_LINE = new RegExp(`${READY_PREFIX}.+`)

export const readReadyUrl = (
  proc: Bun.Subprocess,
  readyWithin: Duration.Input,
): Effect.Effect<string, ServerProcessFixtureError> => {
  const stdout = proc.stdout
  // oxlint-disable-next-line effect/noNullish, effect/noRuntimeTypeof -- Bun stdout uses an external stream, fd, or absent union
  if (stdout === undefined || typeof stdout === "number") {
    return Effect.fail(new ServerProcessFixtureError({ message: "server stdout was not piped" }))
  }
  // The read ends at the ready line or at a missed bound, and either way
  // releases its lock without cancelling: the server keeps its stdout open.
  const ready = Stream.fromReadableStream({
    evaluate: () => stdout,
    onError: (error) =>
      new ServerProcessFixtureError({ message: `reading stdout failed: ${String(error)}` }),
    releaseLockOnEnd: true,
  }).pipe(
    Stream.decodeText,
    Stream.scan(
      () => "",
      (text, chunk) => text + chunk,
    ),
    Stream.filterMap(
      Filter.fromPredicateOption((text: string) =>
        Option.map(Option.fromNullishOr(text.match(READY_LINE)), (match) =>
          match[0].slice(READY_PREFIX.length).trim(),
        ),
      ),
    ),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new ServerProcessFixtureError({ message: "stdout closed before ready" })),
        onSome: Effect.succeed,
      }),
    ),
  )
  return ready.pipe(
    Effect.timeoutOrElse({
      duration: readyWithin,
      orElse: () =>
        Effect.fail(new ServerProcessFixtureError({ message: "server did not become ready" })),
    }),
  )
}

/**
 * Spawn a standalone server subprocess on `port`. The server belongs to the
 * caller's scope: closing it stops the server and waits for its exit, so no
 * server outlives its test.
 */
export const startServer = ({
  dataDir,
  port,
}: {
  readonly dataDir: string
  readonly port: number
}): Effect.Effect<Bun.Subprocess, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      // oxlint-disable-next-line effect/noGlobals -- the fixture spawns the real server process with the test's environment
      Bun.spawn(
        ["bun", "src/main.tsx", "server", "start", "--port", String(port), "--isolate", "--mock"],
        {
          cwd: tuiDirectory,
          env: {
            // oxlint-disable-next-line effect/noGlobals -- the fixture spawns the real server process with the test's environment
            ...Bun.env,
            GENT_DATA_DIR: dataDir,
          },
          stdout: "pipe",
          // Nothing reads stderr; a pipe nobody drains can stall the server.
          stderr: "ignore",
        },
      ),
    ),
    (proc) => stopProcess(proc, 5_000),
  )

/**
 * `startServer`, then its ready line, read for at most 10 seconds. A missed
 * bound fails, and the caller's scope still stops the server.
 */
export const spawnServer = ({
  dataDir,
  port,
}: {
  readonly dataDir: string
  readonly port: number
}): Effect.Effect<{ url: string; proc: Bun.Subprocess }, ServerProcessFixtureError, Scope.Scope> =>
  Effect.gen(function* () {
    const proc = yield* startServer({ dataDir, port })
    const url = yield* readReadyUrl(proc, "10 seconds")
    return { url: `${url}/rpc`, proc }
  })

export const killProcess = (proc: Bun.Subprocess, signal?: NodeJS.Signals): Effect.Effect<void> =>
  Effect.sync(() => {
    proc.kill(signal)
  }).pipe(Effect.ignoreCause)

/**
 * Stop `proc`: SIGTERM, and wait up to `graceMs` for its exit. A process
 * still alive then gets SIGKILL and a second wait; one that outlives both is
 * logged, since nothing more can stop it.
 */
export const stopProcess = (proc: Bun.Subprocess, graceMs: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* killProcess(proc)
    if (Option.isSome(yield* exitWithin(proc.exited, Duration.millis(graceMs)))) return
    yield* killProcess(proc, "SIGKILL")
    if (Option.isSome(yield* exitWithin(proc.exited, Duration.millis(graceMs)))) return
    yield* Effect.logWarning("process outlived SIGTERM and SIGKILL").pipe(
      Effect.annotateLogs({ pid: proc.pid, graceMs }),
    )
  })
