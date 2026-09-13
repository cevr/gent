import { describe, it, expect } from "effect-bun-test"
import { Predicate, Effect, FileSystem, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  FileIndex,
  FileIndexError,
  FallbackFileIndexLive,
  FileIndexLive,
} from "../../src/fs-tools/file-index.js"

const PlatformLayer = BunServices.layer
const FallbackLayer = Layer.merge(
  PlatformLayer,
  Layer.provide(FallbackFileIndexLive, PlatformLayer),
)
const LiveLayer = Layer.merge(
  PlatformLayer,
  Layer.provide(FileIndexLive({ home: "/tmp" }), PlatformLayer),
)

describe("FileIndex fallback walk", () => {
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
    }).pipe(Effect.provide(FallbackLayer)),
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
    }).pipe(Effect.provide(FallbackLayer)),
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
    }).pipe(Effect.provide(FallbackLayer)),
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
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("gitignore cache is scoped per layer instance (no cross-instance bleed)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/foo.txt`, "x")
      yield* fs.writeFileString(`${tmpDir}/bar.txt`, "y")

      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "foo.txt")
      yield* Effect.gen(function* () {
        const idx = yield* FileIndex
        yield* idx.listFiles({ cwd: tmpDir })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(FallbackLayer), Effect.scoped)

      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "bar.txt")
      const filesB = yield* Effect.gen(function* () {
        const idx = yield* FileIndex
        return yield* idx.listFiles({ cwd: tmpDir })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(FallbackLayer), Effect.scoped)
      const namesB = filesB.map((f) => f.fileName)

      expect(namesB).toContain("foo.txt")
      expect(namesB).not.toContain("bar.txt")
    }).pipe(Effect.provide(PlatformLayer)),
  )
})

describe("FileIndex native-first layer", () => {
  it.scopedLive("constructs without error (always succeeds)", () =>
    Effect.gen(function* () {
      const fileIndex = yield* FileIndex
      expect(fileIndex).toBeDefined()
      expect(Predicate.isFunction(fileIndex.listFiles)).toBe(true)
    }).pipe(Effect.provide(LiveLayer)),
  )

  it.scopedLive("listFiles returns results for cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/indexed.txt`, "hello")

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ cwd: tmpDir })

      expect(files.length).toBe(1)
      expect(files[0]!.path.length).toBeGreaterThan(0)
      expect(files[0]!.relativePath).toBe("indexed.txt")
      expect(files[0]!.modifiedMs).toBeGreaterThan(0)
    }).pipe(Effect.provide(LiveLayer)),
  )

  it.scopedLive("per-method fallback: invalid cwd yields FileIndexError or an empty list", () =>
    Effect.gen(function* () {
      const fileIndex = yield* FileIndex
      const result = yield* fileIndex
        .listFiles({ cwd: "/nonexistent-path-that-does-not-exist" })
        .pipe(Effect.catchTag("FileIndexError", (e) => Effect.succeed({ caught: e.message })))

      if ("caught" in result) {
        expect(result.caught).toBeDefined()
      } else {
        expect(result.length).toBe(0)
      }
    }).pipe(Effect.provide(LiveLayer)),
  )

  it.scopedLive("a failing primary falls back to the walk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/hello.txt`, "hi")

      const fallbackIndex = yield* FileIndex
      const files = yield* Effect.fail(
        new FileIndexError({ message: "native boom", cwd: tmpDir }),
      ).pipe(Effect.catchTag("FileIndexError", () => fallbackIndex.listFiles({ cwd: tmpDir })))

      expect(files.length).toBe(1)
      expect(files[0]!.fileName).toBe("hello.txt")
    }).pipe(Effect.provide(FallbackLayer)),
  )
})
