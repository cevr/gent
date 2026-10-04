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
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import {
  type AgentEvent,
  type Branch,
  type BranchId,
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  type ExtensionServiceError,
  isSpawnedSession,
  type Message,
  MessageId,
  omitUndefined,
  request,
  tailChars,
  tool,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import { makeBranchStateStore } from "./branch-state-store.js"
import { runBashCommand, wholeCommandOutputText } from "./exec-tools.js"
import { makeRegexMatcher } from "./regex-matcher.js"

// Test seam: only tests read these exports. WakeAlarms and
// WakeAlarmsLive let a test hold and cancel timers; rearmPendingAlarms runs the
// restart path directly, and resumeAfterTurn a repeated turn end.
// wakeMessage, monitorMessage, nextDueAt and dueAtOf are pure functions with
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
 * What makes an alarm an auto-resume: the turn a usage limit stopped, and
 * when the limit resets. An earlier version ignores the key and reads the
 * row as a plain alarm.
 */
const ResumeAlarm = Schema.Struct({
  /** The turns a usage limit stopped since the branch's last answered turn, the resumed one included. */
  attempt: Schema.Finite,
  /** The user's `wake.autoResume.maxResumes` when the resume was armed. */
  maxResumes: Schema.Finite,
  /** When the limit resets, in epoch milliseconds (`TurnAfterInput.retryAt`); the alarm is due a margin after it. */
  resetAt: Schema.Finite,
  /** The message that opened the stopped turn. A newer step on the branch when the resume fires takes its place. */
  messageId: Schema.String,
})
type ResumeAlarm = typeof ResumeAlarm.Type

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
    resume: Schema.optionalKey(ResumeAlarm),
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
    /** An auto-resume that did not run (past its cap, or past due), and when its limit resets. */
    resume: Schema.optionalKey(Schema.Struct({ resetAt: Schema.Finite })),
  },
})
export type WakeEntry = typeof WakeEntry.Type
type AlarmEntry = Extract<WakeEntry, { readonly _tag: "alarm" }>
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
  /** An auto-resume's fire: its attempt, and when the limit reset (epoch milliseconds). */
  resume: Schema.optionalKey(Schema.Struct({ attempt: Schema.Finite, resetAt: Schema.Finite })),
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

interface WakeAlarmsService {
  /** Serializes publication, installation, re-arm and cancellation; waits interruptibly, then completes the transfer. */
  readonly withLifecycle: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
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
    const lifecycle = yield* Semaphore.make(1)
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
      withLifecycle: (work) => work.pipe(Effect.uninterruptible, lifecycle.withPermits(1)),
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

// ── Firing ──

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))

export const wakeMessage = (entry: Extract<WakeEntry, { readonly _tag: "alarm" }>) =>
  `Alarm ${entry.wakeId} fired at ${isoOf(entry.dueAt)}. ${entry.note}`

const tailOf = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.length <= MONITOR_OUTPUT_TAIL_CHARS) return trimmed
  return `…${tailChars(trimmed, MONITOR_OUTPUT_TAIL_CHARS)}`
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
  ifLatest: Option.Option<MessageId> = Option.none(),
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
      yield* store.update((current) => {
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
      ...omitUndefined({ ifLatest: Option.getOrUndefined(ifLatest) }),
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
    yield* store.update(settle)
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
  const notices = (yield* store.read()).flatMap((entry) => {
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

// ── Auto-resume fire ──

/** The resume is due this long after the limit resets: a margin for the provider's clock. */
const RESUME_MARGIN_MS = 30_000
/**
 * A resume this far past due when it fires (gent was not running at the
 * reset, or the machine slept) starts no turn: no user may be present to
 * pay for it. It leaves a notice instead.
 */
const RESUME_PAST_DUE_MS = 10 * 60_000

const resumeMessage = (resume: Pick<ResumeAlarm, "resetAt">) =>
  `The usage limit reset at ${isoOf(resume.resetAt)}. Continue the task where it stopped.`

const lateResumeNotice = (entry: AlarmEntry, resume: ResumeAlarm, firedAt: number) =>
  WakeEntry.cases.notice.make({
    wakeId: entry.wakeId,
    outcome: "fired",
    firedAt,
    content: `Auto-resume skipped: the usage limit reset at ${isoOf(resume.resetAt)} while gent was not running, so the stopped task did not continue on its own.`,
    note: "auto-resume skipped: gent was not running",
    resume: { resetAt: resume.resetAt },
  })

/**
 * Fires one resume. Past due by more than `RESUME_PAST_DUE_MS`, it leaves a
 * notice in the row's place. Otherwise it queues the one resume line on a
 * condition (`ifLatest`): the loop admits it, and starts its turn, only while
 * the branch is idle, nothing waits in its queue, and the stopped turn's
 * opener is still the branch's newest step. A message the user sent, or a
 * steer they parked, since the turn stopped takes the resume's place. The
 * loop decides in the admission itself, so no send lands between a read and
 * the queue. The row goes either way.
 *
 * The fire holds the alarms' lifecycle, as a dismiss does: a dismiss that
 * comes while the line is queued waits for the fire and then finds no row,
 * so it reports that nothing was cancelled.
 */
const fireResume = Effect.fn("Wake.fireResume")(function* (entry: AlarmEntry, resume: ResumeAlarm) {
  const alarms = yield* WakeAlarms
  yield* Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const firedAt = yield* Clock.currentTimeMillis
    if (firedAt - entry.dueAt > RESUME_PAST_DUE_MS) {
      yield* Effect.logInfo("wake.resume.late").pipe(Effect.annotateLogs({ wakeId: entry.wakeId }))
      yield* store.update((current) => [
        ...dropPendingRow(entry.wakeId)(current),
        lateResumeNotice(entry, resume, firedAt),
      ])
      return yield* ctx.State.changed()
    }
    yield* queueWake(
      entry,
      resumeMessage(resume),
      {
        outcome: "fired",
        note: entry.note,
        firedAt,
        resume: { attempt: resume.attempt, resetAt: resume.resetAt },
      },
      dropPendingRow(entry.wakeId),
      Option.some(MessageId.make(resume.messageId)),
    )
    yield* ctx.State.changed()
  }).pipe(alarms.withLifecycle)
})

/** What a timer needs while it runs: the branch context, its file, and the monitor's shell. */
type WakeWorkServices =
  | ExtensionContext
  | WakeAlarms
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
      // A resume never repeats.
      if (Predicate.isNotUndefined(entry.resume)) return yield* fireResume(entry, entry.resume)
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

const matches = Effect.fn("Wake.monitorMatches")(function* (
  entry: Extract<WakeEntry, { readonly _tag: "monitor" }>,
  result: { readonly exitCode: number; readonly stdoutPieces: ReadonlyArray<string> },
) {
  const until = entry.until
  if (Predicate.isUndefined(until)) return result.exitCode === 0
  // The data, never the display: a cut display holds a marker `until` could
  // match, and a match must not span the gap between the head and the tail.
  const regex = yield* Effect.try({
    try: () => new RegExp(until),
    catch: () => new WakeError({ message: `until is not a valid regular expression: ${until}` }),
  })
  const matcher = yield* makeRegexMatcher(regex).pipe(
    Effect.mapError((cause) => new WakeError({ message: cause.message })),
  )
  const reply = yield* matcher
    .searchPieces(result.stdoutPieces)
    .pipe(Effect.mapError((cause) => new WakeError({ message: cause.message })))
  if (reply.hits.length > 0) return true
  if (reply.undecided > 0)
    return yield* new WakeError({
      message: "until matching could not decide: simplify the pattern",
    })
  return false
})

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
      // A check keeps no file: only its verdict and its output's tail reach
      // a message, and each stream's middle past the ends never reaches memory.
      const result = yield* Effect.scoped(
        runBashCommand(entry.command, Option.some(cwd), Option.none()),
      ).pipe(
        Effect.map((ran) => ({ ...ran, cut: false })),
        Effect.timeoutOrElse({
          duration: Duration.millis(budget),
          orElse: () =>
            Effect.succeed({
              exitCode: 1,
              stdout: "",
              stdoutPieces: [],
              stderr: "check still running at deadline",
              cut: true,
            }),
        }),
        Effect.catch((error) =>
          Effect.succeed({
            exitCode: 1,
            stdout: "",
            stdoutPieces: [],
            stderr: error.message,
            cut: false,
          }),
        ),
      )
      lastOutput = [result.stdout, result.stderr].filter((text) => text.length > 0).join("\n")
      let matched = false
      let cut = result.cut
      if (!cut) {
        const remaining = Math.max(0, entry.deadline - (yield* Clock.currentTimeMillis))
        const verdict = yield* Effect.scoped(matches(entry, result)).pipe(
          Effect.timeoutOption(Duration.millis(remaining)),
          Effect.catch((error) =>
            Effect.gen(function* () {
              // A slow miss may be JSC giving up. Keep the reason and settle
              // at the deadline, rather than silently retrying an unknown result.
              lastOutput = [lastOutput, error.message].join("\n")
              const left = Math.max(0, entry.deadline - (yield* Clock.currentTimeMillis))
              yield* Effect.sleep(Duration.millis(left))
              return Option.none<boolean>()
            }),
          ),
        )
        matched = Option.getOrElse(verdict, () => false)
        cut = Option.isNone(verdict)
        if (cut)
          lastOutput = [lastOutput, "until matching did not complete before deadline"].join("\n")
      }
      if (matched) {
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
      if (cut || now >= entry.deadline) {
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
  const forget = store.update(dropPendingRow(entry.wakeId)).pipe(Effect.ignore)
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
      Effect.provideService(WakeAlarms, alarms),
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
  const alarms = yield* WakeAlarms
  yield* store
    .modify((current: ReadonlyArray<WakeEntry>) =>
      Effect.gen(function* () {
        yield* Effect.logDebug("wake.rearm").pipe(Effect.annotateLogs({ pending: current.length }))
        for (const entry of current) {
          if (entry._tag !== "notice") yield* armEntry(entry)
        }
        // The file stays as read: returning it skips the write.
        return { next: current, result: current.length }
      }),
    )
    .pipe(alarms.withLifecycle)
})

const storeAndArm = Effect.fn("WakeTool.storeAndArm")(function* (entry: PendingWakeEntry) {
  const alarms = yield* WakeAlarms
  yield* Effect.gen(function* () {
    yield* store.update((current) => [...current, entry])
    yield* armEntry(entry)
  }).pipe(alarms.withLifecycle)
})

/** Drops entries from the file and interrupts their timers; returns each removed id once. */
const cancelWakes = Effect.fn("WakeTool.cancel")(function* (keep: (entry: WakeEntry) => boolean) {
  const alarms = yield* WakeAlarms
  return yield* Effect.gen(function* () {
    const removed = yield* store.modify((current: ReadonlyArray<WakeEntry>) =>
      Effect.succeed({
        next: current.filter(keep),
        // A repeating notify alarm and its unread notices share one id.
        result: [
          ...new Set(
            current
              .values()
              .filter((entry) => !keep(entry))
              .map((entry) => entry.wakeId),
          ),
        ],
      }),
    )
    // A stored entry may have no timer yet (before the loop's open re-arms it); an
    // interrupted timer leaves the file alone, which is why it is cleaned here first.
    yield* Effect.forEach(removed, (wakeId) => alarms.cancel(wakeId), { discard: true })
    return removed
  }).pipe(alarms.withLifecycle)
})

// ── Auto-resume ──

/**
 * A turn a usage limit stopped (`TurnAfterInput.retryAt`) gets one resume
 * alarm, due `RESUME_MARGIN_MS` after the reset, when the user turned it on
 * in their own config:
 *
 *     { "wake": { "autoResume": { "maxResumes": 3 } } }
 *
 * `maxResumes` (default 3) caps the resumed turns the limit stops again in a
 * row; past it the turn leaves a notice instead. Only `~/.gent/config.json`
 * counts: a resume spends the user's money, and a project file cannot.
 * A spawned session stores none: its completion carries the error to its
 * parent, which resumes on the same account. A limit that resets more than
 * 24 hours away stores none either, and so does a turn on a branch whose
 * newest client message no user watches (`MessageMetadata.unattended`, a
 * headless run): nothing is stored, so no later fire or re-arm of the branch
 * has a resume to run. The branch keeps one resume: the latest turn's, so
 * any other turn (a message the user sent, an alarm's wake) takes a pending
 * resume's place.
 */

const DEFAULT_MAX_RESUMES = 3

const AutoResumeConfig = Schema.fromJsonString(
  Schema.Struct({
    wake: Schema.optionalKey(
      Schema.Struct({
        autoResume: Schema.optionalKey(
          Schema.Struct({
            maxResumes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          }),
        ),
      }),
    ),
  }),
)

/** `wake.autoResume` from the user's own config: none when absent; a file that does not decode turns it off, with a warning. */
const readAutoResume = Effect.fn("Wake.autoResumeConfig")(function* () {
  const ctx = yield* ExtensionContext
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(ctx.home, ".gent", "config.json")
  if (!(yield* fs.exists(file))) return Option.none<{ readonly maxResumes: number }>()
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeEffect(AutoResumeConfig)),
    Effect.map((config) =>
      Option.fromUndefinedOr(config.wake?.autoResume).pipe(
        Option.map((autoResume) => ({
          maxResumes: autoResume.maxResumes ?? DEFAULT_MAX_RESUMES,
        })),
      ),
    ),
    Effect.catch((error) =>
      Effect.logWarning("wake.autoResume.config.unreadable").pipe(
        Effect.annotateLogs({ file, error: String(error) }),
        Effect.as(Option.none<{ readonly maxResumes: number }>()),
      ),
    ),
  )
})

/** A branch's messages, as `Session.getDetail` lists them. */
const branchMessages = (
  detail: {
    readonly branches: ReadonlyArray<{
      readonly branch: Branch
      readonly messages: ReadonlyArray<Message>
    }>
  },
  branchId: BranchId,
): ReadonlyArray<Message> =>
  detail.branches.find((entry) => entry.branch.id === branchId)?.messages ?? []

/** No user watches the branch's turns: its newest client message came from a headless run. */
const unattended = (messages: ReadonlyArray<Message>): boolean =>
  messages.findLast((message) => message.metadata?.fromClient === true)?.metadata?.unattended ===
  true

const isSynchronized = (event: AgentEvent) => event._tag === "StreamSynchronized"

/**
 * The turns a usage limit stopped since the branch's last answered turn,
 * read from the branch's durable events (as `delegate` reads a child's
 * end). A receipt that answered starts the count again; an interrupt, a
 * turn that gave up, or a failure that was not a usage limit neither counts
 * nor starts it again. The receipt of `messageId`'s own turn is left out, so
 * a repeated end of the same turn counts the same.
 */
const limitedSinceAnswer = Effect.fn("Wake.limitedSinceAnswer")(function* (messageId: string) {
  const ctx = yield* ExtensionContext
  const folded = yield* ctx.Session.events({
    sessionId: ctx.sessionId,
    branchId: ctx.branchId,
  }).pipe(
    Stream.takeUntil(isSynchronized),
    Stream.runFold(
      () => ({ limited: false, count: 0 }),
      (state, event) => {
        if (event._tag === "ErrorOccurred") {
          if (event.notice === true) return state
          return { ...state, limited: Predicate.isNotUndefined(event.retryAt) }
        }
        if (event._tag !== "TurnCompleted") return state
        // Each receipt closes its turn: an error before it is not the next turn's.
        if (event.messageId === messageId) return { ...state, limited: false }
        if (
          event.streamFailed !== true &&
          event.unanswered !== true &&
          event.interrupted !== true
        ) {
          return { limited: false, count: 0 }
        }
        if (event.streamFailed === true && state.limited) {
          return { limited: false, count: state.count + 1 }
        }
        return { ...state, limited: false }
      },
    ),
  )
  return folded.count
})

const capNotice = (wakeId: string, maxResumes: number, resetAt: number, firedAt: number) =>
  WakeEntry.cases.notice.make({
    wakeId,
    outcome: "fired",
    firedAt,
    content: `Auto-resume stopped after ${maxResumes} attempts: the usage limit still held. It resets at ${isoOf(resetAt)}.`,
    note: `auto-resume stopped after ${maxResumes} attempts`,
    resume: { resetAt },
  })

/**
 * What the turn leaves for the branch: a resume alarm, the cap's notice, or
 * nothing. The id names the turn's opener and the reset, so a repeat of the
 * same turn end plans the same entry.
 */
const planResume = Effect.fn("Wake.planResume")(function* (input: TurnAfterInput) {
  if (Option.isNone(input.retryAt)) return Option.none<WakeEntry>()
  const resetAt = input.retryAt.value
  const now = yield* Clock.currentTimeMillis
  if (resetAt - now > MAXIMUM_WAKE_DELAY_MS) return Option.none<WakeEntry>()
  const config = yield* readAutoResume()
  if (Option.isNone(config)) return Option.none<WakeEntry>()
  const ctx = yield* ExtensionContext
  const detail = yield* ctx.Session.getDetail(ctx.sessionId)
  if (isSpawnedSession(detail.session)) return Option.none<WakeEntry>()
  if (unattended(branchMessages(detail, ctx.branchId))) {
    yield* Effect.logInfo("wake.resume.unattended").pipe(
      Effect.annotateLogs({ messageId: input.messageId }),
    )
    return Option.none<WakeEntry>()
  }
  // This turn is one more stop.
  const attempt = (yield* limitedSinceAnswer(input.messageId)) + 1
  const { maxResumes } = config.value
  const wakeId = `resume:${input.messageId}:${resetAt}`
  if (attempt > maxResumes) return Option.some(capNotice(wakeId, maxResumes, resetAt, now))
  return Option.some<WakeEntry>(
    WakeEntry.cases.alarm.make({
      wakeId,
      dueAt: resetAt + RESUME_MARGIN_MS,
      note: "continue after the usage limit resets",
      resume: { attempt, maxResumes, resetAt, messageId: input.messageId },
    }),
  )
})

const isPendingResume = (entry: WakeEntry): entry is AlarmEntry =>
  entry._tag === "alarm" && Predicate.isNotUndefined(entry.resume)

/**
 * The branch's one resume follows its latest turn: a resume an earlier turn
 * armed leaves with its timer, and the turn's own entry is stored once, so
 * a repeat of the same turn end stores nothing new. A turn that leaves
 * nothing and finds no resume does not take the file's lock.
 */
const settleResume = Effect.fn("Wake.settleResume")(function* (planned: Option.Option<WakeEntry>) {
  if (Option.isNone(planned) && !(yield* store.read()).some(isPendingResume)) return
  const alarms = yield* WakeAlarms
  const plannedId = Option.map(planned, (entry) => entry.wakeId)
  const changed = yield* Effect.gen(function* () {
    const { superseded, added } = yield* store.modify((current: ReadonlyArray<WakeEntry>) => {
      const superseded = current
        .values()
        .filter((entry) => isPendingResume(entry) && !Option.contains(plannedId, entry.wakeId))
        .map((entry) => entry.wakeId)
        .toArray()
      const added = Option.filter(
        planned,
        (entry) => !current.some((candidate) => candidate.wakeId === entry.wakeId),
      )
      if (superseded.length === 0 && Option.isNone(added)) {
        return Effect.succeed({ next: current, result: { superseded, added } })
      }
      const kept = current.filter(
        (entry) => !isPendingResume(entry) || !superseded.includes(entry.wakeId),
      )
      return Effect.succeed({
        next: [...kept, ...Option.toArray(added)],
        result: { superseded, added },
      })
    })
    yield* Effect.forEach(superseded, (wakeId) => alarms.cancel(wakeId), { discard: true })
    if (Option.isSome(added) && added.value._tag === "alarm") yield* armEntry(added.value)
    return superseded.length > 0 || Option.isSome(added)
  }).pipe(alarms.withLifecycle)
  if (changed) yield* (yield* ExtensionContext).State.changed()
})

/** The `turnAfter` half of auto-resume: plan the turn's entry, then settle the branch's one resume. */
export const resumeAfterTurn = Effect.fn("Wake.resumeAfterTurn")(function* (input: TurnAfterInput) {
  yield* settleResume(yield* planResume(input))
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
      description: `Regular expression; when it matches the command's stdout the monitor is done. A stdout past ${wholeCommandOutputText} characters is matched on its head and on its tail, each apart.`,
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
  const entries = yield* store.read()
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
  Dismiss: request({
    id: "wake.dismiss",
    description:
      "Cancel one pending alarm or monitor on the current branch, or dismiss one unread notice, by id: what the tray shows, taken back by the user",
    answersDuringTurn: true,
    input: Schema.Struct({ wakeId: Schema.String }),
    output: Schema.Struct({ dismissed: Schema.Array(Schema.String) }),
    execute: ({ wakeId }) =>
      Effect.gen(function* () {
        const dismissed = yield* cancelWakes((entry) => entry.wakeId !== wakeId)
        if (dismissed.length > 0) yield* (yield* ExtensionContext).State.changed()
        return { dismissed }
      }),
  }),
})

// ── Extension ──

export const WakeExtension = defineExtension({
  id: WAKE_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", WakeTool, MonitorTool, CancelTool, ListTool)
    yield* host.register("request", WakeRpc.Pending, WakeRpc.Dismiss)
    yield* host.on("sessionDeleted", ({ branchIds }) => store.removeBranches(branchIds))
    // The branch resource starts without a session facade, so the loop's open
    // is where stored entries get their timers back: after a restart or a
    // branch close, as soon as anything reaches the branch, and for each new
    // build of the resource (an edit, a disable and enable), once the build
    // before it closed with its timers. A past-due alarm
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
    // A turn a usage limit stopped arms its resume; any turn ends the one before.
    yield* host.on("turnAfter", (input) =>
      resumeAfterTurn(input).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("wake.resume.arm.failed").pipe(
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
