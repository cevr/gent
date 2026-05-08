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
import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { AutoJournal } from "../../src/auto/journal.js"
const autoJournalLayer = Layer.merge(BunFileSystem.layer, Path.layer)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("AutoJournal row decoding", () => {
  it.scopedLive("skips malformed JSONL lines and returns only well-typed rows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cwd = yield* fs.makeTempDirectoryScoped()
      const journalLayer = AutoJournal.Live({ cwd })
      const live = journalLayer.pipe(Layer.provide(autoJournalLayer))
      const autoDir = path.join(cwd, ".gent", "auto")
      yield* fs.makeDirectory(autoDir, { recursive: true })
      // Start a journal. Writes a valid ConfigRow + active pointer.
      const journalPath = yield* Effect.gen(function* () {
        const svc = yield* AutoJournal
        return yield* svc.start({ goal: "decode-test", maxIterations: 3 })
      }).pipe(Effect.provide(live))
      // Append a mix of rows: one valid checkpoint, one bogus-JSON line,
      // one JSON-valid-but-wrong-shape line, one valid review.
      yield* fs.writeFileString(
        journalPath,
        [
          encodeJson({
            type: "checkpoint",
            iteration: 1,
            status: "continue",
            summary: "step 1",
          }),
          "not-json-at-all",
          encodeJson({ type: "checkpoint", iteration: 2, status: "bogus-status-enum" }),
          encodeJson({ type: "review", iteration: 2 }),
          "",
        ].join("\n") + "\n",
        { flag: "a" },
      )
      const result = yield* Effect.gen(function* () {
        const svc = yield* AutoJournal
        return yield* svc.readActive()
      }).pipe(Effect.provide(live))
      expect(result).toBeDefined()
      if (result === undefined) return
      // Good rows: ConfigRow (start) + checkpoint iter 1 + review iter 2 = 3.
      // Bad rows (unparseable JSON, wrong status enum) must be dropped.
      expect(result.rows.length).toBe(3)
      expect(result.rows[0]?.type).toBe("config")
      expect(result.rows[1]?.type).toBe("checkpoint")
      expect(result.rows[2]?.type).toBe("review")
    }).pipe(Effect.provide(autoJournalLayer)),
  )
})
