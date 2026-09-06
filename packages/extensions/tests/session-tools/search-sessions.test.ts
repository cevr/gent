import { describe, test, expect } from "bun:test"
import { Option } from "effect"
import { parseRelativeDate } from "../../src/session-tools/search-sessions.js"

const NOW_MS = 1_700_000_000_000

describe("parseRelativeDate", () => {
  test('"7d" → ~7 days ago', () => {
    const result = parseRelativeDate("7d", NOW_MS)
    expect(Option.isSome(result)).toBe(true)
    if (Option.isNone(result)) return
    const expected = NOW_MS - 7 * 86400000
    expect(Math.abs(result.value - expected)).toBeLessThan(1000)
  })

  test('"2w" → ~14 days ago', () => {
    const result = parseRelativeDate("2w", NOW_MS)
    expect(Option.isSome(result)).toBe(true)
    if (Option.isNone(result)) return
    const expected = NOW_MS - 14 * 86400000
    expect(Math.abs(result.value - expected)).toBeLessThan(1000)
  })

  test('"1m" → ~30 days ago', () => {
    const result = parseRelativeDate("1m", NOW_MS)
    expect(Option.isSome(result)).toBe(true)
    if (Option.isNone(result)) return
    const expected = NOW_MS - 30 * 86400000
    expect(Math.abs(result.value - expected)).toBeLessThan(1000)
  })

  test('ISO date "2024-01-15" → correct timestamp', () => {
    const result = parseRelativeDate("2024-01-15", NOW_MS)
    expect(result).toEqual(Option.some(Date.parse("2024-01-15")))
  })

  test('"foo" → no date', () => {
    expect(Option.isNone(parseRelativeDate("foo", NOW_MS))).toBe(true)
  })

  test('"0d" → ~now', () => {
    const result = parseRelativeDate("0d", NOW_MS)
    expect(Option.isSome(result)).toBe(true)
    if (Option.isNone(result)) return
    expect(Math.abs(result.value - NOW_MS)).toBeLessThan(1000)
  })
})
