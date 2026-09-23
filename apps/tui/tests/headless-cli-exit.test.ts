import { it, describe, expect } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path } from "effect"
import { Auth, AuthApi } from "@gent/core/host"
import { createWorkerEnv } from "@gent/core/test-utils"
const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "gent-headless-exit-" })
})
const waitForExit = (proc: Bun.Subprocess, timeoutMs: number) => {
  // gent/no-sleep: allow real-clock timeout fence that kills a wedged subprocess
  const timeout = Effect.sleep(timeoutMs).pipe(
    Effect.tap(() => Effect.sync(() => proc.kill())),
    Effect.as(-1),
  )
  return Effect.race(
    Effect.promise(() => proc.exited),
    timeout,
  )
}
const seedAuth = (directory: string) => {
  const authLayer = Auth.Live(directory).pipe(Layer.provide(BunServices.layer))
  return Effect.gen(function* () {
    const auth = yield* Auth
    yield* auth.set("anthropic", AuthApi.make({ type: "api", key: "test-key" }))
    yield* auth.set("openai", AuthApi.make({ type: "api", key: "test-key" }))
  }).pipe(Effect.provide(authLayer))
}
const makeChildEnv = (homeDir: string, env: ReturnType<typeof createWorkerEnv>) => {
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
    GENT_PERSISTENCE_MODE: "memory",
    GENT_PROVIDER_MODE: "debug-scripted",
    ...env,
  }
}
/**
 * Run `gent --debug <args>` in a fresh home with stored keys and collect its
 * exit and output. `keyless` runs without `--debug` and without keys.
 */
const runGent = (args: ReadonlyArray<string>, options: { readonly keyless?: boolean } = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const appDir = path.resolve(import.meta.dir, "..")
    const homeDir = yield* makeTempDir
    const env = createWorkerEnv(homeDir, "debug-scripted")
    const mode: Array<string> = []
    if (options.keyless !== true) {
      yield* seedAuth(env["GENT_AUTH_DIRECTORY"]!)
      mode.push("--debug")
    }
    // eslint-disable-next-line effect/noGlobals -- subprocess execution is the integration boundary under test.
    const proc = Bun.spawn(
      ["bun", "--preload", "@opentui/solid/preload", "src/main.tsx", ...mode, ...args],
      {
        cwd: appDir,
        env: makeChildEnv(homeDir, env),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
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

  it.scopedLive(
    "--agent without -H is refused, not dropped",
    () =>
      Effect.gen(function* () {
        const { exitCode, stderr } = yield* runGent(["--agent", "main"])
        expect(exitCode).toBe(1)
        expect(stderr).toBe(
          "CliStartupError: --agent applies to headless mode; add -H with a prompt\n",
        )
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

  it.scopedLive(
    "--approve-all without -H is refused",
    () =>
      Effect.gen(function* () {
        const { exitCode, stderr } = yield* runGent(["--approve-all"])
        expect(exitCode).toBe(1)
        expect(stderr).toBe(
          "CliStartupError: --approve-all applies to headless mode; add -H with a prompt\n",
        )
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
    "missing API keys are one line on stderr",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runGent(["-H", "Say hi in 3 words"], {
          keyless: true,
        })
        expect(exitCode).toBe(1)
        expect(stderr).toBe("CliStartupError: missing required API keys: anthropic\n")
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
import * as Sql from "effect/unstable/sql"

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

describe("compiled binary", () => {
  it.scopedLive(
    "loads a user extension outside the repository that imports the effect peers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        // `bun run test:e2e` builds the binary first (turbo `dependsOn`).
        const binary = path.resolve(import.meta.dir, "..", "bin", "gent")
        expect({ binary, exists: yield* fs.exists(binary) }).toEqual({ binary, exists: true })
        // The system temp directory: no node_modules above it.
        const homeDir = yield* makeTempDir
        const extensionDir = path.join(homeDir, ".gent", "extensions")
        yield* fs.makeDirectory(extensionDir, { recursive: true })
        yield* fs.writeFileString(path.join(extensionDir, "peers-probe.ts"), PEERS_PROBE)
        const env = createWorkerEnv(homeDir, "debug-scripted")
        yield* seedAuth(env["GENT_AUTH_DIRECTORY"]!)
        // eslint-disable-next-line effect/noGlobals -- subprocess execution is the integration boundary under test.
        const proc = Bun.spawn([binary, "--debug", "-H", "Say hi in 3 words"], {
          cwd: homeDir,
          env: { ...makeChildEnv(homeDir, env), GENT_LOG_LEVEL: "debug" },
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
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
        expect(stdout).toContain("Latest user message: Say hi in 3 words")

        const logDir = path.join(env["GENT_DATA_DIR"]!, "logs")
        const serverLogs = (yield* fs.readDirectory(logDir)).filter((name) =>
          name.endsWith("-server.log"),
        )
        const lines = yield* Effect.forEach(serverLogs, (name) =>
          fs.readFileString(path.join(logDir, name)),
        )
        const probeLines = lines
          .join("\n")
          .split("\n")
          .filter((line) => line.includes('"@user/peers-probe"'))
        // On a failure, the probe's own log lines name the import that failed.
        const loaded = probeLines.some(
          (line) => line.includes('"msg":"extension.setup.ok"') && line.includes('"tools":1'),
        )
        expect({ loaded, probeLines }).toMatchObject({ loaded: true })
      }).pipe(Effect.timeout("18 seconds"), Effect.provide(BunServices.layer)),
    20000,
  )
})
