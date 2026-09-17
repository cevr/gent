import { describe, expect, test } from "bun:test"
import { parseCsv, rowsToRecords } from "../src/import/csv"

describe("csv", () => {
  test("splits plain rows", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]])
  })
  test("keeps commas inside quotes", () => {
    expect(parseCsv('a\n"x, y"\n')).toEqual([["a"], ["x, y"]])
  })
  test("a doubled quote is a literal quote", () => {
    expect(parseCsv('a\n"say ""hi"", ok"\n')).toEqual([["a"], ['say "hi", ok']])
  })
  test("maps header names case-insensitively", () => {
    const records = rowsToRecords(parseCsv("DATE,merchant,Amount\n2026-01-02,Shop,1.00\n"))
    expect(records).toEqual([{ date: "2026-01-02", merchant: "Shop", memo: "", amount: "1.00" }])
  })
})
