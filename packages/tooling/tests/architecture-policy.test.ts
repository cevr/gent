import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
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

  test("turn-control, if still present, does not leak mutable public handles", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/extensions/turn-control.ts")
    if (!existsSync(file)) {
      expect(true).toBe(true)
      return
    }
    const source = readFileSync(file, "utf8")
    const serviceMatch = source.match(
      /export interface ExtensionTurnControlService \{([\s\S]*?)\n\}/,
    )

    expect(serviceMatch).not.toBeNull()

    const body = serviceMatch?.[1] ?? ""
    expect(body).not.toMatch(/\breadonly\s+(queue|state|ref|set|offer|take|enqueue)\b/)
    expect(source).not.toMatch(/\bexport const\s+(Queue|MutableQueue|QueueRef|TurnControlRef)\b/)
  })

  test("SessionRuntime public surface does not expose direct turn execution", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/session-runtime.ts")
    const source = readFileSync(file, "utf8")
    const serviceMatch = source.match(/export interface SessionRuntimeService \{([\s\S]*?)\n\}/)

    expect(serviceMatch).not.toBeNull()

    const body = serviceMatch?.[1] ?? ""
    expect(body).not.toMatch(/\brunOnce\b/)
  })

  test("SessionProfileCache public surface does not expose speculative cache reads", () => {
    const file = pathResolve(ROOT, "packages/core/src/runtime/session-profile.ts")
    const source = readFileSync(file, "utf8")
    const serviceMatch = source.match(
      /export interface SessionProfileCacheService \{([\s\S]*?)\n\}/,
    )

    expect(serviceMatch).not.toBeNull()

    const body = serviceMatch?.[1] ?? ""
    expect(body).not.toMatch(/\bpeek\b/)
  })

  test("composition roots share the profile runtime helper", () => {
    const files = [
      pathResolve(ROOT, "packages/core/src/server/dependencies.ts"),
      pathResolve(ROOT, "packages/core/src/runtime/session-profile.ts"),
    ]

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      expect(source).toMatch(/\bresolveProfileRuntime\b/)
      expect(source).not.toMatch(/\bresolveRuntimeProfile\b/)
      expect(source).not.toMatch(/\bbuildExtensionLayers\b/)
      expect(source).not.toMatch(/\bcompileBaseSections\b/)
    }
  })

  test("machine mailbox ownership is not exported as shared extension context", () => {
    const sharedSource = readFileSync(
      pathResolve(ROOT, "packages/core/src/runtime/extensions/extension-actor-shared.ts"),
      "utf8",
    )
    expect(sharedSource).not.toMatch(/\bCurrentMailboxSession\b/)

    const violations = collectSourceFiles()
      .filter(
        (file) =>
          !file.endsWith("packages/core/src/runtime/extensions/resource-host/machine-engine.ts"),
      )
      .flatMap((file) =>
        sourceLines(file)
          .filter(({ text }) => !isCommentLine(text))
          .filter(({ text }) => /\bCurrentMailboxSession\b/.test(text))
          .map(({ line, text }) => `${file.slice(ROOT.length + 1)}:${line} ${text.trim()}`),
      )

    expect(violations).toEqual([])
  })

  test("public extension api does not re-export runtime or server internals", () => {
    const source = readFileSync(pathResolve(ROOT, "packages/core/src/extensions/api.ts"), "utf8")

    expect(source).not.toMatch(/\bMachineEngine\b/)
    expect(source).not.toMatch(/\bMachineExecute\b/)
    expect(source).not.toMatch(/\bToolRunner\b/)
    expect(source).not.toMatch(/\bInteractionPendingReader\b/)
    expect(source).not.toMatch(/\bEventPublisher\b/)
    expect(source).not.toMatch(/\.\.\/runtime\//)
  })
})
