import { describe, expect, test } from "bun:test"
import { findUnadmittedChildSessionWriters } from "../src/core-child-session-depth"

const childWriter = `
yield* sessionStorage.createSession(
  new Session({
    id: sessionId,
    parentSessionId: input.parentSessionId,
    parentBranchId: input.parentBranchId,
    createdAt: now,
    updatedAt: now,
  }),
)
`

describe("child-session depth guard", () => {
  test("flags a core writer that nests a session without the shared admission", () => {
    const findings = findUnadmittedChildSessionWriters(
      "packages/core/src/server/session-mutations-live.ts",
      childWriter,
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "packages/core/src/server/session-mutations-live.ts:3",
    ])
    expect(findings[0]?.message).toContain("admitChildSessionDepth")
  })

  test("accepts a writer once the file calls the shared admission", () => {
    const findings = findUnadmittedChildSessionWriters(
      "packages/core/src/server/session-mutations-live.ts",
      `yield* admitChildSessionDepth(input.parentSessionId)\n${childWriter}`,
    )
    expect(findings).toEqual([])
  })

  test("ignores a root session row", () => {
    const findings = findUnadmittedChildSessionWriters(
      "packages/core/src/server/session-mutations-live.ts",
      "new Session({ id, name, createdAt: now, updatedAt: now })",
    )
    expect(findings).toEqual([])
  })

  test("ignores storage readers, test fixtures, and files outside core", () => {
    for (const file of [
      "packages/core/src/storage/schema.ts",
      "packages/core/src/test-utils/index.ts",
      "packages/extensions/src/thread/thread.ts",
      "apps/tui/tests/components/thread-view.test.tsx",
    ]) {
      expect(findUnadmittedChildSessionWriters(file, childWriter)).toEqual([])
    }
  })
})
