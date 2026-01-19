import { describe, test, expect } from "bun:test"
import { getFiletype, countDiffLines, getEditUnifiedDiff } from "./edit-utils.js"

describe("getFiletype", () => {
  test("maps common extensions", () => {
    expect(getFiletype("foo.ts")).toBe("typescript")
    expect(getFiletype("bar.tsx")).toBe("tsx")
    expect(getFiletype("baz.js")).toBe("javascript")
    expect(getFiletype("qux.jsx")).toBe("jsx")
    expect(getFiletype("script.py")).toBe("python")
    expect(getFiletype("main.rs")).toBe("rust")
    expect(getFiletype("main.go")).toBe("go")
    expect(getFiletype("README.md")).toBe("markdown")
    expect(getFiletype("config.json")).toBe("json")
    expect(getFiletype("config.yaml")).toBe("yaml")
    expect(getFiletype("config.yml")).toBe("yaml")
    expect(getFiletype("Cargo.toml")).toBe("toml")
  })

  test("handles case insensitivity", () => {
    expect(getFiletype("foo.TS")).toBe("typescript")
    expect(getFiletype("bar.JSON")).toBe("json")
  })

  test("returns undefined for unknown extensions", () => {
    expect(getFiletype("foo.xyz")).toBe(undefined)
    expect(getFiletype("foo.cpp")).toBe(undefined)
  })

  test("handles paths with multiple dots", () => {
    expect(getFiletype("/path/to/file.test.ts")).toBe("typescript")
    expect(getFiletype("foo.bar.baz.json")).toBe("json")
  })

  test("handles paths without extension", () => {
    expect(getFiletype("Makefile")).toBe(undefined)
    expect(getFiletype("/bin/bash")).toBe(undefined)
  })
})

describe("countDiffLines", () => {
  test("counts lines added", () => {
    const oldStr = "line1\nline2"
    const newStr = "line1\nline2\nline3\nline4"
    const result = countDiffLines(oldStr, newStr)
    expect(result).toEqual({ added: 2, removed: 0 })
  })

  test("counts lines removed", () => {
    const oldStr = "line1\nline2\nline3"
    const newStr = "line1"
    const result = countDiffLines(oldStr, newStr)
    expect(result).toEqual({ added: 0, removed: 2 })
  })

  test("counts changed lines when same count", () => {
    const oldStr = "aaa\nbbb\nccc"
    const newStr = "aaa\nXXX\nccc"
    const result = countDiffLines(oldStr, newStr)
    expect(result).toEqual({ added: 1, removed: 1 })
  })

  test("handles empty strings", () => {
    expect(countDiffLines("", "line1")).toEqual({ added: 1, removed: 0 })
    expect(countDiffLines("line1", "")).toEqual({ added: 0, removed: 1 })
    expect(countDiffLines("", "")).toEqual({ added: 0, removed: 0 })
  })

  test("handles identical strings", () => {
    const str = "line1\nline2"
    const result = countDiffLines(str, str)
    expect(result).toEqual({ added: 0, removed: 0 })
  })

  test("handles single line changes", () => {
    expect(countDiffLines("old", "new")).toEqual({ added: 1, removed: 1 })
  })
})

describe("getEditUnifiedDiff", () => {
  test("generates diff from valid input with oldString/newString", () => {
    const input = {
      path: "/foo/bar.ts",
      oldString: "const x = 1",
      newString: "const x = 2",
    }
    const result = getEditUnifiedDiff(input)

    expect(result).not.toBeNull()
    expect(result!.filetype).toBe("typescript")
    expect(result!.diff).toContain("---")
    expect(result!.diff).toContain("+++")
    expect(result!.added).toBe(1)
    expect(result!.removed).toBe(1)
  })

  test("supports old_string/new_string snake_case", () => {
    const input = {
      path: "/foo/bar.py",
      old_string: "x = 1",
      new_string: "x = 2",
    }
    const result = getEditUnifiedDiff(input)

    expect(result).not.toBeNull()
    expect(result!.filetype).toBe("python")
  })

  test("returns null for null input", () => {
    expect(getEditUnifiedDiff(null)).toBeNull()
  })

  test("returns null for non-object input", () => {
    expect(getEditUnifiedDiff("string")).toBeNull()
    expect(getEditUnifiedDiff(123)).toBeNull()
  })

  test("returns null when path missing", () => {
    const input = { oldString: "a", newString: "b" }
    expect(getEditUnifiedDiff(input)).toBeNull()
  })

  test("returns null when oldString missing", () => {
    const input = { path: "/foo.ts", newString: "b" }
    expect(getEditUnifiedDiff(input)).toBeNull()
  })

  test("returns null when newString missing", () => {
    const input = { path: "/foo.ts", oldString: "a" }
    expect(getEditUnifiedDiff(input)).toBeNull()
  })

  test("returns null when values are wrong type", () => {
    expect(getEditUnifiedDiff({ path: 123, oldString: "a", newString: "b" })).toBeNull()
    expect(getEditUnifiedDiff({ path: "/foo", oldString: 123, newString: "b" })).toBeNull()
    expect(getEditUnifiedDiff({ path: "/foo", oldString: "a", newString: 123 })).toBeNull()
  })

  test("counts multi-line additions correctly", () => {
    const input = {
      path: "/foo.ts",
      oldString: "line1",
      newString: "line1\nline2\nline3",
    }
    const result = getEditUnifiedDiff(input)

    expect(result!.added).toBe(2)
    expect(result!.removed).toBe(0)
  })

  test("counts multi-line removals correctly", () => {
    const input = {
      path: "/foo.ts",
      oldString: "line1\nline2\nline3",
      newString: "line1",
    }
    const result = getEditUnifiedDiff(input)

    expect(result!.added).toBe(0)
    expect(result!.removed).toBe(2)
  })

  test("generates valid unified diff format", () => {
    const input = {
      path: "/foo/bar.ts",
      oldString: "const x = 1\n",
      newString: "const x = 2\n",
    }
    const result = getEditUnifiedDiff(input)

    // Verify unified diff structure
    expect(result!.diff).toContain("--- /foo/bar.ts")
    expect(result!.diff).toContain("+++ /foo/bar.ts")
    expect(result!.diff).toContain("-const x = 1")
    expect(result!.diff).toContain("+const x = 2")
  })
})
