import { describe, test, expect } from "bun:test"
import { Option } from "effect"

// Extract the pure logic from use-prompt-history for testing
// We test canNavigateAtCursor and the navigate state machine

function canNavigateAtCursor(
  direction: "up" | "down",
  cursorPos: number,
  textLength: number,
  inHistory: boolean,
): boolean {
  const pos = Math.max(0, Math.min(cursorPos, textLength))
  if (inHistory) return pos === 0 || pos === textLength
  if (direction === "up") return pos === 0
  return pos === textLength
}

describe("canNavigateAtCursor", () => {
  test("up at cursor 0 → true", () => {
    expect(canNavigateAtCursor("up", 0, 10, false)).toBe(true)
  })

  test("up at cursor 5 → false", () => {
    expect(canNavigateAtCursor("up", 5, 10, false)).toBe(false)
  })

  test("down at end → true", () => {
    expect(canNavigateAtCursor("down", 10, 10, false)).toBe(true)
  })

  test("down at middle → false", () => {
    expect(canNavigateAtCursor("down", 5, 10, false)).toBe(false)
  })

  test("in history: up at either boundary → true", () => {
    expect(canNavigateAtCursor("up", 0, 10, true)).toBe(true)
    expect(canNavigateAtCursor("up", 10, 10, true)).toBe(true)
  })

  test("in history: down at either boundary → true", () => {
    expect(canNavigateAtCursor("down", 0, 10, true)).toBe(true)
    expect(canNavigateAtCursor("down", 10, 10, true)).toBe(true)
  })

  test("in history: middle → false", () => {
    expect(canNavigateAtCursor("up", 5, 10, true)).toBe(false)
  })

  test("empty text: always at boundary", () => {
    expect(canNavigateAtCursor("up", 0, 0, false)).toBe(true)
    expect(canNavigateAtCursor("down", 0, 0, false)).toBe(true)
  })
})

// Test the navigate state machine without Solid reactivity
describe("prompt history navigation", () => {
  type NavigationResult =
    | { readonly handled: false }
    | { readonly handled: true; readonly text: string; readonly cursor: "start" | "end" }

  function createHistory(initialEntries: string[] = []) {
    const entries = [...initialEntries]
    let historyIndex = -1
    let savedEntry: Option.Option<string> = Option.none()

    const navigate = (
      direction: "up" | "down",
      currentText: string,
      cursorPos: number,
      textLength: number,
    ): NavigationResult => {
      const inHistory = historyIndex >= 0
      if (!canNavigateAtCursor(direction, cursorPos, textLength, inHistory)) {
        return { handled: false }
      }
      if (entries.length === 0 && direction === "up") return { handled: false }

      if (direction === "up") {
        if (historyIndex === -1) {
          const firstEntry = Option.fromNullishOr(entries[0])
          if (Option.isNone(firstEntry)) return { handled: false }
          savedEntry = Option.some(currentText)
          historyIndex = 0
          return { handled: true, text: firstEntry.value, cursor: "start" }
        }
        if (historyIndex < entries.length - 1) {
          historyIndex += 1
          const entry = Option.fromNullishOr(entries[historyIndex])
          if (Option.isNone(entry)) return { handled: false }
          return { handled: true, text: entry.value, cursor: "start" }
        }
        return { handled: false }
      }

      if (historyIndex > 0) {
        historyIndex -= 1
        const entry = Option.fromNullishOr(entries[historyIndex])
        if (Option.isNone(entry)) return { handled: false }
        return { handled: true, text: entry.value, cursor: "end" }
      }
      if (historyIndex === 0) {
        historyIndex = -1
        const restored = Option.getOrElse(savedEntry, () => "")
        savedEntry = Option.none()
        return { handled: true, text: restored, cursor: "end" }
      }
      return { handled: false }
    }

    const add = (text: string) => {
      if (text.trim().length === 0) return
      if (entries[0] === text.trim()) return
      entries.unshift(text.trim())
      if (entries.length > 100) entries.length = 100
      historyIndex = -1
      savedEntry = Option.none()
    }

    return { navigate, add, getIndex: () => historyIndex }
  }

  test("up with no history → not handled", () => {
    const h = createHistory()
    expect(h.navigate("up", "", 0, 0)).toEqual({ handled: false })
  })

  test("up recalls first entry", () => {
    const h = createHistory(["first", "second"])
    const result = h.navigate("up", "current", 0, 7)
    expect(result).toEqual({ handled: true, text: "first", cursor: "start" })
  })

  test("up twice recalls second entry", () => {
    const h = createHistory(["first", "second"])
    h.navigate("up", "current", 0, 7)
    const result = h.navigate("up", "first", 0, 5)
    expect(result).toEqual({ handled: true, text: "second", cursor: "start" })
  })

  test("up then down restores saved", () => {
    const h = createHistory(["first"])
    h.navigate("up", "my input", 0, 8)
    const result = h.navigate("down", "first", 5, 5)
    expect(result).toEqual({ handled: true, text: "my input", cursor: "end" })
  })

  test("down with no history browsing → not handled", () => {
    const h = createHistory(["first"])
    expect(h.navigate("down", "text", 4, 4)).toEqual({ handled: false })
  })

  test("up at non-zero cursor → not handled", () => {
    const h = createHistory(["first"])
    expect(h.navigate("up", "text", 2, 4)).toEqual({ handled: false })
  })

  test("add deduplicates against last", () => {
    const h = createHistory()
    h.add("hello")
    h.add("hello") // should not add
    const r1 = h.navigate("up", "", 0, 0)
    expect(r1).toEqual({ handled: true, text: "hello", cursor: "start" })
    const r2 = h.navigate("up", "hello", 0, 5)
    expect(r2).toEqual({ handled: false }) // only 1 entry
  })

  test("add resets history index", () => {
    const h = createHistory(["old"])
    h.navigate("up", "", 0, 0) // now browsing
    h.add("new")
    // After add, index is reset, next up should get "new"
    const result = h.navigate("up", "", 0, 0)
    expect(result).toEqual({ handled: true, text: "new", cursor: "start" })
  })
})
