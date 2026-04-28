import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { AuthApi, AuthStore } from "@gent/core/domain/auth-store"
import { AuthStorage } from "@gent/core/domain/auth-storage"
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn, type IPty } from "zigpty"
import { ignoreSyncDefect, sleepMillis } from "./effect-test-adapters"

const CTRL_C = "\x03"
const CLIENT_LOG_PATH = path.join(
  os.homedir(),
  ".gent",
  "logs",
  "Users-cvr-Developer-personal-gent-apps-tui",
  "gent-client.log",
)

export interface TestContext {
  readonly pty: IPty
  readonly output: string
  readonly tempDir: string
  readonly cleanup: Effect.Effect<void>
}

export const seedAuth = (tempDir: string) => {
  const authFilePath = path.join(tempDir, "auth.json.enc")
  const authKeyPath = path.join(tempDir, "auth.key")

  const layer = AuthStore.Live.pipe(
    Layer.provide(AuthStorage.LiveEncryptedFile(authFilePath, authKeyPath)),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer),
  )

  return Effect.gen(function* () {
    const store = yield* AuthStore
    yield* store.set("anthropic", new AuthApi({ type: "api", key: "sk-test-anthropic" }))
    yield* store.set("openai", new AuthApi({ type: "api", key: "sk-test-openai" }))
  }).pipe(Effect.provide(layer))
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
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const deadline = Date.now() + timeoutMs
        const tick = () => {
          if (!isPidAlive(pid) || Date.now() >= deadline) {
            resolve()
            return
          }
          setTimeout(tick, 50)
        }
        tick()
      }),
  )

export const spawnWithDir = (
  tempDir: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): TestContext => {
  const tuiDir = path.resolve(import.meta.dir, "../../../apps/tui")
  const mainPath = path.join(tuiDir, "src", "main.tsx")
  const preloadPath = path.join(
    tuiDir,
    "node_modules",
    "@opentui",
    "solid",
    "scripts",
    "preload.ts",
  )

  let output = ""

  const pty = spawn("bun", ["--preload", preloadPath, mainPath, "--isolate", ...extraArgs], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: tuiDir,
    env: {
      ...Bun.env,
      GENT_DATA_DIR: tempDir,
      GENT_AUTH_FILE_PATH: path.join(tempDir, "auth.json.enc"),
      GENT_AUTH_KEY_PATH: path.join(tempDir, "auth.key"),
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
    yield* ignoreSyncDefect(() => fs.rmSync(tempDir, { recursive: true, force: true }))
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
  ignoreSyncDefect(() => fs.rmSync(CLIENT_LOG_PATH, { force: true }))

export const readClientLog = (): string => {
  try {
    return fs.readFileSync(CLIENT_LOG_PATH, "utf8")
  } catch {
    return ""
  }
}

export const seedAndSpawn = (extraArgs: string[] = []) =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-e2e-"))
    yield* seedAuth(tempDir)
    return spawnWithDir(tempDir, extraArgs)
  })

export const spawnNoAuth = (): TestContext => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-e2e-"))
  return spawnWithDir(tempDir)
}

export const seedSkillAndSpawn = () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-e2e-"))
    yield* seedAuth(tempDir)

    const fakeHome = path.join(tempDir, "home")
    const skillDir = path.join(fakeHome, ".claude", "skills", "test-skill")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: test-skill\ndescription: A test skill for e2e\n---\n\nTest skill content.",
    )

    return spawnWithDir(tempDir, [], { HOME: fakeHome })
  })

export const ptyWaitFor = (
  pty: IPty,
  text: string,
  opts: { timeout: number },
): Effect.Effect<void> => Effect.promise(() => pty.waitFor(text, opts))

export const shortPause = (ms: number): Effect.Effect<void> => sleepMillis(ms)

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
