import { describe, test, expect } from "bun:test"
import { windowItems, headTailExcerpts } from "@gent/core"

type TestItem = { _tag: "item"; value: string } | { _tag: "elision"; count: number }

const makeElision = (count: number): TestItem => ({ _tag: "elision", count })
const item = (v: string): TestItem => ({ _tag: "item", value: v })

describe("windowItems with headTailExcerpts(3, 3)", () => {
  const excerpts = headTailExcerpts(3, 3)

  test("empty input returns empty", () => {
    const result = windowItems<TestItem>([], excerpts, makeElision)
    expect(result.items).toEqual([])
    expect(result.skippedRanges).toEqual([])
  })

  test("< 6 items — no elision", () => {
    const items = [item("a"), item("b"), item("c"), item("d"), item("e")]
    const result = windowItems(items, excerpts, makeElision)
    expect(result.items.length).toBe(5)
    expect(result.items.every((i) => i._tag === "item")).toBe(true)
  })

  test("exactly 6 items — no elision (head 3 + tail 3 merge)", () => {
    const items = Array.from({ length: 6 }, (_, i) => item(`line-${i}`))
    const result = windowItems(items, excerpts, makeElision)
    expect(result.items.length).toBe(6)
    expect(result.items.every((i) => i._tag === "item")).toBe(true)
  })

  test("10 items — head 3 + elision + tail 3", () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`line-${i}`))
    const result = windowItems(items, excerpts, makeElision)
    // head 3, elision(4), tail 3 = 7 entries
    expect(result.items.length).toBe(7)
    expect(result.items[0]).toEqual(item("line-0"))
    expect(result.items[1]).toEqual(item("line-1"))
    expect(result.items[2]).toEqual(item("line-2"))
    expect(result.items[3]).toEqual({ _tag: "elision", count: 4 })
    expect(result.items[4]).toEqual(item("line-7"))
    expect(result.items[5]).toEqual(item("line-8"))
    expect(result.items[6]).toEqual(item("line-9"))
  })

  test("100 items — head 3 + elision + tail 3", () => {
    const items = Array.from({ length: 100 }, (_, i) => item(`line-${i}`))
    const result = windowItems(items, excerpts, makeElision)
    expect(result.items.length).toBe(7)
    expect(result.items[0]).toEqual(item("line-0"))
    expect(result.items[3]).toEqual({ _tag: "elision", count: 94 })
    expect(result.items[6]).toEqual(item("line-99"))
  })

  test("7 items — head 3 + elision(1) + tail 3", () => {
    const items = Array.from({ length: 7 }, (_, i) => item(`line-${i}`))
    const result = windowItems(items, excerpts, makeElision)
    expect(result.items.length).toBe(7)
    expect(result.items[3]).toEqual({ _tag: "elision", count: 1 })
  })
})

describe("elision marker format", () => {
  test("elision carries the skipped count", () => {
    const items = Array.from({ length: 20 }, (_, i) => `line-${i}`)
    const { items: result } = windowItems(
      items,
      headTailExcerpts(3, 3),
      (count) => `· ··· ${count} more lines`,
    )
    expect(result[3]).toBe("· ··· 14 more lines")
  })
})
