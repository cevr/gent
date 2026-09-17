import { parseCsv, rowsToRecords } from "./import/csv"
import { parseAmount } from "./domain/money"
import { transactionId, validateTransaction, type Transaction } from "./domain/transaction"
import { categorize, DEFAULT_RULES } from "./rules/categorize"
import { LedgerStore } from "./store/sqlite"
import { monthlyReport, renderReport } from "./report/monthly"

const DB = process.env.LEDGER_DB ?? "ledger.db"

const usage = `ledgerline <command>
  import <file.csv>     import transactions (idempotent)
  categorize            apply rules to uncategorized transactions
  report <YYYY-MM>      print the monthly report
  list [from to]        list transactions`

export const importCsv = (store: LedgerStore, text: string): { imported: number; rejected: string[] } => {
  const records = rowsToRecords(parseCsv(text))
  const rejected: string[] = []
  const items: Transaction[] = []
  for (const r of records) {
    try {
      const amount = parseAmount(r.amount)
      const tx: Transaction = {
        id: transactionId(r.date, r.merchant, amount, r.memo),
        date: r.date,
        merchant: r.merchant,
        memo: r.memo,
        amount,
        category: null,
      }
      const problems = validateTransaction(tx)
      if (problems.length > 0) rejected.push(`${r.date} ${r.merchant}: ${problems.join("; ")}`)
      else items.push(tx)
    } catch (error) {
      rejected.push(`${r.date} ${r.merchant}: ${String(error)}`)
    }
  }
  return { imported: store.upsertMany(items), rejected }
}

export const applyRules = (store: LedgerStore): number => {
  let changed = 0
  for (const tx of store.uncategorized()) {
    const category = categorize(tx, DEFAULT_RULES)
    if (category !== null) {
      store.setCategory(tx.id, category)
      changed += 1
    }
  }
  return changed
}

const main = async (argv: ReadonlyArray<string>) => {
  const [command, ...args] = argv
  const store = new LedgerStore(DB)
  try {
    switch (command) {
      case "import": {
        const file = args[0]
        if (!file) throw new Error("import needs a file")
        const result = importCsv(store, await Bun.file(file).text())
        console.log(`imported ${result.imported}, rejected ${result.rejected.length}`)
        for (const r of result.rejected) console.log(`  ! ${r}`)
        return
      }
      case "categorize":
        console.log(`categorized ${applyRules(store)}`)
        return
      case "report": {
        const month = args[0]
        if (!month) throw new Error("report needs YYYY-MM")
        console.log(renderReport(monthlyReport(month, store.list())))
        return
      }
      case "list": {
        const [from, to] = args
        const items = from && to ? store.list({ from, to }) : store.list()
        for (const t of items) console.log(`${t.date}  ${t.merchant.padEnd(24)} ${t.amount}  ${t.category ?? "-"}`)
        return
      }
      default:
        console.log(usage)
    }
  } finally {
    store.close()
  }
}

if (import.meta.main) await main(process.argv.slice(2))
