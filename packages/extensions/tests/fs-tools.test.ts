import { describe, expect, it, test } from "effect-bun-test"
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  EditTool,
  FilesRpc,
  FsToolsExtension,
  GrepTool,
  ReadTool,
  WriteTool,
} from "../src/fs-tools.js"
import {
  createRpcHarness,
  LanguageModelLayers,
  RuntimeEnvironment,
  runToolWithCtx,
  testToolContext,
  textStep,
} from "@gent/core/test-utils"
import { ref, runProcess } from "@gent/core/extensions/api"
import { BranchId, SessionId, ToolCallId } from "@gent/core/protocol"
import { toolResultSummary } from "@gent/core/extensions/branch-tools"
import { e2ePreset } from "./helpers/test-preset"

// ── read tool ───────────────────────────────────────────────────────────────

const ctx = testToolContext({
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  toolCallId: ToolCallId.make("test-call"),
  home: "/nonexistent/gent-test-home",
})

const PlatformLayer = Layer.merge(
  BunServices.layer,
  RuntimeEnvironment.Live({
    cwd: process.cwd(),
    home: "/nonexistent/test-home",
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

  // Lines the read cuts, from bytes: one past the byte cap, one whose cap splits an emoji, one invalid byte.
  const cutLines = [
    Buffer.from("plain"),
    Buffer.from("é".repeat(5000)),
    Buffer.from(`a${"😀".repeat(2000)}`),
    Buffer.concat([Buffer.from("bad "), Buffer.from([0xff]), Buffer.from(" byte")]),
    Buffer.from("after"),
  ]
  const cutContent = (first: number) =>
    [
      `${first}\tplain`,
      `${first + 1}\t${"é".repeat(2000)} [3000 chars cut]`,
      // The cut moves off the emoji pair it would split.
      `${first + 2}\ta${"😀".repeat(999)} [2002 chars cut]`,
      `${first + 3}\tbad � byte`,
      `${first + 4}\tafter`,
    ].join("\n")

  readTest("a long line is cut, with a marker that counts what it lost", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${tmpDir}/cut.txt`
      yield* fs.writeFile(
        testFile,
        Buffer.concat(cutLines.flatMap((line) => [line, Buffer.from("\n")])),
      )

      const result = yield* runToolWithCtx(ReadTool, { path: testFile }, ctx)
      expect(result.content).toBe(cutContent(1))
      expect(result.lineCount).toBe(5)
      expect(result.lossy).toBe(true)
    }),
  )

  // A large file streams: every line is counted, and only the lines shown are decoded and checked.
  readTest("a large file reads its window, cut, without decoding the rest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${tmpDir}/large.txt`
      const filler = (from: number, count: number) =>
        Buffer.from(
          Array.from({ length: count }, (_, index) => `line ${from + index} `.padEnd(99, "x")).join(
            "\n",
          ),
        )
      // 250,000 lines of 100 bytes, about 25 MB; the last line has no newline.
      yield* fs.writeFile(
        testFile,
        Buffer.concat([
          filler(1, 100_000),
          Buffer.from("\n"),
          ...cutLines.flatMap((line) => [line, Buffer.from("\n")]),
          filler(100_006, 149_995),
        ]),
      )

      const [elapsed, result] = yield* Effect.timed(
        runToolWithCtx(ReadTool, { path: testFile, offset: 100_001, limit: 5 }, ctx),
      )
      expect(result.content).toBe(cutContent(100_001))
      expect(result.lineCount).toBe(250_000)
      expect(result.truncated).toBe(true)
      expect(result.nextOffset).toBe(100_006)
      expect(result.lossy).toBe(true)
      expect(Duration.toMillis(elapsed)).toBeLessThan(5000)

      // The invalid byte lies outside this window, and the last line has no newline.
      const tail = yield* runToolWithCtx(ReadTool, { path: testFile, offset: 249_999 }, ctx)
      expect(tail.content).toBe(
        `249999\t${"line 249999 ".padEnd(99, "x")}\n250000\t${"line 250000 ".padEnd(99, "x")}`,
      )
      expect(tail.truncated).toBe(false)
      expect(tail.lossy).toBeUndefined()
    }).pipe(Effect.timeout("30 seconds")),
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

// ── write tool ──────────────────────────────────────────────────────────────

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

// ── edit tool ───────────────────────────────────────────────────────────────

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
    runToolWithCtx(EditTool, { path: filePath, ...params }, stubCtx).pipe(
      Effect.provide(editLayer),
    ),
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
    {
      name: "curly quotes around a code escape the file holds",
      file: "s = “a\\nb”",
      oldString: '"a\\nb"',
      after: "s = X",
    },
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
  // A search that matches only once unescaped says nothing about how its
  // replacement was written, so the edit is refused rather than guessed.
  for (const { name, file, oldString, newString } of [
    {
      name: "an escaped search whose replacement holds a code escape",
      file: "a\nb\n",
      oldString: "a\\nb",
      newString: 'const s = "\\n";',
    },
    {
      name: "an escaped search on a CRLF file",
      file: "a\r\nb\r\n",
      oldString: "a\\nb",
      newString: "x",
    },
    { name: "a literal \\t", file: "col1\tcol2", oldString: "col1\\tcol2", newString: "X" },
    { name: "a literal \\r", file: "before\rafter", oldString: "before\\rafter", newString: "X" },
    { name: "an escaped backslash", file: "a\\b", oldString: "a\\\\b", newString: "X" },
    // One pass: `\\n` reads as a backslash and an n, not a backslash and a newline.
    {
      name: "a double-escaped \\n",
      file: "a\\nb",
      oldString: "a\\\\nb",
      newString: "X",
    },
  ]) {
    editTest(`${name} is refused and the file stays`, () =>
      Effect.gen(function* () {
        const edited = yield* editFile(file, { oldString, newString })
        expect(edited.exit._tag).toBe("Failure")
        expect(edited.failure).toContain("matched only after unescaping")
        expect(edited.after).toBe(file)
      }),
    )
  }
  editTest("an exact search keeps the escapes its replacement holds", () =>
    Effect.gen(function* () {
      const edited = yield* editFile('s = "a"\n', {
        oldString: '"a"',
        newString: '"a\\nb"',
      })
      expect(edited.after).toBe('s = "a\\nb"\n')
    }),
  )
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
        ).pipe(Effect.provide(editLayer))
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
      ).pipe(Effect.provide(editLayer))
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
      ).pipe(Effect.provide(editLayer))
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
        ).pipe(Effect.provide(editLayer)),
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
        runToolWithCtx(
          EditTool,
          { path: filePath, oldString: "foo", newString: "baz" },
          stubCtx,
        ).pipe(Effect.provide(editLayer)),
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
      ).pipe(Effect.provide(editLayer))
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
        ).pipe(Effect.provide(editLayer)),
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
        runToolWithCtx(
          EditTool,
          { path: filePath, oldString: "foo\nbar", newString: "x" },
          stubCtx,
        ).pipe(Effect.provide(editLayer)),
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
      ).pipe(Effect.provide(editLayer))
      expect(result.replacements).toBe(2)
      expect(yield* fs.readFileString(filePath)).toBe("x\nmid\nx\n")
    }),
  )
})

// ── file encodings ──────────────────────────────────────────────────────────

/** `text` as a UTF-16 file with its byte order mark. */
const utf16File = (text: string, order: "le" | "be") => {
  const littleEndian = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])
  if (order === "le") return littleEndian
  return Buffer.from(littleEndian).swap16()
}

describe("file encodings", () => {
  const encodingTest = it.scopedLive.layer(editLayer)

  const orders: ReadonlyArray<"le" | "be"> = ["le", "be"]
  for (const order of orders) {
    encodingTest(`read returns the text of a UTF-16 ${order} file`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const filePath = `${dir}/utf16.txt`
        yield* fs.writeFile(filePath, utf16File("hello NEEDLE\nsecond line", order))
        const result = yield* runToolWithCtx(ReadTool, { path: filePath }, stubCtx)
        expect(result.content).toBe("1\thello NEEDLE\n2\tsecond line")
        expect(result.lineCount).toBe(2)
        expect(result.lossy).toBeUndefined()
      }),
    )

    encodingTest(`edit finds text in a UTF-16 ${order} file and keeps its encoding`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const filePath = `${dir}/utf16.txt`
        yield* fs.writeFile(filePath, utf16File("hello NEEDLE\nsecond line\n", order))
        const result = yield* runToolWithCtx(
          EditTool,
          { path: filePath, oldString: "hello", newString: "goodbye" },
          stubCtx,
        )
        expect(result.replacements).toBe(1)
        const after = Buffer.from(yield* fs.readFile(filePath))
        expect(after.equals(utf16File("goodbye NEEDLE\nsecond line\n", order))).toBe(true)
      }),
    )
  }

  encodingTest("edit keeps a UTF-8 byte order mark", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${dir}/bom.txt`
      const bom = Buffer.from([0xef, 0xbb, 0xbf])
      yield* fs.writeFile(filePath, Buffer.concat([bom, Buffer.from("hello world\n")]))
      yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "hello", newString: "goodbye" },
        stubCtx,
      )
      const after = Buffer.from(yield* fs.readFile(filePath))
      expect(after.equals(Buffer.concat([bom, Buffer.from("goodbye world\n")]))).toBe(true)
    }),
  )

  const atomicModes: ReadonlyArray<[string, boolean]> = [
    ["a write", false],
    ["an atomic write", true],
  ]
  for (const [how, atomic] of atomicModes) {
    encodingTest(`${how} over a file keeps its byte order mark and encoding`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const bomPath = `${dir}/bom.txt`
        const bom = Buffer.from([0xef, 0xbb, 0xbf])
        yield* fs.writeFile(bomPath, Buffer.concat([bom, Buffer.from("hi\n")]))
        const written = yield* runToolWithCtx(
          WriteTool,
          { path: bomPath, content: "bye\n", atomic },
          stubCtx,
        )
        const bomAfter = Buffer.from(yield* fs.readFile(bomPath))
        expect(bomAfter.equals(Buffer.concat([bom, Buffer.from("bye\n")]))).toBe(true)
        expect(written.bytesWritten).toBe(bomAfter.length)

        const utf16Path = `${dir}/utf16.txt`
        yield* fs.writeFile(utf16Path, utf16File("hi\n", "be"))
        yield* runToolWithCtx(WriteTool, { path: utf16Path, content: "bye\n", atomic }, stubCtx)
        const utf16After = Buffer.from(yield* fs.readFile(utf16Path))
        expect(utf16After.equals(utf16File("bye\n", "be"))).toBe(true)
      }),
    )
  }

  encodingTest("edit matches across lines in a CRLF file and writes CRLF line endings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${dir}/crlf.txt`
      yield* fs.writeFileString(filePath, "alpha\r\nbeta\r\ngamma\r\n")
      const result = yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "alpha\nbeta", newString: "one\ntwo\nthree" },
        stubCtx,
      )
      expect(result.replacements).toBe(1)
      expect(yield* fs.readFileString(filePath)).toBe("one\r\ntwo\r\nthree\r\ngamma\r\n")
    }),
  )

  encodingTest(
    "edit in a mixed file gives the replacement its line's ending and leaves other lines alone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const filePath = `${dir}/mixed.txt`
        yield* fs.writeFileString(filePath, "a\r\nb\nc\r\nd\n")
        yield* runToolWithCtx(
          EditTool,
          { path: filePath, oldString: "b\nc", newString: "B\nC" },
          stubCtx,
        )
        expect(yield* fs.readFileString(filePath)).toBe("a\r\nB\nC\r\nd\n")
        yield* runToolWithCtx(
          EditTool,
          { path: filePath, oldString: "a\nB", newString: "x\ny\nB" },
          stubCtx,
        )
        expect(yield* fs.readFileString(filePath)).toBe("x\r\ny\r\nB\nC\r\nd\n")
      }),
  )

  encodingTest("a CRLF search in a mixed file replaces only the CRLF sites", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${dir}/mixed.txt`
      yield* fs.writeFileString(filePath, "a\nb\n--\na\r\nb\r\n")
      const result = yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "a\r\nb", newString: "X", replaceAll: true },
        stubCtx,
      )
      expect(result.replacements).toBe(1)
      expect(yield* fs.readFileString(filePath)).toBe("a\nb\n--\nX\r\n")
    }),
  )

  // A match never starts or ends between a CR and its LF.
  const crlfEdits: ReadonlyArray<[string, string, string, string, string]> = [
    [
      "a search that starts with LF takes the CR before it",
      "prev\r\nfoo\r\nnext\r\n",
      "\nfoo",
      "\nbar",
      "prev\r\nbar\r\nnext\r\n",
    ],
    [
      "a line deleted from its LF takes its CR too",
      "prev\r\nfoo\r\nnext\r\n",
      "\nfoo",
      "",
      "prev\r\nnext\r\n",
    ],
  ]
  for (const [name, before, oldString, newString, after] of crlfEdits) {
    encodingTest(name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const filePath = `${dir}/crlf.txt`
        yield* fs.writeFileString(filePath, before)
        const result = yield* runToolWithCtx(
          EditTool,
          { path: filePath, oldString, newString },
          stubCtx,
        )
        expect(result.replacements).toBe(1)
        expect(yield* fs.readFileString(filePath)).toBe(after)
      }),
    )
  }

  encodingTest("a search that ends between a CR and its LF matches nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${dir}/crlf.txt`
      yield* fs.writeFileString(filePath, "a\r\nb\r\n")
      const failed = yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "a\r", newString: "Z" },
        stubCtx,
      ).pipe(Effect.flip)
      expect(failed.message).toBe("oldString not found in file")
      expect(yield* fs.readFileString(filePath)).toBe("a\r\nb\r\n")
    }),
  )

  // [name, file, oldString, newString, replaceAll, count, file after]
  const lineEndEdits: ReadonlyArray<[string, string, string, string, boolean, number, string]> = [
    ["a bare-CR file: a middle line edits in place", "a\rb\rc", "b", "B", false, 1, "a\rB\rc"],
    [
      "a bare-CR file: a replacement's line breaks take CR",
      "a\rb\rc",
      "b",
      "b1\nb2",
      false,
      1,
      "a\rb1\rb2\rc",
    ],
    ["a bare-CR file: replaceAll edits every site", "a\rb\ra", "a", "z", true, 2, "z\rb\rz"],
    [
      "a CRLF search that ends at the last CRLF keeps it whole",
      "x\r\nfoo\r\n",
      "foo\r\n",
      "bar\n",
      false,
      1,
      "x\r\nbar\r\n",
    ],
    [
      "an LF search that ends at the last CRLF takes the CR too",
      "x\r\nfoo\r\n",
      "foo\n",
      "bar\n",
      false,
      1,
      "x\r\nbar\r\n",
    ],
    [
      "a line deleted up to the last CRLF leaves no stray CR",
      "x\r\nfoo\r\n",
      "foo\n",
      "",
      false,
      1,
      "x\r\n",
    ],
  ]
  for (const [name, before, oldString, newString, replaceAll, count, after] of lineEndEdits) {
    encodingTest(name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const filePath = `${dir}/endings.txt`
        yield* fs.writeFileString(filePath, before)
        const result = yield* runToolWithCtx(
          EditTool,
          { path: filePath, oldString, newString, replaceAll },
          stubCtx,
        )
        expect(result.replacements).toBe(count)
        expect(yield* fs.readFileString(filePath)).toBe(after)
      }),
    )
  }

  encodingTest("an LF search in a mixed file finds the CRLF sites too", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${dir}/mixed.txt`
      yield* fs.writeFileString(filePath, "a\nb\n--\na\r\nb\r\n")
      const duplicate = yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "a\nb", newString: "X" },
        stubCtx,
      ).pipe(Effect.flip)
      expect(duplicate.message).toContain("found 2 times")
      const result = yield* runToolWithCtx(
        EditTool,
        { path: filePath, oldString: "a\nb", newString: "X\nY", replaceAll: true },
        stubCtx,
      )
      expect(result.replacements).toBe(2)
      expect(yield* fs.readFileString(filePath)).toBe("X\nY\n--\nX\r\nY\r\n")
    }),
  )

  // Bytes the decoder can only show as U+FFFD: a rewrite of the text would not
  // give them back.
  const malformed: ReadonlyArray<[string, Uint8Array]> = [
    [
      "a UTF-16 file with an odd trailing byte",
      Buffer.concat([utf16File("hello world\n", "le"), Buffer.from([0x41])]),
    ],
    [
      "a UTF-8 file with an invalid byte",
      Buffer.concat([Buffer.from("hello "), Buffer.from([0xff]), Buffer.from(" world\n")]),
    ],
  ]
  for (const [name, bytes] of malformed) {
    encodingTest(`${name}: read marks it lossy, and edit and write leave it alone`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const filePath = `${dir}/malformed.txt`
        yield* fs.writeFile(filePath, bytes)

        const read = yield* runToolWithCtx(ReadTool, { path: filePath }, stubCtx)
        expect(read.lossy).toBe(true)
        expect(read.content).toContain("�")

        const edit = yield* Effect.exit(
          runToolWithCtx(
            EditTool,
            { path: filePath, oldString: "hello", newString: "goodbye" },
            stubCtx,
          ),
        )
        expect(Exit.isFailure(edit)).toBe(true)
        if (Exit.isFailure(edit)) expect(Cause.pretty(edit.cause)).toContain("not valid")

        const write = yield* Effect.exit(
          runToolWithCtx(WriteTool, { path: filePath, content: read.content }, stubCtx),
        )
        expect(Exit.isFailure(write)).toBe(true)
        if (Exit.isFailure(write)) expect(Cause.pretty(write.cause)).toContain("not valid")

        expect(Buffer.from(yield* fs.readFile(filePath)).equals(Buffer.from(bytes))).toBe(true)
      }),
    )
  }

  // A lone surrogate has no UTF-8 bytes, and in a UTF-16 file it makes the
  // next read lossy: write and edit refuse it and leave the file alone.
  encodingTest("write and edit refuse text with a lone surrogate", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const newPath = `${dir}/new.txt`
      const created = yield* runToolWithCtx(
        WriteTool,
        { path: newPath, content: "x\uD800y" },
        stubCtx,
      ).pipe(Effect.flip)
      expect(created.message).toContain("lone surrogate")
      expect(yield* fs.exists(newPath)).toBe(false)

      const utf16Path = `${dir}/utf16.txt`
      const before = utf16File("hello\n", "le")
      yield* fs.writeFile(utf16Path, before)
      const written = yield* runToolWithCtx(
        WriteTool,
        { path: utf16Path, content: "x\uDC00y" },
        stubCtx,
      ).pipe(Effect.flip)
      expect(written.message).toContain("lone surrogate")
      const edited = yield* runToolWithCtx(
        EditTool,
        { path: utf16Path, oldString: "hello", newString: "x\uD800" },
        stubCtx,
      ).pipe(Effect.flip)
      expect(edited.message).toContain("lone surrogate")
      expect(Buffer.from(yield* fs.readFile(utf16Path)).equals(before)).toBe(true)
    }),
  )

  encodingTest("read refuses a binary file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const filePath = `${dir}/blob.bin`
      yield* fs.writeFile(filePath, new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x00]))
      const exit = yield* Effect.exit(runToolWithCtx(ReadTool, { path: filePath }, stubCtx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("binary file")
    }),
  )
})

// ── grep tool ───────────────────────────────────────────────────────────────

const IndexLayer = BunServices.layer
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
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
  )

  it.scopedLive("a target whose name starts with two dots keeps the session's ignore rules", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "*.log\n")
      yield* fs.makeDirectory(`${tmpDir}/..cache`)
      yield* fs.writeFileString(`${tmpDir}/..cache/a.log`, "const foo = 0")
      yield* fs.writeFileString(`${tmpDir}/..cache/b.ts`, "const foo = 1")

      const result = yield* runToolWithCtx(
        GrepTool,
        { pattern: "foo", path: `${tmpDir}/..cache` },
        testToolContext({ cwd: tmpDir }),
      )
      expect(result.matches.map((match) => match.file)).toEqual([`${tmpDir}/..cache/b.ts`])
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
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
    }).pipe(Effect.provide(IndexLayer)),
  )

  // `(x+x+)+y` backtracks exponentially on a run of x with no y after it.
  // JavaScriptCore gives up on such a line after about a second and reports
  // no match, even for a line that holds one.
  it.scopedLive("a backtracking pattern does not stall the server, and a timeout ends it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const slowLine = `${"x".repeat(28)}!`
      yield* fs.writeFileString(`${tmpDir}/slow.txt`, Array(8).fill(slowLine).join("\n"))

      const started = yield* Clock.currentTimeMillis
      const result = yield* runToolWithCtx(
        GrepTool,
        { pattern: "(x+x+)+y", path: tmpDir },
        ctxGrep,
      ).pipe(Effect.timeoutOption("300 millis"))
      const elapsed = (yield* Clock.currentTimeMillis) - started
      expect(Option.isNone(result)).toBe(true)
      // On the server thread, the search runs every line to the end before a timeout can act.
      expect(elapsed).toBeLessThan(1500)
    }).pipe(Effect.provide(IndexLayer)),
  )

  // Each line holds a match, but JavaScriptCore stops at its backtrack limit
  // and reports none. `(?:a|a)*b` is the fastest give-up measured (about 320 ms
  // on an M-series Mac); `(x+x+)+y` takes 600 ms to a second.
  const giveUps: ReadonlyArray<[string, string]> = [
    ["(x+x+)+y", `${"x".repeat(30)}!xxy`],
    ["(?:a|a)*b", `${"a".repeat(40)}!ab`],
  ]
  for (const [pattern, line] of giveUps) {
    it.scopedLive(`a line ${pattern} gives up on is reported, not dropped`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${tmpDir}/slow.txt`, `plain line\n${line}\n`)

        const result = yield* runToolWithCtx(GrepTool, { pattern, path: tmpDir }, ctxGrep).pipe(
          Effect.timeout("20 seconds"),
        )
        expect(result.matches).toEqual([])
        expect(result.undecided).toBe(1)
      }).pipe(Effect.provide(IndexLayer)),
    )
  }

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
    }).pipe(Effect.provide(IndexLayer)),
  )

  it.scopedLive("a UTF-16 file with a byte order mark is searched, not skipped as binary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const text = "first\nthe needle here\n"
      const littleEndian = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])
      const bigEndian = Buffer.from(littleEndian).swap16()
      yield* fs.writeFile(`${tmpDir}/le.txt`, littleEndian)
      yield* fs.writeFile(`${tmpDir}/be.txt`, bigEndian)

      const result = yield* runToolWithCtx(GrepTool, { pattern: "needle", path: tmpDir }, ctxGrep)
      expect(
        result.matches.map((match) => [
          match.file.slice(tmpDir.length + 1),
          match.line,
          match.content,
        ]),
      ).toEqual([
        ["be.txt", 2, "the needle here"],
        ["le.txt", 2, "the needle here"],
      ])
    }).pipe(Effect.provide(IndexLayer)),
  )

  it.scopedLive("results keep listing order and the limit across many files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const names = Array.from({ length: 300 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`)
      for (const name of names) yield* fs.writeFileString(`${tmpDir}/${name}`, "hit\nhit\n")

      const all = yield* runToolWithCtx(
        GrepTool,
        { pattern: "hit", path: tmpDir, limit: 1000 },
        ctxGrep,
      )
      const files = all.matches.map((match) => match.file.slice(tmpDir.length + 1))
      expect(files).toEqual(names.flatMap((name) => [name, name]))
      expect(all.truncated).toBe(false)

      const cut = yield* runToolWithCtx(
        GrepTool,
        { pattern: "hit", path: tmpDir, limit: 5 },
        ctxGrep,
      )
      expect(cut.matches.map((match) => [match.file.slice(tmpDir.length + 1), match.line])).toEqual(
        all.matches.slice(0, 5).map((match) => [match.file.slice(tmpDir.length + 1), match.line]),
      )
      expect(cut.truncated).toBe(true)
    }).pipe(Effect.provide(IndexLayer)),
  )

  it.scopedLive("a file over the size cap is skipped and counted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/big.log`, `needle\n${"x".repeat(11 * 1024 * 1024)}`)
      yield* fs.writeFileString(`${tmpDir}/small.txt`, "needle\n")

      const result = yield* runToolWithCtx(GrepTool, { pattern: "needle", path: tmpDir }, ctxGrep)
      expect(result.matches.map((match) => match.file.slice(tmpDir.length + 1))).toEqual([
        "small.txt",
      ])
      expect(result.oversized).toBe(1)
    }).pipe(Effect.provide(IndexLayer)),
  )

  it.scopedLive("a cut never splits a surrogate pair", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      // The match sits past the cut, and an emoji straddles each cut end.
      const long = `${"a".repeat(499)}😀${"b".repeat(99)}needle${"c".repeat(393)}😀${"d".repeat(900)}`
      yield* fs.writeFileString(`${tmpDir}/emoji.txt`, long)

      const result = yield* runToolWithCtx(GrepTool, { pattern: "needle", path: tmpDir }, ctxGrep)
      const content = result.matches[0]?.content ?? ""
      expect(content).toContain("needle")
      expect(content.isWellFormed()).toBe(true)
      expect(
        content.replace(/^\[\d+ chars cut\] | \[\d+ chars cut\]$/g, "").length,
      ).toBeLessThanOrEqual(500)
    }).pipe(Effect.provide(IndexLayer)),
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
      }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer)),
  )
})

// ── file index ──────────────────────────────────────────────────────────────

describe("grep's file listing outside a git work tree", () => {
  it.scopedLive("lists every file, dotfiles too", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "node_modules")
      yield* fs.writeFileString(`${tmpDir}/a.ts`, "hello")
      yield* fs.writeFileString(`${tmpDir}/b.js`, "world")

      expect(yield* listed(tmpDir)).toEqual([".gitignore", "a.ts", "b.js"])
    }).pipe(Effect.provide(IndexLayer)),
  )

  it.scopedLive("a .gitignore line drops the file it names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "ignored.txt")
      yield* fs.writeFileString(`${tmpDir}/kept.txt`, "keep")
      yield* fs.writeFileString(`${tmpDir}/ignored.txt`, "skip")

      expect(yield* listed(tmpDir)).toEqual([".gitignore", "kept.txt"])
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer)),
  )

  it.scopedLive("an explicitly named ignored directory is listed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${tmpDir}/dist`)
      yield* fs.writeFileString(`${tmpDir}/.gitignore`, "dist/\n")
      yield* fs.writeFileString(`${tmpDir}/dist/b.js`, "x")

      expect(yield* listed(tmpDir, `${tmpDir}/dist`)).toEqual(["b.js"])
    }).pipe(Effect.provide(IndexLayer)),
  )

  it.scopedLive("the listing has no early break", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      for (let i = 0; i < 50; i++) {
        yield* fs.writeFileString(`${tmpDir}/file-${i}.txt`, `content-${i}`)
      }

      expect((yield* listed(tmpDir)).length).toBe(50)
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer)),
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
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("20 seconds")),
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
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
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
      }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
  )

  it.scopedLive("an explicitly named ignored directory is listed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", repo])
      yield* writeTree(repo, ["dist/b.js", "src/a.ts"], { ".gitignore": "dist/\n" })

      expect(yield* listed(repo, `${repo}/dist`)).toEqual(["b.js"])
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
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

describe("git decides the listing inside a work tree", () => {
  it.scopedLive("a package session applies every exclude source above it", () =>
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
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
  )

  it.scopedLive("a session inside an ignored directory lists its files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", repo])
      yield* writeTree(repo, ["scratch/a.ts", "scratch/sub/b.ts", "scratch/c.log", "top.ts"], {
        ".gitignore": "scratch/\n",
        "scratch/.gitignore": "*.log\n",
      })

      expect(yield* listed(`${repo}/scratch`)).toEqual([".gitignore", "a.ts", "sub/b.ts"])
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
  )

  it.scopedLive("nested repositories and submodules are listed by their own git", () =>
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
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
  )
})

describe("the listing outside a work tree", () => {
  it.scopedLive("the .gitignore rules decide, and dotfiles are listed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      yield* writeTree(
        tmpDir,
        [".env", ".github/ci.yml", "a.ts", "dist/o.js", "node_modules/x/i.js"],
        { ".gitignore": "dist/\n" },
      )

      expect(yield* listed(tmpDir)).toEqual([
        ".env",
        ".github/ci.yml",
        ".gitignore",
        "a.ts",
        "node_modules/x/i.js",
      ])
      expect(yield* listed(tmpDir, `${tmpDir}/dist`)).toEqual(["o.js"])
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("4 seconds")),
  )
})

describe("symbolic links", () => {
  for (const { inWorkTree, where } of [
    { inWorkTree: false, where: "outside a work tree" },
    { inWorkTree: true, where: "inside a work tree" },
  ]) {
    it.scopedLive(`${where}: a symbolic link is never listed or walked`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        if (inWorkTree) yield* runProcess("git", ["init", "-q", tmpDir])
        yield* writeTree(tmpDir, ["real/r.ts", "zeta/z.ts"], {})
        yield* fs.symlink(`${tmpDir}/real`, `${tmpDir}/alink`)
        yield* fs.symlink(`${tmpDir}/real/r.ts`, `${tmpDir}/flink.ts`)
        yield* fs.symlink(`${tmpDir}/zeta`, `${tmpDir}/zeta/loop`)

        expect(yield* listed(tmpDir)).toEqual(["real/r.ts", "zeta/z.ts"])
      }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
    )
  }
})

describe("a tracked path under a directory that is now a link", () => {
  it.scopedLive("is not read through the link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs.makeTempDirectoryScoped()
      const outside = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", repo])
      yield* writeTree(repo, ["sub/a.ts", "keep.ts"], {})
      yield* runProcess("git", ["-C", repo, "add", "."])
      yield* writeTree(outside, ["a.ts"], {})
      yield* fs.remove(`${repo}/sub`, { recursive: true })
      yield* fs.symlink(outside, `${repo}/sub`)

      expect(yield* listed(repo)).toEqual(["keep.ts"])
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
  )
})

/**
 * The index over a platform whose spawner rewrites each command first. It
 * stands in for what the index cannot choose: the environment gent inherits,
 * or a git that misbehaves.
 */
const layerWithSpawner = (
  rewrite: (command: ChildProcess.StandardCommand) => ChildProcess.StandardCommand,
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
  return Layer.merge(BunServices.layer, spawner)
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

describe("git index entries that are not files on disk", () => {
  it.scopedLive("a sparse index past the file bound still lists the files on disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", repo])
      yield* writeTree(repo, ["keep/a.ts"], {})
      const blob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
      yield* runProcess("sh", [
        "-c",
        `seq 0 100000 | awk '{printf "100644 ${blob}\\tfar/f%s.ts\\n", $1}' | git -C "$0" update-index --index-info && seq 0 100000 | awk '{printf "far/f%s.ts\\n", $1}' | git -C "$0" update-index --skip-worktree --stdin`,
        repo,
      ])

      expect(yield* listed(repo)).toEqual(["keep/a.ts"])
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("4 seconds")),
  )

  it.scopedLive("a name that is not valid UTF-8 is counted, not silently lost", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", repo])
      yield* writeTree(repo, ["a.ts"], {})
      yield* runProcess("sh", [
        "-c",
        `printf '100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\\tbad\\377.ts\\n' | git -C "$0" update-index --index-info`,
        repo,
      ])

      const result = yield* runToolWithCtx(
        GrepTool,
        { pattern: "x", path: repo },
        testToolContext({ cwd: repo }),
      )
      expect(result.matches.map((match) => match.file)).toEqual([`${repo}/a.ts`])
      expect(result.unreadable).toBe(1)
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("4 seconds")),
  )
})

describe("the git processes behind a listing", () => {
  it.scopedLive("a GIT_DIR from a hook does not redirect the listing", () =>
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

      const files = yield* listed(repo).pipe(Effect.provide(layerWithSpawner(hook)))
      expect(files).toEqual([".gitignore", "a.ts"])
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )

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
      ).pipe(Effect.flip, Effect.provide(layerWithSpawner(endless)))
      expect(failure.message).toContain("more than 100000 files")
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("4 seconds")),
  )

  it.scopedLive("a git that never answers times out, and the search asks for a narrower path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectoryScoped()
      const signals = yield* fs.makeTempDirectoryScoped()
      yield* writeTree(tmpDir, ["a.ts"], {})
      yield* runProcess("mkfifo", [`${signals}/started`])
      const hung = fakeLsFiles(`echo started > ${signals}/started; exec sleep 30`)

      const listing = yield* Effect.forkChild(
        listed(tmpDir).pipe(Effect.flip, Effect.provide(layerWithSpawner(hung))),
      )
      // Reading the pipe returns once git runs, so its timeout is already armed.
      yield* fs.readFileString(`${signals}/started`)
      yield* TestClock.adjust("1 minute")
      // A timed-out git may be a huge work tree: the .gitignore walk would
      // miss info/exclude and the global excludes there.
      expect((yield* Fiber.join(listing)).message).toContain("search a narrower path")
    }).pipe(
      // The test clock runs the listing; the live clock bounds the test.
      Effect.provide(Layer.merge(BunServices.layer, TestClock.layer())),
      Effect.timeout("4 seconds"),
    ),
  )
})

describe("an ignored directory with tracked files", () => {
  it.scopedLive("an explicit search lists its untracked files too", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs.makeTempDirectoryScoped()
      yield* runProcess("git", ["init", "-q", repo])
      yield* writeTree(repo, ["dist/pinned.js", "src/a.ts"], {})
      yield* runProcess("git", ["-C", repo, "add", "."])
      yield* fs.writeFileString(`${repo}/.gitignore`, "dist/\n")
      yield* fs.writeFileString(`${repo}/dist/new.js`, "x")

      expect(yield* listed(repo, `${repo}/dist`)).toEqual(["new.js", "pinned.js"])
    }).pipe(Effect.provide(IndexLayer), Effect.timeout("8 seconds")),
  )
})

describe("the file listing request", () => {
  it.scopedLive(
    "lists the session's files as git lists them, relative and sorted",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* fs.makeTempDirectoryScoped()
        yield* runProcess("git", ["init", "-q", repo])
        yield* writeTree(repo, ["src/b.ts", "a.md", "dist/out.js", ".turbo/log.txt"], {
          ".gitignore": "dist/\n.turbo/\n",
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          cwd: repo,
          providerLayer,
          extensionInputs: [FsToolsExtension],
        })
        const raw = yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: ref(FilesRpc.List).extensionId,
          capabilityId: ref(FilesRpc.List).capabilityId,
          input: {},
        })
        expect(yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(raw)).toEqual([
          ".gitignore",
          "a.md",
          "src/b.ts",
        ])
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
    15_000,
  )
})
