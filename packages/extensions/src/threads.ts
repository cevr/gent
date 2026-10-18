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
 * cache; `delegate` is the one-round subagent). With a task, the task is its
 * first round. A thread may work in a snapshot copy of the working tree
 * (`workspace: { snapshot: true }`, from `@gent/workspaces`) and may start
 * from the starter's context window (`fork`). `thread.send` admits one
 * round, a turn on the thread's current session, and returns the round's id
 * at admission, never its answer: a thread runs one round at a time, and only
 * the thread that started it sends to it. The `turnAfter` hook of the
 * thread's branch ends the round: it records the text, the value the thread
 * gave `thread.reply`, the turn's flags and its bill in `thread_rounds`,
 * publishes the end to the `Threads` service's subscribers, then notifies as
 * the round's `notify` says: the user reads it (`user`), a message that
 * carries the answer and the row it draws wakes the starter (`starter`), or
 * nobody is told (`none`, the service's own senders). A branch's loop open
 * reconciles what a restart left, and its next turn reconciles again after
 * a threads hook failed. The starter's interrupt stops the `starter` rounds
 * whose end would wake it, and its next turns read which; it leaves `user`
 * and `none` rounds running. `thread.stop` stops any thread.
 */
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  type PlatformError,
  Predicate,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { Hex } from "effect/encoding"
import { Migrator, SqlClient } from "effect/sql"
import {
  ActorCommandId,
  AgentDefinition,
  AgentName,
  BranchId,
  CredentialSlot,
  defineResource,
  ExtensionContext,
  type ExtensionContextService,
  type ExtensionHostService,
  type ExtensionServiceError,
  FollowUpQueueFull,
  headChars,
  headTailChars,
  initialSessionMetrics,
  latestAssistantText,
  MessageId,
  ModelId,
  omitUndefined,
  ReasoningEffort,
  RequestId,
  SessionAccount,
  sessionAccount,
  type SessionReachError,
  SessionId,
  sessionThread,
  stepSessionMetrics,
  tool,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import {
  ChildToolLine,
  ChildUsage,
  receiptTotal,
  startTurnMessages,
  toolCountsOf,
  turnDuration,
  turnEnd,
  turnToolLines,
  usageOf,
} from "./child-turns.js"
import { childSessionName } from "./session-names.js"
import { type CollectedWork, type WorkspaceError, Workspaces } from "./workspaces.js"

// ── the agents ──────────────────────────────────────────────────────────────

/**
 * The one-round subagent: a thread started with a task and `notify:
 * "starter"`, whose round's end hands its starter the answer. It never
 * orchestrates: fan-out is the starter's decision, and a project prompt that
 * addresses "the orchestrator" reaches a thread too, so without these denials
 * it would read that prompt and start threads of its own. Its model and effort
 * come from this definition, reshaped by `agents.delegate` in
 * `.gent/config.json` (user, then project), unless the start names its own.
 * That config entry is where a pairing such as fable → opus is declared.
 */
export const DELEGATE_AGENT_NAME = AgentName.make("delegate")

const delegateAgent = AgentDefinition.make({
  name: DELEGATE_AGENT_NAME,
  description:
    "The default subagent: runs one delegated task and cannot delegate further. When blocked in its task turn, it ends the turn with its question; in a later turn, it asks its parent with session.send.",
  tools: ["*", "!thread.start", "!thread.stop", "!machine.*"],
})

const WORKER_AGENT_NAME = AgentName.make("worker")

/**
 * The agent of a long-lived thread that takes rounds. A worker does its
 * starter's work and never orchestrates: it starts and stops no threads and
 * runs no machines. It keeps `thread.reply` for a round that
 * asks for a value, and the session prompt cache (`promptCache: "session"`):
 * its rounds come minutes or an hour apart, where a one-turn child keeps
 * five minutes.
 */
const workerAgent = AgentDefinition.make({
  name: WORKER_AGENT_NAME,
  description:
    "A long-lived worker thread: takes rounds from the thread that started it, one at a time, and answers each in its final text, or with thread.reply when the round asks for a value.",
  tools: ["*", "!thread.start", "!thread.stop", "!machine.*"],
  promptCache: "session",
  systemPromptAddendum: `# Worker

You are a worker thread: a long-lived session that another session started. Each round arrives as a message, and your final text in that turn is the round's answer. When a round asks for a reply value, call thread.reply({ value }) with it before you end the turn; the last call counts.`,
})

// ── errors ──────────────────────────────────────────────────────────────────

class ThreadError extends Schema.TaggedError<ThreadError, { readonly brand: unique symbol }>()(
  "ThreadError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

class ThreadStorageError extends Schema.TaggedError<
  ThreadStorageError,
  { readonly brand: unique symbol }
>()("ThreadStorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const storageError = (message: string) => (cause: unknown) =>
  new ThreadStorageError({ message, cause })

/**
 * A send to a thread whose round is still open: a thread runs one round at a
 * time. A sender that is not a model turn waits for `round` to end and sends
 * again; a full follow-up queue (`FollowUpQueueFull`) is another refusal.
 */
export class ThreadBusy extends Schema.TaggedError<ThreadBusy, { readonly brand: unique symbol }>()(
  "ThreadBusy",
  {
    message: Schema.String,
    thread: Schema.String,
    round: Schema.String,
  },
) {}

/**
 * A round past the running cap: the starter's thread already has `threads`
 * with an open round. A sender that is not a model turn waits for one of
 * them to end.
 */
export class ThreadsOverCap extends Schema.TaggedError<
  ThreadsOverCap,
  { readonly brand: unique symbol }
>()("ThreadsOverCap", {
  message: Schema.String,
  threads: Schema.Array(Schema.String),
}) {}

/**
 * Every fault behind the facade is one caller-facing error. A busy thread
 * and the cap keep their own words: the model reads them as before, as a
 * `ThreadError`, and the service's callers get the typed refusal.
 */
const asThreadError = (what: string) =>
  Effect.mapError(
    (
      cause:
        | ExtensionServiceError
        | SessionReachError
        | PlatformError.PlatformError
        | FollowUpQueueFull
        | ThreadStorageError
        | WorkspaceError
        | ThreadBusy
        | ThreadsOverCap
        | ThreadError,
    ) => {
      if (Schema.is(ThreadError)(cause)) return cause
      if (Schema.is(ThreadBusy)(cause) || Schema.is(ThreadsOverCap)(cause)) {
        return new ThreadError({ message: cause.message, cause })
      }
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
 * nothing reaches the starter. `starter`: a message that carries the answer
 * wakes the starter, and the starter's interrupt stops the round. `none`:
 * nobody is told; the end is recorded and published on
 * `Threads.subscribeRoundEnds`, for a sender that is not a model turn.
 */
const RoundNotify = Schema.Literals(["user", "starter", "none"])
type RoundNotify = typeof RoundNotify.Type

/** The modes a tool call picks; `none` belongs to the service's own senders. */
const ToolNotify = Schema.Literals(["user", "starter"]).annotate({
  description:
    "`user` (default): the user reads the round in the thread, and nothing comes back to you. `starter`: the round's end arrives as a message that wakes you with the thread's answer; thread.round reads its whole text and reply. Your interrupt stops a `starter` round.",
})

/**
 * One round. `thread` is the thread's key, and `session_id` and `branch_id`
 * the session it ran on, the thread's current one when it was sent. The
 * starter is the session and branch that sent it and their thread, which a
 * round's end reaches after a handoff. `reply_spec` is the value the round
 * asked for and `reply_json` the last `thread.reply`. `stopped_at` is set by
 * a `thread.stop` that closed the round, or by the starter's interrupt; the
 * interrupt also sets `stop_notice_at`, which stays until a turn of the
 * starter reads the notice. The end fields are NULL while the round is open;
 * the flags are 0 or 1. `wake_session_id` and `wake_branch_id` are where a
 * `starter` round's end wakes its starter, saved before the wake is sent (or
 * when the interrupt that stops it is that place's), so a second delivery
 * goes where the first one went.
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
  stop_notice_at: Schema.NullOr(Schema.Finite),
})
type RoundRow = typeof RoundRow.Type

/** A session and branch: where a round runs, or where its end wakes. */
interface Place {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

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
  /**
   * Records the end once: the first writer wins, a later one changes nothing.
   * A turn that ended uninterrupted completed before the starter's interrupt
   * reached it: the interrupt's stop and notice go, so its end wakes the
   * starter as any other does.
   */
  readonly endRound: (round: string, end: RoundEnd) => Effect.Effect<void, ThreadStorageError>
  readonly markStopped: (round: string, at: number) => Effect.Effect<void, ThreadStorageError>
  /** The open `starter` rounds one starter thread sent that nothing has stopped yet. */
  readonly stopCandidates: (
    starterThread: SessionId,
  ) => Effect.Effect<ReadonlyArray<RoundRow>, ThreadStorageError>
  /**
   * Marks an open round stopped by the starter's interrupt at `place`, with a
   * stop notice, and saves `place` as where its end wakes: `replacing` is the
   * saved target this replaces (none when none was saved), as
   * `saveWakeTarget`'s compare and swap reads it. False when the round ended,
   * was stopped already, or its target moved.
   */
  readonly claimStop: (
    round: string,
    at: number,
    place: Place,
    replacing: Option.Option<SessionId>,
  ) => Effect.Effect<boolean, ThreadStorageError>
  /** Hands back a claim whose stop failed: the round runs on and reports itself. */
  readonly unclaimStop: (round: string, at: number) => Effect.Effect<void, ThreadStorageError>
  /** The rounds whose stop notice no turn at `place` has read, the newest stop first. */
  readonly stopNoticesAt: (
    place: Place,
  ) => Effect.Effect<ReadonlyArray<RoundRow>, ThreadStorageError>
  /** Drops one notice, only for the stop that wrote it. */
  readonly clearStopNotice: (round: string, at: number) => Effect.Effect<void, ThreadStorageError>
  /** A thread's latest round, open or ended; with `ended`, its latest ended one. */
  readonly latestRound: (
    thread: string,
    ended: boolean,
  ) => Effect.Effect<Option.Option<RoundRow>, ThreadStorageError>
  /** Saves where the end wakes the starter; the first writer wins. Returns the saved place. */
  readonly saveWakeTarget: (
    round: string,
    place: { readonly sessionId: SessionId; readonly branchId: BranchId },
    /** The saved target's session this replaces; none saves the first. */
    replacing: Option.Option<SessionId>,
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
  /** The branches whose turns reconciled since the last failed hook step. */
  readonly reconciled: ReconciledBranches
}

/**
 * The branches this server reconciled on a turn. A turn's reconcile repairs
 * what a failed hook step left; the hooks deliver every end otherwise. So a
 * branch's turns reconcile once per process, and again after any threads hook
 * step fails: a failure invalidates every mark, in every place, because the
 * failed step may not know which starter it was writing to. A generation
 * keeps a reconcile that raced the failure from marking its branch clean.
 * Without the gate every model step would replay each running thread's log.
 */
interface ReconciledBranches {
  /** The current generation, read before a reconcile starts. */
  readonly generation: Effect.Effect<number>
  readonly has: (key: string) => Effect.Effect<boolean>
  /** Marks the branch only when no failure invalidated the marks since `generation`. */
  readonly add: (key: string, generation: number) => Effect.Effect<void>
  readonly invalidate: Effect.Effect<void>
}

interface ReconciledState {
  readonly generation: number
  readonly keys: ReadonlySet<string>
}

const makeReconciledBranches = Effect.map(
  Ref.make<ReconciledState>({ generation: 0, keys: new Set() }),
  (state): ReconciledBranches => ({
    generation: Effect.map(Ref.get(state), (current) => current.generation),
    has: (key) => Effect.map(Ref.get(state), (current) => current.keys.has(key)),
    add: (key, generation) =>
      Ref.update(state, (current) => {
        if (current.generation !== generation) return current
        return { generation, keys: new Set([...current.keys, key]) }
      }),
    invalidate: Ref.update(state, (current) => ({
      generation: current.generation + 1,
      keys: new Set<string>(),
    })),
  }),
)

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
 * The stop notice of a round the starter's interrupt stopped: when it was
 * written, until a turn of the starter reads it. Additive: a server on the
 * code before it reads and writes the same rows.
 */
const stopNoticesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* Effect.forEach(
    [
      `ALTER TABLE thread_rounds ADD COLUMN stop_notice_at INTEGER`,
      `CREATE INDEX thread_rounds_stop_notices ON thread_rounds (wake_session_id, wake_branch_id) WHERE stop_notice_at IS NOT NULL`,
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
  loader: Migrator.fromRecord({
    "1_thread_rounds": threadRoundsMigration,
    "2_thread_round_stop_notices": stopNoticesMigration,
  }),
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
      const reconciled = yield* makeReconciledBranches
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
            // Every SET reads the row as it was, so the CASEs see the claim.
            const completed = flag(!end.interrupted)
            yield* sql`
              UPDATE thread_rounds
              SET ended_at = ${end.endedAt},
                  text = ${end.text},
                  interrupted = ${flag(end.interrupted)},
                  stream_failed = ${flag(end.streamFailed)},
                  unanswered = ${flag(end.unanswered)},
                  error = ${Option.getOrNull(end.error)},
                  usage_json = ${Option.getOrNull(usage)},
                  stopped_at = CASE
                    WHEN ${completed} = 1 AND stop_notice_at IS NOT NULL THEN NULL
                    ELSE stopped_at
                  END,
                  stop_notice_at = CASE
                    WHEN ${completed} = 1 THEN NULL
                    ELSE stop_notice_at
                  END
              WHERE round = ${round} AND ended_at IS NULL
            `
          },
          Effect.mapError(storageError("Failed to record the round's end")),
        ),

        stopCandidates: Effect.fn("ThreadRounds.stopCandidates")(
          function* (starterThread) {
            return yield* sql<RoundRow>`
              SELECT * FROM thread_rounds
              WHERE starter_thread = ${starterThread} AND notify = 'starter'
                AND ended_at IS NULL AND stopped_at IS NULL
              ORDER BY started_at, round
            `
          },
          Effect.mapError(storageError("Failed to read the rounds to stop")),
        ),

        claimStop: Effect.fn("ThreadRounds.claimStop")(
          function* (round, at, place, replacing) {
            const rows = yield* sql<{ readonly round: string }>`
              UPDATE thread_rounds
              SET stopped_at = ${at}, stop_notice_at = ${at},
                  wake_session_id = ${place.sessionId}, wake_branch_id = ${place.branchId}
              WHERE round = ${round} AND ended_at IS NULL AND stopped_at IS NULL
                AND wake_session_id IS ${Option.getOrNull(replacing)}
              RETURNING round
            `
            return rows.length > 0
          },
          Effect.mapError(storageError("Failed to mark the round stopped")),
        ),

        unclaimStop: Effect.fn("ThreadRounds.unclaimStop")(
          function* (round, at) {
            yield* sql`
              UPDATE thread_rounds SET stopped_at = NULL, stop_notice_at = NULL
              WHERE round = ${round} AND stop_notice_at = ${at} AND ended_at IS NULL
            `
          },
          Effect.mapError(storageError("Failed to hand the round back")),
        ),

        stopNoticesAt: Effect.fn("ThreadRounds.stopNoticesAt")(
          function* (place) {
            return yield* sql<RoundRow>`
              SELECT * FROM thread_rounds
              WHERE stop_notice_at IS NOT NULL
                AND wake_session_id = ${place.sessionId} AND wake_branch_id = ${place.branchId}
              ORDER BY stop_notice_at DESC, round
            `
          },
          Effect.mapError(storageError("Failed to read the stop notices")),
        ),

        clearStopNotice: Effect.fn("ThreadRounds.clearStopNotice")(
          function* (round, at) {
            yield* sql`
              UPDATE thread_rounds SET stop_notice_at = NULL
              WHERE round = ${round} AND stop_notice_at = ${at}
            `
          },
          Effect.mapError(storageError("Failed to clear the stop notice")),
        ),

        latestRound: Effect.fn("ThreadRounds.latestRound")(
          function* (thread, ended) {
            const rows = yield* sql<RoundRow>`
              SELECT * FROM thread_rounds
              WHERE thread = ${thread} AND (${flag(ended)} = 0 OR ended_at IS NOT NULL)
              ORDER BY number DESC LIMIT 1
            `
            return Option.fromNullishOr(rows[0])
          },
          Effect.mapError(storageError("Failed to read the thread's rounds")),
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
          function* (round, place, replacing) {
            // `IS` compares a NULL as a value: a writer that saw no target, or
            // the same deleted one, wins once, and the rest read its place.
            yield* sql`
              UPDATE thread_rounds
              SET wake_session_id = ${place.sessionId}, wake_branch_id = ${place.branchId}
              WHERE round = ${round} AND wake_session_id IS ${Option.getOrNull(replacing)}
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
        reconciled,
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

/** A thread that loops on a broken model stops here instead of spending its starter's budget. */
const THREAD_MAX_MODEL_ATTEMPTS = 32

/** The head and tail of a round's text in the starter's round-end message; the whole text is `thread.round`'s. */
const maximumPreviewChars = 4_000

/** The error a round ended on, as one bounded line. */
const maximumErrorChars = 1_000

/** The round-end row shows the round's last calls; the thread's branch keeps them all. */
const MAX_ROUND_END_TOOLS = 20

const oneLine = (text: string, limit: number) => {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= limit) return line
  return `${headChars(line, limit - 1)}…`
}

const ROUND_PREFIX = "Round "

/**
 * Where a round's answer goes, in words the thread's model reads. A `starter`
 * round's final text is its result, and it returns to the starter by itself:
 * a thread told only that "a later result goes through session.send" sent
 * this turn's result that way too, so the starter read every result twice. A
 * question in this turn is that text too. Only a later turn that nobody waits
 * for reports with session.send: one a wake, a monitor or a goal starts, or a
 * message from the starter. The round's message stays in every later turn's
 * context.
 */
const answerLine = (notify: RoundNotify) => {
  if (notify === "user") {
    return "The user reads your replies in this thread; nothing you write returns to that session, so do not report to it with session.send. When you are blocked, end your turn with your question: the user answers here."
  }
  if (notify === "starter") {
    return [
      "Your final text in this turn is the round's result: it goes back to that session by itself, so do not also send it with session.send. When you are blocked in this turn, end it with your question as that text.",
      'End this turn once the work is done or handed to a wake, a monitor or a goal; do not wait for them. A later turn that is not a round (a wake, a monitor, a goal, a message from that session) returns nothing by itself: send its result or question with session.send to "parent".',
    ].join("\n")
  }
  return "Your final text in this turn is the round's answer, and it goes back to that session; do not send it with session.send."
}

/** Where a snapshot thread works: its copy, and the branch its work returns on. */
interface WorkPlace {
  readonly cwd: string
  readonly branch: string
}

/** The line every round to a snapshot thread carries. */
const placeLine = (place: WorkPlace) =>
  `You work in a private copy of your starter's working tree at ${place.cwd}. When each of your turns ends, your changes go back to that session as the git branch ${place.branch}; you do not need to commit or push.`

/**
 * A round's message: lines that say where it came from, where its answer
 * goes and, for a snapshot thread, where it works; a blank line; the
 * starter's words; and the value it asks for when it asks for one. Without
 * the lines, a session a parent spawned reads the sessions section and
 * reports to its parent with session.send, and takes its own task for an
 * injection.
 */
export const threadRoundText = (input: {
  readonly number: number
  readonly starter: SessionId
  readonly message: string
  readonly reply: Option.Option<string>
  readonly notify: RoundNotify
  readonly place: Option.Option<WorkPlace>
}) =>
  [
    `${ROUND_PREFIX}${input.number} from session ${input.starter}. ${answerLine(input.notify)}`,
    ...Option.toArray(Option.map(input.place, placeLine)),
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

/**
 * How a round ended badly, in words a model reads; none for one that
 * completed. The round-end message and its row both say it in these words.
 */
export const roundFailureNames = (flags: {
  readonly interrupted: boolean
  readonly streamFailed: boolean
  readonly unanswered: boolean
}): ReadonlyArray<string> => {
  const names: Array<string> = []
  if (flags.interrupted) names.push("interrupted")
  if (flags.streamFailed) names.push("model stream failed")
  if (flags.unanswered) names.push("no answer produced")
  return names
}

const roundFlags = (round: RoundRow) => ({
  interrupted: round.interrupted === 1,
  streamFailed: round.stream_failed === 1,
  unanswered: round.unanswered === 1,
})

const outcomeWords = (round: RoundRow) => {
  const failures = roundFailureNames(roundFlags(round))
  if (failures.length === 0) return "completed"
  return `ended (${failures.join(", ")})`
}

/** What the round's reply value came to; none for a round that asked for none. */
const replyNote = (round: RoundRow): Option.Option<string> => {
  if (Predicate.isNull(round.reply_spec)) return Option.none()
  if (Predicate.isNotNull(round.reply_json)) {
    return Option.some("The round's reply recorded: thread.round returns the value.")
  }
  return Option.some(
    "The round got no reply: it asked for one and the thread never called thread.reply.",
  )
}

/**
 * `metadata.details` of a round's end on the starter's branch. The row that
 * draws it commits to scrollback once, after the round ends, so it carries
 * everything the row shows: the thread's name and agent, the turn's flags and
 * bill, its last calls and its time, and a snapshot thread's work.
 */
export const ThreadRoundEndDetails = Schema.Struct({
  round: Schema.String,
  thread: Schema.String,
  number: Schema.Finite,
  sessionId: SessionId,
  branchId: BranchId,
  /** The agent the thread runs as; absent when it runs as its starter's default agent. */
  agentName: Schema.optionalKey(AgentName),
  /** The thread session's name, as the tray and the sessions pane show it. */
  name: Schema.optionalKey(Schema.String),
  interrupted: Schema.Boolean,
  streamFailed: Schema.Boolean,
  unanswered: Schema.Boolean,
  usage: Schema.optionalKey(ChildUsage),
  /** The error a turn that ended badly ended on, one bounded line. */
  error: Schema.optionalKey(Schema.String),
  /** The round's last calls, oldest first. `toolCount` counts every call. */
  tools: Schema.Array(ChildToolLine),
  toolCount: Schema.Finite,
  /** Every call by tool and outcome, so the row's summary counts more than the kept calls. */
  toolCounts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: ChildToolLine.fields.status,
      count: Schema.Finite,
    }),
  ),
  /** From the round's message to its turn's last message. */
  durationMs: Schema.Finite,
  /** A snapshot thread's work: its copy, the branch that holds it, and its size. */
  workspace: Schema.optionalKey(
    Schema.Struct({
      path: Schema.optionalKey(Schema.String),
      branch: Schema.optionalKey(Schema.String),
      files: Schema.optionalKey(Schema.Finite),
      insertions: Schema.optionalKey(Schema.Finite),
      deletions: Schema.optionalKey(Schema.Finite),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
})
type ThreadRoundEndDetails = typeof ThreadRoundEndDetails.Type

/** A snapshot thread's work as its round's end carries it. */
interface RoundWork {
  readonly line: string
  readonly details: NonNullable<ThreadRoundEndDetails["workspace"]>
}

/** The round end's line for a collected copy, and its details. */
const workOf = (work: CollectedWork): RoundWork => {
  if (Predicate.isNotUndefined(work.problem)) {
    return {
      line: `Work: not on a branch: ${work.problem} (${work.path}).`,
      details: { path: work.path, error: work.problem },
    }
  }
  return Option.match(Option.fromUndefinedOr(work.branch), {
    onNone: () => ({
      line: `Work: no changes in the thread's copy at ${work.path}.`,
      details: { path: work.path, files: 0, insertions: 0, deletions: 0 },
    }),
    onSome: (branch) => ({
      line: `Work: branch ${branch}, one commit over the thread's copy as it started (${work.files} files, +${work.insertions} -${work.deletions}). Nothing is merged; read it with git show ${branch}.`,
      details: {
        path: work.path,
        branch,
        files: work.files,
        insertions: work.insertions,
        deletions: work.deletions,
      },
    }),
  })
}

/**
 * The message a round's end wakes its starter with: the answer itself, so
 * the starter reads it with no extra step.
 *
 * A turn receipt is not task success, and the ways a turn can end badly are
 * not visible in its text: an interrupted turn, a failed model stream, and a
 * turn that spent its continuations without answering all leave text a
 * starter would otherwise read as a result. Each flag is named in the
 * header, with the error the turn ended on, so a failure that will repeat (a
 * sign-in, a missing key) reads differently from a flake. `thread.round`
 * returns the whole text and the reply value.
 */
const roundEndContent = (input: {
  readonly round: RoundRow
  readonly name: Option.Option<string>
  readonly agentName: Option.Option<AgentName>
  readonly work: Option.Option<RoundWork>
}): string => {
  const { round } = input
  const named = Option.match(input.name, {
    onNone: () => "",
    onSome: (name) => ` "${name}"`,
  })
  const agent = Option.match(input.agentName, {
    onNone: () => "",
    onSome: (name) => ` (agent ${name})`,
  })
  const error = Option.filter(Option.fromNullishOr(round.error), (text) => text.length > 0)
  const text = Option.getOrElse(Option.fromNullishOr(round.text), () => "")
  return [
    `Thread${named}${agent} round ${round.number} ${outcomeWords(round)}. Thread ${round.thread}; round ${round.round}; session ${round.session_id}; branch ${round.branch_id}.`,
    ...Option.toArray(Option.map(error, (line) => `Error: ${line}`)),
    ...Option.toArray(Option.map(input.work, (work) => work.line)),
    "A round's end is a turn receipt, not task success. Read the answer before relying on it.",
    "",
    headTailChars(text, maximumPreviewChars).text,
    "",
    ...Option.toArray(replyNote(round)),
    `thread.round({ round: "${round.round}" }) returns its whole text and reply.`,
  ].join("\n")
}

/**
 * The answer a round-end message carries, as its row shows it: the text
 * between the header's blank line and the blank line before the closing
 * notes, which hold no blank line of their own. Any other text is returned
 * whole.
 */
export const threadRoundEndAnswer = (content: string): string => {
  const start = content.indexOf("\n\n")
  if (start === -1) return content
  const end = content.lastIndexOf("\n\n")
  if (end <= start) return content.slice(start + 2)
  return content.slice(start + 2, end)
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
 * A saved place whose session was deleted since can never take the wake:
 * the starter's current place replaces it, once, by compare-and-swap.
 */
const wakeTarget = Effect.fn("Threads.wakeTarget")(function* (round: RoundRow) {
  const ctx = yield* ExtensionContext
  const rounds = yield* ThreadRounds
  const saved = wakeTargetOf(round)
  if (Option.isSome(saved)) {
    const session = yield* ctx.Session.getSession(saved.value.sessionId)
    if (Predicate.isNotUndefined(session)) return saved.value
  }
  const place = yield* starterPlace(round)
  const replacing = Option.map(saved, (target) => target.sessionId)
  return Option.getOrElse(yield* rounds.saveWakeTarget(round.round, place, replacing), () => place)
})

/**
 * A snapshot thread's work, brought back to the origin as a branch before
 * the round's end goes out; a thread with no copy has none. The workspaces
 * turn end collects the same turn under the same key (the round's message),
 * so the turn is collected once, whichever runs first. A collect that fails
 * is one line in the message, which still goes out.
 */
const roundWork = Effect.fn("Threads.roundWork")(function* (round: RoundRow) {
  const places = yield* Effect.serviceOption(Workspaces)
  if (Option.isNone(places)) return Option.none<RoundWork>()
  const collected = yield* places.value
    .collect(SessionId.make(round.session_id), round.message_id)
    .pipe(Effect.result)
  if (collected._tag === "Success") return Option.map(collected.success, workOf)
  const message = collected.failure.message
  return Option.some<RoundWork>({
    line: `Work: the thread's copy was not collected: ${message}`,
    details: { error: message },
  })
})

/**
 * The starter's message for a recorded end, and the row's details: read from
 * the round's own turn, so a forked thread's copied window counts for
 * nothing, and from the thread's session, for its name and agent.
 */
const roundEndMessage = Effect.fn("Threads.roundEndMessage")(function* (round: RoundRow) {
  const ctx = yield* ExtensionContext
  const sessionId = SessionId.make(round.session_id)
  const detail = yield* ctx.Session.getDetail(sessionId)
  const branch = detail.branches.find((current) => current.branch.id === round.branch_id)
  const messages = startTurnMessages(branch?.messages ?? [], MessageId.make(round.message_id))
  const tools = turnToolLines(messages)
  const name = Option.fromUndefinedOr(detail.session.name)
  const agentName = Option.fromUndefinedOr(detail.session.admission?.agent)
  const work = yield* roundWork(round)
  const details: ThreadRoundEndDetails = {
    round: round.round,
    thread: round.thread,
    number: round.number,
    sessionId,
    branchId: BranchId.make(round.branch_id),
    interrupted: round.interrupted === 1,
    streamFailed: round.stream_failed === 1,
    unanswered: round.unanswered === 1,
    tools: tools.slice(-MAX_ROUND_END_TOOLS),
    toolCount: tools.length,
    toolCounts: toolCountsOf(tools),
    durationMs: turnDuration(messages),
    ...omitUndefined({
      agentName: Option.getOrUndefined(agentName),
      name: Option.getOrUndefined(name),
      usage: Option.getOrUndefined(
        Option.flatMap(Option.fromNullishOr(round.usage_json), decodeUsage),
      ),
      error: Option.getOrUndefined(
        Option.filter(Option.fromNullishOr(round.error), (text) => text.length > 0),
      ),
      workspace: Option.getOrUndefined(Option.map(work, (found) => found.details)),
    }),
  }
  return { content: roundEndContent({ round, name, agentName, work }), details }
})

/**
 * Hands a recorded end to whoever hears it. A `starter` round wakes the
 * starter with its answer, once: the message id derives from the source id
 * and the saved place, so a second delivery after a crash is a no-op. A
 * round `thread.stop` or the starter's interrupt closed wakes nobody: its
 * stopper knows, and an interrupt's notice tells the starter's next turns.
 * Every end is then marked delivered, and the one writer that marked it
 * publishes it.
 */
const deliverRoundEnd = Effect.fn("Threads.deliverRoundEnd")(function* (round: RoundRow) {
  const ctx = yield* ExtensionContext
  const rounds = yield* ThreadRounds
  if (round.notify === "starter" && Predicate.isNull(round.stopped_at)) {
    const place = yield* wakeTarget(round)
    const ended = yield* roundEndMessage(round)
    yield* ctx.Session.send({
      delivery: "queue",
      ...place,
      sourceId: roundEndSourceId(round.round),
      wake: true,
      content: ended.content,
      metadata: { customType: THREAD_ROUND_END_TYPE, details: ended.details },
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
  // The agents tray re-reads on this pulse, so a thread whose round ended
  // leaves its running place at once.
  yield* ctx.State.changed().pipe(Effect.ignore)
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

/** A random id no earlier request shares, for a request that must not repeat one. */
const randomNonce = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  return yield* crypto.randomUUIDv4()
})

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
 * turn's own hook ends the round. A round whose thread session was deleted
 * while no process ran (so no delete hook dropped it) goes, as the hook
 * would have dropped it: it wakes nobody, and frees its place under the cap.
 */
const reconcileRound = Effect.fn("Threads.reconcileRound")(function* (
  round: RoundRow,
  starterSide: boolean,
) {
  const ctx = yield* ExtensionContext
  const sessionId = SessionId.make(round.session_id)
  if (Predicate.isUndefined(yield* ctx.Session.getSession(sessionId))) {
    return yield* Effect.flatMap(ThreadRounds, (rounds) => rounds.removeSession(sessionId))
  }
  if (Predicate.isNotNull(round.ended_at)) return yield* deliverRoundEnd(round)
  const recorded = yield* recordedOutcome(round)
  if (Option.isSome(recorded)) return yield* endRound(round, recorded.value)
  if (Predicate.isNotNull(round.stopped_at)) {
    // A stop that died before it closed the round. A round whose turn never
    // reached the branch has no turn to end it. One whose turn did ends when
    // its loop resumes the turn, and the stop may have died before it reached
    // the loop: the starter's side asks again, which opens the thread's loop
    // and stops the turn there. A new request id each time: a durable repeat
    // of an earlier one returns its stored reply and reaches no loop.
    if (!(yield* admitted(round))) return yield* endRound(round, stoppedOutcome)
    if (!starterSide) return
    yield* stopRoundTurn(
      round,
      RequestId.make(`thread-stop:${round.round}:reconcile:${yield* randomNonce}`),
    )
    return
  }
  if (!starterSide) return
  yield* sendClaimedRound(round)
})

/**
 * A hook's step that fails is logged, never raised: no user watches a hook.
 * It may have left an end undelivered or a stop unsettled, for a starter it
 * cannot name, so it invalidates every branch's reconcile mark: each
 * branch's next turn reconciles again.
 */
const logFailure =
  (event: string) =>
  <E, R>(step: Effect.Effect<void, E, R>) =>
    step.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(event).pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          Effect.andThen(Effect.flatMap(ThreadRounds, (rounds) => rounds.reconciled.invalidate)),
        ),
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

/** The reconcile mark of the caller's branch. */
const branchKey = Effect.map(ExtensionContext, (ctx) => `${ctx.sessionId}:${ctx.branchId}`)

/**
 * The loop open's reconcile: always, since a restart or a loop that closed
 * may have left anything. It marks the branch, so its turns do not repeat it.
 */
const reconcileOnOpen = Effect.gen(function* () {
  const rounds = yield* ThreadRounds
  const key = yield* branchKey
  const generation = yield* rounds.reconciled.generation
  yield* reconcileBranch()
  yield* rounds.reconciled.add(key, generation)
})

/** The turn-time reconcile: once per branch per process, again after any threads hook step failed. */
const reconcileOnce = Effect.gen(function* () {
  const rounds = yield* ThreadRounds
  const key = yield* branchKey
  if (yield* rounds.reconciled.has(key)) return
  const generation = yield* rounds.reconciled.generation
  yield* reconcileBranch()
  yield* rounds.reconciled.add(key, generation)
})

// ── the starter's interrupt ─────────────────────────────────────────────────

/**
 * Where a round's end would wake now, without saving it: the saved target
 * while its session exists, else the starter's current place. With the
 * saved session the claim replaces, as `wakeTarget` would.
 */
const wouldWake = Effect.fn("Threads.wouldWake")(function* (round: RoundRow) {
  const ctx = yield* ExtensionContext
  const saved = wakeTargetOf(round)
  const replacing = Option.map(saved, (target) => target.sessionId)
  if (Option.isSome(saved)) {
    const session = yield* ctx.Session.getSession(saved.value.sessionId)
    if (Predicate.isNotUndefined(session)) return { place: saved.value, replacing }
  }
  return { place: yield* starterPlace(round), replacing }
})

/**
 * Stops one round for the starter's interrupt. The round is claimed first:
 * marked stopped with a notice, so its turn's end, interrupted, wakes nobody,
 * and the starter's next turns read the notice instead. Then its turn is
 * stopped, queued or running, and a round whose turn never reached the
 * thread's branch is closed here. A turn that completed before the stop
 * reached it ends uninterrupted, and its end takes the claim back
 * (`endRound`): it wakes the starter as any other. A stop that fails hands
 * the claim back and fails: the round runs on and reports itself.
 */
const stopForInterrupt = Effect.fn("Threads.stopForInterrupt")(function* (
  round: RoundRow,
  place: Place,
  replacing: Option.Option<SessionId>,
) {
  const rounds = yield* ThreadRounds
  const at = yield* Clock.currentTimeMillis
  if (!(yield* rounds.claimStop(round.round, at, place, replacing))) return
  yield* Effect.scoped(
    Effect.gen(function* () {
      const ends = yield* PubSub.subscribe(rounds.ended)
      const answer = yield* Effect.exit(
        stopRoundTurn(round, RequestId.make(`thread-stop:${round.round}:interrupt:${at}`)),
      )
      if (Exit.isFailure(answer)) {
        yield* rounds.unclaimStop(round.round, at)
        return yield* Effect.failCause(answer.cause)
      }
      // The stopped turn's own end closes a round that reached the branch; a
      // round still queued is closed here, without waiting for any turn.
      const current = yield* rounds.round(round.round)
      yield* settleStopped(
        Option.getOrElse(current, () => round),
        ends,
        false,
      )
    }),
  )
})

/** Rounds one interrupt stops side by side, a few at a time. */
const STOP_CONCURRENCY = 8

/**
 * An interrupted turn on branch B stops the open `starter` rounds whose end
 * would wake B: the rounds B's thread sent, whichever of its sessions sent
 * them, whose wake lands here. Left running, they would work on after the
 * user stopped what was waiting for them; the gamut saw six such children
 * edit files after an Escape. A `user` or `none` round runs on: it is the
 * user's side thread, or a machine's. A thread stopped this way ends its own
 * turn interrupted, so the cascade reaches what it started too. Each round
 * stops on its own; one that fails is logged and invalidates the reconcile
 * marks, so the next turn tries again.
 */
const stopStarterRounds = Effect.fn("Threads.stopStarterRounds")(function* (
  input: Pick<TurnAfterInput, "sessionId" | "branchId" | "interrupted">,
) {
  if (!input.interrupted) return
  const ctx = yield* ExtensionContext
  const rounds = yield* ThreadRounds
  const candidates = yield* rounds.stopCandidates(yield* callerThread())
  if (candidates.length === 0) return
  yield* Effect.forEach(
    candidates,
    (round) =>
      Effect.gen(function* () {
        const target = yield* wouldWake(round)
        if (
          target.place.sessionId !== input.sessionId ||
          target.place.branchId !== input.branchId
        ) {
          return
        }
        yield* stopForInterrupt(round, target.place, target.replacing)
      }).pipe(
        logFailure("threads.interrupt.stop-failed"),
        Effect.annotateLogs({ round: round.round }),
      ),
    { concurrency: STOP_CONCURRENCY, discard: true },
  )
  yield* ctx.State.changed().pipe(Effect.ignore)
})

/** A stop notice names a round by its message's first line, cut here by code point. */
const maximumNoticeTaskChars = 80

/** The threads one notice names; the rest are counted, and named once these are read. */
const maximumNoticeThreads = 8

const noticeTask = (content: string) => {
  const line = threadRoundBody(content).trim().split("\n")[0] ?? ""
  if (line.length <= maximumNoticeTaskChars) return line
  return `${headChars(line, maximumNoticeTaskChars - 1)}…`
}

/** One unread stop notice: a round, at the stop that wrote it. A later stop of the same round is a new notice. */
const stopNoticeKey = (round: RoundRow) => `${round.round}@${round.stop_notice_at}`

/** The notice's id; session-tools' own notices have others. */
const STOPPED_THREADS_NOTICE = "threads-stopped"

/**
 * The threads this branch's interrupt stopped, as one turn notice: the stop
 * wakes nobody, and without it the starter's next turn believes they still
 * run. A thread is one line however many of its rounds were stopped, the
 * newest stop first, at most `maximumNoticeThreads`; the rest are a count.
 * Every step reads it; an answered turn clears exactly the rounds it showed,
 * and a round the cap left out stays for the next turn. It is untrusted: each
 * line holds the head of a round's message, which a model or a user wrote.
 */
const stopNotices = Effect.fn("Threads.stopNotices")(function* () {
  const ctx = yield* ExtensionContext
  const rounds = yield* ThreadRounds
  const stopped = yield* rounds.stopNoticesAt({ sessionId: ctx.sessionId, branchId: ctx.branchId })
  if (stopped.length === 0) return []
  // Newest stop first: each thread's first row is its latest.
  const byThread = new Map<string, Array<RoundRow>>()
  for (const round of stopped)
    byThread.set(round.thread, [...(byThread.get(round.thread) ?? []), round])
  const threads = [...byThread.values()]
  const named = threads.slice(0, maximumNoticeThreads)
  const unnamed = threads.length - named.length
  const lines = named.flatMap((rows) =>
    Option.toArray(
      Option.map(
        Option.fromUndefinedOr(rows[0]),
        (latest) =>
          `- "${noticeTask(latest.content)}" · thread ${latest.thread} · round ${latest.round}`,
      ),
    ),
  )
  if (unnamed > 0) {
    lines.push(`- and ${unnamed} more stopped threads, named once you have read these.`)
  }
  return [
    {
      id: STOPPED_THREADS_NOTICE,
      keys: named.flat().map(stopNoticeKey),
      content: `# Stopped threads\n\nThe user interrupted your turn, and that stopped these threads before their rounds finished. They are not running, and no round end will come from them. Tell the user which threads stopped; send them work again only when the user asks for it.\n\n${lines.join("\n")}`,
      trusted: false,
    },
  ]
})

/**
 * Drops the stop notices the turn read. The runtime hands back only what an
 * answered turn showed: an interrupted, failed or unanswered turn keeps them,
 * and so does every notice the turn did not show.
 */
const clearReadStopNotices = Effect.fn("Threads.clearStopNotices")(function* (
  input: Pick<TurnAfterInput, "sessionId" | "branchId" | "readNotices">,
) {
  if (input.readNotices.size === 0) return
  const rounds = yield* ThreadRounds
  const shown = yield* rounds.stopNoticesAt(input)
  yield* Effect.forEach(
    shown.filter((round) => input.readNotices.has(stopNoticeKey(round))),
    (round) => rounds.clearStopNotice(round.round, round.stop_notice_at ?? 0),
    { discard: true },
  )
})

// ── the threads service ─────────────────────────────────────────────────────

/**
 * Where a thread works besides its `cwd`. `snapshot`: a private copy of the
 * working tree from `@gent/workspaces`, whose work returns as a branch.
 */
const ThreadWorkspace = Schema.Struct({ snapshot: Schema.Literal(true) }).annotate({
  description:
    "{ snapshot: true }: the thread works in its own copy of the git working tree it would work in, and each turn's work comes back as the branch gent/<name> that nothing merges. A copy is not a sandbox.",
})

const StartParams = Schema.Struct({
  task: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The thread's first round: the whole task. A thread starts with no conversation history and sees only this text, unless it is forked. Absent: the thread waits for its first thread.send.",
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
        'The agent the thread runs as, with that agent\'s own model and effort; default yours, with your model. "delegate" runs one task and cannot start threads; "worker" is a long-lived thread that takes rounds and keeps its prompt cache between them.',
    }),
  ),
  model: Schema.optionalKey(
    ModelId.annotate({
      description: "The thread's model; default the agent's own, or yours when no agent is named.",
    }),
  ),
  effort: Schema.optionalKey(ReasoningEffort),
  account: Schema.optionalKey(
    CredentialSlot.annotate({
      description:
        'The credential label from /auth (e.g. "personal") that every round of the thread runs on, alone: a refusal on it fails the round and never moves to another credential. Default: a named agent walks the provider\'s order; with no agent, yours.',
    }),
  ),
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
  workspace: Schema.optionalKey(ThreadWorkspace),
  fork: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "true: the thread starts from your current context window, so it can continue your work as it stands. The copy is what you see now, so a long context is a costly seed.",
    }),
  ),
})

const RoundHandle = Schema.Struct({ round: Schema.String, number: Schema.Finite })

const StartResult = Schema.Struct({
  /** The thread's key: its first session's id. */
  thread: SessionId,
  sessionId: SessionId,
  branchId: BranchId,
  /** The task's round, when a task was given. */
  round: Schema.optionalKey(RoundHandle),
  /** A snapshot thread's copy and the branch its work returns on. */
  workspace: Schema.optionalKey(
    Schema.Struct({
      path: Schema.String,
      branch: Schema.String,
      /** What the copy did not do as asked, one line each (a worktree in place of rift, a failed hook). */
      note: Schema.optionalKey(Schema.String),
    }),
  ),
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
 * and admission, as a `/btw` fork runs. Model attempts are capped, unless
 * the run names a cap. `instructions` add to the run's addendum, and `tools`
 * narrow its tools, keeping `thread.reply`. `account` pins the run to that
 * credential (`RunSpec.credentialSlot`); a named agent runs on none unless
 * the call names one, and a thread with no agent keeps the starter's pin.
 * A handoff keeps its parent's admission, so the pin outlives it.
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
      ...omitUndefined({ credentialSlot: input.account }),
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
  return yield* new ThreadsOverCap({
    message: `This session's thread already runs ${busy.length} ${threadsWord(busy.length)}: ${names}. Stop one with thread.stop, or send this round when one ends.`,
    threads: busy,
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
  readonly place: Place
  readonly message: string
  readonly reply: Option.Option<string>
  readonly notify: RoundNotify
  /** A snapshot thread's copy, which the round's text names. */
  readonly workPlace: Option.Option<WorkPlace>
}

/** The round a start or a send under `key` admits: the same key, the same round. */
const roundIdOf = Effect.fn("Threads.roundIdOf")(function* (kind: string, key: string) {
  return `round-${(yield* identityDigest(kind, key)).slice(0, 16)}`
})

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
  const roundId = yield* roundIdOf(kind, key)
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
            place: input.workPlace,
          }),
        replySpec: input.reply,
        notify: input.notify,
        startedAt: yield* Clock.currentTimeMillis,
      })
    }),
  )
  if (claim._tag === "OverCap") return yield* capRefusal(claim.threads)
  if (claim._tag === "Busy") {
    return yield* new ThreadBusy({
      message: `Thread ${claim.round.thread} is running round ${claim.round.number} (${claim.round.round}); send the next round when it ends`,
      thread: claim.round.thread,
      round: claim.round.round,
    })
  }
  const round = claim.round
  if (claim.fresh || (Predicate.isNull(round.ended_at) && !(yield* admitted(round)))) {
    yield* sendClaimedRound(round)
  }
  return { round: round.round, number: round.number, thread: SessionId.make(round.thread) }
})

/**
 * The model and reasoning a thread's session keeps. A session's own model
 * wins over its agent's, so a named agent gets only what the call names:
 * otherwise the agent's own (its definition, reshaped by config
 * `agents.<name>`), else config `model`. A thread with no agent is its
 * starter's run, model and reasoning included.
 */
const threadRoute = (starter: StoredSession, input: ThreadStartInput) =>
  Option.match(Option.fromUndefinedOr(input.agent), {
    onNone: () => ({
      modelId: input.model ?? starter.modelId,
      reasoningLevel: input.effort ?? starter.reasoningLevel,
    }),
    onSome: () => ({ modelId: input.model, reasoningLevel: input.effort }),
  })

/**
 * The thread session a start stored, read from storage: the one session
 * under this starter branch whose cwd is in the start's copy. The copy's path
 * is named by the start's whole identity, so no other start's thread works
 * there.
 */
const storedThreadIn = Effect.fn("Threads.storedThreadIn")(function* (cwd: string) {
  const ctx = yield* ExtensionContext
  const sessions = yield* ctx.Session.listSessions({ thread: ctx.sessionId })
  return Option.fromUndefinedOr(
    sessions.find(
      (session) =>
        session.parentSessionId === ctx.sessionId &&
        session.parentBranchId === ctx.branchId &&
        session.cwd === cwd,
    ),
  )
})

/**
 * A snapshot thread's copy, made outside the admission permit: a copy runs
 * its `postcreate` hooks, which can take minutes, and must not hold every
 * other admission on the server. `precheck` refuses a start past the cap
 * before the copy is made. The copy's record exists from the first step of
 * its making. When the start fails or is interrupted (the finalizer on the
 * start's scope), storage decides what happens to the copy, not what this
 * fiber saw: core can store the session and then be interrupted before
 * `Session.create` returns. A stored thread session gets the copy (bound); a
 * copy is released only when storage shows no session works in it; a check
 * that fails keeps the copy. The same start (the same key) adopts the copy it
 * made before.
 */
const snapshotPlace = Effect.fn("Threads.snapshotPlace")(function* <E, R>(input: {
  readonly key: RequestId
  readonly cwd: string
  readonly precheck: Effect.Effect<void, E, R>
}) {
  const places = yield* Effect.serviceOption(Workspaces)
  if (Option.isNone(places)) {
    return yield* new ThreadError({
      message:
        "workspace { snapshot: true } needs the @gent/workspaces extension, which is not active for this session",
    })
  }
  yield* input.precheck
  const start = yield* places.value.locate({ key: input.key, cwd: input.cwd })
  const acquired = yield* Ref.make(Option.none<string>())
  yield* Effect.addFinalizer((exit) =>
    Effect.gen(function* () {
      if (Exit.isSuccess(exit)) return
      // No copy yet: `Session.create` never ran, so no session can work in it.
      const cwd = yield* Ref.get(acquired)
      let stored = Option.none<{ readonly id: SessionId }>()
      if (Option.isSome(cwd)) stored = yield* storedThreadIn(cwd.value)
      if (Option.isSome(stored)) return yield* places.value.bind(start.name, stored.value.id)
      yield* places.value.release(start.name)
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("threads.workspace.kept").pipe(
          Effect.annotateLogs({ name: start.name, cause: Cause.pretty(cause) }),
        ),
      ),
    ),
  )
  const place = yield* places.value.acquire(start)
  yield* Ref.set(acquired, Option.some(place.cwd))
  return {
    place,
    bind: (sessionId: SessionId) => places.value.bind(place.name, sessionId),
  }
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
  const cwd = Option.map(Option.fromUndefinedOr(input.cwd), (dir) => path.resolve(ctx.cwd, dir))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      // A start with a task is refused past the cap before its copy is made;
      // a retry has its round already, and the cap does not apply to it.
      const precheck = Effect.gen(function* () {
        if (Option.isNone(task)) return
        const rounds = yield* ThreadRounds
        if (Option.isSome(yield* rounds.round(yield* roundIdOf("thread.start", input.key)))) return
        yield* refuseOverCap(yield* runningCap())
      })
      // `{ snapshot: true }` is the one workspace a start names today.
      const snapshot = yield* Option.match(Option.fromUndefinedOr(input.workspace), {
        onNone: () => Effect.succeedNone,
        onSome: () =>
          Effect.asSome(
            snapshotPlace({
              key: requestId,
              cwd: Option.getOrElse(cwd, () => ctx.cwd),
              precheck,
            }),
          ),
      })
      const create = ctx.Session.create({
        name: threadName(input),
        parentBranchId: ctx.branchId,
        admission: threadAdmission(starter, input),
        ...omitUndefined({
          ...threadRoute(starter, input),
          cwd: Option.getOrUndefined(
            Option.orElse(
              Option.map(snapshot, (found) => found.place.cwd),
              () => cwd,
            ),
          ),
          historyBranchId: Option.getOrUndefined(
            Option.map(
              Option.liftPredicate(input.fork, (fork) => fork === true),
              () => ctx.branchId,
            ),
          ),
        }),
        requestId,
      }).pipe(
        // The binding names the session that works in the copy; a repeat binds the same one.
        Effect.tap((created) =>
          Option.match(snapshot, {
            onNone: () => Effect.void,
            onSome: (found) => found.bind(created.sessionId),
          }),
        ),
      )
      const workPlace = Option.map(snapshot, (found) => ({
        cwd: found.place.cwd,
        branch: found.place.branch,
      }))
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
              workPlace,
            })),
          ).pipe(
            Effect.map((admitted) =>
              Option.some({ round: admitted.round, number: admitted.number }),
            ),
          ),
      })
      const created = yield* create
      yield* ctx.State.changed().pipe(Effect.ignore)
      const result: StartResult = {
        thread: created.sessionId,
        sessionId: created.sessionId,
        branchId: created.branchId,
        ...omitUndefined({
          round: Option.getOrUndefined(round),
          workspace: Option.getOrUndefined(
            Option.map(snapshot, ({ place }) => ({
              path: place.cwd,
              branch: place.branch,
              ...omitUndefined({
                note: Option.getOrUndefined(
                  Option.liftPredicate(place.notes.join("; "), (note) => note.length > 0),
                ),
              }),
            })),
          ),
        }),
      }
      return result
    }),
  )
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

/** The copy a thread's session works in, for its round's text; none without `@gent/workspaces`. */
const workPlaceOf = Effect.fn("Threads.workPlaceOf")(function* (sessionId: SessionId) {
  const places = yield* Effect.serviceOption(Workspaces)
  if (Option.isNone(places)) return Option.none<WorkPlace>()
  const found = yield* places.value.find(sessionId)
  return Option.map(found, ({ cwd, branch }): WorkPlace => ({ cwd, branch }))
})

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
    Effect.map(workPlaceOf(found.current.id), (workPlace) => ({
      thread: found.thread,
      place: place.value,
      message: input.message,
      reply: Option.fromUndefinedOr(input.reply),
      notify: input.notify ?? "user",
      workPlace,
    })),
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
  /** Who hears its end. */
  notify: RoundNotify,
  status: Schema.Literals(["open", "ended"]),
  text: Schema.String,
  reply: Schema.NullOr(Schema.Json),
  replyAsked: Schema.Boolean,
  interrupted: Schema.Boolean,
  streamFailed: Schema.Boolean,
  unanswered: Schema.Boolean,
  /** A thread.stop, or the starter's interrupt, closed the round. */
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
  notify: round.notify,
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
  /**
   * The open round the stop asked to cancel. It is closed when the stop
   * returns, unless its turn holds out: then it stays open, stopped, until
   * that turn ends.
   */
  round: Schema.optionalKey(Schema.String),
})

/**
 * How long a stop waits for the stopped turn's own end. A turn stops at its
 * next await; one that holds out past this (an uninterruptible tool finishing
 * its own work) keeps its round open, stopped, and the turn's end closes it.
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
 * stopped or not), so the stop waits for it while the turn runs, unless the
 * round already ended. A round whose turn already ended is recorded from its
 * receipt, and one whose turn never reached the branch is closed here with
 * no bill. A turn that reached the branch and holds out past `STOP_SETTLE`
 * (an uninterruptible tool finishing its own work) keeps its round open,
 * stopped: its end records the round, bill and all, when it comes.
 */
const settleStopped = Effect.fn("Threads.settleStopped")(function* (
  round: RoundRow,
  ends: PubSub.Subscription<RoundEnded>,
  running: boolean,
) {
  const rounds = yield* ThreadRounds
  const reread = Effect.map(
    rounds.round(round.round),
    Option.getOrElse(() => round),
  )
  const before = yield* reread
  if (Predicate.isNotNull(before.ended_at)) return
  if (running) yield* Effect.timeoutOption(nextEndOf(ends, round.round), STOP_SETTLE)
  const current = yield* reread
  if (Predicate.isNotNull(current.ended_at)) return
  const recorded = yield* recordedOutcome(current)
  if (Option.isSome(recorded)) return yield* endRound(current, recorded.value)
  if (yield* admitted(current)) return
  yield* endRound(current, stoppedOutcome)
})

/** Stops the round's own turn, queued or running; true when the stop reached it. */
const stopRoundTurn = Effect.fn("Threads.stopRoundTurn")(function* (
  round: RoundRow,
  requestId: RequestId,
) {
  const ctx = yield* ExtensionContext
  return yield* ctx.Session.stopMessage({
    sessionId: SessionId.make(round.session_id),
    branchId: BranchId.make(round.branch_id),
    messageId: MessageId.make(round.message_id),
    requestId,
  })
})

/**
 * Stops every turn the thread runs now, and closes its open round as
 * interrupted. The round is marked stopped first, so its end wakes nobody,
 * and the stop returns once the round is closed, or once `STOP_SETTLE`
 * passed while its turn holds out (the turn's end closes it). `key` names a
 * repeat of the same stop.
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
        reached = yield* stopRoundTurn(
          open.value,
          RequestId.make(`thread-stop:${open.value.round}`),
        )
      }
      const stopped = yield* Effect.forEach(found.working, (loop) =>
        Effect.gen(function* () {
          // The id names this call and the loop it stops. A tool call id is
          // unique only in its session and may be long (a cell op's is 69
          // characters), so it is digested with the rest, as a start's is,
          // and the id keeps inside a request id's 128 characters.
          const requestId = yield* Effect.transposeOption(
            Option.map(key, (id) =>
              Effect.map(
                identityDigest("thread.stop", [id, loop.sessionId, loop.branchId].join("\n")),
                (digest) => RequestId.make(`thread-stop:${digest.slice(0, 32)}`),
              ),
            ),
          )
          yield* ctx.Session.stop({
            sessionId: loop.sessionId,
            branchId: loop.branchId,
            ...omitUndefined({ requestId: Option.getOrUndefined(requestId) }),
          })
          return { sessionId: loop.sessionId, branchId: loop.branchId }
        }),
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
    /**
     * A thread's latest round, open or ended, or with `ended` its latest
     * ended one; none for a thread that took no round. By the thread's key
     * alone, for a reader that lists every session (the agents view).
     */
    lastRound: (thread: string, options: { readonly ended: boolean }) =>
      Effect.map(rounds.latestRound(thread, options.ended), Option.map(roundView)),
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
 * `subscribeRoundEnds`. Read it with `Effect.serviceOption`, as threads
 * read `Workspaces`.
 *
 * @effect-expect-leaking ExtensionContext | Path | Crypto | FileSystem | ChildProcessSpawner
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
    'Start a thread: a new session of its own beside you, and return at admission, never its answer. With a task, the task is its first round; without one, it waits for thread.send. By default its replies go to the user in that thread and nothing wakes you; with notify "starter" a round\'s end arrives as a message that wakes you with the thread\'s answer. For a subagent on one task: agent "delegate", notify "starter".',
  promptSnippet: "Start a thread: a subagent, side work, or a long-lived worker",
  promptGuidelines: [
    'Delegate independent, self-contained work with agent "delegate" and notify "starter"; do a single read, search or edit yourself. A thread has no conversation history: give it the whole task, or fork: true when it needs what you already read or decided.',
    "Start every independent thread from one cell, then end your turn. Do not poll, set an alarm or set a monitor for a thread: each round's end wakes you as a message, and several may arrive over several turns.",
    'Interrupting your turn stops every notify "starter" round you are waiting for. A new call starts new work: do not repeat a start to recover an unknown outcome; thread.list shows the threads you started.',
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
  /** The thread's latest ended round: how its turn ended, and whether a stop closed it. */
  lastRound: Schema.optionalKey(
    Schema.Struct({
      ...RoundHandle.fields,
      interrupted: Schema.Boolean,
      streamFailed: Schema.Boolean,
      unanswered: Schema.Boolean,
      stopped: Schema.Boolean,
    }),
  ),
  /** The current session's latest reply: one line, or for one named thread its head and tail. */
  preview: Schema.String,
  /**
   * The account (credential label) the current session runs on. Absent
   * until the session has a pin or its last step's receipt names an
   * account; a placement alone names none. Flat, as every row field is: the
   * row's type renders whole within the cell's signature bound.
   */
  account: Schema.optionalKey(Schema.String),
  /** How the session came to that account: its pin, its placement, or the walk of its order. */
  placement: Schema.optionalKey(SessionAccount.fields.placement),
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
    "List the threads this thread started, from any of its sessions: each one's status, its open round, its last ended round and how it ended, its current session, the account it runs on, and its latest reply. A snapshot; do not call it in a loop to wait for a thread.",
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
        const last = yield* rounds.latestRound(entry.thread, true)
        // The branch's durable history, folded as it streams: the account its steps went out on.
        const metrics = yield* ctx.Session.events({ sessionId: current.id, branchId }).pipe(
          Stream.takeUntil((event) => event._tag === "StreamSynchronized"),
          Stream.runFold(() => initialSessionMetrics, stepSessionMetrics),
        )
        const account = sessionAccount(Option.fromUndefinedOr(current.admission), metrics)
        const row: typeof ThreadRow.Type = {
          thread: entry.thread,
          name: current.name ?? "",
          sessions: entry.sessions.length,
          current: { sessionId: current.id, branchId },
          status: threadStatus(entry),
          preview,
          ...omitUndefined({
            agent: current.admission?.agent,
            account: Option.getOrUndefined(Option.map(account, (found) => found.slot)),
            placement: Option.getOrUndefined(Option.map(account, (found) => found.placement)),
            openRound: Option.getOrUndefined(
              Option.map(open, (round) => ({ round: round.round, number: round.number })),
            ),
            lastRound: Option.getOrUndefined(
              Option.map(last, (round) => ({
                round: round.round,
                number: round.number,
                interrupted: round.interrupted === 1,
                streamFailed: round.stream_failed === 1,
                unanswered: round.unanswered === 1,
                stopped: Predicate.isNotNull(round.stopped_at),
              })),
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
    "Stop a thread this thread started, from any of its sessions: it asks every turn the thread runs now to end as interrupted, and cancels its open round. A round whose turn holds out (a tool finishing its own work) stays open until that turn ends. An idle thread is left as it is.",
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

/**
 * The sessions section's lines for the thread tools, shown only where
 * `thread.start` is admitted: an agent that cannot start threads pays nothing
 * for them in its cached prompt. A section, not tool guidelines: in a cell
 * turn the model sees only the cell tool, and tool guidelines stay behind
 * `tools(id)`.
 */
export const THREAD_LINES = [
  '- Delegate independent, self-contained work to threads: thread.start with agent "delegate" and notify "starter", each from one cell when you work in one, then end your turn. Each round\'s end arrives as a message that wakes you with the answer; do not poll for it. Do a single read, lookup, edit or command yourself.',
  '- A thread has no conversation history, so give it a whole task; fork: true starts it from your context. workspace { snapshot: true } runs it in its own copy of the working tree, and its work comes back as a branch. Your interrupt stops the notify "starter" rounds you wait for. A new call starts new work.',
  '- A thread can also be unrelated side work, or a long-lived worker (agent "worker"): thread.send gives it rounds, one at a time. A round\'s replies go to the user unless you send it with notify "starter"; thread.round reads its text and reply.',
  "- thread.list shows the threads you started, whether each runs, and its last round; read_session reads one in full, and thread.stop stops it. Check on a thread only when the user asks or your work depends on it.",
]

/** A hook step that fails logs and ends; the next loop open reconciles what it left. */
const removeSessionRounds = Effect.fn("Threads.sessionDeleted")(function* (sessionId: SessionId) {
  const rounds = yield* ThreadRounds
  yield* rounds.removeSession(sessionId)
})

/**
 * The threads' part of `@gent/session-tools`: the delegate and worker
 * agents, the tools, the round table, and the hooks that end, deliver,
 * stop and reconcile rounds. Threads share that extension's id, so a
 * thread's messages carry it. Its `turnAfter` hook comes before
 * session-tools' own, so the interrupt stops a starter's rounds before its
 * `session.send` corrections: a correction that a stopped round took with it
 * is named once, under the stopped threads.
 */
export const registerThreads = (host: ExtensionHostService) =>
  Effect.gen(function* () {
    yield* host.register("agent", delegateAgent, workerAgent)
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
    // Every turn end is read three times: as a thread's round end, as a
    // starter's interrupt, and as a starter's answer that read its notices.
    // Each read fails alone, and a failure has the next turn reconcile.
    yield* host.on("turnAfter", (input) =>
      Effect.all(
        [
          onRoundTurnAfter(input).pipe(logFailure("threads.round-end.failed")),
          stopStarterRounds(input).pipe(logFailure("threads.interrupt.failed")),
          clearReadStopNotices(input).pipe(logFailure("threads.stop-notices.clear.failed")),
        ],
        { discard: true },
      ),
    )
    // A restart leaves a round mid-turn, or ended with no record or no
    // delivery. The loop open of its starter's thread, or of the thread, picks it up.
    yield* host.on("loopOpen", () => reconcileOnOpen.pipe(logFailure("threads.reconcile.failed")))
    // A failed hook step left something for a starter it could not name: each
    // branch's next turn reconciles once more, then reads its stop notices.
    yield* host.on("turnProjection", () =>
      reconcileOnce.pipe(
        logFailure("threads.reconcile.failed"),
        Effect.andThen(
          stopNotices().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("threads.stop-notices.read.failed").pipe(
                Effect.annotateLogs({ cause: Cause.pretty(cause) }),
                Effect.as([]),
              ),
            ),
          ),
        ),
        Effect.map((notices) => ({ notices })),
      ),
    )
    yield* host.on("sessionDeleted", ({ sessionId }) => removeSessionRounds(sessionId))
  })
