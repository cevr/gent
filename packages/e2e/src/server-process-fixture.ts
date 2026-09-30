import { Clock, type Duration, Effect, Schema, type Scope } from "effect"

// ── wait-for-process-exit ───────────────────────────────────────────────────

/**
 * Wait for a process to leave the process table.
 *
 * Both subprocess fixtures need the same answer — did this pid go away
 * before the deadline — so they ask it once here. The result is that
 * question and nothing more: `true` for exited, `false` for timed out. It
 * carries no exit code, because `process.kill(pid, 0)` never reports one.
 */

/** A pid that was never valid cannot be alive, and must not be probed. */
const isPidAlive = (pid: number): Effect.Effect<boolean> => {
  if (!Number.isInteger(pid) || pid <= 0) return Effect.succeed(false)
  return Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.catchEager(() => Effect.succeed(false)),
  )
}

/** `true` once the pid is gone; `false` if it outlived `timeoutMs`. */
export const waitForProcessExit = (pid: number, timeoutMs: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    const loop: Effect.Effect<boolean> = Effect.gen(function* () {
      if (!(yield* isPidAlive(pid))) return true
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) return false
      // gent/no-sleep: allow OS-level wait while polling for the kernel to reap the subprocess
      yield* Effect.sleep("50 millis")
      return yield* loop
    })
    return yield* loop
  })

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
    if (yield* waitForProcessExit(proc.pid, graceMs)) return
    yield* killProcess(proc, "SIGKILL")
    if (yield* waitForProcessExit(proc.pid, graceMs)) return
    yield* Effect.logWarning("process outlived SIGTERM and SIGKILL").pipe(
      Effect.annotateLogs({ pid: proc.pid, graceMs }),
    )
  })
