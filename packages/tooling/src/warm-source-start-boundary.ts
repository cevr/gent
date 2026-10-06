/**
 * Process entry: the second preload of the lanes whose tests start gent from
 * source (the `test:e2e` lanes of `@gent/e2e` and `@gent/tui`). It loads
 * after the test preload and reads the `XDG_CACHE_HOME` that one names.
 *
 * The source preload keeps the TUI's Solid transforms in a cache keyed by
 * each file's path and text, so a checkout starts with none: its first start
 * runs Babel on every `.tsx` file, about 5.5 CPU-seconds against 1.5 warm,
 * and on a loaded machine that start misses `GENT_START_BOUND_MS`. One
 * `gent --version` here, before any test, fills the cache, so each start a
 * test bounds is a warm one. The run has its own bound. A run that fails or
 * misses it only leaves the cache cold, and the tests report what broke. The
 * top-level await is this file's Promise edge: bun waits for a preload.
 */
import { BunServices } from "@effect/platform-bun"
import { Config, Console, Duration, Effect, FileSystem, ManagedRuntime, Path, Stream } from "effect"
import { ChildProcess } from "effect/process"

/** Longer than a cold `gent --version` at load 75 (about 20 s). */
const WARM_START_BOUND = Duration.minutes(2)

const warmStart = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // Without it the start fills the cache of the temp home removed below.
  yield* Config.String("XDG_CACHE_HOME").pipe(Effect.orDie)
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-warm-start-" })
  const handle = yield* ChildProcess.make("bun", ["src/main.tsx", "--version"], {
    cwd: yield* path.fromFileUrl(new URL("../../../apps/tui", import.meta.url)),
    forceKillAfter: "5 seconds",
    env: { HOME: home },
    extendEnv: true,
    stdout: "ignore",
    stderr: "pipe",
  })
  const [exitCode, stderr] = yield* Effect.all(
    [handle.exitCode, Stream.mkString(Stream.decodeText(handle.stderr))],
    { concurrency: "unbounded" },
  )
  if (Number(exitCode) === 0) return
  yield* Console.error(
    `warm-source-start: gent --version exited ${String(exitCode)}; the first start runs cold\n${stderr}`,
  )
}).pipe(
  Effect.scoped,
  Effect.timeout(WARM_START_BOUND),
  Effect.catch((error) =>
    Console.error(`warm-source-start: ${String(error)}; the first start runs cold`),
  ),
)

const runtime = ManagedRuntime.make(BunServices.layer)
// oxlint-disable-next-line effect/noAsyncFunction -- bun waits for a preload only through its top-level await
await runtime.runPromise(warmStart)
// oxlint-disable-next-line effect/noAsyncFunction -- the same edge: the runtime closes before the tests start
await runtime.dispose()
