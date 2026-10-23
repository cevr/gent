import { describe, expect, test } from "bun:test"
import { formatAmount, parseAmount, sum, cents } from "../src/domain/money"

describe("money", () => {
  test("parses whole and two-decimal amounts", () => {
    expect(parseAmount("12.34")).toBe(cents(1234))
    expect(parseAmount("-1,234.00")).toBe(cents(-123400))
    expect(parseAmount("7")).toBe(cents(700))
  })
  test("parses one-decimal amounts as tenths", () => {
    expect(parseAmount("0.5")).toBe(cents(50))
    expect(parseAmount("-2.5")).toBe(cents(-250))
  })
  test("formats with grouping and sign", () => {
    expect(formatAmount(cents(-123456))).toBe("-1,234.56")
    expect(formatAmount(cents(5))).toBe("0.05")
  })
  test("sums cents", () => {
    expect(sum([cents(1), cents(2), cents(-3)])).toBe(cents(0))
  })
})
