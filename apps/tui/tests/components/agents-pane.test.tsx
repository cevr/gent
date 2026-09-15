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
import type { ExtensionAgentDetail } from "../../src/extensions/client-transport"
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
              detail: () => Option.none(),
              select: () => {},
              open: () => true,
              setOpen: () => {},
            }}
            onSelect={(value) => {
              selected = Option.some(value)
            }}
            onToggle={() => {}}
            onDelete={() => {}}
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

  it.live("asks for detail about the row under the cursor and renders it", () =>
    Effect.gen(function* () {
      const parent = row("detail-root", "Alpha", 0)
      const child = row("detail-child", "Beta", 1)
      const asked: Array<string> = []
      const [detail, setDetail] = createSignal(Option.none<ExtensionAgentDetail>())

      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <AgentsPane
            open={true}
            controller={{
              rows: () => [parent, child],
              current: () => Option.none(),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              detail,
              select: (selection) => {
                Option.match(selection, {
                  onNone: () => {},
                  onSome: (value) => {
                    asked.push(value.sessionId)
                    setDetail(
                      Option.some({
                        status: Option.some("Running"),
                        model: Option.some("anthropic/claude-sonnet-5"),
                        turns: 7,
                        costUsd: 0.125,
                        durationMs: 93_000,
                        omittedMessages: 0,
                      }),
                    )
                  },
                })
              },
              open: () => true,
              setOpen: () => {},
            }}
            onSelect={() => {}}
            onToggle={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
          />
        )),
      )

      // The first row is selected on open, so its detail is requested without
      // any keypress; moving down asks about the row now under the cursor.
      expect(asked).toEqual(["detail-root"])
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      expect(asked).toEqual(["detail-root", "detail-child"])

      const frame = renderFrame(setup)
      expect(frame).toContain("claude-sonnet-5")
      expect(frame).not.toContain("anthropic/")
      expect(frame).toContain("7 turns")
      expect(frame).toContain("$0.125")
      expect(frame).toContain("1m33s")
    }),
  )

  it.live("corrects the selected row's section from live state", () =>
    Effect.gen(function* () {
      // The listing has to report a resident loop as idle — it never reads
      // state — so the detail read is the only thing that knows better.
      const busy: AgentRowEntry = { ...row("busy", "Alpha", 0), section: "idle", live: true }

      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <AgentsPane
            open={true}
            controller={{
              rows: () => [busy],
              current: () => Option.none(),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              detail: () =>
                Option.some({
                  status: Option.some("Running"),
                  model: Option.none(),
                  turns: 1,
                  costUsd: 0,
                  durationMs: 0,
                  omittedMessages: 0,
                }),
              select: () => {},
              open: () => true,
              setOpen: () => {},
            }}
            onSelect={() => {}}
            onToggle={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
          />
        )),
      )

      const frame = renderFrame(setup)
      expect(frame).toContain("Idle (1)")
      expect(frame).toContain("Alpha  ·  —  ·  running")
    }),
  )

  it.live("toggles with Ctrl+T while the pane is hidden", () =>
    Effect.gen(function* () {
      // The pane's other keys are gated on `open`, so the toggle has to be
      // registered separately or it can close the pane but never reopen it.
      const [open, setOpen] = createSignal(false)
      let toggles = 0

      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <AgentsPane
            open={open()}
            controller={{
              rows: () => [row("toggle", "Alpha", 0)],
              current: () => Option.none(),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              detail: () => Option.none(),
              select: () => {},
              open,
              setOpen,
            }}
            onSelect={() => {}}
            onToggle={() => {
              toggles++
              setOpen((current) => !current)
            }}
            onDelete={() => {}}
            onClose={() => setOpen(false)}
          />
        )),
      )

      expect(renderFrame(setup)).not.toContain("Agents")

      setup.mockInput.pressKey("t", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(toggles).toBe(1)
      expect(open()).toBe(true)
      expect(renderFrame(setup)).toContain("Agents")

      setup.mockInput.pressKey("t", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(open()).toBe(false)
    }),
  )
})

describe("Agents pane delete", () => {
  it.live("Ctrl+X arms the row in place and a second press deletes it", () =>
    Effect.gen(function* () {
      const deleted: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <AgentsPane
            open={true}
            controller={{
              rows: () => [row("doomed", "Alpha", 0)],
              current: () => Option.none(),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              detail: () => Option.none(),
              select: () => {},
              open: () => true,
              setOpen: () => {},
            }}
            onSelect={() => {}}
            onToggle={() => {}}
            onDelete={(target) => deleted.push(target.sessionId)}
            onClose={() => {}}
          />
        )),
      )

      setup.mockInput.pressKey("x", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("^x again to delete")
      expect(deleted).toEqual([])

      setup.mockInput.pressKey("x", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(deleted).toEqual(["doomed"])
      expect(renderFrame(setup)).not.toContain("^x again")
    }),
  )
})
