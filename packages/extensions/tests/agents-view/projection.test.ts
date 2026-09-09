import { describe, test, expect } from "bun:test"
import { Option } from "effect"
import { BranchId, SessionId } from "@gent/core/extensions/api"
import {
  buildRowTree,
  filterRows,
  projectAgentRows,
  propagateRunning,
  reconcileAgentRows,
  rowKey,
  sectionOf,
  type AgentRow,
  type DurableAgentRow,
  type LiveAgentRow,
} from "../../src/agents-view/projection.js"

const sid = (value: string) => SessionId.make(value)
const bid = (value: string) => BranchId.make(value)

const live = (overrides: {
  session: string
  branch: string
  agent?: string
  status?: string
  model?: string
  turns?: number
  costUsd?: number
  durationMs?: number
}): LiveAgentRow => ({
  sessionId: sid(overrides.session),
  branchId: bid(overrides.branch),
  agent: overrides.agent ?? "main",
  status: Option.some(overrides.status ?? "Running"),
  model: Option.fromUndefinedOr(overrides.model),
  turns: Option.fromUndefinedOr(overrides.turns),
  costUsd: Option.fromUndefinedOr(overrides.costUsd),
  durationMs: Option.fromUndefinedOr(overrides.durationMs),
})

const durable = (overrides: {
  session: string
  branch: string
  name?: string
  cwd?: string
  parentSession?: string
  parentBranch?: string
  updatedAt?: number
}): DurableAgentRow => ({
  sessionId: sid(overrides.session),
  branchId: bid(overrides.branch),
  name: Option.fromUndefinedOr(overrides.name),
  cwd: Option.fromUndefinedOr(overrides.cwd),
  parent: Option.all([
    Option.fromUndefinedOr(overrides.parentSession),
    Option.fromUndefinedOr(overrides.parentBranch),
  ]).pipe(
    Option.map(([parentSession, parentBranch]) => ({
      sessionId: sid(parentSession),
      branchId: bid(parentBranch),
    })),
  ),
  updatedAt: overrides.updatedAt ?? 0,
})

const find = (rows: ReadonlyArray<AgentRow>, session: string, branch: string) =>
  rows.find((row) => row.sessionId === sid(session) && row.branchId === bid(branch))

describe("agents view projection", () => {
  describe("row identity", () => {
    test("keys on session and branch together, so branches of one session are distinct rows", () => {
      const a = rowKey({ sessionId: sid("s1"), branchId: bid("b1") })
      const b = rowKey({ sessionId: sid("s1"), branchId: bid("b2") })
      expect(a).not.toBe(b)
    })

    test("a session and branch that concatenate alike still key apart", () => {
      const a = rowKey({ sessionId: sid("s"), branchId: bid("1 b") })
      const b = rowKey({ sessionId: sid("s 1"), branchId: bid("b") })
      expect(a).not.toBe(b)
    })
  })

  describe("sections", () => {
    test("a materialized running loop is running", () => {
      const row = live({ session: "s", branch: "b", status: "Running" })
      expect(sectionOf(Option.some(row))).toBe("running")
    })

    test("a materialized idle loop is idle", () => {
      const row = live({ session: "s", branch: "b", status: "Idle" })
      expect(sectionOf(Option.some(row))).toBe("idle")
    })

    test("a loop waiting on an interaction counts as running, not idle", () => {
      const row = live({ session: "s", branch: "b", status: "WaitingForInteraction" })
      expect(sectionOf(Option.some(row))).toBe("running")
    })

    test("a durable-only row is inactive", () => {
      expect(sectionOf(Option.none())).toBe("inactive")
    })

    test("a resident loop with an unread status is idle, not running", () => {
      // Being materialized is not the same as working. Reporting it as running
      // would strand every live loop in `running` and make `idle` unreachable.
      const row = { ...live({ session: "s", branch: "b" }), status: Option.none() }
      expect(sectionOf(Option.some(row))).toBe("idle")
    })
  })

  describe("reconciliation", () => {
    test("merges a live and durable row for the same loop into one row", () => {
      const rows = reconcileAgentRows({
        live: [live({ session: "s1", branch: "b1", agent: "main", status: "Running" })],
        durable: [durable({ session: "s1", branch: "b1", name: "my task", cwd: "/repo" })],
      })
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row?.live).toBe(true)
      expect(row?.section).toBe("running")
      // Live supplies status; durable supplies the fields the registry lacks.
      expect(row?.agent).toEqual(Option.some("main"))
      expect(row?.name).toEqual(Option.some("my task"))
      expect(row?.cwd).toEqual(Option.some("/repo"))
    })

    test("keeps a live loop that has no durable row yet", () => {
      // A brand-new loop must not be invisible until its session row is written.
      const rows = reconcileAgentRows({
        live: [live({ session: "s1", branch: "b1" })],
        durable: [],
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.live).toBe(true)
    })

    test("keeps a durable row with no live loop, as inactive", () => {
      // This is the after-restart case: the registry is empty, storage is not.
      const rows = reconcileAgentRows({
        live: [],
        durable: [durable({ session: "s1", branch: "b1", name: "yesterday" })],
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.live).toBe(false)
      expect(rows[0]?.section).toBe("inactive")
      expect(rows[0]?.name).toEqual(Option.some("yesterday"))
    })

    test("does not collapse two branches of one session", () => {
      const rows = reconcileAgentRows({
        live: [live({ session: "s1", branch: "b1" }), live({ session: "s1", branch: "b2" })],
        durable: [],
      })
      expect(rows).toHaveLength(2)
    })

    test("carries live metrics through", () => {
      const rows = reconcileAgentRows({
        live: [live({ session: "s1", branch: "b1", model: "sonnet", turns: 4, costUsd: 0.5 })],
        durable: [],
      })
      expect(rows[0]?.model).toEqual(Option.some("sonnet"))
      expect(rows[0]?.turns).toEqual(Option.some(4))
      expect(rows[0]?.costUsd).toEqual(Option.some(0.5))
    })
  })

  describe("tree building", () => {
    test("nests a child under its parent", () => {
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            durable({ session: "parent", branch: "b1" }),
            durable({
              session: "child",
              branch: "b1",
              parentSession: "parent",
              parentBranch: "b1",
            }),
          ],
        }),
      )
      expect(find(rows, "parent", "b1")?.depth).toBe(0)
      expect(find(rows, "child", "b1")?.depth).toBe(1)
    })

    test("nests a grandchild two deep", () => {
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            durable({ session: "a", branch: "b" }),
            durable({ session: "b", branch: "b", parentSession: "a", parentBranch: "b" }),
            durable({ session: "c", branch: "b", parentSession: "b", parentBranch: "b" }),
          ],
        }),
      )
      expect(find(rows, "c", "b")?.depth).toBe(2)
    })

    test("promotes an orphan to top level rather than hiding it", () => {
      // The parent has not loaded. Dropping the child would make real work vanish.
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            durable({
              session: "orphan",
              branch: "b1",
              parentSession: "missing",
              parentBranch: "b1",
            }),
          ],
        }),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.depth).toBe(0)
    })

    test("terminates on a parent cycle instead of looping forever", () => {
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            durable({ session: "a", branch: "b", parentSession: "b", parentBranch: "b" }),
            durable({ session: "b", branch: "b", parentSession: "a", parentBranch: "b" }),
          ],
        }),
      )
      expect(rows).toHaveLength(2)
    })

    test("orders running before idle before inactive", () => {
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [
            live({ session: "idle", branch: "b", status: "Idle" }),
            live({ session: "run", branch: "b", status: "Running" }),
          ],
          durable: [durable({ session: "old", branch: "b" })],
        }),
      )
      expect(rows.map((row) => row.section)).toEqual(["running", "idle", "inactive"])
    })

    test("orders more recent rows first within a section", () => {
      const rows = buildRowTree(
        reconcileAgentRows({
          live: [],
          durable: [
            durable({ session: "older", branch: "b", updatedAt: 100 }),
            durable({ session: "newer", branch: "b", updatedAt: 200 }),
          ],
        }),
      )
      expect(rows[0]?.sessionId).toBe(sid("newer"))
    })
  })

  describe("running propagation", () => {
    test("forces an idle parent to running while a child runs", () => {
      // A collapsed parent must not look idle while its subagent works.
      const rows = propagateRunning(
        reconcileAgentRows({
          live: [
            live({ session: "parent", branch: "b", status: "Idle" }),
            live({ session: "child", branch: "b", status: "Running" }),
          ],
          durable: [
            durable({ session: "parent", branch: "b" }),
            durable({ session: "child", branch: "b", parentSession: "parent", parentBranch: "b" }),
          ],
        }),
      )
      expect(find(rows, "parent", "b")?.section).toBe("running")
    })

    test("propagates through two levels to the grandparent", () => {
      const rows = propagateRunning(
        reconcileAgentRows({
          live: [
            live({ session: "a", branch: "b", status: "Idle" }),
            live({ session: "b", branch: "b", status: "Idle" }),
            live({ session: "c", branch: "b", status: "Running" }),
          ],
          durable: [
            durable({ session: "a", branch: "b" }),
            durable({ session: "b", branch: "b", parentSession: "a", parentBranch: "b" }),
            durable({ session: "c", branch: "b", parentSession: "b", parentBranch: "b" }),
          ],
        }),
      )
      expect(find(rows, "a", "b")?.section).toBe("running")
    })

    test("leaves an idle parent idle when no descendant runs", () => {
      const rows = propagateRunning(
        reconcileAgentRows({
          live: [
            live({ session: "parent", branch: "b", status: "Idle" }),
            live({ session: "child", branch: "b", status: "Idle" }),
          ],
          durable: [
            durable({ session: "parent", branch: "b" }),
            durable({ session: "child", branch: "b", parentSession: "parent", parentBranch: "b" }),
          ],
        }),
      )
      expect(find(rows, "parent", "b")?.section).toBe("idle")
    })

    test("terminates on a cycle", () => {
      const rows = propagateRunning(
        reconcileAgentRows({
          live: [live({ session: "a", branch: "b", status: "Running" })],
          durable: [
            durable({ session: "a", branch: "b", parentSession: "b", parentBranch: "b" }),
            durable({ session: "b", branch: "b", parentSession: "a", parentBranch: "b" }),
          ],
        }),
      )
      expect(rows).toHaveLength(2)
    })
  })

  describe("search", () => {
    const rows = buildRowTree(
      reconcileAgentRows({
        live: [live({ session: "s1", branch: "b1", agent: "main", model: "sonnet" })],
        durable: [durable({ session: "s1", branch: "b1", name: "Fix the parser", cwd: "/repo" })],
      }),
    )

    test("returns everything for an empty query", () => {
      expect(filterRows(rows, "")).toHaveLength(1)
      expect(filterRows(rows, "   ")).toHaveLength(1)
    })

    test("matches on name, case-insensitively", () => {
      expect(filterRows(rows, "PARSER")).toHaveLength(1)
    })

    test("matches on cwd, agent, and model", () => {
      expect(filterRows(rows, "/repo")).toHaveLength(1)
      expect(filterRows(rows, "main")).toHaveLength(1)
      expect(filterRows(rows, "sonnet")).toHaveLength(1)
    })

    test("returns nothing for a miss", () => {
      expect(filterRows(rows, "nonexistent")).toHaveLength(0)
    })
  })

  describe("full projection", () => {
    test("reconciles, propagates, orders, and filters in one pass", () => {
      const rows = projectAgentRows({
        live: [
          live({ session: "parent", branch: "b", status: "Idle" }),
          live({ session: "child", branch: "b", status: "Running" }),
        ],
        durable: [
          durable({ session: "parent", branch: "b", name: "parent task", updatedAt: 200 }),
          durable({
            session: "child",
            branch: "b",
            name: "child task",
            updatedAt: 100,
            parentSession: "parent",
            parentBranch: "b",
          }),
          durable({ session: "gone", branch: "b", name: "old task", updatedAt: 50 }),
        ],
      })
      expect(rows).toHaveLength(3)
      // The idle parent was forced running by its child, so both sort first.
      expect(rows[0]?.section).toBe("running")
      expect(rows[1]?.section).toBe("running")
      expect(rows[2]?.section).toBe("inactive")
      expect(find(rows, "child", "b")?.depth).toBe(1)
    })

    test("survives an empty live catalog, as after a restart", () => {
      const rows = projectAgentRows({
        live: [],
        durable: [durable({ session: "s1", branch: "b1", name: "yesterday" })],
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.section).toBe("inactive")
    })

    test("returns nothing when both catalogs are empty", () => {
      expect(projectAgentRows({ live: [], durable: [] })).toHaveLength(0)
    })
  })
})
