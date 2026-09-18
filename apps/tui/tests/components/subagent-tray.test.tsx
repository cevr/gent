/** @jsxImportSource @opentui/solid */
/**
 * The subagent tray under the status line.
 *
 * One dim line per running child of the current session, from the same rows
 * the agents pane lists; hidden while nothing runs, and while the pane is open.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import { BranchId, SessionId } from "@gent/core/protocol"
import type { AgentRowEntry } from "@gent/extensions/client"
import { SubagentTray, subtreeCounts, trayLines } from "../../src/extensions/agents.client"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

const root = (id: string, section: AgentRowEntry["section"]): AgentRowEntry => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
  section,
  live: section !== "inactive",
  depth: 0,
})

const child = (id: string, section: AgentRowEntry["section"], parent: string): AgentRowEntry => ({
  ...root(id, section),
  agent: "main",
  name: `main: ${id} task`,
  parentSessionId: SessionId.make(parent),
})

const rows = [
  root("root", "idle"),
  child("child-a", "running", "root"),
  child("child-b", "idle", "root"),
  child("grandchild", "inactive", "child-b"),
  root("other-root", "running"),
  child("other-child", "running", "other-root"),
]

describe("subtreeCounts", () => {
  it.live("counts descendants at any depth and skips the root and other trees", () =>
    Effect.sync(() => {
      expect(subtreeCounts(rows, Option.some({ sessionId: "root" }))).toEqual({
        total: 3,
        running: 1,
        idle: 1,
        inactive: 1,
      })
      expect(subtreeCounts(rows, Option.some({ sessionId: "grandchild" })).total).toBe(0)
      expect(subtreeCounts(rows, Option.none()).total).toBe(0)
    }),
  )
})

describe("trayLines", () => {
  it.live("one line per running child, the agent prefix dropped, the rest counted", () =>
    Effect.sync(() => {
      const running = ["a", "b", "c", "d", "e"].map((id) => child(id, "running", "root"))
      const lines = trayLines(running, 60)
      expect(lines.map((line) => line.text)).toEqual([
        "main working · a task",
        "main working · b task",
        "main working · c task",
        "+2 more working",
      ])
      expect(lines.map((line) => line.pulse)).toEqual([true, true, true, false])
      expect(trayLines(running.slice(0, 1), 18)[0]?.text).toBe("main working · a …")
    }),
  )
})

describe("Subagent tray", () => {
  it.live("lists the running child and hides when the pane opens", () =>
    Effect.gen(function* () {
      const [open, setOpen] = createSignal(false)
      const refreshes: Array<string> = []

      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SubagentTray
            controller={{
              rows: () => rows,
              current: () => Option.some({ sessionId: "root", branchId: "root-branch" }),
              error: () => Option.none(),
              loading: () => false,
              refresh: (query) => {
                refreshes.push(query)
              },
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              open,
              setOpen,
            }}
          />
        )),
      )

      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("working"), "tray"),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("main working · child-a task")
      expect(frame).not.toContain("child-b")
      expect(frame).not.toContain("idle")
      expect(frame).toContain("^t agents")
      // Mounting on a session fetched that session's rows.
      expect(refreshes).toEqual([""])

      setOpen(true)
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => !renderFrame(setup).includes("working"), "tray hidden"),
      )
    }),
  )

  it.live("stays hidden for a session whose children are all idle or inactive", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SubagentTray
            controller={{
              rows: () => rows,
              current: () => Option.some({ sessionId: "child-b", branchId: "b" }),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              open: () => false,
              setOpen: () => {},
            }}
          />
        )),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).not.toContain("working")
      expect(renderFrame(setup)).not.toContain("agents")
    }),
  )
})
