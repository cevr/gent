import { describe, expect, it, test } from "effect-bun-test"
import { spyOn } from "bun:test"
import { FileFinder as NativeFileFinder } from "@ff-labs/fff-bun"
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Predicate } from "effect"
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
  ReadTool,
  unescapeStr,
  WriteTool,
} from "../src/fs-tools.js"
import { runToolWithCtx, testToolContext, RuntimeEnvironment } from "@gent/core/test-utils"
import { runProcess } from "@gent/core/extensions/api"
import { BranchId, SessionId, ToolCallId } from "@gent/core/protocol"
import { toolResultSummary } from "@gent/core/extensions/branch-tools"

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

describe("shipped file tool summaries", () => {
  const succeeded = <A>(result: A) => ({ isFailure: false, result })
  test("read names the path and the line count, and marks a truncated read", () => {
    expect(
      toolResultSummary(
        Option.some(ReadTool),
        { path: "a.ts" },
        succeeded({ content: "", path: "/w/a.ts", lineCount: 12, truncated: false }),
      ),
    ).toBe("/w/a.ts · 12 lines")
    expect(
      toolResultSummary(
        Option.some(ReadTool),
        { path: "a.ts" },
        succeeded({ content: "", path: "/w/a.ts", lineCount: 1, truncated: true, nextOffset: 2 }),
      ),
    ).toBe("/w/a.ts · 1 line (truncated)")
  })
  test("write and edit name the path and what changed", () => {
    expect(
      toolResultSummary(
        Option.some(WriteTool),
        { path: "a.ts", content: "x" },
        succeeded({ path: "/w/a.ts", bytesWritten: 40 }),
      ),
    ).toBe("/w/a.ts · 40 bytes")
    expect(
      toolResultSummary(
        Option.some(EditTool),
        { path: "a.ts", oldString: "a", newString: "b" },
        succeeded({ path: "/w/a.ts", replacements: 1 }),
      ),
    ).toBe("/w/a.ts · 1 replacement")
  })
  test("grep counts matches for the pattern", () => {
    const match = { file: "a.ts", line: 1, content: "x" }
    expect(
      toolResultSummary(
        Option.some(GrepTool),
        { pattern: "TODO" },
        succeeded({ matches: [match, match], truncated: true }),
      ),
    ).toBe("2 matches for TODO (truncated)")
  })
})

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

  readTest("a trailing newline ends the last line; an empty file has no lines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/two.txt`, "a\nb\n")
      yield* fs.writeFileString(`${tmpDir}/empty.txt`, "")

      const two = yield* runToolWithCtx(ReadTool, { path: `${tmpDir}/two.txt` }, ctx)
      expect(two.lineCount).toBe(2)
      expect(two.content).toBe("1\ta\n2\tb")
      const empty = yield* runToolWithCtx(ReadTool, { path: `${tmpDir}/empty.txt` }, ctx)
      expect(empty.lineCount).toBe(0)
      expect(empty.content).toBe("")
      expect(empty.truncated).toBe(false)
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

  writeTest("atomic and normal writes both follow a symlink to its target", () =>
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
      expect(yield* fs.readFileString(target)).toBe("atomic result")
      expect(yield* fs.readLink(link)).toBe(target)
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
  test("a whitespace-only oldString does not match blank lines", () => {
    expect(Option.isNone(findMatch("a\n\nb", "   "))).toBe(true)
    expect(Option.isNone(findMatch("a\n\n\nb", " \n "))).toBe(true)
  })
  test("a normalized search matches inside a line", () => {
    const match = Option.getOrThrow(findMatch('const s = "hello"', "\u201Chello\u201D"))
    expect(match.strategy).toBe("normalized")
    expect(match.ranges).toEqual([{ start: 10, end: 17 }])
  })
  test("a normalized match across lines keeps the trailing whitespace it spans", () => {
    const content = "x = \u201Chi\u201D  \nnext line"
    const match = Option.getOrThrow(findMatch(content, 'x = "hi"\nnext'))
    expect(match.ranges).toEqual([{ start: 0, end: 15 }])
  })
  test("a normalized search that ends a line takes the line's trailing whitespace", () => {
    const match = Option.getOrThrow(findMatch("a \u201Cq\u201D   \nb", '"q"'))
    expect(match.ranges).toEqual([{ start: 2, end: 8 }])
  })
  test("a normalized match keeps the searched spaces when the line goes on", () => {
    const match = Option.getOrThrow(findMatch("\u201Chi\u201D  x", '"hi"  '))
    expect(match.ranges).toEqual([{ start: 0, end: 6 }])
    const atLineEnd = Option.getOrThrow(findMatch("\u201Chi\u201D\nx", '"hi"  '))
    expect(atLineEnd.ranges).toEqual([{ start: 0, end: 4 }])
  })
  test("a whitespace run that exists in the file still matches exactly", () => {
    expect(Option.getOrThrow(findMatch("a\tb", "\t")).strategy).toBe("exact")
  })
})
// ============================================================================
// Integration — real file editing
// ============================================================================
const editLayer = BunServices.layer
const editTest = it.scopedLive.layer(editLayer)
const stubCtx = testToolContext()
describe("EditTool execution", () => {
  // The file keeps its own spelling; the model's ASCII search still finds it.
  const normalizedCases = [
    { name: "trailing spaces", file: "hello   \nworld  \n", search: "hello\nworld" },
    { name: "double curly quotes", file: "say \u201Chello\u201D now\n", search: 'say "hello" now' },
    { name: "single curly quotes", file: "say \u2018hi\u2019 now\n", search: "say 'hi' now" },
    { name: "an em dash", file: "a\u2014b\n", search: "a-b" },
    { name: "a no-break space", file: "a\u00A0b\n", search: "a b" },
  ]
  for (const { name, file, search } of normalizedCases) {
    editTest(`an ASCII search matches ${name} in the file`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* fs.makeTempDirectoryScoped()
        const filePath = path.join(dir, "test.txt")
        yield* fs.writeFileString(filePath, file)
        const result = yield* runToolWithCtx(
          EditTool,
          { path: filePath, oldString: search, newString: "done" },
          stubCtx,
        )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(editLayer))
        expect(result.replacements).toBe(1)
        expect(yield* fs.readFileString(filePath)).toBe("done\n")
      }),
    )
  }
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

  it.scopedLive("finds matches in a gitignored directory under the session cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", tmpDir])
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "dist/\n")
      yield* fs.makeDirectory(`${tmpDir}/dist/sub`, { recursive: true })
      yield* fs.writeFileString(`${tmpDir}/src.ts`, "const foo = 0")
      yield* fs.writeFileString(`${tmpDir}/dist/sub/b.js`, "const foo = 1")

      const ctxRepo = testToolContext({ cwd: tmpDir })
      const whole = yield* runToolWithCtx(GrepTool, { pattern: "foo", path: tmpDir }, ctxRepo)
      expect(whole.matches.map((match) => match.file)).toEqual([`${tmpDir}/src.ts`])
      const ignored = yield* runToolWithCtx(
        GrepTool,
        { pattern: "foo", path: `${tmpDir}/dist` },
        ctxRepo,
      )
      expect(ignored.matches.map((match) => match.file)).toEqual([`${tmpDir}/dist/sub/b.js`])
    }).pipe(Effect.provide(LiveLayer), Effect.timeout("8 seconds")),
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

  it.scopedLive("an edited .gitignore applies to the next listing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "first.txt")
      yield* fs.writeFileString(`${tmpDir}/first.txt`, "a")
      yield* fs.writeFileString(`${tmpDir}/second.txt`, "b")

      const fileIndex = yield* FileIndex
      const names = fileIndex
        .listFiles({ root: tmpDir, cwd: tmpDir })
        .pipe(Effect.map((files) => files.map((f) => f.relativePath)))
      expect(yield* names).not.toContain("first.txt")
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "second.txt")
      const after = yield* names
      expect(after).toContain("first.txt")
      expect(after).not.toContain("second.txt")
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("a subdirectory listing applies the .gitignore files from the root down", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${tmpDir}/pkg/node_modules/dep`, { recursive: true })
      yield* fs.makeDirectory(`${tmpDir}/pkg/build`, { recursive: true })
      yield* fs.makeDirectory(`${tmpDir}/pkg/gen`, { recursive: true })
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "node_modules\n/build\n*.log\n!keep.log\n")
      yield* fs.writeFileString(`${tmpDir}/pkg/.gitignore`, "gen/\nlocal.ts\n")
      yield* fs.writeFileString(`${tmpDir}/pkg/gen/.gitignore`, "")
      for (const file of [
        "pkg/a.ts",
        "pkg/node_modules/dep/index.js",
        "pkg/build/out.js",
        "pkg/debug.log",
        "pkg/keep.log",
        "pkg/local.ts",
        "pkg/gen/x.ts",
      ]) {
        yield* fs.writeFileString(`${tmpDir}/${file}`, "x")
      }

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ root: tmpDir, cwd: `${tmpDir}/pkg` })
      expect(files.map((f) => f.relativePath).toSorted()).toEqual([
        ".gitignore",
        "a.ts",
        "build/out.js",
        "keep.log",
      ])
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("a directory-only pattern leaves a file of that name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${tmpDir}/src/logs`, { recursive: true })
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "logs/\n")
      yield* fs.writeFileString(`${tmpDir}/src/logs/a.txt`, "x")
      yield* fs.writeFileString(`${tmpDir}/logs`, "a file")

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ root: tmpDir, cwd: tmpDir })
      expect(files.map((f) => f.relativePath).toSorted()).toEqual([".gitignore", "logs"])
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("an explicitly named ignored directory is listed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${tmpDir}/dist`)
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "dist/\n")
      yield* fs.writeFileString(`${tmpDir}/dist/b.js`, "x")

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ root: tmpDir, cwd: `${tmpDir}/dist` })
      expect(files.map((f) => f.relativePath)).toEqual(["b.js"])
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
})

/**
 * `.gitignore` cases where a glob library and git disagree easily. Each runs
 * twice: git lists a work tree, and the matcher walk lists a plain copy.
 */
const GITIGNORE_CASES = {
  "anchored-leading-slash": {
    files: ["foo", "a/foo", "b.txt"],
    ignores: { ".gitignore": "/foo\n" },
  },
  "anchored-middle": {
    files: ["doc/a.txt", "x/doc/a.txt", "doc/sub/a.txt"],
    ignores: { ".gitignore": "doc/*.txt\n" },
  },
  "dir-only": {
    files: ["build/a", "x/build/b", "buildfile"],
    ignores: { ".gitignore": "build/\n" },
  },
  "dir-only-file-named-same": { files: ["logs", "x/logs/a"], ignores: { ".gitignore": "logs/\n" } },
  "double-star-prefix": {
    files: ["foo", "a/foo", "a/b/foo/c"],
    ignores: { ".gitignore": "**/foo\n" },
  },
  "double-star-suffix-negate": {
    files: ["foo/a", "foo/keep.txt", "foo/sub/b"],
    ignores: { ".gitignore": "foo/**\n!foo/keep.txt\n" },
  },
  "double-star-middle": {
    files: ["a/b", "a/x/b", "a/x/y/b", "c/a/b"],
    ignores: { ".gitignore": "a/**/b\n" },
  },
  "negate-inside-ignored-dir": {
    files: ["dir/a", "dir/keep"],
    ignores: { ".gitignore": "dir/\n!dir/keep\n" },
  },
  "negate-dir-star": {
    files: ["dir/a", "dir/keep"],
    ignores: { ".gitignore": "dir/*\n!dir/keep\n" },
  },
  "nested-relative": {
    files: ["sub/a.log", "sub/deep/b.log", "a.log", "sub/x/y", "x/y"],
    ignores: { "sub/.gitignore": "*.log\nx/y\n" },
  },
  "nested-negation-overrides-parent": {
    files: ["a.log", "sub/b.log"],
    ignores: { ".gitignore": "*.log\n", "sub/.gitignore": "!b.log\n" },
  },
  "escaped-hash": { files: ["#foo", "foo"], ignores: { ".gitignore": "\\#foo\n" } },
  "escaped-bang": {
    files: ["!important", "other", "x/y"],
    ignores: { ".gitignore": "\\!important\n" },
  },
  "escaped-star": { files: ["a*b", "axb"], ignores: { ".gitignore": "a\\*b\n" } },
  "braces-literal": { files: ["{a,b}", "a", "b"], ignores: { ".gitignore": "{a,b}\n" } },
  "bracket-negation": { files: ["fa", "fb", "fc"], ignores: { ".gitignore": "f[!a]\n" } },
  "leading-space": { files: [" foo", "foo"], ignores: { ".gitignore": " foo\n" } },
  "trailing-escaped-space": { files: ["foo ", "foo"], ignores: { ".gitignore": "foo\\ \n" } },
  "extglob-chars": { files: ["+(a)", "a", "aa"], ignores: { ".gitignore": "+(a)\n" } },
  "dot-files-star": { files: [".env", "x/.env.local", "a"], ignores: { ".gitignore": ".env*\n" } },
  "star-only": { files: ["a", "b/c"], ignores: { ".gitignore": "*\n!.gitignore\n" } },
  question: { files: ["a1", "a12"], ignores: { ".gitignore": "a?\n" } },
  "slash-star-star-alone": { files: ["a", "b/c"], ignores: { ".gitignore": "/**\n!/a\n" } },
  paren: { files: ["a(1)", "a1"], ignores: { ".gitignore": "a(1)\n" } },
  "negate-then-reignore": {
    files: ["x.log", "keep.log"],
    ignores: { ".gitignore": "*.log\n!keep.log\nkeep.log\n" },
  },
  "dir-pattern-with-slash-inside": {
    files: ["a/b/c", "x/a/b/c"],
    ignores: { ".gitignore": "a/b/\n" },
  },
} satisfies Record<
  string,
  { readonly files: ReadonlyArray<string>; readonly ignores: Record<string, string> }
>

const writeTree = Effect.fn("test.writeTree")(function* (
  root: string,
  files: ReadonlyArray<string>,
  ignores: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const contents: Array<[string, string]> = files.map((file) => [file, "x"])
  for (const [file, content] of [...contents, ...Object.entries(ignores)]) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
    yield* fs.writeFileString(path.join(root, file), content)
  }
})

describe("FileIndex outside a git work tree", () => {
  it.scopedLive("the walk ignores exactly what git ignores", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const results: Record<string, { readonly git: string; readonly walk: string }> = {}
      for (const [name, { files, ignores }] of Object.entries(GITIGNORE_CASES)) {
        const repo = yield* fs.makeTempDirectoryScoped()
        const plain = yield* fs.makeTempDirectoryScoped()
        yield* writeTree(repo, files, ignores)
        yield* writeTree(plain, files, ignores)
        yield* runProcess("git", ["init", "-q", repo])
        const git = yield* runProcess("git", [
          "-C",
          repo,
          "-c",
          "core.excludesFile=/dev/null",
          "ls-files",
          "-z",
          "--others",
          "--exclude-standard",
        ])
        const fileIndex = yield* FileIndex
        const walked = yield* fileIndex.listFiles({ root: plain, cwd: plain })
        results[name] = {
          git: git.stdout
            .split("\0")
            .filter((entry) => entry.length > 0)
            .toSorted()
            .join(" | "),
          walk: walked
            .map((file) => file.relativePath)
            .toSorted()
            .join(" | "),
        }
      }
      for (const [name, result] of Object.entries(results)) {
        expect({ name, listed: result.walk }).toEqual({ name, listed: result.git })
      }
    }).pipe(Effect.provide(FallbackLayer), Effect.timeout("20 seconds")),
  )
})

describe("FileIndex inside a git work tree", () => {
  it.scopedLive("a subdirectory listing applies the repo's ignore rules above it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", repo])
      yield* writeTree(repo, ["pkg/src/a.ts", "pkg/dist/out.js", "pkg/secret.env"], {
        ".gitignore": "dist/\n",
      })
      yield* fs.writeFileString(`${repo}/.git/info/exclude`, "*.env\n")

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ root: `${repo}/pkg`, cwd: `${repo}/pkg` })
      expect(files.map((file) => file.relativePath)).toEqual(["src/a.ts"])
      expect(files.map((file) => file.path)).toEqual([`${repo}/pkg/src/a.ts`])
    }).pipe(Effect.provide(FallbackLayer), Effect.timeout("8 seconds")),
  )

  it.scopedLive(
    "a tracked file stays listed when a pattern matches it; a deleted one does not",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* fs.makeTempDirectoryScoped()
        yield* runProcess("git", ["init", "-q", repo])
        yield* writeTree(repo, ["build/pinned.js", "build/gone.js", "src/a.ts"], {})
        yield* runProcess("git", ["-C", repo, "add", "."])
        yield* fs.writeFileString(`${repo}/.gitignore`, "build/\n")
        yield* fs.writeFileString(`${repo}/build/fresh.js`, "x")
        yield* fs.remove(`${repo}/build/gone.js`)

        const fileIndex = yield* FileIndex
        const files = yield* fileIndex.listFiles({ root: repo, cwd: repo })
        expect(files.map((file) => file.relativePath).toSorted()).toEqual([
          ".gitignore",
          "build/pinned.js",
          "src/a.ts",
        ])
      }).pipe(Effect.provide(FallbackLayer), Effect.timeout("8 seconds")),
  )

  it.scopedLive("an explicitly named ignored directory is listed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", repo])
      yield* writeTree(repo, ["dist/b.js", "src/a.ts"], { ".gitignore": "dist/\n" })

      const fileIndex = yield* FileIndex
      const files = yield* fileIndex.listFiles({ root: repo, cwd: `${repo}/dist` })
      expect(files.map((file) => file.relativePath)).toEqual(["b.js"])
    }).pipe(Effect.provide(FallbackLayer), Effect.timeout("8 seconds")),
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

  it.scopedLive("listing ignored directories does not create finders or evict the root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", tmpDir])
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "vendor/\n")
      yield* fs.writeFileString(`${tmpDir}/src.ts`, "x")
      for (let index = 0; index < 6; index++) {
        yield* fs.makeDirectory(`${tmpDir}/vendor/p${index}`, { recursive: true })
        yield* fs.writeFileString(`${tmpDir}/vendor/p${index}/i.js`, "x")
      }
      const create = spyOn(NativeFileFinder, "create")
      yield* Effect.addFinalizer(() => Effect.sync(() => create.mockRestore()))

      const fileIndex = yield* FileIndex
      const root = yield* fileIndex.listFiles({ root: tmpDir, cwd: tmpDir })
      for (let index = 0; index < 6; index++) {
        const vendored = yield* fileIndex.listFiles({
          root: tmpDir,
          cwd: `${tmpDir}/vendor/p${index}`,
        })
        expect(vendored.map((f) => f.relativePath)).toEqual(["i.js"])
      }
      const again = yield* fileIndex.listFiles({ root: tmpDir, cwd: tmpDir })
      expect(again.map((f) => f.relativePath).toSorted()).toEqual(
        root.map((f) => f.relativePath).toSorted(),
      )
      expect(create).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(LiveLayer), Effect.timeout("8 seconds")),
  )

  it.scopedLive("an evicted finder stays alive until its in-flight listing finishes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const roots: Array<string> = []
      for (let index = 0; index < 5; index++) {
        const root = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${root}/file-${index}.txt`, "x")
        roots.push(root)
      }
      const [first, ...others] = roots
      const firstRoot = Option.getOrThrow(Option.fromUndefinedOr(first))

      // Hold the first finder's scan open until the others have evicted it.
      const services = yield* Effect.context<never>()
      const scanStarted = yield* Deferred.make<boolean>()
      const releaseScan = yield* Deferred.make<boolean>()
      const create = spyOn(NativeFileFinder, "create")
      const heldFinder = () =>
        Option.fromUndefinedOr(create.mock.results[0]).pipe(
          Option.map((created): unknown => created.value),
          Option.filter(Predicate.hasProperty("value")),
          Option.map((result) => result.value),
          Option.filter((finder) => finder instanceof NativeFileFinder),
        )
      const isHeld = (finder: NativeFileFinder) =>
        Option.exists(heldFinder(), (held) => held === finder)
      const wait = spyOn(NativeFileFinder.prototype, "waitForScan").mockImplementation(function (
        this: NativeFileFinder,
        timeoutMs?: number,
      ) {
        const scan = Effect.sync(() => this.waitForScanBlocking(timeoutMs))
        let held = scan
        if (isHeld(this)) {
          held = Deferred.succeed(scanStarted, true).pipe(
            Effect.andThen(Deferred.await(releaseScan)),
            Effect.andThen(scan),
          )
        }
        // oxlint-disable-next-line gent/no-promise-control-flow-in-tests -- The fake implements the finder's Promise-based waitForScan contract.
        return Effect.runPromiseWith(services)(held)
      })
      const destroy = spyOn(NativeFileFinder.prototype, "destroy")
      const search = spyOn(NativeFileFinder.prototype, "fileSearch")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const spy of [wait, destroy, search, create]) spy.mockRestore()
        }),
      )
      const heldWas = (calls: ReadonlyArray<unknown>) =>
        calls.some(
          (context) =>
            Predicate.isObject(context) && context instanceof NativeFileFinder && isHeld(context),
        )

      const fileIndex = yield* FileIndex
      const inFlight = yield* Effect.forkChild(
        fileIndex.listFiles({ root: firstRoot, cwd: firstRoot }),
      )
      yield* Deferred.await(scanStarted)
      for (const root of others) yield* fileIndex.listFiles({ root, cwd: root })
      // The first finder is evicted, but its listing still holds it.
      expect(heldWas(destroy.mock.contexts)).toBe(false)

      yield* Deferred.succeed(releaseScan, true)
      const files = yield* Fiber.join(inFlight)
      expect(files.map((file) => file.relativePath)).toEqual(["file-0.txt"])
      expect(heldWas(search.mock.contexts)).toBe(true)
      expect(heldWas(destroy.mock.contexts)).toBe(true)
    }).pipe(Effect.provide(LiveLayer), Effect.timeout("8 seconds")),
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
