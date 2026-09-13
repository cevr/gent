/** @jsxImportSource @opentui/solid */
/**
 * The subagent tray above the composer.
 *
 * It counts the current session's subtree from the same rows the agents pane
 * lists, stays hidden while there is nothing under the session, and yields to
 * the pane when that is open.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import { BranchId, SessionId } from "@gent/core/protocol"
import type { AgentRowEntry } from "@gent/extensions/client"
import { SubagentTray, subtreeCounts } from "../../src/extensions/builtins/agents-view.client"
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

describe("Subagent tray", () => {
  it.live("shows the subtree counts and hides when the pane opens", () =>
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
              detail: () => Option.none(),
              select: () => {},
              open,
              setOpen,
            }}
          />
        )),
      )

      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("1 running"), "tray"),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("● 1 running")
      expect(frame).toContain("◐ 1 idle")
      expect(frame).toContain("○ 1 inactive")
      expect(frame).toContain("^t agents")
      // Mounting on a session fetched that session's rows.
      expect(refreshes).toEqual([""])

      setOpen(true)
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => !renderFrame(setup).includes("running"), "tray hidden"),
      )
    }),
  )

  it.live("stays hidden for a session with nothing under it", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SubagentTray
            controller={{
              rows: () => rows,
              current: () => Option.some({ sessionId: "grandchild", branchId: "b" }),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              detail: () => Option.none(),
              select: () => {},
              open: () => false,
              setOpen: () => {},
            }}
          />
        )),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).not.toContain("subagents")
    }),
  )
})
