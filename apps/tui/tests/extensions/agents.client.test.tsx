/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Clock, Deferred, Effect, Option } from "effect"
import { createSignal } from "solid-js"
import { BranchId, dateFromMillis, Session, SessionId } from "@gent/core/protocol"
import type { AgentRowEntry } from "@gent/extensions/client"
import {
  AgentsPane,
  makeAgentsController,
  SubagentTray,
  subtreeCounts,
  trayLines,
} from "../../src/extensions/agents.client"
import type { ExtensionAgentDetail } from "../../src/extensions/client-facets"
import { usePickerGeometry } from "../../src/ui"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"
import { provideClientServices } from "../extension-test-harness-boundary"
import { makeThreadController } from "../../src/extensions/thread-view.client"

// ── ../components/agents-controller.test ────────────────────────────────────

/**
 * Detail fetching for the agents view.
 *
 * Arrow keys move faster than a round trip, so replies can land out of order.
 * These cover the rule that only the reply for the row still selected wins —
 * without it, one row's cost renders next to another row's name.
 */

const row = (id: string, live = true): AgentRowEntry => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
  section: "idle",
  live,
  depth: 0,
  sideThread: false,
})

const detail = (turns: number): ExtensionAgentDetail => ({
  status: "Idle",
  model: "anthropic/claude-sonnet-5",
  turns,
  costUsd: 0,
  durationMs: 0,
  omittedMessages: 0,
})

describe("Agents controller detail", () => {
  it.scopedLive("ignores a reply for a row the reader already moved off", () =>
    Effect.gen(function* () {
      // Stands in for the client's `cast`, which runs effects on the shell's
      // own runtime; here that is the surrounding test context.
      const slow = yield* Deferred.make<ExtensionAgentDetail>()
      const fast = yield* Deferred.make<ExtensionAgentDetail>()
      const gates = new Map([
        ["first", slow],
        ["second", fast],
      ])

      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Effect.succeed([]),
          (key) =>
            Option.match(Option.fromUndefinedOr(gates.get(key.sessionId)), {
              onNone: () => Effect.never,
              onSome: (gate) => Deferred.await(gate),
            }),
        ),
        { currentSession: () => Option.none() },
      )

      // Select the first row, then move on before its reply arrives.
      controller.select(Option.some(row("first")))
      controller.select(Option.some(row("second")))

      // The stale reply lands first and must not be shown.
      yield* Deferred.succeed(slow, detail(111))
      yield* Effect.yieldNow
      expect(controller.detail()).toEqual(Option.none())

      // The reply for the row still selected is the one that wins.
      yield* Deferred.succeed(fast, detail(222))
      yield* Effect.yieldNow
      expect(Option.map(controller.detail(), (value) => value.turns)).toEqual(Option.some(222))
    }),
  )

  it.scopedLive("clears detail when the selection goes away", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<ExtensionAgentDetail>()

      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Effect.succeed([]),
          () => Deferred.await(gate),
        ),
        { currentSession: () => Option.none() },
      )

      controller.select(Option.some(row("only")))
      yield* Deferred.succeed(gate, detail(5))
      yield* Effect.yieldNow
      expect(Option.isSome(controller.detail())).toBe(true)

      controller.select(Option.none())
      expect(controller.detail()).toEqual(Option.none())
    }),
  )
})

describe("Agents controller reload", () => {
  it.scopedLive("re-reads the filter the reader typed, not the whole listing", () =>
    Effect.gen(function* () {
      const asked: Array<string> = []

      const controller = yield* provideClientServices(
        makeAgentsController(
          (query) => {
            asked.push(query)
            return Effect.succeed([])
          },
          () => Effect.never,
        ),
        {
          currentSession: () =>
            Option.some({ sessionId: SessionId.make("only"), branchId: BranchId.make("only") }),
        },
      )

      // The reader filters the pane, then deletes a row from it. The listing
      // that comes back must still be the filtered one.
      controller.refresh("dep")
      controller.reload()
      yield* Effect.yieldNow

      expect(asked).toEqual(["dep", "dep"])
    }),
  )
})

describe("Agents controller stored rows", () => {
  it.scopedLive("never asks a stored session for detail, since the read would spawn its loop", () =>
    Effect.gen(function* () {
      const asked: Array<string> = []
      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Effect.succeed([]),
          (key) => {
            asked.push(key.sessionId)
            return Effect.succeed(detail(1))
          },
        ),
        { currentSession: () => Option.none() },
      )
      controller.select(Option.some(row("stored", false)))
      expect(asked).toEqual([])
      expect(controller.detail()).toEqual(Option.none())
    }),
  )
})

// ── ../components/agents-pane.test ──────────────────────────────────────────

/**
 * Keyboard navigation for the agents overlay.
 *
 * Migrated from the session-tree test this view replaced: same three
 * behaviors (arrow selects, Enter fires onSelect, Escape closes), now against
 * the overlay that owns them.
 */

const rowPane = (id: string, name: string, depth: number): AgentRowEntry => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
  section: "inactive",
  name,
  live: false,
  depth,
  sideThread: false,
})

/**
 * A rowPane that has run, so `ageFor` yields a real age.
 *
 * The age is the only part of a rowPane drawn against the right edge, so a
 * fixture without `updatedAt` cannot overflow the budget however long its
 * name is: the width tests above passed against a visibly wrapping pane
 * because every rowPane they drew had an empty age column.
 *
 * `updatedAt` is an instant the caller resolves from the clock, not a
 * duration: the pane reads the wall clock to format the age.
 */
const agedRow = (id: string, name: string, updatedAt: number): AgentRowEntry => ({
  ...rowPane(id, name, 0),
  section: "idle",
  live: true,
  updatedAt,
})

describe("Agents pane navigation", () => {
  it.live("selects a child with the keyboard and closes with Escape", () =>
    Effect.gen(function* () {
      const parent = rowPane("agents-root", "Alpha", 0)
      const child = rowPane("agents-child", "Beta", 1)
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
      const parent = rowPane("detail-root", "Alpha", 0)
      const child = rowPane("detail-child", "Beta", 1)
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
                        status: "Running",
                        model: "anthropic/claude-sonnet-5",
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
      const busy: AgentRowEntry = { ...rowPane("busy", "Alpha", 0), section: "idle", live: true }

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
                  status: "Running",
                  model: "anthropic/claude-sonnet-5",
                  turns: 1,
                  costUsd: 0,
                  durationMs: 0,
                  omittedMessages: 0,
                }),
              select: () => {},
              open: () => true,
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
      expect(frame).toContain("Alpha  ·  running")
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
              rows: () => [rowPane("toggle", "Alpha", 0)],
              current: () => Option.none(),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              open,
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
              rows: () => [rowPane("doomed", "Alpha", 0)],
              current: () => Option.none(),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              open: () => true,
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
  it.scopedLive("a live row asked about before closing is asked about again on reopen", () =>
    Effect.gen(function* () {
      // The pane unmounts its list on close, so the list never observes
      // `open=false`. Without a cursor reset from cleanup, the controller keeps
      // the pending token for the row it last fetched and the duplicate check
      // swallows the fresh detail the reader reopened the pane to see.
      const live: AgentRowEntry = {
        ...rowPane("reopened", "Alpha", 0),
        section: "idle",
        live: true,
      }
      const asked: Array<string> = []
      const [open, setOpen] = createSignal(true)
      const [turns, setTurns] = createSignal(1)

      // The shell is on this loop. The listing is keyed on it, so a reply
      // is kept only while it is still the current session.
      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Effect.succeed([live]),
          (key) => {
            asked.push(key.sessionId)
            return Effect.succeed({
              status: "Idle",
              model: "anthropic/claude-sonnet-5",
              turns: turns(),
              costUsd: 0,
              durationMs: 0,
              omittedMessages: 0,
            })
          },
        ),
        {
          currentSession: () => Option.some({ sessionId: live.sessionId, branchId: live.branchId }),
        },
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
      const idle: AgentRowEntry = { ...rowPane("framed", "Alpha", 0), section: "idle", live: true }
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
                    status: "Idle",
                    model: "anthropic/claude-sonnet-5",
                    turns: 7,
                    costUsd: 0.125,
                    durationMs: 93_000,
                    omittedMessages: 0,
                  }),
                select: () => {},
                open: () => true,
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
      const wide = rowPane("wide", "W".repeat(200), 0)
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
      const seen: Array<{ rowPane: number; section: number }> = []
      const Probe = () => {
        const { rowWidth, sectionWidth } = usePickerGeometry()
        seen.push({ rowPane: rowWidth(), section: sectionWidth() })
        return <text>probe</text>
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Probe />, { width: 58, height: 24 }),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (frame) => frame.includes("probe"), "probe"),
      )
      expect(seen[0]).toEqual({ rowPane: 55, section: 56 })
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
                rows: () => [rowPane("erred", "Alpha", 0)],
                current: () => Option.none(),
                error: () => Option.some("listing failed"),
                loading: () => false,
                refresh: () => {},
                reload: () => {},
                detail: () => Option.none(),
                select: () => {},
                open: () => true,
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

// ── ../components/subagent-tray.test ────────────────────────────────────────

/**
 * The subagent tray under the status line.
 *
 * One dim line per running child of the current session, from the same rows
 * the agents pane lists; hidden while nothing runs, and while the pane is open.
 */

const root = (id: string, section: AgentRowEntry["section"]): AgentRowEntry => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
  section,
  live: section !== "inactive",
  depth: 0,
  sideThread: false,
})

const child = (id: string, section: AgentRowEntry["section"], parent: string): AgentRowEntry => ({
  ...root(id, section),
  name: `delegate: ${id} task`,
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
  it.live("one line per running child by name, the rest counted", () =>
    Effect.sync(() => {
      const running = ["a", "b", "c", "d", "e"].map((id) => child(id, "running", "root"))
      const lines = trayLines(running, 60)
      expect(lines.map((line) => line.text)).toEqual([
        "working · delegate: a task",
        "working · delegate: b task",
        "working · delegate: c task",
        "+2 more working",
      ])
      expect(lines.map((line) => line.pulse)).toEqual([true, true, true, false])
      expect(trayLines(running.slice(0, 1), 18)[0]?.text).toBe("working · delegat…")
    }),
  )
  it.live("children keep their start order while their updates reorder the listing", () =>
    Effect.sync(() => {
      const started = (id: string, createdAt: number, updatedAt: number) => ({
        ...child(id, "running", "root"),
        createdAt,
        updatedAt,
      })
      // Two polls of the same three children; each step bumps `updatedAt`.
      const first = [started("b", 2, 30), started("a", 1, 20), started("c", 3, 10)]
      const second = [started("c", 3, 50), started("b", 2, 40), started("a", 1, 35)]
      const expected = [
        "working · delegate: a task",
        "working · delegate: b task",
        "working · delegate: c task",
      ]
      expect(trayLines(first, 60).map((line) => line.text)).toEqual(expected)
      expect(trayLines(second, 60).map((line) => line.text)).toEqual(expected)
    }),
  )
  it.live("a running child shows what it is doing now", () =>
    Effect.sync(() => {
      const busy = { ...child("a", "running", "root"), activity: "running bash" }
      expect(trayLines([busy], 60)[0]?.text).toBe("working · delegate: a task · running bash")
    }),
  )
  it.live("a long task name leaves room for what the child is doing", () =>
    Effect.sync(() => {
      const busy = {
        ...child("a", "running", "root"),
        name: "Run this shell command exactly: sleep 5; echo step one; sleep 40; echo finished",
        activity: "running bash",
      }
      const text = trayLines([busy], 80)[0]?.text ?? ""
      expect(text.endsWith(" · running bash")).toBe(true)
      expect(text.startsWith("working · Run this shell")).toBe(true)
      expect(text.length).toBeLessThanOrEqual(80)
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
              current: () =>
                Option.some({
                  sessionId: SessionId.make("root"),
                  branchId: BranchId.make("root-branch"),
                }),
              error: () => Option.none(),
              loading: () => false,
              refresh: (query) => {
                refreshes.push(query)
              },
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              open,
            }}
          />
        )),
      )

      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("working"), "tray"),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("working · delegate: child-a task")
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

  it.live("the hint stays on the row when a child's name is wide", () =>
    Effect.gen(function* () {
      const wide = [
        root("root", "idle"),
        { ...child("wide", "running", "root"), name: "日本語のタスク" },
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <SubagentTray
              controller={{
                rows: () => wide,
                current: () =>
                  Option.some({
                    sessionId: SessionId.make("root"),
                    branchId: BranchId.make("root-branch"),
                  }),
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                reload: () => {},
                detail: () => Option.none(),
                select: () => {},
                open: () => false,
              }}
            />
          ),
          { width: 80, height: 10 },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (next) => next.includes("working"), "wide tray"),
      )
      // Padding counts display columns: each of these characters takes two.
      expect(frame).toContain("^t agents")
    }),
  )

  it.live("stays hidden for a session whose children are all idle or inactive", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SubagentTray
            controller={{
              rows: () => rows,
              current: () =>
                Option.some({ sessionId: SessionId.make("child-b"), branchId: BranchId.make("b") }),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              reload: () => {},
              detail: () => Option.none(),
              select: () => {},
              open: () => false,
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

// ── ../components/pane-stale-reply.test ─────────────────────────────────────

/**
 * Docked panes must not write a previous session's rows, and must not write an
 * older query's rows either.
 *
 * Both panes refetch across a session switch — the agents tray on `current()`
 * changing plus a 2 s poll, the thread pane on a compaction event — so a reply
 * can land after the shell has already moved. The key the fetch was made for
 * is re-read when it lands; a reply for any other key is dropped.
 *
 * The filter fires one fetch per keystroke, so replies also race each other
 * within one session. Only the newest refresh may write, and every reply that
 * reaches the query clears the load state, even the ones it drops.
 */

const key = (id: string) => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
})

const rowStaleReply = (id: string): AgentRowEntry => ({
  sessionId: SessionId.make(id),
  branchId: BranchId.make(`${id}-branch`),
  section: "idle",
  live: true,
  depth: 0,
  sideThread: false,
})

describe("Agents controller across a session switch", () => {
  it.scopedLive("drops a reply that lands after the shell moved to another session", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()

      // The shell starts on "first"; the test moves it while the fetch is out.
      let active = Option.some(key("first"))

      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Deferred.await(gate),
          () => Effect.never,
        ),
        { currentSession: () => active },
      )

      // Fetch for "first" goes out, then the shell switches to "second".
      controller.refresh("")
      active = Option.some(key("second"))

      // The in-flight reply carries the previous session's rows.
      yield* Deferred.succeed(gate, [rowStaleReply("first")])
      yield* Effect.yieldNow

      expect(controller.rows()).toEqual([])
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.scopedLive("keeps the newest filter's rows when an older one replies last", () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()
      const second = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()
      const gates = new Map([
        ["a", first],
        ["ab", second],
      ])

      const active = Option.some(key("only"))
      const controller = yield* provideClientServices(
        makeAgentsController(
          (query) =>
            Option.match(Option.fromUndefinedOr(gates.get(query)), {
              onNone: () => Effect.never,
              onSome: (gate) => Deferred.await(gate),
            }),
          () => Effect.never,
        ),
        { currentSession: () => active },
      )

      // One fetch per keystroke; the shorter query is still out when the
      // longer one replies.
      controller.refresh("a")
      controller.refresh("ab")

      yield* Deferred.succeed(second, [rowStaleReply("ab-match")])
      yield* Effect.yieldNow
      yield* Deferred.succeed(first, [rowStaleReply("a-match")])
      yield* Effect.yieldNow

      expect(controller.rows().map((entry) => String(entry.sessionId))).toEqual(["ab-match"])
    }).pipe(Effect.timeout("20 seconds")),
  )

  it.scopedLive("stops loading even when the reply is for the session the shell left", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<ReadonlyArray<AgentRowEntry>>()

      let active = Option.some(key("first"))
      const controller = yield* provideClientServices(
        makeAgentsController(
          () => Deferred.await(gate),
          () => Effect.never,
        ),
        { currentSession: () => active },
      )

      controller.refresh("")
      expect(controller.loading()).toBe(true)
      active = Option.some(key("second"))

      yield* Deferred.succeed(gate, [rowStaleReply("first")])
      yield* Effect.yieldNow

      // The rows are dropped, but the pane must not draw "loading" forever.
      expect(controller.rows()).toEqual([])
      expect(controller.loading()).toBe(false)
    }).pipe(Effect.timeout("20 seconds")),
  )
})

describe("Thread controller across a session switch", () => {
  it.scopedLive("drops windows fetched for the session the shell just left", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<ReadonlyArray<Session>>()

      let active = Option.some(key("first"))

      const controller = yield* provideClientServices(
        makeThreadController(
          () => Deferred.await(gate),
          () => Effect.succeed([]),
          () => Effect.succeed(0),
        ),
        { currentSession: () => active },
      )

      controller.refresh()
      active = Option.some(key("second"))

      yield* Deferred.succeed(gate, [
        new Session({
          id: SessionId.make("first"),
          name: "First",
          activeBranchId: BranchId.make("first-branch"),
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(1),
        }),
      ])
      yield* Effect.yieldNow

      expect(controller.sessions()).toBe(0)
    }).pipe(Effect.timeout("20 seconds")),
  )
})
