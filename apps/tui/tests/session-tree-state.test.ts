import { describe, expect, test } from "bun:test"
import { SessionTreeState, transitionSessionTree } from "../src/components/session-tree-state"

describe("transitionSessionTree", () => {
  test("open resets query and selection", () => {
    const state = transitionSessionTree(
      {
        query: "abc",
        selectedIndex: 2,
      },
      { _tag: "Open", selectedIndex: 1 },
    )

    expect(state).toEqual(SessionTreeState.initial(1))
  })

  test("typing updates query and resets selection", () => {
    const state = transitionSessionTree(
      {
        query: "ab",
        selectedIndex: 3,
      },
      { _tag: "TypeChar", char: "c" },
    )

    expect(state).toEqual({
      query: "abc",
      selectedIndex: 0,
    })
  })

  test("move wraps across item bounds", () => {
    const up = transitionSessionTree(SessionTreeState.initial(0), {
      _tag: "MoveUp",
      itemCount: 4,
    })
    const down = transitionSessionTree(
      {
        query: "",
        selectedIndex: 3,
      },
      { _tag: "MoveDown", itemCount: 4 },
    )

    expect(up.selectedIndex).toBe(3)
    expect(down.selectedIndex).toBe(0)
  })
})
