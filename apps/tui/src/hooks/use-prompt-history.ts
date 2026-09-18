/**
 * Prompt history — navigate previous prompts with up/down arrows.
 *
 * Plain text entries, persisted to ~/.cache/gent/prompt-history.json.
 * Max 100 entries. Deduplicates against the last entry on add.
 *
 * File access runs on the client runtime, which already carries
 * `FileSystem` and `Path`. The cache paths come from the workspace home the
 * shell mounted with, computed inside the hook rather than at module load.
 */

import { createSignal } from "solid-js"
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { useWorkspace } from "../workspace"
import { useRuntime } from "../client"

const MAX_ENTRIES = 100

const HistoryStore = Schema.Struct({ entries: Schema.Array(Schema.String) })
const decodeHistoryStore = Schema.decodeUnknownOption(Schema.fromJsonString(HistoryStore))
const encodeHistoryStore = Schema.encodeSync(Schema.fromJsonString(HistoryStore))

const historyPaths = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = path.join(home, ".cache", "gent")
    return { directory, file: path.join(directory, "prompt-history.json") }
  })

/** Absent for no file, unreadable content, or bad JSON — history starts fresh. */
export const readEntries = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* historyPaths(home)
    const exists = yield* fs.exists(paths.file)
    if (!exists) return Option.none<ReadonlyArray<string>>()
    const text = yield* fs.readFileString(paths.file)
    if (text.length === 0) return Option.none<ReadonlyArray<string>>()
    return Option.map(decodeHistoryStore(text), (store) => store.entries)
  }).pipe(Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()))

export const writeEntries = (home: string, items: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* historyPaths(home)
    yield* fs.makeDirectory(paths.directory, { recursive: true })
    yield* fs.writeFileString(paths.file, encodeHistoryStore(HistoryStore.make({ entries: items })))
  }).pipe(Effect.ignoreCause)

export function canNavigateAtCursor(
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

interface NavigateResult {
  readonly handled: boolean
  readonly text?: string
  readonly cursor?: "start" | "end"
}

interface PromptHistory {
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
  savedEntry: Option.Option<string>
  loaded: boolean
}

let singleton: Option.Option<PromptHistoryStore> = Option.none()

const getStore = (): PromptHistoryStore => {
  if (Option.isSome(singleton)) return singleton.value

  const [entries, setEntries] = createSignal<string[]>([])
  const store: PromptHistoryStore = {
    entries,
    setEntries,
    historyIndex: -1,
    savedEntry: Option.none(),
    loaded: false,
  }
  singleton = Option.some(store)
  return store
}

export function usePromptHistory(): PromptHistory {
  const store = getStore()
  const workspace = useWorkspace()
  const { cast } = useRuntime()

  const ensureLoaded = () => {
    if (store.loaded) return
    store.loaded = true
    cast(
      readEntries(workspace.home).pipe(
        Effect.tap((loaded) =>
          Effect.sync(() => {
            if (Option.isNone(loaded)) return
            store.setEntries([...loaded.value.slice(0, MAX_ENTRIES)])
          }),
        ),
      ),
    )
  }

  const persist = (items: string[]) => {
    cast(writeEntries(workspace.home, items))
  }

  ensureLoaded()

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
      store.savedEntry = Option.none()
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
          store.savedEntry = Option.some(currentText)
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
        const restored = Option.getOrElse(store.savedEntry, () => "")
        store.savedEntry = Option.none()
        return { handled: true, text: restored, cursor: "end" }
      }
      return { handled: false }
    },

    reset() {
      store.historyIndex = -1
      store.savedEntry = Option.none()
    },
  }
}
