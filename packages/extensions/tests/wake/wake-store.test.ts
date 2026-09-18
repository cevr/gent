/**
 * Alarms live in one file per branch so a restart loses none: the tool writes
 * the file, firing removes the entry, and the next turn re-arms what is left.
 */
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Exit, FileSystem, Layer, Option, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { BunFileSystem } from "@effect/platform-bun"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { runToolWithCtx, testLeafContext } from "@gent/core-internal/test-utils"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { makeTempDirectoryScoped } from "@gent/core-internal/test-utils/fixtures"
import {
  ExtensionContext,
  type ExtensionContextService,
} from "@gent/core-internal/domain/extension"
import {
  rearmPendingAlarms,
  CancelTool,
  WakeAlarms,
  WakeAlarmsLive,
  WakeEntry,
  WakeTool,
} from "../../src/wake.js"

const branchId = BranchId.make("wake-branch")
const encodeAlarms = Schema.encodeSync(Schema.fromJsonString(Schema.Array(WakeEntry)))

const contextWith = (
  home: string,
  queued: Ref.Ref<ReadonlyArray<string>>,
  fired: Option.Option<Deferred.Deferred<boolean>> = Option.none(),
) =>
  testToolContext({
    sessionId: SessionId.make("wake-session"),
    branchId,
    toolCallId: ToolCallId.make("tc-wake"),
    home,
    Session: {
      ...testToolContext().Session,
      // Recording the line and opening the latch in one step lets a test join the
      // fire instead of polling for it.
      queueFollowUp: ({ content }) =>
        Ref.update(queued, (all) => [...all, content]).pipe(
          Effect.andThen(
            Option.match(fired, {
              onNone: () => Effect.void,
              onSome: (latch) => Deferred.succeed(latch, true),
            }),
          ),
        ),
    },
  })

/**
 * `WakeAlarms.schedule` drops the id from `pending` only after the fired entry's
 * finalizer rewrote the branch file, so an empty `pending` means the fire fully
 * settled. The finalizer does real file I/O, so the wait has to give the fiber
 * turns rather than spin: each turn advances the virtual clock by a millisecond,
 * which both yields and releases anything sleeping. Exhaustion fails loudly; a
 * silent give-up would let a later assertion read a half-finished fire.
 */
const settled = (
  ids: Effect.Effect<ReadonlyArray<string>>,
  wakeId: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 2000; turn += 1) {
      const running = yield* ids
      const done = Option.match(wakeId, {
        onNone: () => running.length === 0,
        onSome: (id) => !running.includes(id),
      })
      if (done) return
      yield* TestClock.adjust("1 milli")
    }
    expect("wake timers still pending").toBe("no wake timer pending")
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
      const fired = yield* Deferred.make<boolean>()
      const ctx = contextWith(home, queued, Option.some(fired))
      const handle = yield* runToolWithCtx(
        WakeTool,
        { afterSeconds: 0.2, note: "check the deploy" },
        ctx,
      )
      const stored = yield* readFile(home)
      expect(stored).toContain(handle.wakeId)
      expect(stored).toContain("check the deploy")
      expect(yield* Ref.get(queued)).toEqual([])
      const alarms = yield* WakeAlarms
      yield* TestClock.adjust("200 millis")
      yield* Deferred.await(fired)
      yield* settled(alarms.pending)
      expect((yield* Ref.get(queued)).length).toBe(1)
      expect(yield* readFile(home)).toBe("[]")
    }).pipe(
      // The timer lives in the resource scope; that scope must outlive the tool call.
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunFileSystem.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )

  it.scopedLive("a stored past-due alarm fires on re-arm; a ticking one is not doubled", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-rearm-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const fired = yield* Deferred.make<boolean>()
      const ctx: ExtensionContextService = testLeafContext(
        contextWith(home, queued, Option.some(fired)),
      )
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
      const alarms = yield* WakeAlarms
      // TestClock starts at epoch 0, so the stored dueAt of 1_000 is one second out.
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(fired)
      yield* settled(alarms.pending, Option.some("past"))
      expect((yield* Ref.get(queued))[0]).toContain("CI should be done")
      expect(yield* readFile(home)).not.toContain("past")
      expect(yield* readFile(home)).toContain("later")
      const again = yield* rearmPendingAlarms().pipe(Effect.provideService(ExtensionContext, ctx))
      expect(again).toBe(0)
      expect(yield* alarms.pending).toEqual(["later"])
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunFileSystem.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )

  it.scopedLive("cancelling stops the timer, empties the file, and nothing fires", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-cancel-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const ctx = contextWith(home, queued)
      const first = yield* runToolWithCtx(WakeTool, { afterSeconds: 0.3, note: "one" }, ctx)
      const second = yield* runToolWithCtx(WakeTool, { afterSeconds: 0.3, note: "two" }, ctx)
      const alarms = yield* WakeAlarms
      expect((yield* alarms.pending).length).toBe(2)
      const one = yield* runToolWithCtx(CancelTool, { wakeId: first.wakeId }, ctx)
      expect(one.cancelled).toEqual([first.wakeId])
      expect(yield* alarms.pending).toEqual([second.wakeId])
      expect(yield* readFile(home)).not.toContain(first.wakeId)
      const rest = yield* runToolWithCtx(CancelTool, {}, ctx)
      expect(rest.cancelled).toEqual([second.wakeId])
      expect(yield* alarms.pending).toEqual([])
      expect(yield* readFile(home)).toBe("[]")
      // Both alarms were due at 0.3s. Past that point nothing may have queued.
      yield* TestClock.adjust("500 millis")
      expect(yield* Ref.get(queued)).toEqual([])
      const missing = yield* runToolWithCtx(CancelTool, { wakeId: "nope" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunFileSystem.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )
})
