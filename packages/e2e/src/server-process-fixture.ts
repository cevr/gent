import { GENT_START_BOUND_MS, waitFor } from "@gent/core/test-utils"
import { Duration, Effect, Filter, Option, Ref, Schema, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
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

// ── a command run to its end ────────────────────────────────────────────────

/** What a command printed on stdout and stderr, and its exit code. */
export interface CommandRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run `command` in `cwd` to its end, as a shell would: its output and exit
 * code. The verify helpers and the gent wrapper they write are run this way.
 * `env` is laid over the caller's environment.
 */
export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd,
          env,
          extendEnv: true,
          forceKillAfter: "5 seconds",
        }),
      )
      const [stdout, stderr, code] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText, Stream.mkString),
          handle.stderr.pipe(Stream.decodeText, Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: 3 },
      )
      return { code: Number(code), stdout, stderr } satisfies CommandRun
    }),
  )

// ── server-process-fixture ──────────────────────────────────────────────────

// The TUI binary owns `gent server start`; it runs from its package, whose
// bunfig preloads the JSX transform.
export const tuiDirectory = fileURLToPath(new URL("../../../apps/tui", import.meta.url))

class ServerProcessFixtureError extends Schema.TaggedError<
  ServerProcessFixtureError,
  { readonly brand: unique symbol }
>()("@gent/e2e/src/server-process-fixture/ServerProcessFixtureError", { message: Schema.String }) {}

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
 * `startServer`, then its ready line, read for at most `GENT_START_BOUND_MS`.
 * A missed bound fails, and the caller's scope still stops the server.
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
    const url = yield* readReadyUrl(proc, GENT_START_BOUND_MS)
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

// ── a test host process ─────────────────────────────────────────────────────

const E2E_DIRECTORY = fileURLToPath(new URL("..", import.meta.url))

/** A host process a crash test runs: a test root that only a signal ends. */
export interface TestHost {
  readonly proc: Bun.Subprocess<"ignore", "pipe", Bun.BunFile>
  /** The `<prefix> <event>` lines the host printed, in order, without the prefix. */
  readonly events: Ref.Ref<ReadonlyArray<string>>
}

/** SIGKILL, then its exit: no finalizer of the host runs. A host that outlives it fails the test. */
export const hardKill = (proc: Bun.Subprocess<"ignore", "pipe", Bun.BunFile>) =>
  killProcess(proc, "SIGKILL").pipe(
    Effect.andThen(exitWithin(proc.exited, "5 seconds")),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error(`host ${proc.pid} outlived SIGKILL by 5 s`)),
        onSome: () => Effect.void,
      }),
    ),
  )

/**
 * Spawns `script` (a path under `packages/e2e`) with `dir` as gent's data
 * dir. The scope kills it with SIGKILL if the test has not; its stderr goes
 * to `<dir>/<label>.err`. Each stdout line that starts with `prefix` and a
 * space is an event.
 */
export const spawnTestHost = (input: {
  readonly script: string
  readonly prefix: string
  readonly dir: string
  readonly label: string
  readonly env: Readonly<Record<string, string>>
}) =>
  Effect.gen(function* () {
    const proc = yield* Effect.acquireRelease(
      Effect.sync(() =>
        // oxlint-disable-next-line effect/noGlobals -- the test spawns the real host process with the test's environment
        Bun.spawn(["bun", input.script], {
          cwd: E2E_DIRECTORY,
          // oxlint-disable-next-line effect/noGlobals -- the test spawns the real host process with the test's environment
          env: { ...Bun.env, GENT_DATA_DIR: input.dir, ...input.env },
          stdin: "ignore",
          stdout: "pipe",
          // oxlint-disable-next-line effect/noGlobals -- the host's log goes to a file the test leaves for a failed run
          stderr: Bun.file(`${input.dir}/${input.label}.err`),
        }),
      ),
      (child) => hardKill(child),
    )
    const events = yield* Ref.make<ReadonlyArray<string>>([])
    const marker = `${input.prefix} `
    yield* Stream.fromReadableStream({ evaluate: () => proc.stdout, onError: String }).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.startsWith(marker)),
      Stream.runForEach((line) =>
        Ref.update(events, (seen) => [...seen, line.slice(marker.length)]),
      ),
      Effect.ignore,
      Effect.forkScoped,
    )
    const host: TestHost = { proc, events }
    return host
  })

/** Waits until `host` printed `event`. */
export const hostPrinted = (host: TestHost, event: string, within: number) =>
  waitFor(Ref.get(host.events), (seen) => seen.includes(event), within, `the host printed ${event}`)
