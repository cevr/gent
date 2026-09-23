import { describe, expect, it, test } from "effect-bun-test"
import { spyOn } from "bun:test"
import { FileFinder as NativeFileFinder } from "@ff-labs/fff-bun"
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { EditTool, FileIndexLive, GrepTool, ReadTool, WriteTool } from "../src/fs-tools.js"
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

  for (const { name, params } of [
    { name: "offset 0", params: { offset: 0 } },
    { name: "offset 1.5", params: { offset: 1.5 } },
    { name: "limit 0", params: { limit: 0 } },
    { name: "limit -1", params: { limit: -1 } },
    { name: "limit 2.5", params: { limit: 2.5 } },
  ]) {
    readTest(`refuses ${name}: a start line or line count is a positive whole number`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${tmpDir}/a.txt`, "a\nb\n")
        const exit = yield* Effect.exit(
          Effect.suspend(() =>
            runToolWithCtx(ReadTool, { path: `${tmpDir}/a.txt`, ...params }, ctx),
          ),
        )
        expect(exit._tag).toBe("Failure")
      }),
    )
  }

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

const editLayer = BunServices.layer
const editTest = it.scopedLive.layer(editLayer)
const stubCtx = testToolContext()

/** Edit a fresh file that holds `content`: the tool's exit and the file afterward. */
const editFile = Effect.fn("test.editFile")(function* (
  content: string,
  params: { readonly oldString: string; readonly newString: string; readonly replaceAll?: boolean },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped()
  const filePath = path.join(dir, "test.txt")
  yield* fs.writeFileString(filePath, content)
  const exit = yield* Effect.exit(
    runToolWithCtx(EditTool, { path: filePath, ...params }, stubCtx)
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      .pipe(Effect.provide(editLayer)),
  )
  let failure = ""
  if (Exit.isFailure(exit)) failure = Cause.pretty(exit.cause)
  return { exit, failure, after: yield* fs.readFileString(filePath) }
})

describe("EditTool redaction check", () => {
  for (const placeholder of [
    "[REDACTED]",
    "[...omitted code]",
    "[rest of file unchanged]",
    "// ... existing code",
    "# ... existing code",
  ]) {
    editTest(`a newString with ${placeholder} is refused and the file stays`, () =>
      Effect.gen(function* () {
        const { exit, failure, after } = yield* editFile("old\n", {
          oldString: "old",
          newString: `line1\n${placeholder}\nline3`,
        })
        expect(exit._tag).toBe("Failure")
        expect(failure).toContain(`redaction placeholder "${placeholder}"`)
        expect(after).toBe("old\n")
      }),
    )
  }
  editTest("a placeholder that the old text holds too is legitimate content", () =>
    Effect.gen(function* () {
      const { after } = yield* editFile("a\n// ... existing code\n", {
        oldString: "a\n// ... existing code",
        newString: "b\n// ... existing code",
      })
      expect(after).toBe("b\n// ... existing code\n")
    }),
  )
})

describe("EditTool matching", () => {
  const cases: ReadonlyArray<{
    readonly name: string
    readonly file: string
    readonly oldString: string
    readonly after: string
  }> = [
    {
      name: "an exact match",
      file: "hello world foo bar",
      oldString: "world foo",
      after: "hello X bar",
    },
    { name: "a literal \\n", file: "line1\nline2", oldString: "line1\\nline2", after: "X" },
    { name: "a literal \\t", file: "col1\tcol2", oldString: "col1\\tcol2", after: "X" },
    { name: "a literal \\r", file: "before\rafter", oldString: "before\\rafter", after: "X" },
    { name: "an escaped backslash", file: "a\\b", oldString: "a\\\\b", after: "X" },
    {
      name: "a trailing whitespace diff",
      file: "hello\nworld",
      oldString: "hello   \nworld",
      after: "X",
    },
    {
      name: "curly quotes inside a line",
      file: 'const s = "hello"',
      oldString: "“hello”",
      after: "const s = X",
    },
    {
      name: "a match across lines, with the trailing whitespace it spans",
      file: "x = “hi”  \nnext line",
      oldString: 'x = "hi"\nnext',
      after: "X line",
    },
    {
      name: "a match that ends a line, with the line's trailing whitespace",
      file: "a “q”   \nb",
      oldString: '"q"',
      after: "a X\nb",
    },
    {
      name: "searched spaces when the line goes on",
      file: "“hi”  x",
      oldString: '"hi"  ',
      after: "Xx",
    },
    { name: "searched spaces at a line end", file: "“hi”\nx", oldString: '"hi"  ', after: "X\nx" },
    { name: "a whitespace run the file holds", file: "a\tb", oldString: "\t", after: "aXb" },
  ]
  for (const { name, file, oldString, after } of cases) {
    editTest(`${name} is replaced`, () =>
      Effect.gen(function* () {
        const edited = yield* editFile(file, { oldString, newString: "X" })
        expect(edited.exit._tag).toBe("Success")
        expect(edited.after).toBe(after)
      }),
    )
  }
  for (const { name, file, oldString } of [
    { name: "text the file does not hold", file: "hello world", oldString: "xyz" },
    { name: "a whitespace-only search", file: "a\n\nb", oldString: "   " },
    { name: "a whitespace-only search across lines", file: "a\n\n\nb", oldString: " \n " },
  ]) {
    editTest(`${name} matches nothing`, () =>
      Effect.gen(function* () {
        const edited = yield* editFile(file, { oldString, newString: "X" })
        expect(edited.exit._tag).toBe("Failure")
        expect(edited.after).toBe(file)
      }),
    )
  }
})

// ============================================================================
// Integration — real file editing
// ============================================================================
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

/** Turn the native finder off for one layer build: the index lists with git or the walk. */
const nativeOff = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.sync(() => spyOn(NativeFileFinder, "isAvailable").mockReturnValue(false)),
    (spy) => Effect.sync(() => spy.mockRestore()),
  ),
)
const FallbackLayer = Layer.merge(
  BunServices.layer,
  Layer.provide(FileIndexLive({ home: "/tmp" }), Layer.merge(BunServices.layer, nativeOff)),
)
const LiveLayer = Layer.merge(
  BunServices.layer,
  Layer.provide(FileIndexLive({ home: "/tmp" }), BunServices.layer),
)
const ctxGrep = testToolContext()

/**
 * The files grep reads for a search of `path` from a session in `cwd`,
 * relative to `path` and sorted. `^` matches every line, so a file is listed
 * once per line; the set keeps one.
 */
const listed = (cwd: string, path = cwd) =>
  runToolWithCtx(GrepTool, { pattern: "^", path, limit: 100_000 }, testToolContext({ cwd })).pipe(
    Effect.map((result) =>
      [...new Set(result.matches.map((match) => match.file.slice(path.length + 1)))].toSorted(),
    ),
  )

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
    }).pipe(Effect.provide(FallbackLayer)),
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
    }).pipe(Effect.provide(FallbackLayer)),
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
    }).pipe(Effect.provide(FallbackLayer)),
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
    }).pipe(Effect.provide(FallbackLayer)),
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
    }).pipe(Effect.provide(FallbackLayer)),
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

  it.scopedLive("a file with a NUL byte in its first 8 KB is binary and skipped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/text.ts`, "const needle = 1")
      yield* fs.writeFileString(`${tmpDir}/binary.bin`, `${"x".repeat(8000)}\0needle`)
      yield* fs.writeFileString(`${tmpDir}/late-nul.txt`, `needle${"x".repeat(9000)}\0`)

      const result = yield* runToolWithCtx(GrepTool, { pattern: "needle", path: tmpDir }, ctxGrep)
      expect(result.matches.map((match) => match.file.slice(tmpDir.length + 1)).toSorted()).toEqual(
        ["late-nul.txt", "text.ts"],
      )
      const direct = yield* runToolWithCtx(
        GrepTool,
        { pattern: "needle", path: `${tmpDir}/binary.bin` },
        ctxGrep,
      )
      expect(direct.matches).toEqual([])
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("a long line is cut around the match, and so is its context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const long = `${"a".repeat(5000)}needle${"b".repeat(5000)}`
      yield* fs.writeFileString(`${tmpDir}/min.js`, `${"c".repeat(3000)}\n${long}\nshort`)

      const result = yield* runToolWithCtx(
        GrepTool,
        { pattern: "needle", path: tmpDir, context: 1 },
        ctxGrep,
      )
      const [match] = result.matches
      expect(match?.line).toBe(2)
      expect(match?.content).toBe(
        `[4900 chars cut] ${"a".repeat(100)}needle${"b".repeat(394)} [4606 chars cut]`,
      )
      expect(match?.context?.before).toEqual([`${"c".repeat(500)} [2500 chars cut]`])
      expect(match?.context?.after).toEqual(["short"])
    }).pipe(Effect.provide(FallbackLayer)),
  )

  for (const { name, params } of [
    { name: "limit 0", params: { limit: 0 } },
    { name: "limit -2", params: { limit: -2 } },
    { name: "limit 1.5", params: { limit: 1.5 } },
    { name: "context -1", params: { context: -1 } },
    { name: "context 0.5", params: { context: 0.5 } },
  ]) {
    it.scopedLive(`refuses ${name}: a count is a whole number`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${tmpDir}/a.ts`, "foo\nfoo\n")
        const exit = yield* Effect.exit(
          Effect.suspend(() =>
            runToolWithCtx(GrepTool, { pattern: "foo", path: tmpDir, ...params }, ctxGrep),
          ),
        )
        expect(exit._tag).toBe("Failure")
      }).pipe(Effect.provide(FallbackLayer)),
    )
  }

  it.scopedLive("context 0 is no context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/a.ts`, "x\nfoo\ny\n")
      const result = yield* runToolWithCtx(
        GrepTool,
        { pattern: "foo", path: tmpDir, context: 0 },
        ctxGrep,
      )
      expect(result.matches.map((match) => "context" in match)).toEqual([false])
    }).pipe(Effect.provide(FallbackLayer)),
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
    }).pipe(Effect.provide(FallbackLayer)),
  )
})

// ── fs-tools/file-index.test ────────────────────────────────────────────────

describe("grep's file listing outside a git work tree", () => {
  it.scopedLive("lists every file, dotfiles too", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "node_modules")
      yield* fs.writeFileString(`${tmpDir}/a.ts`, "hello")
      yield* fs.writeFileString(`${tmpDir}/b.js`, "world")
      const create = spyOn(NativeFileFinder, "create")
      yield* Effect.addFinalizer(() => Effect.sync(() => create.mockRestore()))

      expect(yield* listed(tmpDir)).toEqual([".gitignore", "a.ts", "b.js"])
      // The fallback layer never builds a native finder.
      expect(create).not.toHaveBeenCalled()
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("a .gitignore line drops the file it names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "ignored.txt")
      yield* fs.writeFileString(`${tmpDir}/kept.txt`, "keep")
      yield* fs.writeFileString(`${tmpDir}/ignored.txt`, "skip")

      expect(yield* listed(tmpDir)).toEqual([".gitignore", "kept.txt"])
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("an edited .gitignore applies to the next listing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "first.txt")
      yield* fs.writeFileString(`${tmpDir}/first.txt`, "a")
      yield* fs.writeFileString(`${tmpDir}/second.txt`, "b")

      expect(yield* listed(tmpDir)).toEqual([".gitignore", "second.txt"])
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "second.txt")
      expect(yield* listed(tmpDir)).toEqual([".gitignore", "first.txt"])
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

      expect(yield* listed(tmpDir, `${tmpDir}/pkg`)).toEqual([
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

      expect(yield* listed(tmpDir)).toEqual([".gitignore", "logs"])
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("an explicitly named ignored directory is listed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${tmpDir}/dist`)
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "dist/\n")
      yield* fs.writeFileString(`${tmpDir}/dist/b.js`, "x")

      expect(yield* listed(tmpDir, `${tmpDir}/dist`)).toEqual(["b.js"])
    }).pipe(Effect.provide(FallbackLayer)),
  )

  it.scopedLive("the listing has no early break", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      for (let i = 0; i < 50; i++) {
        yield* fs.writeFileString(`${tmpDir}/file-${i}.txt`, `content-${i}`)
      }

      expect((yield* listed(tmpDir)).length).toBe(50)
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

      expect(yield* listed(tmpDir).pipe(Effect.timeout("5 seconds"))).toEqual(["src/a.ts"])
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
  "escaped-bracket-bang": {
    files: ["[!a]", "[^a]", "b"],
    ignores: { ".gitignore": "\\[!a]\n" },
  },
  "trailing-backslash": { files: ["foo", "foo\\"], ignores: { ".gitignore": "foo\\\n" } },
  "class-with-slash": { files: ["a/b", "axb", "a[/]b"], ignores: { ".gitignore": "a[/]b\n" } },
  "negated-class-and-slash": { files: ["a/b", "acb"], ignores: { ".gitignore": "a[!x]b\n" } },
  "leading-dot-slash": { files: ["a", "x/a"], ignores: { ".gitignore": "./a\n" } },
  "question-mark-and-multibyte": {
    files: ["caf\u00E9", "cafe", "caf\u00E9s"],
    ignores: { ".gitignore": "caf?\ncaf??s\n" },
  },
  "unclosed-class": { files: ["a[b", "ab"], ignores: { ".gitignore": "a[b\n" } },
  "literal-multibyte": { files: ["caf\u00E9", "cafe"], ignores: { ".gitignore": "caf\u00E9\n" } },
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

describe("the matcher walk against git", () => {
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
        results[name] = {
          git: git.stdout
            .split("\0")
            .filter((entry) => entry.length > 0)
            .toSorted()
            .join(" | "),
          walk: (yield* listed(plain)).join(" | "),
        }
      }
      for (const [name, result] of Object.entries(results)) {
        expect({ name, listed: result.walk }).toEqual({ name, listed: result.git })
      }
    }).pipe(Effect.provide(FallbackLayer), Effect.timeout("20 seconds")),
  )
})

describe("grep's file listing inside a git work tree", () => {
  it.scopedLive("a subdirectory listing applies the repo's ignore rules above it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", repo])
      yield* writeTree(repo, ["pkg/src/a.ts", "pkg/dist/out.js", "pkg/secret.env"], {
        ".gitignore": "dist/\n",
      })
      yield* fs.writeFileString(`${repo}/.git/info/exclude`, "*.env\n")

      expect(yield* listed(`${repo}/pkg`)).toEqual(["src/a.ts"])
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

        expect(yield* listed(repo)).toEqual([".gitignore", "build/pinned.js", "src/a.ts"])
      }).pipe(Effect.provide(FallbackLayer), Effect.timeout("8 seconds")),
  )

  it.scopedLive("an explicitly named ignored directory is listed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", repo])
      yield* writeTree(repo, ["dist/b.js", "src/a.ts"], { ".gitignore": "dist/\n" })

      expect(yield* listed(repo, `${repo}/dist`)).toEqual(["b.js"])
    }).pipe(Effect.provide(FallbackLayer), Effect.timeout("8 seconds")),
  )
})

/** git with a fixed identity, no signing and no global hooks, for test commits. */
const git = (repo: string, args: ReadonlyArray<string>) =>
  runProcess("git", [
    "-C",
    repo,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.file.allow=always",
    ...args,
  ])

/** Both listing paths answer each listing question the same way. */
const bothLayers = [
  { name: "fallback", layer: FallbackLayer },
  { name: "native-first", layer: LiveLayer },
]

describe("git decides the listing inside a work tree", () => {
  for (const { name, layer } of bothLayers) {
    it.scopedLive(`${name}: a package session applies every exclude source above it`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* fs.makeTempDirectoryScoped()
        yield* runProcess("git", ["init", "-q", repo])
        yield* writeTree(
          repo,
          [
            "packages/foo/src/a.ts",
            "packages/foo/dist/out.js",
            "packages/foo/x.secret",
            "packages/foo/y.local",
          ],
          { ".gitignore": "dist/\n", excludes: "*.local\n" },
        )
        yield* fs.writeFileString(`${repo}/.git/info/exclude`, "*.secret\nexcludes\n")
        yield* git(repo, ["config", "core.excludesFile", `${repo}/excludes`])

        expect(yield* listed(`${repo}/packages/foo`)).toEqual(["src/a.ts"])
      }).pipe(Effect.provide(layer), Effect.timeout("8 seconds")),
    )

    it.scopedLive(`${name}: a session inside an ignored directory lists its files`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* fs.makeTempDirectoryScoped()
        yield* runProcess("git", ["init", "-q", repo])
        yield* writeTree(repo, ["scratch/a.ts", "scratch/sub/b.ts", "scratch/c.log", "top.ts"], {
          ".gitignore": "scratch/\n",
          "scratch/.gitignore": "*.log\n",
        })

        expect(yield* listed(`${repo}/scratch`)).toEqual([".gitignore", "a.ts", "sub/b.ts"])
      }).pipe(Effect.provide(layer), Effect.timeout("8 seconds")),
    )

    it.scopedLive(`${name}: nested repositories and submodules are listed by their own git`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* fs.makeTempDirectoryScoped()
        const source = yield* fs.makeTempDirectoryScoped()
        yield* runProcess("git", ["init", "-q", source])
        yield* writeTree(source, ["s.ts"], {})
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-qm", "source"])
        yield* runProcess("git", ["init", "-q", repo])
        yield* writeTree(repo, ["top.ts"], {})
        yield* git(repo, ["submodule", "add", "-q", source, "mods/s"])
        yield* runProcess("git", ["init", "-q", `${repo}/vendor/lib`])
        yield* writeTree(repo, ["vendor/lib/inner.ts", "vendor/lib/x.tmp"], {
          "vendor/lib/.gitignore": "*.tmp\n",
        })

        expect(yield* listed(repo)).toEqual([
          ".gitmodules",
          "mods/s/s.ts",
          "top.ts",
          "vendor/lib/.gitignore",
          "vendor/lib/inner.ts",
        ])
      }).pipe(Effect.provide(layer), Effect.timeout("8 seconds")),
    )
  }
})

describe("symbolic links", () => {
  for (const { name, layer } of bothLayers) {
    for (const { inWorkTree, where } of [
      { inWorkTree: false, where: "outside a work tree" },
      { inWorkTree: true, where: "inside a work tree" },
    ]) {
      it.scopedLive(`${name}, ${where}: a symbolic link is never listed or walked`, () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const tmpDir = yield* fs.makeTempDirectoryScoped()
          if (inWorkTree) yield* runProcess("git", ["init", "-q", tmpDir])
          yield* writeTree(tmpDir, ["real/r.ts", "zeta/z.ts"], {})
          yield* fs.symlink(`${tmpDir}/real`, `${tmpDir}/alink`)
          yield* fs.symlink(`${tmpDir}/real/r.ts`, `${tmpDir}/flink.ts`)
          yield* fs.symlink(`${tmpDir}/zeta`, `${tmpDir}/zeta/loop`)

          expect(yield* listed(tmpDir)).toEqual(["real/r.ts", "zeta/z.ts"])
        }).pipe(Effect.provide(layer), Effect.timeout("8 seconds")),
      )
    }
  }
})

/**
 * The index over a platform whose spawner rewrites each command first. It
 * stands in for what the index cannot choose: the environment gent inherits,
 * or a git that misbehaves.
 */
const layerWithSpawner = (
  rewrite: (command: ChildProcess.StandardCommand) => ChildProcess.StandardCommand,
  options: { readonly native: boolean },
) => {
  const spawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return real.spawn(command)
        return real.spawn(rewrite(command))
      })
    }),
  ).pipe(Layer.provide(BunServices.layer))
  let platform = Layer.merge(BunServices.layer, spawner)
  if (!options.native) platform = Layer.merge(platform, nativeOff)
  return Layer.merge(platform, Layer.provide(FileIndexLive({ home: "/tmp" }), platform))
}

/** gent started by a hook: its environment names another repository. */
const inheritedEnv = (env: Record<string, string>) => (command: ChildProcess.StandardCommand) =>
  ChildProcess.make(command.command, command.args, {
    ...command.options,
    env: { ...env, ...command.options.env },
    extendEnv: true,
  })

/** A git whose `ls-files` runs `script` instead; every other git command is real. */
const fakeLsFiles = (script: string) => (command: ChildProcess.StandardCommand) => {
  if (command.command !== "git" || !command.args.includes("ls-files")) return command
  return ChildProcess.make("sh", ["-c", script], command.options)
}

describe("the git processes behind a listing", () => {
  for (const { name, native } of [
    { name: "fallback", native: false },
    { name: "native-first", native: true },
  ]) {
    it.scopedLive(`${name}: a GIT_DIR from a hook does not redirect the listing`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* fs.makeTempDirectoryScoped()
        const other = yield* fs.makeTempDirectoryScoped()
        yield* runProcess("git", ["init", "-q", repo])
        yield* runProcess("git", ["init", "-q", other])
        yield* writeTree(repo, ["a.ts", "b.log"], { ".gitignore": "*.log\n" })
        yield* writeTree(other, ["elsewhere.ts"], {})
        const hook = inheritedEnv({
          GIT_DIR: `${other}/.git`,
          GIT_WORK_TREE: other,
          GIT_INDEX_FILE: `${other}/.git/index`,
        })

        const files = yield* listed(repo).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- The spawner's environment names repositories this test creates.
          Effect.provide(layerWithSpawner(hook, { native })),
        )
        expect(files).toEqual([".gitignore", "a.ts"])
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
    )
  }

  it.scopedLive("a listing that passes the file bound stops without reading the rest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", tmpDir])
      yield* writeTree(tmpDir, ["a.ts"], {})
      const endless = fakeLsFiles(`yes x | tr '\\n' '\\000'`)

      const failure = yield* runToolWithCtx(
        GrepTool,
        { pattern: "x", path: tmpDir },
        testToolContext({ cwd: tmpDir }),
      ).pipe(
        Effect.flip,
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(layerWithSpawner(endless, { native: false })),
      )
      expect(failure.message).toContain("more than 100000 files")
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )

  it.scopedLive("a git that never answers times out, and the walk lists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const signals = yield* fs.makeTempDirectoryScoped()
      yield* writeTree(tmpDir, ["a.ts"], {})
      yield* runProcess("mkfifo", [`${signals}/started`])
      const hung = fakeLsFiles(`echo started > ${signals}/started; exec sleep 30`)

      const listing = yield* Effect.forkChild(
        listed(tmpDir).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- The fake git signals through a pipe this test creates.
          Effect.provide(layerWithSpawner(hung, { native: false })),
        ),
      )
      // Reading the pipe returns once git runs, so its timeout is already armed.
      yield* fs.readFileString(`${signals}/started`)
      yield* TestClock.adjust("1 minute")
      expect(yield* Fiber.join(listing)).toEqual(["a.ts"])
    }).pipe(
      // The test clock runs the listing; the live clock bounds the test.
      Effect.provide(Layer.merge(BunServices.layer, TestClock.layer())),
      Effect.timeout("4 seconds"),
    ),
  )
})

describe("an ignored directory with tracked files", () => {
  for (const { name, layer } of [
    { name: "fallback", layer: FallbackLayer },
    { name: "native-first", layer: LiveLayer },
  ]) {
    it.scopedLive(`${name}: an explicit search lists its untracked files too`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* fs.makeTempDirectoryScoped()
        yield* runProcess("git", ["init", "-q", repo])
        yield* writeTree(repo, ["dist/pinned.js", "src/a.ts"], {})
        yield* runProcess("git", ["-C", repo, "add", "."])
        yield* fs.writeFileString(`${repo}/.gitignore`, "dist/\n")
        yield* fs.writeFileString(`${repo}/dist/new.js`, "x")

        expect(yield* listed(repo, `${repo}/dist`)).toEqual(["new.js", "pinned.js"])
      }).pipe(Effect.provide(layer), Effect.timeout("8 seconds")),
    )
  }
})

describe("grep's native file index", () => {
  it.scopedLive("lists the files under the search path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/indexed.txt`, "hello")

      expect(yield* listed(tmpDir)).toEqual(["indexed.txt"])
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

      expect(yield* listed(tmpDir, `${tmpDir}/src`)).toEqual(["deep/a.txt"])
      expect(yield* listed(tmpDir, `${tmpDir}/docs`)).toEqual(["b.txt"])
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

      expect(yield* listed(tmpDir)).toEqual([".gitignore", "src.ts"])
      for (let index = 0; index < 6; index++) {
        expect(yield* listed(tmpDir, `${tmpDir}/vendor/p${index}`)).toEqual(["i.js"])
      }
      expect(yield* listed(tmpDir)).toEqual([".gitignore", "src.ts"])
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

      const inFlight = yield* Effect.forkChild(listed(firstRoot))
      yield* Deferred.await(scanStarted)
      for (const root of others) yield* listed(root)
      // The first finder is evicted, but its listing still holds it.
      expect(heldWas(destroy.mock.contexts)).toBe(false)

      yield* Deferred.succeed(releaseScan, true)
      expect(yield* Fiber.join(inFlight)).toEqual(["file-0.txt"])
      expect(heldWas(search.mock.contexts)).toBe(true)
      expect(heldWas(destroy.mock.contexts)).toBe(true)
    }).pipe(Effect.provide(LiveLayer), Effect.timeout("8 seconds")),
  )

  it.scopedLive("a failing native search falls back to the walk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/hello.txt`, "hi")
      const search = spyOn(NativeFileFinder.prototype, "fileSearch").mockReturnValue({
        ok: false,
        error: "native boom",
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => search.mockRestore()))

      expect(yield* listed(tmpDir)).toEqual(["hello.txt"])
      expect(search).toHaveBeenCalled()
    }).pipe(Effect.provide(LiveLayer), Effect.timeout("8 seconds")),
  )
})
