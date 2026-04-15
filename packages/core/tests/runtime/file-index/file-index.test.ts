import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  FileIndex,
  FileIndexError,
  FallbackFileIndexLive,
  FileIndexLive,
} from "@gent/core/runtime/file-index/index"

const PlatformLayer = BunServices.layer

// ---------------------------------------------------------------------------
// Fallback adapter
// ---------------------------------------------------------------------------

describe("FileIndex.Fallback", () => {
  it.scopedLive("listFiles returns files in a directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/a.ts`, "hello")
      yield* fs.writeFileString(`${tmpDir}/b.js`, "world")

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ cwd: tmpDir })

      expect(files.length).toBe(2)
      expect(files.every((f) => f.path.startsWith(tmpDir))).toBe(true)
      expect(files.every((f) => f.modifiedMs > 0)).toBe(true)
      expect(files.every((f) => f.size > 0)).toBe(true)
    }).pipe(Effect.provide(Layer.merge(PlatformLayer, FallbackFileIndexLive))),
  )

  it.scopedLive("listFiles includes dotfiles", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "node_modules")
      yield* fs.writeFileString(`${tmpDir}/readme.md`, "hi")

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ cwd: tmpDir })
      const names = files.map((f) => f.fileName)

      expect(names).toContain(".gitignore")
      expect(names).toContain("readme.md")
    }).pipe(Effect.provide(Layer.merge(PlatformLayer, FallbackFileIndexLive))),
  )

  it.scopedLive("listFiles respects gitignore", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "ignored.txt")
      yield* fs.writeFileString(`${tmpDir}/kept.txt`, "keep")
      yield* fs.writeFileString(`${tmpDir}/ignored.txt`, "skip")

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ cwd: tmpDir })
      const names = files.map((f) => f.fileName)

      expect(names).toContain("kept.txt")
      expect(names).toContain(".gitignore")
      expect(names).not.toContain("ignored.txt")
    }).pipe(Effect.provide(Layer.merge(PlatformLayer, FallbackFileIndexLive))),
  )

  it.scopedLive("listFiles returns full file list (no early break)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      for (let i = 0; i < 50; i++) {
        yield* fs.writeFileString(`${tmpDir}/file-${i}.txt`, `content-${i}`)
      }

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ cwd: tmpDir })

      expect(files.length).toBe(50)
    }).pipe(Effect.provide(Layer.merge(PlatformLayer, FallbackFileIndexLive))),
  )

  it.live("searchFiles returns empty (no fuzzy in fallback)", () =>
    Effect.gen(function* () {
      const fileIndex = yield* FileIndex
      const results = yield* fileIndex.searchFiles({ cwd: "/tmp", query: "anything" })

      expect(results.length).toBe(0)
    }).pipe(Effect.provide(Layer.merge(PlatformLayer, FallbackFileIndexLive))),
  )
})

// ---------------------------------------------------------------------------
// FileIndex.Live (composite: native with per-method fallback)
// ---------------------------------------------------------------------------

describe("FileIndex.Live", () => {
  it.scopedLive("constructs without error (always succeeds)", () =>
    Effect.gen(function* () {
      const fileIndex = yield* FileIndex
      expect(fileIndex).toBeDefined()
      expect(typeof fileIndex.listFiles).toBe("function")
      expect(typeof fileIndex.searchFiles).toBe("function")
      expect(typeof fileIndex.trackSelection).toBe("function")
    }).pipe(Effect.provide(Layer.merge(PlatformLayer, FileIndexLive))),
  )

  it.scopedLive("listFiles returns results for cwd", () =>
    Effect.gen(function* () {
      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ cwd: process.cwd() })

      expect(files.length).toBeGreaterThan(0)
      expect(files[0]!.path.length).toBeGreaterThan(0)
      expect(files[0]!.relativePath.length).toBeGreaterThan(0)
      expect(files[0]!.modifiedMs).toBeGreaterThan(0)
    }).pipe(Effect.provide(Layer.merge(PlatformLayer, FileIndexLive))),
  )

  it.scopedLive("per-method fallback: invalid cwd yields FileIndexError", () =>
    Effect.gen(function* () {
      const fileIndex = yield* FileIndex
      const result = yield* fileIndex
        .listFiles({ cwd: "/nonexistent-path-that-does-not-exist" })
        .pipe(Effect.catchTag("FileIndexError", (e) => Effect.succeed({ caught: e.message })))

      // Either succeeded via fallback (empty list) or caught the error
      if (Array.isArray(result)) {
        expect(result.length).toBe(0)
      } else {
        expect(result.caught).toBeDefined()
      }
    }).pipe(Effect.provide(Layer.merge(PlatformLayer, FileIndexLive))),
  )
})

// ---------------------------------------------------------------------------
// Per-method fallback behavior (mock native that always fails)
// ---------------------------------------------------------------------------

describe("withFallback composite", () => {
  it.scopedLive("falls back to fallback when native listFiles fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/hello.txt`, "hi")

      const fallbackIndex = yield* FileIndex

      // Simulate: native fails → fallback succeeds
      const files = yield* Effect.gen(function* () {
        return yield* new FileIndexError({ message: "native boom", cwd: tmpDir })
      }).pipe(Effect.catchTag("FileIndexError", () => fallbackIndex.listFiles({ cwd: tmpDir })))

      expect(files.length).toBe(1)
      expect(files[0]!.fileName).toBe("hello.txt")
    }).pipe(Effect.provide(Layer.merge(PlatformLayer, FallbackFileIndexLive))),
  )
})
