/** Money is integer cents. Never floats. */
export type Cents = number & { readonly __brand: "Cents" }

export const cents = (value: number): Cents => {
  if (!Number.isInteger(value)) throw new Error(`cents must be an integer, got ${value}`)
  return value as Cents
}

/** Parse "12.34", "-0.5", "1,234.00" into cents. */
export const parseAmount = (text: string): Cents => {
  const cleaned = text.replace(/,/g, "").trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error(`invalid amount: ${text}`)
  const negative = cleaned.startsWith("-")
  const [whole = "0", frac = ""] = cleaned.replace("-", "").split(".")
  // BUG: a one-digit fraction ("0.5") is treated as 5 cents instead of 50.
  const value = Number(whole) * 100 + Number(frac || "0")
  return cents(negative ? -value : value)
}

export const formatAmount = (value: Cents): string => {
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(value)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, "0")
  return `${sign}${whole.toLocaleString("en-US")}.${frac}`
}

export const sum = (values: Iterable<Cents>): Cents => {
  let total = 0
  for (const v of values) total += v
  return cents(total)
}
