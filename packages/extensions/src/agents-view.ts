import { Context, Effect, FiberMap, Layer, Option, Order, Ref, Schema, Stream } from "effect"
import {
  type AgentEvent,
  BranchId,
  defineExtension,
  defineResource,
  defineRequests,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  headChars,
  isSpawnedSession,
  request,
  SessionId,
  sessionThread,
  tailChars,
} from "@gent/core/extensions/api"
import { DELEGATE_AGENT_NAME } from "./delegate.js"
import { openQuestionCount } from "./interaction-tools.js"

// Test seam: only tests read these exports. The row shapes (LiveAgentRow,
// DurableAgentRow, AgentRow) and the row functions (rowKey, sectionOf,
// reconcileAgentRows, buildRowTree, projectAgentRows) and the activity fold
// (emptyActivity, foldActivity, activityOf) are pure with unit tests.
// AgentActivity and AgentActivityLive let a test run the activity service.

// ── projection ──────────────────────────────────────────────────────────────

/**
 * Pure projection for the agents view.
 *
 * This section has no TUI imports, no I/O and no Effect services: plain
 * functions over plain data, so the reconciliation can be tested without a
 * terminal or a runtime. The `AgentActivity` service and the `ListAgents`
 * request later in this file feed it.
 *
 * The load-bearing piece is {@link reconcileAgentRows}. Rows come from two
 * catalogs that disagree by design:
 *
 *   - **live** — materialized actor loops. Carries status and metrics, but is
 *     empty after a restart and omits idle or evicted branches.
 *   - **durable** — session storage. Survives restarts and covers every agent,
 *     but knows nothing about what is running now.
 *
 * A live row and a durable row for the same `(sessionId, branchId)` are the
 * same agent. Live data wins on conflict; durable data supplies the rest.
 *
 * @module
 */

/**
 * Section an agent row is grouped under, in display order. `needs`: the loop
 * waits on the reader, on an ask or a background question it left open.
 */
type AgentSection = "needs" | "running" | "idle" | "inactive"

/** Identity of one agent loop. One session with three branches is three rows. */
interface AgentRowKey {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

/** A materialized loop, from `ExtensionContext.Session.listActiveLoops`, with its registered state. */
export interface LiveAgentRow {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /**
   * Runtime state tag, e.g. `"Idle"` / `"Running"` / `"WaitingForInteraction"`.
   *
   * `None` when the loop is materialized but its state read failed; such a
   * loop counts as idle rather than running.
   */
  readonly status: Option.Option<string>
  /** When the current turn began; `None` while idle or when the state read failed. */
  readonly runningSince: Option.Option<number>
  /** Background questions (`ask_user_async`) the branch holds open for the reader. */
  readonly openQuestions: number
}

/** A stored session branch, from session storage. Survives restarts. */
export interface DurableAgentRow {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: Option.Option<string>
  readonly cwd: Option.Option<string>
  readonly parent: Option.Option<AgentRowKey>
  readonly createdAt: number
  readonly updatedAt: number
  /** Spawned beside its parent's work (a delegate child or a `/btw` fork), not a handoff. */
  readonly sideThread: boolean
  /** The thread key (`sessionThread`): a handoff chain shares its first session's id. */
  readonly thread: SessionId
  /** A delegate child: its completion lands in its parent's transcript. */
  readonly delegate: boolean
}

/** One reconciled row, ready for display. */
export interface AgentRow {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly section: AgentSection
  readonly status: Option.Option<string>
  readonly name: Option.Option<string>
  readonly cwd: Option.Option<string>
  /** When the session was created: a stable order for rows that change on every read. */
  readonly createdAt: Option.Option<number>
  readonly updatedAt: Option.Option<number>
  /** When the live loop's current turn began: a woken child's run time, not its age. */
  readonly runningSince: Option.Option<number>
  /** Background questions its live loops hold open; a thread counts every member's. */
  readonly openQuestions: number
  readonly parent: Option.Option<AgentRowKey>
  /** True when the loop is materialized right now. */
  readonly live: boolean
  /** Depth in the parent/child tree; 0 for a top-level agent. */
  readonly depth: number
  /** From the durable row; a loop with no session row yet is not marked. */
  readonly sideThread: boolean
  /** The thread key, from the durable row; `None` for a loop with no session row yet. */
  readonly thread: Option.Option<SessionId>
  /** From the durable row; a loop with no session row yet is not marked. */
  readonly delegate: boolean
  /**
   * The loops this row stands for, oldest first. One for a loop; a thread's
   * sessions after `buildRowTree` folds them, the row's own ids the newest's.
   */
  readonly members: ReadonlyArray<AgentRowKey>
}

/**
 * Stable identity for a loop. `(sessionId, branchId)` — never session alone.
 *
 * Length-prefixed rather than delimiter-joined: ids are opaque strings, so any
 * separator could itself appear inside one and make two distinct loops collide.
 */
export const rowKey = (key: AgentRowKey): string =>
  `${key.sessionId.length}:${key.sessionId}:${key.branchId}`

/**
 * Which section a row belongs to. Anything only in durable storage is inactive.
 *
 * A loop that waits on the reader needs them: one parked on an ask, or one
 * that left a background question open, whether its turn still runs or not.
 * A stored session's questions wait for its loop to open.
 *
 * A materialized loop whose status was not read counts as **idle**, not
 * running: being resident is not the same as working, and claiming otherwise
 * leaves every live loop stuck in `running` forever. Only a status that says
 * so puts a row in `running`.
 */
export const sectionOf = (live: Option.Option<LiveAgentRow>): AgentSection =>
  Option.match(live, {
    onNone: () => "inactive",
    onSome: (row) => {
      if (row.openQuestions > 0 || Option.contains(row.status, "WaitingForInteraction"))
        return "needs"
      return Option.match(row.status, {
        onNone: () => "idle",
        onSome: (status) => {
          if (status === "Idle") return "idle"
          return "running"
        },
      })
    },
  })

const SECTION_ORDER = { needs: 0, running: 1, idle: 2, inactive: 3 } satisfies Record<
  AgentSection,
  number
>

/**
 * Merge the live and durable catalogs into one row per loop.
 *
 * Live data wins where the two overlap, because it reflects the loop as it is
 * now. Durable data supplies name, cwd, and parent links, which the actor
 * registry does not carry. A live row with no durable counterpart still
 * appears — a brand-new loop must not be invisible until its session row is
 * written.
 */
export const reconcileAgentRows = (params: {
  readonly live: ReadonlyArray<LiveAgentRow>
  readonly durable: ReadonlyArray<DurableAgentRow>
}): ReadonlyArray<AgentRow> => {
  const liveByKey = new Map<string, LiveAgentRow>()
  for (const row of params.live) liveByKey.set(rowKey(row), row)
  const durableByKey = new Map<string, DurableAgentRow>()
  for (const row of params.durable) durableByKey.set(rowKey(row), row)

  const rows: Array<AgentRow> = []
  for (const key of new Set([...liveByKey.keys(), ...durableByKey.keys()])) {
    const live = Option.fromUndefinedOr(liveByKey.get(key))
    const durable = Option.fromUndefinedOr(durableByKey.get(key))
    // Keys come from the union of both maps, so at least one side is present.
    const identity = Option.orElse(
      Option.map(live, (row) => ({ sessionId: row.sessionId, branchId: row.branchId })),
      () => Option.map(durable, (row) => ({ sessionId: row.sessionId, branchId: row.branchId })),
    )
    if (Option.isNone(identity)) continue
    rows.push({
      sessionId: identity.value.sessionId,
      branchId: identity.value.branchId,
      section: sectionOf(live),
      status: Option.flatMap(live, (row) => row.status),
      name: Option.flatMap(durable, (row) => row.name),
      cwd: Option.flatMap(durable, (row) => row.cwd),
      createdAt: Option.map(durable, (row) => row.createdAt),
      updatedAt: Option.map(durable, (row) => row.updatedAt),
      runningSince: Option.flatMap(live, (row) => row.runningSince),
      openQuestions: Option.match(live, { onNone: () => 0, onSome: (row) => row.openQuestions }),
      parent: Option.flatMap(durable, (row) => row.parent),
      live: Option.isSome(live),
      depth: 0,
      sideThread: Option.exists(durable, (row) => row.sideThread),
      thread: Option.map(durable, (row) => row.thread),
      delegate: Option.exists(durable, (row) => row.delegate),
      members: [identity.value],
    })
  }
  return rows
}

/** Oldest first; the row key breaks a tie, so the order is total. */
const byStart = (left: AgentRow, right: AgentRow) => {
  const start =
    Option.getOrElse(left.createdAt, () => 0) - Option.getOrElse(right.createdAt, () => 0)
  if (start !== 0) return start
  return Order.String(rowKey(left), rowKey(right))
}

/** The first row of `rows` under `order`, or `seed` when none comes before it. */
const firstBy = (
  seed: AgentRow,
  rows: ReadonlyArray<AgentRow>,
  order: (left: AgentRow, right: AgentRow) => number,
): AgentRow =>
  rows.reduce((best, row) => {
    if (order(row, best) < 0) return row
    return best
  }, seed)

/** A known ask or an open question needs attention even while another member works. */
const attentionOrder = (row: AgentRow): number => {
  if (row.section === "inactive") return 4
  if (row.section === "needs") return 0
  if (Option.contains(row.status, "Running")) return 1
  if (!Option.contains(row.status, "Idle")) return 2
  return 3
}

/**
 * One row for the sessions of one thread. The newest session is the thread's
 * current one: the row takes its ids, name, cwd and liveness, so opening the
 * row opens it. The status is the most active session's, the start and the
 * place in the tree (parent, side-thread mark) the first session's, and the
 * last update the latest of any.
 */
const foldThread = (seed: AgentRow, others: ReadonlyArray<AgentRow>): AgentRow => {
  if (others.length === 0) return seed
  const all = [seed, ...others]
  const first = firstBy(seed, all, byStart)
  const current = firstBy(seed, all, (left, right) => byStart(right, left))
  const busiest = firstBy(
    seed,
    all,
    (left, right) => attentionOrder(left) - attentionOrder(right) || byStart(right, left),
  )
  const stamps = all.flatMap((row) => Option.toArray(row.updatedAt))
  return {
    ...current,
    section: busiest.section,
    status: busiest.status,
    runningSince: busiest.runningSince,
    openQuestions: all.reduce((sum, row) => sum + row.openQuestions, 0),
    createdAt: first.createdAt,
    updatedAt: Option.map(
      Option.liftPredicate(stamps, (values) => values.length > 0),
      (values) => Math.max(...values),
    ),
    parent: first.parent,
    sideThread: first.sideThread,
    members: all.toSorted(byStart).map((row) => ({
      sessionId: row.sessionId,
      branchId: row.branchId,
    })),
  }
}

/**
 * Fold each thread's sessions (a handoff chain) into one row. A loop with no
 * session row has no key and stays its own row. A parent link keeps the
 * persisted parent; `buildRowTree` nests a child of an older session under
 * its thread's row through the row's members.
 */
const groupThreads = (rows: ReadonlyArray<AgentRow>): ReadonlyArray<AgentRow> => {
  const groups = new Map<string, { readonly seed: AgentRow; readonly others: Array<AgentRow> }>()
  for (const row of rows) {
    const key = Option.match(row.thread, {
      onNone: () => `loop ${rowKey(row)}`,
      onSome: (thread) => `thread ${thread}`,
    })
    Option.match(Option.fromUndefinedOr(groups.get(key)), {
      onNone: () => groups.set(key, { seed: row, others: [] }),
      onSome: (group) => group.others.push(row),
    })
  }
  return Array.from(groups.values(), (group) => foldThread(group.seed, group.others))
}

/**
 * Order rows for display: one row per thread, by section, and in each
 * section as a tree. The sessions of one thread (a handoff chain) fold into
 * one row first; a spawned session is a thread of its own and nests under
 * the session that started it. A root,
 * or a row whose parent is in another section, is placed by its last update,
 * most recent first, at depth 0; its children follow it one level deeper, in
 * the order they started, as the tray lists them, so a child's steps never
 * reshuffle its siblings. Depth is the nesting as drawn, so a row is never
 * indented under a row that is not its parent.
 *
 * A child whose parent is absent from the row set is promoted to top level
 * rather than hidden — an orphan is still a real agent, and dropping it would
 * make work disappear from the view. Rows on a parent cycle are placed as
 * roots.
 */
export const buildRowTree = (loops: ReadonlyArray<AgentRow>): ReadonlyArray<AgentRow> => {
  const rows = groupThreads(loops)
  const byKey = new Map<string, AgentRow>()
  for (const row of rows) byKey.set(rowKey(row), row)
  // Each session of a thread stands for the thread's row, so a child of an
  // older session nests under the thread.
  const rowOfMember = new Map<string, string>()
  for (const row of rows) {
    for (const member of row.members) rowOfMember.set(rowKey(member), rowKey(row))
  }

  const byRecency = (left: AgentRow, right: AgentRow) => {
    const recency =
      Option.getOrElse(right.updatedAt, () => 0) - Option.getOrElse(left.updatedAt, () => 0)
    if (recency !== 0) return recency
    return Order.String(rowKey(left), rowKey(right))
  }
  // The parent a row nests under here: one in the same section.
  const parentKeyOf = (row: AgentRow): Option.Option<string> =>
    Option.map(row.parent, (parent) => rowOfMember.get(rowKey(parent)) ?? rowKey(parent)).pipe(
      Option.filter((key) => byKey.get(key)?.section === row.section),
    )
  const children = new Map<string, Array<AgentRow>>()
  for (const row of rows) {
    const parentKey = parentKeyOf(row)
    if (Option.isNone(parentKey)) continue
    children.set(parentKey.value, [...(children.get(parentKey.value) ?? []), row])
  }

  const ordered: Array<AgentRow> = []
  const seen = new Set<string>()
  const visit = (row: AgentRow, depth: number): void => {
    const key = rowKey(row)
    if (seen.has(key)) return
    seen.add(key)
    ordered.push({ ...row, depth })
    for (const child of (children.get(key) ?? []).toSorted(byStart)) visit(child, depth + 1)
  }
  const sectionRank = (row: AgentRow) => SECTION_ORDER[row.section]
  const bySectionThenRecency = (left: AgentRow, right: AgentRow) =>
    sectionRank(left) - sectionRank(right) || byRecency(left, right)
  for (const root of rows
    .filter((row) => Option.isNone(parentKeyOf(row)))
    .toSorted(bySectionThenRecency)) {
    visit(root, 0)
  }
  // A cycle has no root to reach it from.
  for (const row of rows.toSorted(bySectionThenRecency)) visit(row, 0)
  return ordered.toSorted((left, right) => sectionRank(left) - sectionRank(right))
}

/** Case-insensitive substring match over the fields a reader would search by. */
export const filterRows = (
  rows: ReadonlyArray<AgentRow>,
  query: string,
): ReadonlyArray<AgentRow> => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return rows
  return rows.filter((row) => {
    const fields = [
      Option.getOrElse(row.name, () => ""),
      Option.getOrElse(row.cwd, () => ""),
      row.sessionId,
      row.branchId,
      // An older session of the thread finds the thread's row.
      ...row.members.map((member) => member.sessionId),
    ]
    return fields.some((field) => field.toLowerCase().includes(needle))
  })
}

/**
 * Full projection: reconcile, then order. A row's section is its own loop's
 * state, so a parent idles in its own section while a child works, and the
 * child is a root of the running section. A query filters after, with `filterRows`.
 */
export const projectAgentRows = (params: {
  readonly live: ReadonlyArray<LiveAgentRow>
  readonly durable: ReadonlyArray<DurableAgentRow>
}): ReadonlyArray<AgentRow> => buildRowTree(reconcileAgentRows(params))

// ── live activity ───────────────────────────────────────────────────────────

/**
 * The input fields that say what a call works on, bounded: the first line of
 * a command, a path or a pattern, and a cell's source, whose calls the client
 * reads as verbs. The client words the call, as its own live line words one;
 * the server sends no words of its own.
 */
const ActivityInput = Schema.Struct({
  command: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
})
type ActivityInput = typeof ActivityInput.Type
const decodeActivityInput = Schema.decodeUnknownOption(ActivityInput)

/** A running call as the tray reads it: its tool and what it works on. */
const RunningCall = Schema.Struct({ tool: Schema.String, input: ActivityInput })
type RunningCall = typeof RunningCall.Type

/**
 * What a running loop is doing now, folded from its event stream: the calls
 * still running, in start order, and the reply text streamed since its step began.
 */
interface ActivityFold {
  readonly tools: ReadonlyArray<{ readonly id: string; readonly call: RunningCall }>
  readonly partial: string
}

/** Characters of the streamed line, and of a call's command, path or pattern, the tray keeps. */
const ACTIVITY_CHARS = 80

/** Characters of a cell's source the tray keeps: enough for the calls it opens with. */
const CELL_CODE_CHARS = 2_000

/** The first non-empty line of `text`, bounded. */
const firstLine = (text: string) =>
  headChars(text.trim().split("\n")[0]?.trim() ?? "", ACTIVITY_CHARS)

/** The fields of a call's input that the tray reads, each bounded; the rest stay on the server. */
const boundedInput = (input: Option.Option<ActivityInput>): ActivityInput => {
  const fields = Option.getOrElse(input, (): ActivityInput => ({}))
  const bound = (value: Option.Option<string>, cut: (text: string) => string) =>
    Option.getOrUndefined(Option.map(value, cut))
  return {
    command: bound(Option.fromUndefinedOr(fields.command), firstLine),
    path: bound(Option.fromUndefinedOr(fields.path), firstLine),
    pattern: bound(Option.fromUndefinedOr(fields.pattern), firstLine),
    code: bound(Option.fromUndefinedOr(fields.code), (code) => headChars(code, CELL_CODE_CHARS)),
  }
}

export const emptyActivity: ActivityFold = { tools: [], partial: "" }

export const foldActivity = (state: ActivityFold, event: AgentEvent): ActivityFold => {
  switch (event._tag) {
    case "StreamStarted":
      return { ...state, partial: "" }
    case "StreamChunk":
      return { ...state, partial: tailChars(state.partial + event.chunk, 4 * ACTIVITY_CHARS) }
    case "ToolCallStarted":
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            id: event.toolCallId,
            call: { tool: event.toolName, input: boundedInput(decodeActivityInput(event.input)) },
          },
        ],
      }
    case "ToolCallSucceeded":
    case "ToolCallFailed":
      return { ...state, tools: state.tools.filter((tool) => tool.id !== event.toolCallId) }
    case "TurnCompleted":
      return emptyActivity
    default:
      return state
  }
}

/** What a running loop does now: its last streamed line and its newest running call. */
const Activity = Schema.Struct({
  line: Schema.optional(Schema.String),
  call: Schema.optional(RunningCall),
})
type Activity = typeof Activity.Type

/** The loop's last streamed line and newest running call; none when it shows neither. */
export const activityOf = (state: ActivityFold): Option.Option<Activity> => {
  const line = Option.fromUndefinedOr(
    state.partial
      .split("\n")
      .map((text) => text.trim())
      .findLast((text) => text.length > 0),
  ).pipe(Option.map((text) => headChars(text, ACTIVITY_CHARS)))
  const call = Option.map(Option.fromUndefinedOr(state.tools.at(-1)), (tool) => tool.call)
  if (Option.isNone(line) && Option.isNone(call)) return Option.none()
  return Option.some({ line: Option.getOrUndefined(line), call: Option.getOrUndefined(call) })
}

interface AgentActivityService {
  /**
   * Watch the `watch` loops: start a watcher for each key not watched yet,
   * and stop the watchers of loops missing from `listed`, the runtime's whole
   * listing as the caller just read it. A watcher reads its loop's events for
   * as long as the loop is listed, so each turn's start comes from the loop
   * itself, never from a listing: the first line of a turn is never missed.
   * Each turn's end clears its line. Only the runtime listing stops a
   * watcher, never a caller's filtered rows, so a filtered listing, or a TUI
   * in another workspace, cannot blank the tray.
   */
  readonly follow: (loops: {
    readonly listed: ReadonlyArray<AgentRowKey>
    readonly watch: ReadonlyArray<AgentRowKey>
  }) => Effect.Effect<void, never, ExtensionContext>
  readonly read: (key: AgentRowKey) => Effect.Effect<Option.Option<Activity>>
}

/**
 * Process-scoped watchers of listed child loops. A watcher reads the loop's
 * events from now through `ExtensionContext.Session.events`, the same verb
 * any extension has, and folds them into one line per loop. The resource
 * scope owns the fibers, so shutdown stops them.
 */
export class AgentActivity extends Context.Service<AgentActivity, AgentActivityService>()(
  "@gent/extensions/src/agents-view/AgentActivity",
) {}

export const AgentActivityLive: Layer.Layer<AgentActivity> = Layer.effect(
  AgentActivity,
  Effect.gen(function* () {
    const watchers = yield* FiberMap.make<string, void>()
    const folds = yield* Ref.make<ReadonlyMap<string, ActivityFold>>(new Map())
    const setFold = (key: string, change: (fold: ActivityFold) => ActivityFold) =>
      Ref.update(folds, (all) => {
        const next = new Map(all)
        next.set(key, change(all.get(key) ?? emptyActivity))
        return next
      })
    const watchOne = (loop: AgentRowKey) =>
      Effect.gen(function* () {
        const ctx = yield* ExtensionContext
        const key = rowKey(loop)
        // From now: the fold needs only what the loop does next, so a
        // watcher never replays the child's whole history. A turn's end
        // empties the fold, and the next turn's events refill it.
        yield* ctx.Session.events({ ...loop, from: "now" }).pipe(
          Stream.runForEach((event) => setFold(key, (fold) => foldActivity(fold, event))),
          Effect.catchCause((cause) =>
            Effect.logWarning("agents-view.activity.watch-failed").pipe(
              Effect.annotateLogs({ sessionId: loop.sessionId, error: String(cause) }),
            ),
          ),
          Effect.ensuring(
            Ref.update(folds, (all) => {
              const next = new Map(all)
              next.delete(key)
              return next
            }),
          ),
        )
      })
    return AgentActivity.of({
      follow: (loops) =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          // A loop the runtime no longer lists has nothing more to report.
          const listed = new Set(loops.listed.map(rowKey))
          for (const [key] of Array.from(watchers)) {
            if (!listed.has(key)) yield* FiberMap.remove(watchers, key)
          }
          for (const loop of loops.watch) {
            yield* FiberMap.run(
              watchers,
              rowKey(loop),
              watchOne(loop).pipe(Effect.provideService(ExtensionContext, ctx)),
              { onlyIfMissing: true },
            )
          }
        }),
      read: (key) =>
        Ref.get(folds).pipe(
          Effect.map((all) =>
            Option.flatMap(Option.fromUndefinedOr(all.get(rowKey(key))), activityOf),
          ),
        ),
    })
  }),
)

const AgentActivityResource = defineResource({
  id: "@gent/agents-view/activity",
  scope: "process",
  layer: AgentActivityLive,
})

// ── protocol ────────────────────────────────────────────────────────────────

/**
 * Agents view — the wire contract between the two halves. The client half
 * imports the row schema and the capability ref from here through
 * `client.ts`; `defineRequests` binds the extension id before either half
 * runs.
 */

const AGENTS_VIEW_EXTENSION_ID = ExtensionId.make("@gent/agents-view")

/**
 * Wire shape for one row.
 *
 * `Option` fields flatten to optional keys: the projection's `Option` is an
 * in-process representation, not a transport one.
 */
export const AgentRowEntry = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  section: Schema.Literals(["needs", "running", "idle", "inactive"]),
  status: Schema.optional(Schema.String),
  /** Background questions the row's live loops hold open. Absent at none. Wire only. */
  openQuestions: Schema.optional(Schema.Finite),
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Finite),
  updatedAt: Schema.optional(Schema.Finite),
  /** When a running loop's current turn began (epoch ms). Absent while idle. */
  runningSince: Schema.optional(Schema.Finite),
  live: Schema.Boolean,
  depth: Schema.Finite,
  /**
   * The session this one was created from, as stored. Absent at a tree root.
   * When that session is an older one of a thread, the row it nests under is
   * the thread's row, whose `sessions` hold it.
   */
  parentSessionId: Schema.optional(SessionId),
  /** The session opened a thread of its own under a parent; a handoff shares its parent's. */
  sideThread: Schema.Boolean,
  /**
   * The thread's key: its first session's id. A handoff does not change it,
   * so a client follows one thread by it while the row's own ids move to the
   * newest session. Absent for a loop with no stored session.
   */
  thread: Schema.optional(SessionId),
  /**
   * A delegate child, whose completion lands in its parent's transcript; the
   * TUI gives it no done row. Absent for any other session.
   */
  delegate: Schema.optional(Schema.Literal(true)),
  /**
   * The sessions of this row's thread, oldest first, when it holds more than
   * one (a handoff chain). The row's own ids are the newest's.
   */
  sessions: Schema.optional(Schema.Array(SessionId)),
  /** A running loop's last streamed line. Wire only, never stored. */
  activity: Schema.optional(Schema.String),
  /**
   * A running loop's newest running call: its tool and what it works on,
   * which the client words as its live line does. Wire only, never stored.
   */
  runningCall: Schema.optional(RunningCall),
})
export type AgentRowEntry = typeof AgentRowEntry.Type

export const ListAgentsInput = Schema.Struct({
  /** Case-insensitive substring filter over name, cwd, and ids. */
  query: Schema.optional(Schema.String),
  /**
   * Only this session's thread and the sessions below it, at any depth: the
   * tray's read, whose cost follows the subtree rather than the workspace. A
   * handoff's listing so holds what the sessions it continues started. Absent,
   * the listing covers every session in the workspace.
   */
  root: Schema.optional(SessionId),
})
export type ListAgentsInput = typeof ListAgentsInput.Type

const ListAgentsOutput = Schema.Struct({
  rows: Schema.Array(AgentRowEntry),
})

/**
 * Join the live loop enumeration against durable session storage, before the
 * query filter: the whole workspace, or with a `root` only its thread's tree.
 *
 * Neither catalog is sufficient alone: the live one is empty after a restart,
 * and the durable one cannot say what is running. `projectAgentRows` above
 * reconciles the two. `listed` is the runtime's whole loop listing, whatever
 * the root, because only that listing may stop an activity watcher.
 */
const collectRows = Effect.fn("AgentsView.collectRows")(function* (root: Option.Option<SessionId>) {
  const ctx = yield* ExtensionContext

  // A catalog read that fails is a host defect, not something the caller can
  // recover from, so it dies rather than widening the capability's error type.
  const activeLoops = yield* ctx.Session.listActiveLoops.pipe(Effect.orDie)
  // A root stands for its whole thread: a handoff's listing holds what the
  // sessions it continues started, even with the thread's first session gone.
  const sessions = yield* ctx.Session.listSessions({ thread: Option.getOrUndefined(root) }).pipe(
    Effect.orDie,
  )
  const listed: ReadonlyArray<AgentRowKey> = activeLoops.map((loop) => ({
    sessionId: loop.sessionId,
    branchId: loop.branchId,
  }))

  // The live half. Status comes with the enumeration; metrics need a heavier
  // per-loop read (the client transport's `agentDetail`), which it makes for one
  // selected row at a time. Under a root, only the subtree's loops: a loop
  // with no stored session yet has no parent link to place it by.
  const inTree = new Set<string>(sessions.map((session) => session.id))
  const live: ReadonlyArray<LiveAgentRow> = yield* Effect.forEach(
    activeLoops.filter((loop) => Option.isNone(root) || inTree.has(loop.sessionId)),
    (loop) =>
      // A question file the store cannot read is the questions view's error
      // to show; here the loop counts none rather than failing the listing.
      openQuestionCount(loop.branchId).pipe(
        Effect.orElseSucceed(() => 0),
        Effect.map((openQuestions) => ({
          sessionId: loop.sessionId,
          branchId: loop.branchId,
          status: loop.status,
          runningSince: loop.runningSince,
          openQuestions,
        })),
      ),
    { concurrency: 8 },
  )

  // The durable half. One row per session, keyed to its active branch — a
  // session with no active branch has never run and has no loop to show.
  const durable: ReadonlyArray<DurableAgentRow> = sessions.flatMap((session) => {
    const branchId = Option.fromUndefinedOr(session.activeBranchId)
    if (Option.isNone(branchId)) return []
    const parent = Option.all([
      Option.fromUndefinedOr(session.parentSessionId),
      Option.fromUndefinedOr(session.parentBranchId),
    ]).pipe(Option.map(([sessionId, parentBranchId]) => ({ sessionId, branchId: parentBranchId })))
    return [
      {
        sessionId: session.id,
        branchId: branchId.value,
        name: Option.fromUndefinedOr(session.name),
        cwd: Option.fromUndefinedOr(session.cwd),
        parent,
        createdAt: session.createdAt.getTime(),
        updatedAt: session.updatedAt.getTime(),
        // A handoff joins its parent's thread. A delegate child or a `/btw` fork
        // has a parent and is the session its own thread is named after.
        // A session that names its parent without a branch gets no `parent`.
        sideThread: isSpawnedSession(session),
        thread: sessionThread(session),
        delegate: session.admission?.agent === DELEGATE_AGENT_NAME,
      },
    ]
  })

  return { loops: reconcileAgentRows({ live, durable }), listed }
})

export const AgentsViewRpc = defineRequests(AGENTS_VIEW_EXTENSION_ID, {
  ListAgents: request({
    id: "list-agents",
    description: "List agent loops, live and stored, as display rows",
    // The tray and pane read this while the session's own turn is running.
    answersDuringTurn: true,
    input: ListAgentsInput,
    output: ListAgentsOutput,
    resources: [AgentActivityResource],
    execute: Effect.fn("AgentsViewRpc.ListAgents")(function* (input) {
      const { loops, listed } = yield* collectRows(Option.fromUndefinedOr(input.root))
      const activity = yield* AgentActivity
      // Every live child read here is watched, working or idle, so its next
      // turn reports from its first event. A tree root is never in the tray.
      // The watch set comes from the loops before the query filter and before
      // a thread folds its sessions into one row; under a `root` it is that
      // subtree, which is all the caller shows. Only the runtime's whole
      // listing stops a watcher, never the rows read here.
      yield* activity.follow({
        listed,
        watch: loops.filter((row) => row.live && Option.isSome(row.parent)),
      })
      const rows = filterRows(buildRowTree(loops), input.query ?? "")
      const now = new Map<string, Activity>()
      for (const row of rows) {
        // A thread's row says what its newest working session does.
        for (const member of row.members.toReversed()) {
          const found = yield* activity.read(member)
          if (Option.isNone(found)) continue
          now.set(rowKey(row), found.value)
          break
        }
      }
      return {
        rows: rows.map((row) => ({
          sessionId: row.sessionId,
          branchId: row.branchId,
          section: row.section,
          status: Option.getOrUndefined(row.status),
          openQuestions: Option.getOrUndefined(
            Option.liftPredicate(row.openQuestions, (count) => count > 0),
          ),
          name: Option.getOrUndefined(row.name),
          cwd: Option.getOrUndefined(row.cwd),
          createdAt: Option.getOrUndefined(row.createdAt),
          updatedAt: Option.getOrUndefined(row.updatedAt),
          runningSince: Option.getOrUndefined(row.runningSince),
          live: row.live,
          depth: row.depth,
          parentSessionId: Option.getOrUndefined(
            Option.map(row.parent, (parent) => parent.sessionId),
          ),
          sideThread: row.sideThread,
          thread: Option.getOrUndefined(row.thread),
          delegate: Option.getOrUndefined(Option.liftPredicate(true as const, () => row.delegate)),
          sessions: Option.getOrUndefined(
            Option.liftPredicate(
              row.members.map((member) => member.sessionId),
              (ids) => ids.length > 1,
            ),
          ),
          activity: now.get(rowKey(row))?.line,
          runningCall: now.get(rowKey(row))?.call,
        })),
      }
    }),
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

/**
 * Agents view — the server half.
 *
 * The view is an extension of the loop, not core code and not app code.
 * This half contributes one `request` capability returning the
 * reconciled agent rows; the client half renders them.
 *
 * The wire contract and the reconciliation above are pure, so their
 * correctness is tested without a terminal.
 */

export const AgentsViewExtension = defineExtension({
  id: AGENTS_VIEW_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", AgentActivityResource)
    yield* host.register("request", AgentsViewRpc.ListAgents)
  }),
})
