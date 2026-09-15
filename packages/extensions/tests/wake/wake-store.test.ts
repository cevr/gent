/**
 * Alarms live in one file per branch so a restart loses none: the tool writes
 * the file, firing removes the entry, and the next turn re-arms what is left.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Layer, Ref, Schema } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { runToolWithCtx } from "@gent/core-internal/test-utils"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { makeTempDirectoryScoped, waitFor } from "@gent/core-internal/test-utils/fixtures"
import {
  ExtensionContext,
  type ExtensionContextService,
} from "@gent/core-internal/domain/extension-services"
import {
  rearmPendingAlarms,
  WakeAlarms,
  WakeAlarmsLive,
  WakeEntry,
  WakeTool,
} from "../../src/wake/index.js"

const branchId = BranchId.make("wake-branch")
const encodeAlarms = Schema.encodeSync(Schema.fromJsonString(Schema.Array(WakeEntry)))

const contextWith = (home: string, queued: Ref.Ref<ReadonlyArray<string>>) =>
  testToolContext({
    sessionId: SessionId.make("wake-session"),
    branchId,
    toolCallId: ToolCallId.make("tc-wake"),
    home,
    Session: {
      ...testToolContext().Session,
      queueFollowUp: ({ content }) => Ref.update(queued, (all) => [...all, content]),
    },
    State: { changed: () => Effect.void },
  })

const readFile = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(`${home}/.gent/wakes/${branchId}.json`)
  }).pipe(Effect.provide(BunFileSystem.layer))

describe("wake store", () => {
  it.scopedLive("an alarm is written to the branch file and removed once it fires", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-store-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const ctx = contextWith(home, queued)
      const handle = yield* runToolWithCtx(
        WakeTool,
        { afterSeconds: 0.2, note: "check the deploy" },
        ctx,
      )
      const stored = yield* readFile(home)
      expect(stored).toContain(handle.wakeId)
      expect(stored).toContain("check the deploy")
      yield* waitFor(Ref.get(queued), (all) => all.length === 1, 3_000, "the alarm fired")
      yield* waitFor(readFile(home), (text) => text === "[]", 3_000, "the file emptied")
    }).pipe(
      // The timer lives in the resource scope; that scope must outlive the tool call.
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunFileSystem.layer)),
      Effect.timeout("8 seconds"),
    ),
  )

  it.scopedLive("a stored past-due alarm fires on re-arm; a ticking one is not doubled", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-rearm-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const ctx: ExtensionContextService = contextWith(home, queued)
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
      yield* fs.writeFileString(
        `${home}/.gent/wakes/${branchId}.json`,
        encodeAlarms([
          { _tag: "alarm", wakeId: "past", dueAt: 1_000, note: "CI should be done" },
          { _tag: "alarm", wakeId: "later", dueAt: 4_000_000_000_000, note: "tomorrow" },
        ]),
      )
      const armed = yield* rearmPendingAlarms().pipe(Effect.provideService(ExtensionContext, ctx))
      expect(armed).toBe(2)
      yield* waitFor(Ref.get(queued), (all) => all.length === 1, 3_000, "the past-due alarm fired")
      expect((yield* Ref.get(queued))[0]).toContain("CI should be done")
      yield* waitFor(readFile(home), (text) => !text.includes("past"), 3_000, "past removed")
      expect(yield* readFile(home)).toContain("later")
      const again = yield* rearmPendingAlarms().pipe(Effect.provideService(ExtensionContext, ctx))
      expect(again).toBe(0)
      const alarms = yield* WakeAlarms
      expect(yield* alarms.pending).toEqual(["later"])
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunFileSystem.layer)),
      Effect.timeout("8 seconds"),
    ),
  )
})
