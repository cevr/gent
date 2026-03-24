import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { discoverTuiExtensions } from "../src/extensions/discovery"

const TEST_DIR = join(import.meta.dir, ".tmp-ext-discovery")
const USER_DIR = join(TEST_DIR, "user")
const PROJECT_DIR = join(TEST_DIR, "project")

beforeAll(() => {
  // Set up test directories
  mkdirSync(join(USER_DIR), { recursive: true })
  mkdirSync(join(PROJECT_DIR), { recursive: true })

  // User scope: single-file client extensions
  writeFileSync(join(USER_DIR, "my-tool.client.tsx"), "export default {}")
  writeFileSync(join(USER_DIR, "other.client.ts"), "export default {}")
  writeFileSync(join(USER_DIR, "server-only.ts"), "export default {}") // should NOT be discovered

  // User scope: directory with client.tsx
  mkdirSync(join(USER_DIR, "my-ext"), { recursive: true })
  writeFileSync(join(USER_DIR, "my-ext", "index.ts"), "export default {}") // server, not client
  writeFileSync(join(USER_DIR, "my-ext", "client.tsx"), "export default {}") // client

  // Project scope
  writeFileSync(join(PROJECT_DIR, "override.client.tsx"), "export default {}")

  // Project scope: .mjs client
  writeFileSync(join(PROJECT_DIR, "prebuilt.client.mjs"), "export default {}")

  // Things that should be skipped
  mkdirSync(join(USER_DIR, "__tests__"), { recursive: true })
  writeFileSync(join(USER_DIR, "__tests__", "test.client.tsx"), "export default {}")
  writeFileSync(join(USER_DIR, ".hidden.client.tsx"), "export default {}")
  writeFileSync(join(USER_DIR, "_internal.client.tsx"), "export default {}")
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe("discoverTuiExtensions", () => {
  test("discovers single-file client extensions", () => {
    const results = discoverTuiExtensions({ userDir: USER_DIR, projectDir: PROJECT_DIR })
    const userPaths = results.filter((r) => r.kind === "user").map((r) => r.filePath)
    expect(userPaths).toContain(join(USER_DIR, "my-tool.client.tsx"))
    expect(userPaths).toContain(join(USER_DIR, "other.client.ts"))
  })

  test("discovers client.tsx in subdirectories", () => {
    const results = discoverTuiExtensions({ userDir: USER_DIR, projectDir: PROJECT_DIR })
    const userPaths = results.filter((r) => r.kind === "user").map((r) => r.filePath)
    expect(userPaths).toContain(join(USER_DIR, "my-ext", "client.tsx"))
  })

  test("ignores server extension files", () => {
    const results = discoverTuiExtensions({ userDir: USER_DIR, projectDir: PROJECT_DIR })
    const allPaths = results.map((r) => r.filePath)
    expect(allPaths).not.toContain(join(USER_DIR, "server-only.ts"))
    expect(allPaths).not.toContain(join(USER_DIR, "my-ext", "index.ts"))
  })

  test("tags user and project extensions correctly", () => {
    const results = discoverTuiExtensions({ userDir: USER_DIR, projectDir: PROJECT_DIR })
    const user = results.filter((r) => r.kind === "user")
    const project = results.filter((r) => r.kind === "project")
    expect(user.length).toBeGreaterThan(0)
    expect(project.length).toBeGreaterThan(0)
    expect(project.some((r) => r.filePath.includes("override.client.tsx"))).toBe(true)
  })

  test("discovers .mjs client files", () => {
    const results = discoverTuiExtensions({ userDir: USER_DIR, projectDir: PROJECT_DIR })
    const projectPaths = results.filter((r) => r.kind === "project").map((r) => r.filePath)
    expect(projectPaths).toContain(join(PROJECT_DIR, "prebuilt.client.mjs"))
  })

  test("skips hidden files, _ prefixed, and __tests__", () => {
    const results = discoverTuiExtensions({ userDir: USER_DIR, projectDir: PROJECT_DIR })
    const allPaths = results.map((r) => r.filePath)
    expect(allPaths).not.toContain(join(USER_DIR, "__tests__", "test.client.tsx"))
    expect(allPaths).not.toContain(join(USER_DIR, ".hidden.client.tsx"))
    expect(allPaths).not.toContain(join(USER_DIR, "_internal.client.tsx"))
  })

  test("returns empty for nonexistent directories", () => {
    const results = discoverTuiExtensions({
      userDir: "/nonexistent/a",
      projectDir: "/nonexistent/b",
    })
    expect(results.length).toBe(0)
  })

  test("results are sorted within each scope", () => {
    const results = discoverTuiExtensions({ userDir: USER_DIR, projectDir: PROJECT_DIR })
    const userPaths = results.filter((r) => r.kind === "user").map((r) => r.filePath)
    const sorted = [...userPaths].sort()
    expect(userPaths).toEqual(sorted)
  })
})
