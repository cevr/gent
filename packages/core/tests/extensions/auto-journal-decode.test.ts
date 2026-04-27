/**
 * Regression: AutoJournal.readActive must Schema-decode each JSONL row
 * and drop malformed lines with a warning log, rather than forwarding
 * unvalidated `JSON.parse` output through the rest of the auto loop.
 *
 * Prior behavior used `JSON.parse(line) as JournalRow` with a bare
 * try/catch — any object that parsed as JSON would pass, even if its
 * `type` field didn't match one of the three known row shapes. That
 * let corrupt rows (wrong `status` enum, missing required fields)
 * reach `autoProtocol.onInit` replay and crash the extension.
 */
import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { AutoJournal } from "@gent/extensions/auto-journal"

const mkTempCwd = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gent-auto-journal-decode-"))
  return dir
}

describe("AutoJournal row decoding", () => {
  it("skips malformed JSONL lines and returns only well-typed rows", async () => {
    const cwd = await mkTempCwd()
    try {
      const journalLayer = AutoJournal.Live({ cwd })
      const autoDir = path.join(cwd, ".gent", "auto")
      await fs.mkdir(autoDir, { recursive: true })

      // Start a journal. Writes a valid ConfigRow + active pointer.
      const journalPath = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* AutoJournal
          return yield* svc.start({ goal: "decode-test", maxIterations: 3 })
        })
          .pipe(Effect.provide(journalLayer))
          .pipe(Effect.provide(BunFileSystem.layer))
          .pipe(Effect.provide(BunPath.layer)),
      )

      // Append a mix of rows: one valid checkpoint, one bogus-JSON line,
      // one JSON-valid-but-wrong-shape line, one valid review.
      await fs.appendFile(
        journalPath,
        [
          JSON.stringify({
            type: "checkpoint",
            iteration: 1,
            status: "continue",
            summary: "step 1",
          }),
          "not-json-at-all",
          JSON.stringify({ type: "checkpoint", iteration: 2, status: "bogus-status-enum" }),
          JSON.stringify({ type: "review", iteration: 2 }),
          "",
        ].join("\n") + "\n",
      )

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* AutoJournal
          return yield* svc.readActive()
        })
          .pipe(Effect.provide(journalLayer))
          .pipe(Effect.provide(BunFileSystem.layer))
          .pipe(Effect.provide(BunPath.layer)),
      )

      expect(result).toBeDefined()
      if (result === undefined) return
      // Good rows: ConfigRow (start) + checkpoint iter 1 + review iter 2 = 3.
      // Bad rows (unparseable JSON, wrong status enum) must be dropped.
      expect(result.rows.length).toBe(3)
      expect(result.rows[0]?.type).toBe("config")
      expect(result.rows[1]?.type).toBe("checkpoint")
      expect(result.rows[2]?.type).toBe("review")
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
})
