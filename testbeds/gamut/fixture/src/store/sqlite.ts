import { Database } from "bun:sqlite"
import { cents, type Cents } from "../domain/money"
import type { Transaction } from "../domain/transaction"

export class LedgerStore {
  private readonly db: Database

  constructor(path = ":memory:") {
    this.db = new Database(path)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        merchant TEXT NOT NULL,
        memo TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL,
        category TEXT
      )
    `)
    this.db.run(`CREATE INDEX IF NOT EXISTS transactions_date ON transactions(date)`)
  }

  /** Insert or ignore. Returns the number of new rows. */
  upsertMany(items: ReadonlyArray<Transaction>): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO transactions (id, date, merchant, memo, amount, category)
       VALUES ($id, $date, $merchant, $memo, $amount, $category)`,
    )
    let inserted = 0
    const run = this.db.transaction((rows: ReadonlyArray<Transaction>) => {
      for (const tx of rows) {
        const result = stmt.run({
          $id: tx.id,
          $date: tx.date,
          $merchant: tx.merchant,
          $memo: tx.memo,
          $amount: tx.amount,
          $category: tx.category,
        })
        inserted += result.changes
      }
    })
    run(items)
    return inserted
  }

  setCategory(id: string, category: string | null): void {
    this.db.run(`UPDATE transactions SET category = ? WHERE id = ?`, [category, id])
  }

  list(range?: { readonly from: string; readonly to: string }): ReadonlyArray<Transaction> {
    const rows = range
      ? this.db
          .query(`SELECT * FROM transactions WHERE date >= ? AND date <= ? ORDER BY date, id`)
          .all(range.from, range.to)
      : this.db.query(`SELECT * FROM transactions ORDER BY date, id`).all()
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      date: String(r.date),
      merchant: String(r.merchant),
      memo: String(r.memo),
      amount: cents(Number(r.amount)) as Cents,
      category: r.category === null ? null : String(r.category),
    }))
  }

  uncategorized(): ReadonlyArray<Transaction> {
    return this.list().filter((t) => t.category === null)
  }

  close(): void {
    this.db.close()
  }
}
