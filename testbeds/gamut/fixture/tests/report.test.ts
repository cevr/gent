import { describe, expect, test } from "bun:test"
import { monthOf, monthlyReport } from "../src/report/monthly"
import { cents } from "../src/domain/money"

describe("monthly report", () => {
  test("monthOf uses the calendar date as written", () => {
    expect(monthOf("2026-03-01")).toBe("2026-03")
    expect(monthOf("2026-12-31")).toBe("2026-12")
  })
  test("splits income and spend and sorts categories by spend", () => {
    const report = monthlyReport("2026-03", [
      { id: "1", date: "2026-03-02", merchant: "Payroll", memo: "", amount: cents(1000), category: "income" },
      { id: "2", date: "2026-03-05", merchant: "Shop", memo: "", amount: cents(-300), category: "groceries" },
      { id: "3", date: "2026-03-06", merchant: "Cab", memo: "", amount: cents(-100), category: "transport" },
      { id: "4", date: "2026-04-06", merchant: "Cab", memo: "", amount: cents(-100), category: "transport" },
    ])
    expect(report.income).toBe(1000)
    expect(report.spend).toBe(-400)
    expect(report.net).toBe(600)
    expect(report.byCategory.map((c) => c.category)).toEqual(["groceries", "transport"])
  })
})
