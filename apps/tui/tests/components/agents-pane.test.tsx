/** @jsxImportSource @opentui/solid */
/**
 * Keyboard navigation for the agents overlay.
 *
 * Migrated from the session-tree test this view replaced: same three
 * behaviors (arrow selects, Enter fires onSelect, Escape closes), now against
 * the overlay that owns them.
 */
import { describe, expect, it } from "effect-bun-test"
import { Clock, Effect, Option } from "effect"
import { createRoot, createSignal } from "solid-js"
import { BranchId, SessionId } from "@gent/core/protocol"
import type { AgentRowEntry } from "@gent/extensions/client"
import { AgentsPane, makeAgentsController } from "../../src/extensions/builtins/agents-view.client"
import { usePickerGeometry } from "../../src/components/picker-frame"
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

/**
 * A row that has run, so `ageFor` yields a real age.
 *
 * The age is the only part of a row drawn against the right edge, so a
 * fixture without `updatedAt` cannot overflow the budget however long its
 * name is: the width tests above passed against a visibly wrapping pane
 * because every row they drew had an empty age column.
 *
 * `updatedAt` is an instant the caller resolves from the clock, not a
 * duration: the pane reads the wall clock to format the age.
 */
const agedRow = (id: string, name: string, updatedAt: number): AgentRowEntry => ({
  ...row(id, name, 0),
  section: "idle",
  live: true,
  updatedAt,
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
              reload: () => {},
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
              reload: () => {},
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
              reload: () => {},
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
              reload: () => {},
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
              reload: () => {},
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

describe("Agents pane reopen", () => {
  it.live("a live row asked about before closing is asked about again on reopen", () =>
    Effect.gen(function* () {
      // The pane unmounts its list on close, so the list never observes
      // `open=false`. Without a cursor reset from cleanup, the controller keeps
      // the pending token for the row it last fetched and the duplicate check
      // swallows the fresh detail the reader reopened the pane to see.
      const live: AgentRowEntry = { ...row("reopened", "Alpha", 0), section: "idle", live: true }
      const asked: Array<string> = []
      const [open, setOpen] = createSignal(true)
      const [turns, setTurns] = createSignal(1)

      // The pane runs detail fetches as fibers. Forking with the test's own
      // services keeps those children inside this Effect rather than starting a
      // second runtime beside it.
      const runFork = Effect.runForkWith(yield* Effect.context<never>())

      const controller = createRoot(() =>
        makeAgentsController(
          () => Effect.succeed([live]),
          (key) => {
            asked.push(key.sessionId)
            return Effect.succeed({
              status: Option.none(),
              model: Option.none(),
              turns: turns(),
              costUsd: 0,
              durationMs: 0,
              omittedMessages: 0,
            })
          },
          (effect) => {
            runFork(effect)
          },
          // The shell is on this loop. The listing is keyed on it, so a reply
          // is kept only while it is still the current session.
          () => Option.some({ sessionId: live.sessionId, branchId: live.branchId }),
        ),
      )

      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <AgentsPane
            open={open()}
            controller={controller}
            onSelect={() => {}}
            onToggle={() => {}}
            onDelete={() => {}}
            onClose={() => setOpen(false)}
          />
        )),
      )
      yield* Effect.promise(() => setup.renderOnce())
      expect(asked).toEqual(["reopened"])

      // The pane closes and its list unmounts.
      setOpen(false)
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => !open(), "agents pane closed"))

      // The loop keeps working while the pane is shut.
      setTurns(9)

      // Reopening must ask again, not reuse the token from before the close.
      setOpen(true)
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => setup.renderOnce())
      expect(asked).toEqual(["reopened", "reopened"])
      expect(Option.map(controller.detail(), (value) => value.turns)).toEqual(Option.some(9))
    }),
  )
})

describe("Agents pane framing", () => {
  it.live("presents as the slash-command popup does: ruled off, titled, one muted footer", () =>
    Effect.gen(function* () {
      // The pane reads as a continuation of the composer, not a floating box
      // over the transcript: the same frame the autocomplete popup draws.
      const idle: AgentRowEntry = { ...row("framed", "Alpha", 0), section: "idle", live: true }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <AgentsPane
              open={true}
              controller={{
                rows: () => [idle],
                current: () => Option.none(),
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                reload: () => {},
                detail: () =>
                  Option.some({
                    status: Option.none(),
                    model: Option.some("anthropic/claude-sonnet-5"),
                    turns: 7,
                    costUsd: 0.125,
                    durationMs: 93_000,
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
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("^t hide"), "agents pane"),
      )
      const lines = renderFrame(setup).split("\n")

      // Ruled top and bottom, never the rounded box a docked pane draws.
      const rules = lines.filter((line) => line.startsWith("────"))
      expect(rules.length).toBe(2)
      expect(renderFrame(setup)).not.toContain("╭")
      expect(renderFrame(setup)).not.toContain("╰")

      // The title carries its counts, on the first line inside the top rule.
      const top = lines.findIndex((line) => line.startsWith("────"))
      expect(lines[top + 1]).toContain("Agents · 0 running, 1 idle, 0 inactive")

      // One muted footer line, immediately under the bottom rule.
      const bottom = lines.findLastIndex((line) => line.startsWith("────"))
      expect(lines[bottom + 1]).toContain("↑↓ move   ↵ open   ^x delete   esc close   ^t hide")

      // Every capability the pane had inside the bordered box still draws:
      // the section heading, the row, and the detail line, each on its own
      // line. The picker height rule counts items, so a pane that budgeted
      // rows rather than drawn lines overprints these.
      const body = lines.slice(top + 1, bottom)
      expect(body.some((line) => line.includes("Idle (1)"))).toBe(true)
      expect(body.some((line) => line.includes("Alpha"))).toBe(true)
      expect(
        body.some((line) => line.includes("claude-sonnet-5") && line.includes("7 turns")),
      ).toBe(true)
    }),
  )

  it.live("budgets a row the full width the rule spans, not a bordered pane's", () =>
    Effect.gen(function* () {
      // The frame rules off top and bottom and has no side border or margin,
      // so a row spends only its own left pad. Budgeting a docked pane's
      // allowance here truncates every row five columns short of the rule.
      const wide = row("wide", "W".repeat(200), 0)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <AgentsPane
              open={true}
              controller={{
                rows: () => [wide],
                current: () => Option.none(),
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                reload: () => {},
                detail: () => Option.none(),
                select: () => {},
                open: () => true,
                setOpen: () => {},
              }}
              onSelect={() => {}}
              onToggle={() => {}}
              onDelete={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("WWW"), "wide row"),
      )
      const lines = renderFrame(setup).split("\n")
      const rule = Option.getOrThrow(
        Option.fromNullishOr(lines.find((line) => line.startsWith("────"))),
      )
      // Only the row itself: the heading also holds a "W", in "Inactive".
      const rowLine = Option.getOrThrow(
        Option.fromNullishOr(lines.find((line) => line.includes("WWW"))),
      )
      // A row spends exactly 3 of the rule's columns: the list body pads 1
      // each side and the row pads 1 more on the left. Landing on that number
      // says the budget is the picker's — a docked pane's allowance would cut
      // the row 5 columns further in — and that it is not overspent, which
      // wraps the age onto a line of its own.
      expect(rowLine.trimEnd().length).toBe(rule.trimEnd().length - 3)
    }),
  )

  it.live("keeps a row's age on the row's own line in a narrow pane", () =>
    Effect.gen(function* () {
      // Observed at 58 columns: every row wrapped its age onto a line of its
      // own. A row is drawn inside the list body, which pads a column each
      // side, and pads one more itself — so a budget that only counts the
      // row's own pad draws a line as wide as the terminal and the age falls
      // off the end.
      const now = yield* Clock.currentTimeMillis
      const aged = agedRow("aged", "New Chat", now - 60_000)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <AgentsPane
              open={true}
              controller={{
                rows: () => [aged],
                current: () => Option.none(),
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                reload: () => {},
                detail: () => Option.none(),
                select: () => {},
                open: () => true,
                setOpen: () => {},
              }}
              onSelect={() => {}}
              onToggle={() => {}}
              onDelete={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 58, height: 24 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("New Chat"), "aged row"),
      )
      const lines = renderFrame(setup).split("\n")

      // The age rides the row that names the agent, not a line by itself.
      const rowLine = Option.getOrThrow(
        Option.fromNullishOr(lines.find((line) => line.includes("New Chat"))),
      )
      expect(rowLine).toContain("1m")
      expect(lines.some((line) => line.trim() === "1m")).toBe(false)

      // The drawn row ends one column short of the rule: the body keeps its
      // right pad. A row that reaches the rule itself has overspent and is
      // what pushes the age onto the next line.
      const rule = Option.getOrThrow(
        Option.fromNullishOr(lines.find((line) => line.startsWith("────"))),
      )
      expect(rowLine.trimEnd().length).toBe(rule.trimEnd().length - 1)
    }),
  )

  it.live("cuts an overlong label instead of wrapping it under the row", () =>
    Effect.gen(function* () {
      // With the budget right, `rowLine` already builds exactly the columns a
      // row may spend, so the clamp on the row's text changes nothing here —
      // removing it keeps this green. It is kept for the reason the sibling
      // rows carry theirs: a future row built wider than the budget is cut,
      // not reflowed under its own line.
      const now = yield* Clock.currentTimeMillis
      const aged = agedRow("long", "L".repeat(400), now - 2 * 24 * 60 * 60 * 1000)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <AgentsPane
              open={true}
              controller={{
                rows: () => [aged],
                current: () => Option.none(),
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                reload: () => {},
                detail: () => Option.none(),
                select: () => {},
                open: () => true,
                setOpen: () => {},
              }}
              onSelect={() => {}}
              onToggle={() => {}}
              onDelete={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 58, height: 24 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("LLL"), "long row"),
      )
      const lines = renderFrame(setup).split("\n")

      // One line carries the label, and it carries the age too.
      const labelLines = lines.filter((line) => line.includes("LLL"))
      expect(labelLines.length).toBe(1)
      expect(labelLines[0]).toContain("2d")
      expect(lines.some((line) => line.trim() === "2d")).toBe(false)

      // A cut row ends where an uncut one does, one column inside the rule.
      const rule = Option.getOrThrow(
        Option.fromNullishOr(lines.find((line) => line.startsWith("────"))),
      )
      expect(labelLines[0]?.trimEnd().length).toBe(rule.trimEnd().length - 1)
    }),
  )

  it.live("budgets a row the columns it actually spends", () =>
    Effect.gen(function* () {
      // The drawn row cannot witness this once the text is clamped: the clamp
      // cuts a line to the row's box whatever the budget says, so an
      // overspent budget still draws one unwrapped line. The numbers are the
      // only place the spend stays visible, and the wrap follows from them —
      // a row spends the body's two pad columns plus its own.
      const seen: Array<{ row: number; section: number }> = []
      const Probe = () => {
        const { rowWidth, sectionWidth } = usePickerGeometry()
        seen.push({ row: rowWidth(), section: sectionWidth() })
        return <text>probe</text>
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Probe />, { width: 58, height: 24 }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("probe"), "probe"),
      )
      expect(seen[0]).toEqual({ row: 55, section: 56 })
    }),
  )

  it.live("keeps the error surface inside the frame", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <AgentsPane
              open={true}
              controller={{
                rows: () => [row("erred", "Alpha", 0)],
                current: () => Option.none(),
                error: () => Option.some("listing failed"),
                loading: () => false,
                refresh: () => {},
                reload: () => {},
                detail: () => Option.none(),
                select: () => {},
                open: () => true,
                setOpen: () => {},
              }}
              onSelect={() => {}}
              onToggle={() => {}}
              onDelete={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("listing failed"), "error row"),
      )
      const lines = renderFrame(setup).split("\n")
      const top = lines.findIndex((line) => line.startsWith("────"))
      const bottom = lines.findLastIndex((line) => line.startsWith("────"))
      const body = lines.slice(top + 1, bottom)
      expect(body.some((line) => line.includes("listing failed"))).toBe(true)
    }),
  )
})
