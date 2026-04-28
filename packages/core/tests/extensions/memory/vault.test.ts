import { describe, test, expect, it } from "effect-bun-test"
import { beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import * as Fs from "node:fs"
import * as Path from "node:path"
import * as Os from "node:os"
import {
  makeMemoryVault,
  parseFrontmatter,
  serializeFrontmatter,
  projectKey,
  projectDisplayName,
  type MemoryFrontmatter,
} from "@gent/extensions/memory/vault"
let tmpDir: string
beforeEach(() => {
  tmpDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "gent-vault-test-"))
})
afterEach(() => {
  Fs.rmSync(tmpDir, { recursive: true, force: true })
})
const makeFm = (scope: "global" | "project" = "global"): MemoryFrontmatter => ({
  scope,
  tags: ["test"],
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-01T00:00:00Z",
  source: "agent",
})
describe("MemoryVault", () => {
  it.live("write + read roundtrip", () =>
    Effect.gen(function* () {
      const vault = makeMemoryVault(tmpDir)
      yield* Effect.gen(function* () {
        yield* vault.ensureDirs()
        yield* vault.write("global/test-topic.md", makeFm(), "# Test Topic\n\nSome content.")
        const content = yield* vault.read("global/test-topic.md")
        expect(content).toContain("# Test Topic")
        expect(content).toContain("Some content.")
        expect(content).toContain("scope: global")
      })
    }),
  )
  it.live("write creates parent directories", () =>
    Effect.gen(function* () {
      const vault = makeMemoryVault(tmpDir)
      yield* vault.write(
        "project/my-proj-abc123/deep-topic.md",
        makeFm("project"),
        "# Deep\n\nNested.",
      )
      expect(Fs.existsSync(Path.join(tmpDir, "project/my-proj-abc123/deep-topic.md"))).toBe(true)
    }),
  )
  it.live("list returns entries with parsed frontmatter", () =>
    Effect.gen(function* () {
      const vault = makeMemoryVault(tmpDir)
      yield* Effect.gen(function* () {
        yield* vault.ensureDirs()
        yield* vault.write("global/alpha.md", makeFm(), "# Alpha\n\nFirst entry.")
        yield* vault.write("global/beta.md", makeFm(), "# Beta\n\nSecond entry.")
        const entries = yield* vault.list("global")
        expect(entries.length).toBe(2)
        expect(entries.map((e) => e.title).sort()).toEqual(["Alpha", "Beta"])
        expect(entries[0]!.frontmatter.scope).toBe("global")
      })
    }),
  )
  it.live("list filters by scope", () =>
    Effect.gen(function* () {
      const vault = makeMemoryVault(tmpDir)
      yield* Effect.gen(function* () {
        yield* vault.ensureDirs("test-proj-aaa111")
        yield* vault.write("global/g1.md", makeFm(), "# Global One\n\nG.")
        yield* vault.write(
          "project/test-proj-aaa111/p1.md",
          makeFm("project"),
          "# Project One\n\nP.",
        )
        const globalOnly = yield* vault.list("global")
        const projectOnly = yield* vault.list("project", "test-proj-aaa111")
        expect(globalOnly.length).toBe(1)
        expect(projectOnly.length).toBe(1)
        expect(globalOnly[0]!.title).toBe("Global One")
        expect(projectOnly[0]!.title).toBe("Project One")
      })
    }),
  )
  it.live("remove deletes file and rebuilds index", () =>
    Effect.gen(function* () {
      const vault = makeMemoryVault(tmpDir)
      yield* Effect.gen(function* () {
        yield* vault.ensureDirs()
        yield* vault.write("global/ephemeral.md", makeFm(), "# Ephemeral\n\nGone soon.")
        let entries = yield* vault.list("global")
        expect(entries.length).toBe(1)
        yield* vault.remove("global/ephemeral.md")
        entries = yield* vault.list("global")
        expect(entries.length).toBe(0)
      })
    }),
  )
  it.live("search finds by title", () =>
    Effect.gen(function* () {
      const vault = makeMemoryVault(tmpDir)
      yield* Effect.gen(function* () {
        yield* vault.ensureDirs()
        yield* vault.write("global/typescript.md", makeFm(), "# TypeScript Patterns\n\nUse Effect.")
        yield* vault.write("global/rust.md", makeFm(), "# Rust Notes\n\nOwnership rules.")
        const results = yield* vault.search("typescript")
        expect(results.length).toBe(1)
        expect(results[0]!.title).toBe("TypeScript Patterns")
      })
    }),
  )
  it.live("search finds by content", () =>
    Effect.gen(function* () {
      const vault = makeMemoryVault(tmpDir)
      yield* Effect.gen(function* () {
        yield* vault.ensureDirs()
        yield* vault.write("global/api.md", makeFm(), "# API Design\n\nAlways use snake_case.")
        const results = yield* vault.search("snake_case")
        expect(results.length).toBe(1)
      })
    }),
  )
  it.live("rebuildIndex creates scope and root indexes", () =>
    Effect.gen(function* () {
      const vault = makeMemoryVault(tmpDir)
      yield* Effect.gen(function* () {
        yield* vault.ensureDirs()
        yield* vault.write("global/topic-a.md", makeFm(), "# Topic A\n\nContent A.")
        // Index should have been rebuilt by write
        const rootIndex = Fs.readFileSync(Path.join(tmpDir, "index.md"), "utf-8")
        const scopeIndex = Fs.readFileSync(Path.join(tmpDir, "global/index.md"), "utf-8")
        expect(rootIndex).toContain("Topic A")
        expect(scopeIndex).toContain("Topic A")
      })
    }),
  )
})
describe("parseFrontmatter", () => {
  test("parses valid frontmatter", () => {
    const content = `---
scope: global
tags: [test, memory]
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
source: agent
---

# My Title

Body content.`
    const result = parseFrontmatter(content)
    expect(result).toBeDefined()
    expect(result!.frontmatter.scope).toBe("global")
    expect(result!.frontmatter.tags).toEqual(["test", "memory"])
    expect(result!.frontmatter.source).toBe("agent")
    expect(result!.body).toContain("# My Title")
  })
  test("returns undefined for no frontmatter", () => {
    expect(parseFrontmatter("# Just a title\n\nNo frontmatter.")).toBeUndefined()
  })
})
describe("serializeFrontmatter", () => {
  test("roundtrips", () => {
    const fm = makeFm()
    const serialized = serializeFrontmatter(fm)
    expect(serialized).toContain("scope: global")
    expect(serialized).toContain("tags: [test]")
    expect(serialized).toContain("source: agent")
    const parsed = parseFrontmatter(serialized + "\n\n# Title\n\nBody")
    expect(parsed).toBeDefined()
    expect(parsed!.frontmatter.scope).toBe("global")
  })
})
describe("projectKey", () => {
  test("produces slug with hash suffix", () => {
    const key = projectKey("/Users/dev/projects/my-app")
    expect(key).toMatch(/^my-app-[a-f0-9]{6}$/)
  })
  test("different paths produce different keys", () => {
    const k1 = projectKey("/Users/dev/work/api")
    const k2 = projectKey("/Users/dev/personal/api")
    expect(k1).not.toBe(k2)
  })
})
describe("projectDisplayName", () => {
  test("strips hash suffix", () => {
    expect(projectDisplayName("my-app-abc123")).toBe("my-app")
  })
})
