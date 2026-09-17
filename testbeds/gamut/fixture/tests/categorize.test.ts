import { describe, expect, test } from "bun:test"
import { categorize, DEFAULT_RULES } from "../src/rules/categorize"
import { cents } from "../src/domain/money"

const tx = (merchant: string, memo = "") => ({
  id: "x", date: "2026-03-01", merchant, memo, amount: cents(-100), category: null,
})

describe("categorize", () => {
  test("substring rules are case-insensitive", () => {
    expect(categorize(tx("WHOLE FOODS #123"), DEFAULT_RULES)).toBe("groceries")
  })
  test("regex rules match word boundaries", () => {
    expect(categorize(tx("Uber Trip"), DEFAULT_RULES)).toBe("transport")
    expect(categorize(tx("Tuberville Books"), DEFAULT_RULES)).toBeNull()
  })
  test("higher priority wins", () => {
    expect(categorize(tx("Uber to Cafe Roma"), DEFAULT_RULES)).toBe("transport")
  })
})
