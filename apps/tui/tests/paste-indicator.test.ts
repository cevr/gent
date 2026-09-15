import { describe, test, expect } from "bun:test"
import {
  countLines,
  createPasteManager,
  isLargePaste,
} from "../src/components/use-composer-controller"

// The paste manager is per-controller: each composer owns its id counter and
// store, so every test makes its own rather than resetting shared state.

describe("countLines", () => {
  test("counts single line", () => {
    expect(countLines("hello")).toBe(1)
  })

  test("counts multiple lines", () => {
    expect(countLines("line1\nline2")).toBe(2)
    expect(countLines("a\nb\nc")).toBe(3)
    expect(countLines("1\n2\n3\n4\n5")).toBe(5)
  })

  test("handles empty string", () => {
    expect(countLines("")).toBe(1)
  })

  test("handles trailing newline", () => {
    expect(countLines("line1\nline2\n")).toBe(3)
  })
})

describe("isLargePaste", () => {
  test("returns false for short single-line text", () => {
    expect(isLargePaste("hello")).toBe(false)
    expect(isLargePaste("short text")).toBe(false)
  })

  test("returns true for text with 3+ lines", () => {
    expect(isLargePaste("a\nb\nc")).toBe(true)
    expect(isLargePaste("line1\nline2\nline3")).toBe(true)
  })

  test("returns false for 2 lines", () => {
    expect(isLargePaste("line1\nline2")).toBe(false)
  })

  test("returns true for long text even if single line", () => {
    const longText = "x".repeat(150)
    expect(isLargePaste(longText)).toBe(true)
  })

  test("returns false for text just under threshold", () => {
    const shortText = "x".repeat(149)
    expect(isLargePaste(shortText)).toBe(false)
  })

  test("returns true if either condition is met", () => {
    expect(isLargePaste("a\nb\nc")).toBe(true)
    expect(isLargePaste("x".repeat(150))).toBe(true)
  })
})

describe("createPlaceholder", () => {
  test("creates placeholder with line count", () => {
    const paste = createPasteManager()
    const placeholder = paste.createPlaceholder("line1\nline2\nline3")
    expect(placeholder).toMatch(/\[Pasted ~3 lines #paste-\d+\]/)
  })

  test("stores original text for later retrieval", () => {
    const paste = createPasteManager()
    const text = "original content\nwith lines"
    const placeholder = paste.createPlaceholder(text)
    expect(placeholder).toBe("[Pasted ~2 lines #paste-1]")
    expect(paste.expandPlaceholders(placeholder)).toBe(text)
  })

  test("increments ID for each placeholder", () => {
    const paste = createPasteManager()
    expect(paste.createPlaceholder("a\nb\nc")).toBe("[Pasted ~3 lines #paste-1]")
    expect(paste.createPlaceholder("x\ny\nz")).toBe("[Pasted ~3 lines #paste-2]")
  })

  test("each manager owns its own id sequence", () => {
    expect(createPasteManager().createPlaceholder("a\nb\nc")).toBe("[Pasted ~3 lines #paste-1]")
    expect(createPasteManager().createPlaceholder("a\nb\nc")).toBe("[Pasted ~3 lines #paste-1]")
  })
})

describe("expandPlaceholders", () => {
  test("expands single placeholder", () => {
    const paste = createPasteManager()
    const original = "line1\nline2\nline3"
    const placeholder = paste.createPlaceholder(original)

    expect(paste.expandPlaceholders(`Before ${placeholder} after`)).toBe(`Before ${original} after`)
  })

  test("expands multiple placeholders", () => {
    const paste = createPasteManager()
    const text1 = "first\npaste\ncontent"
    const text2 = "second\npaste\nhere"
    const p1 = paste.createPlaceholder(text1)
    const p2 = paste.createPlaceholder(text2)

    expect(paste.expandPlaceholders(`Start ${p1} middle ${p2} end`)).toBe(
      `Start ${text1} middle ${text2} end`,
    )
  })

  test("removes placeholder from store after expansion", () => {
    const paste = createPasteManager()
    const placeholder = paste.createPlaceholder("a\nb\nc")

    expect(paste.expandPlaceholders(placeholder)).toBe("a\nb\nc")
    // Second expansion finds nothing left to substitute.
    expect(paste.expandPlaceholders(placeholder)).toBe(placeholder)
  })

  test("preserves unknown placeholders", () => {
    const paste = createPasteManager()
    const input = "text with [Pasted ~5 lines #paste-unknown] placeholder"
    expect(paste.expandPlaceholders(input)).toBe(input)
  })

  test("handles text without placeholders", () => {
    const paste = createPasteManager()
    const input = "just regular text without any placeholders"
    expect(paste.expandPlaceholders(input)).toBe(input)
  })

  test("handles empty string", () => {
    expect(createPasteManager().expandPlaceholders("")).toBe("")
  })

  test("clear drops stored pastes", () => {
    const paste = createPasteManager()
    const placeholder = paste.createPlaceholder("a\nb\nc")
    paste.clear()
    expect(paste.expandPlaceholders(placeholder)).toBe(placeholder)
  })
})

describe("paste workflow integration", () => {
  test("full paste and expand cycle", () => {
    const paste = createPasteManager()
    const pastedCode = `function example() {
  const x = 1
  const y = 2
  return x + y
}`
    expect(isLargePaste(pastedCode)).toBe(true)

    const placeholder = paste.createPlaceholder(pastedCode)
    expect(placeholder).toMatch(/\[Pasted ~5 lines #paste-\d+\]/)

    const userInput = `Check this code: ${placeholder}`
    expect(paste.expandPlaceholders(userInput)).toBe(`Check this code: ${pastedCode}`)
  })
})
