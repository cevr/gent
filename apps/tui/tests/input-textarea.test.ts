import { describe, test, expect, beforeEach } from "bun:test"

// ── Paste placeholder logic (extracted from input.tsx) ───────────────

const PASTE_THRESHOLD_LINES = 3
const PASTE_THRESHOLD_LENGTH = 150

function countLines(text: string): number {
  return text.split("\n").length
}

function isLargePaste(inserted: string): boolean {
  return countLines(inserted) >= PASTE_THRESHOLD_LINES || inserted.length >= PASTE_THRESHOLD_LENGTH
}

function createPasteManager() {
  let idCounter = 0
  const store = new Map<string, string>()

  return {
    createPlaceholder(text: string): string {
      const id = `paste-${++idCounter}`
      store.set(id, text)
      const lines = countLines(text)
      return `[Pasted ~${lines} lines #${id}]`
    },
    expandPlaceholders(text: string): string {
      return text.replace(/\[Pasted ~\d+ lines #(paste-\d+)\]/g, (match, id) => {
        const content = store.get(id)
        if (content !== undefined) {
          store.delete(id)
          return content
        }
        return match
      })
    },
    clear() {
      store.clear()
      idCounter = 0
    },
  }
}

// ── Shell mode prefix detection ──────────────────────────────────────

function isShellTrigger(char: string, cursorOffset: number, mode: string): boolean {
  return char === "!" && cursorOffset === 0 && mode === "normal"
}

// ── Autocomplete trigger detection ───────────────────────────────────

type AutocompleteType = "$" | "@" | "/"

interface AutocompleteState {
  type: AutocompleteType
  filter: string
  triggerPos: number
}

function detectAutocompleteTrigger(value: string): AutocompleteState | null {
  // / at start
  if (value.startsWith("/")) {
    return { type: "/", filter: value.slice(1), triggerPos: 0 }
  }

  // $ or @ trigger
  const match = value.match(/(?:^|[\s])([$@])([^\s]*)$/)
  if (match !== null) {
    const [fullMatch, prefix, filter] = match
    if (prefix === undefined || prefix.length === 0) return null
    const triggerPos = value.length - fullMatch.length + (fullMatch.startsWith(" ") ? 1 : 0)
    return { type: prefix as AutocompleteType, filter: filter ?? "", triggerPos }
  }

  return null
}

// ── Submit extracts plainText ────────────────────────────────────────

function extractSubmitValue(
  plainText: string,
  pasteManager: ReturnType<typeof createPasteManager>,
): string | null {
  const expanded = pasteManager.expandPlaceholders(plainText)
  const text = expanded.trim()
  if (text.length === 0) return null
  return text
}

// ── Tests ────────────────────────────────────────────────────────────

describe("paste placeholder logic (textarea)", () => {
  let paste: ReturnType<typeof createPasteManager>

  beforeEach(() => {
    paste = createPasteManager()
  })

  test("large paste creates placeholder", () => {
    const content = "line1\nline2\nline3"
    expect(isLargePaste(content)).toBe(true)

    const placeholder = paste.createPlaceholder(content)
    expect(placeholder).toBe("[Pasted ~3 lines #paste-1]")
  })

  test("small paste does not trigger", () => {
    expect(isLargePaste("short")).toBe(false)
    expect(isLargePaste("two\nlines")).toBe(false)
  })

  test("long single-line paste triggers", () => {
    expect(isLargePaste("x".repeat(150))).toBe(true)
  })

  test("expand restores original content", () => {
    const original = "function foo() {\n  return 1\n  // done\n}"
    const placeholder = paste.createPlaceholder(original)
    const submitted = `Check this: ${placeholder}`
    const expanded = paste.expandPlaceholders(submitted)
    expect(expanded).toBe(`Check this: ${original}`)
  })

  test("multiple placeholders expand independently", () => {
    const a = "a\nb\nc"
    const b = "x\ny\nz"
    const pa = paste.createPlaceholder(a)
    const pb = paste.createPlaceholder(b)
    const expanded = paste.expandPlaceholders(`${pa} then ${pb}`)
    expect(expanded).toBe(`${a} then ${b}`)
  })
})

describe("shell mode prefix detection", () => {
  test("! at position 0 in normal mode enters shell", () => {
    expect(isShellTrigger("!", 0, "normal")).toBe(true)
  })

  test("! at non-zero position does not trigger", () => {
    expect(isShellTrigger("!", 5, "normal")).toBe(false)
  })

  test("! in shell mode does not re-trigger", () => {
    expect(isShellTrigger("!", 0, "shell")).toBe(false)
  })

  test("other chars at position 0 do not trigger", () => {
    expect(isShellTrigger("a", 0, "normal")).toBe(false)
  })
})

describe("autocomplete trigger detection", () => {
  test("$ at word boundary triggers skill autocomplete", () => {
    const result = detectAutocompleteTrigger("hello $eff")
    expect(result).not.toBeNull()
    expect(result!.type).toBe("$")
    expect(result!.filter).toBe("eff")
  })

  test("@ at word boundary triggers file autocomplete", () => {
    const result = detectAutocompleteTrigger("check @src/")
    expect(result).not.toBeNull()
    expect(result!.type).toBe("@")
    expect(result!.filter).toBe("src/")
  })

  test("/ at start triggers command autocomplete", () => {
    const result = detectAutocompleteTrigger("/age")
    expect(result).not.toBeNull()
    expect(result!.type).toBe("/")
    expect(result!.filter).toBe("age")
  })

  test("$ at start of input triggers", () => {
    const result = detectAutocompleteTrigger("$effect")
    expect(result).not.toBeNull()
    expect(result!.type).toBe("$")
    expect(result!.filter).toBe("effect")
  })

  test("no trigger in plain text", () => {
    expect(detectAutocompleteTrigger("hello world")).toBeNull()
  })

  test("mid-word $ does not trigger", () => {
    // "$" must follow whitespace or start of string
    expect(detectAutocompleteTrigger("co$t")).toBeNull()
  })
})

describe("submit extracts plainText", () => {
  test("trims whitespace", () => {
    const paste = createPasteManager()
    expect(extractSubmitValue("  hello world  ", paste)).toBe("hello world")
  })

  test("empty/whitespace returns null", () => {
    const paste = createPasteManager()
    expect(extractSubmitValue("", paste)).toBeNull()
    expect(extractSubmitValue("   ", paste)).toBeNull()
  })

  test("expands paste placeholders before submit", () => {
    const paste = createPasteManager()
    const original = "a\nb\nc\nd"
    const placeholder = paste.createPlaceholder(original)
    const result = extractSubmitValue(`prefix ${placeholder} suffix`, paste)
    expect(result).toBe(`prefix ${original} suffix`)
  })

  test("multiline content preserved through submit", () => {
    const paste = createPasteManager()
    const multiline = "line 1\nline 2\nline 3"
    expect(extractSubmitValue(multiline, paste)).toBe(multiline)
  })
})
