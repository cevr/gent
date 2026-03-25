import { describe, test, expect } from "bun:test"
import { windowItems, headTailExcerpts, type Excerpt } from "@gent/core/domain/windowing"

const elision = (n: number) => `[${n} skipped]`

describe("windowItems", () => {
  test("empty excerpts — returns all items", () => {
    const result = windowItems([1, 2, 3, 4, 5], [], elision)
    expect(result.items).toEqual([1, 2, 3, 4, 5])
    expect(result.skippedRanges).toEqual([])
  })

  test("empty items — returns empty", () => {
    const result = windowItems([], [{ focus: "head", context: 3 }], elision)
    expect(result.items).toEqual([])
  })

  test("head excerpt", () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const result = windowItems(items, [{ focus: "head", context: 3 }], elision)
    expect(result.items).toEqual([0, 1, 2, "[7 skipped]"])
    expect(result.skippedRanges).toEqual([[3, 10]])
  })

  test("tail excerpt", () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const result = windowItems(items, [{ focus: "tail", context: 3 }], elision)
    expect(result.items).toEqual(["[7 skipped]", 7, 8, 9])
    expect(result.skippedRanges).toEqual([[0, 7]])
  })

  test("head + tail excerpts", () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const excerpts: Excerpt[] = [
      { focus: "head", context: 2 },
      { focus: "tail", context: 2 },
    ]
    const result = windowItems(items, excerpts, elision)
    expect(result.items).toEqual([0, 1, "[6 skipped]", 8, 9])
  })

  test("index-based excerpt", () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    // focus=5, context=1 → range [4,6]
    const result = windowItems(items, [{ focus: 5, context: 1 }], elision)
    expect(result.items).toEqual(["[4 skipped]", 4, 5, 6, "[3 skipped]"])
  })

  test("overlapping excerpts merged", () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const excerpts: Excerpt[] = [
      { focus: 2, context: 2 }, // [0, 4]
      { focus: 4, context: 2 }, // [2, 6]
    ]
    const result = windowItems(items, excerpts, elision)
    // merged: [0, 6]
    expect(result.items).toEqual([0, 1, 2, 3, 4, 5, 6, "[3 skipped]"])
  })

  test("adjacent excerpts merged", () => {
    const items = [0, 1, 2, 3, 4, 5]
    const excerpts: Excerpt[] = [
      { focus: "head", context: 3 }, // [0, 2]
      { focus: "tail", context: 3 }, // [3, 5]
    ]
    const result = windowItems(items, excerpts, elision)
    // adjacent: merged to [0, 5] — all items shown
    expect(result.items).toEqual([0, 1, 2, 3, 4, 5])
    expect(result.skippedRanges).toEqual([])
  })

  test("excerpt beyond bounds clamped", () => {
    const items = [0, 1, 2]
    const result = windowItems(items, [{ focus: "head", context: 100 }], elision)
    expect(result.items).toEqual([0, 1, 2])
  })
})

describe("headTailExcerpts", () => {
  test("produces head + tail excerpts", () => {
    const excerpts = headTailExcerpts(3, 3)
    expect(excerpts).toEqual([
      { focus: "head", context: 3 },
      { focus: "tail", context: 3 },
    ])
  })
})
