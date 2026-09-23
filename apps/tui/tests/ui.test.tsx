/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Clock, Effect, Option } from "effect"
import { createSignal } from "solid-js"
import {
  decoration,
  pickerHeight,
  pickerLines,
  selectable,
  SelectList,
  SelectListEvent,
  type SelectListRow,
  SelectListState,
  transitionSelectList,
  usePickerGeometry,
} from "../src/ui"
import { createMockClient, renderFrame, renderWithProviders } from "./render-harness-boundary"
import { waitForFrame } from "./helpers-boundary"
import {
  BranchId,
  dateFromMillis,
  Model,
  ModelId,
  ProviderId,
  SessionId,
} from "@gent/core/protocol"
import { BranchPicker, modelRows, SettingsPicker } from "../src/pickers"
import { ThreadPane, type ThreadWindow } from "../src/extensions/thread-view.client"
import type { Branch } from "@gent/sdk"

// ── components/select-list.test ─────────────────────────────────────────────

/**
 * The one selectable list every pane mounts.
 *
 * These cover the block the panes used to hand-write: the wrapped cursor, the
 * filter input, the sticky anchor and when it yields, the empty fallback, and
 * the keys a pane claims for itself.
 */

interface Fruit {
  readonly id: string
  readonly name: string
}

const fruits: ReadonlyArray<Fruit> = [
  { id: "apple", name: "Apple" },
  { id: "banana", name: "Banana" },
  { id: "cherry", name: "Cherry" },
]

const plainRows = (items: ReadonlyArray<Fruit>): ReadonlyArray<SelectListRow<Fruit>> =>
  items.map((fruit) =>
    selectable(fruit, (isSelected, id) => {
      const marker = () => {
        if (isSelected()) return ">"
        return " "
      }
      return (
        <box id={id}>
          <text>{`${marker()} ${fruit.name}`}</text>
        </box>
      )
    }),
  )

describe("select list reducer", () => {
  it.effect("wraps the cursor at both ends and clamps a list that shrank", () =>
    Effect.sync(() => {
      const top = SelectListState.initial(0)
      const up = transitionSelectList(top, SelectListEvent.cases.MoveUp.make({ itemCount: 3 }))
      expect(up.selectedIndex).toBe(2)
      const down = transitionSelectList(up, SelectListEvent.cases.MoveDown.make({ itemCount: 3 }))
      expect(down.selectedIndex).toBe(0)

      const far = SelectListState.initial(7)
      const clamped = transitionSelectList(far, SelectListEvent.cases.Clamp.make({ itemCount: 3 }))
      expect(clamped.selectedIndex).toBe(2)
      const emptied = transitionSelectList(far, SelectListEvent.cases.Clamp.make({ itemCount: 0 }))
      expect(emptied.selectedIndex).toBe(0)
    }),
  )

  it.effect("typing resets the cursor but an anchor leaves the query alone", () =>
    Effect.sync(() => {
      const typed = transitionSelectList(
        SelectListState.initial(2),
        SelectListEvent.cases.TypeChar.make({ char: "a" }),
      )
      expect(typed).toEqual({ query: "a", selectedIndex: 0 })

      const anchored = transitionSelectList(
        typed,
        SelectListEvent.cases.Anchor.make({ selectedIndex: 2 }),
      )
      expect(anchored).toEqual({ query: "a", selectedIndex: 2 })

      const opened = transitionSelectList(
        typed,
        SelectListEvent.cases.Open.make({ selectedIndex: 1 }),
      )
      expect(opened).toEqual({ query: "", selectedIndex: 1 })
    }),
  )
})

describe("select list keyboard", () => {
  it.live("moves with arrows and control keys, and selects with enter", () =>
    Effect.gen(function* () {
      const picked: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => plainRows(fruits)}
            onSelect={(fruit) => picked.push(fruit.id)}
            onDismiss={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Apple"), "open")

      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("> Banana")

      setup.mockInput.pressKey("n", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("> Cherry")

      // Past the last row the cursor wraps to the first.
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("> Apple")

      setup.mockInput.pressKey("p", { ctrl: true })
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("> Cherry")

      setup.mockInput.pressEnter()
      expect(picked).toEqual(["cherry"])
    }),
  )

  it.live("dismisses on escape", () =>
    Effect.gen(function* () {
      const [open, setOpen] = createSignal(true)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={open()}
            rows={() => plainRows(fruits)}
            onSelect={() => {}}
            onDismiss={() => setOpen(false)}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Apple"), "open")
      setup.mockInput.pressEscape()
      // The mock terminal holds an escape until the next frame, so poll for the
      // effect rather than reading it on the press.
      yield* waitForFrame(setup, () => !open(), "dismissed")
      expect(open()).toBe(false)
    }),
  )

  it.live("gives a pane its own keys before the list sees them", () =>
    Effect.gen(function* () {
      const armed: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => plainRows(fruits)}
            extraKeys={(event, selected) => {
              if (event.ctrl !== true || event.name !== "x") return false
              Option.match(selected, {
                onNone: () => {},
                onSome: (fruit) => armed.push(fruit.id),
              })
              return true
            }}
            onSelect={() => {}}
            onDismiss={() => {}}
          />
        )),
      )
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressKey("x", { ctrl: true })
      expect(armed).toEqual(["banana"])
    }),
  )

  it.live("leaves every key alone while closed", () =>
    Effect.gen(function* () {
      const picked: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={false}
            rows={() => plainRows(fruits)}
            onSelect={(fruit) => picked.push(fruit.id)}
            onDismiss={() => {}}
          />
        )),
      )
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      expect(picked).toEqual([])
    }),
  )
})

describe("select list filter", () => {
  it.live("draws the query, reports every change, and narrows the rows", () =>
    Effect.gen(function* () {
      const [query, setQuery] = createSignal("")
      const seen: Array<string> = []
      const visible = () =>
        fruits.filter((fruit) => fruit.name.toLowerCase().includes(query().toLowerCase()))

      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => plainRows(visible())}
            filter={{
              onQueryChange: (next) => {
                seen.push(next)
                setQuery(next)
              },
            }}
            onSelect={() => {}}
            onDismiss={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Cherry"), "open")

      setup.mockInput.pressKey("a")
      setup.mockInput.pressKey("n")
      yield* waitForFrame(setup, () => !renderFrame(setup).includes("Cherry"), "narrowed")
      // Opening reports an empty query first: a pane that owns the filter has
      // to be told the list starts unfiltered.
      expect(seen).toEqual(["", "a", "an"])
      expect(renderFrame(setup)).toContain("› an")
      expect(renderFrame(setup)).toContain("> Banana")
      expect(renderFrame(setup)).not.toContain("Apple")

      setup.mockInput.pressBackspace()
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Apple"), "widened")
      expect(seen).toEqual(["", "a", "an", "a"])
    }),
  )

  it.live("ignores control characters as filter input", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => plainRows(fruits)}
            filter={{ onQueryChange: (next) => seen.push(next) }}
            onSelect={() => {}}
            onDismiss={() => {}}
          />
        )),
      )
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressTab()
      yield* Effect.promise(() => setup.renderOnce())
      // Only the open reset; tab contributed nothing.
      expect(seen).toEqual([""])
    }),
  )

  it.live("hides the query row when the pane asks it to", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => plainRows(fruits)}
            filter={{ onQueryChange: () => {}, showInput: false }}
            onSelect={() => {}}
            onDismiss={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Apple"), "open")
      expect(renderFrame(setup)).not.toContain("›")
    }),
  )
})

describe("select list sticky selection", () => {
  it.live("moves the cursor onto the anchored row when the data lands", () =>
    Effect.gen(function* () {
      // The fetch resolves after the pane mounts, which is why the anchor
      // cannot be applied once at open time.
      const [rows, setRows] = createSignal<ReadonlyArray<Fruit>>([])
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => plainRows(rows())}
            sticky={(values) => {
              const index = values.findIndex((fruit) => fruit.id === "cherry")
              if (index < 0) return Option.none()
              return Option.some(index)
            }}
            empty={() => <text>nothing yet</text>}
            onSelect={() => {}}
            onDismiss={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("nothing yet"), "empty")

      setRows(fruits)
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Cherry"), "anchored")
      expect(renderFrame(setup)).toContain("  Apple")
    }),
  )

  it.live("stops re-anchoring once the reader has typed", () =>
    Effect.gen(function* () {
      // A sticky rule that keeps firing while the filter narrows drags the
      // cursor off whatever the reader is looking for.
      const [query, setQuery] = createSignal("")
      const visible = () =>
        fruits.filter((fruit) => fruit.name.toLowerCase().includes(query().toLowerCase()))
      const picked: Array<string> = []

      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => plainRows(visible())}
            filter={{ onQueryChange: setQuery }}
            sticky={(values) => {
              const index = values.findIndex((fruit) => fruit.id === "cherry")
              if (index < 0) return Option.some(0)
              return Option.some(index)
            }}
            onSelect={(fruit) => picked.push(fruit.id)}
            onDismiss={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Cherry"), "anchored")

      // "an" matches Banana only; the cursor has to land on it rather than
      // being pulled back by the anchor.
      setup.mockInput.pressKey("a")
      setup.mockInput.pressKey("n")
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Banana"), "narrowed")
      setup.mockInput.pressEnter()
      expect(picked).toEqual(["banana"])
    }),
  )

  it.live("keeps the cursor inside a list that shrank under it", () =>
    Effect.gen(function* () {
      const [rows, setRows] = createSignal(fruits)
      const picked: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => plainRows(rows())}
            onSelect={(fruit) => picked.push(fruit.id)}
            onDismiss={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Cherry"), "open")
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressArrow("down")
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Cherry"), "last row")

      setRows(fruits.slice(0, 1))
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Apple"), "clamped")
      setup.mockInput.pressEnter()
      expect(picked).toEqual(["apple"])
    }),
  )
})

describe("select list rows", () => {
  it.live("draws decorations without letting the cursor stop on them", () =>
    Effect.gen(function* () {
      const picked: Array<string> = []
      const rows = (): ReadonlyArray<SelectListRow<Fruit>> => [
        decoration<Fruit>(() => <text>— Citrus —</text>),
        ...plainRows(fruits.slice(0, 1)),
        decoration<Fruit>(() => <text>— Berries —</text>),
        ...plainRows(fruits.slice(1)),
      ]

      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={rows}
            onSelect={(fruit) => picked.push(fruit.id)}
            onDismiss={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("— Berries —"), "open")
      // The first press moves past a heading onto the second fruit, not onto
      // the heading itself.
      setup.mockInput.pressArrow("down")
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Banana"), "second")
      setup.mockInput.pressEnter()
      expect(picked).toEqual(["banana"])
    }),
  )

  it.live("draws the empty fallback when nothing is selectable", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => []}
            empty={() => <text>nothing matches</text>}
            onSelect={() => {}}
            onDismiss={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("nothing matches"), "empty")
      expect(renderFrame(setup)).not.toContain("Apple")
    }),
  )
})

// ── components/docked-pane-frame.test ───────────────────────────────────────

/**
 * The ruled frame the docked panes share.
 *
 * `/model`, `/think`, `/thread` and the resume-branch pane draw the same `PickerFrame` the
 * slash-command popup does: ruled off top and bottom under the composer, not
 * a bordered box. These pin the two things that framing decides — the rows a
 * pane keeps to the height rule, and the columns a row may spend.
 *
 * The column budget is the part that has broken twice. A row pads itself one
 * column and sits inside a body that pads one each side, so a row ends one
 * column inside the rule. Budget it wider and the right-aligned tail wraps
 * onto a line of its own; budget it narrower and every row is cut short.
 */

const sessionId = SessionId.make("s1")
const branchId = BranchId.make("s1-branch")

/** Rows the frame occupies: its top rule through its footer. */
const renderedFrameRows = (frame: string): number => {
  const lines = frame.split("\n")
  const top = lines.findIndex((line) => line.startsWith("────"))
  const bottom = lines.findLastIndex((line) => line.startsWith("────"))
  expect(top).toBeGreaterThanOrEqual(0)
  expect(bottom).toBeGreaterThan(top)
  // The footer draws below the closing rule.
  return bottom - top + 2
}

const ruleWidth = (lines: ReadonlyArray<string>): number =>
  Option.getOrThrow(Option.fromNullishOr(lines.find((line) => line.startsWith("────")))).trimEnd()
    .length

/**
 * A window whose age renders, so a row can actually overflow its budget.
 *
 * The age is the only part of a thread row drawn against the right edge. A
 * fixture that leaves `updatedAt` at zero draws an empty age column, and no
 * row can overflow however long its preview is — which is exactly how the
 * agents pane shipped a visibly wrapping row past a green width test.
 */
const agedWindow = (updatedAt: number): ThreadWindow => ({
  sessionId,
  branchId,
  sessionName: "Session s1",
  index: 1,
  firstMessageId: "u1",
  lastMessageId: "a1",
  count: 2,
  summary: Option.none(),
  summarizedCount: 0,
  omittedCount: 0,
  preview: "P".repeat(300),
  updatedAt,
})

const branch = (id: string, name: string): Branch => ({
  id: BranchId.make(id),
  sessionId,
  name,
  createdAt: dateFromMillis(0),
})

/**
 * A branch whose label cannot fit any terminal.
 *
 * Unlike a thread or a settings row, a branch row has nothing anchored to the
 * right edge: `formatBranchLabel` draws one left-aligned `name (count)` and
 * stops. So a branch row can be cut short but can never wrap a tail onto a
 * line of its own, and the rendered frame cannot witness an overspent budget
 * on its own — which is why the budget itself is pinned below.
 */
const wideBranch = branch("branch-wide", "L".repeat(400))

const wideModel = new Model({
  id: ModelId.make("D".repeat(150)),
  name: "N".repeat(150),
  provider: ProviderId.make("test"),
})

describe("picker height rule", () => {
  it.live("counts the lines a pane draws, not the items it holds", () => {
    // A flat list spends one line per item; a pane that opens groups with
    // headings and closes with a detail line spends more, and counting items
    // alone would starve its body.
    expect(pickerLines(0, 1)).toBe(0)
    expect(pickerLines(3, 0)).toBe(3)
    expect(pickerLines(3, 1)).toBe(4)
    // Six rows is the cap, plus the frame's own five lines of chrome.
    expect(pickerHeight(pickerLines(20, 1), 40)).toBe(11)
    return Effect.void
  })
})

describe("docked panes", () => {
  it.live("the thread pane keeps the picker's height rule", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <ThreadPane
              open={true}
              controller={{
                windows: () => [agedWindow(0)],
                sessions: () => 1,
                current: () => Option.some({ sessionId, branchId }),
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                open: () => true,
              }}
              onSelect={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("open session"), "thread pane")
      // One heading, one window, one detail line: three drawn lines.
      expect(renderedFrameRows(renderFrame(setup))).toBe(pickerHeight(pickerLines(2, 1), 40))
    }),
  )

  it.live("the settings pane keeps the picker's height rule", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <SettingsPicker
              open={true}
              title="Model"
              rows={modelRows([wideModel])}
              current={Option.none()}
              onSelect={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("Model · 1"), "settings pane")
      // One row plus the query row above it.
      expect(renderedFrameRows(renderFrame(setup))).toBe(pickerHeight(pickerLines(1, 1), 40))
    }),
  )

  it.live("the resume-branch pane keeps the picker's height rule", () =>
    Effect.gen(function* () {
      // A flat list: no heading opens a group and no detail line follows it,
      // so the pane draws exactly the branches it holds and budgets items
      // rather than lines. It used to cap itself at sixteen rows of its own.
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <BranchPicker
              open={true}
              sessionId={sessionId}
              sessionName="Test Session"
              branches={[branch("b1", "main"), branch("b2", "side-quest")]}
              onSelect={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("side-quest"), "branch pane")
      expect(renderedFrameRows(renderFrame(setup))).toBe(pickerHeight(2, 40))
    }),
  )
})

describe("docked pane column budget", () => {
  it.live("a thread row keeps its age on the row, one column inside the rule", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <ThreadPane
              open={true}
              controller={{
                windows: () => [agedWindow(now - 2 * 24 * 60 * 60 * 1000)],
                sessions: () => 1,
                current: () => Option.some({ sessionId, branchId }),
                error: () => Option.none(),
                loading: () => false,
                refresh: () => {},
                open: () => true,
              }}
              onSelect={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 58, height: 30 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("PPP"), "thread row")
      const lines = renderFrame(setup).split("\n")
      const rowLines = lines.filter((line) => line.includes("PPP"))

      // The preview and the age share one line: the age never wraps alone.
      expect(rowLines.length).toBe(1)
      expect(rowLines[0]).toContain("2d")
      expect(lines.some((line) => line.trim() === "2d")).toBe(false)
      // A cut row ends one column inside the rule.
      expect(rowLines[0]?.trimEnd().length).toBe(ruleWidth(lines) - 1)
    }),
  )

  it.live("a settings row spends the picker's columns, not a bordered pane's", () =>
    Effect.gen(function* () {
      // The drawn row cannot witness an overspent budget: the row box clamps
      // its text, so a row budgeted four columns too wide still draws one
      // unwrapped line. The budget itself is the only place the spend stays
      // visible, and the wrap follows from it — the same reason the agents
      // pane pins these numbers rather than a rendered length.
      const seen: Array<{ row: number; section: number }> = []
      const Probe = () => {
        const { rowWidth, sectionWidth } = usePickerGeometry()
        seen.push({ row: rowWidth(), section: sectionWidth() })
        return <text>probe</text>
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <Probe />
              <SettingsPicker
                open={true}
                title="Model"
                rows={modelRows([wideModel])}
                current={Option.none()}
                onSelect={() => {}}
                onClose={() => {}}
              />
            </>
          ),
          { width: 58, height: 30 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("NNN"), "settings row")
      // A row pads itself one column inside a body that pads one each side.
      expect(seen[0]).toEqual({ row: 55, section: 56 })

      const lines = renderFrame(setup).split("\n")
      const rowLines = lines.filter((line) => line.includes("NNN"))
      // The name and its detail share one line rather than wrapping.
      expect(rowLines.length).toBe(1)
      expect(rowLines[0]?.trimEnd().length).toBe(ruleWidth(lines) - 1)
    }),
  )

  it.live("a branch row spends the picker's columns, not a bordered pane's", () =>
    Effect.gen(function* () {
      // The pane budgeted `width - 8` while it drew its own border and
      // margins. Ruled, it spends three: the body pads one each side and the
      // row pads one more on the left. The drawn row cannot witness the
      // difference — a row budgeted too wide is clamped by its own box — so
      // the budget is pinned here and the cut row is checked against the rule.
      const seen: Array<{ row: number; section: number }> = []
      const Probe = () => {
        const { rowWidth, sectionWidth } = usePickerGeometry()
        seen.push({ row: rowWidth(), section: sectionWidth() })
        return <text>probe</text>
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <Probe />
              <BranchPicker
                open={true}
                sessionId={sessionId}
                sessionName="Test Session"
                branches={[wideBranch]}
                onSelect={() => {}}
                onClose={() => {}}
              />
            </>
          ),
          {
            width: 58,
            height: 30,
            client: createMockClient({
              branch: {
                getTree: () =>
                  Effect.succeed([{ branch: wideBranch, messageCount: 4, children: [] }]),
              },
            }),
          },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("LLL"), "branch row")
      // A row pads itself one column inside a body that pads one each side.
      expect(seen[0]).toEqual({ row: 55, section: 56 })

      const lines = renderFrame(setup).split("\n")
      const rowLines = lines.filter((line) => line.includes("LLL"))
      // The label is cut, not wrapped onto a second line.
      expect(rowLines.length).toBe(1)
      // A cut row ends one column inside the rule, at every width measured.
      expect(rowLines[0]?.trimEnd().length).toBe(ruleWidth(lines) - 1)
    }),
  )
})
