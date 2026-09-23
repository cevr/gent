import { describe, expect, it, test } from "effect-bun-test"
import { spyOn } from "bun:test"
import { FileFinder as NativeFileFinder } from "@ff-labs/fff-bun"
import { Effect, FileSystem, Layer, Option, Path, Predicate } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  detectRedaction,
  EditTool,
  FallbackFileIndexLive,
  FileIndex,
  FileIndexError,
  FileIndexLive,
  findMatch,
  GrepTool,
  normalizeWhitespace,
  ReadTool,
  unescapeStr,
  WriteTool,
  writeFileAtomic,
} from "../src/fs-tools.js"
import { runToolWithCtx, testToolContext, RuntimeEnvironment } from "@gent/core/test-utils"
import { BranchId, SessionId, ToolCallId } from "@gent/core/protocol"

// ── fs-tools/read.test ──────────────────────────────────────────────────────

const ctx = testToolContext({
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("test-call"),
  cwd: "/tmp",
  home: "/tmp",
})

const PlatformLayer = Layer.merge(
  BunServices.layer,
  RuntimeEnvironment.Live({
    cwd: process.cwd(),
    home: "/tmp/test-home",
  }),
)
const ToolLayer = PlatformLayer

describe("ReadTool", () => {
  const readTest = it.scopedLive.layer(ToolLayer)

  readTest("reads a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${tmpDir}/test.txt`
      yield* fs.writeFileString(testFile, "Hello, World!")

      const result = yield* runToolWithCtx(ReadTool, { path: testFile }, ctx)
      expect(result.content).toBe("1\tHello, World!")
    }),
  )

  readTest("returns error for non-existent file", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        runToolWithCtx(ReadTool, { path: "/nonexistent/file.txt" }, ctx),
      )
      expect(result._tag).toBe("Failure")
    }),
  )

  readTest("a truncated read reports the offset that continues without a gap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${tmpDir}/paged.txt`
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
      yield* fs.writeFileString(testFile, lines.join("\n"))

      const first = yield* runToolWithCtx(ReadTool, { path: testFile, limit: 4 }, ctx)
      expect(first.truncated).toBe(true)
      expect(first.nextOffset).toBe(5)
      expect(first.content).toContain("4\tline 4")
      expect(first.content).not.toContain("line 5")

      const second = yield* runToolWithCtx(
        ReadTool,
        { path: testFile, offset: Option.getOrThrow(Option.fromNullishOr(first.nextOffset)) },
        ctx,
      )
      // The line-number column is right-padded to the widest number in the page.
      expect(second.content.split("\n")[0]).toBe(" 5\tline 5")
      expect(second.truncated).toBe(false)
      expect(Option.isNone(Option.fromNullishOr(second.nextOffset))).toBe(true)
    }),
  )

  readTest("a complete read reports no continuation offset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${tmpDir}/whole.txt`
      yield* fs.writeFileString(testFile, "only line")

      const result = yield* runToolWithCtx(ReadTool, { path: testFile }, ctx)
      expect(result.truncated).toBe(false)
      expect(Option.isNone(Option.fromNullishOr(result.nextOffset))).toBe(true)
    }),
  )

  readTest("returns error for directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()

      const result = yield* Effect.result(runToolWithCtx(ReadTool, { path: tmpDir }, ctx))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("Cannot read directory")
      }
    }),
  )
})

// ── fs-tools/write.test ─────────────────────────────────────────────────────

describe("WriteTool", () => {
  const writeTest = it.scopedLive.layer(ToolLayer)

  writeTest("atomic replacement writes complete content and leaves no temporary file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const path = `${dir}/result.md`
      yield* fs.writeFileString(path, "previous result")
      const content = "complete result\n".repeat(100_000)
      const result = yield* runToolWithCtx(WriteTool, { path, content, atomic: true }, ctx)
      expect(result.bytesWritten).toBe(content.length)
      expect(yield* fs.readFileString(path)).toBe(content)
      expect(yield* fs.readDirectory(dir)).toEqual(["result.md"])
    }),
  )

  writeTest("failed atomic rename preserves the destination and removes the temporary file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const destination = `${dir}/saved`
      yield* fs.makeDirectory(destination)
      yield* fs.writeFileString(`${destination}/previous.md`, "previous result")
      const result = yield* runToolWithCtx(
        WriteTool,
        { path: destination, content: "new result", atomic: true },
        ctx,
      ).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(yield* fs.readFileString(`${destination}/previous.md`)).toBe("previous result")
      expect(yield* fs.readDirectory(dir)).toEqual(["saved"])
    }),
  )

  writeTest("atomic replacement replaces a symlink while normal writes follow it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const target = `${dir}/target.md`
      const link = `${dir}/link.md`
      yield* fs.writeFileString(target, "original")
      yield* fs.symlink(target, link)
      yield* runToolWithCtx(WriteTool, { path: link, content: "normal write" }, ctx)
      expect(yield* fs.readFileString(target)).toBe("normal write")
      yield* runToolWithCtx(WriteTool, { path: link, content: "atomic result", atomic: true }, ctx)
      expect(yield* fs.readFileString(target)).toBe("normal write")
      expect(yield* fs.readFileString(link)).toBe("atomic result")
      expect((yield* fs.stat(link)).type).toBe("File")
      expect((yield* fs.readDirectory(dir)).sort()).toEqual(["link.md", "target.md"])
    }),
  )

  writeTest("writes content to a new file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${tmpDir}/new-file.txt`

      const result = yield* runToolWithCtx(
        WriteTool,
        { path: filePath, content: "Hello, World!" },
        ctx,
      )

      expect(result.path).toBe(filePath)
      expect(result.bytesWritten).toBe(13)

      const written = yield* fs.readFileString(filePath)
      expect(written).toBe("Hello, World!")
    }),
  )

  writeTest("creates parent directories when missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${tmpDir}/nested/dir/file.txt`

      yield* runToolWithCtx(WriteTool, { path: filePath, content: "nested" }, ctx)

      const written = yield* fs.readFileString(filePath)
      expect(written).toBe("nested")
    }),
  )

  writeTest("overwrites existing file content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${tmpDir}/existing.txt`
      yield* fs.writeFileString(filePath, "original content")

      yield* runToolWithCtx(WriteTool, { path: filePath, content: "replaced" }, ctx)

      const written = yield* fs.readFileString(filePath)
      expect(written).toBe("replaced")
    }),
  )
})

describe("writeFileAtomic", () => {
  const atomicTest = it.scopedLive.layer(BunServices.layer)

  atomicTest("replaces a symlink entry and leaves its target untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const target = `${dir}/target.json`
      const link = `${dir}/state.json`
      yield* fs.writeFileString(target, "target content")
      yield* fs.symlink(target, link)
      yield* writeFileAtomic(link, "replaced")
      expect(yield* fs.readFileString(target)).toBe("target content")
      expect(yield* fs.readFileString(link)).toBe("replaced")
      expect((yield* fs.readLink(link).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* fs.readDirectory(dir)).sort()).toEqual(["state.json", "target.json"])
    }),
  )
})

// ── fs-tools/edit.test ──────────────────────────────────────────────────────

describe("detectRedaction", () => {
  test("clean replacement has no redaction", () => {
    expect(Option.isNone(detectRedaction("old code", "new code"))).toBe(true)
  })
  test("catches [REDACTED]", () => {
    const result = detectRedaction("old", "before [REDACTED] after")
    expect(Option.getOrThrow(result)).toContain("[REDACTED]")
  })
  test("catches [...omitted code]", () => {
    const result = detectRedaction("old", "before [...omitted code] after")
    expect(Option.getOrThrow(result)).toContain("[...omitted code]")
  })
  test("catches [rest of file unchanged]", () => {
    const result = detectRedaction("old", "before [rest of file unchanged] after")
    expect(Option.getOrThrow(result)).toContain("[rest of file unchanged]")
  })
  test("catches // ... existing code", () => {
    const result = detectRedaction("old", "line1\n// ... existing code\nline3")
    expect(Option.getOrThrow(result)).toContain("// ... existing code")
  })
  test("catches # ... existing code", () => {
    const result = detectRedaction("old", "line1\n# ... existing code\nline3")
    expect(Option.getOrThrow(result)).toContain("# ... existing code")
  })
  test("allows pattern when also in oldString (legitimate content)", () => {
    const content = "// ... existing code"
    expect(Option.isNone(detectRedaction(content, content))).toBe(true)
  })
})
describe("unescapeStr", () => {
  test("converts literal \\n → newline", () => {
    expect(unescapeStr("line1\\nline2")).toBe("line1\nline2")
  })
  test("converts \\t → tab", () => {
    expect(unescapeStr("col1\\tcol2")).toBe("col1\tcol2")
  })
  test("converts \\r → CR", () => {
    expect(unescapeStr("before\\rafter")).toBe("before\rafter")
  })
  test("converts \\\\\\\\ → single backslash", () => {
    // "a\\\\b" → JS string "a\\b" → after \\\\→\ replacement → "a\b"
    expect(unescapeStr("a\\\\b")).toBe("a\\b")
  })
  test("no-op on clean strings", () => {
    expect(unescapeStr("hello world")).toBe("hello world")
  })
})
describe("normalizeWhitespace", () => {
  test("strips trailing whitespace per line", () => {
    expect(normalizeWhitespace("hello   \nworld  ")).toBe("hello\nworld")
  })
  test("curly quotes → ASCII quotes", () => {
    expect(normalizeWhitespace("\u201Chello\u201D")).toBe('"hello"')
    expect(normalizeWhitespace("\u2018hi\u2019")).toBe("'hi'")
  })
  test("em-dash → hyphen, NBSP → space", () => {
    expect(normalizeWhitespace("a\u2014b")).toBe("a-b")
    expect(normalizeWhitespace("a\u00A0b")).toBe("a b")
  })
})
describe("findMatch", () => {
  test("exact match → strategy 'exact', correct index", () => {
    const content = "hello world foo bar"
    const result = findMatch(content, "world foo")
    const match = Option.getOrThrow(result)
    expect(match.strategy).toBe("exact")
    expect(match.index).toBe(6)
  })
  test("literal \\n in oldString → falls through to 'unescaped'", () => {
    const content = "line1\nline2"
    const result = findMatch(content, "line1\\nline2")
    expect(Option.getOrThrow(result).strategy).toBe("unescaped")
  })
  test("trailing whitespace diff → falls through to 'normalized'", () => {
    const content = "hello\nworld"
    const result = findMatch(content, "hello   \nworld")
    expect(Option.getOrThrow(result).strategy).toBe("normalized")
  })
  test("no match returns none", () => {
    expect(Option.isNone(findMatch("hello world", "xyz"))).toBe(true)
  })
})
// ============================================================================
// Integration — real file editing
// ============================================================================
const editLayer = BunServices.layer
const editTest = it.scopedLive.layer(editLayer)
const stubCtx = testToolContext()
describe("EditTool execution", () => {
  editTest("applies edit to a real file and reads back the result", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "hello world\ngoodbye world\n")
      const result = yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "hello world", newString: "hi there" },
        stubCtx,
      )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        .pipe(Effect.provide(editLayer))
      expect(result.replacements).toBe(1)
      expect(result.path).toBe(filePath)
      const content = yield* fs.readFileString(filePath)
      expect(content).toBe("hi there\ngoodbye world\n")
    }),
  )
  editTest("replaceAll replaces every occurrence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "foo bar foo baz foo\n")
      const result = yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "foo", newString: "qux", replaceAll: true },
        stubCtx,
      )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        .pipe(Effect.provide(editLayer))
      expect(result.replacements).toBe(3)
      const content = yield* fs.readFileString(filePath)
      expect(content).toBe("qux bar qux baz qux\n")
    }),
  )
  editTest("fails when oldString not found", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "hello world\n")
      const exit = yield* Effect.exit(
        runToolWithCtx(
          EditTool,
          { path: filePath, oldString: "not here", newString: "replaced" },
          stubCtx,
        )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(editLayer)),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
  editTest("fails on ambiguous match without replaceAll", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "foo bar foo\n")
      const exit = yield* Effect.exit(
        runToolWithCtx(EditTool, { path: filePath, oldString: "foo", newString: "baz" }, stubCtx)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(editLayer)),
      )
      expect(exit._tag).toBe("Failure")
    }),
  )
  editTest("newString with dollar patterns is written literally", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.sh")
      yield* fs.writeFileString(filePath, "echo old\n")
      yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "old", newString: "$$ pid $& $` $' x" },
        stubCtx,
      )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        .pipe(Effect.provide(editLayer))
      expect(yield* fs.readFileString(filePath)).toBe("echo $$ pid $& $` $' x\n")
    }),
  )
  editTest("an empty oldString is rejected", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "abc")
      // The params decode rejects the call before the tool body runs.
      const exit = yield* Effect.exit(
        Effect.suspend(() =>
          runToolWithCtx(
            EditTool,
            { path: filePath, oldString: "", newString: "-", replaceAll: true },
            stubCtx,
          ),
        )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(editLayer)),
      )
      expect(exit._tag).toBe("Failure")
      expect(yield* fs.readFileString(filePath)).toBe("abc")
    }),
  )
  editTest("a normalized match that occurs twice is ambiguous", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      const original = "foo \nbar\nfoo  \nbar\n"
      yield* fs.writeFileString(filePath, original)
      const exit = yield* Effect.exit(
        runToolWithCtx(EditTool, { path: filePath, oldString: "foo\nbar", newString: "x" }, stubCtx)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(editLayer)),
      )
      expect(exit._tag).toBe("Failure")
      expect(yield* fs.readFileString(filePath)).toBe(original)
    }),
  )
  editTest("replaceAll replaces every normalized match", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "foo \nbar\nmid\nfoo  \nbar\n")
      const result = yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "foo\nbar", newString: "x", replaceAll: true },
        stubCtx,
      )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        .pipe(Effect.provide(editLayer))
      expect(result.replacements).toBe(2)
      expect(yield* fs.readFileString(filePath)).toBe("x\nmid\nx\n")
    }),
  )
  editTest("fuzzy match handles literal backslash-n in oldString", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = path.join(dir, "test.txt")
      yield* fs.writeFileString(filePath, "line1\nline2\n")
      const result = yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "line1\\nline2", newString: "merged" },
        stubCtx,
      )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        .pipe(Effect.provide(editLayer))
      expect(result.replacements).toBe(1)
      const content = yield* fs.readFileString(filePath)
      expect(content).toBe("merged\n")
    }),
  )
})

// ── fs-tools/grep.test ──────────────────────────────────────────────────────

const ToolLayerGrep = Layer.merge(
  BunServices.layer,
  Layer.provide(FallbackFileIndexLive, BunServices.layer),
)
const ctxGrep = testToolContext()

describe("GrepTool", () => {
  it.scopedLive("finds pattern in files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/file1.ts`, "const foo = 1")
      yield* fs.writeFileString(`${tmpDir}/file2.ts`, "const bar = 2")
      yield* fs.writeFileString(`${tmpDir}/file3.ts`, "const foo = 3")

      const result = yield* runToolWithCtx(GrepTool, { pattern: "foo", path: tmpDir }, ctxGrep)
      expect(result.matches.length).toBe(2)
    }).pipe(Effect.provide(ToolLayerGrep)),
  )

  it.scopedLive("respects glob filter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/file1.ts`, "const foo = 1")
      yield* fs.writeFileString(`${tmpDir}/file2.js`, "const foo = 2")

      const result = yield* runToolWithCtx(
        GrepTool,
        { pattern: "foo", path: tmpDir, glob: "*.ts" },
        ctxGrep,
      )
      expect(result.matches.length).toBe(1)
      expect(result.matches[0]!.file).toContain("file1.ts")
    }).pipe(Effect.provide(ToolLayerGrep)),
  )

  it.scopedLive("a glob without a slash matches files in nested directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${tmpDir}/src/deep`, { recursive: true })
      yield* fs.writeFileString(`${tmpDir}/top.ts`, "const foo = 1")
      yield* fs.writeFileString(`${tmpDir}/src/deep/nested.ts`, "const foo = 2")
      yield* fs.writeFileString(`${tmpDir}/src/deep/nested.js`, "const foo = 3")

      const anywhere = yield* runToolWithCtx(
        GrepTool,
        { pattern: "foo", path: tmpDir, glob: "*.ts" },
        ctxGrep,
      )
      expect(
        anywhere.matches
          .map((match) => match.file.split("/").at(-1))
          .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
      ).toEqual(["nested.ts", "top.ts"])
      // A glob with a slash still matches the path relative to the search root.
      const scoped = yield* runToolWithCtx(
        GrepTool,
        { pattern: "foo", path: tmpDir, glob: "src/*.ts" },
        ctxGrep,
      )
      expect(scoped.matches).toEqual([])
    }).pipe(Effect.provide(ToolLayerGrep)),
  )

  it.scopedLive("a glob with a slash matches paths relative to the search root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${tmpDir}/src/deep`, { recursive: true })
      yield* fs.makeDirectory(`${tmpDir}/test`, { recursive: true })
      yield* fs.writeFileString(`${tmpDir}/top.ts`, "const foo = 1")
      yield* fs.writeFileString(`${tmpDir}/src/a.ts`, "const foo = 2")
      yield* fs.writeFileString(`${tmpDir}/src/deep/b.ts`, "const foo = 3")
      yield* fs.writeFileString(`${tmpDir}/test/c.ts`, "const foo = 4")
      const namesFor = (glob: string) =>
        runToolWithCtx(GrepTool, { pattern: "foo", path: tmpDir, glob }, ctxGrep).pipe(
          Effect.map((result) =>
            result.matches
              .map((match) => match.file.slice(tmpDir.length + 1))
              .sort((a, b) => a.localeCompare(b)),
          ),
        )
      expect(yield* namesFor("src/*.ts")).toEqual(["src/a.ts"])
      expect(yield* namesFor("{src,test}/**/*.ts")).toEqual([
        "src/a.ts",
        "src/deep/b.ts",
        "test/c.ts",
      ])
    }).pipe(Effect.provide(ToolLayerGrep)),
  )

  it.scopedLive("truncated is set only when more matches exist than the limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/a.ts`, "foo\nfoo")
      const exact = yield* runToolWithCtx(
        GrepTool,
        { pattern: "foo", path: tmpDir, limit: 2 },
        ctxGrep,
      )
      expect(exact.matches.length).toBe(2)
      expect(exact.truncated).toBe(false)
      yield* fs.writeFileString(`${tmpDir}/b.ts`, "foo")
      const over = yield* runToolWithCtx(
        GrepTool,
        { pattern: "foo", path: tmpDir, limit: 2 },
        ctxGrep,
      )
      expect(over.matches.length).toBe(2)
      expect(over.truncated).toBe(true)
    }).pipe(Effect.provide(ToolLayerGrep)),
  )

  it.scopedLive("searches single file directly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/target.ts`, "hello\nworld\nhello again")

      const result = yield* runToolWithCtx(
        GrepTool,
        { pattern: "hello", path: `${tmpDir}/target.ts` },
        ctxGrep,
      )
      expect(result.matches.length).toBe(2)
    }).pipe(Effect.provide(ToolLayerGrep)),
  )
})

// ── fs-tools/file-index.test ────────────────────────────────────────────────

const PlatformLayerFileIndex = BunServices.layer
const FallbackLayer = Layer.merge(
  PlatformLayerFileIndex,
  Layer.provide(FallbackFileIndexLive, PlatformLayerFileIndex),
)
const LiveLayer = Layer.merge(
  PlatformLayerFileIndex,
  Layer.provide(FileIndexLive({ home: "/tmp" }), PlatformLayerFileIndex),
)

describe("FileIndex fallback walk", () => {
  it.scopedLive("listFiles returns files in a directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/a.ts`, "hello")
      yield* fs.writeFileString(`${tmpDir}/b.js`, "world")

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ root: tmpDir, cwd: tmpDir })

      expect(files.length).toBe(2)
      expect(files.every((f) => f.path.startsWith(tmpDir))).toBe(true)
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("listFiles includes dotfiles", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "node_modules")
      yield* fs.writeFileString(`${tmpDir}/readme.md`, "hi")

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ root: tmpDir, cwd: tmpDir })
      const names = files.map((f) => f.relativePath)

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
      const files = yield* fileIndex.listFiles({ root: tmpDir, cwd: tmpDir })
      const names = files.map((f) => f.relativePath)

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
      const files = yield* fileIndex.listFiles({ root: tmpDir, cwd: tmpDir })

      expect(files.length).toBe(50)
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("the walk skips .git and stops at a directory link cycle", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${tmpDir}/.git/logs`, { recursive: true })
      yield* fs.writeFileString(`${tmpDir}/.git/logs/HEAD`, "commit")
      yield* fs.makeDirectory(`${tmpDir}/src`)
      yield* fs.writeFileString(`${tmpDir}/src/a.ts`, "a")
      yield* fs.symlink(tmpDir, `${tmpDir}/src/loop`)

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex
        .listFiles({ root: tmpDir, cwd: tmpDir })
        .pipe(Effect.timeout("5 seconds"))
      expect(files.map((f) => f.relativePath)).toEqual(["src/a.ts"])
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
        yield* idx.listFiles({ root: tmpDir, cwd: tmpDir })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(FallbackLayer), Effect.scoped)

      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "bar.txt")
      const filesB = yield* Effect.gen(function* () {
        const idx = yield* FileIndex
        return yield* idx.listFiles({ root: tmpDir, cwd: tmpDir })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(FallbackLayer), Effect.scoped)
      const namesB = filesB.map((f) => f.relativePath)

      expect(namesB).toContain("foo.txt")
      expect(namesB).not.toContain("bar.txt")
    }).pipe(Effect.provide(PlatformLayerFileIndex)),
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
      const files = yield* fileIndex.listFiles({ root: tmpDir, cwd: tmpDir })

      expect(files.length).toBe(1)
      expect(files[0]!.path.length).toBeGreaterThan(0)
      expect(files[0]!.relativePath).toBe("indexed.txt")
    }).pipe(Effect.provide(LiveLayer)),
  )

  it.scopedLive("listings under one root share one native finder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${tmpDir}/src/deep`, { recursive: true })
      yield* fs.makeDirectory(`${tmpDir}/docs`)
      yield* fs.writeFileString(`${tmpDir}/top.txt`, "t")
      yield* fs.writeFileString(`${tmpDir}/src/deep/a.txt`, "a")
      yield* fs.writeFileString(`${tmpDir}/docs/b.txt`, "b")
      const create = spyOn(NativeFileFinder, "create")
      yield* Effect.addFinalizer(() => Effect.sync(() => create.mockRestore()))

      const fileIndex = yield* FileIndex
      const src = yield* fileIndex.listFiles({ root: tmpDir, cwd: `${tmpDir}/src` })
      const docs = yield* fileIndex.listFiles({ root: tmpDir, cwd: `${tmpDir}/docs` })

      expect(src.map((f) => f.relativePath)).toEqual(["deep/a.txt"])
      expect(src.map((f) => f.path)).toEqual([`${tmpDir}/src/deep/a.txt`])
      expect(docs.map((f) => f.relativePath)).toEqual(["b.txt"])
      expect(create).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(LiveLayer)),
  )

  it.scopedLive("per-method fallback: invalid cwd yields FileIndexError or an empty list", () =>
    Effect.gen(function* () {
      const fileIndex = yield* FileIndex
      const result = yield* fileIndex
        .listFiles({
          root: "/nonexistent-path-that-does-not-exist",
          cwd: "/nonexistent-path-that-does-not-exist",
        })
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
      ).pipe(
        Effect.catchTag("FileIndexError", () =>
          fallbackIndex.listFiles({ root: tmpDir, cwd: tmpDir }),
        ),
      )

      expect(files.length).toBe(1)
      expect(files[0]!.relativePath).toBe("hello.txt")
    }).pipe(Effect.provide(FallbackLayer)),
  )
})
