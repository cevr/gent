/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Clock, Effect, Option } from "effect"
import { createSignal } from "solid-js"
import {
  decoration,
  pickerHeight,
  PickerFrame,
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
  type Branch,
} from "@gent/core/protocol"
import { BranchPicker, modelRows, SettingsPicker } from "../src/pickers"
import { ThreadPane, type ThreadWindow } from "../src/extensions/thread-view.client"

// ── select list ─────────────────────────────────────────────────────────────

/**
 * The one selectable list every pane mounts.
 *
 * These cover the wrapped cursor, the filter input, the sticky anchor and when
 * it yields, the cursor that follows its entry, the empty fallback, and the
 * keys a pane claims for itself.
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
      // A move marks the cursor as the reader's, so changed rows keep it on its entry.
      expect(down.moved).toBe(true)
      const retyped = transitionSelectList(down, SelectListEvent.cases.TypeChar.make({ char: "a" }))
      expect(retyped.moved).toBe(false)

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
      expect(typed).toEqual({ query: "a", selectedIndex: 0, moved: false })

      const anchored = transitionSelectList(
        typed,
        SelectListEvent.cases.Anchor.make({ selectedIndex: 2 }),
      )
      expect(anchored).toEqual({ query: "a", selectedIndex: 2, moved: false })

      const opened = transitionSelectList(
        typed,
        SelectListEvent.cases.Open.make({ selectedIndex: 1 }),
      )
      expect(opened).toEqual({ query: "", selectedIndex: 1, moved: false })
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
            rowKey={(fruit) => fruit.id}
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
            rowKey={(fruit) => fruit.id}
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
            rowKey={(fruit) => fruit.id}
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
            rowKey={(fruit) => fruit.id}
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
            rowKey={(fruit) => fruit.id}
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
            rowKey={(fruit) => fruit.id}
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
            rowKey={(fruit) => fruit.id}
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
            rowKey={(fruit) => fruit.id}
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

  it.live("a key two rows share keeps the cursor on the one nearest where it was", () =>
    Effect.gen(function* () {
      // Two entries share a key; the reader sits on the second. A new entry
      // lands on top, and the cursor must stay on the second, not jump to
      // the first match of its key.
      const older: Fruit = { id: "apple", name: "Older apple" }
      const [rows, setRows] = createSignal<ReadonlyArray<Fruit>>([
        { id: "apple", name: "Newer apple" },
        { id: "banana", name: "Banana" },
        { id: "kiwi", name: "Kiwi" },
        older,
      ])
      const picked: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => plainRows(rows())}
            rowKey={(fruit) => fruit.id}
            onSelect={(fruit) => picked.push(fruit.name)}
            onDismiss={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Newer apple"), "open")
      setup.mockInput.pressArrow("up")
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Older apple"), "moved")

      setRows([
        { id: "cherry", name: "Cherry" },
        { id: "apple", name: "Newer apple" },
        ...rows().slice(1),
      ])
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      expect(picked).toEqual(["Older apple"])
    }),
  )

  it.live("keeps the cursor on the reader's row when the rows arrive again reordered", () =>
    Effect.gen(function* () {
      // A pane that polls hands the list fresh objects, in a new order. The
      // cursor the reader moved stays on the same entry, not the same index
      // and not the sticky row.
      const [rows, setRows] = createSignal<ReadonlyArray<Fruit>>(fruits)
      const picked: Array<string> = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <SelectList
            id="fruit"
            open={true}
            rows={() => plainRows(rows())}
            rowKey={(fruit) => fruit.id}
            sticky={(values) => Option.some(values.findIndex((fruit) => fruit.id === "cherry"))}
            onSelect={(fruit) => picked.push(fruit.id)}
            onDismiss={() => {}}
          />
        )),
      )
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Cherry"), "anchored")
      setup.mockInput.pressArrow("up")
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Banana"), "moved")

      setRows([
        { id: "banana", name: "Banana" },
        { id: "cherry", name: "Cherry" },
        { id: "apple", name: "Apple" },
      ])
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("> Banana")
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
            rowKey={(fruit) => fruit.id}
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
            rowKey={(fruit) => fruit.id}
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
            rows={(): ReadonlyArray<SelectListRow<Fruit>> => []}
            rowKey={(fruit) => fruit.id}
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

// ── docked pane frame ───────────────────────────────────────────────────────

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
  it.live("six body lines is the cap, plus the frame's own four lines of chrome", () => {
    expect(pickerHeight(2, 40)).toBe(6)
    expect(pickerHeight(20, 40)).toBe(10)
    // A query row above the list sits outside the cap: six rows still show.
    expect(pickerHeight(20, 40, 1)).toBe(11)
    // Never more than half the terminal.
    expect(pickerHeight(20, 12)).toBe(7)
    return Effect.void
  })

  /** A frame over a two-row list, which reports its rows; the frame's rows once drawn at 80×40. */
  const frameRows = (note: {
    readonly detail?: Option.Option<string>
    readonly error?: Option.Option<string>
  }) =>
    Effect.gen(function* () {
      const bodyRows = (): ReadonlyArray<SelectListRow<string>> =>
        ["BODY-1", "BODY-2"].map((label) =>
          selectable(label, (_selected, id) => (
            <box id={id}>
              <text>{label}</text>
            </box>
          )),
        )
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <PickerFrame title="TITLE" footer="KEY-HINT" {...note}>
              <SelectList
                id="frame-rows"
                open={true}
                rows={bodyRows}
                rowKey={(label) => label}
                onSelect={() => {}}
                onDismiss={() => {}}
              />
            </PickerFrame>
          ),
          { width: 80, height: 40 },
        ),
      )
      yield* waitForFrame(setup, (frame) => frame.includes("KEY-HINT"), "frame")
      return { rows: renderedFrameRows(renderFrame(setup)), frame: renderFrame(setup) }
    })

  it.live("a pane with a detail line gets its row, drawn or not yet", () =>
    Effect.gen(function* () {
      expect((yield* frameRows({})).rows).toBe(pickerHeight(2, 40))
      // The row stays while the detail has nothing to say, so the pane does
      // not jump when the text arrives.
      const waiting = yield* frameRows({ detail: Option.none() })
      expect(waiting.rows).toBe(pickerHeight(3, 40))
      const empty = yield* frameRows({ detail: Option.some("") })
      expect(empty.rows).toBe(pickerHeight(3, 40))
      const said = yield* frameRows({ detail: Option.some("DETAIL-LINE") })
      expect(said.rows).toBe(pickerHeight(3, 40))
      expect(said.frame).toContain("DETAIL-LINE")
    }),
  )

  it.live("an error draws in the note row and is budgeted as it", () =>
    Effect.gen(function* () {
      const failed = yield* frameRows({ error: Option.some("ERROR-LINE") })
      expect(failed.rows).toBe(pickerHeight(3, 40))
      expect(failed.frame).toContain("ERROR-LINE")
      const both = yield* frameRows({
        detail: Option.some("DETAIL-LINE"),
        error: Option.some("ERROR-LINE"),
      })
      expect(both.rows).toBe(pickerHeight(3, 40))
      expect(both.frame).toContain("ERROR-LINE")
      expect(both.frame).not.toContain("DETAIL-LINE")
    }),
  )
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
      expect(renderedFrameRows(renderFrame(setup))).toBe(pickerHeight(3, 40))
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
      expect(renderedFrameRows(renderFrame(setup))).toBe(pickerHeight(2, 40))
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

  // The frame asks for its chrome as it draws it: two rules, the title and
  // the key hint. A flat list of three draws no blank row under its last row.
  it.live("a flat list closes on its rule under its last row", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <BranchPicker
              open={true}
              sessionId={sessionId}
              sessionName="Test Session"
              branches={[branch("b1", "main"), branch("b2", "side-quest"), branch("b3", "third")]}
              onSelect={() => {}}
              onClose={() => {}}
            />
          ),
          { width: 80, height: 40 },
        ),
      )
      const frame = yield* waitForFrame(setup, (current) => current.includes("third"), "pane")
      const lines = frame.split("\n")
      const bottom = lines.findLastIndex((line) => line.startsWith("────"))
      expect(lines[bottom - 1]).toContain("third")
    }),
  )
})

/**
 * A frame asking for `height()` rows inside a 10-row column. The frame's
 * measured height stays 10 whenever it asks for 10 or more, so a change of
 * the requested height alone must re-decide whether the key hint shows.
 */
const mountSqueezableFrame = (initial: number) =>
  Effect.gen(function* () {
    const [height, setHeight] = createSignal(initial)
    const setup = yield* Effect.promise(() =>
      renderWithProviders(
        () => (
          <box flexDirection="column" height={10} maxHeight={10}>
            <PickerFrame height={height()} title="TITLE" footer="KEY-HINT">
              <box flexDirection="column" flexGrow={1}>
                <text>BODY-1</text>
              </box>
            </PickerFrame>
          </box>
        ),
        { width: 40, height: 20 },
      ),
    )
    return { setup, setHeight }
  })

describe("picker squeeze", () => {
  it.live("a squeezed frame that then asks for exactly the rows it has shows its key hint", () =>
    Effect.gen(function* () {
      const { setup, setHeight } = yield* mountSqueezableFrame(14)
      yield* waitForFrame(
        setup,
        (frame) => frame.includes("TITLE") && !frame.includes("KEY-HINT"),
        "squeezed frame",
      )
      setHeight(10)
      yield* waitForFrame(setup, (frame) => frame.includes("KEY-HINT"), "key hint back", 1_000)
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("a frame that fits and then asks for more rows than it has drops its key hint", () =>
    Effect.gen(function* () {
      const { setup, setHeight } = yield* mountSqueezableFrame(10)
      yield* waitForFrame(setup, (frame) => frame.includes("KEY-HINT"), "fitting frame")
      setHeight(14)
      yield* waitForFrame(setup, (frame) => !frame.includes("KEY-HINT"), "key hint gone", 1_000)
    }).pipe(Effect.timeout("4 seconds")),
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
