import { createTempDirFixture } from "@gent/core-internal/test-utils/fixtures"
import { Clock, Config, Effect, Option } from "effect"
import { spawn, type IPty } from "zigpty"
import { seedAuthBoundary } from "./auth-seed-boundary"

const CTRL_C = "\x03"
const repoRoot = decodeURIComponent(new URL("../../..", import.meta.url).pathname).replace(
  /\/$/,
  "",
)
const tuiDir = `${repoRoot}/apps/tui`
const makeTempDir = createTempDirFixture("gent-e2e-")
const clientLogPath = Effect.gen(function* () {
  const home = Option.getOrElse(yield* Config.option(Config.string("HOME")), () => "")
  return `${home}/.gent/logs/Users-cvr-Developer-personal-gent-apps-tui/gent-client.log`
})

export interface TestContext {
  readonly pty: IPty
  readonly output: string
  readonly tempDir: string
  readonly cleanup: Effect.Effect<void>
}

const isPidAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForExit = (pid: number, timeoutMs: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    const loop: Effect.Effect<void> = Effect.gen(function* () {
      if (!isPidAlive(pid)) return
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) return
      // gent/no-sleep: allow OS-level wait for kernel to reap the PTY subprocess
      yield* Effect.sleep("50 millis")
      return yield* loop
    })
    return yield* loop
  })

const ignoreSyncDefect = (evaluate: () => void): Effect.Effect<void> =>
  Effect.sync(evaluate).pipe(Effect.catchCause(() => Effect.void))

export const spawnWithDir = (
  tempDir: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): TestContext => {
  const mainPath = `${tuiDir}/src/main.tsx`
  const preloadPath = `${tuiDir}/node_modules/@opentui/solid/scripts/preload.ts`

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
    yield* waitForExit(pid, 1_000)
    if (isPidAlive(pid)) {
      yield* ignoreSyncDefect(() => process.kill(pid, "SIGKILL"))
      yield* waitForExit(pid, 2_000)
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

export const resetClientLog = (): Effect.Effect<void> =>
  clientLogPath.pipe(
    Effect.flatMap((path) => Effect.tryPromise(() => Bun.file(path).delete())),
    Effect.catchCause(() => Effect.void),
  )

export const readClientLog = (): Effect.Effect<string> =>
  clientLogPath.pipe(
    Effect.flatMap((path) => Effect.tryPromise(() => Bun.file(path).text())),
    Effect.catchCause(() => Effect.succeed("")),
  )

export const seedAndSpawn = (extraArgs: string[] = []) =>
  Effect.gen(function* () {
    const tempDir = makeTempDir()
    yield* Effect.promise(() => seedAuthBoundary(`${tempDir}/auth`))
    return spawnWithDir(tempDir, extraArgs)
  })

export const spawnNoAuth = (): Effect.Effect<TestContext> =>
  Effect.sync(() => spawnWithDir(makeTempDir()))

export const seedSkillAndSpawn = () =>
  Effect.gen(function* () {
    const tempDir = makeTempDir()

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

export const ptyWaitFor = (
  pty: IPty,
  text: string,
  opts: { timeout: number },
): Effect.Effect<void> => Effect.promise(() => pty.waitFor(text, opts))

// gent/no-sleep: allow PTY fixture primitive — deliberate OS-level pause for terminal redraw cycles
export const shortPause = (ms: number): Effect.Effect<void> => Effect.sleep(`${ms} millis`)

const escape = "\\u001b"
const bell = "\\u0007"

export const stripAnsi = (str: string): string =>
  str
    .replace(new RegExp(`${escape}\\[[0-9;]*[a-zA-Z]`, "g"), "")
    .replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "")
    .replace(new RegExp(`${escape}\\[\\?[0-9;]*[a-zA-Z$]`, "g"), "")
    .replace(new RegExp(`${escape}\\][^${bell}]*${bell}`, "g"), "")
    .replace(new RegExp(`${escape}\\[>[0-9]*[a-zA-Z]`, "g"), "")
    .replace(new RegExp(`${escape}\\[[0-9]*"`, "g"), "")
