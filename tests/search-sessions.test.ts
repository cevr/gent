import { describe, test, expect } from "bun:test"
import { parseRelativeDate } from "@gent/tools"

describe("parseRelativeDate", () => {
  test('"7d" → ~7 days ago', () => {
    const result = parseRelativeDate("7d")
    expect(result).toBeDefined()
    const expected = Date.now() - 7 * 86400000
    expect(Math.abs(result! - expected)).toBeLessThan(1000)
  })

  test('"2w" → ~14 days ago', () => {
    const result = parseRelativeDate("2w")
    expect(result).toBeDefined()
    const expected = Date.now() - 14 * 86400000
    expect(Math.abs(result! - expected)).toBeLessThan(1000)
  })

  test('"1m" → ~30 days ago', () => {
    const result = parseRelativeDate("1m")
    expect(result).toBeDefined()
    const expected = Date.now() - 30 * 86400000
    expect(Math.abs(result! - expected)).toBeLessThan(1000)
  })

  test('ISO date "2024-01-15" → correct timestamp', () => {
    const result = parseRelativeDate("2024-01-15")
    expect(result).toBe(Date.parse("2024-01-15"))
  })

  test('"foo" → undefined', () => {
    expect(parseRelativeDate("foo")).toBeUndefined()
  })

  test('"0d" → ~now', () => {
    const result = parseRelativeDate("0d")
    expect(result).toBeDefined()
    expect(Math.abs(result! - Date.now())).toBeLessThan(1000)
  })
})
