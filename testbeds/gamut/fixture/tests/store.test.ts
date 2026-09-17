import { describe, expect, test } from "bun:test"
import { LedgerStore } from "../src/store/sqlite"
import { importCsv, applyRules } from "../src/cli"

const CSV = await Bun.file(new URL("../fixtures/march.csv", import.meta.url)).text()

describe("store", () => {
  test("import is idempotent", () => {
    const store = new LedgerStore()
    const first = importCsv(store, CSV)
    const second = importCsv(store, CSV)
    expect(first.imported).toBe(10)
    expect(first.rejected).toEqual([])
    expect(second.imported).toBe(0)
    store.close()
  })
  test("rules categorize the fixture", () => {
    const store = new LedgerStore()
    importCsv(store, CSV)
    expect(applyRules(store)).toBe(9)
    expect(store.uncategorized().map((t) => t.merchant)).toEqual(["Landlord LLC"])
    store.close()
  })
})
