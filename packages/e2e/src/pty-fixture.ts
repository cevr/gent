import { makeTempDirectoryScoped, waitFor } from "@gent/core-internal/test-utils/fixtures"
import { Effect } from "effect"
import { spawn, type IPty } from "zigpty"
import { seedAuthBoundary } from "./auth-seed-boundary"
import { waitForProcessExit } from "./wait-for-process-exit"

const CTRL_C = "\x03"
const repoRoot = decodeURIComponent(new URL("../../..", import.meta.url).pathname).replace(
  /\/$/,
  "",
)
const tuiDir = `${repoRoot}/apps/tui`

export interface TestContext {
  readonly pty: IPty
  readonly output: string
  readonly tempDir: string
  readonly cleanup: Effect.Effect<void>
}

const ignoreSyncDefect = (evaluate: () => void): Effect.Effect<void> =>
  Effect.sync(evaluate).pipe(Effect.ignoreCause)

const spawnWithDir = (
  tempDir: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): TestContext => {
  const mainPath = `${tuiDir}/src/main.tsx`
  const preloadPath = `${tuiDir}/node_modules/@opentui/solid/scripts/preload.js`

  let output = ""

  const pty = spawn("bun", ["--preload", preloadPath, mainPath, "--isolate", ...extraArgs], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: tuiDir,
    env: {
      ...Bun.env,
      GENT_DATA_DIR: tempDir,
      GENT_AUTH_DIRECTORY: `${tempDir}/auth`,
      ...extraEnv,
    },
  })

  pty.onData((data) => {
    output += data
  })

  const cleanup = Effect.gen(function* () {
    const pid = pty.pid
    yield* ignoreSyncDefect(() => pty.write(CTRL_C))
    const exited = yield* waitForProcessExit(pid, 1_000)
    if (!exited) {
      yield* ignoreSyncDefect(() => process.kill(pid, "SIGKILL"))
      yield* waitForProcessExit(pid, 2_000)
    }
    yield* ignoreSyncDefect(() => pty.close())
  })

  return {
    pty,
    get output() {
      return output
    },
    tempDir,
    cleanup,
  }
}

export const seedAndSpawn = (extraArgs: string[] = []) =>
  Effect.gen(function* () {
    const tempDir = yield* makeTempDirectoryScoped("gent-e2e-")
    yield* Effect.promise(() => seedAuthBoundary(`${tempDir}/auth`))
    return spawnWithDir(tempDir, extraArgs)
  })

export const spawnNoAuth = Effect.gen(function* () {
  const tempDir = yield* makeTempDirectoryScoped("gent-e2e-")
  return spawnWithDir(tempDir)
})

export const seedSkillAndSpawn = Effect.gen(function* () {
  const tempDir = yield* makeTempDirectoryScoped("gent-e2e-")

  const fakeHome = `${tempDir}/home`
  const skillDir = `${fakeHome}/.claude/skills/test-skill`
  yield* Effect.promise(() => Bun.$`mkdir -p ${skillDir}`.quiet())
  yield* Effect.promise(() =>
    Bun.write(
      `${skillDir}/SKILL.md`,
      "---\nname: test-skill\ndescription: A test skill for e2e\n---\n\nTest skill content.",
    ),
  )

  yield* Effect.promise(() => seedAuthBoundary(`${tempDir}/auth`))
  return spawnWithDir(tempDir, [], { HOME: fakeHome })
})

export const ptyWaitFor = (ctx: TestContext, text: string, opts: { timeout: number }) =>
  waitFor(
    Effect.sync(() => stripAnsi(ctx.output)),
    (output) => output.includes(text),
    opts.timeout,
    `PTY output "${text}"`,
  ).pipe(Effect.asVoid)

// gent/no-sleep: allow PTY fixture primitive — deliberate OS-level pause for terminal redraw cycles
export const shortPause = (ms: number): Effect.Effect<void> => Effect.sleep(`${ms} millis`)

export const stripAnsi = (str: string): string => Bun.stripANSI(str)
