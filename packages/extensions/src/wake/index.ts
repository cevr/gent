/**
 * @gent/wake — an alarm for work that finishes outside the harness.
 *
 * The model sets one when it is waiting on CI, a deploy, or a remote queue,
 * then answers and goes idle. When the alarm fires the extension queues a
 * user-role `wake` message on the same branch and wakes the loop, so the
 * next turn starts with the note the model left itself. Timers live in a
 * branch-scoped resource; the alarms themselves live in one file per branch
 * under the gent home, so the next turn after a restart re-arms what is
 * still pending and fires at once what came due while the process was down.
 */
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  type ExtensionServiceError,
  tool,
} from "@gent/core/extensions/api"

export const WAKE_EXTENSION_ID = ExtensionId.make("@gent/wake")
/** `metadata.customType` on the user-role message an alarm queues. */
export const WAKE_MESSAGE_TYPE = "wake"
export const MAXIMUM_WAKE_DELAY_MS = 24 * 60 * 60 * 1000

export class WakeError extends Schema.TaggedError<WakeError>()("WakeError", {
  message: Schema.String,
}) {}

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

export const WakeAlarm = Schema.Struct({
  wakeId: Schema.String,
  dueAt: Schema.Finite,
  note: Schema.String,
})
export type WakeAlarm = typeof WakeAlarm.Type

export interface WakeAlarmsService {
  /**
   * Forks a timer that runs `fire` at `dueAt`; the branch scope owns it.
   * False when a timer for that id is already pending.
   */
  readonly schedule: (
    alarm: WakeAlarm,
    fire: Effect.Effect<void, ExtensionServiceError>,
  ) => Effect.Effect<boolean>
  readonly pending: Effect.Effect<ReadonlyArray<WakeAlarm>>
}

export class WakeAlarms extends Context.Service<WakeAlarms, WakeAlarmsService>()(
  "@gent/extensions/src/wake/WakeAlarms",
) {}

export const WakeAlarmsLive: Layer.Layer<WakeAlarms> = Layer.effect(
  WakeAlarms,
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.asVoid))
    const alarms = yield* Ref.make<ReadonlyMap<string, WakeAlarm>>(new Map())
    const forget = (wakeId: string) =>
      Ref.update(alarms, (current) => {
        const next = new Map(current)
        next.delete(wakeId)
        return next
      })
    const schedule: WakeAlarmsService["schedule"] = (alarm, fire) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(alarms)
        if (current.has(alarm.wakeId)) return false
        yield* Ref.set(alarms, new Map(current).set(alarm.wakeId, alarm))
        const now = yield* Clock.currentTimeMillis
        yield* Effect.sleep(Duration.millis(Math.max(0, alarm.dueAt - now))).pipe(
          Effect.andThen(fire),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void
            return Effect.logWarning("wake.fire.failed").pipe(
              Effect.annotateLogs({ wakeId: alarm.wakeId, cause: Cause.pretty(cause) }),
            )
          }),
          Effect.ensuring(forget(alarm.wakeId)),
          Effect.forkIn(scope),
        )
        return true
      })
    return WakeAlarms.of({
      schedule,
      pending: Ref.get(alarms).pipe(Effect.map((current) => [...current.values()])),
    })
  }),
)

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

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))

export const wakeMessage = (alarm: WakeAlarm) =>
  `Alarm ${alarm.wakeId} fired at ${isoOf(alarm.dueAt)}. ${alarm.note}`

// ── Durable half: one file per branch ──

const codec = Schema.fromJsonString(Schema.Array(WakeAlarm))
const decode = Schema.decodeUnknownEffect(codec)
const encode = Schema.encodeSync(codec)

const wakePath = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  return {
    directory: ctx.Files.join(ctx.home, "wakes"),
    file: ctx.Files.join(ctx.home, "wakes", `${ctx.branchId}.json`),
  }
})

/** The alarms still pending on this branch; a missing file is an empty list. */
export const readAlarms = Effect.fn("WakeStore.read")(function* () {
  const ctx = yield* ExtensionContext
  const { file } = yield* wakePath
  if (!(yield* ctx.Files.exists(file))) return []
  const text = yield* ctx.Files.read(file)
  return yield* decode(text).pipe(
    Effect.mapError(
      (cause) => new WakeError({ message: `Wake file ${file} is invalid: ${cause.message}` }),
    ),
  )
})

const writeAlarms = Effect.fn("WakeStore.write")(function* (alarms: ReadonlyArray<WakeAlarm>) {
  const ctx = yield* ExtensionContext
  const { directory, file } = yield* wakePath
  yield* ctx.Files.makeDirectory(directory, { recursive: true })
  const staging = `${file}.${yield* ctx.Process.randomId}.tmp`
  yield* ctx.Files.write(staging, encode(alarms))
  yield* ctx.Files.rename(staging, file)
})

const modifyAlarms = (update: (alarms: ReadonlyArray<WakeAlarm>) => ReadonlyArray<WakeAlarm>) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const { file } = yield* wakePath
    yield* ctx.FileLock.withLock(
      file,
      Effect.gen(function* () {
        const current = yield* readAlarms()
        yield* writeAlarms(update(current))
      }),
    )
  })

/**
 * Starts the timer for one stored alarm. Firing queues the wake message and
 * drops the alarm from the file; an id already ticking is left alone.
 */
const armAlarm = Effect.fn("WakeTool.arm")(function* (alarm: WakeAlarm) {
  const ctx = yield* ExtensionContext
  const alarms = yield* WakeAlarms
  const fire = ctx.Session.queueFollowUp({
    sourceId: `wake:${alarm.wakeId}`,
    content: wakeMessage(alarm),
    metadata: {
      customType: WAKE_MESSAGE_TYPE,
      extensionId: WAKE_EXTENSION_ID,
      details: { note: alarm.note },
    },
    wake: true,
  })
  const forget = modifyAlarms((current) =>
    current.filter((entry) => entry.wakeId !== alarm.wakeId),
  ).pipe(Effect.ignore, Effect.provideService(ExtensionContext, ctx))
  return yield* alarms.schedule(alarm, fire.pipe(Effect.ensuring(forget)))
})

/** Re-arms every alarm the file still holds; past-due ones fire at once. */
export const rearmPendingAlarms = Effect.fn("WakeTool.rearm")(function* () {
  const pending = yield* readAlarms()
  let armed = 0
  for (const alarm of pending) {
    if (yield* armAlarm(alarm)) armed += 1
  }
  return armed
})

export const WakeTool = tool({
  id: "wake",
  readonly: true,
  description:
    "Set an alarm. When it fires, a wake message carrying your note starts a new turn on this branch. Use it to check on work that runs outside this session (CI, a deploy, a remote job) instead of polling.",
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
    const alarm: WakeAlarm = { wakeId: yield* ctx.Process.randomId, dueAt, note: params.note }
    yield* modifyAlarms((current) => [...current, alarm])
    yield* armAlarm(alarm)
    return { wakeId: alarm.wakeId, dueAt: isoOf(dueAt), note: alarm.note }
  }),
})

export const WakeExtension = defineExtension({
  id: WAKE_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", WakeTool)
    // The branch resource starts without a session facade, so the first turn
    // after a restart is where stored alarms get their timers back.
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
