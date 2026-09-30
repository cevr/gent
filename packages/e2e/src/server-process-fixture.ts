import { Duration, Effect, Option, Schema, type Scope } from "effect"

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

const repoRoot = decodeURIComponent(new URL("../../..", import.meta.url).pathname).replace(
  /\/$/,
  "",
)
// The TUI binary owns `gent server start`; it runs from its package, whose
// bunfig preloads the JSX transform.
const tuiDirectory = `${repoRoot}/apps/tui`

class ServerProcessFixtureError extends Schema.TaggedError<ServerProcessFixtureError>()(
  "@gent/e2e/src/server-process-fixture/ServerProcessFixtureError",
  { message: Schema.String },
) {}

const READY_PREFIX = "Gent server ready on "
const READY_LINE = new RegExp(`${READY_PREFIX}.+`)

const readReadyUrl = (
  proc: Bun.Subprocess,
  readyWithin: Duration.Input,
): Effect.Effect<string, ServerProcessFixtureError> => {
  const ready = Effect.callback<string, ServerProcessFixtureError>((resume) => {
    const chunks: string[] = []
    const decoder = new TextDecoder()
    const stdout = proc.stdout
    // oxlint-disable-next-line effect/noNullish, effect/noRuntimeTypeof -- Bun stdout uses an external stream, fd, or absent union
    if (stdout === undefined || typeof stdout === "number") {
      resume(Effect.fail(new ServerProcessFixtureError({ message: "server stdout was not piped" })))
      return
    }
    const reader = stdout.getReader()
    const pump = (): void => {
      reader.read().then(
        ({ value, done }) => {
          if (done) {
            resume(
              Effect.fail(new ServerProcessFixtureError({ message: "stdout closed before ready" })),
            )
            return
          }
          chunks.push(decoder.decode(value))
          const match = chunks.join("").match(READY_LINE)
          if (match) {
            reader.releaseLock()
            resume(Effect.succeed(match[0].slice(READY_PREFIX.length).trim()))
          } else {
            pump()
          }
        },
        (error: unknown) =>
          resume(
            Effect.fail(
              new ServerProcessFixtureError({ message: `reading stdout failed: ${String(error)}` }),
            ),
          ),
      )
    }
    pump()
    // A missed ready bound interrupts the wait: the pending read is cancelled with it.
    return Effect.tryPromise(() => reader.cancel()).pipe(Effect.ignore)
  })
  return ready.pipe(
    Effect.timeoutOrElse({
      duration: readyWithin,
      orElse: () =>
        Effect.fail(new ServerProcessFixtureError({ message: "server did not become ready" })),
    }),
  )
}

/**
 * Spawn a standalone server subprocess on `port` and wait for its ready line,
 * for at most `readyWithin` (10 seconds unless given). The server belongs to
 * the caller's scope: closing it stops the server and waits for its exit,
 * and so does a missed ready bound, so no server outlives its test.
 */
export const spawnServer = ({
  dataDir,
  port,
  readyWithin = "10 seconds",
}: {
  readonly dataDir: string
  readonly port: number
  readonly readyWithin?: Duration.Input
}): Effect.Effect<{ url: string; proc: Bun.Subprocess }, ServerProcessFixtureError, Scope.Scope> =>
  Effect.gen(function* () {
    const proc = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn(
          ["bun", "src/main.tsx", "server", "start", "--port", String(port), "--isolate", "--mock"],
          {
            cwd: tuiDirectory,
            env: {
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
    const url = yield* readReadyUrl(proc, readyWithin)
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
