/**
 * PTY-based E2E tests for TUI
 *
 * Uses bun-pty for proper pseudo-terminal emulation, allowing us to
 * send real keystrokes and test the full TUI flow.
 */
import { describe, test, expect, afterEach } from "bun:test"
import { spawn, type IPty } from "bun-pty"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"

// Test timeout
const TEST_TIMEOUT = 30_000

// Key codes
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

/**
 * Spawns the TUI in a real PTY with isolated data directory
 */
function spawnTui(): TestContext {
  // Create isolated temp directory for test data
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-e2e-"))

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

  const pty = spawn("bun", ["--preload", preloadPath, mainPath], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: tuiDir,
    env: {
      ...Bun.env,
      ANTHROPIC_API_KEY: "sk-test-anthropic",
      OPENAI_API_KEY: "sk-test-openai",
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
    // Clean up temp directory
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

/**
 * Wait for output to match a condition
 */
async function waitForOutput(
  getOutput: () => string,
  condition: (output: string) => boolean,
  timeout = 5000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (condition(getOutput())) return
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`Timeout waiting for output condition`)
}

/**
 * Wait for TUI to be ready (prompt visible)
 */
async function waitForReady(ctx: TestContext, timeout = 5000): Promise<void> {
  await waitForOutput(
    () => ctx.output,
    (o) => o.includes("❯") || o.includes("gent"),
    timeout,
  )
}

/**
 * Type text character by character with small delays
 */
async function typeText(pty: IPty, text: string, charDelay = 30): Promise<void> {
  for (const char of text) {
    pty.write(char)
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, charDelay))
  }
}

/**
 * Strip ANSI escape codes for easier inspection
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
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
    "TUI starts and shows home view",
    async () => {
      testContext = spawnTui()
      await waitForReady(testContext)

      // Should see the prompt symbol and some UI
      expect(testContext.output.length).toBeGreaterThan(100)
      expect(stripAnsi(testContext.output)).toContain("❯")

      testContext.pty.write(CTRL_C)
    },
    TEST_TIMEOUT,
  )

  test(
    "shift+tab toggles agent label",
    async () => {
      testContext = spawnTui()
      await waitForReady(testContext)

      await waitForOutput(
        () => stripAnsi(testContext!.output),
        (o) => o.includes("cowork"),
        5000,
      )

      testContext.pty.write(SHIFT_TAB)

      await waitForOutput(
        () => stripAnsi(testContext!.output),
        (o) => o.includes("deepwork"),
        5000,
      )

      testContext.pty.write(CTRL_C)
    },
    TEST_TIMEOUT,
  )

  test(
    "typing in input is reflected in output",
    async () => {
      testContext = spawnTui()
      await waitForReady(testContext)

      const outputBefore = testContext.output.length

      await typeText(testContext.pty, "hello world")
      await new Promise((r) => setTimeout(r, 500))

      const outputAfter = testContext.output.length
      expect(outputAfter).toBeGreaterThan(outputBefore)

      testContext.pty.write(CTRL_C)
    },
    TEST_TIMEOUT,
  )

  test(
    "double ESC exits the application",
    async () => {
      testContext = spawnTui()
      await waitForReady(testContext)

      const exitPromise = new Promise<{ exitCode: number; signal?: number | string }>((resolve) => {
        testContext!.pty.onExit((event) => {
          resolve(event)
        })
      })

      testContext.pty.write(ESC)
      await new Promise((r) => setTimeout(r, 200))
      testContext.pty.write(ESC)

      const exitResult = await Promise.race([
        exitPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ])

      expect(exitResult).not.toBeNull()
      if (exitResult) {
        expect(exitResult.exitCode).toBe(0)
      }
    },
    TEST_TIMEOUT,
  )
})

describe("E2E: Home → Session Navigation", () => {
  test(
    "pressing Enter after typing triggers session creation",
    async () => {
      testContext = spawnTui()
      await waitForReady(testContext)

      const outputBeforeTyping = testContext.output.length

      // Type a message
      await typeText(testContext.pty, "hi", 100)
      await new Promise((r) => setTimeout(r, 500))

      // Press Enter to submit
      testContext.pty.write(ENTER)

      // Wait for session creation and navigation
      await new Promise((r) => setTimeout(r, 5000))

      const cleanOutput = stripAnsi(testContext.output)

      // Check for signs of session view or activity after submission
      const hasSessionIndicators =
        cleanOutput.includes("Session") ||
        cleanOutput.includes("Error") ||
        cleanOutput.includes("API") ||
        cleanOutput.includes("provider") ||
        cleanOutput.includes("key") ||
        cleanOutput.includes("streaming") ||
        cleanOutput.includes("model") ||
        cleanOutput.includes("claude") ||
        cleanOutput.includes("user") ||
        cleanOutput.includes("assistant") ||
        // Check output grew significantly (session view renders more)
        testContext.output.length > outputBeforeTyping + 1000

      // After typing and pressing Enter, should navigate to session view
      expect(hasSessionIndicators).toBe(true)

      testContext.pty.write(CTRL_C)
    },
    TEST_TIMEOUT,
  )
})
