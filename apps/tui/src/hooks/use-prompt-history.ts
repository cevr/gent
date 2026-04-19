/**
 * Prompt history — navigate previous prompts with up/down arrows.
 *
 * Plain text entries, persisted to ~/.cache/gent/prompt-history.json.
 * Max 100 entries. Deduplicates against the last entry on add.
 */

import { createSignal } from "solid-js"
import { isRecord } from "@gent/core/domain/guards.js"
import { homedir } from "os"
import { makeDirectory, writeFileString } from "../platform/fs-runtime-boundary"
import { joinPath } from "../platform/path-runtime"

const MAX_ENTRIES = 100
const CACHE_DIR = joinPath(homedir(), ".cache", "gent")
const HISTORY_PATH = joinPath(CACHE_DIR, "prompt-history.json")

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
  readonly entries: () => readonly string[]
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

type PromptHistoryStore = {
  entries: ReturnType<typeof createSignal<string[]>>[0]
  setEntries: ReturnType<typeof createSignal<string[]>>[1]
  historyIndex: number
  savedEntry: string | null
  loaded: boolean
}

let singleton: PromptHistoryStore | null = null

const getStore = (): PromptHistoryStore => {
  if (singleton !== null) return singleton

  const [entries, setEntries] = createSignal<string[]>([])
  singleton = {
    entries,
    setEntries,
    historyIndex: -1,
    savedEntry: null,
    loaded: false,
  }
  return singleton
}

export function usePromptHistory(): PromptHistory {
  const store = getStore()

  const ensureLoaded = async () => {
    if (store.loaded) return
    store.loaded = true
    try {
      const file = Bun.file(HISTORY_PATH)
      if (!(await file.exists())) return
      const raw = await file.text()
      if (raw.length === 0) return
      const data: unknown = JSON.parse(raw)
      if (isRecord(data) && Array.isArray(data["entries"])) {
        const entries = data["entries"].filter((e: unknown): e is string => typeof e === "string")
        store.setEntries(entries.slice(0, MAX_ENTRIES))
      }
    } catch {
      // No file or bad JSON — start fresh
    }
  }

  const persist = (items: string[]) => {
    const data: HistoryStore = { entries: items }
    void makeDirectory(CACHE_DIR, { recursive: true })
      .then(() => writeFileString(HISTORY_PATH, JSON.stringify(data)))
      .catch(() => {})
  }

  void ensureLoaded()

  return {
    entries: () => store.entries(),

    add(text: string) {
      const trimmed = text.trim()
      if (trimmed.length === 0) return

      store.setEntries((prev) => {
        if (prev[0] === trimmed) return prev
        const next = [trimmed, ...prev].slice(0, MAX_ENTRIES)
        persist(next)
        return next
      })
      store.historyIndex = -1
      store.savedEntry = null
    },

    navigate(
      direction: "up" | "down",
      currentText: string,
      cursorPos: number,
      textLength: number,
    ): NavigateResult {
      const inHistory = store.historyIndex >= 0
      if (!canNavigateAtCursor(direction, cursorPos, textLength, inHistory)) {
        return { handled: false }
      }

      const list = store.entries()
      if (list.length === 0 && direction === "up") return { handled: false }

      if (direction === "up") {
        if (store.historyIndex === -1) {
          store.savedEntry = currentText
          store.historyIndex = 0
          return { handled: true, text: list[0], cursor: "start" }
        }
        if (store.historyIndex < list.length - 1) {
          store.historyIndex += 1
          return { handled: true, text: list[store.historyIndex], cursor: "start" }
        }
        return { handled: false }
      }

      // down
      if (store.historyIndex > 0) {
        store.historyIndex -= 1
        return { handled: true, text: list[store.historyIndex], cursor: "end" }
      }
      if (store.historyIndex === 0) {
        store.historyIndex = -1
        const restored = store.savedEntry ?? ""
        store.savedEntry = null
        return { handled: true, text: restored, cursor: "end" }
      }
      return { handled: false }
    },

    reset() {
      store.historyIndex = -1
      store.savedEntry = null
    },
  }
}
