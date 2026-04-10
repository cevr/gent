/**
 * Boundary enforcement — builtin extensions must not import internal modules.
 *
 * Extensions should use the typed extension API (domain types, extensions/api,
 * protocol files) instead of reaching into runtime/, storage/, or server/.
 *
 * Allowlist: extensions/api.ts is the builder implementation and legitimately
 * imports runtime internals to wire the extension lifecycle.
 */

import { describe, test, expect } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const EXTENSIONS_DIR = join(import.meta.dir, "../../src/extensions")

const FORBIDDEN_PATTERNS = [
  /from\s+["']\.\.\/runtime\//,
  /from\s+["']\.\.\/storage\//,
  /from\s+["']\.\.\/server\//,
  /from\s+["']\.\.\/\.\.\/runtime\//,
  /from\s+["']\.\.\/\.\.\/storage\//,
  /from\s+["']\.\.\/\.\.\/server\//,
]

/** Files that legitimately need internal imports */
const ALLOWLIST = new Set(["api.ts"])

const collectTsFiles = (dir: string): string[] => {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectTsFiles(full))
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      results.push(full)
    }
  }
  return results
}

describe("Extension import boundary", () => {
  const files = collectTsFiles(EXTENSIONS_DIR)

  test("no extension files import from runtime/, storage/, or server/", () => {
    const violations: Array<{ file: string; line: number; import: string }> = []

    for (const file of files) {
      const rel = relative(EXTENSIONS_DIR, file)
      // Top-level file name for allowlist check
      const topFile = rel.split("/")[0]!
      if (ALLOWLIST.has(topFile)) continue

      const content = readFileSync(file, "utf8")
      const lines = content.split("\n")

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            violations.push({
              file: rel,
              line: i + 1,
              import: line.trim(),
            })
          }
        }
      }
    }

    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line} — ${v.import}`).join("\n")
      expect.unreachable(
        `Extension files must not import from runtime/, storage/, or server/.\n\nViolations:\n${report}\n\nFix: use the typed extension API (domain types, extensions/api, protocol files) instead.`,
      )
    }
  })

  test("extensions directory has files to check", () => {
    expect(files.length).toBeGreaterThan(10)
  })
})
