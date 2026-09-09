/** @jsxImportSource @opentui/solid */
/**
 * Keyboard navigation for the agents overlay.
 *
 * Migrated from the session-tree test this view replaced: same three
 * behaviors (arrow selects, Enter fires onSelect, Escape closes), now against
 * the overlay that owns them.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import { BranchId, SessionId } from "@gent/core/protocol"
import type { AgentRowEntry } from "@gent/extensions/client"
import { AgentsPane } from "../../src/extensions/builtins/agents-view.client"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

const row = (id: string, name: string, depth: number): AgentRowEntry => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
  section: "inactive",
  name,
  live: false,
  depth,
})

describe("Agents pane navigation", () => {
  it.live("selects a child with the keyboard and closes with Escape", () =>
    Effect.gen(function* () {
      const parent = row("agents-root", "Alpha", 0)
      const child = row("agents-child", "Beta", 1)
      let selected = Option.none<AgentRowEntry>()
      const [open, setOpen] = createSignal(true)

      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <AgentsPane
            open={open()}
            controller={{
              rows: () => [parent, child],
              current: () => Option.none(),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
            }}
            onSelect={(value) => {
              selected = Option.some(value)
            }}
            onClose={() => setOpen(false)}
          />
        )),
      )

      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      expect(selected).toEqual(Option.some(child))

      setup.mockInput.pressEscape()
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => !open(), "agents pane closed"))
      expect(open()).toBe(false)
      expect(renderFrame(setup)).not.toContain("Agents")
    }),
  )
})
