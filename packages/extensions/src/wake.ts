import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect"
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
 * One pending wake. An alarm fires at a time, and again every `everySeconds`
 * when it repeats; a monitor runs a command on an interval and fires when it
 * succeeds, its output matches `until`, or the deadline passes.
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
  /** A `notify` fire nobody has read yet. The next turn's projection consumes it; `wake.cancel` dismisses it. */
  notice: {
    wakeId: Schema.String,
    outcome: Schema.Literals(["fired", "matched", "timed-out"]),
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
 * under `~/.gent/wakes`, so the next turn after a restart re-arms what is
 * still pending and fires at once what came due while the process was down.
 * A repeating alarm advances its stored due time on every fire; ticks missed
 * while the process was down collapse into one fire. In `notify` mode a fire
 * starts no turn: it leaves a `notice` entry in the same file, the tray shows
 * it at once, and the next turn's projection reads every notice into a prompt
 * section and clears them.
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
   * cancels it. False when work for that id is already running.
   */
  readonly schedule: (wakeId: string, work: Effect.Effect<void>) => Effect.Effect<boolean>
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
      Effect.gen(function* () {
        if (yield* FiberMap.has(running, wakeId)) return false
        yield* FiberMap.run(running, wakeId, work)
        return true
      })
    const cancel: WakeAlarmsService["cancel"] = (wakeId) =>
      Effect.gen(function* () {
        if (!(yield* FiberMap.has(running, wakeId))) return false
        yield* FiberMap.remove(running, wakeId)
        return true
      })
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
 * What a fire leaves behind. In `wake` mode a user-role line is queued with
 * `wake: true`, which starts a turn on an idle loop. In `notify` mode a notice
 * is stored beside the pending entries and the tray is pulsed; no turn starts.
 */
const queueWake = (
  entry: PendingWakeEntry,
  content: string,
  details: WakeDetails & { readonly firedAt: number },
) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    if (modeOf(entry) === "notify") {
      const notice = WakeEntry.cases.notice.make({
        wakeId: entry.wakeId,
        outcome: details.outcome,
        firedAt: details.firedAt,
        content,
        note: entry.note,
      })
      yield* modifyWakeEntries((current) => [...current, notice])
      return yield* ctx.State.changed()
    }
    yield* ctx.Session.queueFollowUp({
      sourceId: `wake:${entry.wakeId}:${details.firedAt}`,
      content,
      metadata: { customType: WAKE_MESSAGE_TYPE, extensionId: WAKE_EXTENSION_ID, details },
      wake: true,
    })
  })

/**
 * Every notice as one prompt section; none gives no section. The projection
 * runs on every step, so the section stays for the whole turn, and nothing is
 * cleared here: a turn that fails or is interrupted keeps its notices.
 */
const noticeSections = Effect.fn("WakeTool.notices")(function* () {
  const notices = (yield* readWakeEntries()).flatMap((entry) => {
    if (entry._tag === "notice") return [entry]
    return []
  })
  if (notices.length === 0) return []
  return [
    {
      id: "wake-notices",
      priority: 85,
      content: `# Notices\n\nThese fired while you were idle; nothing has answered them yet.\n\n${notices.map((notice) => `- ${notice.content}`).join("\n")}`,
    },
  ]
})

/** Drops the notices an answered turn read: those that fired before it started. A later one shows again next turn. */
const clearReadNotices = Effect.fn("WakeTool.clearNotices")(function* (turnStartedAt: number) {
  let cleared = 0
  yield* modifyWakeEntries((current) => {
    const kept = current.filter((entry) => entry._tag !== "notice" || entry.firedAt > turnStartedAt)
    cleared = current.length - kept.length
    return kept
  })
  return cleared
})

/** The first tick of a repeating alarm that is still ahead of `now`; every missed tick folds into the fire that just happened. */
export const nextDueAt = (dueAt: number, everySeconds: number, now: number): number => {
  // A stored row is not re-validated on re-arm, so the floor is applied here too.
  const every = Math.max(everySeconds, MINIMUM_REPEAT_EVERY_SECONDS) * 1000
  const missed = Math.max(0, Math.floor((now - dueAt) / every))
  return dueAt + (missed + 1) * every
}

const alarmWork: (
  entry: Extract<WakeEntry, { readonly _tag: "alarm" }>,
) => Effect.Effect<void, ExtensionServiceError | WakeError, ExtensionContext> = (entry) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* Effect.logInfo("wake.armed").pipe(
      Effect.annotateLogs({ wakeId: entry.wakeId, dueInMs: entry.dueAt - now }),
    )
    yield* Effect.sleep(Duration.millis(Math.max(0, entry.dueAt - now)))
    yield* Effect.logInfo("wake.fired").pipe(Effect.annotateLogs({ wakeId: entry.wakeId }))
    const firedAt = yield* Clock.currentTimeMillis
    yield* queueWake(entry, wakeMessage(entry), { outcome: "fired", note: entry.note, firedAt })
    if (Predicate.isUndefined(entry.everySeconds)) return
    // The next tick is stored before the timer sleeps again, so a restart in between re-arms it.
    const next = { ...entry, dueAt: nextDueAt(entry.dueAt, entry.everySeconds, firedAt) }
    yield* modifyWakeEntries((current) =>
      current.map((candidate) => {
        if (candidate.wakeId === entry.wakeId) return next
        return candidate
      }),
    )
    yield* alarmWork(next)
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
): Effect.Effect<void, ExtensionServiceError | WakeError, ExtensionContext> =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    yield* Effect.logInfo("wake.monitor.armed").pipe(
      Effect.annotateLogs({ wakeId: entry.wakeId, everySeconds: entry.everySeconds }),
    )
    let checks = 0
    let lastOutput = ""
    for (;;) {
      checks += 1
      const result = yield* ctx.Process.run("bash", ["-c", entry.command], {
        cwd: entry.cwd,
        stdin: "ignore",
      }).pipe(
        Effect.catch((error) => Effect.succeed({ exitCode: 1, stdout: "", stderr: error.message })),
      )
      lastOutput = [result.stdout, result.stderr].filter((text) => text.length > 0).join("\n")
      if (matches(entry, result)) {
        yield* Effect.logInfo("wake.monitor.matched").pipe(
          Effect.annotateLogs({ wakeId: entry.wakeId, checks }),
        )
        return yield* queueWake(entry, monitorMessage(entry, "matched", checks, lastOutput), {
          outcome: "matched",
          note: entry.note,
          firedAt: yield* Clock.currentTimeMillis,
        })
      }
      const now = yield* Clock.currentTimeMillis
      if (now >= entry.deadline) {
        return yield* queueWake(entry, monitorMessage(entry, "timed-out", checks, lastOutput), {
          outcome: "timed-out",
          note: entry.note,
          firedAt: now,
        })
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
 */
const armEntry = Effect.fn("WakeTool.arm")(function* (entry: WakeEntry) {
  if (entry._tag === "notice") return false
  const ctx = yield* ExtensionContext
  const alarms = yield* WakeAlarms
  const work = workFor(entry)
  // A notice the fire left under the same id stays; only the pending entry goes.
  const forget = modifyWakeEntries((current) =>
    current.filter((candidate) => candidate._tag === "notice" || candidate.wakeId !== entry.wakeId),
  ).pipe(Effect.ignore)
  return yield* alarms.schedule(
    entry.wakeId,
    work.pipe(
      Effect.andThen(forget),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        return Effect.logWarning("wake.fire.failed").pipe(
          Effect.annotateLogs({ wakeId: entry.wakeId, cause: Cause.pretty(cause) }),
          Effect.andThen(forget),
        )
      }),
      Effect.provideService(ExtensionContext, ctx),
    ),
  )
})

/** Re-arms every entry the file still holds; past-due alarms fire at once. */
export const rearmPendingAlarms = Effect.fn("WakeTool.rearm")(function* () {
  const pending = yield* readWakeEntries()
  yield* Effect.logDebug("wake.rearm").pipe(Effect.annotateLogs({ pending: pending.length }))
  let armed = 0
  for (const entry of pending) {
    if (yield* armEntry(entry)) armed += 1
  }
  return armed
})

const storeAndArm = Effect.fn("WakeTool.storeAndArm")(function* (entry: PendingWakeEntry) {
  yield* modifyWakeEntries((current) => [...current, entry])
  yield* armEntry(entry)
})

/** Drops entries from the file and interrupts their timers; returns the ids removed. */
const cancelWakes = Effect.fn("WakeTool.cancel")(function* (keep: (entry: WakeEntry) => boolean) {
  const alarms = yield* WakeAlarms
  let removed: ReadonlyArray<string> = []
  yield* modifyWakeEntries((current) => {
    removed = current.filter((entry) => !keep(entry)).map((entry) => entry.wakeId)
    return current.filter(keep)
  })
  // A stored entry may have no timer yet (before the first turn re-arms it); an
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

/** Resolves `afterSeconds` or `at` to an epoch-millisecond due time. */
export const dueAtOf = (
  params: Pick<typeof WakeParams.Type, "afterSeconds" | "at">,
  now: number,
): Effect.Effect<number, WakeError> => {
  const fromAfter = Option.fromUndefinedOr(params.afterSeconds).pipe(
    Option.map((seconds) => now + seconds * 1000),
  )
  const fromAt = Option.fromUndefinedOr(params.at).pipe(
    Option.flatMap((at) => DateTime.make(at)),
    Option.map(DateTime.toEpochMillis),
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
  if (dueAt.value - now > MAXIMUM_WAKE_DELAY_MS) {
    return Effect.fail(new WakeError({ message: "An alarm can be at most 24 hours away" }))
  }
  return Effect.succeed(dueAt.value)
}

export const WakeTool = tool({
  id: "wake",
  readonly: true,
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
  execute: Effect.fn("WakeTool.execute")(function* (params: typeof WakeParams.Type) {
    const ctx = yield* ExtensionContext
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
      wakeId: yield* ctx.Process.randomId,
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

const MonitorTool = tool({
  id: "monitor",
  readonly: true,
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
  execute: Effect.fn("MonitorTool.execute")(function* (params: typeof MonitorParams.Type) {
    const ctx = yield* ExtensionContext
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
    if (params.command.trim().length === 0) {
      return yield* new WakeError({ message: "command is empty" })
    }
    const deadline = now + timeoutSeconds * 1000
    // An optional key must be absent, not `undefined`, for the entry schema.
    const entry = WakeEntry.cases.monitor.make({
      wakeId: yield* ctx.Process.randomId,
      command: params.command,
      cwd: Option.getOrElse(Option.fromUndefinedOr(params.cwd), () => ctx.cwd),
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
  readonly: true,
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

const ListTool = tool({
  id: "wake.list",
  readonly: true,
  description:
    "List the alarms and monitors pending on this branch and the notices nobody has answered. Times are epoch milliseconds; compare them with `now`. Use it after a context handoff, or before you arm a wake that may already exist.",
  promptSnippet: "List pending alarms, monitors, and notices",
  params: Schema.Struct({
    wakeId: Schema.optionalKey(
      Schema.String.annotate({ description: "Show only this alarm, monitor, or notice." }),
    ),
  }),
  output: WakePending,
  execute: Effect.fn("ListTool.execute")(function* (params) {
    const pending = yield* listPending()
    return Option.match(Option.fromUndefinedOr(params.wakeId), {
      onNone: () => pending,
      onSome: (id) => ({ ...pending, entries: pending.entries.filter((e) => e.wakeId === id) }),
    })
  }),
})

// ── Requests ──

export const WakeRpc = defineRequests(WAKE_EXTENSION_ID, {
  Pending: request({
    id: "wake.pending",
    description:
      "The alarms and monitors still pending on the current branch, and the notices not yet read",
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
    // The branch resource starts without a session facade, so the first turn
    // after a restart is where stored entries get their timers back.
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        yield* rearmPendingAlarms()
        return { promptSections: yield* noticeSections() }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("wake.rearm.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            Effect.as({}),
          ),
        ),
      ),
    )
    // A turn that answered has read every notice its steps were shown.
    yield* host.on("turnAfter", (input) =>
      Effect.gen(function* () {
        if (input.interrupted || input.streamFailed) return
        const now = yield* Clock.currentTimeMillis
        const cleared = yield* clearReadNotices(now - input.durationMs)
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
        tag: WakeAlarms,
        scope: "branch",
        layer: WakeAlarmsLive,
      }),
    )
  }),
})
