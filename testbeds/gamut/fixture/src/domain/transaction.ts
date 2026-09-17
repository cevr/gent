import type { Cents } from "./money"

export interface Transaction {
  readonly id: string
  /** ISO date, YYYY-MM-DD, in the account's local calendar. */
  readonly date: string
  readonly merchant: string
  readonly memo: string
  readonly amount: Cents
  readonly category: string | null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const validateTransaction = (input: Transaction): ReadonlyArray<string> => {
  const problems: string[] = []
  if (input.id.length === 0) problems.push("id is empty")
  if (!ISO_DATE.test(input.date)) problems.push(`date is not YYYY-MM-DD: ${input.date}`)
  if (input.merchant.trim().length === 0) problems.push("merchant is empty")
  if (input.amount === 0) problems.push("amount is zero")
  return problems
}

/** Stable id from the row content so re-imports do not duplicate. */
export const transactionId = (date: string, merchant: string, amount: Cents, memo: string): string => {
  const hasher = new Bun.CryptoHasher("sha1")
  hasher.update(`${date}|${merchant}|${amount}|${memo}`)
  return hasher.digest("hex").slice(0, 16)
}
