import { describe, expect, test } from "effect-bun-test"
import { Option, Schema } from "effect"
import { OutputCut } from "@gent/core/protocol"
import {
  bashOutputRows,
  callOperation,
  cellOperations,
  getEditUnifiedDiff,
  getFiletype,
  type ToolCall,
} from "../src/tool-renderers"

// ── edit utils ──────────────────────────────────────────────────────────────

describe("getFiletype", () => {
  // The map itself is data; what a reader sees is the highlighted diff below.
  // These pin the lookup: by the last extension, any case, and none for an
  // unknown or missing one.
  test("reads the last extension in any case, and names nothing it does not know", () => {
    expect(getFiletype("/path/to/file.test.TS")).toBe("typescript")
    expect(Option.isNone(Option.fromUndefinedOr(getFiletype("foo.xyz")))).toBe(true)
    expect(Option.isNone(Option.fromUndefinedOr(getFiletype("Makefile")))).toBe(true)
  })
})

// The edit row's +/- counts are the diff's own lines: a rewrite removes every
// old line and adds every new one, and a shifted edit moves only what changed.
describe("edit diff counts", () => {
  const cases: ReadonlyArray<{
    readonly name: string
    readonly oldString: string
    readonly newString: string
    readonly added: number
    readonly removed: number
  }> = [
    { name: "lines appended", oldString: "a\nb", newString: "a\nb\nc\nd", added: 2, removed: 0 },
    { name: "lines removed", oldString: "a\nb\nc", newString: "a", added: 0, removed: 2 },
    { name: "one line changed", oldString: "a\nb\nc", newString: "a\nX\nc", added: 1, removed: 1 },
    {
      name: "a 3-line rewrite to 5 lines",
      oldString: "a\nb\nc",
      newString: "v\nw\nx\ny\nz",
      added: 5,
      removed: 3,
    },
    {
      name: "a shifted edit of the same length",
      oldString: "a\nb\nc",
      newString: "b\nc\nd",
      added: 1,
      removed: 1,
    },
    {
      name: "a final newline ends the last line",
      oldString: "a\nb\n",
      newString: "",
      added: 0,
      removed: 2,
    },
    { name: "identical text", oldString: "a\nb", newString: "a\nb", added: 0, removed: 0 },
  ]
  for (const { name, oldString, newString, added, removed } of cases) {
    test(name, () => {
      const result = getEditUnifiedDiff({ path: "/foo/bar.ts", oldString, newString })
      expect(Option.map(result, (diff) => [diff.added, diff.removed])).toEqual(
        Option.some([added, removed]),
      )
    })
  }
})

// A group row reads each op as the tool it is: its outcome, its arguments
// from the cwd, and an edit's own line counts.
describe("group ops", () => {
  const place = { cwd: "/work/proj", home: "/home/me" }
  const op = (
    id: string,
    toolName: string,
    input: Readonly<Record<string, string>>,
    status: ToolCall["status"] = "completed",
  ): ToolCall => ({ id, toolName, status, input })

  test("an edit op carries the lines it changed; any other op carries none", () => {
    const edit = op("e1", "edit", {
      path: "/work/proj/src/a.ts",
      oldString: "a\nb\nc",
      newString: "a\nB\nc\nd",
    })
    expect(callOperation(edit, place)).toEqual({
      tool: "edit",
      outcome: "succeeded",
      detail: "src/a.ts",
      diff: { added: 2, removed: 1 },
    })
    expect(callOperation(op("r1", "read", { path: "/home/me/x.md" }, "error"), place)).toEqual({
      tool: "read",
      outcome: "failed",
      detail: "~/x.md",
    })
  })

  // fx counts a command that exits nonzero among a group's failures; the
  // call itself succeeded, but the command did not.
  test("a bash op that exits nonzero failed; one that exits 0 or runs on in the background did not", () => {
    const bash = (output: string): ToolCall => ({
      ...op("b1", "bash", { command: "ls d.ts" }),
      output,
    })
    const outcome = (output: string) => callOperation(bash(output), place).outcome
    expect(outcome('{"stdout":"","stderr":"ls: no d.ts\\n","exitCode":2}')).toBe("failed")
    expect(outcome('{"stdout":"d.ts\\n","stderr":"","exitCode":0}')).toBe("succeeded")
    expect(outcome('{"stdout":"started","stderr":"","exitCode":0,"status":"background"}')).toBe(
      "succeeded",
    )
    const cell: ToolCall = {
      ...op("c1", "cell", { code: "…" }),
      operations: [bash('{"stdout":"","stderr":"","exitCode":1}')],
    }
    expect(cellOperations(cell, place).map((operation) => operation.outcome)).toEqual(["failed"])
  })

  test("a cell's live ops read as group ops, in the order they ran", () => {
    const cell: ToolCall = {
      ...op("c1", "cell", { code: "…" }),
      operations: [
        op("o1", "read", { path: "/work/proj/a.ts" }),
        op("o2", "edit", { path: "/work/proj/a.ts", oldString: "x", newString: "y" }),
        op("o3", "bash", { command: "bun test" }, "running"),
      ],
    }
    expect(
      cellOperations(cell, place).map((operation) => [operation.tool, operation.outcome]),
    ).toEqual([
      ["read", "succeeded"],
      ["edit", "succeeded"],
      ["bash", "running"],
    ])
    expect(cellOperations(cell, place)[1]?.diff).toEqual({ added: 1, removed: 1 })
  })
})

describe("edit diff", () => {
  test("an edit draws a unified diff of its old and new text, highlighted by its path", () => {
    const result = getEditUnifiedDiff({
      path: "/foo/bar.ts",
      oldString: "const x = 1\n",
      newString: "const x = 2\n",
    })
    expect(Option.map(result, (diff) => diff.filetype)).toEqual(Option.some("typescript"))
    const diff = Option.getOrElse(
      Option.map(result, (value) => value.diff),
      () => "",
    )
    expect(diff).toContain("--- /foo/bar.ts")
    expect(diff).toContain("+++ /foo/bar.ts")
    expect(diff).toContain("-const x = 1")
    expect(diff).toContain("+const x = 2")
  })

  // The renderer falls back to the summary line for each of these.
  const undecodable: ReadonlyArray<readonly [string, Parameters<typeof getEditUnifiedDiff>[0]]> = [
    // eslint-disable-next-line effect/noNullish -- A tool call's JSON input can be null.
    ["no input", null],
    ["a string", "string"],
    ["a number", 123],
    ["no path", { oldString: "a", newString: "b" }],
    ["no old text", { path: "/foo.ts", newString: "b" }],
    ["no new text", { path: "/foo.ts", oldString: "a" }],
    ["a path that is not text", { path: 123, oldString: "a", newString: "b" }],
    ["old text that is not text", { path: "/foo", oldString: 123, newString: "b" }],
    ["new text that is not text", { path: "/foo", oldString: "a", newString: 123 }],
  ]
  test("an input that does not decode draws no diff", () => {
    for (const [name, input] of undecodable) {
      expect([name, Option.isNone(getEditUnifiedDiff(input))]).toEqual([name, true])
    }
  })
})

// ── cut bash rows ───────────────────────────────────────────────────────────

/**
 * A reloaded bash op whose stdout was cut. The record counts lines as every
 * reader does, so a final newline ends the last line and adds none; the
 * excerpt is the head, one marker line, then the tail from `tailLine`.
 */
const cutBash = (stdout: string, lines: number, tailLine: number) =>
  bashOutputRows({
    id: "cut",
    toolName: "bash",
    status: "completed",
    input: { command: "seq 1 1000" },
    output: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
      stdout,
      stderr: "",
      exitCode: 0,
    }),
    cuts: [OutputCut.cases.Text.make({ field: "stdout", lines, tailLine, chars: 0 })],
  })

const drawn = (rows: ReturnType<typeof cutBash>["rows"]) =>
  rows.map((row) => {
    if (row._tag === "line") return `${row.lineNum}:${row.text}`
    return `+${row.count}`
  })

describe("cut bash rows", () => {
  test("an output ending in a newline counts its lines, not the empty part after them", () => {
    const rows = cutBash("1\n2\n…\n999\n1000\n", 1000, 999)
    expect(drawn(rows.rows)).toEqual(["1:1", "2:2", "+996", "999:999", "1000:1000"])
    expect(rows.total).toBe(1000)
  })

  test("a tail that keeps nothing draws the gap to the last line", () => {
    const rows = cutBash("1\n2\n…\n", 1000, 1001)
    expect(drawn(rows.rows)).toEqual(["1:1", "2:2", "+998"])
    expect(rows.total).toBe(1000)
  })

  test("a head that keeps nothing draws the gap from line 1", () => {
    const rows = cutBash("…\n999\n1000", 1000, 999)
    expect(drawn(rows.rows)).toEqual(["+998", "999:999", "1000:1000"])
    expect(rows.total).toBe(1000)
  })

  test("an emptied stdout is one gap over all its lines", () => {
    const rows = cutBash("", 2, 3)
    expect(drawn(rows.rows)).toEqual(["+2"])
    expect(rows.total).toBe(2)
  })
})
