import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "..")

test("production TUI shell does not import app runtime wiring directly", () => {
  const mainSource = fs.readFileSync(path.join(repoRoot, "apps/tui/src/main.tsx"), "utf8")

  expect(mainSource).not.toContain("@gent/core/server/dependencies.js")
  expect(mainSource).not.toContain("@gent/core/server/index.js")
  expect(mainSource).not.toContain("@gent/core/debug/session.js")
  expect(mainSource).not.toContain("makeDirectGentClient")
  expect(mainSource).toContain("startWorkerSupervisor")
  expect(mainSource).toContain('import("./debug/run-debug-app")')
})
