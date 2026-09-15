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
 */
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Match,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect"
import {
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  type ExtensionServiceError,
  omitUndefined,
  request,
  tool,
} from "@gent/core/extensions/api"
import { makeBranchStateStore } from "../branch-state-store.js"
import {
  WAKE_EXTENSION_ID,
  WAKE_MESSAGE_TYPE,
  WakeDetails,
  WakeEntry,
  WakePending,
} from "./protocol.js"

export { WAKE_EXTENSION_ID, WAKE_MESSAGE_TYPE, WakeDetails, WakeEntry, WakePending }

export const MAXIMUM_WAKE_DELAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MONITOR_EVERY_SECONDS = 30
const DEFAULT_MONITOR_TIMEOUT_SECONDS = 30 * 60
const MINIMUM_MONITOR_EVERY_SECONDS = 0.1
const MONITOR_OUTPUT_TAIL_CHARS = 2_000

export class WakeError extends Schema.TaggedError<WakeError>()("WakeError", {
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
    const scope = yield* Effect.scope
    const running = yield* Ref.make<ReadonlyMap<string, Fiber.Fiber<void>>>(new Map())
    const forget = (wakeId: string) =>
      Ref.update(running, (current) => {
        const next = new Map(current)
        next.delete(wakeId)
        return next
      })
    const schedule: WakeAlarmsService["schedule"] = (wakeId, work) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(running)
        if (current.has(wakeId)) return false
        const fiber = yield* work.pipe(Effect.ensuring(forget(wakeId)), Effect.forkIn(scope))
        yield* Ref.update(running, (latest) => new Map(latest).set(wakeId, fiber))
        return true
      })
    const cancel: WakeAlarmsService["cancel"] = (wakeId) =>
      Effect.gen(function* () {
        const fiber = Option.fromUndefinedOr((yield* Ref.get(running)).get(wakeId))
        if (Option.isNone(fiber)) return false
        yield* Fiber.interrupt(fiber.value)
        return true
      })
    return WakeAlarms.of({
      schedule,
      cancel,
      pending: Ref.get(running).pipe(Effect.map((current) => [...current.keys()])),
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

/** The user-role line a fired entry queues; `wake: true` starts a turn on an idle loop. */
const queueWake = (wakeId: string, content: string, details: WakeDetails) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    yield* ctx.Session.queueFollowUp({
      sourceId: `wake:${wakeId}`,
      content,
      metadata: { customType: WAKE_MESSAGE_TYPE, extensionId: WAKE_EXTENSION_ID, details },
      wake: true,
    })
  })

const alarmWork = (
  entry: Extract<WakeEntry, { readonly _tag: "alarm" }>,
): Effect.Effect<void, ExtensionServiceError, ExtensionContext> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* Effect.logInfo("wake.armed").pipe(
      Effect.annotateLogs({ wakeId: entry.wakeId, dueInMs: entry.dueAt - now }),
    )
    yield* Effect.sleep(Duration.millis(Math.max(0, entry.dueAt - now)))
    yield* Effect.logInfo("wake.fired").pipe(Effect.annotateLogs({ wakeId: entry.wakeId }))
    yield* queueWake(entry.wakeId, wakeMessage(entry), { outcome: "fired", note: entry.note })
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
): Effect.Effect<void, ExtensionServiceError, ExtensionContext> =>
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
        return yield* queueWake(
          entry.wakeId,
          monitorMessage(entry, "matched", checks, lastOutput),
          { outcome: "matched", note: entry.note },
        )
      }
      const now = yield* Clock.currentTimeMillis
      if (now >= entry.deadline) {
        return yield* queueWake(
          entry.wakeId,
          monitorMessage(entry, "timed-out", checks, lastOutput),
          { outcome: "timed-out", note: entry.note },
        )
      }
      yield* Effect.sleep(
        Duration.millis(Math.min(entry.everySeconds * 1000, entry.deadline - now)),
      )
    }
  })

const workFor = Match.type<WakeEntry>().pipe(
  Match.tagsExhaustive({
    alarm: (entry) => alarmWork(entry),
    monitor: (entry) => monitorWork(entry),
  }),
)

/**
 * Starts the timer for one stored entry. Firing queues the wake message and
 * drops the entry from the file; an id already running is left alone.
 */
const armEntry = Effect.fn("WakeTool.arm")(function* (entry: WakeEntry) {
  const ctx = yield* ExtensionContext
  const alarms = yield* WakeAlarms
  const work = workFor(entry)
  const forget = modifyWakeEntries((current) =>
    current.filter((candidate) => candidate.wakeId !== entry.wakeId),
  ).pipe(Effect.ignore)
  return yield* alarms.schedule(
    entry.wakeId,
    work.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        return Effect.logWarning("wake.fire.failed").pipe(
          Effect.annotateLogs({ wakeId: entry.wakeId, cause: Cause.pretty(cause) }),
        )
      }),
      Effect.ensuring(forget),
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

const storeAndArm = Effect.fn("WakeTool.storeAndArm")(function* (entry: WakeEntry) {
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
  // interrupted timer would drop the entry itself, but the file is already clean.
  yield* Effect.forEach(removed, (wakeId) => alarms.cancel(wakeId), { discard: true })
  return removed
})

// ── Tools ──

export const WakeParams = Schema.Struct({
  afterSeconds: Schema.optionalKey(
    Schema.Finite.annotate({ description: "Seconds from now until the alarm fires." }),
  ),
  at: Schema.optionalKey(
    Schema.String.annotate({ description: "ISO 8601 time at which the alarm fires." }),
  ),
  note: Schema.String.annotate({
    description: "What to check when the alarm fires. Arrives verbatim in the wake message.",
  }),
})

export const WakeResult = Schema.Struct({
  wakeId: Schema.String,
  dueAt: Schema.String,
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
  ],
  params: WakeParams,
  output: WakeResult,
  execute: Effect.fn("WakeTool.execute")(function* (params: typeof WakeParams.Type) {
    const ctx = yield* ExtensionContext
    const now = yield* Clock.currentTimeMillis
    const dueAt = yield* dueAtOf(params, now)
    const entry = WakeEntry.cases.alarm.make({
      wakeId: yield* ctx.Process.randomId,
      dueAt,
      note: params.note,
    })
    yield* storeAndArm(entry)
    return { wakeId: entry.wakeId, dueAt: isoOf(dueAt), note: entry.note }
  }),
})

export const MonitorParams = Schema.Struct({
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
  note: Schema.String.annotate({
    description: "What to do when the monitor wakes you. Arrives verbatim in the wake message.",
  }),
})

export const MonitorResult = Schema.Struct({
  wakeId: Schema.String,
  everySeconds: Schema.Finite,
  deadline: Schema.String,
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
      ...omitUndefined({ until: params.until }),
    })
    yield* storeAndArm(entry)
    return { wakeId: entry.wakeId, everySeconds, deadline: isoOf(deadline), note: entry.note }
  }),
})

export const CancelParams = Schema.Struct({
  wakeId: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The alarm or monitor to cancel. Omit to cancel every pending one on this branch.",
    }),
  ),
})

export const CancelResult = Schema.Struct({ cancelled: Schema.Array(Schema.String) })

export const CancelTool = tool({
  id: "wake.cancel",
  readonly: true,
  description:
    "Cancel a pending alarm or monitor by wakeId, or every pending one on this branch when no id is given. Use it when the thing you were waiting for is already done.",
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

// ── Requests ──

export const WakeRpc = defineRequests(WAKE_EXTENSION_ID, {
  List: request({
    id: "wake.list",
    description: "The alarms and monitors still pending on the current branch",
    input: Schema.Struct({}),
    output: WakePending,
    execute: Effect.fn("WakeRpc.List")(function* () {
      const now = yield* Clock.currentTimeMillis
      const entries = yield* readWakeEntries()
      return { now, entries }
    }),
  }),
})

// ── Extension ──

export const WakeExtension = defineExtension({
  id: WAKE_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", WakeTool, MonitorTool, CancelTool)
    yield* host.register("request", WakeRpc.List)
    // The branch resource starts without a session facade, so the first turn
    // after a restart is where stored entries get their timers back.
    yield* host.on("turnProjection", () =>
      rearmPendingAlarms().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("wake.rearm.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
        Effect.as({}),
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
