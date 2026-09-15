/**
 * Pure projection for the agents view.
 *
 * No TUI imports, no I/O, no Effect services — plain functions over plain
 * data, so the reconciliation can be tested without a terminal or a runtime.
 * This follows Prime's state layer, which is the half of its agents view worth
 * copying; its 2,124-line view class is not.
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

import { Option } from "effect"
import type { BranchId, SessionId } from "@gent/core/extensions/api"

/** Section an agent row is grouped under, in display order. */
export type AgentSection = "running" | "idle" | "inactive"

/** Identity of one agent loop. One session with three branches is three rows. */
export interface AgentRowKey {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

/** A materialized loop, from `ExtensionContext.Session.listActiveLoops`, with its registered state. */
export interface LiveAgentRow {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agent: string
  /**
   * Runtime state tag, e.g. `"Idle"` / `"Running"` / `"WaitingForInteraction"`.
   *
   * `None` when the loop is materialized but its state read failed; such a
   * loop counts as idle rather than running.
   */
  readonly status: Option.Option<string>
}

/** A stored session branch, from session storage. Survives restarts. */
export interface DurableAgentRow {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: Option.Option<string>
  readonly cwd: Option.Option<string>
  readonly parent: Option.Option<AgentRowKey>
  readonly updatedAt: number
}

/** One reconciled row, ready for display. */
export interface AgentRow {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly section: AgentSection
  readonly agent: Option.Option<string>
  readonly status: Option.Option<string>
  readonly name: Option.Option<string>
  readonly cwd: Option.Option<string>
  readonly updatedAt: Option.Option<number>
  readonly parent: Option.Option<AgentRowKey>
  /** True when the loop is materialized right now. */
  readonly live: boolean
  /** Depth in the parent/child tree; 0 for a top-level agent. */
  readonly depth: number
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
      agent: Option.map(live, (row) => row.agent),
      status: Option.flatMap(live, (row) => row.status),
      name: Option.flatMap(durable, (row) => row.name),
      cwd: Option.flatMap(durable, (row) => row.cwd),
      updatedAt: Option.map(durable, (row) => row.updatedAt),
      parent: Option.flatMap(durable, (row) => row.parent),
      live: Option.isSome(live),
      depth: 0,
    })
  }
  return rows
}

/**
 * Walk a row's ancestor chain, stopping at the root, at an orphan, or at a
 * cycle. Shared by depth assignment and running propagation because both need
 * exactly the same guarded traversal.
 */
const ancestorsOf = (
  row: AgentRow,
  byKey: ReadonlyMap<string, AgentRow>,
): ReadonlyArray<AgentRow> => {
  const chain: Array<AgentRow> = []
  const seen = new Set<string>([rowKey(row)])
  let current = row
  for (;;) {
    if (Option.isNone(current.parent)) return chain
    const parentKey = rowKey(current.parent.value)
    const parent = Option.fromUndefinedOr(byKey.get(parentKey))
    // Orphan: parent not loaded. Treat the row as top level rather than hiding it.
    if (Option.isNone(parent)) return chain
    // Cycle guard.
    if (seen.has(parentKey)) return chain
    seen.add(parentKey)
    chain.push(parent.value)
    current = parent.value
  }
}

/**
 * Assign tree depth from parent links, then order rows for display.
 *
 * A child whose parent is absent from the row set is promoted to top level
 * rather than hidden — an orphan is still a real agent, and dropping it would
 * make work disappear from the view.
 */
export const buildRowTree = (rows: ReadonlyArray<AgentRow>): ReadonlyArray<AgentRow> => {
  const byKey = new Map<string, AgentRow>()
  for (const row of rows) byKey.set(rowKey(row), row)

  return rows
    .map((row) => ({ ...row, depth: ancestorsOf(row, byKey).length }))
    .toSorted((left, right) => {
      const bySection = SECTION_ORDER[left.section] - SECTION_ORDER[right.section]
      if (bySection !== 0) return bySection
      const byRecency =
        Option.getOrElse(right.updatedAt, () => 0) - Option.getOrElse(left.updatedAt, () => 0)
      if (byRecency !== 0) return byRecency
      return rowKey(left).localeCompare(rowKey(right))
    })
}

/**
 * A busy descendant forces every ancestor to render as running, so a collapsed
 * parent never looks idle while its children work. Cycle-guarded via
 * {@link ancestorsOf}.
 */
export const propagateRunning = (rows: ReadonlyArray<AgentRow>): ReadonlyArray<AgentRow> => {
  const byKey = new Map<string, AgentRow>()
  for (const row of rows) byKey.set(rowKey(row), row)

  const forced = new Set<string>()
  for (const row of rows) {
    if (row.section !== "running") continue
    for (const ancestor of ancestorsOf(row, byKey)) forced.add(rowKey(ancestor))
  }

  if (forced.size === 0) return rows
  return rows.map((row) => {
    if (row.section === "running" || !forced.has(rowKey(row))) return row
    return { ...row, section: "running" satisfies AgentSection }
  })
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
      Option.getOrElse(row.agent, () => ""),
      Option.getOrElse(row.cwd, () => ""),
      row.sessionId,
      row.branchId,
    ]
    return fields.some((field) => field.toLowerCase().includes(needle))
  })
}

/** Full projection: reconcile, propagate, then order. */
export const projectAgentRows = (params: {
  readonly live: ReadonlyArray<LiveAgentRow>
  readonly durable: ReadonlyArray<DurableAgentRow>
  readonly query?: string
}): ReadonlyArray<AgentRow> => {
  const reconciled = reconcileAgentRows(params)
  const propagated = propagateRunning(reconciled)
  const tree = buildRowTree(propagated)
  return filterRows(tree, params.query ?? "")
}
