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

/** The name `classifyLogFile` reads, from a full path. */
const basename = (path: Option.Option<string>): string =>
  Option.getOrElse(
    Option.map(path, (value) =>
      Option.getOrElse(Option.fromUndefinedOr(value.split("/").at(-1)), () => value),
    ),
    () => "",
  )

/**
 * `inspectLogs` reads the one shared log directory a live gent also writes to,
 * and orders by mtime. Fixtures are written in order so each is newer than the
 * last, and removed again on the way out; assertions compare only files this
 * test created, never "newest in the directory".
 */
const writeLog = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = `${LOG_DIR}/${name}`
    yield* fs.writeFileString(path, "{}\n")
    return path
  })

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

      // Written oldest first; the last write of each kind is the newest.
      const older = yield* writeLog("00000001-20260915120000-server.log")
      const client = yield* writeLog("00000002-20260915140000-client.log")
      const newer = yield* writeLog("00000003-20260915130000-server.log")
      // Newest file of all, and not a log: the classifier must refuse it.
      const ignored = yield* writeLog("00000004-notes.txt")
      const written = [older, client, newer, ignored]

      const logs = yield* inspectLogs.pipe(
        Effect.ensuring(
          Effect.forEach(written, (path) => fs.remove(path).pipe(Effect.ignore), {
            discard: true,
          }),
        ),
      )

      expect(logs.dir).toBe(LOG_DIR)
      // A name neither side claims never wins, however new it is.
      expect(logs.latestServer).not.toBe(ignored)
      expect(logs.latestClient).not.toBe(ignored)
      // Among this test's own server logs the later write wins.
      expect(logs.latestServer).not.toBe(older)
      expect(
        Option.contains(
          classifyLogFile(basename(Option.fromUndefinedOr(logs.latestServer))),
          "server",
        ),
      ).toBe(true)
      expect(
        Option.contains(
          classifyLogFile(basename(Option.fromUndefinedOr(logs.latestClient))),
          "client",
        ),
      ).toBe(true)
      // The client fixture is the only client log this test wrote.
      expect([client, logs.latestClient]).toContain(client)
    }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunServices.layer)),
  )
})
