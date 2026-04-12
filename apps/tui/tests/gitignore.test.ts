import { describe, test, expect } from "bun:test"
import { parseGitignorePatterns, isGitignored } from "../src/utils/fallback-file-search"

const parse = (gitignore: string) => parseGitignorePatterns(gitignore)
const ignored = (path: string, gitignore: string) => isGitignored(path, parse(gitignore))

describe("gitignore pattern matching", () => {
  describe("simple name (no slash) — matches at any depth", () => {
    const patterns = parse("node_modules")

    test("matches at root", () => {
      expect(isGitignored("node_modules", patterns)).toBe(true)
    })

    test("matches nested", () => {
      expect(isGitignored("packages/core/node_modules", patterns)).toBe(true)
    })

    test("matches files inside at root", () => {
      expect(isGitignored("node_modules/effect/package.json", patterns)).toBe(true)
    })

    test("matches files inside nested", () => {
      expect(isGitignored("packages/core/node_modules/effect/index.js", patterns)).toBe(true)
    })

    test("does not match partial name", () => {
      expect(isGitignored("my_node_modules_backup", patterns)).toBe(false)
    })
  })

  describe("trailing slash — directory pattern", () => {
    const patterns = parse("dist/")

    test("matches directory name at root", () => {
      expect(isGitignored("dist", patterns)).toBe(true)
    })

    test("matches files inside at root", () => {
      expect(isGitignored("dist/bundle.js", patterns)).toBe(true)
    })

    test("matches nested directory", () => {
      expect(isGitignored("packages/core/dist", patterns)).toBe(true)
    })

    test("matches files inside nested", () => {
      expect(isGitignored("packages/core/dist/index.js", patterns)).toBe(true)
    })
  })

  describe("leading slash — anchored to root", () => {
    test("matches at root", () => {
      expect(ignored("build", "/build")).toBe(true)
    })

    test("matches files inside root dir", () => {
      expect(ignored("build/output.js", "/build")).toBe(true)
    })

    test("does not match nested", () => {
      expect(ignored("packages/build", "/build")).toBe(false)
    })

    test("does not match nested contents", () => {
      expect(ignored("packages/build/output.js", "/build")).toBe(false)
    })
  })

  describe("path with slash — anchored pattern", () => {
    test("matches exact path", () => {
      expect(ignored("packages/dist", "packages/dist")).toBe(true)
    })

    test("matches files inside", () => {
      expect(ignored("packages/dist/bundle.js", "packages/dist")).toBe(true)
    })

    test("does not match at different depth", () => {
      expect(ignored("other/packages/dist", "packages/dist")).toBe(false)
    })
  })

  describe("glob patterns", () => {
    test("*.log matches at root", () => {
      expect(ignored("error.log", "*.log")).toBe(true)
    })

    test("*.log matches nested", () => {
      expect(ignored("logs/error.log", "*.log")).toBe(true)
    })

    test("*.log does not match non-log", () => {
      expect(ignored("error.txt", "*.log")).toBe(false)
    })
  })

  describe("comments and blank lines", () => {
    test("comments are ignored", () => {
      const patterns = parse("# this is a comment\nnode_modules")
      expect(patterns.length).toBeGreaterThan(0)
      expect(isGitignored("node_modules", patterns)).toBe(true)
    })

    test("blank lines are ignored", () => {
      const patterns = parse("\n\nnode_modules\n\n")
      expect(isGitignored("node_modules", patterns)).toBe(true)
    })

    test("negation patterns are skipped", () => {
      const patterns = parse("*.log\n!important.log")
      // negation not supported — important.log still matches *.log
      expect(isGitignored("important.log", patterns)).toBe(true)
    })
  })

  describe("dotfiles", () => {
    test(".env matches", () => {
      expect(ignored(".env", ".env")).toBe(true)
    })

    test(".env.local matches", () => {
      expect(ignored(".env.local", ".env.local")).toBe(true)
    })
  })

  describe("real-world .gitignore", () => {
    const gitignore = `
# dependencies
node_modules
.bun

# build
dist/
*.tsbuildinfo

# env
.env
.env.local

# logs
*.log

# IDE
.idea/
`
    const patterns = parse(gitignore)

    test("node_modules at root", () => {
      expect(isGitignored("node_modules/effect/index.js", patterns)).toBe(true)
    })

    test("node_modules nested in monorepo", () => {
      expect(isGitignored("packages/core/node_modules/effect/index.js", patterns)).toBe(true)
    })

    test("dist output", () => {
      expect(isGitignored("packages/core/dist/index.js", patterns)).toBe(true)
    })

    test("tsbuildinfo", () => {
      expect(isGitignored("packages/core/tsconfig.tsbuildinfo", patterns)).toBe(true)
    })

    test(".env at root", () => {
      expect(isGitignored(".env", patterns)).toBe(true)
    })

    test("log files", () => {
      expect(isGitignored("server.log", patterns)).toBe(true)
    })

    test(".idea directory", () => {
      expect(isGitignored(".idea/workspace.xml", patterns)).toBe(true)
    })

    test("source files NOT ignored", () => {
      expect(isGitignored("packages/core/src/index.ts", patterns)).toBe(false)
    })

    test("package.json NOT ignored", () => {
      expect(isGitignored("package.json", patterns)).toBe(false)
    })

    test("README NOT ignored", () => {
      expect(isGitignored("README.md", patterns)).toBe(false)
    })
  })
})
