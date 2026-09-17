import { LedgerStore } from "../store/sqlite"
import { monthlyReport } from "../report/monthly"
import { importCsv, applyRules } from "../cli"

/** Minimal JSON API. No auth; local use only. */
export const makeServer = (store: LedgerStore, port = 8787) =>
  Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/transactions") {
        const from = url.searchParams.get("from")
        const to = url.searchParams.get("to")
        const items = from && to ? store.list({ from, to }) : store.list()
        return Response.json(items)
      }
      if (request.method === "GET" && url.pathname.startsWith("/report/")) {
        const month = url.pathname.slice("/report/".length)
        return Response.json(monthlyReport(month, store.list()))
      }
      if (request.method === "POST" && url.pathname === "/import") {
        const result = importCsv(store, await request.text())
        return Response.json(result)
      }
      if (request.method === "POST" && url.pathname === "/categorize") {
        return Response.json({ changed: applyRules(store) })
      }
      return new Response("not found", { status: 404 })
    },
  })

if (import.meta.main) {
  const server = makeServer(new LedgerStore(process.env.LEDGER_DB ?? "ledger.db"))
  console.log(`ledgerline api on http://localhost:${server.port}`)
}
