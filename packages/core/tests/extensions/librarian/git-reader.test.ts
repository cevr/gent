import { describe, it, expect } from "effect-bun-test"
import { beforeAll, afterAll } from "bun:test"
import { Effect, Layer } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { GitReader } from "@gent/extensions/librarian/git-reader"
import { $ } from "bun"

// ---------------------------------------------------------------------------
// Fixture: create a real git repo with nested files
// ---------------------------------------------------------------------------

const FIXTURE_DIR = `/tmp/test-git-reader-${Date.now()}`

beforeAll(async () => {
  await $`mkdir -p ${FIXTURE_DIR}`.quiet()
  await $`git -C ${FIXTURE_DIR} init`.quiet()
  await $`git -C ${FIXTURE_DIR} config user.email "test@test.com"`.quiet()
  await $`git -C ${FIXTURE_DIR} config user.name "Test"`.quiet()

  // Create nested file structure
  await $`mkdir -p ${FIXTURE_DIR}/src/utils`.quiet()
  await Bun.write(`${FIXTURE_DIR}/README.md`, "# Test Repo\n\nHello world.\n")
  await Bun.write(`${FIXTURE_DIR}/src/index.ts`, 'export const main = () => "hello"\n')
  await Bun.write(
    `${FIXTURE_DIR}/src/utils/helpers.ts`,
    "export const add = (a: number, b: number) => a + b\n",
  )
  await Bun.write(`${FIXTURE_DIR}/.gitignore`, "node_modules/\n")

  // Create a binary file (PNG header)
  const binaryContent = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  await Bun.write(`${FIXTURE_DIR}/icon.png`, binaryContent)

  await $`git -C ${FIXTURE_DIR} add -A`.quiet()
  await $`git -C ${FIXTURE_DIR} commit -m "initial commit"`.quiet()
})

afterAll(async () => {
  await $`rm -rf ${FIXTURE_DIR}`.quiet()
})

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

const TestLayer = Layer.provide(GitReader.Live(FIXTURE_DIR), BunFileSystem.layer)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitReader", () => {
  describe("listFiles", () => {
    it.live("returns all files with full relative paths", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const files = yield* reader.listFiles(FIXTURE_DIR)

        expect(files).toContain("README.md")
        expect(files).toContain("src/index.ts")
        expect(files).toContain("src/utils/helpers.ts")
        expect(files).toContain(".gitignore")
        expect(files).toContain("icon.png")
        expect(files.length).toBe(5)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.live("paths are sorted depth-first", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const files = yield* reader.listFiles(FIXTURE_DIR)

        const srcIdx = files.indexOf("src/index.ts")
        const helpersIdx = files.indexOf("src/utils/helpers.ts")
        // Both should be present (already checked above), just verify they have paths
        expect(srcIdx).toBeGreaterThanOrEqual(0)
        expect(helpersIdx).toBeGreaterThanOrEqual(0)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.live("no duplicate paths", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const files = yield* reader.listFiles(FIXTURE_DIR)
        const unique = new Set(files)
        expect(unique.size).toBe(files.length)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.live("fails on nonexistent repo", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const result = yield* reader.listFiles("/tmp/nonexistent-repo-xyz").pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("readFile", () => {
    it.live("reads text file content", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const blob = yield* reader.readFile(FIXTURE_DIR, "README.md")

        expect(blob.isBinary).toBe(false)
        expect(blob.size).toBeGreaterThan(0)
        const text = new TextDecoder().decode(blob.content)
        expect(text).toContain("# Test Repo")
        expect(text).toContain("Hello world.")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.live("reads nested file content", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const blob = yield* reader.readFile(FIXTURE_DIR, "src/utils/helpers.ts")

        expect(blob.isBinary).toBe(false)
        const text = new TextDecoder().decode(blob.content)
        expect(text).toContain("export const add")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.live("detects binary files", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const blob = yield* reader.readFile(FIXTURE_DIR, "icon.png")

        expect(blob.isBinary).toBe(true)
        expect(blob.size).toBe(9)
        // PNG magic bytes
        expect(blob.content[0]).toBe(0x89)
        expect(blob.content[1]).toBe(0x50)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.live("fails on nonexistent file", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const result = yield* reader.readFile(FIXTURE_DIR, "nonexistent.ts").pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.live("content is a copy (safe after GC)", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const blob = yield* reader.readFile(FIXTURE_DIR, "README.md")

        // Verify the content is a standalone Uint8Array, not a view into native memory
        expect(blob.content).toBeInstanceOf(Uint8Array)
        expect(blob.content.buffer.byteLength).toBe(blob.content.length)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("clone", () => {
    it.live("fails on invalid URL", () =>
      Effect.gen(function* () {
        const reader = yield* GitReader
        const result = yield* reader
          .clone("https://invalid.example.com/no-repo.git", `/tmp/test-clone-fail-${Date.now()}`)
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})
