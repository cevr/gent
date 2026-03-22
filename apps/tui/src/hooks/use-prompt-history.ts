/**
 * Prompt history — navigate previous prompts with up/down arrows.
 *
 * Plain text entries, persisted to ~/.cache/gent/prompt-history.json.
 * Max 100 entries. Deduplicates against the last entry on add.
 */

import { createSignal } from "solid-js"
import { readFile, writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { homedir } from "os"

const MAX_ENTRIES = 100
const CACHE_DIR = join(homedir(), ".cache", "gent")
const HISTORY_PATH = join(CACHE_DIR, "prompt-history.json")

interface HistoryStore {
  entries: string[]
}

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

export interface NavigateResult {
  readonly handled: boolean
  readonly text?: string
  readonly cursor?: "start" | "end"
}

export interface PromptHistory {
  /** Add a submitted prompt to history. */
  readonly add: (text: string) => void
  /**
   * Navigate history. Pass current input text so it can be saved/restored.
   * Returns `{ handled: true, text, cursor }` if navigation occurred.
   */
  readonly navigate: (
    direction: "up" | "down",
    currentText: string,
    cursorPos: number,
    textLength: number,
  ) => NavigateResult
  /** Reset navigation state (e.g., on submit or mode change). */
  readonly reset: () => void
}

export function usePromptHistory(): PromptHistory {
  const [entries, setEntries] = createSignal<string[]>([])
  let historyIndex = -1
  let savedEntry: string | null = null
  let loaded = false

  const ensureLoaded = async () => {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(HISTORY_PATH, "utf-8")
      if (raw.length === 0) return
      const data = JSON.parse(raw) as HistoryStore
      if (Array.isArray(data.entries)) {
        setEntries(data.entries.slice(0, MAX_ENTRIES))
      }
    } catch {
      // No file or bad JSON — start fresh
    }
  }

  const persist = (items: string[]) => {
    const data: HistoryStore = { entries: items }
    void mkdir(CACHE_DIR, { recursive: true })
      .then(() => writeFile(HISTORY_PATH, JSON.stringify(data), "utf-8"))
      .catch(() => {})
  }

  void ensureLoaded()

  return {
    add(text: string) {
      const trimmed = text.trim()
      if (trimmed.length === 0) return

      setEntries((prev) => {
        if (prev[0] === trimmed) return prev
        const next = [trimmed, ...prev].slice(0, MAX_ENTRIES)
        persist(next)
        return next
      })
      historyIndex = -1
      savedEntry = null
    },

    navigate(
      direction: "up" | "down",
      currentText: string,
      cursorPos: number,
      textLength: number,
    ): NavigateResult {
      const inHistory = historyIndex >= 0
      if (!canNavigateAtCursor(direction, cursorPos, textLength, inHistory)) {
        return { handled: false }
      }

      const list = entries()
      if (list.length === 0 && direction === "up") return { handled: false }

      if (direction === "up") {
        if (historyIndex === -1) {
          savedEntry = currentText
          historyIndex = 0
          return { handled: true, text: list[0], cursor: "start" }
        }
        if (historyIndex < list.length - 1) {
          historyIndex += 1
          return { handled: true, text: list[historyIndex], cursor: "start" }
        }
        return { handled: false }
      }

      // down
      if (historyIndex > 0) {
        historyIndex -= 1
        return { handled: true, text: list[historyIndex], cursor: "end" }
      }
      if (historyIndex === 0) {
        historyIndex = -1
        const restored = savedEntry ?? ""
        savedEntry = null
        return { handled: true, text: restored, cursor: "end" }
      }
      return { handled: false }
    },

    reset() {
      historyIndex = -1
      savedEntry = null
    },
  }
}
