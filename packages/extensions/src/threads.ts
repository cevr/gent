/**
 * Threads: child sessions that take rounds, built on the public extension
 * facade alone.
 *
 * A thread is the sessions that share one thread key (`sessionThread`), in
 * the order they were created; its key is its first session's id, and its
 * current session is the newest. A handoff joins its parent's thread; every
 * other create starts one. So a long-lived worker that fills its context
 * hands off and keeps its address.
 *
 * `thread.start` opens a thread: a session spawned under the starter, as the
 * starter's agent or the one it names (`worker` keeps the session prompt
 * cache). With a task, the task is its first round. `thread.send` admits one
 * round, a turn on the thread's current session, and returns the round's id
 * at admission, never its answer: a thread runs one round at a time, and only
 * the thread that started it sends to it. The `turnAfter` hook of the
 * thread's branch ends the round: it records the text, the value the thread
 * gave `thread.reply`, the turn's flags and its bill in `thread_rounds`,
 * publishes the end to the `Threads` service's subscribers, then notifies as
 * the round's `notify` says: the user reads it (`user`), a one-line message
 * wakes the starter (`starter`), or nobody is told (`none`, the service's
 * own senders). A branch's loop open reconciles what a restart left. The
 * starter's own interrupt does not stop a thread; `thread.stop` does.
 */
import {
  Clock,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  type PlatformError,
  Predicate,
  PubSub,
  Schema,
  Semaphore,
} from "effect"
import { Hex } from "effect/encoding"
import { Migrator, SqlClient } from "effect/sql"
import {
  ActorCommandId,
  AgentDefinition,
  AgentName,
  BranchId,
  defineResource,
  ExtensionContext,
  type ExtensionContextService,
  type ExtensionHostService,
  type ExtensionServiceError,
  FollowUpQueueFull,
  headChars,
  headTailChars,
  latestAssistantText,
  MessageId,
  ModelId,
  omitUndefined,
  ReasoningEffort,
  RequestId,
  type SessionReachError,
  SessionId,
  sessionThread,
  tool,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import { ChildUsage, receiptTotal, startTurnMessages, turnEnd, usageOf } from "./child-turns.js"
import { childSessionName } from "./session-names.js"

// ── the worker agent ────────────────────────────────────────────────────────

const WORKER_AGENT_NAME = AgentName.make("worker")

/**
 * The agent of a long-lived thread that takes rounds. A worker does its
 * starter's work and never orchestrates: it starts and stops no threads, runs
 * no machines and delegates nothing. It keeps `thread.reply` for a round that
 * asks for a value, and the session prompt cache (`promptCache: "session"`):
 * its rounds come minutes or an hour apart, where a one-turn child keeps
 * five minutes.
 */
const workerAgent = AgentDefinition.make({
  name: WORKER_AGENT_NAME,
  description:
    "A long-lived worker thread: takes rounds from the thread that started it, one at a time, and answers each in its final text, or with thread.reply when the round asks for a value.",
  tools: ["*", "!thread.start", "!thread.stop", "!machine.*", "!delegate.*"],
  promptCache: "session",
  systemPromptAddendum: `# Worker

You are a worker thread: a long-lived session that another session started. Each round arrives as a message, and your final text in that turn is the round's answer. When a round asks for a reply value, call thread.reply({ value }) with it before you end the turn; the last call counts.`,
})

// ── errors ──────────────────────────────────────────────────────────────────

class ThreadError extends Schema.TaggedError<ThreadError>()("ThreadError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

class ThreadStorageError extends Schema.TaggedError<ThreadStorageError>()("ThreadStorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const storageError = (message: string) => (cause: unknown) =>
  new ThreadStorageError({ message, cause })

/** Every fault behind the facade is one caller-facing error. */
const asThreadError = (what: string) =>
  Effect.mapError(
    (
      cause:
        | ExtensionServiceError
        | SessionReachError
        | PlatformError.PlatformError
        | FollowUpQueueFull
        | ThreadStorageError
        | ThreadError,
    ) => {
      if (Schema.is(ThreadError)(cause)) return cause
      return new ThreadError({ message: `${what}: ${cause.message}`, cause })
    },
  )

// ── the threads a session started ───────────────────────────────────────────

type StoredSession = Effect.Success<
  ReturnType<ExtensionContextService["Session"]["listSessions"]>
>[number]

type ActiveLoop = Effect.Success<ExtensionContextService["Session"]["listActiveLoops"]>[number]

/** A loop that is doing work: any state but idle. A state that was not read counts as idle. */
const isWorking = (loop: ActiveLoop): boolean =>
  Option.exists(loop.status, (status) => status !== "Idle")

const byCreation = (left: StoredSession, right: StoredSession): number =>
  left.createdAt.getTime() - right.createdAt.getTime() || Order.String(left.id, right.id)

/** One thread a session started, as the thread tools read it. */
interface StartedThread {
  readonly thread: SessionId
  /** Oldest first. */
  readonly sessions: ReadonlyArray<StoredSession>
  /** The newest session: the one a round goes to. */
  readonly current: StoredSession
  /** The loops of the thread's sessions that work now. */
  readonly working: ReadonlyArray<ActiveLoop>
}

/**
 * The threads the thread `starter` started: the threads whose first session
 * any session of `starter` spawned. A thread is one conversation over its
 * sessions, so after a handoff the newer session owns what the older one
 * started, and the older one sees what the newer one starts. A handoff
 * continues its own thread, so it is not one. `sessions` is the starter
 * thread's tree (`listSessions({ thread })`), which holds every session in
 * question.
 */
const threadsStartedBy = (
  starter: SessionId,
  sessions: ReadonlyArray<StoredSession>,
): ReadonlyArray<{
  readonly thread: SessionId
  readonly sessions: ReadonlyArray<StoredSession>
}> => {
  const byThread = new Map<SessionId, Array<StoredSession>>()
  for (const session of sessions) {
    const key = sessionThread(session)
    byThread.set(key, [...(byThread.get(key) ?? []), session])
  }
  const starters = new Set<string>((byThread.get(starter) ?? []).map((session) => session.id))
  return [...byThread].flatMap(([thread, members]) => {
    const first = members.find((session) => session.id === thread)
    if (Predicate.isUndefined(first?.parentSessionId) || !starters.has(first.parentSessionId)) {
      return []
    }
    return [{ thread, sessions: members.toSorted(byCreation) }]
  })
}

/** The caller's thread key: the thread its session belongs to. */
const callerThread = Effect.fn("Threads.callerThread")(function* () {
  const ctx = yield* ExtensionContext
  const caller = yield* ctx.Session.getSession(ctx.sessionId)
  return Option.getOrElse(
    Option.map(Option.fromUndefinedOr(caller), sessionThread),
    () => ctx.sessionId,
  )
})

/**
 * The threads this session's thread started, wherever in the thread the
 * caller is. The host reads the thread's sessions by its key, and what is
 * below them, so a deleted first session (whose handoffs stay) loses none.
 */
const startedThreads = Effect.fn("Threads.startedThreads")(function* () {
  const ctx = yield* ExtensionContext
  const sessions = yield* ctx.Session.listSessions({ thread: ctx.sessionId })
  const caller = sessions.find((session) => session.id === ctx.sessionId)
  const thread = Option.getOrElse(
    Option.map(Option.fromUndefinedOr(caller), sessionThread),
    () => ctx.sessionId,
  )
  const loops = yield* ctx.Session.listActiveLoops
  return threadsStartedBy(thread, sessions).flatMap((found): ReadonlyArray<StartedThread> => {
    const current = found.sessions.at(-1)
    if (Predicate.isUndefined(current)) return []
    const members = new Set<SessionId>(found.sessions.map((session) => session.id))
    const working = loops.filter((loop) => members.has(loop.sessionId) && isWorking(loop))
    return [{ ...found, current, working }]
  })
})

/** The thread this session's thread started with that key, or a failure that says it is not one. */
const ownThread = Effect.fn("Threads.ownThread")(function* (thread: string) {
  const found = (yield* startedThreads()).find((entry) => entry.thread === thread)
  if (Predicate.isUndefined(found)) {
    return yield* new ThreadError({
      message: `${thread} is not a thread started by this session's thread; thread.list shows them`,
    })
  }
  return found
})

/** The branch a round to the thread goes to: its current session's active branch. */
const currentPlace = (found: StartedThread) =>
  Option.map(Option.fromUndefinedOr(found.current.activeBranchId), (branchId) => ({
    sessionId: found.current.id,
    branchId,
  }))

// ── round storage ───────────────────────────────────────────────────────────

/**
 * Who hears a round's end. `user`: the user reads it in the thread, and
 * nothing reaches the starter. `starter`: a one-line message wakes the
 * starter. `none`: nobody is told; the end is recorded and published on
 * `Threads.subscribeRoundEnds`, for a sender that is not a model turn.
 */
const RoundNotify = Schema.Literals(["user", "starter", "none"])
type RoundNotify = typeof RoundNotify.Type

/** The modes a tool call picks; `none` belongs to the service's own senders. */
const ToolNotify = Schema.Literals(["user", "starter"]).annotate({
  description:
    "`user` (default): the user reads the round in the thread, and nothing comes back to you. `starter`: the round's end wakes you with a one-line summary; thread.round reads its text and reply.",
})

/**
 * One round. `thread` is the thread's key, and `session_id` and `branch_id`
 * the session it ran on, the thread's current one when it was sent. The
 * starter is the session and branch that sent it and their thread, which a
 * round's end reaches after a handoff. `reply_spec` is the value the round
 * asked for and `reply_json` the last `thread.reply`. `stopped_at` is set by
 * a `thread.stop` that closed the round. The end fields are NULL while the
 * round is open; the flags are 0 or 1. `wake_session_id` and
 * `wake_branch_id` are where a `starter` round's end wakes its starter,
 * saved before the wake is sent, so a second delivery goes where the first
 * one went.
 */
const RoundRow = Schema.Struct({
  round: Schema.String,
  thread: Schema.String,
  number: Schema.Finite,
  starter_session_id: Schema.String,
  starter_branch_id: Schema.String,
  starter_thread: Schema.String,
  session_id: Schema.String,
  branch_id: Schema.String,
  message_id: Schema.String,
  content: Schema.String,
  reply_spec: Schema.NullOr(Schema.String),
  notify: RoundNotify,
  started_at: Schema.Finite,
  stopped_at: Schema.NullOr(Schema.Finite),
  ended_at: Schema.NullOr(Schema.Finite),
  text: Schema.NullOr(Schema.String),
  reply_json: Schema.NullOr(Schema.String),
  interrupted: Schema.Finite,
  stream_failed: Schema.Finite,
  unanswered: Schema.Finite,
  error: Schema.NullOr(Schema.String),
  usage_json: Schema.NullOr(Schema.String),
  wake_session_id: Schema.NullOr(Schema.String),
  wake_branch_id: Schema.NullOr(Schema.String),
  delivered_at: Schema.NullOr(Schema.Finite),
})
type RoundRow = typeof RoundRow.Type

/** What a round's end records. */
interface RoundEnd {
  readonly text: string
  readonly interrupted: boolean
  readonly streamFailed: boolean
  readonly unanswered: boolean
  readonly error: Option.Option<string>
  readonly usage: Option.Option<typeof ChildUsage.Type>
  readonly endedAt: number
}

/**
 * A send's claim on its thread: its own round, `fresh` when this claim
 * inserted it and false on a retry; the open round that refuses it; or the
 * busy threads of a starter thread at its cap.
 */
const RoundClaim = Schema.TaggedUnion({
  Ready: { round: RoundRow, fresh: Schema.Boolean },
  Busy: { round: RoundRow },
  OverCap: { threads: Schema.Array(Schema.String) },
})
type RoundClaim = typeof RoundClaim.Type

interface NewRound {
  readonly round: string
  /** The most threads with an open round the starter's thread may have. */
  readonly cap: number
  readonly thread: SessionId
  readonly starter: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly thread: SessionId
  }
  readonly place: { readonly sessionId: SessionId; readonly branchId: BranchId }
  readonly messageId: MessageId
  readonly content: (number: number) => string
  readonly replySpec: Option.Option<string>
  readonly notify: RoundNotify
  readonly startedAt: number
}

/** A round's end, as `Threads.subscribeRoundEnds` publishes it once it is recorded. */
interface RoundEnded {
  readonly round: string
  readonly thread: string
  readonly number: number
  readonly notify: RoundNotify
}

const UsageJson = Schema.fromJsonString(ChildUsage)
const encodeUsage = Schema.encodeEffect(UsageJson)
const decodeUsage = Schema.decodeUnknownOption(UsageJson)
const ReplyJson = Schema.fromJsonString(Schema.Json)
const encodeReply = Schema.encodeEffect(ReplyJson)
const decodeReply = Schema.decodeUnknownOption(ReplyJson)

const flag = (raised: boolean) => {
  if (raised) return 1
  return 0
}

interface ThreadRoundsService {
  readonly round: (round: string) => Effect.Effect<Option.Option<RoundRow>, ThreadStorageError>
  readonly openRound: (thread: string) => Effect.Effect<Option.Option<RoundRow>, ThreadStorageError>
  /** The open round on one session's branch: the round a `thread.reply` there answers. */
  readonly openRoundAt: (place: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<Option.Option<RoundRow>, ThreadStorageError>
  /** The threads with an open round that one starter thread sent. */
  readonly busyThreads: (
    starterThread: SessionId,
  ) => Effect.Effect<ReadonlyArray<string>, ThreadStorageError>
  /**
   * In one transaction: the round itself on a retry, else refused when the
   * thread is busy or the starter's thread is at its cap, else inserted.
   */
  readonly claimRound: (round: NewRound) => Effect.Effect<RoundClaim, ThreadStorageError>
  /** Keeps the value on the open round; a round that ended keeps the one it had. */
  readonly recordReply: (round: string, json: string) => Effect.Effect<boolean, ThreadStorageError>
  /** Records the end once: the first writer wins, a later one changes nothing. */
  readonly endRound: (round: string, end: RoundEnd) => Effect.Effect<void, ThreadStorageError>
  readonly markStopped: (round: string, at: number) => Effect.Effect<void, ThreadStorageError>
  /** Saves where the end wakes the starter; the first writer wins. Returns the saved place. */
  readonly saveWakeTarget: (
    round: string,
    place: { readonly sessionId: SessionId; readonly branchId: BranchId },
  ) => Effect.Effect<
    Option.Option<{ readonly sessionId: SessionId; readonly branchId: BranchId }>,
    ThreadStorageError
  >
  /** True for the one writer that marked it: that writer publishes the end. */
  readonly markDelivered: (round: string, at: number) => Effect.Effect<boolean, ThreadStorageError>
  /** The rounds a branch owes or is owed: undelivered, sent by its thread or run on it. */
  readonly pendingAt: (place: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly thread: SessionId
  }) => Effect.Effect<ReadonlyArray<RoundRow>, ThreadStorageError>
  /** Drops a round that is still open: its turn was refused, so it never ran. */
  readonly releaseRound: (round: string) => Effect.Effect<void, ThreadStorageError>
  /**
   * Drops the rounds a deleted session ran. A round it sent stays: the
   * starter's thread owns it, and its handoffs still read and hear it. A
   * deleted thread's own threads go with it, spawned below it, and their
   * rounds with them.
   */
  readonly removeSession: (sessionId: SessionId) => Effect.Effect<void, ThreadStorageError>
  /** Every round end this server marks, in order. In memory: a restart starts it empty. */
  readonly ended: PubSub.PubSub<RoundEnded>
  /**
   * One admission at a time in this server: the cap check and the start's
   * session it guards are one step, so a start past the cap makes no session.
   */
  readonly admissions: Semaphore.Semaphore
}

/**
 * The round table, in the server's database. Threads run their own
 * migrations, recorded in their own table (`thread_migrations`), as the cell
 * does, so their ids never meet core's chain. The table first shipped
 * without a ledger, on an unreleased branch, so the first migration drops a
 * table that build left and creates it whole. A later migration must be
 * additive: a server that still runs the code before it reads the same table.
 */
const threadRoundsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* Effect.forEach(
    [
      `DROP TABLE IF EXISTS thread_rounds`,
      `CREATE TABLE thread_rounds (
        round TEXT PRIMARY KEY,
        thread TEXT NOT NULL,
        number INTEGER NOT NULL,
        starter_session_id TEXT NOT NULL,
        starter_branch_id TEXT NOT NULL,
        starter_thread TEXT NOT NULL,
        session_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        reply_spec TEXT,
        notify TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER,
        ended_at INTEGER,
        text TEXT,
        reply_json TEXT,
        interrupted INTEGER NOT NULL DEFAULT 0,
        stream_failed INTEGER NOT NULL DEFAULT 0,
        unanswered INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        usage_json TEXT,
        wake_session_id TEXT,
        wake_branch_id TEXT,
        delivered_at INTEGER
      )`,
      `CREATE INDEX thread_rounds_by_thread ON thread_rounds (thread, ended_at)`,
      `CREATE INDEX thread_rounds_open_at ON thread_rounds (session_id, branch_id) WHERE ended_at IS NULL`,
      `CREATE INDEX thread_rounds_open_by_starter ON thread_rounds (starter_thread) WHERE ended_at IS NULL`,
      `CREATE INDEX thread_rounds_undelivered ON thread_rounds (starter_thread) WHERE delivered_at IS NULL`,
    ],
    (statement) => sql.unsafe(statement),
    { discard: true },
  )
})

/**
 * Runs the migrations the database has not recorded, in one transaction. A
 * run that finds another one recording the same ids treats them as done, so
 * the builds of two places over one database are safe.
 */
const migrateThreadRounds = Migrator.make({})({
  loader: Migrator.fromRecord({ "1_thread_rounds": threadRoundsMigration }),
  table: "thread_migrations",
}).pipe(Effect.mapError(storageError("Thread table migration failed")))

/**
 * The `thread_rounds` table, the feed of round ends and the admission permit.
 * Building it runs the migrations it lacks. It is a server resource: a thread
 * started with `cwd` runs in another place than its starter, and its round's
 * sender and end must meet one feed and one permit.
 */
class ThreadRounds extends Context.Service<ThreadRounds, ThreadRoundsService>()(
  "@gent/extensions/src/threads/ThreadRounds",
) {
  static Live: Layer.Layer<ThreadRounds, ThreadStorageError, SqlClient.SqlClient> = Layer.effect(
    ThreadRounds,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const ended = yield* PubSub.unbounded<RoundEnded>()
      const admissions = yield* Semaphore.make(1)
      yield* migrateThreadRounds

      const selectRound = Effect.fn("ThreadRounds.selectRound")(function* (round: string) {
        const rows =
          yield* sql<RoundRow>`SELECT * FROM thread_rounds WHERE round = ${round} LIMIT 1`
        return Option.fromNullishOr(rows[0])
      })
      const selectOpenRound = Effect.fn("ThreadRounds.selectOpenRound")(function* (thread: string) {
        const rows = yield* sql<RoundRow>`
          SELECT * FROM thread_rounds WHERE thread = ${thread} AND ended_at IS NULL
          ORDER BY number DESC LIMIT 1
        `
        return Option.fromNullishOr(rows[0])
      })

      const selectBusyThreads = Effect.fn("ThreadRounds.selectBusyThreads")(function* (
        starterThread: string,
      ) {
        const rows = yield* sql<{ readonly thread: string }>`
          SELECT DISTINCT thread FROM thread_rounds
          WHERE starter_thread = ${starterThread} AND ended_at IS NULL
        `
        return rows.map((row) => row.thread)
      })

      return ThreadRounds.of({
        round: Effect.fn("ThreadRounds.round")(
          function* (round) {
            return yield* selectRound(round)
          },
          Effect.mapError(storageError("Failed to read the round")),
        ),

        openRound: Effect.fn("ThreadRounds.openRound")(
          function* (thread) {
            return yield* selectOpenRound(thread)
          },
          Effect.mapError(storageError("Failed to read the open round")),
        ),

        openRoundAt: Effect.fn("ThreadRounds.openRoundAt")(
          function* (place) {
            const rows = yield* sql<RoundRow>`
              SELECT * FROM thread_rounds
              WHERE session_id = ${place.sessionId} AND branch_id = ${place.branchId}
                AND ended_at IS NULL
              ORDER BY started_at DESC LIMIT 1
            `
            return Option.fromNullishOr(rows[0])
          },
          Effect.mapError(storageError("Failed to read the open round")),
        ),

        busyThreads: Effect.fn("ThreadRounds.busyThreads")(
          function* (starterThread) {
            return yield* selectBusyThreads(starterThread)
          },
          Effect.mapError(storageError("Failed to count the busy threads")),
        ),

        claimRound: Effect.fn("ThreadRounds.claimRound")(
          function* (input) {
            return yield* Effect.gen(function* () {
              const retry = yield* selectRound(input.round)
              if (Option.isSome(retry)) {
                return RoundClaim.cases.Ready.make({ round: retry.value, fresh: false })
              }
              const open = yield* selectOpenRound(input.thread)
              if (Option.isSome(open)) return RoundClaim.cases.Busy.make({ round: open.value })
              const busy = yield* selectBusyThreads(input.starter.thread)
              if (busy.length >= input.cap) return RoundClaim.cases.OverCap.make({ threads: busy })
              const counted = yield* sql<{
                readonly rounds: number
              }>`SELECT COUNT(*) AS rounds FROM thread_rounds WHERE thread = ${input.thread}`
              const number =
                Option.getOrElse(
                  Option.map(Option.fromNullishOr(counted[0]), (row) => row.rounds),
                  () => 0,
                ) + 1
              yield* sql`
                INSERT INTO thread_rounds (
                  round, thread, number, starter_session_id, starter_branch_id, starter_thread,
                  session_id, branch_id, message_id, content, reply_spec, notify, started_at
                ) VALUES (
                  ${input.round}, ${input.thread}, ${number}, ${input.starter.sessionId},
                  ${input.starter.branchId}, ${input.starter.thread}, ${input.place.sessionId},
                  ${input.place.branchId}, ${input.messageId}, ${input.content(number)},
                  ${Option.getOrNull(input.replySpec)}, ${input.notify}, ${input.startedAt}
                )
              `
              const inserted = yield* selectRound(input.round)
              return yield* Option.match(inserted, {
                onNone: () => Effect.die("an inserted round reads back"),
                onSome: (round) =>
                  Effect.succeed(RoundClaim.cases.Ready.make({ round, fresh: true })),
              })
            }).pipe(sql.withTransaction)
          },
          Effect.mapError(storageError("Failed to admit the round")),
        ),

        recordReply: Effect.fn("ThreadRounds.recordReply")(
          function* (round, json) {
            const rows = yield* sql<{ readonly round: string }>`
              UPDATE thread_rounds SET reply_json = ${json}
              WHERE round = ${round} AND ended_at IS NULL
              RETURNING round
            `
            return rows.length > 0
          },
          Effect.mapError(storageError("Failed to record the reply")),
        ),

        endRound: Effect.fn("ThreadRounds.endRound")(
          function* (round, end) {
            const usage = yield* Option.match(end.usage, {
              onNone: () => Effect.succeed(Option.none<string>()),
              onSome: (value) => Effect.asSome(encodeUsage(value)),
            })
            yield* sql`
              UPDATE thread_rounds
              SET ended_at = ${end.endedAt},
                  text = ${end.text},
                  interrupted = ${flag(end.interrupted)},
                  stream_failed = ${flag(end.streamFailed)},
                  unanswered = ${flag(end.unanswered)},
                  error = ${Option.getOrNull(end.error)},
                  usage_json = ${Option.getOrNull(usage)}
              WHERE round = ${round} AND ended_at IS NULL
            `
          },
          Effect.mapError(storageError("Failed to record the round's end")),
        ),

        markStopped: Effect.fn("ThreadRounds.markStopped")(
          function* (round, at) {
            yield* sql`
              UPDATE thread_rounds SET stopped_at = ${at}
              WHERE round = ${round} AND stopped_at IS NULL
            `
          },
          Effect.mapError(storageError("Failed to mark the round stopped")),
        ),

        saveWakeTarget: Effect.fn("ThreadRounds.saveWakeTarget")(
          function* (round, place) {
            yield* sql`
              UPDATE thread_rounds
              SET wake_session_id = ${place.sessionId}, wake_branch_id = ${place.branchId}
              WHERE round = ${round} AND wake_session_id IS NULL
            `
            return Option.flatMap(yield* selectRound(round), wakeTargetOf)
          },
          Effect.mapError(storageError("Failed to save the wake target")),
        ),

        markDelivered: Effect.fn("ThreadRounds.markDelivered")(
          function* (round, at) {
            const rows = yield* sql<{ readonly round: string }>`
              UPDATE thread_rounds SET delivered_at = ${at}
              WHERE round = ${round} AND delivered_at IS NULL
              RETURNING round
            `
            return rows.length > 0
          },
          Effect.mapError(storageError("Failed to mark the round delivered")),
        ),

        pendingAt: Effect.fn("ThreadRounds.pendingAt")(
          function* (place) {
            return yield* sql<RoundRow>`
              SELECT * FROM thread_rounds
              WHERE delivered_at IS NULL
                AND (
                  starter_thread = ${place.thread}
                  OR (session_id = ${place.sessionId} AND branch_id = ${place.branchId})
                )
              ORDER BY started_at, round
            `
          },
          Effect.mapError(storageError("Failed to read the pending rounds")),
        ),

        releaseRound: Effect.fn("ThreadRounds.releaseRound")(
          function* (round) {
            yield* sql`DELETE FROM thread_rounds WHERE round = ${round} AND ended_at IS NULL`
          },
          Effect.mapError(storageError("Failed to release the round")),
        ),

        removeSession: Effect.fn("ThreadRounds.removeSession")(
          function* (sessionId) {
            yield* sql`
              DELETE FROM thread_rounds WHERE session_id = ${sessionId}
            `
          },
          Effect.mapError(storageError("Failed to remove the session's rounds")),
        ),

        ended,
        admissions,
      })
    }),
  )
}

// ── ids ─────────────────────────────────────────────────────────────────────

/**
 * The hex SHA-256 of a call's whole identity: the calling session, its
 * branch, and its key (a tool call id). A tool call id is unique only in its
 * session, and a round's message id is unique across every session.
 */
const identityDigest = Effect.fn("Threads.identityDigest")(function* (kind: string, key: string) {
  const ctx = yield* ExtensionContext
  const crypto = yield* Crypto.Crypto
  const identity = [kind, ctx.sessionId, ctx.branchId, key].join("\n")
  return Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(identity)))
})

/** The host-owned tool call, which makes a start or a send durable-once. */
const requireToolCall = Effect.fn("Threads.requireToolCall")(function* (operation: string) {
  const ctx = yield* ExtensionContext
  if (Predicate.isUndefined(ctx.toolCallId)) {
    return yield* new ThreadError({ message: `${operation} requires a host-owned tool call` })
  }
  return ctx.toolCallId
})

/** The message that opens a round's turn on the thread; the turn's command id is the same. */
const roundMessageId = (round: string) => MessageId.make(`thread-round:${round}`)

/** The follow-up source of a round's end: the starter's message id derives from it. */
const roundEndSourceId = (round: string) => `thread-round-end:${round}`

// ── rounds ──────────────────────────────────────────────────────────────────

/** `metadata.customType` on a round's message: an agent wrote it, not a person. */
export const THREAD_ROUND_TYPE = "thread-round"

/** `metadata.customType` on the message that wakes a starter at a round's end. */
export const THREAD_ROUND_END_TYPE = "thread-round-end"

/**
 * Running threads one thread may have, over all its sessions: threads with
 * an open round. The user's own config sets another cap:
 *
 *     { "threads": { "maxRunning": 8 } }
 *
 * Only `~/.gent/config.json` counts: each running thread spends the user's
 * money, and a project file cannot.
 */
const DEFAULT_MAX_RUNNING_THREADS = 4

const ThreadsConfig = Schema.fromJsonString(
  Schema.Struct({
    threads: Schema.optionalKey(
      Schema.Struct({
        maxRunning: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      }),
    ),
  }),
)

/** The cap from the user's own config, else the default; a file that does not decode keeps the default, with a warning. */
const runningCap = Effect.fn("Threads.runningCap")(function* () {
  const ctx = yield* ExtensionContext
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(ctx.home, ".gent", "config.json")
  if (!(yield* fs.exists(file))) return DEFAULT_MAX_RUNNING_THREADS
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeEffect(ThreadsConfig)),
    Effect.map((config) => config.threads?.maxRunning ?? DEFAULT_MAX_RUNNING_THREADS),
    Effect.catch((error) =>
      Effect.logWarning("threads.config.unreadable").pipe(
        Effect.annotateLogs({ file, error: String(error) }),
        Effect.as(DEFAULT_MAX_RUNNING_THREADS),
      ),
    ),
  )
})

/** A thread that loops on a broken model stops here, as a delegate child does. */
const THREAD_MAX_MODEL_ATTEMPTS = 32

/** A round's preview in the wake line; the whole text is `thread.round`'s. */
const maximumPreviewChars = 240

/** The error a round ended on, as one bounded line. */
const maximumErrorChars = 400

const oneLine = (text: string, limit: number) => {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= limit) return line
  return `${headChars(line, limit - 1)}…`
}

const ROUND_PREFIX = "Round "

/** Where a round's answer goes, in words the thread's model reads. */
const answerLine = (notify: RoundNotify) => {
  if (notify === "user") {
    return "The user reads your replies in this thread; nothing you write returns to that session, so do not report to it with session.send. When you are blocked, end your turn with your question: the user answers here."
  }
  return "Your final text in this turn is the round's answer, and it goes back to that session; do not send it with session.send."
}

/**
 * A round's message: a line that says where it came from and where its
 * answer goes, a blank line, the starter's words, and the value it asks for
 * when it asks for one. Without the line, a session a parent spawned reads
 * the sessions section and reports to its parent with session.send.
 */
export const threadRoundText = (input: {
  readonly number: number
  readonly starter: SessionId
  readonly message: string
  readonly reply: Option.Option<string>
  readonly notify: RoundNotify
}) =>
  [
    `${ROUND_PREFIX}${input.number} from session ${input.starter}. ${answerLine(input.notify)}`,
    "",
    input.message,
    ...Option.match(input.reply, {
      onNone: () => [],
      onSome: (spec) => [
        "",
        "---",
        `This round asks for a reply value: ${spec}`,
        "Call thread.reply({ value }) with it before you end your turn; the last call counts.",
      ],
    }),
  ].join("\n")

/** A round's message without its source line, as a transcript shows it; any other text is returned whole. */
export const threadRoundBody = (text: string): string =>
  Option.liftPredicate(text, (value) => value.startsWith(ROUND_PREFIX)).pipe(
    Option.flatMap((value) =>
      Option.liftPredicate(value.indexOf("\n\n"), (split) => split !== -1).pipe(
        Option.map((split) => value.slice(split + 2)),
      ),
    ),
    Option.getOrElse(() => text),
  )

/** How a round ended badly, in words a model reads; none for one that completed. */
const failureNames = (round: RoundRow): ReadonlyArray<string> => {
  const names: Array<string> = []
  if (round.interrupted === 1) names.push("interrupted")
  if (round.stream_failed === 1) names.push("model stream failed")
  if (round.unanswered === 1) names.push("no answer produced")
  return names
}

const outcomeWords = (round: RoundRow) => {
  const failures = failureNames(round)
  if (failures.length === 0) return "completed"
  return `ended (${failures.join(", ")})`
}

const replyWords = (round: RoundRow) => {
  if (Predicate.isNull(round.reply_spec)) return ""
  if (Predicate.isNotNull(round.reply_json)) return "; reply recorded"
  return "; no reply: the round asked for one and the thread never called thread.reply"
}

/** The one line that wakes a round's starter. */
const roundEndLine = (round: RoundRow) => {
  const parts = [
    `Thread ${round.thread} round ${round.number} ${outcomeWords(round)}${replyWords(round)}.`,
    `thread.round({ round: "${round.round}" }) returns its text and reply.`,
  ]
  const error = Option.filter(Option.fromNullishOr(round.error), (text) => text.length > 0)
  if (Option.isSome(error)) parts.push(`Error: ${error.value}`)
  const preview = oneLine(
    Option.getOrElse(Option.fromNullishOr(round.text), () => ""),
    maximumPreviewChars,
  )
  if (preview.length > 0) parts.push(`It begins: ${preview}`)
  return parts.join(" ")
}

/** Admits (or re-sends) a round's turn on the thread. A repeat admits nothing new. */
const sendRoundTurn = Effect.fn("Threads.sendRoundTurn")(function* (round: RoundRow) {
  const ctx = yield* ExtensionContext
  yield* ctx.Session.send({
    delivery: "turn",
    sessionId: SessionId.make(round.session_id),
    branchId: BranchId.make(round.branch_id),
    content: round.content,
    commandId: ActorCommandId.make(round.message_id),
    completion: "admission",
    metadata: {
      customType: THREAD_ROUND_TYPE,
      details: {
        round: round.round,
        thread: round.thread,
        number: round.number,
        createdBy: "agent",
        starter: round.starter_session_id,
      },
    },
  })
})

/**
 * Sends a claimed round's turn. Only a full queue proves the turn is out of
 * the thread's loop (`FollowUpQueueFull`), and the loop keeps that reply
 * under the round's command id, so a repeat is refused the same way: the
 * round goes with it, since an open round with no turn would hold the thread
 * busy and take a place under the cap until a stop. Any other failure proves
 * nothing (a reply lost after the loop admitted the turn, a concurrent repeat
 * of the request refused as already processing): the round stays, its turn's
 * end records it, and a retry or the starter's reconcile sends a turn that
 * never arrived.
 */
const sendClaimedRound = Effect.fn("Threads.sendClaimedRound")(function* (round: RoundRow) {
  const rounds = yield* ThreadRounds
  yield* sendRoundTurn(round).pipe(
    Effect.tapError((error) => {
      if (!Schema.is(FollowUpQueueFull)(error)) return Effect.void
      return rounds.releaseRound(round.round)
    }),
  )
})

/** The thread branch's messages, from the session detail. */
const branchMessages = Effect.fn("Threads.branchMessages")(function* (round: RoundRow) {
  const ctx = yield* ExtensionContext
  const detail = yield* ctx.Session.getDetail(SessionId.make(round.session_id))
  const branch = detail.branches.find((current) => current.branch.id === round.branch_id)
  return branch?.messages ?? []
})

/** The round's message is on the thread's branch: its turn was admitted. */
const admitted = Effect.fn("Threads.admitted")(function* (round: RoundRow) {
  const messages = yield* branchMessages(round)
  return messages.some((message) => message.id === round.message_id)
})

/** The place a round's end wakes, once one was saved. */
const wakeTargetOf = (round: RoundRow) =>
  Option.map(
    Option.all({
      sessionId: Option.fromNullishOr(round.wake_session_id),
      branchId: Option.fromNullishOr(round.wake_branch_id),
    }),
    (place) => ({
      sessionId: SessionId.make(place.sessionId),
      branchId: BranchId.make(place.branchId),
    }),
  )

/**
 * Where a round's end wakes its starter: the starter thread's current
 * session, so a starter that handed off reads it in its new session, also
 * once the session that sent it is deleted. The branch is the one that sent
 * the round while that session is still current.
 */
const starterPlace = Effect.fn("Threads.starterPlace")(function* (round: RoundRow) {
  const ctx = yield* ExtensionContext
  const sent = {
    sessionId: SessionId.make(round.starter_session_id),
    branchId: BranchId.make(round.starter_branch_id),
  }
  const tree = yield* ctx.Session.listSessions({ thread: sent.sessionId })
  // A deleted sender seeds no tree; its handoffs own the round, so the
  // starter thread's sessions are read from the workspace by their key.
  let sessions = tree
  if (tree.length === 0) sessions = yield* ctx.Session.listSessions()
  const newest = sessions
    .filter((session) => sessionThread(session) === round.starter_thread)
    .toSorted(byCreation)
    .at(-1)
  if (Predicate.isUndefined(newest) || newest.id === sent.sessionId) return sent
  return Option.getOrElse(
    Option.map(Option.fromUndefinedOr(newest.activeBranchId), (branchId) => ({
      sessionId: newest.id,
      branchId,
    })),
    () => sent,
  )
})

/**
 * The place a round's end wakes, saved before the first wake is sent. The
 * wake's message id derives from its source id and the place it lands, so a
 * delivery after a crash and a handoff of the starter would land a second
 * wake on the handoff; the saved place sends it where the first one went.
 */
const wakeTarget = Effect.fn("Threads.wakeTarget")(function* (round: RoundRow) {
  const rounds = yield* ThreadRounds
  const saved = wakeTargetOf(round)
  if (Option.isSome(saved)) return saved.value
  const place = yield* starterPlace(round)
  return Option.getOrElse(yield* rounds.saveWakeTarget(round.round, place), () => place)
})

/**
 * Hands a recorded end to whoever hears it. A `starter` round wakes the
 * starter with the line, once: the message id derives from the source id
 * and the saved place, so a second delivery after a crash is a no-op. A round `thread.stop`
 * closed wakes nobody: its stopper knows. Every end is then marked
 * delivered, and the one writer that marked it publishes it.
 */
const deliverRoundEnd = Effect.fn("Threads.deliverRoundEnd")(function* (round: RoundRow) {
  const ctx = yield* ExtensionContext
  const rounds = yield* ThreadRounds
  if (round.notify === "starter" && Predicate.isNull(round.stopped_at)) {
    const place = yield* wakeTarget(round)
    yield* ctx.Session.send({
      delivery: "queue",
      ...place,
      sourceId: roundEndSourceId(round.round),
      wake: true,
      content: roundEndLine(round),
      metadata: {
        customType: THREAD_ROUND_END_TYPE,
        details: { round: round.round, thread: round.thread, number: round.number },
      },
    })
  }
  const marked = yield* rounds.markDelivered(round.round, yield* Clock.currentTimeMillis)
  if (!marked) return
  yield* PubSub.publish(rounds.ended, {
    round: round.round,
    thread: round.thread,
    number: round.number,
    notify: round.notify,
  })
})

interface TurnOutcome {
  readonly interrupted: boolean
  readonly streamFailed: boolean
  readonly unanswered: boolean
  readonly error: Option.Option<string>
  readonly usage: Option.Option<typeof ChildUsage.Type>
}

/**
 * Records a round's end and hands it on. The hook, a reconcile and a stop
 * race to write it; the first record stands, and the delivery is keyed by
 * the round, so the starter reads it once.
 */
const endRound = Effect.fn("Threads.endRound")(function* (round: RoundRow, outcome: TurnOutcome) {
  const rounds = yield* ThreadRounds
  const text = latestAssistantText(
    startTurnMessages(yield* branchMessages(round), MessageId.make(round.message_id)),
  )
  const failed = outcome.interrupted || outcome.streamFailed || outcome.unanswered
  yield* rounds.endRound(round.round, {
    ...outcome,
    text,
    error: Option.map(
      Option.filter(outcome.error, () => failed),
      (error) => oneLine(error, maximumErrorChars),
    ),
    endedAt: yield* Clock.currentTimeMillis,
  })
  const ended = yield* rounds.round(round.round)
  if (Option.isNone(ended) || Predicate.isNotNull(ended.value.delivered_at)) return
  yield* deliverRoundEnd(ended.value)
})

/** The thread's own turn receipt: the round it opened, or one joined into it, ends here. */
const onRoundTurnAfter = Effect.fn("Threads.turnAfter")(function* (input: TurnAfterInput) {
  const rounds = yield* ThreadRounds
  const round = Option.filter(
    yield* rounds.openRoundAt(input),
    (open) =>
      open.message_id === input.messageId ||
      input.joinedMessageIds.has(MessageId.make(open.message_id)),
  )
  if (Option.isNone(round)) return
  const failed = input.interrupted || input.streamFailed || input.unanswered
  // The hook runs after the receipt is stored, so the turn's error is in the
  // thread's events; a round that completed has none to read.
  let error = Option.none<string>()
  if (failed) error = Option.flatMap(yield* turnEnd(input), (end) => end.error)
  yield* endRound(round.value, {
    interrupted: input.interrupted,
    streamFailed: input.streamFailed,
    unanswered: input.unanswered,
    error,
    // A round shows the turn's total, as its receipt does: a partial count
    // would read as the whole spend.
    usage: usageOf(
      Option.map(
        Option.liftPredicate(input.usage, (usage) => usage.complete),
        (usage) => usage.known,
      ),
    ),
  })
})

/** A round a stop closed with no turn's end to read: interrupted, with no bill. */
const stoppedOutcome: TurnOutcome = {
  interrupted: true,
  streamFailed: false,
  unanswered: false,
  error: Option.none(),
  usage: Option.none(),
}

/** The round's turn as its receipt in the thread's history records it, once the turn ended. */
const recordedOutcome = Effect.fn("Threads.recordedOutcome")(function* (round: RoundRow) {
  const end = yield* turnEnd({
    sessionId: SessionId.make(round.session_id),
    branchId: BranchId.make(round.branch_id),
    messageId: MessageId.make(round.message_id),
  })
  return Option.map(end, ({ receipt, error }): TurnOutcome => ({
    interrupted: receipt.interrupted === true,
    streamFailed: receipt.streamFailed === true,
    unanswered: receipt.unanswered === true,
    error,
    usage: usageOf(receiptTotal(receipt)),
  }))
})

// ── reconcile ───────────────────────────────────────────────────────────────

/**
 * One round a restart may have left behind. A recorded end is delivered. A
 * turn that ended with no record is read from the thread's history, then
 * recorded and delivered. A stopped round whose turn never reached the
 * branch is closed. A turn with no receipt is running, was cut short,
 * or was never sent (the process died between saving the round and sending
 * it): the starter side re-sends the round. A repeat of its command with
 * `completion: "admission"` admits nothing new and returns at once, and it
 * opens the thread's loop, which resumes a turn cut short; a round never
 * sent is admitted now, though the thread's loop is open and idle. The
 * turn's own hook ends the round.
 */
const reconcileRound = Effect.fn("Threads.reconcileRound")(function* (
  round: RoundRow,
  starterSide: boolean,
) {
  if (Predicate.isNotNull(round.ended_at)) return yield* deliverRoundEnd(round)
  const recorded = yield* recordedOutcome(round)
  if (Option.isSome(recorded)) return yield* endRound(round, recorded.value)
  if (Predicate.isNotNull(round.stopped_at)) {
    // A stop that died before it closed the round. A turn that reached the
    // branch ends it when its loop resumes it, stopped; a round whose turn
    // never did has no turn to end it.
    if (yield* admitted(round)) return
    return yield* endRound(round, stoppedOutcome)
  }
  if (!starterSide) return
  yield* sendClaimedRound(round)
})

/** A hook's step that fails is logged, never raised: no user watches a hook. */
const logFailure =
  (event: string) =>
  <E, R>(step: Effect.Effect<void, E, R>) =>
    step.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(event).pipe(Effect.annotateLogs({ cause: String(cause) })),
      ),
    )

/**
 * Every round this branch's thread sent, or this branch runs, whose end is
 * not delivered. Each round settles on its own: one that fails is logged
 * with its id, and the rest go on.
 */
const reconcileBranch = Effect.fn("Threads.reconcile")(function* () {
  const ctx = yield* ExtensionContext
  const rounds = yield* ThreadRounds
  const thread = yield* callerThread()
  const pending = yield* rounds.pendingAt({
    sessionId: ctx.sessionId,
    branchId: ctx.branchId,
    thread,
  })
  yield* Effect.forEach(
    pending,
    (round) =>
      reconcileRound(round, round.starter_thread === thread).pipe(
        logFailure("threads.reconcile.round-failed"),
        Effect.annotateLogs({ round: round.round }),
      ),
    { discard: true },
  )
})

// ── the threads service ─────────────────────────────────────────────────────

const StartParams = Schema.Struct({
  task: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The thread's first round. The thread starts with no conversation history: it sees only this text. Absent: the thread waits for its first thread.send.",
    }),
  ),
  name: Schema.optionalKey(
    Schema.String.annotate({
      description: "A short name for the thread; defaults to the task's first line.",
    }),
  ),
  agent: Schema.optionalKey(
    AgentName.annotate({
      description:
        'The agent the thread runs as; default yours. "worker" is a long-lived thread that takes rounds and keeps its prompt cache between them.',
    }),
  ),
  model: Schema.optionalKey(
    ModelId.annotate({ description: "The thread's model; default yours." }),
  ),
  effort: Schema.optionalKey(ReasoningEffort),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The thread's working directory; a relative path resolves against yours. Default: yours.",
    }),
  ),
  instructions: Schema.optionalKey(
    Schema.String.annotate({
      description: "The thread's standing role, added to its system prompt.",
    }),
  ),
  tools: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        'Ordered tool patterns that narrow the thread\'s tools, e.g. ["read", "grep", "bash"]. thread.reply stays available.',
    }),
  ),
  notify: Schema.optionalKey(ToolNotify),
})

const RoundHandle = Schema.Struct({ round: Schema.String, number: Schema.Finite })

const StartResult = Schema.Struct({
  /** The thread's key: its first session's id. */
  thread: SessionId,
  sessionId: SessionId,
  branchId: BranchId,
  /** The task's round, when a task was given. */
  round: Schema.optionalKey(RoundHandle),
})
type StartResult = typeof StartResult.Type

/**
 * What starts a thread. `key` makes the start durable-once in the caller's
 * session: a tool passes its call id, and the same key returns the same
 * thread and round.
 */
interface ThreadStartInput extends Omit<Schema.Schema.Type<typeof StartParams>, "notify"> {
  readonly key: string
  readonly notify?: RoundNotify
}

/** A thread is a child session: its name follows `childSessionName`, else `thread`. */
const threadName = (start: { readonly name?: string; readonly task?: string }) =>
  Option.getOrElse(
    childSessionName({
      name: Option.fromUndefinedOr(start.name),
      prompt: Option.getOrElse(Option.fromUndefinedOr(start.task), () => ""),
    }),
    () => "thread",
  )

type StoredAdmission = NonNullable<StoredSession["admission"]>

/**
 * The run a thread starts with: the named agent, else the starter's agent
 * and admission, as a `/btw` fork runs. Model attempts are capped as a
 * delegate child's are, unless the run names a cap. `instructions` add to the
 * run's addendum, and `tools` narrow its tools, keeping `thread.reply`.
 */
const threadAdmission = (starter: StoredSession, input: ThreadStartInput): StoredAdmission => {
  const base: StoredAdmission = Option.match(Option.fromUndefinedOr(input.agent), {
    onNone: () => ({ ...starter.admission }),
    onSome: (agent) => ({ agent }),
  })
  const overrides = base.runSpec?.overrides
  const addenda = [overrides?.systemPromptAddendum, input.instructions].filter(Predicate.isString)
  return {
    ...base,
    runSpec: {
      ...base.runSpec,
      overrides: {
        maxModelAttempts: THREAD_MAX_MODEL_ATTEMPTS,
        ...overrides,
        ...omitUndefined({
          systemPromptAddendum: Option.getOrUndefined(
            Option.liftPredicate(addenda.join("\n\n"), (text) => text.length > 0),
          ),
          tools: Option.getOrUndefined(
            Option.map(Option.fromUndefinedOr(input.tools), (patterns) => [
              ...patterns,
              "thread.reply",
            ]),
          ),
        }),
      },
    },
  }
}

const threadsWord = (count: number) => {
  if (count === 1) return "thread"
  return "threads"
}

/** The cap's refusal, naming the threads the starter's thread runs. */
const capRefusal = Effect.fn("Threads.capRefusal")(function* (busy: ReadonlyArray<string>) {
  const started = yield* startedThreads()
  const names = busy
    .map((thread) => {
      const name = started.find((entry) => entry.thread === thread)?.current.name ?? ""
      return `${thread} "${name}"`
    })
    .join(", ")
  return yield* new ThreadError({
    message: `This session's thread already runs ${busy.length} ${threadsWord(busy.length)}: ${names}. Stop one with thread.stop, or send this round when one ends.`,
  })
})

/**
 * The cap, read before a start makes its session, so a start past it makes
 * none. The claim reads it again in its transaction: that read is the one
 * the table holds to.
 */
const refuseOverCap = Effect.fn("Threads.refuseOverCap")(function* (cap: number) {
  const rounds = yield* ThreadRounds
  const busy = yield* rounds.busyThreads(yield* callerThread())
  if (busy.length < cap) return
  return yield* capRefusal(busy)
})

interface RoundRequest {
  readonly thread: SessionId
  readonly place: { readonly sessionId: SessionId; readonly branchId: BranchId }
  readonly message: string
  readonly reply: Option.Option<string>
  readonly notify: RoundNotify
}

/**
 * Admits one round under the cap. A retry under the same key is handed the
 * round it admitted before any refusal applies, and is sent only when its
 * first call never admitted it (a crash between the row and the send).
 * `request` runs under the permit after the cap check, so a start makes its
 * session only when the cap admits it, and two calls in one model step
 * cannot both take the last place.
 */
const admitRound = Effect.fn("Threads.admitRound")(function* <E, R>(
  kind: string,
  key: string,
  request: Effect.Effect<RoundRequest, E, R>,
) {
  const ctx = yield* ExtensionContext
  const rounds = yield* ThreadRounds
  const roundId = `round-${(yield* identityDigest(kind, key)).slice(0, 16)}`
  const starter = {
    sessionId: ctx.sessionId,
    branchId: ctx.branchId,
    thread: yield* callerThread(),
  }
  const cap = yield* runningCap()
  const claim = yield* Semaphore.withPermit(
    rounds.admissions,
    Effect.gen(function* () {
      const retry = yield* rounds.round(roundId)
      if (Option.isSome(retry)) {
        return RoundClaim.cases.Ready.make({ round: retry.value, fresh: false })
      }
      yield* refuseOverCap(cap)
      const input = yield* request
      return yield* rounds.claimRound({
        round: roundId,
        cap,
        thread: input.thread,
        starter,
        place: input.place,
        messageId: roundMessageId(roundId),
        content: (number) =>
          threadRoundText({
            number,
            starter: ctx.sessionId,
            message: input.message,
            reply: input.reply,
            notify: input.notify,
          }),
        replySpec: input.reply,
        notify: input.notify,
        startedAt: yield* Clock.currentTimeMillis,
      })
    }),
  )
  if (claim._tag === "OverCap") return yield* capRefusal(claim.threads)
  if (claim._tag === "Busy") {
    return yield* new ThreadError({
      message: `Thread ${claim.round.thread} is running round ${claim.round.number} (${claim.round.round}); send the next round when it ends`,
    })
  }
  const round = claim.round
  if (claim.fresh || (Predicate.isNull(round.ended_at) && !(yield* admitted(round)))) {
    yield* sendClaimedRound(round)
  }
  return { round: round.round, number: round.number, thread: SessionId.make(round.thread) }
})

const startThread = Effect.fn("Threads.start")(function* (input: ThreadStartInput) {
  const ctx = yield* ExtensionContext
  const path = yield* Path.Path
  const starter = yield* ctx.Session.getSession()
  if (Predicate.isUndefined(starter)) {
    return yield* new ThreadError({ message: "This session no longer exists" })
  }
  const task = Option.filter(
    Option.map(Option.fromUndefinedOr(input.task), (text) => text.trim()),
    (text) => text.length > 0,
  )
  // The create is durable-once by its request id, so a repeat of this call
  // finds its own thread. A request id is matched in the whole workspace,
  // and a tool call id is unique only in its session, so the id digests the
  // calling session and branch with the key, as a round's does.
  const requestId = RequestId.make(
    `thread:${(yield* identityDigest("thread.create", input.key)).slice(0, 32)}`,
  )
  const create = ctx.Session.create({
    name: threadName(input),
    parentBranchId: ctx.branchId,
    admission: threadAdmission(starter, input),
    ...omitUndefined({
      modelId: input.model ?? starter.modelId,
      reasoningLevel: input.effort ?? starter.reasoningLevel,
      cwd: Option.getOrUndefined(
        Option.map(Option.fromUndefinedOr(input.cwd), (cwd) => path.resolve(ctx.cwd, cwd)),
      ),
    }),
    requestId,
  })
  // With a task, the cap admits the thread before its session is made. A
  // retry finds its round before the cap and its session after it.
  const round = yield* Option.match(task, {
    onNone: () => Effect.succeed(Option.none<typeof RoundHandle.Type>()),
    onSome: (message) =>
      admitRound(
        "thread.start",
        input.key,
        Effect.map(create, (created) => ({
          thread: created.sessionId,
          place: created,
          message,
          reply: Option.none<string>(),
          notify: input.notify ?? "user",
        })),
      ).pipe(
        Effect.map((admitted) => Option.some({ round: admitted.round, number: admitted.number })),
      ),
  })
  const created = yield* create
  yield* ctx.State.changed().pipe(Effect.ignore)
  const result: StartResult = {
    thread: created.sessionId,
    sessionId: created.sessionId,
    branchId: created.branchId,
    ...omitUndefined({ round: Option.getOrUndefined(round) }),
  }
  return result
})

const SendParams = Schema.Struct({
  thread: SessionId.annotate({
    description: "The thread's key, from thread.start or thread.list.",
  }),
  message: Schema.String.annotate({ description: "The round's whole message to the thread." }),
  reply: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The value the round must return, described, e.g. "verdict: accepted | changes, findings[]". The thread answers with thread.reply; thread.round returns it as reply.',
    }),
  ),
  notify: Schema.optionalKey(ToolNotify),
})

/**
 * What sends a round. `key` makes the send durable-once, as a start's does;
 * `notify` names who hears its end.
 */
interface ThreadSendInput extends Omit<Schema.Schema.Type<typeof SendParams>, "notify"> {
  readonly key: string
  readonly notify?: RoundNotify
}

/** A round to the thread's current session, so it reaches the thread after a handoff. */
const sendToThread = Effect.fn("Threads.send")(function* (input: ThreadSendInput) {
  const found = yield* ownThread(input.thread)
  const place = currentPlace(found)
  if (Option.isNone(place)) {
    return yield* new ThreadError({ message: `Thread ${input.thread} has no active branch` })
  }
  const admitted = yield* admitRound(
    "thread.send",
    input.key,
    Effect.succeed({
      thread: found.thread,
      place: place.value,
      message: input.message,
      reply: Option.fromUndefinedOr(input.reply),
      notify: input.notify ?? "user",
    }),
  )
  return { round: admitted.round, number: admitted.number }
})

/**
 * One round as its sender reads it: open, or ended with the thread's final
 * text, the last `thread.reply` value (null when the round asked for none or
 * got none), how the turn ended, and its bill. Flat, so a cell reads it as
 * one typed shape.
 */
const RoundView = Schema.Struct({
  round: Schema.String,
  thread: Schema.String,
  number: Schema.Finite,
  status: Schema.Literals(["open", "ended"]),
  text: Schema.String,
  reply: Schema.NullOr(Schema.Json),
  replyAsked: Schema.Boolean,
  interrupted: Schema.Boolean,
  streamFailed: Schema.Boolean,
  unanswered: Schema.Boolean,
  /** A thread.stop closed the round. */
  stopped: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(ChildUsage),
})
type RoundView = typeof RoundView.Type

const roundStatus = (round: RoundRow): RoundView["status"] => {
  if (Predicate.isNull(round.ended_at)) return "open"
  return "ended"
}

const roundView = (round: RoundRow): RoundView => ({
  round: round.round,
  thread: round.thread,
  number: round.number,
  status: roundStatus(round),
  text: Option.getOrElse(Option.fromNullishOr(round.text), () => ""),
  reply: Option.getOrNull(Option.flatMap(Option.fromNullishOr(round.reply_json), decodeReply)),
  replyAsked: Predicate.isNotNull(round.reply_spec),
  interrupted: round.interrupted === 1,
  streamFailed: round.stream_failed === 1,
  unanswered: round.unanswered === 1,
  stopped: Predicate.isNotNull(round.stopped_at),
  ...omitUndefined({
    error: Option.getOrUndefined(Option.fromNullishOr(round.error)),
    usage: Option.getOrUndefined(
      Option.flatMap(Option.fromNullishOr(round.usage_json), decodeUsage),
    ),
  }),
})

/** One round, read by the thread that sent it. */
const readRound = Effect.fn("Threads.round")(function* (roundId: string) {
  const rounds = yield* ThreadRounds
  const round = yield* rounds.round(roundId)
  if (Option.isNone(round)) return yield* new ThreadError({ message: `No round ${roundId}` })
  yield* ownThread(round.value.thread)
  return roundView(round.value)
})

const StopResult = Schema.Struct({
  /** The loops the stop reached; empty when the thread was idle. */
  stopped: Schema.Array(Schema.Struct({ sessionId: SessionId, branchId: BranchId })),
  /** The open round the stop closed. */
  round: Schema.optionalKey(Schema.String),
})

/**
 * How long a stop waits for the stopped turn's own end. A turn stops at its
 * next await; one that holds out past this has its round closed by the stop,
 * with no bill.
 */
const STOP_SETTLE = "10 seconds"

/** The next end of one round on the feed. */
const nextEndOf = (ends: PubSub.Subscription<RoundEnded>, round: string) =>
  Effect.gen(function* () {
    let ended = yield* PubSub.take(ends)
    while (ended.round !== round) ended = yield* PubSub.take(ends)
    return ended
  })

/**
 * Closes a round a stop reached. The stopped turn's own `turnAfter` records
 * the end, with the turn's text and bill (a round records what it spent,
 * stopped or not), so the stop waits for it while the turn runs. A round
 * whose turn already ended is recorded from its receipt; one whose turn
 * never ran, or held out past `STOP_SETTLE`, is closed here with no bill.
 */
const settleStopped = Effect.fn("Threads.settleStopped")(function* (
  round: RoundRow,
  ends: PubSub.Subscription<RoundEnded>,
  running: boolean,
) {
  const rounds = yield* ThreadRounds
  if (running) yield* Effect.timeoutOption(nextEndOf(ends, round.round), STOP_SETTLE)
  const current = Option.getOrElse(yield* rounds.round(round.round), () => round)
  if (Predicate.isNotNull(current.ended_at)) return
  const recorded = yield* recordedOutcome(current)
  yield* endRound(
    current,
    Option.getOrElse(recorded, () => stoppedOutcome),
  )
})

/**
 * Stops every turn the thread runs now, and closes its open round as
 * interrupted. The round is marked stopped first, so its end wakes nobody,
 * and the stop returns once the round is closed. `key` names a repeat of the
 * same stop.
 */
const stopThread = Effect.fn("Threads.stop")(function* (
  thread: string,
  key: Option.Option<string>,
) {
  const ctx = yield* ExtensionContext
  const rounds = yield* ThreadRounds
  const found = yield* ownThread(thread)
  const open = yield* rounds.openRound(found.thread)
  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Subscribed before the stop, so the stopped turn's end cannot fall before it.
      const ends = yield* PubSub.subscribe(rounds.ended)
      let reached = false
      if (Option.isSome(open)) {
        yield* rounds.markStopped(open.value.round, yield* Clock.currentTimeMillis)
        reached = yield* ctx.Session.stopMessage({
          sessionId: SessionId.make(open.value.session_id),
          branchId: BranchId.make(open.value.branch_id),
          messageId: MessageId.make(open.value.message_id),
          requestId: RequestId.make(`thread-stop:${open.value.round}`),
        })
      }
      const stopped = yield* Effect.forEach(found.working, (loop) =>
        ctx.Session.stop({
          sessionId: loop.sessionId,
          branchId: loop.branchId,
          ...omitUndefined({
            requestId: Option.getOrUndefined(
              Option.map(key, (id) =>
                RequestId.make(`thread-stop:${id}:${loop.sessionId}:${loop.branchId}`),
              ),
            ),
          }),
        }).pipe(Effect.as({ sessionId: loop.sessionId, branchId: loop.branchId })),
      )
      if (Option.isSome(open)) {
        yield* settleStopped(open.value, ends, reached || stopped.length > 0)
      }
      return {
        stopped,
        ...omitUndefined({
          round: Option.getOrUndefined(Option.map(open, (round) => round.round)),
        }),
      }
    }),
  )
})

/** The service's methods, each run in its caller's leaf or hook. */
const makeThreads = (rounds: ThreadRoundsService) => {
  const withRounds = Effect.provideService(ThreadRounds, ThreadRounds.of(rounds))
  return {
    start: (input: ThreadStartInput) => startThread(input).pipe(withRounds),
    send: (input: ThreadSendInput) => sendToThread(input).pipe(withRounds),
    round: (round: string) => readRound(round).pipe(withRounds),
    stop: (thread: string, key: Option.Option<string>) => stopThread(thread, key).pipe(withRounds),
    /**
     * A subscription to every round end this server records, in any place,
     * after its row is written and its starter (if any) is woken, whatever
     * its `notify`.
     * Subscribe before sending, so no end falls between the two. In memory
     * only: after a restart, a consumer reads its rounds' rows with `round`.
     */
    subscribeRoundEnds: PubSub.subscribe(rounds.ended),
  }
}

type ThreadsApi = ReturnType<typeof makeThreads>

/**
 * Threads for other extensions: start, send, read and stop, with the checks
 * the tools make, and the feed of round ends. A sender that is not a model
 * turn (a machine) sends with `notify: "none"` and reads
 * `subscribeRoundEnds`. Read it with `Effect.serviceOption`, as delegate
 * reads `Workspaces`.
 *
 * @effect-expect-leaking ExtensionContext | Path | Crypto | FileSystem
 */
export class Threads extends Context.Service<Threads, ThreadsApi>()(
  "@gent/extensions/src/threads",
) {}

/** The round table and the service: one per server, every place's profile shares them. */
const ThreadsResource = defineResource({
  id: "@gent/session-tools/threads",
  scope: "server",
  layer: Layer.effect(
    Threads,
    Effect.map(ThreadRounds, (rounds) => Threads.of(makeThreads(rounds))),
  ).pipe(Layer.provideMerge(ThreadRounds.Live)),
})

// ── tools ───────────────────────────────────────────────────────────────────

export const ThreadStartTool = tool({
  id: "thread.start",
  resources: [ThreadsResource],
  description:
    'Start a thread: a new session of its own beside you, and return at admission. With a task, the task is its first round; without one, it waits for thread.send. By default its replies go to the user in that thread and nothing wakes you; with notify "starter" a round\'s end wakes you with a one-line summary.',
  promptSnippet: "Start a thread: side work, or a long-lived worker",
  promptGuidelines: [
    'For a role that lasts several rounds (an implementor, a reviewer), start a thread with agent "worker" and no task, then give it rounds with thread.send.',
  ],
  params: StartParams,
  output: StartResult,
  summary: (input) => threadName(input),
  execute: Effect.fn("ThreadStartTool.execute")(function* (params) {
    const key = yield* requireToolCall("thread.start")
    return yield* startThread({ ...params, key }).pipe(asThreadError("Cannot start the thread"))
  }),
})

const ThreadSendTool = tool({
  id: "thread.send",
  resources: [ThreadsResource],
  description:
    "Send a thread you started one round, to its current session, and return the round's id at admission, never its answer. A thread runs one round at a time.",
  promptSnippet: "Give a thread one round",
  promptGuidelines: [
    'With notify "starter", end your turn after sending: the round\'s end wakes you, and thread.round reads it. Do not poll.',
  ],
  params: SendParams,
  output: RoundHandle,
  execute: Effect.fn("ThreadSendTool.execute")(function* (params) {
    const key = yield* requireToolCall("thread.send")
    return yield* sendToThread({ ...params, key }).pipe(asThreadError("Cannot send the round"))
  }),
})

const ThreadRoundTool = tool({
  id: "thread.round",
  resources: [ThreadsResource],
  description:
    "Read one round you sent: open, or ended with the thread's text, its reply, how the turn ended, and its usage and cost.",
  promptSnippet: "Read a thread round's result",
  readonly: true,
  params: Schema.Struct({
    round: Schema.String.annotate({ description: "The round id thread.send returned." }),
  }),
  output: RoundView,
  execute: Effect.fn("ThreadRoundTool.execute")(function* (params) {
    return yield* readRound(params.round).pipe(asThreadError("Cannot read the round"))
  }),
})

const ThreadReplyTool = tool({
  id: "thread.reply",
  resources: [ThreadsResource],
  description:
    "From a thread: give the open round the value it asked for. The last call in a round is the round's reply.",
  promptSnippet: "Give the round its reply value",
  params: Schema.Struct({
    value: Schema.Json.annotate({ description: "The value, in the shape the round asked for." }),
  }),
  output: Schema.Struct({ round: Schema.String }),
  execute: Effect.fn("ThreadReplyTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const rounds = yield* ThreadRounds
    const open = yield* rounds
      .openRoundAt({ sessionId: ctx.sessionId, branchId: ctx.branchId })
      .pipe(asThreadError("Cannot reply"))
    if (Option.isNone(open)) {
      return yield* new ThreadError({ message: "No round is open in this session" })
    }
    if (Predicate.isNull(open.value.reply_spec)) {
      return yield* new ThreadError({
        message: "This round asks for no reply value: answer in your final text",
      })
    }
    const json = yield* encodeReply(params.value).pipe(
      Effect.mapError(
        (cause) => new ThreadError({ message: `Reply is not JSON: ${cause.message}` }),
      ),
    )
    const recorded = yield* rounds
      .recordReply(open.value.round, json)
      .pipe(asThreadError("Cannot reply"))
    if (!recorded) return yield* new ThreadError({ message: "The round ended before the reply" })
    return { round: open.value.round }
  }),
})

/** The latest reply `thread.list` shows for one named thread, head and tail; a child completion's bound. */
const THREAD_PREVIEW_CHARS = 4_000

/** The one line of latest reply each row of a whole listing shows. */
const THREAD_LINE_CHARS = 200

const ThreadListParams = Schema.Struct({
  thread: Schema.optionalKey(
    SessionId.annotate({
      description: "One thread's key: its row then carries the head and tail of its latest reply.",
    }),
  ),
})

const ThreadRow = Schema.Struct({
  thread: SessionId,
  name: Schema.String,
  /** The agent the current session runs as; absent for the default agent. */
  agent: Schema.optionalKey(Schema.String),
  /** How many sessions the thread holds: more than one after a handoff. */
  sessions: Schema.Finite,
  /** The session a round to the thread goes to. */
  current: Schema.Struct({ sessionId: SessionId, branchId: BranchId }),
  status: Schema.Literals(["running", "idle"]),
  /** The round the thread runs now, if any. */
  openRound: Schema.optionalKey(RoundHandle),
  /** The current session's latest reply: one line, or for one named thread its head and tail. */
  preview: Schema.String,
})

/** A thread runs while any of its sessions' loops works. */
const threadStatus = (entry: StartedThread): "running" | "idle" => {
  if (entry.working.length > 0) return "running"
  return "idle"
}

/** The first line of the reply that has words, cut to one row. */
const firstLine = (text: string): string =>
  headChars(
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "",
    THREAD_LINE_CHARS,
  )

const ThreadListTool = tool({
  id: "thread.list",
  resources: [ThreadsResource],
  description:
    "List the threads this thread started, from any of its sessions: each one's status, its open round, its current session, and its latest reply. A snapshot; do not call it in a loop to wait for a thread.",
  params: ThreadListParams,
  output: Schema.Array(ThreadRow),
  execute: Effect.fn("ThreadListTool.execute")(function* (params: typeof ThreadListParams.Type) {
    const ctx = yield* ExtensionContext
    const rounds = yield* ThreadRounds
    const named = Option.fromUndefinedOr(params.thread)
    const threads = yield* Option.match(named, {
      onNone: () => startedThreads(),
      onSome: (thread) => Effect.map(ownThread(thread), (found) => [found]),
    }).pipe(asThreadError("Cannot list the threads"))
    return yield* Effect.forEach(threads, (entry) =>
      Effect.gen(function* () {
        const current = entry.current
        const branchId = current.activeBranchId
        if (Predicate.isUndefined(branchId)) return []
        const detail = yield* ctx.Session.getDetail(current.id)
        const reply = latestAssistantText(
          detail.branches.find((found) => found.branch.id === branchId)?.messages ?? [],
        )
        const preview = Option.match(named, {
          onNone: () => firstLine(reply),
          onSome: () => headTailChars(reply, THREAD_PREVIEW_CHARS).text,
        })
        const open = yield* rounds.openRound(entry.thread)
        const row: typeof ThreadRow.Type = {
          thread: entry.thread,
          name: current.name ?? "",
          sessions: entry.sessions.length,
          current: { sessionId: current.id, branchId },
          status: threadStatus(entry),
          preview,
          ...omitUndefined({
            agent: current.admission?.agent,
            openRound: Option.getOrUndefined(
              Option.map(open, (round) => ({ round: round.round, number: round.number })),
            ),
          }),
        }
        return [row]
      }).pipe(asThreadError(`Cannot read thread ${entry.thread}`)),
    ).pipe(Effect.map((rows) => rows.flat()))
  }),
})

const ThreadStopTool = tool({
  id: "thread.stop",
  resources: [ThreadsResource],
  description:
    "Stop a thread this thread started, from any of its sessions: every turn it runs now ends as interrupted, and its open round closes. An idle thread is left as it is.",
  params: Schema.Struct({
    thread: SessionId.annotate({
      description: "The thread's key, from thread.start or thread.list.",
    }),
  }),
  output: StopResult,
  execute: Effect.fn("ThreadStopTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    return yield* stopThread(params.thread, Option.fromUndefinedOr(ctx.toolCallId)).pipe(
      asThreadError(`Cannot stop thread ${params.thread}`),
    )
  }),
})

// ── registration ────────────────────────────────────────────────────────────

/** The sessions section's lines for the thread tools, shown where `thread.start` is admitted. */
export const THREAD_LINES = [
  '- Start a thread with thread.start: a new session of its own beside you, for unrelated work or for a long-lived worker (agent "worker"). thread.send gives it rounds, one at a time. A round\'s replies go to the user unless you send it with notify "starter": then its end wakes you, and thread.round reads its text and reply.',
  "- thread.list shows the threads you started, whether each runs, and its latest reply; read_session reads one in full, and thread.stop stops it. Check on a thread only when the user asks or your work depends on it.",
]

/** A hook step that fails logs and ends; the next loop open reconciles what it left. */
const removeSessionRounds = Effect.fn("Threads.sessionDeleted")(function* (sessionId: SessionId) {
  const rounds = yield* ThreadRounds
  yield* rounds.removeSession(sessionId)
})

/**
 * The threads' part of `@gent/session-tools`: the worker agent, the tools,
 * the round table, and the hooks that end, deliver and reconcile rounds.
 * Threads share that extension's id, so a thread's messages carry it.
 */
export const registerThreads = (host: ExtensionHostService) =>
  Effect.gen(function* () {
    yield* host.register("agent", workerAgent)
    yield* host.register("resource", ThreadsResource)
    yield* host.register(
      "tool",
      ThreadStartTool,
      ThreadSendTool,
      ThreadRoundTool,
      ThreadReplyTool,
      ThreadListTool,
      ThreadStopTool,
    )
    yield* host.on("turnAfter", (input) =>
      onRoundTurnAfter(input).pipe(logFailure("threads.round-end.failed")),
    )
    // A restart leaves a round mid-turn, or ended with no record or no
    // delivery. The loop open of its starter's thread, or of the thread, picks it up.
    yield* host.on("loopOpen", () => reconcileBranch().pipe(logFailure("threads.reconcile.failed")))
    yield* host.on("sessionDeleted", ({ sessionId }) => removeSessionRounds(sessionId))
  })
