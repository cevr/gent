import { Context, Effect, FiberMap, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  type AgentEvent,
  BranchId,
  defineExtension,
  defineResource,
  defineRequests,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  isSpawnedSession,
  request,
  SessionId,
} from "@gent/core/extensions/api"

// Test seam: only tests read these exports. The row shapes (LiveAgentRow,
// DurableAgentRow, AgentRow) and the row functions (rowKey, sectionOf,
// reconcileAgentRows, buildRowTree, projectAgentRows) and the activity fold
// (emptyActivity, foldActivity, activityText) are pure with unit tests.
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

/** Section an agent row is grouped under, in display order. */
type AgentSection = "running" | "idle" | "inactive"

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
  readonly parent: Option.Option<AgentRowKey>
  /** True when the loop is materialized right now. */
  readonly live: boolean
  /** Depth in the parent/child tree; 0 for a top-level agent. */
  readonly depth: number
  /** From the durable row; a loop with no session row yet is not marked. */
  readonly sideThread: boolean
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
 * A materialized loop whose status was not read counts as **idle**, not
 * running: being resident is not the same as working, and claiming otherwise
 * leaves every live loop stuck in `running` forever. Only a status that says
 * so puts a row in `running`.
 */
export const sectionOf = (live: Option.Option<LiveAgentRow>): AgentSection =>
  Option.match(live, {
    onNone: () => "inactive",
    onSome: (row) =>
      Option.match(row.status, {
        onNone: () => "idle",
        onSome: (status) => {
          if (status === "Idle") return "idle"
          return "running"
        },
      }),
  })

const SECTION_ORDER = { running: 0, idle: 1, inactive: 2 } satisfies Record<AgentSection, number>

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
      parent: Option.flatMap(durable, (row) => row.parent),
      live: Option.isSome(live),
      depth: 0,
      sideThread: Option.exists(durable, (row) => row.sideThread),
    })
  }
  return rows
}

/**
 * Order rows for display: by section, and in each section as a tree. A root,
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
export const buildRowTree = (rows: ReadonlyArray<AgentRow>): ReadonlyArray<AgentRow> => {
  const byKey = new Map<string, AgentRow>()
  for (const row of rows) byKey.set(rowKey(row), row)

  const byRecency = (left: AgentRow, right: AgentRow) => {
    const recency =
      Option.getOrElse(right.updatedAt, () => 0) - Option.getOrElse(left.updatedAt, () => 0)
    if (recency !== 0) return recency
    return rowKey(left).localeCompare(rowKey(right))
  }
  const byStart = (left: AgentRow, right: AgentRow) => {
    const start =
      Option.getOrElse(left.createdAt, () => 0) - Option.getOrElse(right.createdAt, () => 0)
    if (start !== 0) return start
    return rowKey(left).localeCompare(rowKey(right))
  }
  // The parent a row nests under here: one in the same section.
  const parentKeyOf = (row: AgentRow): Option.Option<string> =>
    Option.map(row.parent, rowKey).pipe(
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
 * What a running loop is doing now, folded from its event stream: the tools
 * still running, in start order, and the reply text streamed since its step began.
 */
interface ActivityFold {
  readonly tools: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly partial: string
}

/** The input fields that say what a call works on, in the order they are read. */
const ActivityInput = Schema.Struct({
  command: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
})
const decodeActivityInput = Schema.decodeUnknownOption(ActivityInput)

/** `bash git status`: the tool and the first line of the command, path or pattern it works on. */
const toolLabel = (toolName: string, input: Option.Option<typeof ActivityInput.Type>): string =>
  input.pipe(
    Option.flatMap((fields) =>
      Option.fromUndefinedOr(
        [fields.command, fields.path, fields.pattern]
          .map((text) => (text ?? "").trim().split("\n")[0]?.trim() ?? "")
          .find((text) => text.length > 0),
      ),
    ),
    Option.map((detail) => `${toolName} ${detail}`),
    Option.getOrElse(() => toolName),
  )

export const emptyActivity: ActivityFold = { tools: [], partial: "" }

/** Characters of the streamed line the tray keeps. */
const ACTIVITY_CHARS = 80

export const foldActivity = (state: ActivityFold, event: AgentEvent): ActivityFold => {
  switch (event._tag) {
    case "StreamStarted":
      return { ...state, partial: "" }
    case "StreamChunk":
      return { ...state, partial: (state.partial + event.chunk).slice(-4 * ACTIVITY_CHARS) }
    case "ToolCallStarted":
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            id: event.toolCallId,
            label: toolLabel(event.toolName, decodeActivityInput(event.input)),
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

/** One line for the tray: the newest running tool and what it works on, else the last streamed line. */
export const activityText = (state: ActivityFold): Option.Option<string> =>
  Option.fromUndefinedOr(state.tools.at(-1)).pipe(
    Option.map((tool) => [...`running ${tool.label}`].slice(0, ACTIVITY_CHARS).join("")),
    Option.orElse(() =>
      Option.fromUndefinedOr(
        state.partial
          .split("\n")
          .map((text) => text.trim())
          .findLast((text) => text.length > 0),
      ).pipe(Option.map((line) => [...line].slice(0, ACTIVITY_CHARS).join(""))),
    ),
  )

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
  readonly read: (key: AgentRowKey) => Effect.Effect<Option.Option<string>>
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
            Option.flatMap(Option.fromUndefinedOr(all.get(rowKey(key))), activityText),
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
  section: Schema.Literals(["running", "idle", "inactive"]),
  status: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Finite),
  updatedAt: Schema.optional(Schema.Finite),
  /** When a running loop's current turn began (epoch ms). Absent while idle. */
  runningSince: Schema.optional(Schema.Finite),
  live: Schema.Boolean,
  depth: Schema.Finite,
  /** The session this loop was delegated from; absent at a tree root. */
  parentSessionId: Schema.optional(SessionId),
  /** The session opened a thread of its own under a parent; a handoff shares its parent's. */
  sideThread: Schema.Boolean,
  /** A running loop's current tool or last streamed line. Wire only, never stored. */
  activity: Schema.optional(Schema.String),
})
export type AgentRowEntry = typeof AgentRowEntry.Type

export const ListAgentsInput = Schema.Struct({
  /** Case-insensitive substring filter over name, cwd, and ids. */
  query: Schema.optional(Schema.String),
  /**
   * Only this session and the sessions below it, at any depth: the tray's
   * read, whose cost follows the subtree rather than the workspace. Absent,
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
 * query filter: the whole workspace, or with a `root` only its subtree.
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
  const sessions = yield* ctx.Session.listSessions({ root: Option.getOrUndefined(root) }).pipe(
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
  const live: ReadonlyArray<LiveAgentRow> = activeLoops
    .filter((loop) => Option.isNone(root) || inTree.has(loop.sessionId))
    .map((loop) => ({
      sessionId: loop.sessionId,
      branchId: loop.branchId,
      status: loop.status,
      runningSince: loop.runningSince,
    }))

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
      },
    ]
  })

  return { rows: projectAgentRows({ live, durable }), listed }
})

export const AgentsViewRpc = defineRequests(AGENTS_VIEW_EXTENSION_ID, {
  ListAgents: request({
    id: "list-agents",
    description: "List agent loops, live and stored, as display rows",
    // The tray and pane read this while the session's own turn is running.
    answersDuringTurn: true,
    input: ListAgentsInput,
    output: ListAgentsOutput,
    execute: Effect.fn("AgentsViewRpc.ListAgents")(function* (input) {
      const { rows: all, listed } = yield* collectRows(Option.fromUndefinedOr(input.root))
      const activity = yield* AgentActivity
      // Every live child read here is watched, working or idle, so its next
      // turn reports from its first event. A tree root is never in the tray.
      // The watch set comes from the rows before the query filter; under a
      // `root` it is that subtree, which is all the caller shows. Only the
      // runtime's whole listing stops a watcher, never the rows read here.
      yield* activity.follow({
        listed,
        watch: all.filter((row) => row.live && Option.isSome(row.parent)),
      })
      const rows = filterRows(all, input.query ?? "")
      const lines = new Map<string, string>()
      for (const row of rows) {
        const line = yield* activity.read(row)
        if (Option.isSome(line)) lines.set(rowKey(row), line.value)
      }
      return {
        rows: rows.map((row) => ({
          sessionId: row.sessionId,
          branchId: row.branchId,
          section: row.section,
          status: Option.getOrUndefined(row.status),
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
          activity: lines.get(rowKey(row)),
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
