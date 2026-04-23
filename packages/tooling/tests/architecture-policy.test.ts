import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { extname, join, resolve as pathResolve } from "node:path"

const ROOT = pathResolve(import.meta.dir, "..", "..", "..")
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"])
const SOURCE_ROOTS = [
  "packages/core/src",
  "packages/extensions/src",
  "packages/sdk/src",
  "apps/server/src",
  "apps/tui/src",
] as const

const walkFiles = (dir: string): ReadonlyArray<string> => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath))
      continue
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue
    out.push(fullPath)
  }
  return out
}

const collectSourceFiles = (): ReadonlyArray<string> =>
  SOURCE_ROOTS.flatMap((dir) => walkFiles(pathResolve(ROOT, dir)))

const sourceLines = (file: string): ReadonlyArray<{ line: number; text: string }> =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))

const isCommentLine = (text: string) => {
  const trimmed = text.trim()
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("*/")
  )
}

describe("architecture policy", () => {
  test("owned source shapes do not reintroduce `_kind` discriminators", () => {
    const violations = collectSourceFiles().flatMap((file) =>
      sourceLines(file)
        .filter(({ text }) => !isCommentLine(text))
        .filter(
          ({ text }) => /(?:readonly\s+)?_kind\s*:/.test(text) || /["']_kind["']\s*:/.test(text),
        )
        .map(({ line, text }) => `${file.slice(ROOT.length + 1)}:${line} ${text.trim()}`),
    )

    expect(violations).toEqual([])
  })

  test("production source does not use placeholder ToolContext casts", () => {
    const violations = collectSourceFiles().flatMap((file) =>
      sourceLines(file)
        .filter(({ text }) =>
          /as(?:\s+unknown)?\s+as\s+ToolContext\b|as\s+ToolContext\b/.test(text),
        )
        .map(({ line, text }) => `${file.slice(ROOT.length + 1)}:${line} ${text.trim()}`),
    )

    expect(violations).toEqual([])
  })

  test("turn-control stays a command membrane, not a mutable public bridge", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/extensions/turn-control.ts")
    const source = readFileSync(file, "utf8")
    const serviceMatch = source.match(
      /export interface ExtensionTurnControlService \{([\s\S]*?)\n\}/,
    )

    expect(serviceMatch).not.toBeNull()

    const body = serviceMatch?.[1] ?? ""
    expect(body).toContain("queueFollowUp")
    expect(body).toContain("interject")
    expect(body).toContain("commands")
    expect(body).not.toMatch(/\breadonly\s+(queue|state|ref|set|offer|take|enqueue)\b/)
  })
})
