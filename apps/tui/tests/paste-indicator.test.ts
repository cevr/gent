import { describe, test, expect } from "bun:test"

// Paste indicator constants and functions (matching input.tsx)
const PASTE_THRESHOLD_LINES = 3
const PASTE_THRESHOLD_LENGTH = 150

function countLines(text: string): number {
  return text.split("\n").length
}

function isLargePaste(inserted: string): boolean {
  return countLines(inserted) >= PASTE_THRESHOLD_LINES || inserted.length >= PASTE_THRESHOLD_LENGTH
}

// Simplified version for testing - real implementation uses module-level counter
let testPasteIdCounter = 0
const testPasteStore = new Map<string, string>()

function createPastePlaceholder(text: string): string {
  const id = `paste-${++testPasteIdCounter}`
  testPasteStore.set(id, text)
  const lines = countLines(text)
  return `[Pasted ~${lines} lines #${id}]`
}

function expandPastePlaceholders(text: string): string {
  return text.replace(/\[Pasted ~\d+ lines #(paste-\d+)\]/g, (match, id) => {
    const content = testPasteStore.get(id)
    if (content) {
      testPasteStore.delete(id)
      return content
    }
    return match
  })
}

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
    // 3 lines but short
    expect(isLargePaste("a\nb\nc")).toBe(true)
    // 1 line but 150+ chars
    expect(isLargePaste("x".repeat(150))).toBe(true)
  })
})

describe("createPastePlaceholder", () => {
  test("creates placeholder with line count", () => {
    const text = "line1\nline2\nline3"
    const placeholder = createPastePlaceholder(text)
    expect(placeholder).toMatch(/\[Pasted ~3 lines #paste-\d+\]/)
  })

  test("stores original text for later retrieval", () => {
    testPasteStore.clear()
    testPasteIdCounter = 0
    const text = "original content\nwith lines"
    const placeholder = createPastePlaceholder(text)
    expect(placeholder).toBe("[Pasted ~2 lines #paste-1]")
    expect(testPasteStore.get("paste-1")).toBe(text)
  })

  test("increments ID for each placeholder", () => {
    testPasteStore.clear()
    testPasteIdCounter = 0
    createPastePlaceholder("a\nb\nc")
    createPastePlaceholder("x\ny\nz")
    expect(testPasteStore.has("paste-1")).toBe(true)
    expect(testPasteStore.has("paste-2")).toBe(true)
  })
})

describe("expandPastePlaceholders", () => {
  test("expands single placeholder", () => {
    testPasteStore.clear()
    testPasteIdCounter = 0
    const original = "line1\nline2\nline3"
    const placeholder = createPastePlaceholder(original)

    const expanded = expandPastePlaceholders(`Before ${placeholder} after`)
    expect(expanded).toBe(`Before ${original} after`)
  })

  test("expands multiple placeholders", () => {
    testPasteStore.clear()
    testPasteIdCounter = 0
    const text1 = "first\npaste\ncontent"
    const text2 = "second\npaste\nhere"
    const p1 = createPastePlaceholder(text1)
    const p2 = createPastePlaceholder(text2)

    const input = `Start ${p1} middle ${p2} end`
    const expanded = expandPastePlaceholders(input)
    expect(expanded).toBe(`Start ${text1} middle ${text2} end`)
  })

  test("removes placeholder from store after expansion", () => {
    testPasteStore.clear()
    testPasteIdCounter = 0
    const text = "a\nb\nc"
    const placeholder = createPastePlaceholder(text)
    expect(testPasteStore.size).toBe(1)

    expandPastePlaceholders(placeholder)
    expect(testPasteStore.size).toBe(0)
  })

  test("preserves unknown placeholders", () => {
    testPasteStore.clear()
    const input = "text with [Pasted ~5 lines #paste-unknown] placeholder"
    const expanded = expandPastePlaceholders(input)
    expect(expanded).toBe(input)
  })

  test("handles text without placeholders", () => {
    const input = "just regular text without any placeholders"
    const expanded = expandPastePlaceholders(input)
    expect(expanded).toBe(input)
  })

  test("handles empty string", () => {
    expect(expandPastePlaceholders("")).toBe("")
  })
})

describe("paste workflow integration", () => {
  test("full paste and expand cycle", () => {
    testPasteStore.clear()
    testPasteIdCounter = 0

    // Simulate paste detection
    const pastedCode = `function example() {
  const x = 1
  const y = 2
  return x + y
}`
    expect(isLargePaste(pastedCode)).toBe(true)

    // Create placeholder
    const placeholder = createPastePlaceholder(pastedCode)
    expect(placeholder).toMatch(/\[Pasted ~5 lines #paste-\d+\]/)

    // User types around it
    const userInput = `Check this code: ${placeholder}`

    // On submit, expand
    const submitted = expandPastePlaceholders(userInput)
    expect(submitted).toBe(`Check this code: ${pastedCode}`)
  })
})
