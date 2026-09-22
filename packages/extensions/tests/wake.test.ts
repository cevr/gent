import { describe, expect, it, test } from "effect-bun-test"
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { RuntimeEnvironment } from "@gent/core-internal/runtime/config"
import {
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textDeltaPart,
  textStep,
  toolCallPart,
  toolCallStep,
  waitFor,
} from "@gent/core-internal/test-utils/language-model"
import {
  createRpcHarness,
  runToolWithCtx,
  testLeafContext,
  testToolContext,
} from "@gent/core-internal/test-utils/index"
import { e2ePreset } from "./helpers/test-preset"
import {
  CancelTool,
  dueAtOf,
  monitorMessage,
  MonitorTool,
  nextDueAt,
  rearmPendingAlarms,
  WAKE_EXTENSION_ID,
  WAKE_MESSAGE_TYPE,
  WakeAlarms,
  WakeAlarmsLive,
  WakeEntry,
  wakeMessage,
  WakePending,
  WakeRpc,
  WakeTool,
} from "../src/wake.js"
import { TestClock } from "effect/testing"
import { BranchId, RequestId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { SteerCommand } from "@gent/core-internal/domain/message"
import {
  ExtensionContext,
  type ExtensionContextService,
} from "@gent/core-internal/domain/extension"

// ── wake/wake.test ──────────────────────────────────────────────────────────

/**
 * `wake` is an alarm and `monitor` a poll: the model sets one, answers, and
 * goes idle; when it fires, a user-role `wake` message on the same branch
 * starts the next turn.
 */

const encodeAlarms = Schema.encodeSync(Schema.fromJsonString(Schema.Array(WakeEntry)))

const replyStream = (text: string) =>
  Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })])

interface MessageLike {
  readonly role: string
  readonly metadata?: { readonly customType?: string }
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

const wakeOf = <M extends MessageLike>(messages: ReadonlyArray<M>): Option.Option<M> =>
  Option.fromUndefinedOr(
    messages.find(
      (message) => message.role === "user" && message.metadata?.customType === WAKE_MESSAGE_TYPE,
    ),
  )

const textOf = (message: Option.Option<MessageLike>): string =>
  Option.match(message, {
    onNone: () => "",
    onSome: (value) =>
      value.parts
        .filter((part) => part.type === "text")
        .map((part) => Option.getOrElse(Option.fromUndefinedOr(part.text), () => ""))
        .join(""),
  })

const hasWake = (messages: ReadonlyArray<MessageLike>): boolean => Option.isSome(wakeOf(messages))

const answered = (messages: ReadonlyArray<MessageLike>, text: string): boolean =>
  messages.some((message) => message.role === "assistant" && textOf(Option.some(message)) === text)

describe("wake", () => {
  it.live("a due time comes from afterSeconds or an ISO time, never both", () =>
    Effect.gen(function* () {
      const now = 1_000_000
      expect(yield* dueAtOf({ afterSeconds: 90 }, now)).toBe(now + 90_000)
      expect(yield* dueAtOf({ at: "1970-01-01T00:20:00.000Z" }, now)).toBe(1_200_000)
      const both = yield* Effect.exit(dueAtOf({ afterSeconds: 1, at: "1970-01-01T00:20:00Z" }, now))
      expect(Exit.isFailure(both)).toBe(true)
      const neither = yield* Effect.exit(dueAtOf({}, now))
      expect(Exit.isFailure(neither)).toBe(true)
      const garbage = yield* Effect.exit(dueAtOf({ at: "tomorrow-ish" }, now))
      expect(Exit.isFailure(garbage)).toBe(true)
      const tooFar = yield* Effect.exit(dueAtOf({ afterSeconds: 25 * 60 * 60 }, now))
      expect(Exit.isFailure(tooFar)).toBe(true)
      expect(wakeMessage({ _tag: "alarm", wakeId: "w1", dueAt: 1_200_000, note: "check CI" })).toBe(
        "Alarm w1 fired at 1970-01-01T00:20:00.000Z. check CI",
      )
      const monitor = WakeEntry.cases.monitor.make({
        wakeId: "m1",
        command: "true",
        everySeconds: 1,
        deadline: 0,
        note: "merge it",
      })
      expect(monitorMessage(monitor, "matched", 3, "ok\n")).toBe(
        "Monitor m1 matched after 3 checks of `true`. merge it\n\nLast output:\nok",
      )
      expect(monitorMessage(monitor, "timed-out", 9, "")).toBe(
        "Monitor m1 timed out after 9 checks of `true` without matching. merge it",
      )
      // The next tick is the first one still ahead; missed ticks fold into the fire that happened.
      expect(nextDueAt(1_000, 10, 1_000)).toBe(11_000)
      expect(nextDueAt(1_000, 10, 35_000)).toBe(41_000)
    }),
  )

  it.live(
    "a notify alarm leaves a notice the user sees at once and the next turn reads, without starting one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const systemPrompts: Array<string> = []
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            for (const message of options.prompt.content) {
              if (message.role === "system") systemPrompts.push(message.content)
            }
            calls += 1
            if (calls === 1) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart(
                    "wake",
                    { afterSeconds: 0.2, mode: "notify", note: "stand up" },
                    { toolCallId: ToolCallId.make("notify-1") },
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            if (calls === 2) return Effect.succeed(replyStream("reminder set"))
            return Effect.succeed(replyStream("read the notice with your prompt"))
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          const list = () =>
            client.extension
              .request({
                sessionId,
                branchId,
                extensionId: WAKE_EXTENSION_ID,
                capabilityId: WakeRpc.Pending.id,
                input: {},
              })
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(WakePending)))
          yield* client.message.send({ sessionId, branchId, content: "remind me" })
          // The fire leaves a notice; the loop stays idle and no turn or wake row follows.
          // The fired alarm leaves the file once its notice is in; wait for that settled shape.
          const noticed = yield* waitFor(
            list(),
            (pending) => pending.entries.length === 1 && pending.entries[0]?._tag === "notice",
            5_000,
            "the notice is listed alone",
          )
          expect(noticed.entries).toMatchObject([{ _tag: "notice", note: "stand up" }])
          const idle = yield* client.session.getSnapshot({ sessionId, branchId })
          expect(idle.runtime._tag).toBe("Idle")
          expect(hasWake(idle.messages)).toBe(false)
          // The tool-call step and the reply: nothing after the fire.
          expect(idle.messages.filter((m) => m.role === "assistant").length).toBe(2)
          yield* client.message.send({ sessionId, branchId, content: "what did I miss?" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              answered(current.messages, "read the notice with your prompt"),
            8_000,
            "the next turn ran",
          )
          // The notice reached the model as a prompt section and left the list.
          expect(hasWake(idle.messages)).toBe(false)
          expect(systemPrompts.at(-1)).toContain("# Notices")
          expect(systemPrompts.at(-1)).toContain("stand up")
          expect((yield* list()).entries).toEqual([])
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "an idle session wakes at the alarm with the note as a user message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("wake", { afterSeconds: 0.3, note: "check whether CI is green" }),
            textStep("alarm set, going idle"),
            textStep("woke up and checked CI"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "wake me when CI is done" })
          const idle = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              answered(current.messages, "alarm set, going idle"),
            5_000,
            "first turn answered",
          )
          expect(hasWake(idle.messages)).toBe(false)
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              answered(current.messages, "woke up and checked CI"),
            8_000,
            "the alarm queued a wake message and the loop answered it",
          )
          expect(textOf(wakeOf(woken.messages)).endsWith("check whether CI is green")).toBe(true)
          expect(woken.messages.at(-1)?.role).toBe("assistant")
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a past-due alarm left on disk fires on the first turn after a restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* makeTempDirectoryScoped("wake-restart-")
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("hello again"),
            textStep("checked the build as the alarm asked"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extraLayers: [RuntimeEnvironment.Live({ cwd: "/tmp", home })],
          })
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
          yield* fs.writeFileString(
            `${home}/.gent/wakes/${branchId}.json`,
            encodeAlarms([
              { _tag: "alarm", wakeId: "left-over", dueAt: 1_000, note: "check the build" },
            ]),
          )
          yield* client.message.send({ sessionId, branchId, content: "I'm back" })
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              current.messages.at(-1)?.role === "assistant",
            8_000,
            "the stored alarm fired and was answered",
          )
          expect(woken.messages.filter((m) => m.role === "assistant").length).toBe(2)
          expect(yield* fs.readFileString(`${home}/.gent/wakes/${branchId}.json`)).toBe("[]")
        }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a monitor polls its command until it succeeds, then wakes with the output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* makeTempDirectoryScoped("wake-monitor-")
          const flag = `${dir}/done`
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("monitor", {
              command: `test -f ${flag} && cat ${flag}`,
              everySeconds: 0.1,
              timeoutSeconds: 10,
              note: "read the result file",
            }),
            textStep("watching for the file"),
            textStep("saw the result"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "tell me when it lands" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              answered(current.messages, "watching for the file"),
            5_000,
            "first turn answered",
          )
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString(flag, "build 42 green")
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              answered(current.messages, "saw the result"),
            8_000,
            "the monitor matched and woke the loop",
          )
          const text = textOf(wakeOf(woken.messages))
          expect(text).toContain("matched after")
          expect(text).toContain("build 42 green")
          expect(text).toContain("read the result file")
        }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a monitor that never matches wakes at its deadline and says so",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("monitor", {
              command: "echo still running; false",
              everySeconds: 0.1,
              timeoutSeconds: 0.35,
              note: "give up and report",
            }),
            textStep("watching"),
            textStep("gave up"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "watch it" })
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              answered(current.messages, "gave up"),
            8_000,
            "the monitor timed out and woke the loop",
          )
          const text = textOf(wakeOf(woken.messages))
          expect(text).toContain("timed out after")
          expect(text).toContain("still running")
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

describe("wake.list", () => {
  it.live(
    "the model lists what it armed, with the clock it counts against",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const listed: Array<unknown> = []
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            calls += 1
            if (calls === 1) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart(
                    "wake",
                    { afterSeconds: 3600, everySeconds: 600, note: "check CI" },
                    { toolCallId: ToolCallId.make("arm-1") },
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            if (calls === 2) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart("wake.list", {}, { toolCallId: ToolCallId.make("list-1") }),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            for (const message of options.prompt.content) {
              if (message.role !== "tool") continue
              for (const part of message.content) {
                if (part.type === "tool-result" && part.id === "list-1") {
                  listed.push(part.result)
                }
              }
            }
            return Effect.succeed(replyStream("one alarm pending"))
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "what is armed?" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" && answered(current.messages, "one alarm pending"),
            8_000,
            "the turn answered",
          )
          expect(listed.length).toBe(1)
          // The model reads ISO times, the same format `wake` returned for this alarm.
          const listing = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              now: Schema.String,
              entries: Schema.Array(
                Schema.TaggedStruct("alarm", {
                  dueAt: Schema.String,
                  everySeconds: Schema.Finite,
                  mode: Schema.String,
                  note: Schema.String,
                }),
              ),
            }),
          )(listed[0])
          expect(listing.entries).toMatchObject([
            { _tag: "alarm", note: "check CI", everySeconds: 600, mode: "wake" },
          ])
          const millis = (iso: string) =>
            Option.getOrElse(Option.map(DateTime.make(iso), DateTime.toEpochMillis), () => NaN)
          const aheadSeconds =
            (millis(listing.entries[0]?.dueAt ?? "") - millis(listing.now)) / 1000
          expect(aheadSeconds).toBeGreaterThan(3500)
          expect(aheadSeconds).toBeLessThanOrEqual(3600)
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

describe("notices", () => {
  it.live(
    "a notice stays in every step's prompt and survives an interrupted turn; an answered turn clears it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const systemPrompts: Array<string> = []
          const streaming = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let calls = 0
          const providerLayer = LanguageModelLayers.testStream((options) => {
            for (const message of options.prompt.content) {
              if (message.role === "system") systemPrompts.push(message.content)
            }
            calls += 1
            // Turn 1: set the notify alarm, then reply.
            if (calls === 1) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart(
                    "wake",
                    { afterSeconds: 0.2, mode: "notify", note: "stand up" },
                    { toolCallId: ToolCallId.make("notify-1") },
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            if (calls === 2) return Effect.succeed(replyStream("reminder set"))
            // Turn 2: held open, then interrupted.
            if (calls === 3) {
              return Deferred.succeed(streaming, void 0).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(replyStream("never read")),
              )
            }
            // Turn 3: a tool step, then a reply; both steps must carry the notice.
            if (calls === 4) {
              return Effect.succeed(
                Stream.fromIterable([
                  toolCallPart(
                    "wake",
                    { afterSeconds: 3600, note: "much later" },
                    { toolCallId: ToolCallId.make("later-1") },
                  ),
                  finishPart({ finishReason: "tool-calls" }),
                ]),
              )
            }
            return Effect.succeed(replyStream("read the notice twice"))
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          const list = () =>
            client.extension
              .request({
                sessionId,
                branchId,
                extensionId: WAKE_EXTENSION_ID,
                capabilityId: WakeRpc.Pending.id,
                input: {},
              })
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(WakePending)))
          const notices = () =>
            Effect.map(list(), (pending) =>
              pending.entries.filter((entry) => entry._tag === "notice"),
            )
          yield* client.message.send({ sessionId, branchId, content: "remind me" })
          yield* waitFor(notices(), (found) => found.length === 1, 5_000, "the notice is listed")
          yield* client.message.send({ sessionId, branchId, content: "hold on" })
          yield* Deferred.await(streaming)
          yield* client.steer.command({
            command: SteerCommand.make({
              _tag: "Cancel",
              sessionId,
              branchId,
              requestId: RequestId.make("interrupt-holding-turn"),
            }),
          })
          yield* Deferred.succeed(release, void 0)
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle" && calls === 3,
            5_000,
            "the held turn ended",
          )
          // The interrupted turn read the notice but did not answer; it stays.
          expect(systemPrompts.at(-1)).toContain("stand up")
          expect((yield* notices()).length).toBe(1)
          yield* client.message.send({ sessionId, branchId, content: "what did I miss?" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              answered(current.messages, "read the notice twice"),
            8_000,
            "the answered turn ran",
          )
          expect(systemPrompts.length).toBe(5)
          expect(systemPrompts[3]).toContain("stand up")
          expect(systemPrompts[4]).toContain("stand up")
          yield* waitFor(notices(), (found) => found.length === 0, 5_000, "the notice is cleared")
        }).pipe(Effect.timeout("14 seconds")),
      ),
    16_000,
  )
})

// ── wake/wake-store.test ────────────────────────────────────────────────────

/**
 * Alarms live in one file per branch so a restart loses none: the tool writes
 * the file, firing removes the entry, and the next turn re-arms what is left.
 */

const branchId = BranchId.make("wake-branch")

/** The store's read-modify-write cycles serialize under the host's file lock; the bare test lock is a pass-through, so a timer and a cancel would interleave. */
const lockingFileLock = (): ExtensionContextService["FileLock"] => {
  const locks = new Map<string, Semaphore.Semaphore>()
  return {
    withLock: (path, effect) => {
      const lock = Option.fromNullishOr(locks.get(path)).pipe(
        Option.getOrElse(() => {
          const created = Semaphore.makeUnsafe(1)
          locks.set(path, created)
          return created
        }),
      )
      return lock.withPermits(1)(effect)
    },
  }
}

const contextWith = (
  home: string,
  queued: Ref.Ref<ReadonlyArray<string>>,
  fired: Option.Option<Deferred.Deferred<boolean>> = Option.none(),
) =>
  testToolContext({
    FileLock: lockingFileLock(),
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
 * settled. The finalizer does real file I/O, so the wait is bounded by real
 * time, not by a turn count: two thousand scheduler turns pass in a few
 * milliseconds, and under gate load a write can take longer than that, which
 * is how this wait once reported "still pending" on a fire that was landing.
 * Each turn advances the virtual clock (releases anything sleeping) and then
 * sleeps on the wall clock (lets the I/O land). Exhaustion fails loudly; a
 * silent give-up would let a later assertion read a half-finished fire.
 */
const settled = (
  ids: Effect.Effect<ReadonlyArray<string>>,
  wakeId: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    const deadline = wallClock.currentTimeMillisUnsafe() + 5_000
    while (wallClock.currentTimeMillisUnsafe() < deadline) {
      const running = yield* ids
      const done = Option.match(wakeId, {
        onNone: () => running.length === 0,
        onSome: (id) => !running.includes(id),
      })
      if (done) return
      yield* TestClock.adjust("1 milli")
      // gent/no-sleep: allow the wait is for real file I/O, which only the wall clock paces
      yield* Effect.sleep("2 millis").pipe(Effect.provideService(Clock.Clock, wallClock))
    }
    expect("wake timers still pending").toBe("no wake timer pending")
  })

/** The real clock, beside the `TestClock` the alarms run on. */
const wallClock = Clock.Clock.defaultValue()

/** Waits on the wall clock, never the virtual one, for work a `TestClock.adjust` already released. Exhaustion fails loudly. */
const eventually = <A>(read: Effect.Effect<A>, done: (value: A) => boolean, label: string) =>
  Effect.gen(function* () {
    const deadline = wallClock.currentTimeMillisUnsafe() + 5_000
    while (wallClock.currentTimeMillisUnsafe() < deadline) {
      if (done(yield* read)) return
      // gent/no-sleep: allow the wait is for real file I/O, which only the wall clock paces
      yield* Effect.sleep("2 millis").pipe(Effect.provideService(Clock.Clock, wallClock))
    }
    expect(`still waiting: ${label}`).toBe(label)
  })

const readFile = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(`${home}/.gent/wakes/${branchId}.json`)
  }).pipe(Effect.provide(BunFileSystem.layer))

describe("monitor guardrail", () => {
  test("monitor runs shell commands, so it does not claim to be readonly", () => {
    expect(MonitorTool.readonly).toBe(false)
  })

  it.scopedLive("a flagged command asks once; a denial stores no monitor", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("wake-monitor-guard-")
      const queued = yield* Ref.make<ReadonlyArray<string>>([])
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const base = contextWith(home, queued)
      const ctx = {
        ...base,
        Interaction: {
          ...base.Interaction,
          approve: ({ text }: { readonly text: string }) =>
            Ref.update(asked, (all) => [...all, text]).pipe(Effect.as({ approved: false })),
        },
      }
      const exit = yield* Effect.exit(
        runToolWithCtx(MonitorTool, { command: "rm -rf build && ls build", note: "gone" }, ctx),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const prompts = yield* Ref.get(asked)
      expect(prompts.length).toBe(1)
      expect(prompts[0]).toContain("rm -rf")
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.exists(`${home}/.gent/wakes/${branchId}.json`)).toBe(false)
    }).pipe(
      Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunFileSystem.layer, TestClock.layer())),
      Effect.timeout("8 seconds"),
    ),
  )
})

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

  it.scopedLive(
    "a repeating alarm fires on each tick, stores the next one, and stops on cancel",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-repeat-")
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const ctx = contextWith(home, queued)
        const handle = yield* runToolWithCtx(
          WakeTool,
          { afterSeconds: 1, everySeconds: 2, note: "stretch" },
          ctx,
        )
        expect(handle.everySeconds).toBe(2)
        const alarms = yield* WakeAlarms
        const firedCount = Effect.map(Ref.get(queued), (all) => all.length)
        yield* TestClock.adjust("1 second")
        yield* eventually(firedCount, (count) => count === 1, "first fire")
        // The stored due time moved to the next tick and the timer is still up.
        yield* eventually(
          readFile(home).pipe(Effect.orDie),
          (file) => file.includes(`"dueAt":3000`),
          "next tick",
        )
        expect(yield* alarms.pending).toEqual([handle.wakeId])
        yield* TestClock.adjust("2 seconds")
        yield* eventually(firedCount, (count) => count === 2, "second fire")
        const cancelled = yield* runToolWithCtx(CancelTool, { wakeId: handle.wakeId }, ctx)
        expect(cancelled.cancelled).toEqual([handle.wakeId])
        yield* settled(alarms.pending)
        expect(yield* readFile(home)).toBe("[]")
        yield* TestClock.adjust("4 seconds")
        expect(yield* firedCount).toBe(2)
      }).pipe(
        Effect.provide(Layer.mergeAll(WakeAlarmsLive, BunFileSystem.layer, TestClock.layer())),
        Effect.timeout("8 seconds"),
      ),
  )

  it.scopedLive(
    "an interrupted timer leaves its row for the next re-arm; a settled fire removes it",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("wake-interrupt-")
        const queued = yield* Ref.make<ReadonlyArray<string>>([])
        const ctx = contextWith(home, queued)
        const once = yield* runToolWithCtx(WakeTool, { afterSeconds: 5, note: "once" }, ctx)
        const repeat = yield* runToolWithCtx(
          WakeTool,
          { afterSeconds: 1, everySeconds: 2, note: "again" },
          ctx,
        )
        const alarms = yield* WakeAlarms
        const firedCount = Effect.map(Ref.get(queued), (all) => all.length)
        yield* TestClock.adjust("1 second")
        yield* eventually(firedCount, (count) => count === 1, "the repeat fired once")
        yield* eventually(
          readFile(home).pipe(Effect.orDie),
          (file) => file.includes(`"dueAt":3000`),
          "the repeat stored its next tick",
        )
        // A branch close or a shutdown interrupts the timers; the rows must stay.
        expect(yield* alarms.cancel(repeat.wakeId)).toBe(true)
        expect(yield* alarms.cancel(once.wakeId)).toBe(true)
        yield* settled(alarms.pending)
        const file = yield* readFile(home)
        expect(file).toContain(once.wakeId)
        expect(file).toContain(repeat.wakeId)
        expect(file).toContain(`"dueAt":3000`)
        // Re-armed, the one-shot fires and is the only row that leaves.
        const armed = yield* rearmPendingAlarms().pipe(
          Effect.provideService(ExtensionContext, testLeafContext(ctx)),
        )
        expect(armed).toBe(2)
        yield* TestClock.adjust("4 seconds")
        yield* eventually(firedCount, (count) => count === 3, "the one-shot and the repeat fired")
        yield* settled(alarms.pending, Option.some(once.wakeId))
        expect(yield* readFile(home)).not.toContain(once.wakeId)
        expect(yield* readFile(home)).toContain(repeat.wakeId)
      }).pipe(
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
