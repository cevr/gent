import { cents, formatAmount, sum, type Cents } from "../domain/money"
import type { Transaction } from "../domain/transaction"

export interface MonthlyReport {
  readonly month: string
  readonly income: Cents
  readonly spend: Cents
  readonly net: Cents
  readonly byCategory: ReadonlyArray<{ readonly category: string; readonly total: Cents }>
}

/** "YYYY-MM" for a transaction date. Dates are plain calendar dates; no timezone math. */
export const monthOf = (date: string): string => {
  const [year, month] = date.split("-")
  // BUG: the month loses its leading zero, so "2026-03-01" reports as "2026-3".
  return `${year}-${Number(month)}`
}

export const monthlyReport = (month: string, items: ReadonlyArray<Transaction>): MonthlyReport => {
  const inMonth = items.filter((t) => monthOf(t.date) === month)
  const income = sum(inMonth.filter((t) => t.amount > 0).map((t) => t.amount))
  const spend = sum(inMonth.filter((t) => t.amount < 0).map((t) => t.amount))
  const totals = new Map<string, number>()
  for (const t of inMonth) {
    if (t.amount >= 0) continue
    const key = t.category ?? "uncategorized"
    totals.set(key, (totals.get(key) ?? 0) + t.amount)
  }
  const byCategory = [...totals.entries()]
    .map(([category, total]) => ({ category, total: cents(total) }))
    .sort((a, b) => a.total - b.total)
  return { month, income, spend, net: cents(income + spend), byCategory }
}

export const renderReport = (report: MonthlyReport): string => {
  const lines = [
    `Report for ${report.month}`,
    `  income  ${formatAmount(report.income)}`,
    `  spend   ${formatAmount(report.spend)}`,
    `  net     ${formatAmount(report.net)}`,
    ``,
    `By category:`,
    ...report.byCategory.map((c) => `  ${c.category.padEnd(16)} ${formatAmount(c.total)}`),
  ]
  return lines.join("\n")
}
