import type { Transaction } from "../domain/transaction"

export interface Rule {
  readonly category: string
  /** Case-insensitive substring or /regex/ against merchant + memo. */
  readonly match: string
  /** Higher wins when several rules match. Ties keep the first declared rule. */
  readonly priority: number
}

const compile = (rule: Rule): ((haystack: string) => boolean) => {
  const m = rule.match
  if (m.startsWith("/") && m.lastIndexOf("/") > 0) {
    const end = m.lastIndexOf("/")
    const re = new RegExp(m.slice(1, end), m.slice(end + 1) + "i")
    return (h) => re.test(h)
  }
  const needle = m.toLowerCase()
  return (h) => h.toLowerCase().includes(needle)
}

export const categorize = (tx: Transaction, rules: ReadonlyArray<Rule>): string | null => {
  const haystack = `${tx.merchant} ${tx.memo}`
  let best: Rule | null = null
  for (const rule of rules) {
    if (!compile(rule)(haystack)) continue
    if (best === null || rule.priority > best.priority) best = rule
  }
  return best?.category ?? null
}

export const DEFAULT_RULES: ReadonlyArray<Rule> = [
  { category: "groceries", match: "whole foods", priority: 10 },
  { category: "groceries", match: "trader joe", priority: 10 },
  { category: "transport", match: "/\\b(uber|lyft)\\b/", priority: 10 },
  { category: "transport", match: "shell", priority: 5 },
  { category: "dining", match: "/cafe|restaurant|pizza/", priority: 5 },
  { category: "income", match: "payroll", priority: 20 },
  { category: "subscriptions", match: "/netflix|spotify|github/", priority: 10 },
  // TODO: rent and utilities rules; see README "Open tasks".
]
