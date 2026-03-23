import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "..")

const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8")

test("mock-only client context tests point transport behavior at seam suites", () => {
  const source = read("apps/tui/tests/client-context.test.ts")

  expect(source).toContain("This file is intentionally mock-only.")
  expect(source).toContain("tests/transport-contract.test.ts")
  expect(source).toContain("tests/event-stream-parity.test.ts")
  expect(source).toContain("tests/queue-contract.test.ts")
  expect(source).toContain("apps/tui/tests/session-feed-boundary.test.tsx")
  expect(source).toContain("apps/tui/tests/worker-supervisor.test.ts")
  expect(source).not.toContain("startWorkerSupervisor")
  expect(source).not.toContain("transport-harness")
})

test("real seam suites exist for transport, queue, feed, and worker boundaries", () => {
  expect(fs.existsSync(path.join(repoRoot, "tests/transport-contract.test.ts"))).toBe(true)
  expect(fs.existsSync(path.join(repoRoot, "tests/event-stream-parity.test.ts"))).toBe(true)
  expect(fs.existsSync(path.join(repoRoot, "tests/queue-contract.test.ts"))).toBe(true)
  expect(fs.existsSync(path.join(repoRoot, "apps/tui/tests/session-feed-boundary.test.tsx"))).toBe(
    true,
  )
  expect(fs.existsSync(path.join(repoRoot, "apps/tui/tests/worker-supervisor.test.ts"))).toBe(true)
})
