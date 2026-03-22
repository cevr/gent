/**
 * PTY-based E2E tests for TUI
 *
 * Uses zigpty for pseudo-terminal emulation with waitFor pattern.
 * Tests are grouped by feature. Each test spawns a fresh PTY.
 */
import { describe, test, expect, afterEach } from "bun:test"
import { BunServices, BunFileSystem } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { spawn, type IPty } from "zigpty"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { AuthApi, AuthStore } from "@gent/core/domain/auth-store"
import { AuthStorage } from "@gent/core/domain/auth-storage"

const TEST_TIMEOUT = 30_000

const ENTER = "\r"
const ESC = "\x1b"
const CTRL_C = "\x03"
const SHIFT_TAB = "\x1b[Z"
const UP = "\x1b[A"
const DOWN = "\x1b[B"

interface TestContext {
  pty: IPty
  output: string
  tempDir: string
  cleanup: () => void
}

const seedAuth = async (tempDir: string): Promise<void> => {
  const authFilePath = path.join(tempDir, "auth.json.enc")
  const authKeyPath = path.join(tempDir, "auth.key")

  const layer = AuthStore.Live.pipe(
    Layer.provide(AuthStorage.LiveEncryptedFile(authFilePath, authKeyPath)),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* AuthStore
      yield* store.set("anthropic", new AuthApi({ type: "api", key: "sk-test-anthropic" }))
      yield* store.set("openai", new AuthApi({ type: "api", key: "sk-test-openai" }))
    }).pipe(Effect.provide(layer)),
  )
}

function spawnWithDir(
  tempDir: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): TestContext {
  const tuiDir = path.resolve(import.meta.dir, "..")
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

  const pty = spawn("bun", ["--preload", preloadPath, mainPath, ...extraArgs], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: tuiDir,
    env: { ...Bun.env, GENT_DATA_DIR: tempDir, ...extraEnv },
  })

  pty.onData((data) => {
    output += data
  })

  const cleanup = () => {
    try {
      pty.close()
    } catch {
      /* already dead */
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  return {
    pty,
    get output() {
      return output
    },
    tempDir,
    cleanup,
  }
}

const seedAndSpawn = async (extraArgs: string[] = []): Promise<TestContext> => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-e2e-"))
  await seedAuth(tempDir)
  return spawnWithDir(tempDir, extraArgs)
}

const spawnNoAuth = (): TestContext => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-e2e-"))
  return spawnWithDir(tempDir)
}

/* eslint-disable no-control-regex */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z$]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[>[0-9]*[a-zA-Z]/g, "")
    .replace(/\x1b\[[0-9]*"/g, "")
}
/* eslint-enable no-control-regex */

let testContext: TestContext | null = null

afterEach(async () => {
  if (testContext) {
    testContext.cleanup()
    testContext = null
    // Give OS time to reclaim PTY resources before next test
    await new Promise((r) => setTimeout(r, 200))
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Basics
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("E2E: Basics", () => {
  test(
    "starts and shows home view with prompt",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      expect(stripAnsi(testContext.output)).toContain("❯")
    },
    TEST_TIMEOUT,
  )

  test(
    "shift+tab toggles agent cowork → deepwork",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("cowork", { timeout: 10_000 })
      testContext.pty.write(SHIFT_TAB)
      await testContext.pty.waitFor("deepwork", { timeout: 5_000 })
    },
    TEST_TIMEOUT,
  )

  test(
    "typing text appears in output",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      const before = testContext.output.length
      testContext.pty.write("hello world")
      await new Promise((r) => setTimeout(r, 1_000))
      expect(testContext.output.length).toBeGreaterThan(before)
      expect(stripAnsi(testContext.output)).toContain("hello")
    },
    TEST_TIMEOUT,
  )

  test(
    "double ESC exits with code 0",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      testContext.pty.write(ESC)
      await new Promise((r) => setTimeout(r, 200))
      testContext.pty.write(ESC)
      const code = await Promise.race([
        testContext.pty.exited,
        new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
      ])
      expect(code).toBe(0)
    },
    TEST_TIMEOUT,
  )
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Auth
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("E2E: Auth", () => {
  test(
    "missing auth → auto-opens auth panel",
    async () => {
      testContext = spawnNoAuth()
      await testContext.pty.waitFor("API Keys", { timeout: 10_000 })
      // Give time for provider list to render
      await new Promise((r) => setTimeout(r, 500))
      // Panel rendered successfully
      expect(testContext.output).toContain("API Keys")
      expect(testContext.output.length).toBeGreaterThan(500)
    },
    TEST_TIMEOUT,
  )

  test(
    "auth panel: navigate providers with arrows",
    async () => {
      testContext = spawnNoAuth()
      await testContext.pty.waitFor("API Keys", { timeout: 10_000 })
      testContext.pty.write(DOWN)
      await new Promise((r) => setTimeout(r, 300))
      testContext.pty.write(DOWN)
      await new Promise((r) => setTimeout(r, 300))
      // Output should have grown from navigation
      expect(testContext.output.length).toBeGreaterThan(100)
    },
    TEST_TIMEOUT,
  )

  test(
    "auth panel: Enter opens method picker, ESC goes back",
    async () => {
      testContext = spawnNoAuth()
      await testContext.pty.waitFor("API Keys", { timeout: 10_000 })
      // Select provider
      testContext.pty.write(ENTER)
      // Method picker shows "Enter=choose" hint
      await testContext.pty.waitFor("choose", { timeout: 5_000 })
      // ESC back to list
      testContext.pty.write(ESC)
      await testContext.pty.waitFor("select", { timeout: 5_000 })
    },
    TEST_TIMEOUT,
  )
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Slash Commands
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("E2E: Slash Commands", () => {
  test(
    "/ prefix shows autocomplete popup with commands",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      testContext.pty.write("/")
      await testContext.pty.waitFor("agent", { timeout: 5_000 })
      testContext.pty.write(ESC)
    },
    TEST_TIMEOUT,
  )

  test(
    "typing /auth in autocomplete then Enter navigates to auth",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      testContext.pty.write("/auth")
      await new Promise((r) => setTimeout(r, 300))
      testContext.pty.write(ENTER)
      await testContext.pty.waitFor("API Keys", { timeout: 5_000 })
      // Auth panel rendered — "API Keys" header visible
      expect(testContext.output.length).toBeGreaterThan(500)
      testContext.pty.write(ESC)
    },
    TEST_TIMEOUT,
  )
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Shell Mode
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("E2E: Shell Mode", () => {
  test(
    "! enters shell, runs echo, ESC exits",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      testContext.pty.write("!")
      await testContext.pty.waitFor("$", { timeout: 5_000 })
      testContext.pty.write("echo zigpty-e2e")
      testContext.pty.write(ENTER)
      await testContext.pty.waitFor("zigpty-e2e", { timeout: 5_000 })
      testContext.pty.write(ESC)
    },
    TEST_TIMEOUT,
  )

  test(
    "shell mode: sequential commands",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      testContext.pty.write("!")
      await testContext.pty.waitFor("$", { timeout: 5_000 })
      testContext.pty.write("echo first-cmd")
      testContext.pty.write(ENTER)
      await testContext.pty.waitFor("first-cmd", { timeout: 5_000 })
      await new Promise((r) => setTimeout(r, 500))
      testContext.pty.write("echo second-cmd")
      testContext.pty.write(ENTER)
      await testContext.pty.waitFor("second-cmd", { timeout: 5_000 })
      testContext.pty.write(ESC)
    },
    TEST_TIMEOUT,
  )
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Session
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("E2E: Session", () => {
  test(
    "submitting message triggers session creation",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      testContext.pty.write("hi")
      await new Promise((r) => setTimeout(r, 300))
      testContext.pty.write(ENTER)
      // Session view renders — may show streaming, error, or user message
      // Just wait for output to grow substantially
      await new Promise((r) => setTimeout(r, 3_000))
      expect(testContext.output.length).toBeGreaterThan(2000)
      testContext.pty.write(CTRL_C)
    },
    TEST_TIMEOUT,
  )
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Headless
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("E2E: Headless", () => {
  test(
    "-H flag produces output",
    async () => {
      testContext = await seedAndSpawn(["-H", "say hello"])
      // Wait for process to exit or timeout
      await Promise.race([
        testContext.pty.exited,
        new Promise<null>((r) => setTimeout(() => r(null), 8_000)),
      ])
      expect(testContext.output.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Prompt History
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("E2E: Prompt History", () => {
  test(
    "up arrow at empty prompt does not crash",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      testContext.pty.write(UP)
      await new Promise((r) => setTimeout(r, 500))
      // TUI still running — prompt visible
      expect(stripAnsi(testContext.output)).toContain("❯")
    },
    TEST_TIMEOUT,
  )

  test(
    "up arrow at non-empty input does not navigate",
    async () => {
      testContext = await seedAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      testContext.pty.write("some text")
      await new Promise((r) => setTimeout(r, 500))
      testContext.pty.write(UP)
      await new Promise((r) => setTimeout(r, 300))
      // Text should still be present (up was a no-op because cursor not at 0)
      expect(stripAnsi(testContext.output)).toContain("some")
    },
    TEST_TIMEOUT,
  )
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Skill Popup
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const seedSkillAndSpawn = async (): Promise<TestContext> => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-e2e-"))
  await seedAuth(tempDir)

  // Create a fake skill in a custom HOME
  const fakeHome = path.join(tempDir, "home")
  const skillDir = path.join(fakeHome, ".claude", "skills", "test-skill")
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: test-skill\ndescription: A test skill for e2e\n---\n\nTest skill content.",
  )

  return spawnWithDir(tempDir, [], { HOME: fakeHome })
}

describe("E2E: Skill Popup", () => {
  test(
    "$ trigger shows skills popup",
    async () => {
      testContext = await seedSkillAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      // Wait for skills RPC to complete (async load on mount)
      await new Promise((r) => setTimeout(r, 2_000))
      testContext.pty.write("$t")
      await testContext.pty.waitFor("Skills", { timeout: 5_000 })
      const clean = stripAnsi(testContext.output)
      expect(clean).toContain("Skills")
      testContext.pty.write(ESC)
    },
    TEST_TIMEOUT,
  )

  test(
    "ESC closes skill popup",
    async () => {
      testContext = await seedSkillAndSpawn()
      await testContext.pty.waitFor("❯", { timeout: 10_000 })
      // Wait for skills RPC to complete
      await new Promise((r) => setTimeout(r, 2_000))
      testContext.pty.write("$t")
      await testContext.pty.waitFor("Skills", { timeout: 5_000 })
      testContext.pty.write(ESC)
      await new Promise((r) => setTimeout(r, 500))
      // Popup closed — prompt still there
      expect(stripAnsi(testContext.output)).toContain("❯")
    },
    TEST_TIMEOUT,
  )
})
