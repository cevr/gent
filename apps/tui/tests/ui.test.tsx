/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "effect-bun-test"
import { Clock, Effect, Option } from "effect"
import { createSignal, type JSX, Show } from "solid-js"
import {
  type CliRenderer,
  NativeSpanFeed,
  OptimizedBuffer,
  resolveRenderLib,
  RGBA,
  TextAttributes,
  TextRenderable,
} from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { Terminal } from "@xterm/headless"
import {
  AgentMessageRow,
  CaretLine,
  caretWindow,
  CollapsedRow,
  decoration,
  groupedRows,
  keyHint,
  keyHintsLine,
  KeyHints,
  pickerHeight,
  PickerFrame,
  selectable,
  SelectList,
  SelectListEvent,
  type SelectListRow,
  SelectListState,
  transitionSelectList,
  usePickerGeometry,
  UserRow,
} from "../src/ui"
import { useRenderer } from "@opentui/solid"
import { useScopedKeyboard } from "../src/terminal"
import {
  answerPalette,
  columnBackgrounds,
  createMockClient,
  darkTerminalColors,
  renderFrame,
  renderScoped,
  TerminalOutput,
} from "./render-harness-boundary"
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
import { useTheme } from "../src/theme"
import type { DisclosureLevel } from "../src/extensions/client-facets"
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

describe("caret line", () => {
  test("a caret in a line wider than the room keeps text on both sides in view", () => {
    const text = `start ${"m".repeat(30)} finish`
    const line: CaretLine = { text, caret: text.indexOf("finish") }
    const shown = caretWindow(line, 21)
    // 20 columns of text: up to a third goes after the caret, the rest before it.
    expect(shown).toEqual({ before: "…mmmmmmmmmmmm ", after: "finish" })
    const early: CaretLine = { text, caret: 0 }
    expect(caretWindow(early, 21)).toEqual({ before: "", after: "start mmmmmmmmmmmmm…" })
    expect(caretWindow({ text: "short", caret: 2 }, 21)).toEqual({ before: "sh", after: "ort" })
  })

  test("an insert that joins two characters into one puts the caret after the whole character", () => {
    // A ZWJ between two women makes one grapheme, 👩‍👩, with boundaries 0 and 5.
    const line = CaretLine.insert({ text: "👩👩", caret: "👩".length }, "\u200d")
    expect(line).toEqual({ text: "👩\u200d👩", caret: "👩\u200d👩".length })
  })

  test("an insert at the caret lands between whole characters", () => {
    const line = CaretLine.insert({ text: "a👍🏽b", caret: "a👍🏽".length }, "c")
    expect(line).toEqual({ text: "a👍🏽cb", caret: "a👍🏽c".length })
  })
})

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
      const retyped = transitionSelectList(down, SelectListEvent.cases.Type.make({ text: "a" }))
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
        SelectListEvent.cases.Type.make({ text: "a" }),
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
  it.scopedLive("moves with arrows and control keys, and selects with enter", () =>
    Effect.gen(function* () {
      const picked: Array<string> = []
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={() => plainRows(fruits)}
          rowKey={(fruit) => fruit.id}
          onSelect={(fruit) => picked.push(fruit.id)}
          onDismiss={() => {}}
        />
      ))
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

  it.scopedLive("dismisses on escape", () =>
    Effect.gen(function* () {
      const [open, setOpen] = createSignal(true)
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={open()}
          rows={() => plainRows(fruits)}
          rowKey={(fruit) => fruit.id}
          onSelect={() => {}}
          onDismiss={() => setOpen(false)}
        />
      ))
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Apple"), "open")
      setup.mockInput.pressEscape()
      // The mock terminal holds an escape until the next frame, so poll for the
      // effect rather than reading it on the press.
      yield* waitForFrame(setup, () => !open(), "dismissed")
      expect(open()).toBe(false)
    }),
  )

  it.scopedLive("gives a pane its own keys before the list sees them", () =>
    Effect.gen(function* () {
      const armed: Array<string> = []
      const setup = yield* renderScoped(() => (
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
      ))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressArrow("down")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressKey("x", { ctrl: true })
      expect(armed).toEqual(["banana"])
    }),
  )

  it.scopedLive("leaves every key alone while closed", () =>
    Effect.gen(function* () {
      const picked: Array<string> = []
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={false}
          rows={() => plainRows(fruits)}
          rowKey={(fruit) => fruit.id}
          onSelect={(fruit) => picked.push(fruit.id)}
          onDismiss={() => {}}
        />
      ))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      expect(picked).toEqual([])
    }),
  )
})

describe("select list filter", () => {
  it.scopedLive("draws the query, reports every change, and narrows the rows", () =>
    Effect.gen(function* () {
      const [query, setQuery] = createSignal("")
      const seen: Array<string> = []
      const visible = () =>
        fruits.filter((fruit) => fruit.name.toLowerCase().includes(query().toLowerCase()))

      const setup = yield* renderScoped(() => (
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
      ))
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

  it.scopedLive("ignores control characters as filter input", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={() => plainRows(fruits)}
          rowKey={(fruit) => fruit.id}
          filter={{ onQueryChange: (next) => seen.push(next) }}
          onSelect={() => {}}
          onDismiss={() => {}}
        />
      ))
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressTab()
      yield* Effect.promise(() => setup.renderOnce())
      // Only the open reset; tab contributed nothing.
      expect(seen).toEqual([""])
    }),
  )

  for (const [protocol, kittyKeyboard] of [
    ["legacy", false],
    ["kitty", true],
  ] as const) {
    it.scopedLive(`takes Unicode text and deletes it a character at a time (${protocol})`, () =>
      Effect.gen(function* () {
        const seen: Array<string> = []
        const setup = yield* renderScoped(
          () => (
            <SelectList
              id="fruit"
              open={true}
              rows={() => plainRows(fruits)}
              rowKey={(fruit) => fruit.id}
              filter={{ onQueryChange: (next) => seen.push(next) }}
              onSelect={() => {}}
              onDismiss={() => {}}
            />
          ),
          { kittyKeyboard },
        )
        yield* waitForFrame(setup, () => renderFrame(setup).includes("Cherry"), "open")
        // Under kitty, é arrives as its code point (`CSI 233 u`). The mock's
        // `typeText` splits by UTF-16 unit, so the emoji goes as one key.
        yield* Effect.promise(() => setup.mockInput.typeText("é"))
        setup.mockInput.pressKey("🍒")
        yield* waitForFrame(setup, () => seen.at(-1) === "é🍒", "Unicode query")
        // One backspace takes the whole emoji, never half of its surrogate pair.
        setup.mockInput.pressBackspace()
        yield* waitForFrame(setup, () => seen.at(-1) === "é", "one character deleted")
        // A character drawn from several code points (a skin tone, a flag) goes whole too.
        yield* Effect.promise(() => setup.mockInput.pasteBracketedText("👍🏽🇺🇸"))
        yield* waitForFrame(setup, () => seen.at(-1) === "é👍🏽🇺🇸", "emoji pasted")
        setup.mockInput.pressBackspace()
        yield* waitForFrame(setup, () => seen.at(-1) !== "é👍🏽🇺🇸", "flag deleted")
        expect(seen.at(-1)).toBe("é👍🏽")
        setup.mockInput.pressBackspace()
        yield* waitForFrame(setup, () => seen.at(-1) !== "é👍🏽", "thumb deleted")
        expect(seen.at(-1)).toBe("é")
        expect(renderFrame(setup)).toContain("› é")
      }),
    )
  }

  it.scopedLive("a paste joins the query as one line, its control sequences dropped", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={() => plainRows(fruits)}
          rowKey={(fruit) => fruit.id}
          filter={{ onQueryChange: (next) => seen.push(next) }}
          onSelect={() => {}}
          onDismiss={() => {}}
        />
      ))
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Cherry"), "open")
      setup.mockInput.pressKey("c")
      yield* Effect.promise(() => setup.mockInput.pasteBracketedText("h\u001b[31mer\u001b[0m\nry"))
      yield* waitForFrame(setup, () => seen.at(-1) === "cher ry", "pasted query")
      expect(seen).toEqual(["", "c", "cher ry"])
    }),
  )

  it.scopedLive("ctrl+w deletes the last word and ctrl+u the whole query, as in the composer", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={() => plainRows(fruits)}
          rowKey={(fruit) => fruit.id}
          filter={{ onQueryChange: (next) => seen.push(next) }}
          onSelect={() => {}}
          onDismiss={() => {}}
        />
      ))
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Cherry"), "open")
      yield* Effect.promise(() => setup.mockInput.typeText("son net"))
      yield* waitForFrame(setup, () => seen.at(-1) === "son net", "typed")
      setup.mockInput.pressKey("w", { ctrl: true })
      yield* waitForFrame(setup, () => seen.at(-1) !== "son net", "a key that edits")
      expect(seen.at(-1)).toBe("son ")
      yield* Effect.promise(() => setup.mockInput.typeText("é"))
      yield* waitForFrame(setup, () => seen.at(-1) === "son é", "typed again")
      setup.mockInput.pressKey("u", { ctrl: true })
      yield* waitForFrame(setup, () => seen.at(-1) === "", "the query cleared")
      expect(renderFrame(setup)).toContain("Cherry")
    }),
  )

  it.scopedLive("alt+backspace and ctrl+backspace delete the last word, as in the composer", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={() => plainRows(fruits)}
          rowKey={(fruit) => fruit.id}
          filter={{ onQueryChange: (next) => seen.push(next) }}
          onSelect={() => {}}
          onDismiss={() => {}}
        />
      ))
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Cherry"), "open")
      yield* Effect.promise(() => setup.mockInput.typeText("one son net"))
      yield* waitForFrame(setup, () => seen.at(-1) === "one son net", "typed")
      setup.mockInput.pressKey("BACKSPACE", { meta: true })
      yield* waitForFrame(setup, () => seen.at(-1) !== "one son net", "alt+backspace edits")
      expect(seen.at(-1)).toBe("one son ")
      setup.mockInput.pressKey("BACKSPACE", { ctrl: true })
      yield* waitForFrame(setup, () => seen.at(-1) !== "one son ", "ctrl+backspace edits")
      expect(seen.at(-1)).toBe("one ")
      setup.mockInput.pressKey("BACKSPACE")
      yield* waitForFrame(setup, () => seen.at(-1) !== "one ", "backspace edits")
      expect(seen.at(-1)).toBe("one")
    }),
  )

  it.scopedLive(
    "leaves shortcut keys, and a paste into a list with no filter, to the scopes under it",
    () =>
      Effect.gen(function* () {
        const passed: Array<string> = []
        const Below = () => {
          useScopedKeyboard(
            (event) => {
              passed.push(`key ${event.name}`)
              return true
            },
            {
              paste: (text) => {
                passed.push(`paste ${text}`)
                return true
              },
            },
          )
          return <></>
        }
        const seen: Array<string> = []
        const [filtered, setFiltered] = createSignal(true)
        const setup = yield* renderScoped(
          () => (
            <>
              <Below />
              <Show
                when={filtered()}
                fallback={
                  <SelectList
                    id="plain"
                    open={true}
                    rows={() => plainRows(fruits)}
                    rowKey={(fruit) => fruit.id}
                    onSelect={() => {}}
                    onDismiss={() => {}}
                  />
                }
              >
                <SelectList
                  id="fruit"
                  open={true}
                  rows={() => plainRows(fruits)}
                  rowKey={(fruit) => fruit.id}
                  filter={{ onQueryChange: (next) => seen.push(next) }}
                  onSelect={() => {}}
                  onDismiss={() => {}}
                />
              </Show>
            </>
          ),
          { kittyKeyboard: true },
        )
        yield* waitForFrame(setup, () => renderFrame(setup).includes("Cherry"), "open")
        setup.mockInput.pressKey("a", { ctrl: true })
        setup.mockInput.pressKey("b", { meta: true })
        yield* waitForFrame(setup, () => passed.length === 2, "shortcuts passed on")
        expect(passed).toEqual(["key a", "key b"])
        expect(seen).toEqual([""])

        setFiltered(false)
        yield* Effect.promise(() => setup.mockInput.pasteBracketedText("plain"))
        yield* waitForFrame(setup, () => passed.length === 3, "paste passed on")
        expect(passed.at(-1)).toBe("paste plain")
      }),
  )
})

describe("select list sticky selection", () => {
  it.scopedLive("moves the cursor onto the anchored row when the data lands", () =>
    Effect.gen(function* () {
      // The fetch resolves after the pane mounts, which is why the anchor
      // cannot be applied once at open time.
      const [rows, setRows] = createSignal<ReadonlyArray<Fruit>>([])
      const setup = yield* renderScoped(() => (
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
          loading={() => rows().length === 0}
          onSelect={() => {}}
          onDismiss={() => {}}
        />
      ))
      yield* waitForFrame(setup, () => renderFrame(setup).includes("Loading…"), "loading")

      setRows(fruits)
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Cherry"), "anchored")
      expect(renderFrame(setup)).toContain("  Apple")
    }),
  )

  it.scopedLive("stops re-anchoring once the reader has typed", () =>
    Effect.gen(function* () {
      // A sticky rule that keeps firing while the filter narrows drags the
      // cursor off whatever the reader is looking for.
      const [query, setQuery] = createSignal("")
      const visible = () =>
        fruits.filter((fruit) => fruit.name.toLowerCase().includes(query().toLowerCase()))
      const picked: Array<string> = []

      const setup = yield* renderScoped(() => (
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
      ))
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

  it.scopedLive("a key two rows share keeps the cursor on the one nearest where it was", () =>
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
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={() => plainRows(rows())}
          rowKey={(fruit) => fruit.id}
          onSelect={(fruit) => picked.push(fruit.name)}
          onDismiss={() => {}}
        />
      ))
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

  it.scopedLive("keeps the cursor on the reader's row when the rows arrive again reordered", () =>
    Effect.gen(function* () {
      // A pane that polls hands the list fresh objects, in a new order. The
      // cursor the reader moved stays on the same entry, not the same index
      // and not the sticky row.
      const [rows, setRows] = createSignal<ReadonlyArray<Fruit>>(fruits)
      const picked: Array<string> = []
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={() => plainRows(rows())}
          rowKey={(fruit) => fruit.id}
          sticky={(values) => Option.some(values.findIndex((fruit) => fruit.id === "cherry"))}
          onSelect={(fruit) => picked.push(fruit.id)}
          onDismiss={() => {}}
        />
      ))
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

  it.scopedLive("keeps the cursor inside a list that shrank under it", () =>
    Effect.gen(function* () {
      const [rows, setRows] = createSignal(fruits)
      const picked: Array<string> = []
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={() => plainRows(rows())}
          rowKey={(fruit) => fruit.id}
          onSelect={(fruit) => picked.push(fruit.id)}
          onDismiss={() => {}}
        />
      ))
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
  test("a heading opens each run of one group and counts the group", () => {
    const rows = groupedRows(
      ["a1", "a2", "b1"],
      (item) => item.slice(0, 1),
      (first, count) => selectable(`# ${first.slice(0, 1)} ${count}`, () => <box />),
      (item) => selectable(item, () => <box />),
    )
    expect(rows.map((row) => Option.getOrElse(row.value, () => ""))).toEqual([
      "# a 2",
      "a1",
      "a2",
      "# b 1",
      "b1",
    ])
  })

  it.scopedLive("draws decorations without letting the cursor stop on them", () =>
    Effect.gen(function* () {
      const picked: Array<string> = []
      const rows = (): ReadonlyArray<SelectListRow<Fruit>> => [
        decoration<Fruit>(() => <text>— Citrus —</text>),
        ...plainRows(fruits.slice(0, 1)),
        decoration<Fruit>(() => <text>— Berries —</text>),
        ...plainRows(fruits.slice(1)),
      ]

      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={rows}
          rowKey={(fruit) => fruit.id}
          onSelect={(fruit) => picked.push(fruit.id)}
          onDismiss={() => {}}
        />
      ))
      yield* waitForFrame(setup, () => renderFrame(setup).includes("— Berries —"), "open")
      // The first press moves past a heading onto the second fruit, not onto
      // the heading itself.
      setup.mockInput.pressArrow("down")
      yield* waitForFrame(setup, () => renderFrame(setup).includes("> Banana"), "second")
      setup.mockInput.pressEnter()
      expect(picked).toEqual(["banana"])
    }),
  )

  // One empty row for every list: the words name the state, the same in each pane.
  it.scopedLive("an empty list says loading, no matches, or nothing here", () =>
    Effect.gen(function* () {
      const [loading, setLoading] = createSignal(true)
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={(): ReadonlyArray<SelectListRow<Fruit>> => []}
          rowKey={(fruit) => fruit.id}
          filter={{ onQueryChange: () => {} }}
          loading={loading}
          onSelect={() => {}}
          onDismiss={() => {}}
        />
      ))
      yield* waitForFrame(setup, (frame) => frame.includes("Loading…"), "loading")
      setLoading(false)
      yield* waitForFrame(setup, (frame) => frame.includes("Nothing here"), "nothing here")
      yield* Effect.promise(() => setup.mockInput.typeText("kiwi"))
      yield* waitForFrame(setup, (frame) => frame.includes("No matches"), "no matches")
    }),
  )

  it.scopedLive("a pane's own empty row replaces the list's, when it has one", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => (
        <SelectList
          id="fruit"
          open={true}
          rows={(): ReadonlyArray<SelectListRow<Fruit>> => []}
          rowKey={(fruit) => fruit.id}
          empty={() => Option.some(<text>Press r to retry.</text>)}
          onSelect={() => {}}
          onDismiss={() => {}}
        />
      ))
      yield* waitForFrame(setup, (frame) => frame.includes("Press r to retry."), "own row")
      expect(renderFrame(setup)).not.toContain("Nothing here")
    }),
  )
})

// ── docked pane frame ───────────────────────────────────────────────────────

/**
 * The ruled frame the docked panes share.
 *
 * `/model`, `/effort`, `/thread` and the resume-branch pane draw the same `PickerFrame` the
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
      const setup = yield* renderScoped(
        () => (
          <PickerFrame
            title="TITLE"
            keys={[keyHint("KEY-HINT", "go")]}
            error={Option.none()}
            {...note}
          >
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
      )
      yield* waitForFrame(setup, (frame) => frame.includes("KEY-HINT"), "frame")
      return { rows: renderedFrameRows(renderFrame(setup)), frame: renderFrame(setup) }
    })

  it.scopedLive("a pane with a detail line gets its row, drawn or not yet", () =>
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

  it.scopedLive("an error draws in the note row and is budgeted as it", () =>
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

describe("key hints", () => {
  const keys = [KeyHints.move, KeyHints.select, KeyHints.delete, KeyHints.close]

  test("one spelling: lowercase keys joined by one separator", () => {
    expect(keyHintsLine(keys, 80)).toBe("↑↓ move · enter select · ctrl+x delete · esc close")
  })

  test("a narrow row drops the move hint first, then from the right, and keeps the way out", () => {
    expect(keyHintsLine(keys, 40)).toBe("enter select · ctrl+x delete · esc close")
    expect(keyHintsLine(keys, 26)).toBe("enter select · esc close")
    expect(keyHintsLine(keys, 4)).toBe("esc close")
  })

  test("a short verb comes before a dropped key: the move hint goes, then verbs shorten from the right", () => {
    const own = [
      KeyHints.move,
      keyHint("enter", "files + conversation", "all"),
      keyHint("f", "files only"),
      KeyHints.close,
    ]
    expect(keyHintsLine(own, 60)).toBe("enter files + conversation · f files only · esc close")
    expect(keyHintsLine(own, 40)).toBe("enter all · f files only · esc close")
    expect(keyHintsLine(own, 30)).toBe("enter all · esc close")
  })
})

describe("docked panes", () => {
  it.scopedLive("the thread pane keeps the picker's height rule", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <ThreadPane
            open={true}
            controller={{
              windows: () => [agedWindow(0)],
              sessions: () => 1,
              current: () => ({ sessionId, branchId }),
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
      )
      yield* waitForFrame(setup, (frame) => frame.includes("enter select"), "thread pane")
      // One heading, one window, one detail line: three drawn lines.
      expect(renderedFrameRows(renderFrame(setup))).toBe(pickerHeight(3, 40))
    }),
  )

  it.scopedLive("the settings pane keeps the picker's height rule", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
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
      )
      yield* waitForFrame(setup, (frame) => frame.includes("Model · 1"), "settings pane")
      // One row plus the query row above it.
      expect(renderedFrameRows(renderFrame(setup))).toBe(pickerHeight(2, 40))
    }),
  )

  it.scopedLive("the resume-branch pane keeps the picker's height rule", () =>
    Effect.gen(function* () {
      // A flat list: no heading opens a group and no detail line follows it,
      // so the pane draws exactly the branches it holds and budgets items
      // rather than lines. It used to cap itself at sixteen rows of its own.
      const setup = yield* renderScoped(
        () => (
          <BranchPicker
            open={true}
            sessionId={sessionId}
            sessionName="Test Session"
            branches={[branch("b1", "main"), branch("b2", "side-quest")]}
            onSelect={() => {}}
          />
        ),
        { width: 80, height: 40 },
      )
      yield* waitForFrame(setup, (frame) => frame.includes("side-quest"), "branch pane")
      expect(renderedFrameRows(renderFrame(setup))).toBe(pickerHeight(2, 40))
    }),
  )

  // The frame asks for its chrome as it draws it: two rules, the title and
  // the key hint. A flat list of three draws no blank row under its last row.
  it.scopedLive("a flat list closes on its rule under its last row", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <BranchPicker
            open={true}
            sessionId={sessionId}
            sessionName="Test Session"
            branches={[branch("b1", "main"), branch("b2", "side-quest"), branch("b3", "third")]}
            onSelect={() => {}}
          />
        ),
        { width: 80, height: 40 },
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
    const setup = yield* renderScoped(
      () => (
        <box flexDirection="column" height={10} maxHeight={10}>
          <PickerFrame
            height={height()}
            title="TITLE"
            keys={[keyHint("KEY-HINT", "go")]}
            error={Option.none()}
          >
            <box flexDirection="column" flexGrow={1}>
              <text>BODY-1</text>
            </box>
          </PickerFrame>
        </box>
      ),
      { width: 40, height: 20 },
    )
    return { setup, setHeight }
  })

describe("picker squeeze", () => {
  it.scopedLive(
    "a squeezed frame that then asks for exactly the rows it has shows its key hint",
    () =>
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

  it.scopedLive(
    "a frame that fits and then asks for more rows than it has drops its key hint",
    () =>
      Effect.gen(function* () {
        const { setup, setHeight } = yield* mountSqueezableFrame(10)
        yield* waitForFrame(setup, (frame) => frame.includes("KEY-HINT"), "fitting frame")
        setHeight(14)
        yield* waitForFrame(setup, (frame) => !frame.includes("KEY-HINT"), "key hint gone", 1_000)
      }).pipe(Effect.timeout("4 seconds")),
  )
})

describe("docked pane column budget", () => {
  it.scopedLive("a thread row keeps its age on the row, one column inside the rule", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const setup = yield* renderScoped(
        () => (
          <ThreadPane
            open={true}
            controller={{
              windows: () => [agedWindow(now - 2 * 24 * 60 * 60 * 1000)],
              sessions: () => 1,
              current: () => ({ sessionId, branchId }),
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

  it.scopedLive("a settings row spends the picker's columns, not a bordered pane's", () =>
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
      const setup = yield* renderScoped(
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

  it.scopedLive("a branch row spends the picker's columns, not a bordered pane's", () =>
    Effect.gen(function* () {
      // The pane budgeted `width - 8` while it drew its own border and
      // margins. Ruled, it spends three: the body pads one each side and the
      // row pads one more on the left. The drawn row cannot witness the
      // difference — a row budgeted too wide is clamped by its own box — so
      // the settings test above pins the shared `usePickerGeometry` budget,
      // and here the cut row is checked against the rule.
      const setup = yield* renderScoped(
        () => (
          <BranchPicker
            open={true}
            sessionId={sessionId}
            sessionName="Test Session"
            branches={[wideBranch]}
            onSelect={() => {}}
          />
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
      )
      yield* waitForFrame(setup, (frame) => frame.includes("LLL"), "branch row")
      const lines = renderFrame(setup).split("\n")
      const rowLines = lines.filter((line) => line.includes("LLL"))
      // The label is cut, not wrapped onto a second line.
      expect(rowLines.length).toBe(1)
      // A cut row ends one column inside the rule, at every width measured.
      expect(rowLines[0]?.trimEnd().length).toBe(ruleWidth(lines) - 1)
    }),
  )
})

// ── box borders under a scissor ─────────────────────────────────────────────

/**
 * A box drawn under a scissor (a clipped parent, such as the live tail that
 * cuts off a prompt's top rows) shows inside the scissor what the same box
 * drawn alone shows there, and leaves every cell outside it as it was: the
 * scissor crops the box, it does not lay the box or its titles out again.
 * OpenTUI's border fast path wrote past the scissor (`patches/README.md`).
 */
describe("box borders under a scissor", () => {
  const WIDTH = 24
  const HEIGHT = 8

  interface Rect {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }

  type BoxOptions = Parameters<OptimizedBuffer["drawBox"]>[0]

  const borderColor = RGBA.fromInts(200, 200, 200, 255)
  const clearBackground = RGBA.fromInts(0, 0, 0, 0)
  const solidBackground = RGBA.fromInts(10, 20, 30, 255)
  const groundColor = RGBA.fromInts(90, 90, 90, 255)
  const box = { x: 2, y: 1, width: 20, height: 6, border: true, borderColor } as const

  /** A buffer with a dot in every cell, so a cell a draw changed shows. */
  const groundBuffer = Effect.acquireRelease(
    Effect.sync(() => {
      const buffer = OptimizedBuffer.create(WIDTH, HEIGHT, "unicode")
      for (let y = 0; y < HEIGHT; y++) buffer.drawText(".".repeat(WIDTH), 0, y, groundColor)
      return buffer
    }),
    (buffer) => Effect.sync(() => buffer.destroy()),
  )

  /** Every cell as its char, colors and attributes. */
  const cellsOf = (buffer: OptimizedBuffer): string[] => {
    const { char, fg, bg, attributes } = buffer.buffers
    return Array.from({ length: WIDTH * HEIGHT }, (_, at) =>
      [
        char[at],
        ...fg.subarray(at * 4, at * 4 + 4),
        ...bg.subarray(at * 4, at * 4 + 4),
        attributes[at],
      ].join(","),
    )
  }

  /** The cells after `options` is drawn under each of `clips`, the last innermost. */
  const drawn = (clips: ReadonlyArray<Rect>, options: Option.Option<BoxOptions>) =>
    Effect.gen(function* () {
      const buffer = yield* groundBuffer
      for (const clip of clips) buffer.pushScissorRect(clip.x, clip.y, clip.width, clip.height)
      if (Option.isSome(options)) buffer.drawBox(options.value)
      for (const _clip of clips) buffer.popScissorRect()
      return cellsOf(buffer)
    })

  const inside = (clips: ReadonlyArray<Rect>, at: number) => {
    const x = at % WIDTH
    const y = Math.floor(at / WIDTH)
    return clips.every(
      (clip) => x >= clip.x && x < clip.x + clip.width && y >= clip.y && y < clip.y + clip.height,
    )
  }

  /** The rows of `cells`, so a failure names the row that differs. */
  const rowsOf = (cells: ReadonlyArray<string>) =>
    Array.from({ length: HEIGHT }, (_, y) => cells.slice(y * WIDTH, (y + 1) * WIDTH).join(" | "))

  const cases: ReadonlyArray<{
    readonly name: string
    readonly clips: ReadonlyArray<Rect>
    readonly options: BoxOptions
  }> = [
    {
      name: "a left title cut at its start",
      clips: [{ x: 6, y: 0, width: 18, height: HEIGHT }],
      options: { ...box, backgroundColor: clearBackground, title: "TITLE" },
    },
    {
      name: "a centered title cut on its left",
      clips: [{ x: 10, y: 0, width: 14, height: HEIGHT }],
      options: {
        ...box,
        backgroundColor: clearBackground,
        title: "CENTER",
        titleAlignment: "center",
      },
    },
    {
      name: "a right title cut on its right",
      clips: [{ x: 0, y: 0, width: 18, height: HEIGHT }],
      options: {
        ...box,
        backgroundColor: clearBackground,
        title: "RIGHT",
        titleAlignment: "right",
      },
    },
    {
      name: "a narrow scissor over a left title's end",
      clips: [{ x: 7, y: 0, width: 3, height: HEIGHT }],
      options: { ...box, backgroundColor: clearBackground, title: "TITLE" },
    },
    {
      name: "a wide-character title cut on its left",
      clips: [{ x: 9, y: 0, width: 15, height: HEIGHT }],
      options: {
        ...box,
        backgroundColor: clearBackground,
        title: "日本語の題",
        titleAlignment: "center",
      },
    },
    {
      name: "a top row and its title above the scissor",
      clips: [{ x: 0, y: 2, width: WIDTH, height: 6 }],
      options: {
        ...box,
        backgroundColor: clearBackground,
        title: "TOP",
        bottomTitle: "BOTTOM",
        bottomTitleAlignment: "right",
      },
    },
    {
      name: "nested scissors",
      clips: [
        { x: 4, y: 0, width: 16, height: HEIGHT },
        { x: 0, y: 2, width: 12, height: 6 },
      ],
      options: { ...box, backgroundColor: clearBackground, title: "NESTED" },
    },
    {
      name: "a solid background cut on its left",
      clips: [{ x: 6, y: 0, width: 18, height: HEIGHT }],
      options: { ...box, backgroundColor: solidBackground, shouldFill: true, title: "SOLID" },
    },
  ]

  for (const { name, clips, options } of cases) {
    it.live(`${name} shows the uncut box's cells inside the scissor and none outside`, () =>
      Effect.gen(function* () {
        const whole = yield* drawn([], Option.some(options))
        const ground = yield* drawn([], Option.none())
        const cut = yield* drawn(clips, Option.some(options))
        const expected = whole.map((cell, at) => {
          if (inside(clips, at)) return cell
          return ground[at] ?? ""
        })
        // The uncut box drew inside the scissor, so the crop has something to keep.
        expect(whole.some((cell, at) => inside(clips, at) && cell !== ground[at])).toBe(true)
        expect(rowsOf(cut)).toEqual(rowsOf(expected))
      }).pipe(Effect.scoped),
    )
  }
})

// ── split region growth ─────────────────────────────────────────────────────

/**
 * A split region that grows at the terminal's bottom sends the rows it covers
 * to scrollback with line feeds, and the native frame that moves the region
 * counts those rows (`noteViewportScroll`). The line feeds and the count
 * belong to one admitted native frame. Bytes an earlier write left in the
 * output feed make the native frame skip; when the line feeds went out before
 * that skip, a second growth before the retry counted too few rows, and the
 * history rows after it did not join the rows before it (`patches/README.md`).
 * Each case runs the same session, with and without the skip, and reads the
 * whole terminal.
 */
describe("split region growth", () => {
  const WIDTH = 45
  const HEIGHT = 15

  /** One history row, ended as gent ends a transcript row: no newline after it. */
  const commit = (renderer: CliRenderer, text: string) =>
    renderer.writeToScrollback(({ renderContext }) => ({
      root: new TextRenderable(renderContext, { content: text, width: text.length, height: 1 }),
      startOnNewLine: true,
      trailingNewline: false,
    }))

  /**
   * Leaves bytes in the renderer's output feed that no frame sent. The next
   * native frame sends them first and is skipped, as when an earlier write is
   * still pending.
   */
  const holdFeedBytes = (renderer: CliRenderer) =>
    Effect.gen(function* () {
      // OpenTUI keeps the feed private; the test reads it to hold bytes in it.
      const feed: unknown = renderer["_feed"]
      if (!(feed instanceof NativeSpanFeed)) {
        return yield* Effect.die("a custom stdout gives the renderer an output feed")
      }
      resolveRenderLib().streamWrite(feed.streamPtr, "\u001b[0m")
    })

  /** Every row the terminal holds, scrollback first, each without its trailing spaces. */
  const terminalRows = (bytes: string) =>
    Effect.gen(function* () {
      const emulator = new Terminal({
        cols: WIDTH,
        rows: HEIGHT,
        scrollback: 1000,
        allowProposedApi: true,
      })
      yield* Effect.callback<void>((resume) => {
        emulator.write(bytes, () => resume(Effect.void))
      })
      const buffer = emulator.buffer.active
      const rows: string[] = []
      for (let y = 0; y < buffer.length; y++) {
        rows.push(
          Option.match(Option.fromNullishOr(buffer.getLine(y)), {
            onNone: () => "",
            onSome: (line) => line.translateToString(true).trimEnd(),
          }),
        )
      }
      emulator.dispose()
      return rows
    })

  /**
   * A session at 45x15: twenty history rows fill the rows above a four-row
   * region, the region grows to six rows and then to seven, shrinks back to
   * four, and two more rows commit.
   */
  const session = (skipFirstGrowthFrame: boolean) =>
    Effect.gen(function* () {
      const output = new TerminalOutput(WIDTH, HEIGHT)
      const { renderer, renderOnce } = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createTestRenderer({
            width: WIDTH,
            height: HEIGHT,
            stdout: output.stdout(),
            bufferedOutput: "stdout",
            clock: new ManualClock(),
          }),
        ),
        (setup) => Effect.sync(() => setup.renderer.destroy()),
      )
      const frame = Effect.promise(() => renderOnce())
      yield* Effect.promise(() => renderer.setupTerminal())
      renderer.footerHeight = 4
      renderer.screenMode = "split-footer"
      renderer.externalOutputMode = "capture-stdout"
      yield* frame
      for (let row = 1; row <= 20; row++) {
        commit(renderer, `row-${row}`)
        yield* frame
      }
      if (skipFirstGrowthFrame) yield* holdFeedBytes(renderer)
      const beforeGrowth = output.written().length
      renderer.footerHeight = 6
      yield* frame
      const growthFrameBytes = output.written().slice(beforeGrowth)
      renderer.footerHeight = 7
      yield* frame
      yield* frame
      renderer.footerHeight = 4
      yield* frame
      commit(renderer, "NEW-HISTORY")
      yield* frame
      commit(renderer, "SECOND-HISTORY")
      yield* frame
      return { growthFrameBytes, rows: yield* terminalRows(output.written()) }
    })

  // The shrink from seven rows to four freed three rows above the region; the
  // two new rows take two of them, and the third stays blank.
  const expectedRows = [
    ...Array.from({ length: 20 }, (_, index) => `row-${index + 1}`),
    "NEW-HISTORY",
    "SECOND-HISTORY",
    "",
    ...Array.from({ length: 4 }, () => ""),
  ]

  it.live("a growth without a skipped frame keeps every history row once and in order", () =>
    Effect.gen(function* () {
      const { rows } = yield* session(false)
      expect(rows).toEqual(expectedRows)
    }).pipe(Effect.scoped, Effect.timeout("8 seconds")),
  )

  it.live(
    "a growth whose frame is skipped and that grows again before the retry keeps every history row once and in order",
    () =>
      Effect.gen(function* () {
        const { growthFrameBytes, rows } = yield* session(true)
        // The skipped frame sends the held bytes and scrolls nothing.
        expect(growthFrameBytes).toBe("\u001b[0m")
        expect(rows).toEqual(expectedRows)
      }).pipe(Effect.scoped, Effect.timeout("8 seconds")),
  )
})

// ── message rows ────────────────────────────────────────────────────────────

/**
 * Speaker lanes. Column 0 and the `┃` rail belong to the reader. A row that
 * another agent or the runtime wrote starts at column 2 with its own glyph,
 * muted and never bold, and its wrapped lines hang at column 4.
 */
describe("message rows outside the reader's lane", () => {
  const twelveLines = Array.from({ length: 12 }, (_, i) => `BODY-LINE-${i + 1}`).join("\n")
  const longLine = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ")

  const draw = (row: () => JSX.Element, width: number) =>
    Effect.gen(function* () {
      let colors = Option.none<ReturnType<typeof useTheme>["theme"]>()
      const setup = yield* renderScoped(
        () => {
          colors = Option.some(useTheme().theme)
          return row()
        },
        { width, height: 30 },
      )
      const frame = yield* waitForFrame(setup, (text) => /[»◷]/.test(text), "the row")
      const theme = Option.getOrThrow(colors)
      const drawn = setup
        .captureSpans()
        .lines.flatMap((line) => line.spans.filter((span) => span.text.trim().length > 0))
      return {
        lines: frame.split("\n").map((line) => line.trimEnd()),
        // No span is bold, and every one is the muted gray of a tool row,
        // but the sender's name, which takes the names' color.
        bold: drawn.filter((span) => (span.attributes & TextAttributes.BOLD) !== 0),
        unmuted: drawn.filter(
          (span) => !span.fg.equals(theme.textMuted) && !span.fg.equals(theme.info),
        ),
        names: drawn.filter((span) => span.fg.equals(theme.info)).map((span) => span.text),
      }
    })

  const agentRow = (disclosure: DisclosureLevel, width: number, body = twelveLines) =>
    draw(
      () => (
        <AgentMessageRow
          head="child"
          name="explore"
          id="0e493eaf"
          body={body}
          disclosure={disclosure}
        />
      ),
      width,
    )

  for (const width of [100, 60, 40]) {
    it.scopedLive(
      `a message another session sent is one muted line, its sender's name in the names' color, at ${width} columns`,
      () =>
        Effect.gen(function* () {
          const { lines, bold, unmuted, names } = yield* agentRow("collapsed", width)
          const drawn = lines.filter((line) => line.length > 0)
          expect(drawn).toHaveLength(1)
          expect(drawn[0]?.startsWith("  » child explore")).toBe(true)
          expect(drawn[0]?.length).toBeLessThanOrEqual(width - 1)
          if (width >= 60) expect(drawn[0]).toBe("  » child explore · 0e493eaf · BODY-LINE-1")
          expect(lines.join("\n")).not.toContain("┃")
          expect(bold).toEqual([])
          expect(unmuted).toEqual([])
          expect(names).toEqual(["explore"])
        }),
    )
  }

  for (const width of [100, 60]) {
    it.scopedLive(`preview shows five body lines and counts the rest at ${width} columns`, () =>
      Effect.gen(function* () {
        const { lines, bold, unmuted } = yield* agentRow("preview", width)
        expect(lines.filter((line) => line.length > 0)).toEqual([
          "  » child explore · 0e493eaf",
          "    │ BODY-LINE-1",
          "    │ BODY-LINE-2",
          "    │ BODY-LINE-3",
          "    │ BODY-LINE-4",
          "    │ BODY-LINE-5",
          "    │ … +7 lines (ctrl+o)",
        ])
        expect(bold).toEqual([])
        expect(unmuted).toEqual([])
      }),
    )

    it.scopedLive(`full shows the whole body, hanging at column 4, at ${width} columns`, () =>
      Effect.gen(function* () {
        const { lines, bold, unmuted } = yield* agentRow("full", width)
        expect(lines.filter((line) => line.length > 0)).toEqual([
          "  » child explore · 0e493eaf",
          ...Array.from({ length: 12 }, (_, i) => `    BODY-LINE-${i + 1}`),
        ])
        expect(bold).toEqual([])
        expect(unmuted).toEqual([])
        const wrapped = (yield* agentRow("full", width, longLine)).lines.filter(
          (line) => line.length > 0,
        )
        expect(wrapped.length).toBeGreaterThan(2)
        for (const line of wrapped.slice(1)) expect(line).toMatch(/^ {4}\S/)
      }),
    )
  }

  for (const width of [100, 60, 40]) {
    it.scopedLive(`a notice row has no rail and hangs at column 4 at ${width} columns`, () =>
      Effect.gen(function* () {
        const { lines, bold, unmuted } = yield* draw(
          () => <CollapsedRow glyph="◷" label={`alarm fired · ${longLine}`} />,
          width,
        )
        const drawn = lines.filter((line) => line.length > 0)
        expect(drawn[0]?.startsWith("  ◷ alarm fired · word0")).toBe(true)
        expect(drawn.length).toBeGreaterThan(1)
        for (const line of drawn.slice(1)) expect(line).toMatch(/^ {4}\S/)
        expect(lines.join("\n")).not.toContain("┃")
        expect(bold).toEqual([])
        expect(unmuted).toEqual([])
      }),
    )
  }
})

/**
 * The reader's lane: the `┃` rail, and Codex's prompt surface behind every
 * row of the block (`theme.backgroundPanel`, fx's derived panel: white at
 * 12% over the terminal's dark background). No padding row: the fill marks the block on its own rows.
 * Unknown terminal background, no fill: the rail alone carries it.
 */
describe("the reader's message row", () => {
  // White at 12% over `#1d1f21`, the dark terminal's background.
  const SURFACE = RGBA.fromHex("#383a3c")
  const longLine = Array.from({ length: 24 }, (_, i) => `word${i}`).join(" ")

  const drawUserRow = (width: number, answered: boolean) =>
    Effect.gen(function* () {
      let colors = Option.none<ReturnType<typeof useTheme>["theme"]>()
      const setup = yield* renderScoped(
        () => {
          if (answered) answerPalette(useRenderer(), darkTerminalColors)
          colors = Option.some(useTheme().theme)
          return (
            <UserRow
              content={`${longLine}\nsecond line`}
              images={[{ mediaType: "image/png" }]}
              details={{}}
              disclosure="collapsed"
            />
          )
        },
        { width, height: 30 },
      )
      const filled = () =>
        setup
          .captureSpans()
          .lines.some((line) => columnBackgrounds(line).some((bg) => bg.equals(SURFACE)))
      const frame = yield* waitForFrame(
        setup,
        (text) => text.includes("second line") && (!answered || filled()),
        "the reader's row",
      )
      const lines = frame.split("\n")
      const rail = lines.flatMap((line, index) => {
        if (line.startsWith("┃")) return [index]
        return []
      })
      return {
        lines,
        rail,
        backgrounds: setup.captureSpans().lines.map(columnBackgrounds),
        theme: Option.getOrThrow(colors),
      }
    })

  for (const width of [100, 60, 40]) {
    it.scopedLive(
      `the surface fills every row of the block from column 1 to the edge, wrapped lines too, at ${width} columns`,
      () =>
        Effect.gen(function* () {
          const { lines, rail, backgrounds } = yield* drawUserRow(width, true)
          // The image row, the wrapped first line, the second line: one block.
          expect(rail.length).toBeGreaterThanOrEqual(3)
          if (width === 40) expect(rail.length).toBeGreaterThan(4)
          expect(rail).toEqual(Array.from({ length: rail.length }, (_, i) => (rail[0] ?? 0) + i))
          for (const row of rail) {
            const columns = backgrounds[row] ?? []
            const unfilled = columns.flatMap((bg, column) => {
              if (column === 0 || bg.equals(SURFACE)) return []
              return [column]
            })
            expect(unfilled).toEqual([])
            // The rail is the lane's mark, not the surface.
            expect(columns[0]?.equals(SURFACE)).toBe(false)
          }
          // No padding rows: the rows around the block keep the terminal's ground.
          const outside = backgrounds.filter((_, row) => !rail.includes(row))
          expect(outside.filter((columns) => columns.some((bg) => bg.equals(SURFACE)))).toEqual([])
          expect(lines.slice(rail[0], (rail.at(-1) ?? 0) + 1).join("\n")).toContain("[Image: png]")
        }),
    )
  }

  it.scopedLive("with the terminal's background unknown there is no fill and the rail stays", () =>
    Effect.gen(function* () {
      const { rail, backgrounds } = yield* drawUserRow(60, false)
      expect(rail.length).toBeGreaterThanOrEqual(3)
      // The terminal's ground, as the last row (outside the block) shows it.
      const ground = Option.getOrThrow(Option.fromUndefinedOr(backgrounds.at(-1)?.[0]))
      for (const row of rail) {
        const painted = (backgrounds[row] ?? []).filter((bg) => !bg.equals(ground))
        expect(painted).toEqual([])
      }
    }),
  )
})
