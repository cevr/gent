import { it, describe, expect } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Schedule, Schema } from "effect"
import { createWorkerEnv, seedAuthKeys, serveModelCatalogFixture } from "@gent/core/test-utils"
const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "gent-headless-exit-" })
})
const waitForExit = (proc: Bun.Subprocess, timeoutMs: number) => {
  // oxlint-disable-next-line effect/noFixedWaitInTests -- Real-clock timeout fence that kills a wedged subprocess; the subprocess runs outside TestClock.
  const timeout = Effect.sleep(timeoutMs).pipe(
    Effect.tap(() => Effect.sync(() => proc.kill())),
    Effect.as(-1),
  )
  return Effect.race(
    Effect.promise(() => proc.exited),
    timeout,
  )
}
/**
 * The child's environment: the host's without colour flags and keys, the
 * worker directories, and the fixture catalog served on a loopback port for
 * the test's scope, so the child reads the catalog with no network.
 */
const makeChildEnv = (homeDir: string, env: ReturnType<typeof createWorkerEnv>) =>
  Effect.gen(function* () {
    // eslint-disable-next-line effect/noGlobals -- child process env must inherit the host environment.
    const childEnv = { ...Bun.env }
    delete childEnv["FORCE_COLOR"]
    delete childEnv["NO_COLOR"]
    // A key in the host's environment would satisfy the startup key check.
    for (const name of Object.keys(childEnv)) {
      if (name.endsWith("_API_KEY")) delete childEnv[name]
    }
    return {
      ...childEnv,
      HOME: homeDir,
      ...env,
      GENT_MODEL_CATALOG_URL: yield* serveModelCatalogFixture,
    }
  })
/**
 * Run `gent --debug <args>` in a fresh home with stored keys and collect its
 * exit and output. `keyless` runs without `--debug` and without keys.
 */
const runGent = (args: ReadonlyArray<string>, options: { readonly keyless?: boolean } = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const appDir = path.resolve(yield* path.fromFileUrl(new URL("..", import.meta.url)))
    const homeDir = yield* makeTempDir
    const env = createWorkerEnv(homeDir)
    const mode: Array<string> = []
    if (options.keyless !== true) {
      yield* seedAuthKeys(env["GENT_AUTH_DIRECTORY"]!)
      mode.push("--debug")
    }
    // eslint-disable-next-line effect/noGlobals -- subprocess execution is the integration boundary under test.
    const proc = Bun.spawn(["bun", "src/main.tsx", ...mode, ...args], {
      cwd: appDir,
      env: yield* makeChildEnv(homeDir, env),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        waitForExit(proc, 15000),
        Effect.promise(() => new Response(proc.stdout).text()),
        Effect.promise(() => new Response(proc.stderr).text()),
      ],
      { concurrency: "unbounded" },
    )
    return { exitCode, stdout, stderr }
  })
const runHeadless = (args: ReadonlyArray<string>) => runGent(["-H", ...args])

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
)

describe("headless CLI", () => {
  it.scopedLive(
    "exits after a successful headless turn",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runHeadless(["Say hi in 3 words"])
        expect(stderr).toBe("")
        expect(exitCode).toBe(0)
        expect(stdout).toContain("Latest user message: Say hi in 3 words")
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )

  // The debug model answers this prompt with two rate limits first
  // (`retryBudgetFor` in core's provider.ts); the turn retries past them.
  it.scopedLive(
    "a turn the debug model rate-limits answers after the retry",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runHeadless(["Say hi in 4 words"])
        expect(stderr).toBe("")
        expect(exitCode).toBe(0)
        expect(stdout).toContain("Latest user message: Say hi in 4 words")
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )

  it.scopedLive(
    "an unknown --agent fails before any turn runs",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runHeadless([
          "--agent",
          "revieww",
          "Say hi in 3 words",
        ])
        expect(exitCode).toBe(1)
        // A startup failure is reported on stderr; stdout stays the session's output.
        expect(stderr).toBe("NotFoundError: Unknown agent: revieww\n")
        expect(stdout).not.toContain("Unknown agent")
        expect(stdout).not.toContain("Latest user message")
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )

  // Headless-only input without -H is refused, not dropped. The positional
  // prompt is headless input, as --help says; the TUI takes its startup
  // prompt from -p. One table, three spawns run at once.
  it.scopedLive(
    "headless-only input without -H is refused, not dropped",
    () =>
      Effect.gen(function* () {
        const refused = yield* Effect.all(
          [runGent(["--agent", "main"]), runGent(["fix the tests"]), runGent(["--approve-all"])],
          { concurrency: "unbounded" },
        )
        expect(refused.map(({ exitCode }) => exitCode)).toEqual([1, 1, 1])
        expect(refused.map(({ stderr }) => stderr)).toEqual([
          "CliStartupError: --agent applies to headless mode; add -H with a prompt\n",
          "CliStartupError: a prompt argument needs -H; use -p to start the TUI with a prompt\n",
          "CliStartupError: --approve-all applies to headless mode; add -H with a prompt\n",
        ])
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )

  it.scopedLive(
    "an unanswered turn exits 1 with one line on stderr",
    () =>
      Effect.gen(function* () {
        const { exitCode, stderr } = yield* runHeadless(["--mock-empty", "Say hi in 3 words"])
        expect(exitCode).toBe(1)
        expect(stderr).toBe("HeadlessUnansweredError: the turn ended without an answer\n")
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )

  // The scripted model needs no sign-in: a keyless run reaches its turn.
  it.scopedLive(
    "a --mock-empty run needs no sign-in",
    () =>
      Effect.gen(function* () {
        const { exitCode, stderr } = yield* runGent(["-H", "--mock-empty", "Say hi in 3 words"], {
          keyless: true,
        })
        expect(stderr).toBe("HeadlessUnansweredError: the turn ended without an answer\n")
        expect(exitCode).toBe(1)
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )

  // The release sets the version once, in apps/tui/package.json.
  it.scopedLive(
    "--version prints the version apps/tui/package.json names",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const manifest = path.resolve(
          yield* path.fromFileUrl(new URL("../package.json", import.meta.url)),
        )
        const { version } = decodeManifest(yield* fs.readFileString(manifest))
        const { exitCode, stdout } = yield* runGent(["--version"])
        expect({ exitCode, stdout: stdout.trim() }).toEqual({
          exitCode: 0,
          stdout: `gent v${version}`,
        })
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )

  it.scopedLive(
    "--help names --approve-all",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout } = yield* runGent(["--help"])
        expect(exitCode).toBe(0)
        expect(stdout).toContain("--approve-all")
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )

  it.scopedLive(
    "missing sign-ins are one line on stderr, by provider name",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runGent(["-H", "Say hi in 3 words"], {
          keyless: true,
        })
        expect(exitCode).toBe(1)
        expect(stderr).toBe("CliStartupError: missing required sign-ins: Anthropic\n")
        expect(stdout).toBe("")
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )

  it.scopedLive(
    "a session id that does not exist is one line on stderr",
    () =>
      Effect.gen(function* () {
        const { exitCode, stderr } = yield* runHeadless(["-s", "missing-session", "hi"])
        expect(exitCode).toBe(1)
        expect(stderr).toBe("AppBootstrapError: Session missing-session not found\n")
      }).pipe(Effect.provide(BunServices.layer)),
    20000,
  )
})

// ── compiled binary ─────────────────────────────────────────────────────────

/**
 * A user extension outside the repository, run by the compiled binary. It
 * imports the authoring entry and the `effect` peers the shipped extensions
 * import; the binary has no node_modules, so each resolves only because a
 * loader binds it.
 */
const PEERS_PROBE = `
import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api"
import * as OpenAi from "@effect/ai-openai"
import * as PlatformBun from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import * as Sql from "effect/sql"

export default defineExtension({
  id: "@user/peers-probe",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    const loaded = [OpenAi, PlatformBun, Sql].every((entry) => Object.keys(entry).length > 0)
    yield* host.register(
      "tool",
      tool({
        id: "peers_probe",
        description: "Reports that the peer modules loaded.",
        params: Schema.Struct({}),
        output: Schema.Boolean,
        execute: () => Effect.succeed(loaded),
      }),
    )
  }),
})
`

/**
 * A user extension that logs what the process environment holds for
 * `GENT_DOTENV_PROBE`, which only a `.env` file in the working directory sets.
 */
const DOTENV_PROBE = `
import { defineExtension } from "@gent/core/extensions/api"
import { Effect } from "effect"

export default defineExtension({
  id: "@user/dotenv-probe",
  setup: Effect.logInfo("dotenv-probe").pipe(
    Effect.annotateLogs({ dotenv: process.env["GENT_DOTENV_PROBE"] ?? "unset" }),
  ),
})
`

/** The probe's server log line, a JSON object. */
const decodeDotenvProbeLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ dotenv: Schema.String })),
)

/** The compiled binary `bun run test:e2e` builds first (turbo `dependsOn`). */
const compiledBinary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const binary = yield* path.fromFileUrl(new URL("../bin/gent", import.meta.url))
  expect({ binary, exists: yield* fs.exists(binary) }).toEqual({ binary, exists: true })
  return binary
})

/**
 * Run `<binary> --debug -H <prompt>` in a fresh home (the system temp
 * directory: no node_modules above it) that is also the working directory.
 * `extensions` are written under `~/.gent/extensions` and `files` into the
 * home first. Returns the exit, the output and the server log lines.
 */
const runCompiled = (
  binary: string,
  prompt: string,
  setup: {
    readonly extensions?: Readonly<Record<string, string>>
    readonly files?: Readonly<Record<string, string>>
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const homeDir = yield* makeTempDir
    const extensionDir = path.join(homeDir, ".gent", "extensions")
    yield* fs.makeDirectory(extensionDir, { recursive: true })
    for (const [name, text] of Object.entries(setup.extensions ?? {})) {
      yield* fs.writeFileString(path.join(extensionDir, name), text)
    }
    for (const [name, text] of Object.entries(setup.files ?? {})) {
      yield* fs.writeFileString(path.join(homeDir, name), text)
    }
    const env = createWorkerEnv(homeDir)
    yield* seedAuthKeys(env["GENT_AUTH_DIRECTORY"]!)
    // eslint-disable-next-line effect/noGlobals -- subprocess execution is the integration boundary under test.
    const proc = Bun.spawn([binary, "--debug", "-H", prompt], {
      cwd: homeDir,
      env: { ...(yield* makeChildEnv(homeDir, env)), GENT_LOG_LEVEL: "debug" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        waitForExit(proc, 40000),
        Effect.promise(() => new Response(proc.stdout).text()),
        Effect.promise(() => new Response(proc.stderr).text()),
      ],
      { concurrency: "unbounded" },
    )
    const logDir = path.join(env["GENT_DATA_DIR"]!, "logs")
    const serverLogs = (yield* fs.readDirectory(logDir)).filter((name) =>
      name.endsWith("-server.log"),
    )
    const logs = yield* Effect.forEach(serverLogs, (name) =>
      fs.readFileString(path.join(logDir, name)),
    )
    const logLines = logs.join("\n").split("\n")
    return { exitCode, stdout, stderr, logLines }
  })

describe("compiled binary", () => {
  it.scopedLive(
    "loads a user extension outside the repository that imports the effect peers",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr, logLines } = yield* runCompiled(
          yield* compiledBinary,
          "Say hi in 3 words",
          { extensions: { "peers-probe.ts": PEERS_PROBE } },
        )
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
        expect(stdout).toContain("Latest user message: Say hi in 3 words")
        const probeLines = logLines.filter((line) => line.includes('"@user/peers-probe"'))
        // On a failure, the probe's own log lines name the import that failed.
        const loaded = probeLines.some(
          (line) => line.includes('"msg":"extension.setup.ok"') && line.includes('"tools":1'),
        )
        expect({ loaded, probeLines }).toMatchObject({ loaded: true })
      }).pipe(Effect.timeout("18 seconds"), Effect.provide(BunServices.layer)),
    20000,
  )

  // One shared server serves many projects: a project's `.env` must not set
  // the environment of gent, its extensions or the cell worker it starts.
  it.scopedLive(
    "does not read the .env of the directory it starts in",
    () =>
      Effect.gen(function* () {
        const { exitCode, stderr, logLines } = yield* runCompiled(
          yield* compiledBinary,
          "Say hi in 3 words",
          {
            extensions: { "dotenv-probe.ts": DOTENV_PROBE },
            files: { ".env": "GENT_DOTENV_PROBE=read-from-project-dotenv\n" },
          },
        )
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
        const seen = logLines
          .filter((line) => line.includes('"msg":"dotenv-probe"'))
          .map((line) => decodeDotenvProbeLine(line).dotenv)
        expect(seen).toEqual(["unset"])
      }).pipe(Effect.timeout("18 seconds"), Effect.provide(BunServices.layer)),
    20000,
  )

  // An install links `gent` from a bin directory into the version directory
  // that holds the pair; the link's directory has no worker. The host starts
  // the worker beside its real executable, so each version keeps its own.
  it.scopedLive(
    "started through a symlink, runs cells with the worker beside its real executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const linkDir = yield* makeTempDir
        const link = path.join(linkDir, "gent")
        yield* fs.symlink(yield* compiledBinary, link)
        // The scripted model's `debug tools` turn runs its steps as cells.
        const { exitCode, stdout, stderr } = yield* runCompiled(link, "debug tools")
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
        expect(stdout).toContain("[tool done: cell]")
        expect(stdout).not.toContain("[tool error: cell]")
      }).pipe(Effect.timeout("45 seconds"), Effect.provide(BunServices.layer)),
    50000,
  )

  // install.sh never prunes a version a running gent marks, so a server keeps
  // its gent-cell across updates.
  it.scopedLive(
    "in an install, marks its version in use while it runs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const binary = yield* compiledBinary
        const home = yield* makeTempDir
        const versionDir = path.join(home, "gent", "versions", "1.0.0")
        yield* fs.makeDirectory(versionDir, { recursive: true })
        for (const name of ["gent", "gent-cell"]) {
          yield* fs.copyFile(path.join(path.dirname(binary), name), path.join(versionDir, name))
          yield* fs.chmod(path.join(versionDir, name), 0o755)
        }
        // eslint-disable-next-line effect/noGlobals -- subprocess execution is the integration boundary under test.
        const proc = Bun.spawn(
          [path.join(versionDir, "gent"), "server", "start", "--isolate", "--mock", "--port", "0"],
          {
            cwd: home,
            env: { PATH: "/usr/bin:/bin", HOME: home, GENT_DATA_DIR: path.join(home, "data") },
            stdout: "ignore",
            stderr: "ignore",
          },
        )
        // A failed wait still stops the server.
        yield* Effect.addFinalizer(() => Effect.sync(() => proc.kill("SIGKILL")))
        const marker = path.join(versionDir, ".in-use", String(proc.pid))
        yield* fs
          .exists(marker)
          .pipe(
            Effect.repeat({ until: (found) => found, schedule: Schedule.spaced("100 millis") }),
            Effect.timeout("30 seconds"),
          )
        proc.kill("SIGTERM")
        expect(yield* waitForExit(proc, 20000)).not.toBe(-1)
        expect(yield* fs.exists(marker)).toBe(false)
      }).pipe(Effect.timeout("55 seconds"), Effect.provide(BunServices.layer)),
    60000,
  )

  // The release runs this script on each platform's pair before it packs the
  // archive; running it here proves the script on every change.
  it.scopedLive(
    "passes the release smoke",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const binary = yield* compiledBinary
        const script = yield* path.fromFileUrl(
          new URL("../../../packages/e2e/src/release-smoke.ts", import.meta.url),
        )
        // eslint-disable-next-line effect/noGlobals -- subprocess execution is the integration boundary under test.
        const proc = Bun.spawn(["bun", script, path.dirname(binary)], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            waitForExit(proc, 100000),
            Effect.promise(() => new Response(proc.stdout).text()),
            Effect.promise(() => new Response(proc.stderr).text()),
          ],
          { concurrency: "unbounded" },
        )
        expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 })
        expect(`${stdout}${stderr}`).toContain("release smoke passed")
      }).pipe(Effect.timeout("105 seconds"), Effect.provide(BunServices.layer)),
    110000,
  )
})
