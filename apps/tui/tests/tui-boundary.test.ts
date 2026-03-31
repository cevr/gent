import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

test("production TUI shell does not import app runtime wiring directly", () => {
  const mainSource = fs.readFileSync(path.resolve(import.meta.dir, "../src/main.tsx"), "utf8")

  expect(mainSource).not.toContain("@gent/core/server/dependencies.js")
  expect(mainSource).not.toContain("@gent/core/server/index.js")
  expect(mainSource).not.toContain("@gent/core/debug/session.js")
  expect(mainSource).not.toContain("makeDirectGentClient")
  expect(mainSource).not.toContain("run-debug-app")
  expect(mainSource).toContain("Gent.spawn")
  expect(mainSource).toContain('mode: debug ? "debug" : "default"')
})
