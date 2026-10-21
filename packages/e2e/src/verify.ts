/**
 * The verify-gent helpers: a scratch gent a verifier launches, checks, drives
 * and stops, on the scripted model, with nothing of the owner's.
 *
 *   bun run verify:launch --dir <scratch>     seed, start, print the run once usable
 *   bun run verify:doctor --dir <scratch>     read-only: is this run worth driving?
 *   bun run verify:drive --dir <scratch> --script <file> --out <evidence>
 *   bun run verify:stop --dir <scratch> [--remove]
 *
 * `launch` seeds the scratch directory (a home, a data directory, fake keys, a
 * workspace), then starts `serve` detached: the supervisor that serves the
 * model catalog fixture and owns `gent server start --mock` as its child, so
 * stopping the supervisor by its recorded PID stops the server too. Every
 * gent the run starts goes through `<scratch>/bin/gent`, a wrapper that runs
 * this checkout's source with the run's environment and no other.
 *
 * `.claude/skills/verify-gent/SKILL.md` is the reader's guide. Each command
 * prints one JSON value on stdout; a failure prints one tagged JSON line on
 * stderr and exits 1.
 */
import { BunRuntime } from "@effect/platform-bun"
import { GentPlatform } from "@gent/core/host"
import { BunPlatformLive } from "@gent/core/host-bun"
import { seedAuthKeys, serveModelCatalogFixture, TEST_MODEL_ID } from "@gent/core/test-utils"
import { Gent, serverLock, dataPaths } from "@gent/sdk"
import {
  Clock,
  Config,
  ConfigProvider,
  Console,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Option,
  Order,
  Path,
  Runtime,
  Schedule,
  Schema,
  Stdio,
  Stream,
} from "effect"
import { Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { DriveScript, runDriveScript } from "./pty-fixture"

// ── errors and output ───────────────────────────────────────────────────────

/** A helper step that failed; `step` names it. */
class VerifyFailed extends Schema.TaggedError<VerifyFailed, { readonly brand: unique symbol }>()(
  "VerifyFailed",
  { step: Schema.String, message: Schema.String },
) {
  override readonly [Runtime.errorReported] = false
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
 * A drive that ran to its end with a step that failed: `misses`, the
 * `waitFor` patterns that never showed; `shells`, the `sh` steps that exited
 * non-zero or timed out.
 */
class DriveMissed extends Schema.TaggedError<DriveMissed, { readonly brand: unique symbol }>()(
  "DriveMissed",
  { out: Schema.String, misses: Schema.Array(Schema.String), shells: Schema.Array(Schema.String) },
) {
  override readonly [Runtime.errorReported] = false
}

const VerifyError = Schema.Union([VerifyFailed, DoctorFailed, DriveMissed])
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

// ── the run's layout and record ─────────────────────────────────────────────

/** Where a run keeps each part, under its scratch directory. */
const layout = (dir: string) => ({
  dir,
  home: `${dir}/home`,
  data: `${dir}/data`,
  auth: `${dir}/auth`,
  gh: `${dir}/gh`,
  work: `${dir}/work`,
  bin: `${dir}/bin`,
  gent: `${dir}/bin/gent`,
  record: `${dir}/run.json`,
  serveLog: `${dir}/serve.log`,
  serverLog: `${dir}/server.log`,
})
type Layout = ReturnType<typeof layout>

/** What `serve` records once its server answers; every other command reads it. */
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

const readRun = (paths: Layout) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(paths.record)
    return yield* Schema.decodeEffect(Schema.fromJsonString(VerifyRun))(text)
  }).pipe(Effect.mapError(failed("read-run")))

/** This checkout, from this file's place in it. */
const checkoutRoot = Effect.gen(function* () {
  const path = yield* Path.Path
  const here = yield* path.fromFileUrl(new URL(import.meta.url))
  return path.resolve(here, "../../../..")
}).pipe(Effect.mapError(failed("checkout")))

/** The scratch directory, absolute; never inside the checkout. */
const scratchDir = (dir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const root = yield* checkoutRoot
    const absolute = path.resolve(dir)
    if (!path.relative(root, absolute).startsWith("..")) {
      return yield* new VerifyFailed({
        step: "dir",
        message: `${absolute} is inside the checkout ${root}; name a scratch directory outside it`,
      })
    }
    return layout(absolute)
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

/** Whether `pid` is a live process, and the command line it runs. */
const processCommand = (pid: number) =>
  outputOf("ps", ["-o", "command=", "-p", String(pid)], "/").pipe(
    Effect.map((lines) => Option.fromUndefinedOr(lines.find((line) => line.trim().length > 0))),
    Effect.orElseSucceed(() => Option.none<string>()),
  )

// ── seed and wrapper ────────────────────────────────────────────────────────

/** Quote `text` for a POSIX shell. */
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * The environment of every gent of the run: the scratch home, data directory
 * and keys, the catalog fixture, and a signed-out `gh`. Nothing else of the
 * caller's environment reaches it but `PATH`, `TERM` and the locale.
 */
const runEnv = (paths: Layout, catalog: string, root: string) => ({
  HOME: paths.home,
  GENT_DATA_DIR: paths.data,
  GENT_AUTH_DIRECTORY: paths.auth,
  GENT_MODEL_CATALOG_URL: catalog,
  GH_CONFIG_DIR: paths.gh,
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  COLORTERM: "truecolor",
  LANG: "C.UTF-8",
  // The source run's JSX transform cache: content-addressed, in the
  // checkout's ignored node_modules, so a start after the first is warm.
  XDG_CACHE_HOME: `${root}/node_modules/.cache/gent-verify`,
})

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

/** A fresh scratch run: home, data, keys, workspace. Refuses a directory with files in it. */
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
    const dirs = [`${paths.home}/.gent`, paths.data, paths.auth, paths.gh, paths.work, paths.bin]
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
 * `gent server start --mock` as a child of this scope, record the run once the
 * server prints its ready line, then hold until a signal ends the scope.
 */
const serve = Effect.fn("Verify.serve")(function* (paths: Layout, port: number) {
  const fs = yield* FileSystem.FileSystem
  const platform = yield* GentPlatform
  const root = yield* checkoutRoot
  const catalog = yield* serveModelCatalogFixture
  const env = runEnv(paths, catalog, root)
  yield* fs
    .writeFileString(paths.gent, wrapperText(root, yield* platform.execPath, env))
    .pipe(Effect.andThen(fs.chmod(paths.gent, 0o755)), Effect.mapError(failed("wrapper")))
  const handle = yield* ChildProcess.make(
    paths.gent,
    ["server", "start", "--mock", "--port", String(port)],
    { cwd: paths.work, stdout: "pipe", stderr: "pipe", forceKillAfter: "5 seconds" },
  ).pipe(Effect.mapError(failed("server-spawn")))
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
    supervisorPid: yield* platform.pid,
    serverPid: Number(handle.pid),
    url,
    env,
  }
  yield* Schema.encodeEffect(Schema.fromJsonString(VerifyRun))(run).pipe(
    Effect.flatMap((text) => fs.writeFileString(paths.record, `${text}\n`)),
    Effect.mapError(failed("record")),
  )
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

/** Seed the run, start the supervisor detached, and answer once its server does. */
const launch = Effect.fn("Verify.launch")(function* (dir: string, port: number, seconds: number) {
  const paths = yield* scratchDir(dir)
  yield* seed(paths)
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
      forceKillAfter: "5 seconds",
    },
  ).pipe(Effect.mapError(failed("supervisor-spawn")))
  // The supervisor outlives this call: its scope no longer stops it.
  yield* supervisor.unref.pipe(Effect.asVoid, Effect.mapError(failed("supervisor-spawn")))
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
        supervisor.kill().pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.fail(
              new VerifyFailed({
                step: "server-ready",
                message: `no server within ${seconds} s; the supervisor (PID ${supervisor.pid}) was stopped; see ${paths.serveLog} and ${paths.serverLog}`,
              }),
            ),
          ),
        ),
    }),
  )
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
  const outside = ["HOME", "GENT_DATA_DIR", "GENT_AUTH_DIRECTORY"].filter(
    (name) => !(run.env[name] ?? "").startsWith(`${paths.dir}/`),
  )
  if (outside.length > 0 || run.env["HOME"] === ownerHome) {
    return yield* fail("scratch", `outside ${paths.dir}: ${outside.join(", ")}`)
  }
  pass("scratch", `home, data and keys under ${paths.dir}`)

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

const Driven = Schema.Struct({
  _tag: Schema.tag("Driven"),
  out: Schema.String,
  exit: Schema.optionalKey(Schema.Int),
  captures: Schema.Array(Schema.String),
  hits: Schema.Int,
})

const MISS = /^waitFor (.*): TIMEOUT \d+ms$/
const HIT = /^waitFor .*: hit \d+ms$/
const SHELL_FAILED = /^sh: (.*) -> exit (?!0$)(\S+)$/

/**
 * Run a drive script against the run. `command: ["gent", …]` runs the run's
 * wrapper; the workspace is the default `cwd`; `out` is the evidence
 * directory the caller names; the run's environment, with its `bin` first on
 * `PATH` and `EVIDENCE` set to `out`, is laid under the script's own `env`.
 * Captures print on stderr; a `waitFor` that missed or an `sh` step that
 * exited non-zero fails the drive.
 */
const drive = Effect.fn("Verify.drive")(function* (
  dir: string,
  scriptFile: string,
  outDir: string,
) {
  const paths = yield* scratchDir(dir)
  const run = yield* readRun(paths)
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scriptPath = path.resolve(scriptFile)
  const script = yield* fs
    .readFileString(scriptPath)
    .pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(DriveScript))),
      Effect.mapError(failed("script")),
    )
  const base = path.dirname(scriptPath)
  const out = path.resolve(outDir)
  if (!path.relative(run.checkout, out).startsWith("..")) {
    return yield* new VerifyFailed({
      step: "out",
      message: `${out} is inside the checkout; name an evidence directory outside it`,
    })
  }
  const callerPath = yield* Config.String("PATH").pipe(Effect.orElseSucceed(() => "/usr/bin:/bin"))
  const [program, ...args] = script.command
  // `gent` names the run's wrapper, so the script runs this checkout in the run.
  const executable = Option.match(
    Option.liftPredicate(program, (name) => name === "gent"),
    { onNone: () => program, onSome: () => run.gent },
  )
  const command: readonly [string, ...Array<string>] = [executable, ...args]
  const logged: Array<string> = []
  const console = yield* Console.Console
  const code = yield* runDriveScript({
    ...script,
    command,
    cwd: Option.match(Option.fromUndefinedOr(script.cwd), {
      onNone: () => run.work,
      onSome: (cwd) => path.resolve(base, cwd),
    }),
    out,
    env: { ...run.env, PATH: `${paths.bin}:${callerPath}`, EVIDENCE: out, ...script.env },
  }).pipe(
    Effect.provideService(Console.Console, {
      ...console,
      log: (...line: ReadonlyArray<unknown>) => {
        logged.push(line.map(String).join(" "))
        console.error(...line)
      },
    }),
    Effect.mapError(failed("drive")),
  )
  const misses = logged.flatMap((line) =>
    Option.toArray(Option.fromNullishOr(line.match(MISS)?.[1])),
  )
  const shells = logged.filter((line) => SHELL_FAILED.test(line))
  if (misses.length > 0 || shells.length > 0) {
    return yield* new DriveMissed({ out, misses, shells })
  }
  const captures = (yield* fs.readDirectory(out).pipe(Effect.orElseSucceed(() => []))).toSorted(
    Order.String,
  )
  const result = {
    out,
    captures,
    hits: logged.filter((line) => HIT.test(line)).length,
  }
  return Option.match(code, {
    onNone: () => Driven.make(result),
    onSome: (exit) => Driven.make({ ...result, exit }),
  })
})

// ── stop ────────────────────────────────────────────────────────────────────

const Stopped = Schema.Struct({
  _tag: Schema.tag("Stopped"),
  dir: Schema.String,
  supervisorPid: Schema.Int,
  serverPid: Schema.Int,
  /** PIDs of the run still alive after the stop: empty when it worked. */
  alive: Schema.Array(Schema.Int),
  removed: Schema.Boolean,
})

/**
 * Stop the run by its recorded PIDs, never by a process name: SIGTERM to the
 * supervisor, which stops its server; SIGKILL to either still alive after the
 * grace. A PID that now runs another program is left alone. `remove` then
 * deletes the scratch directory.
 */
const stop = Effect.fn("Verify.stop")(function* (dir: string, remove: boolean) {
  const paths = yield* scratchDir(dir)
  const run = yield* readRun(paths)
  const platform = yield* GentPlatform
  const ours = (pid: number, marker: string) =>
    Effect.map(processCommand(pid), (command) =>
      Option.exists(command, (text) => text.includes(marker)),
    )
  const owned = [
    { pid: run.supervisorPid, marker: "verify.ts serve" },
    { pid: run.serverPid, marker: "server start" },
  ]
  const aliveOf = Effect.filter(owned, ({ pid, marker }) => ours(pid, marker)).pipe(
    Effect.map((left) => left.map(({ pid }) => pid)),
  )
  if (yield* ours(run.supervisorPid, "verify.ts serve")) {
    yield* platform.signal(run.supervisorPid, "SIGTERM").pipe(Effect.ignore)
  }
  const gone = aliveOf.pipe(
    Effect.filterOrFail(
      (left) => left.length === 0,
      (left) => left,
    ),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 50 }),
  )
  const left = yield* gone.pipe(
    Effect.as<ReadonlyArray<number>>([]),
    Effect.catch((pids) =>
      Effect.forEach(pids, (pid) => platform.signal(pid, "SIGKILL").pipe(Effect.ignore)).pipe(
        Effect.andThen(Effect.sleep("500 millis")),
        Effect.andThen(aliveOf),
      ),
    ),
  )
  let removed = false
  if (remove && left.length === 0) {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(paths.dir, { recursive: true }).pipe(Effect.mapError(failed("remove")))
    removed = true
  }
  return Stopped.make({
    dir: paths.dir,
    supervisorPid: run.supervisorPid,
    serverPid: run.serverPid,
    alive: left,
    removed,
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

/** Run `body`, print its result, and report a failure as one JSON line with exit 1. */
const command = <A, I, R>(schema: Schema.Codec<A, I>, body: Effect.Effect<A, VerifyError, R>) =>
  body.pipe(
    Effect.flatMap((value) => printJson(schema, value)),
    Effect.catch(reportError),
  )

const launchCommand = Command.make(
  "launch",
  {
    dir: dirFlag,
    port: portFlag,
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription("Seconds to wait for the server to answer"),
      Flag.withDefault(90),
    ),
  },
  ({ dir, port, timeout }) => Effect.scoped(command(Launched, launch(dir, port, timeout))),
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
  },
  ({ dir, script, out }) => command(Driven, drive(dir, script, out)),
).pipe(Command.withDescription("Run a drive script on the run's TUI; fail when a waitFor missed"))

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

BunRuntime.runMain(
  // @effect-diagnostics-next-line strictEffectProvide:off -- the script's process entry provides the platform once.
  Command.run(verify, { version: "0.0.0" }).pipe(Effect.provide(BunPlatformLive)),
)
