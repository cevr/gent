import { describe, expect, test } from "bun:test"
import {
  CommandPaletteState,
  transitionCommandPalette,
} from "../src/components/command-palette-state"

describe("command-palette-state", () => {
  test("open resets stack, selection, search, and session load state", () => {
    const dirty = transitionCommandPalette(
      transitionCommandPalette(
        transitionCommandPalette(CommandPaletteState.initial(), {
          _tag: "PushLevel",
          level: "sessions",
        }),
        { _tag: "SearchTyped", char: "x" },
      ),
      { _tag: "LoadSessions" },
    )

    expect(transitionCommandPalette(dirty, { _tag: "Open" })).toEqual(CommandPaletteState.initial())
  })

  test("push level clears search and resets selection", () => {
    const state = transitionCommandPalette(
      transitionCommandPalette(CommandPaletteState.initial(), {
        _tag: "SearchTyped",
        char: "t",
      }),
      { _tag: "MoveDown", itemCount: 5 },
    )

    expect(
      transitionCommandPalette(state, {
        _tag: "ActivateSelection",
        outcome: { _tag: "PushLevel", level: "theme" },
      }),
    ).toEqual({
      levelStack: ["theme"],
      selectedIndex: 0,
      searchQuery: "",
      sessions: { _tag: "idle" },
    })
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

  test("sessions loading lifecycle is explicit", () => {
    const loading = transitionCommandPalette(CommandPaletteState.initial(), {
      _tag: "LoadSessions",
    })
    const loaded = transitionCommandPalette(loading, {
      _tag: "SessionsLoaded",
      sessions: [],
    })
    const failed = transitionCommandPalette(loading, {
      _tag: "SessionsFailed",
      message: "boom",
    })

    expect(loading.sessions).toEqual({ _tag: "loading" })
    expect(loaded.sessions._tag).toBe("loaded")
    expect(failed.sessions).toEqual({ _tag: "failed", message: "boom" })
  })
})
