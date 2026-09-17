import { describe, expect, test } from "bun:test"
import { findDiagnosticSuppressionAnchors } from "../src/diagnostic-suppression-anchor"

const FILE = "packages/core/src/runtime/thing.ts"

// Built from pieces on purpose. Spelled whole, the marker is a real directive
// to the Effect TypeScript plugin, which then reports this line as a
// suppression that has no effect.
const MARKER = `@effect-diagnostics${"-next-line"}`
const SUPPRESSION = `  // ${MARKER} anyUnknownInErrorContext:off`

const messagesOf = (lines: ReadonlyArray<string>, file = FILE): ReadonlyArray<string> =>
  findDiagnosticSuppressionAnchors(file, lines.join("\n")).map((finding) => finding.message)

const linesOf = (lines: ReadonlyArray<string>): ReadonlyArray<number> =>
  findDiagnosticSuppressionAnchors(FILE, lines.join("\n")).map((finding) => finding.line)

describe("diagnostic suppression anchor", () => {
  test("allows a suppression directly above the expression", () => {
    expect(messagesOf([SUPPRESSION, "  const sealed = Effect.suspend(effect)"])).toEqual([])
  })

  test("allows a suppression above a multi-line expression head", () => {
    expect(
      messagesOf([SUPPRESSION, "  Effect.provide(", "    FetchHttpClient.layer,", "  ),"]),
    ).toEqual([])
  })

  test("flags a suppression a formatter detached with a blank line", () => {
    const messages = messagesOf([SUPPRESSION, "", "  const sealed = Effect.suspend(effect)"])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("a blank line")
  })

  test("flags a suppression above closing punctuation alone", () => {
    for (const closer of ["  )", "  )", "  })", "  ],", "  );"]) {
      const messages = messagesOf([SUPPRESSION, closer])
      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain("closing punctuation alone")
    }
  })

  test("flags a suppression above a bare pipe continuation", () => {
    const messages = messagesOf([SUPPRESSION, "  .pipe("])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("bare `.pipe(` continuation")
  })

  test("flags a suppression above a second suppression", () => {
    const messages = messagesOf([SUPPRESSION, SUPPRESSION, "  const x = f()"])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("a second suppression comment")
  })

  test("flags a suppression on the last line of a file", () => {
    const messages = messagesOf([" const x = f()", SUPPRESSION])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("ends the file")
  })

  test("reports the comment's own line", () => {
    expect(linesOf(["const a = 1", "const b = 2", SUPPRESSION, "", "const c = 3"])).toEqual([3])
  })

  test("allows a line that closes one call and opens the next", () => {
    // `}).pipe(` carries the expression, so the diagnostic can land on it.
    expect(messagesOf([SUPPRESSION, "  }).pipe("])).toEqual([])
  })

  test("leaves the file-scoped form alone", () => {
    const fileScoped = `// @effect-diagnostics${" nodeBuiltinImport:off"} -- fixture`
    expect(messagesOf([fileScoped, ""])).toEqual([])
  })

  test("reads source files only", () => {
    expect(messagesOf([SUPPRESSION, ""], "plans/notes.md")).toEqual([])
  })

  test("skips the guard's own source and test, which must spell the marker", () => {
    for (const self of [
      "packages/tooling/src/diagnostic-suppression-anchor.ts",
      "packages/tooling/tests/diagnostic-suppression-anchor.test.ts",
    ]) {
      expect(messagesOf([SUPPRESSION, ""], self)).toEqual([])
    }
  })
})
