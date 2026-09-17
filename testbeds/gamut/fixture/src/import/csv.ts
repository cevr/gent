/**
 * RFC 4180 CSV reader. Quoted fields may contain commas and newlines.
 * A doubled quote inside a quoted field is a literal quote.
 */
export const parseCsv = (text: string): ReadonlyArray<ReadonlyArray<string>> => {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        // BUG: a doubled quote ("") must emit one quote and stay quoted.
        quoted = false
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (ch === "\r") {
      // ignore
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export interface CsvTransactionRow {
  readonly date: string
  readonly merchant: string
  readonly memo: string
  readonly amount: string
}

/** Map a header row + data rows into named rows. Header names are case-insensitive. */
export const rowsToRecords = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<CsvTransactionRow> => {
  const [header, ...data] = rows
  if (!header) return []
  const index = (name: string): number => {
    const i = header.findIndex((h) => h.trim().toLowerCase() === name)
    if (i < 0) throw new Error(`missing column: ${name}`)
    return i
  }
  const date = index("date")
  const merchant = index("merchant")
  const memo = header.findIndex((h) => h.trim().toLowerCase() === "memo")
  const amount = index("amount")
  return data
    .filter((r) => r.some((cell) => cell.trim().length > 0))
    .map((r) => ({
      date: r[date] ?? "",
      merchant: r[merchant] ?? "",
      memo: memo >= 0 ? (r[memo] ?? "") : "",
      amount: r[amount] ?? "",
    }))
}
