import {
  Cause,
  Clock,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Fiber,
  FiberMap,
  type FileSystem,
  Layer,
  Match,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Schema,
} from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import {
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  type ExtensionServiceError,
  omitUndefined,
  request,
  tool,
} from "@gent/core/extensions/api"
import { makeBranchStateStore } from "./branch-state-store.js"
import { runBashCommand } from "./exec-tools.js"

// Test seam: only tests read these exports. WakeAlarms, WakeAlarmsService and
// WakeAlarmsLive let a test hold and cancel timers; rearmPendingAlarms runs the
// restart path directly. wakeMessage, monitorMessage, nextDueAt and dueAtOf are pure functions with
// unit tests. WakeTool, MonitorTool and CancelTool are the
// capabilities the cell signature tests render.

// ── protocol ────────────────────────────────────────────────────────────────

/**
 * Wire shapes shared by the wake extension and its TUI tray: the pending
 * entries a branch holds and the request that lists them.
 */

export const WAKE_EXTENSION_ID = ExtensionId.make("@gent/wake")
/** `metadata.customType` on the user-role message an entry queues when it fires. */
export const WAKE_MESSAGE_TYPE = "wake"

/** `wake` starts a turn when the entry fires; `notify` leaves a notice the user sees at once and the model reads on its next turn. */
const WakeMode = Schema.Literals(["wake", "notify"])
type WakeMode = typeof WakeMode.Type

/**
 * How a notice came about. `blocked` is read only from notices stored by an
 * earlier version, which dropped an unapproved monitor on re-arm; nothing
 * writes it now.
 */
const NoticeOutcome = Schema.Literals(["fired", "matched", "timed-out", "blocked"])

/**
 * One pending wake. An alarm fires at a time, and again every `everySeconds`
 * when it repeats; a monitor runs a command on an interval and fires when it
 * succeeds, its output matches `until`, or the deadline passes. A monitor row
 * from an earlier version may carry a `cleared` key; decoding ignores it.
 */
export const WakeEntry = Schema.TaggedUnion({
  alarm: {
    wakeId: Schema.String,
    dueAt: Schema.Finite,
    everySeconds: Schema.optionalKey(Schema.Finite),
    mode: Schema.optionalKey(WakeMode),
    note: Schema.String,
  },
  monitor: {
    wakeId: Schema.String,
    command: Schema.String,
    cwd: Schema.optionalKey(Schema.String),
    everySeconds: Schema.Finite,
    until: Schema.optionalKey(Schema.String),
    deadline: Schema.Finite,
    mode: Schema.optionalKey(WakeMode),
    note: Schema.String,
  },
  /** A `notify` fire that nobody has read yet. The next turn's projection consumes it; `wake.cancel` dismisses it. */
  notice: {
    wakeId: Schema.String,
    outcome: NoticeOutcome,
    firedAt: Schema.Finite,
    content: Schema.String,
    note: Schema.String,
  },
})
export type WakeEntry = typeof WakeEntry.Type
type PendingWakeEntry = Exclude<WakeEntry, { readonly _tag: "notice" }>

const modeOf = (entry: PendingWakeEntry): WakeMode =>
  Option.getOrElse(Option.fromUndefinedOr(entry.mode), () => "wake")

/** What the tray shows: the entries still pending on the current branch, and the clock they count against. */
export const WakePending = Schema.Struct({
  now: Schema.Finite,
  entries: Schema.Array(WakeEntry),
})
export type WakePending = typeof WakePending.Type

/** `details` on a fired wake message; the transcript collapses the row to the outcome and `note`. `fired` is an alarm, the rest a monitor. */
export const WakeDetails = Schema.Struct({
  outcome: Schema.Literals(["fired", "matched", "timed-out"]),
  note: Schema.String,
  /** Epoch milliseconds; keys the queued line so a repeat's fires never merge. Rows written before repeats existed have none. */
  firedAt: Schema.optionalKey(Schema.Finite),
})
export type WakeDetails = typeof WakeDetails.Type

// ── alarms ──────────────────────────────────────────────────────────────────

/**
 * @gent/wake — alarms and monitors for work that finishes outside the harness.
 *
 * The model sets an alarm (a time) or a monitor (a command polled on an
 * interval) when it is waiting on CI, a deploy, or a remote queue, then
 * answers and goes idle. When the entry fires the extension queues a
 * user-role `wake` message on the same branch and wakes the loop, so the
 * next turn starts with the note the model left itself. Timers live in a
 * branch-scoped resource; the entries themselves live in one file per branch
 * under `<data dir>/wakes` (`resolveDataDir`: `GENT_DATA_DIR`, else
 * `~/.gent`), so the branch's loop, when it opens after a restart, re-arms
 * what is still pending and fires at once what came due while the process
 * was down.
 * A repeating alarm advances its stored due time on every fire; ticks missed
 * while the process was down collapse into one fire. In `notify` mode a fire
 * starts no turn: it leaves a `notice` entry in the same file, the tray shows
 * it at once, every step of the next turns reads every notice into a turn
 * notice, and a turn that answered clears the notices it showed. A `wake`
 * line the session refuses is left as a notice the same way.
 */

const MAXIMUM_WAKE_DELAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MONITOR_EVERY_SECONDS = 30
const DEFAULT_MONITOR_TIMEOUT_SECONDS = 30 * 60
const MINIMUM_MONITOR_EVERY_SECONDS = 0.1
const MINIMUM_REPEAT_EVERY_SECONDS = 0.1
const MONITOR_OUTPUT_TAIL_CHARS = 2_000

class WakeError extends Schema.TaggedError<WakeError>()("WakeError", {
  message: Schema.String,
}) {}

// ── Timers: one branch-scoped resource ──

export interface WakeAlarmsService {
  /**
   * Forks `work` into the branch scope under `wakeId`, so a closed branch
   * cancels it. Work already running under that id is left alone.
   */
  readonly schedule: (wakeId: string, work: Effect.Effect<void>) => Effect.Effect<void>
  /** Interrupts the timer under `wakeId`; false when none is running. */
  readonly cancel: (wakeId: string) => Effect.Effect<boolean>
  /** Ids with a running timer. */
  readonly pending: Effect.Effect<ReadonlyArray<string>>
}

export class WakeAlarms extends Context.Service<WakeAlarms, WakeAlarmsService>()(
  "@gent/extensions/src/wake/WakeAlarms",
) {}

export const WakeAlarmsLive: Layer.Layer<WakeAlarms> = Layer.effect(
  WakeAlarms,
  Effect.gen(function* () {
    // The map is bound to the branch scope, so closing the branch interrupts
    // every timer, and a fired timer drops its own key.
    const running = yield* FiberMap.make<string, void>()
    const schedule: WakeAlarmsService["schedule"] = (wakeId, work) =>
      FiberMap.run(running, wakeId, work, { onlyIfMissing: true }).pipe(Effect.asVoid)
    // One lookup: the interrupted fiber drops its own key when it ends.
    const cancel: WakeAlarmsService["cancel"] = (wakeId) =>
      FiberMap.get(running, wakeId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(false),
            onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.as(true)),
          }),
        ),
      )
    return WakeAlarms.of({
      schedule,
      cancel,
      pending: Effect.sync(() => [...running].map(([wakeId]) => wakeId)),
    })
  }),
)

// ── Durable half: one file per branch ──

const store = makeBranchStateStore({
  name: "WakeStore",
  directory: "wakes",
  codec: Schema.fromJsonString(Schema.Array(WakeEntry)),
  empty: [],
  invalid: (file, cause) =>
    new WakeError({ message: `Wake file ${file} is invalid: ${cause.message}` }),
})

/** The entries still pending on this branch; a missing file is an empty list. */
const readWakeEntries = store.read

const modifyWakeEntries = store.update

// ── Firing ──

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))

export const wakeMessage = (entry: Extract<WakeEntry, { readonly _tag: "alarm" }>) =>
  `Alarm ${entry.wakeId} fired at ${isoOf(entry.dueAt)}. ${entry.note}`

const tailOf = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.length <= MONITOR_OUTPUT_TAIL_CHARS) return trimmed
  return `…${trimmed.slice(-MONITOR_OUTPUT_TAIL_CHARS)}`
}

const monitorHead = (
  entry: Extract<WakeEntry, { readonly _tag: "monitor" }>,
  outcome: "matched" | "timed-out",
  checks: number,
): string => {
  if (outcome === "matched") {
    return `Monitor ${entry.wakeId} matched after ${checks} checks of \`${entry.command}\`.`
  }
  return `Monitor ${entry.wakeId} timed out after ${checks} checks of \`${entry.command}\` without matching.`
}

export const monitorMessage = (
  entry: Extract<WakeEntry, { readonly _tag: "monitor" }>,
  outcome: "matched" | "timed-out",
  checks: number,
  lastOutput: string,
): string => {
  const head = monitorHead(entry, outcome, checks)
  const output = tailOf(lastOutput)
  if (output.length === 0) return `${head} ${entry.note}`
  return `${head} ${entry.note}\n\nLast output:\n${output}`
}

/**
 * The key of one fire, stable across a restart: an alarm fires once per due
 * time (each repeat tick has its own), and a monitor fires once. A fire that
 * queued its wake but did not forget its row before a shutdown fires again on
 * re-arm, under the same key, and the queue drops the repeat.
 */
const fireKey = (entry: PendingWakeEntry): string => {
  if (entry._tag === "alarm") return `wake:${entry.wakeId}:${entry.dueAt}`
  return `wake:${entry.wakeId}:${entry.deadline}`
}

/** How a fire moves the entry's own row: a repeat moves to its next tick, anything else leaves. */
type SettleRow = (current: ReadonlyArray<WakeEntry>) => ReadonlyArray<WakeEntry>

/** Drops the entry's pending row; a notice under the same id stays. */
const dropPendingRow =
  (wakeId: string): SettleRow =>
  (current) =>
    current.filter((candidate) => candidate._tag === "notice" || candidate.wakeId !== wakeId)

/**
 * What a fire leaves behind, and the move of its row. In `wake` mode a
 * user-role line is queued with `wake: true`, which starts a turn on an idle
 * loop; the queue drops a repeat of the same fire key, so the row can move in
 * a later write. In `notify` mode the notice and the row move are one write,
 * so a stop cannot leave a notice with its row still due. A file an older
 * binary left in that state has the notice already: an alarm's notice text
 * names its due time, so the same text under the same id is the same fire,
 * and it is not added twice. A `wake` line the session refuses (a full
 * follow-up queue, for one) is left as a notice the same way, so the fire is
 * not lost.
 */
const queueWake = (
  entry: PendingWakeEntry,
  content: string,
  details: WakeDetails & { readonly firedAt: number },
  settle: SettleRow,
) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const leaveNotice = Effect.gen(function* () {
      const notice = WakeEntry.cases.notice.make({
        wakeId: entry.wakeId,
        outcome: details.outcome,
        firedAt: details.firedAt,
        content,
        note: entry.note,
      })
      yield* modifyWakeEntries((current) => {
        const settled = settle(current)
        const seen = current.some(
          (candidate) =>
            candidate._tag === "notice" &&
            candidate.wakeId === notice.wakeId &&
            candidate.content === notice.content,
        )
        if (seen) return settled
        return [...settled, notice]
      })
      yield* ctx.State.changed()
    })
    if (modeOf(entry) === "notify") return yield* leaveNotice
    const sent = yield* ctx.Session.send({
      delivery: "queue",
      sourceId: fireKey(entry),
      content,
      metadata: { customType: WAKE_MESSAGE_TYPE, extensionId: WAKE_EXTENSION_ID, details },
      wake: true,
    }).pipe(
      Effect.as(true),
      Effect.catchEager((error) =>
        Effect.logWarning("wake.fire.refused").pipe(
          Effect.annotateLogs({ wakeId: entry.wakeId, error: error.message }),
          Effect.as(false),
        ),
      ),
    )
    if (!sent) return yield* leaveNotice
    yield* modifyWakeEntries(settle)
  })

type NoticeEntry = Extract<WakeEntry, { readonly _tag: "notice" }>

/** One notice: a fire of one entry. A repeat's later fire is a new notice. */
const noticeKey = (notice: NoticeEntry) => `${notice.wakeId}@${notice.firedAt}`

/**
 * Every notice as one turn notice; none gives none. The projection runs on
 * every step, so the notice stays for the whole turn; nothing is cleared
 * here. Only the notices a step showed clear, and only when the turn
 * answered: a notice written after the turn's last step read the file stays
 * for the next turn.
 */
const turnNotices = Effect.fn("WakeTool.notices")(function* () {
  const notices = (yield* readWakeEntries()).flatMap((entry) => {
    if (entry._tag === "notice") return [entry]
    return []
  })
  if (notices.length === 0) return []
  return [
    {
      id: "wake-notices",
      keys: notices.map(noticeKey),
      content: `# Notices\n\nThese fired while you were idle; nothing has answered them yet.\n\n${notices.map((notice) => `- ${notice.content}`).join("\n")}`,
    },
  ]
})

/**
 * Drops the notices an answered turn showed. Any other, a fire the turn's
 * steps did not read, shows again next turn. Nothing dropped leaves the file
 * unwritten.
 */
const clearReadNotices = Effect.fn("WakeTool.clearNotices")(function* (shown: ReadonlySet<string>) {
  return yield* store.modify((current: ReadonlyArray<WakeEntry>) => {
    const kept = current.filter((entry) => entry._tag !== "notice" || !shown.has(noticeKey(entry)))
    const cleared = current.length - kept.length
    if (cleared === 0) return Effect.succeed({ next: current, result: 0 })
    return Effect.succeed({ next: kept, result: cleared })
  })
})

/** The first tick of a repeating alarm that is still ahead of `now`; every missed tick folds into the fire that just happened. */
export const nextDueAt = (dueAt: number, everySeconds: number, now: number): number => {
  // A stored row is not re-validated on re-arm, so the floor is applied here too.
  const every = Math.max(everySeconds, MINIMUM_REPEAT_EVERY_SECONDS) * 1000
  const missed = Math.max(0, Math.floor((now - dueAt) / every))
  return dueAt + (missed + 1) * every
}

/** What a timer needs while it runs: the branch context, its file, and the monitor's shell. */
type WakeWorkServices =
  | ExtensionContext
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner

type WakeWorkError = ExtensionServiceError | PlatformError.PlatformError | WakeError

/** Sleeps to each tick and fires it, in one loop: a repeat's fiber does not grow per tick. */
const alarmWork = (
  first: Extract<WakeEntry, { readonly _tag: "alarm" }>,
): Effect.Effect<void, WakeWorkError, WakeWorkServices> =>
  Effect.gen(function* () {
    let entry = first
    for (;;) {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("wake.armed").pipe(
        Effect.annotateLogs({ wakeId: entry.wakeId, dueInMs: entry.dueAt - now }),
      )
      yield* Effect.sleep(Duration.millis(Math.max(0, entry.dueAt - now)))
      yield* Effect.logInfo("wake.fired").pipe(Effect.annotateLogs({ wakeId: entry.wakeId }))
      const firedAt = yield* Clock.currentTimeMillis
      const details: WakeDetails & { readonly firedAt: number } = {
        outcome: "fired",
        note: entry.note,
        firedAt,
      }
      if (Predicate.isUndefined(entry.everySeconds)) {
        return yield* queueWake(entry, wakeMessage(entry), details, dropPendingRow(entry.wakeId))
      }
      // The next tick is stored with the fire, before the timer sleeps again, so a restart in between re-arms it.
      const next = { ...entry, dueAt: nextDueAt(entry.dueAt, entry.everySeconds, firedAt) }
      // Only the pending alarm row moves; a notify fire's notice shares its wakeId and stays.
      yield* queueWake(entry, wakeMessage(entry), details, (current) =>
        current.map((candidate) => {
          if (candidate._tag === "alarm" && candidate.wakeId === next.wakeId) return next
          return candidate
        }),
      )
      entry = next
    }
  })

const matches = (
  entry: Extract<WakeEntry, { readonly _tag: "monitor" }>,
  result: { readonly exitCode: number; readonly stdout: string },
): boolean => {
  if (Predicate.isUndefined(entry.until)) return result.exitCode === 0
  return new RegExp(entry.until).test(result.stdout)
}

const monitorWork = (
  entry: Extract<WakeEntry, { readonly _tag: "monitor" }>,
): Effect.Effect<void, WakeWorkError, WakeWorkServices> =>
  Effect.gen(function* () {
    yield* Effect.logInfo("wake.monitor.armed").pipe(
      Effect.annotateLogs({ wakeId: entry.wakeId, everySeconds: entry.everySeconds }),
    )
    // Resolved on every arm, not only when stored: a row an older binary wrote
    // may hold a relative cwd, which must not resolve against the server directory.
    const ctx = yield* ExtensionContext
    const path = yield* Path.Path
    const cwd = path.resolve(ctx.cwd, entry.cwd ?? ".")
    let checks = 0
    let lastOutput = ""
    for (;;) {
      checks += 1
      // A check that blocks (`tail -f`, a dead host) must not hold the monitor
      // past its deadline: the scope close kills the process.
      const budget = Math.max(0, entry.deadline - (yield* Clock.currentTimeMillis))
      // A check cut at the deadline is its own outcome: its empty output must
      // never be tested against `until` (".*" would match it).
      const result = yield* Effect.scoped(runBashCommand(entry.command, Option.some(cwd))).pipe(
        Effect.map((ran) => ({ ...ran, cut: false })),
        Effect.timeoutOrElse({
          duration: Duration.millis(budget),
          orElse: () =>
            Effect.succeed({
              exitCode: 1,
              stdout: "",
              stderr: "check still running at deadline",
              cut: true,
            }),
        }),
        Effect.catch((error) =>
          Effect.succeed({ exitCode: 1, stdout: "", stderr: error.message, cut: false }),
        ),
      )
      lastOutput = [result.stdout, result.stderr].filter((text) => text.length > 0).join("\n")
      if (!result.cut && matches(entry, result)) {
        yield* Effect.logInfo("wake.monitor.matched").pipe(
          Effect.annotateLogs({ wakeId: entry.wakeId, checks }),
        )
        return yield* queueWake(
          entry,
          monitorMessage(entry, "matched", checks, lastOutput),
          {
            outcome: "matched",
            note: entry.note,
            firedAt: yield* Clock.currentTimeMillis,
          },
          dropPendingRow(entry.wakeId),
        )
      }
      const now = yield* Clock.currentTimeMillis
      if (result.cut || now >= entry.deadline) {
        return yield* queueWake(
          entry,
          monitorMessage(entry, "timed-out", checks, lastOutput),
          { outcome: "timed-out", note: entry.note, firedAt: now },
          dropPendingRow(entry.wakeId),
        )
      }
      yield* Effect.sleep(
        Duration.millis(Math.min(entry.everySeconds * 1000, entry.deadline - now)),
      )
    }
  })

const workFor = Match.type<PendingWakeEntry>().pipe(
  Match.tagsExhaustive({
    alarm: (entry) => alarmWork(entry),
    monitor: (entry) => monitorWork(entry),
  }),
)

/**
 * Starts the timer for one stored entry. A settled fire (or a fire that
 * failed) drops the entry from the file; an interrupt does not, so a branch
 * close or a shutdown leaves the row for the next re-arm, and a cancel cleans
 * the file itself. A repeating alarm never settles; only a cancel ends it. An
 * id already running is left alone.
 *
 * A pending timer holds its branch's loop resident until it fires or is
 * cancelled: an idle loop that nothing holds is passivated, and the branch
 * scope the timer runs in closes with it.
 */
const armEntry = Effect.fn("WakeTool.arm")(function* (entry: PendingWakeEntry) {
  const ctx = yield* ExtensionContext
  // The timer outlives this call, so it keeps the services it runs against.
  const platform = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >()
  const alarms = yield* WakeAlarms
  const work = workFor(entry)
  // A settled fire moved its own row; a failed one drops the pending entry here.
  const forget = modifyWakeEntries(dropPendingRow(entry.wakeId)).pipe(Effect.ignore)
  return yield* alarms.schedule(
    entry.wakeId,
    ctx.Session.holdResident.pipe(
      Effect.andThen(work),
      Effect.scoped,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        return Effect.logWarning("wake.fire.failed").pipe(
          Effect.annotateLogs({ wakeId: entry.wakeId, cause: Cause.pretty(cause) }),
          Effect.andThen(forget),
        )
      }),
      Effect.provideService(ExtensionContext, ctx),
      Effect.provideContext(platform),
    ),
  )
})

/**
 * Re-arms every entry the file still holds; past-due alarms fire at once.
 *
 * The read and the arming run under the branch file's lock. A fire drops its
 * entry under the same lock before its timer ends, so an entry read here
 * still has its timer, or has none and is not dropped by a fire. A fire that
 * ended between an unlocked read and the arm was armed again and fired twice.
 */
export const rearmPendingAlarms = Effect.fn("WakeTool.rearm")(function* () {
  yield* store.modify((current: ReadonlyArray<WakeEntry>) =>
    Effect.gen(function* () {
      yield* Effect.logDebug("wake.rearm").pipe(Effect.annotateLogs({ pending: current.length }))
      for (const entry of current) {
        if (entry._tag !== "notice") yield* armEntry(entry)
      }
      // The file stays as read: returning it skips the write.
      return { next: current, result: current.length }
    }),
  )
})

const storeAndArm = Effect.fn("WakeTool.storeAndArm")(function* (entry: PendingWakeEntry) {
  yield* modifyWakeEntries((current) => [...current, entry])
  yield* armEntry(entry)
})

/** Drops entries from the file and interrupts their timers; returns each removed id once. */
const cancelWakes = Effect.fn("WakeTool.cancel")(function* (keep: (entry: WakeEntry) => boolean) {
  const alarms = yield* WakeAlarms
  const removed = yield* store.modify((current: ReadonlyArray<WakeEntry>) =>
    Effect.succeed({
      next: current.filter(keep),
      // A repeating notify alarm and its unread notices share one id.
      result: [...new Set(current.filter((entry) => !keep(entry)).map((entry) => entry.wakeId))],
    }),
  )
  // A stored entry may have no timer yet (before the loop's open re-arms it); an
  // interrupted timer leaves the file alone, which is why it is cleaned here first.
  yield* Effect.forEach(removed, (wakeId) => alarms.cancel(wakeId), { discard: true })
  return removed
})

// ── Tools ──

const WakeParams = Schema.Struct({
  afterSeconds: Schema.optionalKey(
    Schema.Finite.annotate({ description: "Seconds from now until the alarm fires." }),
  ),
  at: Schema.optionalKey(
    Schema.String.annotate({ description: "ISO 8601 time at which the alarm fires." }),
  ),
  everySeconds: Schema.optionalKey(
    Schema.Finite.annotate({
      description:
        "Repeat every this many seconds after the first fire, until wake.cancel. Omit for one fire.",
    }),
  ),
  mode: Schema.optionalKey(
    WakeMode.annotate({
      description:
        "`wake` (default): the fire starts a turn. `notify`: the fire is queued for your next turn and shown to the user, without starting one.",
    }),
  ),
  note: Schema.String.annotate({
    description: "What to check when the alarm fires. Arrives verbatim in the wake message.",
  }),
})

const WakeResult = Schema.Struct({
  wakeId: Schema.String,
  dueAt: Schema.String,
  everySeconds: Schema.optionalKey(Schema.Finite),
  mode: WakeMode,
  note: Schema.String,
})

/**
 * Resolves `afterSeconds` or `at` to an epoch-millisecond due time. An `at`
 * written to the second names the whole second, so one within the current
 * second is now, not the past.
 */
export const dueAtOf = (
  params: Pick<typeof WakeParams.Type, "afterSeconds" | "at">,
  now: number,
): Effect.Effect<number, WakeError> => {
  const fromAfter = Option.fromUndefinedOr(params.afterSeconds).pipe(
    Option.map((seconds) => now + seconds * 1000),
  )
  const startOfSecond = now - (now % 1000)
  const fromAt = Option.fromUndefinedOr(params.at).pipe(
    Option.flatMap((at) => DateTime.make(at)),
    Option.map(DateTime.toEpochMillis),
    Option.map((at) => {
      if (at >= startOfSecond) return Math.max(at, now)
      return at
    }),
  )
  if (Option.isSome(fromAfter) && Option.isSome(fromAt)) {
    return Effect.fail(new WakeError({ message: "Give afterSeconds or at, not both" }))
  }
  const dueAt = Option.orElse(fromAfter, () => fromAt)
  if (Option.isNone(dueAt) || !Number.isFinite(dueAt.value)) {
    return Effect.fail(
      new WakeError({ message: "Give afterSeconds (a number) or at (an ISO 8601 time)" }),
    )
  }
  if (dueAt.value < now) {
    return Effect.fail(new WakeError({ message: "An alarm cannot be in the past" }))
  }
  if (dueAt.value - now > MAXIMUM_WAKE_DELAY_MS) {
    return Effect.fail(new WakeError({ message: "An alarm can be at most 24 hours away" }))
  }
  return Effect.succeed(dueAt.value)
}

/** A wake or monitor row: its schedule, then its note when it has one. */
const summaryWithNote = (schedule: ReadonlyArray<string>, note: string): string =>
  [...schedule, note.trim()].filter((part) => part.length > 0).join(" · ")

export const WakeTool = tool({
  id: "wake",
  description:
    "Set an alarm. When it fires, a wake message carrying your note starts a new turn on this branch. Use it to check on work that runs outside this session (CI, a deploy, a remote job) at a known time instead of polling.",
  promptSnippet: "Schedule a wake-up alarm",
  promptGuidelines: [
    "When you are waiting on something outside the session, set a wake with a note saying what to check, answer, and stop; do not poll in a loop",
    "The note is all the wake message carries, so name the command or URL to check and what result means done",
    "Pick afterSeconds from how fast the thing actually changes: one check after a CI run's usual length beats many short ones",
    "everySeconds makes the alarm repeat; each fire starts a turn, so cancel it with wake.cancel as soon as the work it checks on is done",
    'mode: "notify" is for a reminder the user should see now and you should read next time you run; it never starts a turn',
  ],
  params: WakeParams,
  output: WakeResult,
  summary: (_input, output) =>
    summaryWithNote(
      [
        `${output.mode} at ${output.dueAt}`,
        ...Option.toArray(
          Option.map(Option.fromUndefinedOr(output.everySeconds), (every) => `every ${every}s`),
        ),
      ],
      output.note,
    ),
  execute: Effect.fn("WakeTool.execute")(function* (params: typeof WakeParams.Type) {
    const now = yield* Clock.currentTimeMillis
    const dueAt = yield* dueAtOf(params, now)
    const everySeconds = Option.fromUndefinedOr(params.everySeconds)
    if (Option.isSome(everySeconds) && everySeconds.value < MINIMUM_REPEAT_EVERY_SECONDS) {
      return yield* new WakeError({
        message: `everySeconds must be at least ${MINIMUM_REPEAT_EVERY_SECONDS}`,
      })
    }
    if (Option.isSome(everySeconds) && everySeconds.value * 1000 > MAXIMUM_WAKE_DELAY_MS) {
      return yield* new WakeError({ message: "A repeat can be at most 24 hours apart" })
    }
    // An optional key must be absent, not `undefined`, for the entry schema.
    const entry = WakeEntry.cases.alarm.make({
      wakeId: yield* (yield* Crypto.Crypto).randomUUIDv7,
      dueAt,
      note: params.note,
      ...omitUndefined({ everySeconds: params.everySeconds, mode: params.mode }),
    })
    yield* storeAndArm(entry)
    return {
      wakeId: entry.wakeId,
      dueAt: isoOf(dueAt),
      mode: modeOf(entry),
      note: entry.note,
      ...omitUndefined({ everySeconds: entry.everySeconds }),
    }
  }),
})

const MonitorParams = Schema.Struct({
  command: Schema.String.annotate({
    description:
      "Shell command run on every check. Without `until`, exit 0 means done (for example `gh run view 123 --exit-status`).",
  }),
  cwd: Schema.optionalKey(
    Schema.String.annotate({ description: "Working directory for the command." }),
  ),
  everySeconds: Schema.optionalKey(
    Schema.Finite.annotate({ description: "Seconds between checks. Default 30." }),
  ),
  until: Schema.optionalKey(
    Schema.String.annotate({
      description: "Regular expression; when it matches the command's stdout the monitor is done.",
    }),
  ),
  timeoutSeconds: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Give up after this long and wake anyway. Default 1800, at most 86400.",
    }),
  ),
  mode: Schema.optionalKey(
    WakeMode.annotate({
      description:
        "`wake` (default): the match starts a turn. `notify`: the match is queued for your next turn and shown to the user, without starting one.",
    }),
  ),
  note: Schema.String.annotate({
    description: "What to do when the monitor wakes you. Arrives verbatim in the wake message.",
  }),
})

const MonitorResult = Schema.Struct({
  wakeId: Schema.String,
  everySeconds: Schema.Finite,
  deadline: Schema.String,
  mode: WakeMode,
  note: Schema.String,
})

const validRegex = (pattern: Option.Option<string>): Effect.Effect<void, WakeError> =>
  Option.match(pattern, {
    onNone: () => Effect.void,
    onSome: (value) =>
      Effect.try({
        try: () => new RegExp(value).source,
        catch: () =>
          new WakeError({ message: `until is not a valid regular expression: ${value}` }),
      }).pipe(Effect.asVoid),
  })

export const MonitorTool = tool({
  id: "monitor",
  description:
    "Poll a shell command on an interval until it exits 0 (or its output matches `until`), then wake this branch with a message carrying the last output and your note. Use it for CI runs, deploys, ports, files, or URLs that change on their own.",
  promptSnippet: "Poll a command until it succeeds, then wake",
  promptGuidelines: [
    "One monitor replaces a loop of bash checks: give the check as a command that exits 0 when done, or an `until` regex on its output, then answer and stop",
    "Set everySeconds to how fast the thing changes; a CI run needs a check every minute, not every second",
    "The wake message carries the last output, so make the command print what you will need to decide the next step",
  ],
  params: MonitorParams,
  output: MonitorResult,
  summary: (input, output) =>
    summaryWithNote(
      [output.mode, input.command.trim(), `every ${output.everySeconds}s until ${output.deadline}`],
      output.note,
    ),
  execute: Effect.fn("MonitorTool.execute")(function* (params: typeof MonitorParams.Type) {
    const ctx = yield* ExtensionContext
    const path = yield* Path.Path
    const now = yield* Clock.currentTimeMillis
    yield* validRegex(Option.fromUndefinedOr(params.until))
    const everySeconds = Math.max(
      MINIMUM_MONITOR_EVERY_SECONDS,
      Option.getOrElse(
        Option.fromUndefinedOr(params.everySeconds),
        () => DEFAULT_MONITOR_EVERY_SECONDS,
      ),
    )
    const timeoutSeconds = Math.min(
      MAXIMUM_WAKE_DELAY_MS / 1000,
      Option.getOrElse(
        Option.fromUndefinedOr(params.timeoutSeconds),
        () => DEFAULT_MONITOR_TIMEOUT_SECONDS,
      ),
    )
    if (timeoutSeconds < 0) {
      return yield* new WakeError({ message: "timeoutSeconds must not be negative" })
    }
    if (params.command.trim().length === 0) {
      return yield* new WakeError({ message: "command is empty" })
    }
    // One server serves every workspace: resolve against the session's cwd.
    const cwd = path.resolve(ctx.cwd, params.cwd ?? ".")
    const deadline = now + timeoutSeconds * 1000
    // An optional key must be absent, not `undefined`, for the entry schema.
    const entry = WakeEntry.cases.monitor.make({
      wakeId: yield* (yield* Crypto.Crypto).randomUUIDv7,
      command: params.command,
      cwd,
      everySeconds,
      deadline,
      note: params.note,
      ...omitUndefined({ until: params.until, mode: params.mode }),
    })
    yield* storeAndArm(entry)
    return {
      wakeId: entry.wakeId,
      everySeconds,
      deadline: isoOf(deadline),
      mode: modeOf(entry),
      note: entry.note,
    }
  }),
})

const CancelParams = Schema.Struct({
  wakeId: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The alarm or monitor to cancel. Omit to cancel every pending one on this branch.",
    }),
  ),
})

const CancelResult = Schema.Struct({ cancelled: Schema.Array(Schema.String) })

export const CancelTool = tool({
  id: "wake.cancel",
  description:
    "Cancel a pending alarm or monitor by wakeId, or every pending one on this branch when no id is given. Use it when the thing you were waiting for is already done. A notice still shown to the user is dismissed the same way.",
  promptSnippet: "Cancel a pending alarm or monitor",
  params: CancelParams,
  output: CancelResult,
  execute: Effect.fn("CancelTool.execute")(function* (params: typeof CancelParams.Type) {
    const target = Option.fromUndefinedOr(params.wakeId)
    const cancelled = yield* cancelWakes((entry) =>
      Option.match(target, { onNone: () => false, onSome: (id) => entry.wakeId !== id }),
    )
    if (Option.isSome(target) && cancelled.length === 0) {
      return yield* new WakeError({ message: `No pending wake ${target.value} on this branch` })
    }
    return { cancelled }
  }),
})

/** One read for the model and the tray: what is pending on this branch, against the same clock. */
const listPending = Effect.fn("WakeTool.list")(function* () {
  const now = yield* Clock.currentTimeMillis
  const entries = yield* readWakeEntries()
  return { now, entries }
})

/**
 * One entry as the model reads it: ISO times, like the `wake` and `monitor`
 * results, instead of the epoch milliseconds the tray counts against.
 */
const WakeListing = Schema.TaggedUnion({
  alarm: WakeResult.fields,
  monitor: {
    ...MonitorResult.fields,
    command: Schema.String,
    cwd: Schema.optionalKey(Schema.String),
    until: Schema.optionalKey(Schema.String),
  },
  notice: {
    wakeId: Schema.String,
    outcome: NoticeOutcome,
    firedAt: Schema.String,
    content: Schema.String,
    note: Schema.String,
  },
})

const WakeListResult = Schema.Struct({
  now: Schema.String,
  entries: Schema.Array(WakeListing),
})

const listingOf = Match.type<WakeEntry>().pipe(
  Match.tagsExhaustive({
    alarm: (entry) =>
      WakeListing.cases.alarm.make({
        wakeId: entry.wakeId,
        dueAt: isoOf(entry.dueAt),
        mode: modeOf(entry),
        note: entry.note,
        ...omitUndefined({ everySeconds: entry.everySeconds }),
      }),
    monitor: (entry) =>
      WakeListing.cases.monitor.make({
        wakeId: entry.wakeId,
        command: entry.command,
        everySeconds: entry.everySeconds,
        deadline: isoOf(entry.deadline),
        mode: modeOf(entry),
        note: entry.note,
        ...omitUndefined({ cwd: entry.cwd, until: entry.until }),
      }),
    notice: (entry) =>
      WakeListing.cases.notice.make({
        wakeId: entry.wakeId,
        outcome: entry.outcome,
        firedAt: isoOf(entry.firedAt),
        content: entry.content,
        note: entry.note,
      }),
  }),
)

const ListTool = tool({
  id: "wake.list",
  readonly: true,
  description:
    "List the alarms and monitors pending on this branch and the notices nobody has answered, with ISO times and the current time as `now`. Use it after a context handoff, or before you arm a wake that may already exist.",
  promptSnippet: "List pending alarms, monitors, and notices",
  params: Schema.Struct({
    wakeId: Schema.optionalKey(
      Schema.String.annotate({ description: "Show only this alarm, monitor, or notice." }),
    ),
  }),
  output: WakeListResult,
  execute: Effect.fn("ListTool.execute")(function* (params) {
    const pending = yield* listPending()
    const target = Option.fromUndefinedOr(params.wakeId)
    const entries = pending.entries.filter((entry) =>
      Option.match(target, { onNone: () => true, onSome: (id) => entry.wakeId === id }),
    )
    return { now: isoOf(pending.now), entries: entries.map(listingOf) }
  }),
})

// ── Requests ──

export const WakeRpc = defineRequests(WAKE_EXTENSION_ID, {
  Pending: request({
    id: "wake.pending",
    description:
      "The alarms and monitors still pending on the current branch, and the notices not yet read",
    answersDuringTurn: true,
    input: Schema.Struct({}),
    output: WakePending,
    execute: () => listPending(),
  }),
})

// ── Extension ──

export const WakeExtension = defineExtension({
  id: WAKE_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", WakeTool, MonitorTool, CancelTool, ListTool)
    yield* host.register("request", WakeRpc.Pending)
    // The branch resource starts without a session facade, so the loop's open
    // is where stored entries get their timers back: after a restart or a
    // branch close, as soon as anything reaches the branch. A past-due alarm
    // fires at once; a notify one leaves its notice and starts no turn.
    yield* host.on("loopOpen", () =>
      rearmPendingAlarms().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("wake.rearm.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    )
    // Every step reads the notices that have not been answered yet.
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        return { notices: yield* turnNotices() }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("wake.notices.read.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            Effect.as({}),
          ),
        ),
      ),
    )
    // A turn that answered has read every notice its steps were shown.
    yield* host.on("turnAfter", (input) =>
      Effect.gen(function* () {
        if (input.readNotices.size === 0) return
        const cleared = yield* clearReadNotices(input.readNotices)
        if (cleared > 0) yield* (yield* ExtensionContext).State.changed()
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("wake.notices.clear.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    )
    yield* host.register(
      "resource",
      defineResource({
        id: "@gent/wake/alarms",
        scope: "branch",
        layer: WakeAlarmsLive,
      }),
    )
  }),
})
