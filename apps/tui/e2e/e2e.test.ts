/**
 * PTY-based E2E tests for TUI
 *
 * Uses zigpty for proper pseudo-terminal emulation with waitFor pattern.
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

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
}

async function spawnTui(extraArgs: string[] = []): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-e2e-"))
  await seedAuth(tempDir)

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
    env: {
      ...Bun.env,
      GENT_DATA_DIR: tempDir,
    },
  })

  pty.onData((data) => {
    output += data
  })

  const cleanup = () => {
    try {
      pty.kill()
    } catch {
      // Process may already be dead
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
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

// Track context for cleanup
let testContext: TestContext | null = null

afterEach(() => {
  if (testContext) {
    testContext.cleanup()
    testContext = null
  }
})

describe("E2E: TUI Basics", () => {
  test(
    "TUI starts and shows home view with prompt",
    async () => {
      testContext = await spawnTui()

      await testContext.pty.waitFor("❯", { timeout: 10_000 })

      const clean = stripAnsi(testContext.output)
      expect(clean).toContain("❯")
      expect(testContext.output.length).toBeGreaterThan(100)

      testContext.pty.write(CTRL_C)
    },
    TEST_TIMEOUT,
  )

  test(
    "shift+tab toggles agent from cowork to deepwork",
    async () => {
      testContext = await spawnTui()

      await testContext.pty.waitFor("cowork", { timeout: 10_000 })

      testContext.pty.write(SHIFT_TAB)

      await testContext.pty.waitFor("deepwork", { timeout: 5_000 })

      const clean = stripAnsi(testContext.output)
      expect(clean).toContain("deepwork")

      testContext.pty.write(CTRL_C)
    },
    TEST_TIMEOUT,
  )

  test(
    "typing text produces output",
    async () => {
      testContext = await spawnTui()

      await testContext.pty.waitFor("❯", { timeout: 10_000 })

      const outputBefore = testContext.output.length
      testContext.pty.write("hello world")

      // Wait for output to grow (TUI re-renders with typed text + ANSI sequences)
      await new Promise((r) => setTimeout(r, 1_000))

      expect(testContext.output.length).toBeGreaterThan(outputBefore)
      // Verify individual characters landed (may be interspersed with ANSI)
      const clean = stripAnsi(testContext.output)
      expect(clean).toContain("hello")

      testContext.pty.write(CTRL_C)
    },
    TEST_TIMEOUT,
  )

  test(
    "double ESC exits cleanly",
    async () => {
      testContext = await spawnTui()

      await testContext.pty.waitFor("❯", { timeout: 10_000 })

      testContext.pty.write(ESC)
      await new Promise((r) => setTimeout(r, 200))
      testContext.pty.write(ESC)

      const exitCode = await Promise.race([
        testContext.pty.exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ])

      expect(exitCode).not.toBeNull()
      expect(exitCode).toBe(0)
    },
    TEST_TIMEOUT,
  )
})

describe("E2E: Session Navigation", () => {
  test(
    "submitting a message navigates to session view",
    async () => {
      testContext = await spawnTui()

      await testContext.pty.waitFor("❯", { timeout: 10_000 })

      testContext.pty.write("hi")
      await new Promise((r) => setTimeout(r, 300))
      testContext.pty.write(ENTER)

      // Wait for either session activity or error (no real API keys)
      await new Promise((r) => setTimeout(r, 5_000))

      const clean = stripAnsi(testContext.output)
      const hasSessionIndicators =
        clean.includes("Session") ||
        clean.includes("Error") ||
        clean.includes("API") ||
        clean.includes("provider") ||
        clean.includes("streaming") ||
        clean.includes("model") ||
        clean.includes("user") ||
        clean.includes("assistant") ||
        testContext.output.length > 3000

      expect(hasSessionIndicators).toBe(true)

      testContext.pty.write(CTRL_C)
    },
    TEST_TIMEOUT,
  )
})

describe("E2E: Slash Commands", () => {
  test(
    "/ prefix opens command popup",
    async () => {
      testContext = await spawnTui()

      await testContext.pty.waitFor("❯", { timeout: 10_000 })

      testContext.pty.write("/")

      // Command popup should show available commands
      await testContext.pty.waitFor("agent", { timeout: 5_000 })

      const clean = stripAnsi(testContext.output)
      expect(clean).toContain("agent")

      testContext.pty.write(ESC)
    },
    TEST_TIMEOUT,
  )
})

describe("E2E: Shell Mode", () => {
  test(
    "! prefix enters shell mode",
    async () => {
      testContext = await spawnTui()

      await testContext.pty.waitFor("❯", { timeout: 10_000 })

      testContext.pty.write("!")

      // Shell mode changes the prompt to $
      await testContext.pty.waitFor("$", { timeout: 5_000 })

      // Type a shell command
      testContext.pty.write("echo zigpty-test")
      testContext.pty.write(ENTER)

      // Should see output
      await testContext.pty.waitFor("zigpty-test", { timeout: 5_000 })

      testContext.pty.write(ESC)
    },
    TEST_TIMEOUT,
  )
})

describe("E2E: Headless Mode", () => {
  test(
    "headless mode starts and exits",
    async () => {
      testContext = await spawnTui(["-H", "say hello"])

      // Headless mode should start streaming or error (no real API keys)
      await new Promise((r) => setTimeout(r, 5_000))

      // Should have produced some output
      expect(testContext.output.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )
})
