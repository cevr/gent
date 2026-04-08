import { describe, expect, test } from "bun:test"
import {
  CommandPaletteState,
  transitionCommandPalette,
  type PaletteLevel,
} from "../src/components/command-palette-state"

const stubLevel = (id: string): PaletteLevel => ({
  id,
  title: id.charAt(0).toUpperCase() + id.slice(1),
  source: () => [],
})

const rootLevel = stubLevel("root")

describe("command-palette-state", () => {
  test("open initializes stack with root level", () => {
    const dirty = transitionCommandPalette(
      transitionCommandPalette(CommandPaletteState.initial(), {
        _tag: "PushLevel",
        level: stubLevel("sessions"),
      }),
      { _tag: "SearchTyped", char: "x" },
    )

    const opened = transitionCommandPalette(dirty, { _tag: "Open", rootLevel })
    expect(opened.levelStack).toHaveLength(1)
    expect(opened.levelStack[0]!.id).toBe("root")
    expect(opened.selectedIndex).toBe(0)
    expect(opened.searchQuery).toBe("")
  })

  test("push level clears search and resets selection", () => {
    const state = transitionCommandPalette(
      transitionCommandPalette(
        transitionCommandPalette(CommandPaletteState.initial(), {
          _tag: "Open",
          rootLevel,
        }),
        { _tag: "SearchTyped", char: "t" },
      ),
      { _tag: "MoveDown", itemCount: 5 },
    )

    const pushed = transitionCommandPalette(state, {
      _tag: "PushLevel",
      level: stubLevel("theme"),
    })

    expect(pushed.levelStack).toHaveLength(2)
    expect(pushed.levelStack[1]!.id).toBe("theme")
    expect(pushed.selectedIndex).toBe(0)
    expect(pushed.searchQuery).toBe("")
  })

  test("navigation wraps around item bounds", () => {
    const movedUp = transitionCommandPalette(CommandPaletteState.initial(), {
      _tag: "MoveUp",
      itemCount: 4,
    })
    const movedDown = transitionCommandPalette(movedUp, {
      _tag: "MoveDown",
      itemCount: 4,
    })

    expect(movedUp.selectedIndex).toBe(3)
    expect(movedDown.selectedIndex).toBe(0)
  })

  test("pop level stops at root (stack length 1)", () => {
    const opened = transitionCommandPalette(CommandPaletteState.initial(), {
      _tag: "Open",
      rootLevel,
    })
    const popped = transitionCommandPalette(opened, { _tag: "PopLevel" })
    expect(popped.levelStack).toHaveLength(1)
    expect(popped.levelStack[0]!.id).toBe("root")
  })

  test("pop level returns to previous level", () => {
    const withSub = transitionCommandPalette(
      transitionCommandPalette(CommandPaletteState.initial(), {
        _tag: "Open",
        rootLevel,
      }),
      { _tag: "PushLevel", level: stubLevel("theme") },
    )
    expect(withSub.levelStack).toHaveLength(2)

    const popped = transitionCommandPalette(withSub, { _tag: "PopLevel" })
    expect(popped.levelStack).toHaveLength(1)
    expect(popped.levelStack[0]!.id).toBe("root")
  })

  test("close resets everything", () => {
    const opened = transitionCommandPalette(
      transitionCommandPalette(CommandPaletteState.initial(), {
        _tag: "Open",
        rootLevel,
      }),
      { _tag: "PushLevel", level: stubLevel("sessions") },
    )

    const closed = transitionCommandPalette(opened, { _tag: "Close" })
    expect(closed.levelStack).toHaveLength(0)
    expect(closed.selectedIndex).toBe(0)
    expect(closed.searchQuery).toBe("")
  })
})
