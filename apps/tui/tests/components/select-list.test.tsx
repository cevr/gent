/** @jsxImportSource @opentui/solid */
/**
 * The one selectable list every pane mounts.
 *
 * These cover the block the panes used to hand-write: the wrapped cursor, the
 * filter input, the sticky anchor and when it yields, the empty fallback, and
 * the keys a pane claims for itself.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import {
  SelectList,
  SelectListEvent,
  SelectListState,
  decoration,
  selectable,
  transitionSelectList,
  type SelectListRow,
} from "../../src/components/select-list"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("> Apple"), "open"),
      )

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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Apple"), "open"),
      )
      setup.mockInput.pressEscape()
      // The mock terminal holds an escape until the next frame, so poll for the
      // effect rather than reading it on the press.
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => !open(), "dismissed"))
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Cherry"), "open"),
      )

      setup.mockInput.pressKey("a")
      setup.mockInput.pressKey("n")
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => !renderFrame(setup).includes("Cherry"), "narrowed"),
      )
      expect(seen).toEqual(["a", "an"])
      expect(renderFrame(setup)).toContain("› an")
      expect(renderFrame(setup)).toContain("> Banana")
      expect(renderFrame(setup)).not.toContain("Apple")

      setup.mockInput.pressBackspace()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Apple"), "widened"),
      )
      expect(seen).toEqual(["a", "an", "a"])
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
      expect(seen).toEqual([])
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Apple"), "open"),
      )
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("nothing yet"), "empty"),
      )

      setRows(fruits)
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("> Cherry"), "anchored"),
      )
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("> Cherry"), "anchored"),
      )

      // "an" matches Banana only; the cursor has to land on it rather than
      // being pulled back by the anchor.
      setup.mockInput.pressKey("a")
      setup.mockInput.pressKey("n")
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("> Banana"), "narrowed"),
      )
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("Cherry"), "open"),
      )
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("> Cherry"), "last row"),
      )

      setRows(fruits.slice(0, 1))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("> Apple"), "clamped"),
      )
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("— Berries —"), "open"),
      )
      // The first press moves past a heading onto the second fruit, not onto
      // the heading itself.
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("> Banana"), "second"),
      )
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
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("nothing matches"), "empty"),
      )
      expect(renderFrame(setup)).not.toContain("Apple")
    }),
  )
})
