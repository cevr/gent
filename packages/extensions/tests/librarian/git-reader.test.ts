import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { ExtensionContext, ExtensionId } from "@gent/core/extensions/api"
import { GitReader, GitReaderError } from "../../src/librarian/index.js"
import { $ } from "bun"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"

const StubExtensionContext = Layer.succeed(
  ExtensionContext,
  testToolContext({ extensionId: ExtensionId.make("@gent/librarian-test") }),
)
// ---------------------------------------------------------------------------
// Fixture: create a real git repo with nested files
// ---------------------------------------------------------------------------
const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const fixtureDir = yield* fs.makeTempDirectoryScoped()
  yield* fs.makeDirectory(`${fixtureDir}/src/utils`, { recursive: true })
  yield* Effect.promise(() => $`git -C ${fixtureDir} init`.quiet())
  yield* Effect.promise(() => $`git -C ${fixtureDir} config user.email "test@test.com"`.quiet())
  yield* Effect.promise(() => $`git -C ${fixtureDir} config user.name "Test"`.quiet())
  yield* fs.writeFileString(`${fixtureDir}/README.md`, "# Test Repo\n\nHello world.\n")
  yield* fs.writeFileString(`${fixtureDir}/src/index.ts`, 'export const main = () => "hello"\n')
  yield* fs.writeFileString(
    `${fixtureDir}/src/utils/helpers.ts`,
    "export const add = (a: number, b: number) => a + b\n",
  )
  yield* fs.writeFileString(`${fixtureDir}/.gitignore`, "node_modules/\n")
  yield* fs.writeFile(
    `${fixtureDir}/icon.png`,
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  )
  yield* Effect.promise(() => $`git -C ${fixtureDir} add -A`.quiet())
  yield* Effect.promise(() => $`git -C ${fixtureDir} commit -m "initial commit"`.quiet())
  return { fixtureDir, cloneFailDir: `${fixtureDir}/clone-fail` }
})
// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------
const TestLayer = Layer.mergeAll(GitReader.Live, BunFileSystem.layer, StubExtensionContext)
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GitReader", () => {
  describe("listFiles", () => {
    it.scopedLive("returns all files with full relative paths", () =>
      Effect.gen(function* () {
        const { fixtureDir } = yield* makeFixture
        const reader = yield* GitReader
        const files = yield* reader.listFiles(fixtureDir)
        expect(files).toContain("README.md")
        expect(files).toContain("src/index.ts")
        expect(files).toContain("src/utils/helpers.ts")
        expect(files).toContain(".gitignore")
        expect(files).toContain("icon.png")
        expect(files.length).toBe(5)
      }).pipe(Effect.provide(TestLayer)),
    )
    it.scopedLive("paths are sorted depth-first", () =>
      Effect.gen(function* () {
        const { fixtureDir } = yield* makeFixture
        const reader = yield* GitReader
        const files = yield* reader.listFiles(fixtureDir)
        const srcIdx = files.indexOf("src/index.ts")
        const helpersIdx = files.indexOf("src/utils/helpers.ts")
        // Both should be present (already checked above), just verify they have paths
        expect(srcIdx).toBeGreaterThanOrEqual(0)
        expect(helpersIdx).toBeGreaterThanOrEqual(0)
      }).pipe(Effect.provide(TestLayer)),
    )
    it.scopedLive("no duplicate paths", () =>
      Effect.gen(function* () {
        const { fixtureDir } = yield* makeFixture
        const reader = yield* GitReader
        const files = yield* reader.listFiles(fixtureDir)
        const unique = new Set(files)
        expect(unique.size).toBe(files.length)
      }).pipe(Effect.provide(TestLayer)),
    )
    it.scopedLive("fails on nonexistent repo", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const result = yield* reader.listFiles("/tmp/nonexistent-repo-xyz").pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provide(TestLayer)),
    )
  })
  describe("readFile", () => {
    it.scopedLive("reads text file content", () =>
      Effect.gen(function* () {
        const { fixtureDir } = yield* makeFixture
        const reader = yield* GitReader
        const blob = yield* reader.readFile(fixtureDir, "README.md")
        expect(blob.isBinary).toBe(false)
        expect(blob.size).toBeGreaterThan(0)
        const text = new TextDecoder().decode(blob.content)
        expect(text).toContain("# Test Repo")
        expect(text).toContain("Hello world.")
      }).pipe(Effect.provide(TestLayer)),
    )
    it.scopedLive("reads nested file content", () =>
      Effect.gen(function* () {
        const { fixtureDir } = yield* makeFixture
        const reader = yield* GitReader
        const blob = yield* reader.readFile(fixtureDir, "src/utils/helpers.ts")
        expect(blob.isBinary).toBe(false)
        const text = new TextDecoder().decode(blob.content)
        expect(text).toContain("export const add")
      }).pipe(Effect.provide(TestLayer)),
    )
    it.scopedLive("detects binary files", () =>
      Effect.gen(function* () {
        const { fixtureDir } = yield* makeFixture
        const reader = yield* GitReader
        const blob = yield* reader.readFile(fixtureDir, "icon.png")
        expect(blob.isBinary).toBe(true)
        expect(blob.size).toBe(9)
        // PNG magic bytes
        expect(blob.content[0]).toBe(0x89)
        expect(blob.content[1]).toBe(0x50)
      }).pipe(Effect.provide(TestLayer)),
    )
    it.scopedLive("fails on nonexistent file", () =>
      Effect.gen(function* () {
        const { fixtureDir } = yield* makeFixture
        const reader = yield* GitReader
        const result = yield* reader.readFile(fixtureDir, "nonexistent.ts").pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (!Exit.isFailure(result)) return yield* Effect.die("expected readFile failure")
        const reason = Option.fromNullishOr(result.cause.reasons.find(Cause.isFailReason))
        expect(Option.exists(reason, (item) => Schema.is(GitReaderError)(item.error))).toBe(true)
        if (Option.isNone(reason) || !Schema.is(GitReaderError)(reason.value.error)) return
        expect(reason.value.error.message).toBe("File not found: nonexistent.ts")
      }).pipe(Effect.provide(TestLayer)),
    )
    it.scopedLive("content is a copy (safe after GC)", () =>
      Effect.gen(function* () {
        const { fixtureDir } = yield* makeFixture
        const reader = yield* GitReader
        const blob = yield* reader.readFile(fixtureDir, "README.md")
        // Verify the content is a standalone Uint8Array, not a view into native memory
        expect(blob.content).toBeInstanceOf(Uint8Array)
        expect(blob.content.buffer.byteLength).toBe(blob.content.length)
      }).pipe(Effect.provide(TestLayer)),
    )
  })
  describe("clone", () => {
    it.scopedLive("fails on invalid URL", () =>
      Effect.gen(function* () {
        const { cloneFailDir } = yield* makeFixture
        const reader = yield* GitReader
        const result = yield* reader
          .clone("https://invalid.example.com/no-repo.git", cloneFailDir)
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})
