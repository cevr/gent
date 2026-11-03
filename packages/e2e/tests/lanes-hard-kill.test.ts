/**
 * Account lanes across a hard kill. A real host process (`src/lane-host.ts`)
 * runs a turn on the `anthropic` sign-in `work` over a SQLite file and gent's
 * data dir; the test ends it with SIGKILL, so no finalizer and no ledger
 * write runs, then starts a second host over the same files. The load is
 * what each host's `accounts.lanes` reads.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Clock, Effect, FileSystem, Ref, Schema } from "effect"
import { makeTempDirectoryScoped, waitFor } from "@gent/core/test-utils"
import { hardKill, hostPrinted, spawnTestHost } from "../src/server-process-fixture"

const spawnHost = (dir: string, label: string, env: Readonly<Record<string, string>>) =>
  spawnTestHost({
    script: "src/lane-host.ts",
    prefix: "LH",
    dir,
    label,
    env: { LH_DIR: dir, ...env },
  })

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

/**
 * A ledger that read the week of `work` once, so each host lists the
 * provider from its first read: a reading that never moves carries no
 * capacity, and every lane counts.
 */
const seedLedger = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const now = yield* Clock.currentTimeMillis
    yield* fs.writeFileString(
      `${dir}/credential-usage.json`,
      encodeJson({
        buckets: [],
        readings: [
          {
            provider: "anthropic",
            slot: "work",
            window: "7d",
            utilization: 0.1,
            resetAt: now + 20 * 3_600_000,
            readAt: now,
            rejected: false,
          },
        ],
      }),
    )
  })

describe("account lanes across a hard kill", () => {
  it.live(
    "a turn cut by SIGKILL holds no lane in the next server until it runs again, and counts while it runs",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectoryScoped("gent-lane-kill-")
        const fs = yield* FileSystem.FileSystem
        yield* seedLedger(dir)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* spawnHost(dir, "first", { LH_START: "1" })
            yield* hostPrinted(first, "sent", 20_000)
            yield* hostPrinted(first, "load 1", 10_000)
            expect(yield* Ref.get(first.events)).toEqual(["ready", "load 0", "sent", "load 1"])
            yield* hardKill(first.proc)
          }),
        )
        const second = yield* spawnHost(dir, "second", {})
        yield* hostPrinted(second, "ready", 20_000)
        // Right after the restart: the dead server's lane is gone, and the
        // cut turn waits for its session to open.
        yield* hostPrinted(second, "load 0", 10_000)
        yield* fs.writeFileString(`${dir}/open`, "")
        yield* hostPrinted(second, "opened", 10_000)
        // The cut turn runs again and counts on the lane while it runs.
        yield* hostPrinted(second, "load 1", 10_000)
        yield* fs.writeFileString(`${dir}/go`, "")
        yield* waitFor(
          Ref.get(second.events),
          (seen) => seen.at(-1) === "load 0",
          10_000,
          "the lane freed as the turn ended",
        )
        expect(yield* Ref.get(second.events)).toEqual([
          "ready",
          "load 0",
          "opened",
          "load 1",
          "load 0",
        ])
      }).pipe(Effect.scoped, Effect.timeout("55 seconds"), Effect.provide(BunServices.layer)),
    60_000,
  )
})
