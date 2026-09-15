/**
 * The doctor's log section.
 *
 * The SDK owns the log directory and the file-naming rule, so `inspectLogs`
 * only reads what it is told: the newest file each side wrote, and nothing for
 * a name neither side claims.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Option } from "effect"
import { classifyLogFile, LOG_DIR } from "@gent/sdk"
import { inspectLogs } from "../src/ops/local-health"

/**
 * `inspectLogs` reads the one shared log directory a live gent also writes to.
 * Fixtures are dated well ahead of now so they outrank anything a concurrent
 * process drops in mid-run, and are removed again on the way out.
 */
const writeLog = (name: string, mtime: Date) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = `${LOG_DIR}/${name}`
    yield* fs.writeFileString(path, "{}\n")
    yield* fs.utimes(path, mtime, mtime)
    return path
  })

const ahead = (minutes: number): Date => new Date(Date.now() + minutes * 60_000)

describe("log file classification", () => {
  it.live("names each side by its suffix and claims nothing else", () =>
    Effect.sync(() => {
      expect(classifyLogFile("abc12345-20260915120000-server.log")).toEqual(Option.some("server"))
      expect(classifyLogFile("abc12345-20260915120000-client.log")).toEqual(Option.some("client"))
      expect(classifyLogFile("notes.txt")).toEqual(Option.none())
      expect(classifyLogFile("server.log")).toEqual(Option.none())
    }),
  )
})

describe("inspect logs", () => {
  it.live("reports the newest file each side wrote and ignores unrelated names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(LOG_DIR, { recursive: true }).pipe(Effect.ignore)

      const older = yield* writeLog("00000001-20260915120000-server.log", ahead(10))
      const newer = yield* writeLog("00000002-20260915130000-server.log", ahead(30))
      const client = yield* writeLog("00000003-20260915140000-client.log", ahead(20))
      // Newest of all, and not a log: the classifier must refuse it.
      const ignored = yield* writeLog("00000004-notes.txt", ahead(60))
      const written = [older, newer, client, ignored]

      const logs = yield* inspectLogs.pipe(
        Effect.ensuring(
          Effect.forEach(written, (path) => fs.remove(path).pipe(Effect.ignore), {
            discard: true,
          }),
        ),
      )

      expect(logs.dir).toBe(LOG_DIR)
      expect(logs.latestServer).toBe(newer)
      expect(logs.latestClient).toBe(client)
      expect(logs.latestServer).not.toBe(older)
      expect(logs.latestServer).not.toBe(ignored)
      expect(logs.latestClient).not.toBe(ignored)
    }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunServices.layer)),
  )
})
