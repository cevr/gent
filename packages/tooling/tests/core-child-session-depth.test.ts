import { describe, expect, test } from "bun:test"
import { findUnadmittedChildSessionWriters } from "../src/guards"

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
      "packages/core/src/server/server.ts",
      childWriter,
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "packages/core/src/server/server.ts:3",
    ])
    expect(findings[0]?.message).toContain("admitChildSessionDepth")
  })

  test("accepts a writer once the file calls the shared admission", () => {
    const findings = findUnadmittedChildSessionWriters(
      "packages/core/src/server/server.ts",
      `yield* admitChildSessionDepth(input.parentSessionId)\n${childWriter}`,
    )
    expect(findings).toEqual([])
  })

  test("flags a writer in runtime/session.ts whose own declaration never admits", () => {
    const text = [
      "export const admitChildSessionDepth = Effect.fn(function* (parentSessionId) {",
      "  yield* admitChildSessionDepth(parentSessionId)",
      "})",
      "",
      "export const forkSession = Effect.fn(function* (input) {",
      childWriter,
      "})",
    ].join("\n")
    const findings = findUnadmittedChildSessionWriters("packages/core/src/runtime/session.ts", text)
    expect(findings.map((finding) => finding.line)).toEqual([8])
  })

  test("an admission in an earlier declaration does not cover a later writer", () => {
    const text = `export const admitted = Effect.fn(function* () {\n  yield* admitChildSessionDepth(id)\n})\n\nexport const unadmitted = Effect.fn(function* () {${childWriter}})`
    const findings = findUnadmittedChildSessionWriters("packages/core/src/server/server.ts", text)
    expect(findings).toHaveLength(1)
  })

  test("ignores a root session row", () => {
    const findings = findUnadmittedChildSessionWriters(
      "packages/core/src/server/server.ts",
      "new Session({ id, name, createdAt: now, updatedAt: now })",
    )
    expect(findings).toEqual([])
  })

  test("ignores storage readers, test fixtures, and files outside core", () => {
    for (const file of [
      "packages/core/src/storage/schema.ts",
      "packages/core/src/test-utils/index.ts",
      "packages/extensions/src/thread/thread.ts",
      "apps/tui/tests/extensions/thread-view.client.test.tsx",
    ]) {
      expect(findUnadmittedChildSessionWriters(file, childWriter)).toEqual([])
    }
  })
})
