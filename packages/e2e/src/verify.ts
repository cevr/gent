/**
 * The verify-gent helpers: a scratch gent a verifier launches, checks, drives
 * and stops, on the scripted model, with nothing of the owner's.
 *
 *   bun run verify:launch --dir <scratch>     seed, start, print the run once usable
 *   bun run verify:doctor --dir <scratch>     read-only: is this run worth driving?
 *   bun run verify:drive --dir <scratch> --script <file> --out <evidence> [--print] [--no-record]
 *   bun run verify:stop --dir <scratch> [--remove]
 *
 * `launch` seeds the scratch directory (a home, a data directory, fake keys, a
 * workspace, a cache), then starts `serve`: the supervisor that serves the
 * model catalog fixture and owns `gent server start --mock` as its child, so
 * stopping the supervisor by its recorded PID stops the server too. Until the
 * server answers, `launch` owns the supervisor: an interrupt or a failure
 * stops it. Every gent the run starts goes through `<scratch>/bin/gent`, a
 * wrapper that runs this checkout's source with the run's environment and no
 * other.
 *
 * `.claude/skills/verify-gent/SKILL.md` is the reader's guide. Each command
 * prints one JSON value on stdout; a failure prints one tagged JSON line on
 * stderr and exits 1, a flag the parser refuses exits 2. A defect is a
 * `VerifyFailed` line too, its whole cause appended to `<scratch>/verify.log`.
 */
import { BunRuntime } from "@effect/platform-bun"
import { GentPlatform } from "@gent/core/host"
import { BunPlatformLive } from "@gent/core/host-bun"
import { seedAuthKeys, serveModelCatalogFixture, TEST_MODEL_ID } from "@gent/core/test-utils"
import { Gent, serverLock, dataPaths } from "@gent/sdk"
import {
  Cause,
  Clock,
  Config,
  ConfigProvider,
  Console,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Runtime,
  Schedule,
  Schema,
  Stdio,
  Stream,
} from "effect"
import { CliError, Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  checkRecording,
  DriveEnd,
  DriveScript,
  type DrivenPass,
  keepPassed,
  passProblems,
  runDrivePasses,
  StepOutcome,
} from "./pty-fixture"

// ── errors and output ───────────────────────────────────────────────────────

/** A helper step that failed; `step` names it. */
class VerifyFailed extends Schema.TaggedError<VerifyFailed, { readonly brand: unique symbol }>()(
  "VerifyFailed",
  { step: Schema.String, message: Schema.String },
) {
  override readonly [Runtime.errorReported] = false
}

/** A flag or argument the parser refused; exit 2. */
class VerifyUsage extends Schema.TaggedError<VerifyUsage, { readonly brand: unique symbol }>()(
  "VerifyUsage",
  { message: Schema.String },
) {
  override readonly [Runtime.errorReported] = false
  override readonly [Runtime.errorExitCode] = 2
}

/** One doctor check: its name, whether it passed, and what it saw. */
const Check = Schema.Struct({ name: Schema.String, ok: Schema.Boolean, detail: Schema.String })
type Check = typeof Check.Type

/** The doctor's first failed check, with every check it ran. */
class DoctorFailed extends Schema.TaggedError<DoctorFailed, { readonly brand: unique symbol }>()(
  "DoctorFailed",
  { check: Schema.String, detail: Schema.String, checks: Schema.Array(Check) },
) {
  override readonly [Runtime.errorReported] = false
}

/**
 * A drive that ran to its end and failed: `problems`, one line per missed
 * or failed step and per exit the script does not expect; `end`, how the
 * program ended. Each step's line, and the rows a failed one shows, are on
 * stderr above it.
 */
class DriveFailed extends Schema.TaggedError<DriveFailed, { readonly brand: unique symbol }>()(
  "DriveFailed",
  {
    out: Schema.String,
    problems: Schema.Array(Schema.String),
  },
) {
  override readonly [Runtime.errorReported] = false
}

/**
 * A stop that cannot show the run is gone: `alive`, the recorded PIDs it
 * still found or could not inspect. The receipts and the directory stay, so
 * a second stop can try again.
 */
class StopFailed extends Schema.TaggedError<StopFailed, { readonly brand: unique symbol }>()(
  "StopFailed",
  { dir: Schema.String, message: Schema.String, alive: Schema.Array(Schema.Int) },
) {
  override readonly [Runtime.errorReported] = false
}

const VerifyError = Schema.Union([VerifyFailed, VerifyUsage, DoctorFailed, DriveFailed, StopFailed])
type VerifyError = typeof VerifyError.Type

const failed =
  (step: string) =>
  (error: { readonly message: string }): VerifyFailed =>
    new VerifyFailed({ step, message: error.message })

const writeLine = (stream: "stdout" | "stderr", text: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const sinks = { stdout: () => stdio.stdout(), stderr: () => stdio.stderr() }
    yield* Stream.make(`${text}\n`).pipe(Stream.run(sinks[stream]()), Effect.ignore)
  })

/** Print `value`, encoded by `schema`, as the command's one JSON value. */
const printJson = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError(failed("print")),
    Effect.flatMap((text) => writeLine("stdout", text)),
  )

/** Print a helper error as one JSON line on stderr, then fail with it. */
const reportError = (error: VerifyError) =>
  Schema.encodeEffect(Schema.fromJsonString(VerifyError))(error).pipe(
    // An error this module's schema declares always encodes.
    Effect.orDie,
    Effect.flatMap((text) => writeLine("stderr", text)),
    Effect.andThen(Effect.fail(error)),
  )

// ── paths ───────────────────────────────────────────────────────────────────

/**
 * `target` as the file system resolves it: the real path of its deepest
 * existing ancestor, symlinks followed, with the rest appended. Two names of
 * one directory compare equal.
 */
const canonical: (
  target: string,
) => Effect.Effect<string, VerifyFailed, FileSystem.FileSystem | Path.Path> = Effect.fn(
  "Verify.canonical",
)(function* (target: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absolute = path.resolve(target)
  const exists = yield* fs.exists(absolute).pipe(Effect.mapError(failed("path")))
  if (exists) return yield* fs.realPath(absolute).pipe(Effect.mapError(failed("path")))
  const parent = path.dirname(absolute)
  if (parent === absolute) return absolute
  return path.join(yield* canonical(parent), path.basename(absolute))
})

/** Whether canonical `child` is `parent` or lies under it. */
const within = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

// ── the run's layout and record ─────────────────────────────────────────────

/** Where a run keeps each part, under its scratch directory. */
const layout = (dir: string) => ({
  dir,
  home: `${dir}/home`,
  data: `${dir}/data`,
  auth: `${dir}/auth`,
  gh: `${dir}/gh`,
  cache: `${dir}/cache`,
  work: `${dir}/work`,
  bin: `${dir}/bin`,
  gent: `${dir}/bin/gent`,
  record: `${dir}/run.json`,
  pids: `${dir}/pids.json`,
  serveLog: `${dir}/serve.log`,
  serverLog: `${dir}/server.log`,
  verifyLog: `${dir}/verify.log`,
})
type Layout = ReturnType<typeof layout>

/** What `serve` records once its server answers; doctor and drive read it. */
const VerifyRun = Schema.Struct({
  dir: Schema.String,
  work: Schema.String,
  gent: Schema.String,
  checkout: Schema.String,
  /** The server's build: `src-<short HEAD>` of the checkout it runs from. */
  build: Schema.String,
  supervisorPid: Schema.Int,
  serverPid: Schema.Int,
  url: Schema.String,
  /** The environment every gent of the run gets, `PATH` aside. */
  env: Schema.Record(Schema.String, Schema.String),
})
type VerifyRun = typeof VerifyRun.Type

/**
 * The receipt of the run's processes, written as each starts: `launch`
 * records the supervisor before it waits, the supervisor its server as soon
 * as it spawns it. `stop` reads this, so a run whose launch died before the
 * server answered still stops.
 */
const RunPids = Schema.Struct({
  supervisorPid: Schema.Int,
  serverPid: Schema.optionalKey(Schema.Int),
})
type RunPids = typeof RunPids.Type

const readJson = <A, I>(schema: Schema.Codec<A, I>, file: string, step: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file)
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text)
  }).pipe(Effect.mapError(failed(step)))

/** Flag `"w"` overwrites the file; `"wx"` leaves a file that is already there. */
const writeJson = <A, I>(
  schema: Schema.Codec<A, I>,
  file: string,
  value: A,
  step: string,
  flag: "w" | "wx" = "w",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value)
    yield* fs.writeFileString(file, `${text}\n`, { flag }).pipe(
      Effect.catchIf(
        (error) => flag === "wx" && error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    )
  }).pipe(Effect.mapError(failed(step)))

const readRun = (paths: Layout) => readJson(VerifyRun, paths.record, "read-run")
const readPids = (paths: Layout) => readJson(RunPids, paths.pids, "read-pids")

/** This checkout, from this file's place in it, symlinks resolved. */
const checkoutRoot = Effect.gen(function* () {
  const path = yield* Path.Path
  const here = yield* path.fromFileUrl(new URL(import.meta.url))
  return path.resolve(here, "../../../..")
}).pipe(Effect.mapError(failed("checkout")), Effect.flatMap(canonical))

/** The scratch directory, canonical; never inside the checkout under any name. */
const scratchDir = (dir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const root = yield* checkoutRoot
    const absolute = yield* canonical(dir)
    if (within(path, root, absolute)) {
      return yield* new VerifyFailed({
        step: "dir",
        message: `${absolute} is inside the checkout ${root}; name a scratch directory outside it`,
      })
    }
    return layout(absolute)
  })

/** Data fixtures stay in the run, its sibling evidence directory, or repository test fixtures. */
const dataSource = Effect.fn("Verify.dataSource")(function* (paths: Layout, source: string) {
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const ownerData = yield* canonical(path.join(yield* platform.homeDirectory, ".gent"))
  const real = yield* canonical(source)
  if (within(path, ownerData, real)) {
    return yield* new VerifyFailed({
      step: "data",
      message: "The real home's .gent is never a data fixture",
    })
  }
  const root = yield* checkoutRoot
  const evidence = yield* canonical(path.join(path.dirname(paths.dir), "evidence"))
  const parts = path.relative(root, real).split(path.sep)
  const fixture =
    within(path, root, real) &&
    ((parts[0] === "tests" && parts[1] === "fixtures") ||
      ((parts[0] === "packages" || parts[0] === "apps") &&
        parts[2] === "tests" &&
        parts[3] === "fixtures"))
  if (!within(path, paths.dir, real) && !within(path, evidence, real) && !fixture) {
    return yield* new VerifyFailed({
      step: "data",
      message: `${real} is outside the run, ${evidence}, and repository test fixtures`,
    })
  }
  return real
})

/** A command's output lines, or the failure that stopped it. */
const outputOf = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* spawner.lines(
      ChildProcess.make(command, [...args], { cwd, forceKillAfter: "5 seconds" }),
    )
  }).pipe(Effect.mapError(failed(command)))

/** The build a source server of this checkout names: `src-<short HEAD>`. */
const checkoutBuild = (root: string) =>
  outputOf("git", ["rev-parse", "--short", "HEAD"], root).pipe(
    Effect.map((lines) => `src-${lines.join("").trim()}`),
  )

/**
 * The command line `pid` runs, `None` when no process has it. `ps` exits 0
 * with the line, or 1 with nothing for a PID no process has; anything else,
 * `ps` failing to start included, fails: absence is never assumed.
 */
const processCommand = (pid: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make("ps", ["-o", "command=", "-p", String(pid)], {
          cwd: "/",
          stdin: "ignore",
          forceKillAfter: "5 seconds",
        }),
      )
      const [text, code] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText, Stream.mkString), handle.exitCode],
        { concurrency: 2 },
      )
      const line = Option.fromUndefinedOr(text.split("\n").find((each) => each.trim().length > 0))
      if (Number(code) === 0 && Option.isSome(line)) return line
      if (Number(code) === 1 && Option.isNone(line)) return Option.none<string>()
      return yield* new VerifyFailed({
        step: "ps",
        message: `ps -p ${pid} exited ${code}: ${text.trim()}`,
      })
    }),
  ).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new VerifyFailed({ step: "ps", message: error.message })),
    ),
  )

// ── seed and wrapper ────────────────────────────────────────────────────────

/** Quote `text` for a POSIX shell. */
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * The environment of every gent of the run: the scratch home, data
 * directory, keys and cache, the catalog fixture, and a signed-out `gh`.
 * Nothing else of the caller's environment reaches it but `PATH`, `TERM`
 * and the locale. A drive script may not set any of these.
 */
const runEnv = (paths: Layout, catalog: string) => ({
  HOME: paths.home,
  GENT_DATA_DIR: paths.data,
  GENT_AUTH_DIRECTORY: paths.auth,
  GENT_MODEL_CATALOG_URL: catalog,
  GH_CONFIG_DIR: paths.gh,
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  COLORTERM: "truecolor",
  LANG: "C.UTF-8",
  // The source run's JSX transform cache, in the run: the run writes nothing outside it.
  XDG_CACHE_HOME: paths.cache,
})

/** The variables a drive sets itself beside the run's: a script may not set them either. */
const DRIVE_OWNED = ["PATH", "EVIDENCE"]

/**
 * `<scratch>/bin/gent`: this checkout's source TUI under the run's
 * environment, from any working directory. `env -i` drops the caller's
 * variables, provider keys included.
 */
const wrapperText = (root: string, bun: string, env: Record<string, string>) => {
  const tui = `${root}/apps/tui`
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`)
  return [
    "#!/bin/sh",
    `# gent from ${root}, in the verify run beside this file. Written by verify:launch.`,
    `exec env -i PATH="$PATH" TERM="\${TERM:-xterm-256color}" ${assignments.join(" ")} \\`,
    `  ${shellQuote(bun)} --preload ${shellQuote(`${tui}/scripts/dev-preload-boundary.ts`)} ${shellQuote(`${tui}/src/main.tsx`)} "$@"`,
    "",
  ].join("\n")
}

/** A fresh scratch run: home, data, keys, cache, workspace. Refuses a directory with files in it. */
const seed = (paths: Layout) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    // A directory that does not exist yet has no entries.
    const entries = yield* fs.readDirectory(paths.dir).pipe(Effect.orElseSucceed(() => []))
    if (entries.length > 0) {
      return yield* new VerifyFailed({
        step: "seed",
        message: `${paths.dir} is not empty; launch takes a new directory per run`,
      })
    }
    const dirs = [
      `${paths.home}/.gent`,
      paths.data,
      paths.auth,
      paths.gh,
      paths.cache,
      paths.work,
      paths.bin,
    ]
    yield* Effect.gen(function* () {
      for (const each of dirs) yield* fs.makeDirectory(each, { recursive: true })
      // A session needs a model: the user config names the scripted model's id.
      yield* fs.writeFileString(`${paths.home}/.gent/config.json`, `{"model":"${TEST_MODEL_ID}"}\n`)
      yield* seedAuthKeys(paths.auth)
    }).pipe(Effect.mapError(failed("seed")))
  })

// ── serve: the supervisor ───────────────────────────────────────────────────

const READY_PREFIX = "Gent server ready on "

/** Append each chunk of `stream` to `file`; resolve `ready` with the url of the ready line. */
const teeServerOutput = (
  stream: Stream.Stream<Uint8Array, unknown>,
  file: string,
  onLine: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* stream.pipe(
      Stream.tap((chunk) => fs.writeFile(file, chunk, { flag: "a" }).pipe(Effect.ignore)),
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach(onLine),
      Effect.ignore,
    )
  })

/**
 * The supervisor: serve the catalog fixture, write the wrapper, start
 * `gent server start --mock` as a child of this scope and add its PID to the
 * receipt, record the run once the server prints its ready line, then hold
 * until a signal ends the scope.
 */
const serve = Effect.fn("Verify.serve")(function* (paths: Layout, port: number) {
  const fs = yield* FileSystem.FileSystem
  const platform = yield* GentPlatform
  const root = yield* checkoutRoot
  const catalog = yield* serveModelCatalogFixture
  const env = runEnv(paths, catalog)
  const supervisorPid = yield* platform.pid
  yield* fs
    .writeFileString(paths.gent, wrapperText(root, yield* platform.execPath, env))
    .pipe(Effect.andThen(fs.chmod(paths.gent, 0o755)), Effect.mapError(failed("wrapper")))
  const handle = yield* ChildProcess.make(
    paths.gent,
    ["server", "start", "--mock", "--port", String(port)],
    { cwd: paths.work, stdout: "pipe", stderr: "pipe", forceKillAfter: "5 seconds" },
  ).pipe(Effect.mapError(failed("server-spawn")))
  yield* writeJson(RunPids, paths.pids, { supervisorPid, serverPid: Number(handle.pid) }, "pids")
  const ready = yield* Deferred.make<string>()
  const onLine = (line: string) =>
    Effect.gen(function* () {
      if (!line.startsWith(READY_PREFIX)) return
      yield* Deferred.succeed(ready, `${line.slice(READY_PREFIX.length).trim()}/rpc`)
    })
  yield* Effect.forkScoped(teeServerOutput(handle.stdout, paths.serverLog, onLine))
  yield* Effect.forkScoped(teeServerOutput(handle.stderr, paths.serverLog, () => Effect.void))
  const url = yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "90 seconds",
      orElse: () =>
        Effect.fail(
          new VerifyFailed({
            step: "server-ready",
            message: `no ready line; see ${paths.serverLog}`,
          }),
        ),
    }),
  )
  const run: VerifyRun = {
    dir: paths.dir,
    work: paths.work,
    gent: paths.gent,
    checkout: root,
    build: yield* checkoutBuild(root),
    supervisorPid,
    serverPid: Number(handle.pid),
    url,
    env,
  }
  yield* writeJson(VerifyRun, paths.record, run, "record")
  // The server's exit ends the supervisor: a run without its server is over.
  yield* handle.exitCode.pipe(Effect.ignore)
})

// ── launch ──────────────────────────────────────────────────────────────────

/** The live server the run's data directory names, confirmed by its identity. */
const liveServer = (run: VerifyRun) =>
  Effect.gen(function* () {
    const status = yield* serverLock.status(run.env["HOME"] ?? run.dir)
    if (status._tag !== "Alive") return Option.none()
    if (!(yield* serverLock.probe(status.entry))) return Option.none()
    return Option.some(status.entry)
  }).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: run.env })),
    Effect.orElseSucceed(() => Option.none()),
  )

const Launched = Schema.Struct({
  _tag: Schema.tag("Launched"),
  dir: Schema.String,
  work: Schema.String,
  gent: Schema.String,
  url: Schema.String,
  build: Schema.String,
  supervisorPid: Schema.Int,
  serverPid: Schema.Int,
  ms: Schema.Finite,
})

/**
 * Seed the run, start the supervisor, and answer once its server does. The
 * supervisor is this call's child until then: an interrupt (SIGINT, SIGTERM)
 * or a failure closes the scope, which stops its process group and so its
 * server. Only a server that answers is handed off, the supervisor detached
 * from this call.
 */
const launch = Effect.fn("Verify.launch")(function* (
  dir: string,
  port: number,
  seconds: number,
  data: Option.Option<string>,
) {
  const paths = yield* scratchDir(dir)
  const source = yield* Option.match(data, {
    onNone: () => Effect.succeedNone,
    onSome: (file) => dataSource(paths, file).pipe(Effect.asSome),
  })
  yield* seed(paths)
  // A fixture of server state, read as the server starts: a copy, so the run never writes the original.
  if (Option.isSome(source)) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs
      .copyFile(source.value, path.join(paths.data, path.basename(source.value)))
      .pipe(Effect.mapError(failed("data")))
  }
  const platform = yield* GentPlatform
  const started = yield* Clock.currentTimeMillis
  const here = yield* Effect.flatMap(Path.Path, (path) =>
    path.fromFileUrl(new URL(import.meta.url)),
  ).pipe(Effect.mapError(failed("launch")))
  const supervisor = yield* ChildProcess.make(
    yield* platform.execPath,
    [here, "serve", "--dir", paths.dir, "--port", String(port)],
    {
      cwd: paths.dir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      // Longer than the supervisor's own grace for its server, so a SIGTERM stops both.
      forceKillAfter: "15 seconds",
    },
  ).pipe(Effect.mapError(failed("supervisor-spawn")))
  // The supervisor writes the whole receipt once its server spawns; that receipt is newer.
  yield* writeJson(RunPids, paths.pids, { supervisorPid: Number(supervisor.pid) }, "pids", "wx")
  const answered = readRun(paths).pipe(
    Effect.flatMap((run) =>
      Effect.flatMap(liveServer(run), (entry) =>
        Option.match(entry, {
          onNone: () =>
            Effect.fail(new VerifyFailed({ step: "server-ready", message: "not answering yet" })),
          onSome: () => Effect.succeed(run),
        }),
      ),
    ),
    // The deadline below bounds the wait; the count only keeps the retry finite.
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: seconds * 4 }),
  )
  const supervisorEnded = supervisor.exitCode.pipe(
    Effect.orElseSucceed(() => -1),
    Effect.flatMap((code) =>
      Effect.flatMap(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(paths.serveLog)).pipe(
          Effect.orElseSucceed(() => ""),
        ),
        (log) =>
          Effect.fail(
            new VerifyFailed({
              step: "supervisor",
              message: `the supervisor exited ${code} before its server answered: ${log.trim().split("\n").at(-1) ?? ""}`,
            }),
          ),
      ),
    ),
  )
  const run = yield* Effect.raceFirst(answered, supervisorEnded).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(seconds),
      orElse: () =>
        Effect.fail(
          new VerifyFailed({
            step: "server-ready",
            message: `no server within ${seconds} s; the supervisor (PID ${supervisor.pid}) is stopped as launch exits; see ${paths.serveLog} and ${paths.serverLog}`,
          }),
        ),
    }),
  )
  // The hand-off: the supervisor outlives this call from here on.
  yield* supervisor.unref.pipe(Effect.asVoid, Effect.mapError(failed("supervisor-handoff")))
  const ended = yield* Clock.currentTimeMillis
  return Launched.make({
    dir: run.dir,
    work: run.work,
    gent: run.gent,
    url: run.url,
    build: run.build,
    supervisorPid: run.supervisorPid,
    serverPid: run.serverPid,
    ms: ended - started,
  })
})

// ── doctor ──────────────────────────────────────────────────────────────────

const Healthy = Schema.Struct({
  _tag: Schema.tag("Healthy"),
  dir: Schema.String,
  url: Schema.String,
  checks: Schema.Array(Check),
  /** False when the load average is at or above the core count: timings claim nothing. */
  timingsMeaningful: Schema.Boolean,
})

const ServerLogLine = Schema.Struct({ level: Schema.String, msg: Schema.String })
const decodeLogLine = Schema.decodeUnknownOption(Schema.fromJsonString(ServerLogLine))

/** Error and fatal lines in the run's server logs. */
const serverLogErrors = (run: VerifyRun) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { logDir } = yield* dataPaths(run.env["HOME"] ?? run.dir).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: run.env }),
      ),
    )
    const names = yield* fs.readDirectory(logDir).pipe(Effect.orElseSucceed(() => []))
    const lines = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".log")),
      (name) =>
        fs.readFileString(`${logDir}/${name}`).pipe(
          Effect.map((text) => text.split("\n")),
          Effect.orElseSucceed(() => []),
        ),
    )
    return lines
      .flat()
      .flatMap((line) => Option.toArray(decodeLogLine(line)))
      .filter((line) => line.level === "Error" || line.level === "Fatal")
      .map((line) => line.msg)
  })

/** The load average over one minute and the core count, from the OS. */
const loadAndCores = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const loadText = yield* fs
    .readFileString("/proc/loadavg")
    .pipe(
      Effect.catch(() =>
        outputOf("sysctl", ["-n", "vm.loadavg"], "/").pipe(Effect.map((lines) => lines.join(" "))),
      ),
    )
  const load = Number(loadText.replace(/[{}]/g, " ").trim().split(/\s+/)[0])
  const cores = Number((yield* outputOf("getconf", ["_NPROCESSORS_ONLN"], "/")).join("").trim())
  return { load, cores }
})

/**
 * Read-only checks, in order; the first that fails names the run unfit. The
 * run record parses; its supervisor is alive and is this helper; the data
 * directory's server is the recorded PID and answers its identity; its build
 * is this checkout's HEAD; a client lists sessions; the run touches nothing
 * of the owner's; the server logs hold no errors.
 */
const doctor = Effect.fn("Verify.doctor")(function* (dir: string) {
  const paths = yield* scratchDir(dir)
  const checks: Array<Check> = []
  const pass = (name: string, detail: string) => {
    checks.push({ name, ok: true, detail })
  }
  const fail = (name: string, detail: string) =>
    Effect.gen(function* () {
      checks.push({ name, ok: false, detail })
      return yield* new DoctorFailed({ check: name, detail, checks })
    })

  const record = yield* Effect.result(readRun(paths))
  if (record._tag === "Failure") return yield* fail("record", record.failure.message)
  const run = record.success
  pass("record", paths.record)

  const supervisor = yield* processCommand(run.supervisorPid)
  if (Option.isNone(supervisor))
    return yield* fail("supervisor", `PID ${run.supervisorPid} is not running`)
  if (!supervisor.value.includes("verify.ts serve")) {
    return yield* fail(
      "supervisor",
      `PID ${run.supervisorPid} runs another program: ${supervisor.value}`,
    )
  }
  pass("supervisor", `PID ${run.supervisorPid}`)

  const entry = yield* liveServer(run)
  if (Option.isNone(entry))
    return yield* fail("server", "no live server answers for the run's data directory")
  if (entry.value.pid !== run.serverPid) {
    return yield* fail(
      "server",
      `the lock names PID ${entry.value.pid}, the run recorded ${run.serverPid}`,
    )
  }
  pass("server", `PID ${run.serverPid} at ${entry.value.rpcUrl}`)

  const head = yield* checkoutBuild(run.checkout)
  if (entry.value.buildFingerprint !== head) {
    return yield* fail(
      "build",
      `the server runs ${entry.value.buildFingerprint}, the checkout is at ${head}; stop and launch again`,
    )
  }
  const dirty = yield* outputOf("git", ["status", "--porcelain"], run.checkout)
  const uncommitted = Option.match(
    Option.liftPredicate(dirty.length, (count) => count > 0),
    { onNone: () => "", onSome: (count) => ` with ${count} uncommitted paths` },
  )
  pass("build", `${head}${uncommitted}`)

  const sessions = yield* Effect.scoped(
    Effect.gen(function* () {
      const { client } = yield* Gent.client(entry.value.rpcUrl, { cwd: run.work })
      return yield* client.session.list()
    }),
  ).pipe(Effect.timeout("10 seconds"), Effect.result)
  if (sessions._tag === "Failure") return yield* fail("client", String(sessions.failure))
  pass("client", `${sessions.success.length} sessions`)

  const platform = yield* GentPlatform
  const ownerHome = yield* platform.homeDirectory
  const path = yield* Path.Path
  const isolated = ["HOME", "GENT_DATA_DIR", "GENT_AUTH_DIRECTORY", "XDG_CACHE_HOME"]
  const outside = yield* Effect.filter(isolated, (name) =>
    Option.match(Option.fromUndefinedOr(run.env[name]), {
      onNone: () => Effect.succeed(true),
      onSome: (value) =>
        Effect.map(
          canonical(value),
          (real) => real === paths.dir || !within(path, paths.dir, real),
        ),
    }),
  )
  if (outside.length > 0 || run.env["HOME"] === ownerHome) {
    return yield* fail("scratch", `outside ${paths.dir}: ${outside.join(", ")}`)
  }
  pass("scratch", `home, data, keys and cache under ${paths.dir}`)

  const errors = yield* serverLogErrors(run)
  if (errors.length > 0)
    return yield* fail("log", `${errors.length} error lines; first: ${errors[0]}`)
  pass("log", "no error lines")

  const { load, cores } = yield* loadAndCores.pipe(
    Effect.orElseSucceed(() => ({ load: 0, cores: 0 })),
  )
  pass("load", `load ${load} on ${cores} cores`)
  return Healthy.make({ dir: paths.dir, url: run.url, checks, timingsMeaningful: load < cores })
})

// ── drive ───────────────────────────────────────────────────────────────────

const Recording = Schema.Struct({
  file: Schema.String,
  seconds: Schema.Finite,
  events: Schema.Int,
})

const DrivenSize = Schema.Struct({
  /** `120x40`, or `120x40-60x20` for a sweep's live resize. */
  size: Schema.String,
  /** How many steps ran; each one's line is on stderr. */
  steps: Schema.Int,
  end: DriveEnd,
  /** The files the capture steps saved, in step order, named from `out`. */
  captures: Schema.Array(Schema.String),
  /** The asciicast v2 recording, checked to play; absent with `--no-record`. */
  recording: Schema.optionalKey(Recording),
})

/** A drive that passed: one entry for a plain script, one for each pass of a sweep. */
const Driven = Schema.Struct({
  _tag: Schema.tag("Driven"),
  out: Schema.String,
  passes: Schema.Array(DrivenSize),
})

/**
 * Refuse a script that could reach past the run: a program other than the
 * run's `gent`, a `cwd` outside the run's directory under any name, or an
 * `env` that sets a variable of the run's (`HOME`, `GENT_DATA_DIR`, …) or
 * the drive's own.
 */
const containedScript = Effect.fn("Verify.containedScript")(function* (
  paths: Layout,
  run: VerifyRun,
  script: typeof DriveScript.Type,
  base: string,
) {
  const path = yield* Path.Path
  const refuse = (message: string) => Effect.fail(new VerifyFailed({ step: "script", message }))
  const [program, ...args] = script.command
  const executable = yield* Effect.suspend(() => {
    // `gent` names the run's wrapper, so the script runs this checkout in the run.
    if (program === "gent") return Effect.succeed(run.gent)
    return canonical(path.resolve(base, program)).pipe(
      Effect.flatMap((resolved) => {
        if (resolved === run.gent) return Effect.succeed(run.gent)
        return refuse(`command[0] is ${program}; a drive runs the run's gent: name it \`gent\``)
      }),
    )
  })
  const cwd = yield* Option.match(Option.fromUndefinedOr(script.cwd), {
    onNone: () => Effect.succeed(run.work),
    onSome: (named) => canonical(path.resolve(base, named)),
  })
  if (!within(path, paths.dir, cwd)) {
    return yield* refuse(`cwd ${cwd} is outside the run ${paths.dir}`)
  }
  const protectedNames = new Set([...Object.keys(run.env), ...DRIVE_OWNED])
  const overridden = Object.keys(script.env ?? {}).filter((name) => protectedNames.has(name))
  if (overridden.length > 0) {
    return yield* refuse(`env sets ${overridden.join(", ")}; the run owns them`)
  }
  return { command: [executable, ...args] as const, cwd }
})

/**
 * Run a drive script against the run: the run's wrapper, in the workspace
 * unless the script names a `cwd` inside the run, with the run's environment
 * (its `bin` first on `PATH`, `EVIDENCE` set to the pass's `out`) under the
 * script's `env`. Each step prints one line on stderr, a capture's screen too with
 * `print`; captures and the recording go to `out`, to a directory for each
 * size under it for a sweep. A missed or failed step, an exit the script does
 * not expect, or a recording that does not play fails the drive; a size that
 * passed keeps its last pass all the same.
 */
const drive = Effect.fn("Verify.drive")(function* (options: {
  readonly dir: string
  readonly script: string
  readonly out: string
  readonly print: boolean
  readonly record: boolean
}) {
  const paths = yield* scratchDir(options.dir)
  const run = yield* readRun(paths)
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scriptPath = path.resolve(options.script)
  const script = yield* fs
    .readFileString(scriptPath)
    .pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(DriveScript))),
      Effect.mapError(failed("script")),
    )
  const out = yield* canonical(options.out)
  if (within(path, run.checkout, out)) {
    return yield* new VerifyFailed({
      step: "out",
      message: `${out} is inside the checkout; name an evidence directory outside it`,
    })
  }
  const contained = yield* containedScript(paths, run, script, path.dirname(scriptPath))
  const callerPath = yield* Config.String("PATH").pipe(Effect.orElseSucceed(() => "/usr/bin:/bin"))
  const passes = yield* runDrivePasses(
    {
      ...script,
      command: contained.command,
      cwd: contained.cwd,
      out,
      env: { ...script.env, ...run.env, PATH: `${paths.bin}:${callerPath}` },
    },
    { print: options.print, record: options.record },
  ).pipe(Effect.mapError(failed("drive")))
  // A size that passed is checked and keeps its last pass, even when another failed.
  const driven = yield* Effect.forEach(
    passes.filter((pass) => passProblems([pass]).length === 0),
    (pass) => drivenSize(out, pass),
  )
  const problems = passProblems(passes)
  if (problems.length > 0) return yield* new DriveFailed({ out, problems })
  return Driven.make({ out, passes: driven })
})

/** A pass that passed: its recording checked to play at the pass's size, its captures kept. */
const drivenSize = Effect.fn("Verify.drivenSize")(function* (out: string, pass: DrivenPass) {
  const path = yield* Path.Path
  const { script, outcome } = pass
  const recording = yield* Option.match(outcome.recording, {
    onNone: () => Effect.succeed({}),
    onSome: (file) =>
      checkRecording(file).pipe(
        Effect.mapError((error) => new VerifyFailed({ step: "recording", message: error.message })),
        Effect.flatMap((check) => {
          if (check.width !== script.cols || check.height !== script.rows) {
            return Effect.fail(
              new VerifyFailed({
                step: "recording",
                message: `${file} is ${check.width}x${check.height}; the script drives ${script.cols}x${script.rows}`,
              }),
            )
          }
          return Effect.succeed({
            recording: {
              file: path.relative(out, file),
              seconds: check.seconds,
              events: check.events,
            },
          })
        }),
      ),
  })
  const captures = outcome.steps.flatMap((step) =>
    StepOutcome.match(step, {
      Ok: (ok) => Option.toArray(Option.fromUndefinedOr(ok.file)),
      Miss: () => [],
      Fail: () => [],
    }).map((file) => path.relative(out, file)),
  )
  yield* keepPassed(script.out, outcome)
  return DrivenSize.make({
    size: pass.size,
    steps: outcome.steps.length,
    end: outcome.end,
    captures,
    ...recording,
  })
})

// ── stop ────────────────────────────────────────────────────────────────────

const Stopped = Schema.Struct({
  _tag: Schema.tag("Stopped"),
  dir: Schema.String,
  supervisorPid: Schema.Int,
  serverPid: Schema.optionalKey(Schema.Int),
  removed: Schema.Boolean,
})

/** The recorded PIDs `ps` still shows running the run's command; a failed inspection fails. */
class StillAlive extends Schema.TaggedError<StillAlive, { readonly brand: unique symbol }>()(
  "StillAlive",
  { pids: Schema.Array(Schema.Int) },
) {}

/**
 * Stop the run by its receipt's PIDs, never by a process name: SIGTERM to
 * the supervisor, which stops its server; SIGKILL to either still alive
 * after the grace. A PID that now runs another program is left alone.
 * `remove` then deletes the scratch directory. When `ps` cannot say a PID is
 * gone, or one survives the SIGKILL, the stop fails `StopFailed` and keeps
 * the receipt and the directory.
 */
const stop = Effect.fn("Verify.stop")(function* (dir: string, remove: boolean) {
  const paths = yield* scratchDir(dir)
  const pids = yield* readPids(paths)
  const platform = yield* GentPlatform
  const owned = [
    { pid: pids.supervisorPid, marker: "verify.ts serve" },
    ...Option.toArray(
      Option.map(Option.fromUndefinedOr(pids.serverPid), (pid) => ({
        pid,
        marker: "server start",
      })),
    ),
  ]
  const recorded = owned.map(({ pid }) => pid)
  const unproven = (error: VerifyFailed) =>
    new StopFailed({
      dir: paths.dir,
      message: `cannot tell whether the run stopped: ${error.message}; the receipt stays`,
      alive: recorded,
    })
  const ours = (pid: number, marker: string) =>
    Effect.map(processCommand(pid), (command) =>
      Option.exists(command, (text) => text.includes(marker)),
    )
  const alive = Effect.filter(owned, ({ pid, marker }) => ours(pid, marker)).pipe(
    Effect.map((left) => left.map(({ pid }) => pid)),
    Effect.mapError(unproven),
  )
  const gone = (times: number) =>
    alive.pipe(
      Effect.flatMap((left) => {
        if (left.length === 0) return Effect.void
        return Effect.fail(new StillAlive({ pids: left }))
      }),
      Effect.retry({
        schedule: Schedule.spaced("200 millis"),
        times,
        while: (error) => error._tag === "StillAlive",
      }),
    )
  if (yield* ours(pids.supervisorPid, "verify.ts serve").pipe(Effect.mapError(unproven))) {
    yield* platform.signal(pids.supervisorPid, "SIGTERM").pipe(Effect.ignore)
  }
  yield* gone(50).pipe(
    Effect.catchTag("StillAlive", ({ pids: left }) =>
      Effect.forEach(left, (pid) => platform.signal(pid, "SIGKILL").pipe(Effect.ignore)).pipe(
        Effect.andThen(gone(10)),
      ),
    ),
    Effect.catchTag("StillAlive", ({ pids: left }) =>
      Effect.fail(
        new StopFailed({
          dir: paths.dir,
          message: `PIDs ${left.join(", ")} survived SIGKILL; the receipt stays`,
          alive: left,
        }),
      ),
    ),
  )
  if (remove) {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(paths.dir, { recursive: true }).pipe(Effect.mapError(failed("remove")))
  }
  return Stopped.make({
    dir: paths.dir,
    supervisorPid: pids.supervisorPid,
    ...Option.match(Option.fromUndefinedOr(pids.serverPid), {
      onNone: () => ({}),
      onSome: (serverPid) => ({ serverPid }),
    }),
    removed: remove,
  })
})

// ── commands ────────────────────────────────────────────────────────────────

const dirFlag = Flag.String("dir").pipe(
  Flag.withDescription("The run's scratch directory, outside every checkout; one per run"),
)
const portFlag = Flag.Int("port").pipe(
  Flag.withDescription("The server's TCP port on 127.0.0.1 (0: a free one)"),
  Flag.withDefault(0),
)

/** Run `body` and print its result; `runVerifyCli` reports its failure. */
const command = <A, I, R>(schema: Schema.Codec<A, I>, body: Effect.Effect<A, VerifyError, R>) =>
  body.pipe(Effect.flatMap((value) => printJson(schema, value)))

const launchCommand = Command.make(
  "launch",
  {
    dir: dirFlag,
    port: portFlag,
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription("Seconds to wait for the server to answer"),
      Flag.withDefault(90),
    ),
    data: Flag.String("data").pipe(
      Flag.withDescription(
        "A fixture from the run, its sibling evidence directory, or repository tests/fixtures, copied into the run data directory",
      ),
      Flag.optional,
    ),
  },
  ({ dir, port, timeout, data }) =>
    Effect.scoped(command(Launched, launch(dir, port, timeout, data))),
).pipe(Command.withDescription("Seed a scratch run, start its server, print it once it answers"))

const serveCommand = Command.make("serve", { dir: dirFlag, port: portFlag }, ({ dir, port }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const paths = yield* scratchDir(dir)
      yield* serve(paths, port).pipe(
        Effect.catch((error) =>
          Effect.flatMap(FileSystem.FileSystem, (fs) =>
            Schema.encodeEffect(Schema.fromJsonString(VerifyError))(error).pipe(
              Effect.flatMap((text) =>
                fs.writeFileString(paths.serveLog, `${text}\n`, { flag: "a" }),
              ),
              Effect.ignore,
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        ),
      )
    }),
  ),
).pipe(Command.withDescription("The supervisor launch starts; not for direct use"))

const doctorCommand = Command.make("doctor", { dir: dirFlag }, ({ dir }) =>
  command(Healthy, doctor(dir)),
).pipe(
  Command.withDescription("Read-only: is this run worth driving? Names the first failed check"),
)

const driveCommand = Command.make(
  "drive",
  {
    dir: dirFlag,
    script: Flag.String("script").pipe(Flag.withDescription("A drive script (JSON, DriveScript)")),
    out: Flag.String("out").pipe(
      Flag.withDescription(
        "The evidence directory, outside every checkout; replaces the script's `out`",
      ),
    ),
    print: Flag.Boolean("print").pipe(
      Flag.withDescription("Print each capture's screen on stderr after its step line"),
      Flag.withDefault(false),
    ),
    noRecord: Flag.Boolean("no-record").pipe(
      Flag.withDescription("Do not record the drive as <out>/drive.cast"),
      Flag.withDefault(false),
    ),
  },
  ({ dir, script, out, print, noRecord }) =>
    command(Driven, drive({ dir, script, out, print, record: !noRecord })),
).pipe(
  Command.withDescription(
    "Run a drive script on the run's TUI; fail on a missed step, a failed step or an unexpected exit",
  ),
)

const stopCommand = Command.make(
  "stop",
  {
    dir: dirFlag,
    remove: Flag.Boolean("remove").pipe(
      Flag.withDescription("Delete the scratch directory once no process of the run is alive"),
      Flag.withDefault(false),
    ),
  },
  ({ dir, remove }) => command(Stopped, stop(dir, remove)),
).pipe(Command.withDescription("Stop the run by its recorded PIDs"))

const verify = Command.make("verify", {}, () =>
  writeLine("stderr", "Usage: verify <launch|doctor|drive|stop> --help"),
).pipe(
  Command.withDescription("A scratch gent on the scripted model, for a verifier to drive"),
  Command.withSubcommands([launchCommand, serveCommand, doctorCommand, driveCommand, stopCommand]),
)

// ── the process boundary ────────────────────────────────────────────────────

/** The parser's refusal as one usage error; `None` for a help request. */
const usageOf = (error: CliError.CliError): Option.Option<VerifyUsage> => {
  if (error._tag !== "ShowHelp") return Option.some(new VerifyUsage({ message: error.message }))
  if (error.errors.length === 0) return Option.none()
  return Option.some(
    new VerifyUsage({ message: error.errors.map((each) => each.message).join("; ") }),
  )
}

/** The `--dir` the arguments name, where a defect's cause is kept. */
const dirArgument = (args: ReadonlyArray<string>) =>
  Option.fromUndefinedOr(args[args.indexOf("--dir") + 1]).pipe(
    Option.filter(() => args.includes("--dir")),
  )

/** Append a defect's whole cause to the run's `verify.log`; the path, or why there is none. */
const keepCause = (args: ReadonlyArray<string>, cause: Cause.Cause<unknown>) =>
  Option.match(dirArgument(args), {
    onNone: () => Effect.succeed("no --dir names a log"),
    onSome: (dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const file = layout(path.resolve(dir)).verifyLog
        const at = DateTime.formatIso(yield* DateTime.now)
        yield* fs.writeFileString(
          file,
          `${at} verify ${args.join(" ")}\n${Cause.pretty(cause)}\n`,
          { flag: "a" },
        )
        return `the cause is in ${file}`
      }).pipe(Effect.orElseSucceed(() => "the log could not be written")),
  })

/**
 * `verify <args>`, the boundary every command crosses: a result prints on
 * stdout and the parser's help as it is; any failure prints one tagged JSON
 * line on stderr. A command's own error keeps its tag; a flag the parser
 * refuses is `VerifyUsage` (exit 2); a defect is `VerifyFailed` (step
 * `defect`, exit 1), its whole cause kept in the run's `verify.log`. An
 * interrupt stays an interrupt.
 */
export const runVerifyCli = Effect.fn("Verify.cli")(function* (args: ReadonlyArray<string>) {
  const console = yield* Console.Console
  // The parser writes help through `Console.log`; it prints only when the call succeeds.
  const help: Array<string> = []
  const exit = yield* Command.runWith(verify, { version: "0.0.0", renderErrors: false })(args).pipe(
    Effect.provideService(Console.Console, {
      ...console,
      log: (...line: ReadonlyArray<unknown>) => {
        help.push(line.map(String).join(" "))
      },
    }),
    Effect.exit,
  )
  const printHelp = Effect.sync(() => {
    for (const line of help) console.log(line)
  })
  if (Exit.isSuccess(exit)) return yield* printHelp
  if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isNone(failure)) {
    const [first = "unknown defect"] = Cause.pretty(exit.cause).split("\n")
    const kept = yield* keepCause(args, exit.cause)
    return yield* reportError(new VerifyFailed({ step: "defect", message: `${first}; ${kept}` }))
  }
  const error = failure.value
  if (Schema.is(VerifyError)(error)) return yield* reportError(error)
  if (!CliError.isCliError(error)) {
    return yield* reportError(failed("platform")(error))
  }
  const usage = usageOf(error)
  if (Option.isNone(usage)) return yield* printHelp
  return yield* reportError(usage.value)
})

if (import.meta.main) {
  const main = Stdio.Stdio.use(({ args }) => Effect.flatMap(args, runVerifyCli))
  // @effect-diagnostics-next-line strictEffectProvide:off -- the script's process entry provides the platform once.
  BunRuntime.runMain(main.pipe(Effect.provide(BunPlatformLive)))
}
