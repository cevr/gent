/**
 * The one column-budget truncation.
 *
 * Every caller budgets terminal columns. A name whose `.length` fits the
 * budget can still be wider than it: CJK glyphs take two columns and an emoji
 * is one grapheme of several code units. The old code-unit slice let those
 * rows overflow; the receipt for that is the `.length` line in each test.
 */
import { describe, expect, test } from "bun:test"
import { truncate, truncateStart } from "../src/utils"

describe("truncate", () => {
  test("a CJK name whose length fits but whose width does not is cut to the column budget", () => {
    const name = "漢字漢字漢字"
    expect(name.length).toBeLessThanOrEqual(8)
    expect(Bun.stringWidth(name)).toBeGreaterThan(8)
    const result = truncate(name, 8)
    expect(result).toBe("漢字漢…")
    expect(Bun.stringWidth(result)).toBeLessThanOrEqual(8)
  })

  test("an emoji name is cut on a grapheme boundary and never splits a glyph", () => {
    const name = "👩‍💻".repeat(4)
    expect(Bun.stringWidth(name)).toBe(8)
    const result = truncate(name, 5)
    expect(result).toBe("👩‍💻👩‍💻…")
    expect(Bun.stringWidth(result)).toBe(5)
  })

  test("text that fits comes back unchanged, on one line", () => {
    expect(truncate("short", 10)).toBe("short")
    expect(truncate("two\nlines\there", 20)).toBe("two lines here")
  })

  test("a zero budget yields nothing and an ascii overflow ends in one ellipsis glyph", () => {
    expect(truncate("anything", 0)).toBe("")
    expect(truncate("abcdefghij", 6)).toBe("abcde…")
    expect(truncate("abcdefghij", 6)).not.toContain("...")
  })
})

describe("truncateStart", () => {
  test("keeps the tail of a query within the budget", () => {
    expect(truncateStart("abcdefghij", 4)).toBe("ghij")
    expect(truncateStart("漢字漢字", 3)).toBe("字")
    expect(truncateStart("fits", 10)).toBe("fits")
  })
})
