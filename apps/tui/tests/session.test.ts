import { describe, expect, it, test } from "effect-bun-test"
import { Clock, Deferred, Effect, Fiber, FileSystem, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  beginAuthCheck,
  buildContextLabels,
  buildModelLabels,
  canNavigateAtCursor,
  clearQueue,
  closeAuthGateState,
  completeAuthCheck,
  ComposerInteractionState,
  failAuthCheck,
  filterModels,
  formatCwdGit,
  initialSessionControllerState,
  nextDisclosure,
  queuedDraftText,
  readEntries,
  recordPrompt,
  resolveModelQuery,
  overlayHoldsComposer,
  SessionUiState,
  setQueue,
  transitionComposerInteraction,
  transitionSessionUi,
  writeEntries,
  mergeRefused,
  noticeRowItems,
  runWithReconnect,
} from "../src/session"
import type { AutocompleteContribution, NoticeRow } from "../src/extensions/client-facets"
import {
  BranchId,
  SessionId,
  MessageId,
  Model,
  type ModelContextMetrics,
  ModelId,
  ProviderId,
  type QueueEntryInfo,
} from "@gent/core/protocol"
import { BunServices } from "@effect/platform-bun"
import { RGBA } from "@opentui/core"

// ── composer interaction state ──────────────────────────────────────────────

const testContributions: AutocompleteContribution[] = [
  { prefix: "$", title: "Skills", items: () => [] },
  { prefix: "@", title: "Files", items: () => [] },
  { prefix: "/", title: "Commands", items: () => [] },
]

describe("notice rows", () => {
  const session = { sessionId: SessionId.make("s"), branchId: BranchId.make("b") }
  const row: NoticeRow = { key: "1", createdAt: 5, glyph: "◌", color: "warning", text: "miss" }

  test("a source still deriving is pending; answered rows still merge", () => {
    const deriving = { id: "deriving", extensionId: "ext", rows: () => Option.none() }
    const merged = noticeRowItems(
      [{ id: "answered", extensionId: "ext", rows: () => Option.some([row]) }, deriving],
      session,
      new Map(),
    )
    expect(merged.pending).toEqual([deriving])
    expect([...merged.items.values()].map((item) => item.createdAt)).toEqual([5])
    const answered = noticeRowItems(
      [{ id: "answered", extensionId: "ext", rows: () => Option.some([row]) }],
      session,
      merged.items,
    )
    expect(answered.pending).toEqual([])
    // The same row object keeps its transcript item.
    expect(answered.items.get(row)).toBe(merged.items.get(row))
  })
})

describe("refused submissions", () => {
  const empty = { entries: [], shown: "" }
  const editing = (draft: string) =>
    ({ draft, mode: "editing" }) satisfies Parameters<typeof mergeRefused>[0]

  test("a refusal that lands after an earlier one's text was edited goes ahead of the whole draft", () => {
    const first = mergeRefused(editing(""), empty, {
      order: 0,
      text: "one",
      shell: false,
      requestId: Option.none(),
    })
    const edited = mergeRefused(editing("one, edited"), first.block, {
      order: 1,
      text: "two",
      shell: false,
      requestId: Option.none(),
    })
    expect(edited.draft).toEqual(editing("two\n\none, edited"))
  })

  test("refusals keep send order ahead of what the reader typed since", () => {
    const second = mergeRefused(editing(""), empty, {
      order: 1,
      text: "two",
      shell: false,
      requestId: Option.none(),
    })
    const typed = `${second.draft.draft}\n\ntyped`
    const first = mergeRefused(editing(typed), second.block, {
      order: 0,
      text: "one",
      shell: false,
      requestId: Option.none(),
    })
    expect(first.draft).toEqual(editing("one\n\ntwo\n\ntyped"))
  })

  test("a refused command alone stays a command; beside a message it keeps its bang", () => {
    const alone = mergeRefused(editing(""), empty, {
      order: 0,
      text: "ls",
      shell: true,
      requestId: Option.none(),
    })
    expect(alone.draft).toEqual({ draft: "ls", mode: "shell" })
    const mixed = mergeRefused(editing("hello"), empty, {
      order: 1,
      text: "ls",
      shell: true,
      requestId: Option.none(),
    })
    expect(mixed.draft).toEqual(editing("!ls\n\nhello"))
  })

  // The composer on screen writes a text as large as a paste as a placeholder.
  const placeholder = (text: string) => {
    if (text.length < 150) return text
    return `[Pasted ~1 lines #${text.length}]`
  }
  const longCommand = `echo ${"x".repeat(200)}`
  const longMessage = "y".repeat(200)

  test("a long refused command comes back as the command Enter would run", () => {
    const merged = mergeRefused(
      editing(""),
      empty,
      { order: 0, text: longCommand, shell: true, requestId: Option.none() },
      placeholder,
    )
    expect(merged.draft).toEqual({ draft: longCommand, mode: "shell" })
  })

  test("a kept block that joins a composer on screen is written the way that composer writes", () => {
    // Refused while no composer was on screen: the kept draft holds the text itself.
    const kept = mergeRefused(editing(""), empty, {
      order: 0,
      text: longMessage,
      shell: false,
      requestId: Option.none(),
    })
    expect(kept.draft).toEqual(editing(longMessage))
    const live = mergeRefused(
      kept.draft,
      kept.block,
      { order: 1, text: longMessage, shell: false, requestId: Option.none() },
      placeholder,
    )
    expect(live.draft).toEqual(
      editing(`${placeholder(longMessage)}\n\n${placeholder(longMessage)}`),
    )
  })
})

describe("transitionComposerInteraction", () => {
  test("derives mention autocomplete from draft changes", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "ask @dee" },
      testContributions,
    )

    expect(next.draft).toBe("ask @dee")
    expect(next.autocomplete).toEqual(
      Option.some({
        type: "@",
        filter: "dee",
        triggerPos: 4,
      }),
    )
  })

  test("shell mode suppresses autocomplete until exit", () => {
    const shell = transitionComposerInteraction(ComposerInteractionState.initial(), {
      _tag: "EnterShell",
    })
    const edited = transitionComposerInteraction(shell, {
      _tag: "DraftChanged",
      text: "ls -la",
    })
    const exited = transitionComposerInteraction(edited, { _tag: "ExitShell" })

    expect(edited.mode).toBe("shell")
    expect(Option.isNone(edited.autocomplete)).toBe(true)
    expect(exited.mode).toBe("editing")
  })

  test("detects inline trigger $ from contributions", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "use $eff" },
      testContributions,
    )
    expect(next.autocomplete).toEqual(Option.some({ type: "$", filter: "eff", triggerPos: 4 }))
  })

  // The trigger sits after the separator, whatever whitespace it is, so a
  // completion keeps the newline or tab in front of it.
  test("a trigger after a newline or a tab keeps the separator before it", () => {
    for (const text of ["line one\n@src", "line one\t@src"]) {
      const next = transitionComposerInteraction(
        ComposerInteractionState.initial(),
        { _tag: "DraftChanged", text },
        testContributions,
      )
      expect(next.autocomplete).toEqual(Option.some({ type: "@", filter: "src", triggerPos: 9 }))
    }
    const skill = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "one\n$eff" },
      testContributions,
    )
    expect(skill.autocomplete).toEqual(Option.some({ type: "$", filter: "eff", triggerPos: 4 }))
  })

  // A quoted directory row inserts `@"my dir/` with its quote still open, so
  // the popup keeps going inside it; the filter is the text after the quote.
  test("an open quote after a trigger is one filter, spaces included", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: 'see @"my dir/no' },
      testContributions,
    )
    expect(next.autocomplete).toEqual(
      Option.some({ type: "@", filter: "my dir/no", triggerPos: 4 }),
    )
    const closed = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: 'see @"my notes.md" ' },
      testContributions,
    )
    expect(Option.isNone(closed.autocomplete)).toBe(true)
  })

  test("does not detect unregistered prefix", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "use #tag" },
      testContributions,
    )
    expect(Option.isNone(next.autocomplete)).toBe(true)
  })

  test("detects custom inline prefix when registered", () => {
    const custom: AutocompleteContribution[] = [{ prefix: "#", title: "Tags", items: () => [] }]
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "use #tag" },
      custom,
    )
    expect(next.autocomplete).toEqual(Option.some({ type: "#", filter: "tag", triggerPos: 4 }))
  })

  test("no contributions means no autocomplete detection", () => {
    const next = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "ask @dee" },
      [],
    )
    expect(Option.isNone(next.autocomplete)).toBe(true)
  })

  test("restore and clear draft close autocomplete", () => {
    const withAutocomplete = transitionComposerInteraction(
      ComposerInteractionState.initial(),
      { _tag: "DraftChanged", text: "/" },
      testContributions,
    )
    expect(Option.isSome(withAutocomplete.autocomplete)).toBe(true)

    const restored = transitionComposerInteraction(withAutocomplete, {
      _tag: "RestoreDraft",
      text: "previous prompt",
    })
    const cleared = transitionComposerInteraction(restored, { _tag: "ClearDraft" })

    expect(restored.draft).toBe("previous prompt")
    expect(Option.isNone(restored.autocomplete)).toBe(true)
    expect(cleared.draft).toBe("")
    expect(Option.isNone(cleared.autocomplete)).toBe(true)
  })
})

// ── model query ─────────────────────────────────────────────────────────────

const model = (id: string, name: string): Model =>
  new Model({ id: ModelId.make(id), name, provider: ProviderId.make(id.split("/")[0] ?? "") })

const catalogue = [
  model("anthropic/claude-sonnet-5", "Claude Sonnet 5"),
  model("anthropic/claude-opus-5", "Claude Opus 5"),
  model("openai/gpt-5.6-luna", "GPT-5.6 Luna"),
]

describe("resolveModelQuery", () => {
  test("an exact id wins even when it is a prefix of another id", () => {
    const result = resolveModelQuery(
      [...catalogue, model("anthropic/claude-opus-5-fast", "Claude Opus 5 Fast")],
      "anthropic/claude-opus-5",
    )
    expect(result._tag).toBe("Match")
    if (result._tag === "Match")
      expect(result.model.id).toBe(ModelId.make("anthropic/claude-opus-5"))
  })

  test("a unique substring of the display name matches case-insensitively", () => {
    const result = resolveModelQuery(catalogue, "LUNA")
    expect(result._tag).toBe("Match")
    if (result._tag === "Match") expect(result.model.id).toBe(ModelId.make("openai/gpt-5.6-luna"))
  })

  test("a substring shared by several models is ambiguous and lists them", () => {
    const result = resolveModelQuery(catalogue, "claude")
    expect(result._tag).toBe("Ambiguous")
    if (result._tag === "Ambiguous")
      expect(result.candidates.map((m) => m.id)).toEqual([
        ModelId.make("anthropic/claude-sonnet-5"),
        ModelId.make("anthropic/claude-opus-5"),
      ])
  })

  test("no match reports none", () => {
    expect(resolveModelQuery(catalogue, "gemini")._tag).toBe("None")
  })

  test("an empty filter keeps the catalogue order", () => {
    expect(filterModels(catalogue, "  ")).toEqual(catalogue)
  })
})

// ── prompt history ──────────────────────────────────────────────────────────

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

/**
 * The store itself lives in `ComposerMemoryProvider` (session.tsx), so the
 * index/saved-entry bookkeeping is modeled here while the cursor gate under test
 * is the real `canNavigateAtCursor`.
 */
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

// ── prompt history store ────────────────────────────────────────────────────

/**
 * The cache path follows the workspace home the shell mounted with. A build
 * that resolves it from the host `homedir()` instead writes outside the home
 * it was handed, and these round-trips miss the file they just wrote.
 */
const storeTest = it.scopedLive.layer(BunServices.layer)

describe("prompt history store", () => {
  storeTest("entries round-trip under the supplied home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      expect(Option.isNone(yield* readEntries(home))).toBe(true)

      yield* writeEntries(home, ["second prompt", "first prompt"])

      const written = `${home}/.cache/gent/prompt-history.json`
      expect(yield* fs.exists(written)).toBe(true)

      const loaded = yield* readEntries(home)
      expect(Option.getOrElse(loaded, (): ReadonlyArray<string> => [])).toEqual([
        "second prompt",
        "first prompt",
      ])
    }),
  )

  storeTest("a second home keeps its own history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const first = yield* fs.makeTempDirectoryScoped()
      const second = yield* fs.makeTempDirectoryScoped()

      yield* writeEntries(first, ["only in first"])

      expect(Option.isNone(yield* readEntries(second))).toBe(true)
      expect(Option.getOrElse(yield* readEntries(first), (): ReadonlyArray<string> => [])).toEqual([
        "only in first",
      ])
    }),
  )
})

describe("prompt history across writers", () => {
  storeTest("an add keeps the prompts another gent wrote since this one loaded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      yield* recordPrompt(home, "mine, first")

      // A second TUI on the same home submits behind this one's back.
      yield* writeEntries(home, ["theirs", "mine, first"])

      const merged = yield* recordPrompt(home, "mine, second")

      expect(merged).toEqual(["mine, second", "theirs", "mine, first"])
      expect(Option.getOrElse(yield* readEntries(home), (): ReadonlyArray<string> => [])).toEqual(
        merged,
      )
    }),
  )

  storeTest("concurrent adds in one process all land", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const prompts = Array.from({ length: 20 }, (_, index) => `prompt ${index}`)

      yield* Effect.forEach(prompts, (prompt) => recordPrompt(home, prompt), {
        concurrency: prompts.length,
        discard: true,
      })

      const stored = Option.getOrElse(yield* readEntries(home), (): ReadonlyArray<string> => [])
      expect([...stored].sort()).toEqual([...prompts].sort())
    }),
  )

  storeTest("a repeat of the newest prompt is not stored twice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      yield* recordPrompt(home, "same")
      expect(yield* recordPrompt(home, "same")).toEqual(["same"])
    }),
  )
})

// ── session controller state ────────────────────────────────────────────────

const queueEntry = (tag: QueueEntryInfo["_tag"], id: string, content: string): QueueEntryInfo => ({
  _tag: tag,
  id: MessageId.make(id),
  content,
  createdAt: 0,
})

describe("session controller state", () => {
  test("auth checks ignore stale success and failure results", () => {
    const initial = initialSessionControllerState({ agent: "fast" })
    const first = beginAuthCheck(initial)
    const second = beginAuthCheck(first)

    const staleSuccess = completeAuthCheck(second, {
      version: first.authCheckVersion,
      agent: "fast",
      missing: true,
    })
    const staleFailure = failAuthCheck(second, first.authCheckVersion)

    expect(staleSuccess).toBe(second)
    expect(staleFailure).toBe(second)
    expect(second.authGate).toBe("checking")
  })

  test("manual auth close invalidates pending checks and stores the current agent", () => {
    const checking = beginAuthCheck(initialSessionControllerState({ agent: "fast" }))
    const closed = closeAuthGateState(checking, "deep")
    const staleResult = completeAuthCheck(closed, {
      version: checking.authCheckVersion,
      agent: "fast",
      missing: true,
    })

    expect(closed.authGate).toBe("closed")
    expect(closed.validatedAgent).toBe("deep")
    expect(closed.authCheckVersion).toBe(checking.authCheckVersion + 1)
    expect(staleResult).toBe(closed)
  })

  test("queued draft text preserves steering before follow-up entries", () => {
    const queue = {
      steering: [queueEntry("Steering", "m1", "switch agents")],
      followUp: [
        queueEntry("FollowUp", "m2", "then continue"),
        queueEntry("FollowUp", "m3", "and summarize"),
      ],
    }

    const withQueue = setQueue(initialSessionControllerState({ agent: "fast" }), queue)
    const cleared = clearQueue(withQueue)

    expect(queuedDraftText(withQueue.queue)).toBe("switch agents\nthen continue\nand summarize")
    expect(queuedDraftText(cleared.queue)).toBeUndefined()
  })
})

// ── session labels ──────────────────────────────────────────────────────────

const absent = Option.getOrUndefined(Option.none())

const theme = {
  textMuted: RGBA.fromHex("#888888"),
  error: RGBA.fromHex("#ff0000"),
  warning: RGBA.fromHex("#ffaa00"),
  info: RGBA.fromHex("#00aaff"),
}

const contextLabels = (
  latestInputTokens: number,
  // eslint-disable-next-line effect/noNullish -- mirrors the optional client snapshot field.
  contextLength: number | undefined,
  context?: ModelContextMetrics,
  limits: { readonly inputLimit?: number; readonly outputLimit?: number } = {},
) =>
  buildContextLabels({
    metrics: { latestInputTokens, context: Option.fromNullishOr(context) },
    model: Option.some({ contextLength, ...limits }),
    theme,
  })

describe("buildModelLabels", () => {
  test("empty when no data", () => {
    const labels = buildModelLabels({
      reasoningLevel: Option.none(),
      theme,
      debugMode: false,
    })
    expect(labels.length).toBe(0)
  })

  test("shows thinking level when set", () => {
    const labels = buildModelLabels({
      reasoningLevel: Option.some("high"),
      theme,
      debugMode: false,
    })
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("high")
    expect(labels[0]!.color).toBe(theme.info)
  })

  test("debug mode shows debug label", () => {
    const labels = buildModelLabels({
      reasoningLevel: Option.none(),
      theme,
      debugMode: true,
    })
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("debug")
  })

  test("carries no context gauge — that anchors to the right edge", () => {
    const labels = buildModelLabels({
      reasoningLevel: Option.some("high"),
      theme,
      debugMode: true,
    })
    expect(labels.map((label) => label.text)).toEqual(["high", "debug"])
  })
})

describe("buildContextLabels", () => {
  test("shows context utilization against the input one request may carry", () => {
    // A 200k window keeps 32k for the reply: 168k of input.
    const labels = contextLabels(42_000, 200_000, absent)
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("42k (25%)")
    expect(labels[0]!.color).toBe(theme.textMuted)
  })

  test("with no projection a full input ceiling reads full before the handoff", () => {
    const labels = contextLabels(168_000, 200_000, absent)
    expect(labels[0]!.text).toBe("168k (100%)")
    expect(labels[0]!.color).toBe(theme.error)
  })

  test("with no projection the reserve follows the model's own output cap", () => {
    // An 8k output cap leaves 192k of the 200k window for input.
    const labels = contextLabels(96_000, 200_000, absent, { outputLimit: 8_000 })
    expect(labels[0]!.text).toBe("96k (50%)")
  })

  test("context at 70% uses warning color", () => {
    // A 100k window keeps a quarter, 25k, for the reply.
    const labels = contextLabels(55_000, 100_000, absent)
    expect(labels[0]!.color).toBe(theme.warning)
  })

  test("context at 90% uses error color", () => {
    const labels = contextLabels(70_000, 100_000, absent)
    expect(labels[0]!.color).toBe(theme.error)
  })

  test("a model with an input cap below its window reads full one step before the handoff", () => {
    // GPT-5: a 400k window and a 272k input cap. The messages take 250k of
    // the 252k left after the system prompt and tools; the provider counted
    // 270k in all.
    const labels = contextLabels(270_000, 400_000, {
      estimatedTokens: 250_000,
      availableInputTokens: 252_000,
      contextLimitTokens: 400_000,
      omittedMessages: 3,
      compactions: 2,
      handoffMessageId: MessageId.make("context-handoff:b:m"),
    })
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("ctx 99%")
    expect(labels[0]!.color).toBe(theme.error)
  })

  test("the projection's estimate reads against the input the messages may take", () => {
    const labels = contextLabels(0, 200_000, {
      estimatedTokens: 84_000,
      availableInputTokens: 168_000,
      contextLimitTokens: 200_000,
      omittedMessages: 3,
      compactions: 2,
    })
    expect(labels[0]!.text).toBe("ctx 50%")
  })

  test("a projection with nothing dropped shows only the percent", () => {
    const labels = contextLabels(0, absent, {
      estimatedTokens: 171_000,
      availableInputTokens: 190_000,
      contextLimitTokens: 200_000,
      omittedMessages: 0,
      compactions: 0,
    })
    expect(labels[0]!.text).toBe("ctx 90%")
    expect(labels[0]!.color).toBe(theme.error)
  })

  test("with no projection the provider's count reads against the input cap", () => {
    const labels = contextLabels(136_000, 400_000, absent, { inputLimit: 272_000 })
    expect(labels[0]!.text).toBe("136k (50%)")
  })

  test("a summary-free projection does not label the old compaction count", () => {
    const labels = contextLabels(0, absent, {
      estimatedTokens: 1000,
      availableInputTokens: 190000,
      contextLimitTokens: 200000,
      omittedMessages: 0,
      compactions: 2,
    })
    expect(labels[0]?.text).toBe("ctx 1%")
  })

  test("skips context when tokens are 0", () => {
    expect(contextLabels(0, 200_000, absent).length).toBe(0)
  })

  test("skips context when contextLength undefined", () => {
    expect(contextLabels(50_000, absent, absent).length).toBe(0)
  })
})

describe("formatCwdGit", () => {
  test("cwd at the git root shows the repo name", () => {
    expect(formatCwdGit("/home/u/repo", Option.some("/home/u/repo"), Option.none())).toBe("repo")
  })

  test("cwd under the git root shows the path relative to the repo", () => {
    expect(formatCwdGit("/home/u/repo/apps/tui", Option.some("/home/u/repo"), Option.none())).toBe(
      "repo/apps/tui",
    )
  })

  test("cwd outside the git root falls back to the repo name", () => {
    expect(formatCwdGit("/elsewhere", Option.some("/home/u/repo"), Option.none())).toBe("repo")
  })

  test("no git root shows the last cwd segment", () => {
    expect(formatCwdGit("/home/u/scratch", Option.none(), Option.none())).toBe("scratch")
  })

  test("a non-empty branch is appended in parentheses", () => {
    expect(formatCwdGit("/home/u/repo", Option.some("/home/u/repo"), Option.some("main"))).toBe(
      "repo (main)",
    )
    expect(formatCwdGit("/home/u/repo", Option.some("/home/u/repo"), Option.some(""))).toBe("repo")
  })
})

// ── session labels order ────────────────────────────────────────────────────

/**
 * The status row reads left to right as: where you are, what you are running
 * it with, how full it is, what it cost. Each label's neighbours are the
 * specification, not an accident of which builder happened to push first.
 *
 * Effort belongs beside the model because the two together name what is
 * answering — "Sonnet 5 at medium" is one fact — while the context gauge
 * belongs with the running total, since both describe the session's spend
 * rather than its configuration.
 */

const themeOrder = {
  textMuted: RGBA.fromInts(138, 138, 138, 255),
  error: RGBA.fromInts(255, 0, 0, 255),
  warning: RGBA.fromInts(255, 200, 0, 255),
  info: RGBA.fromInts(0, 200, 255, 255),
}

const texts = (items: ReadonlyArray<{ text: string }>) => items.map((item) => item.text)

// `buildContextLabels` mirrors the client snapshot's optional fields, so its
// absent values are genuinely undefined at this boundary. Naming them keeps
// the intent readable where the signature cannot use Option.
// eslint-disable-next-line effect/noNullish -- matches the helper's optional parameters.
const NO_CONTEXT_LENGTH: number | undefined = undefined
// eslint-disable-next-line effect/noNullish -- matches the helper's optional parameters.
const NO_CONTEXT: undefined = undefined

const contextLabelsOrder = (
  latestInputTokens: number,
  // eslint-disable-next-line effect/noNullish -- matches the helper's optional parameter.
  contextLength: number | undefined,
  context?: ModelContextMetrics,
) =>
  buildContextLabels({
    metrics: { latestInputTokens, context: Option.fromNullishOr(context) },
    model: Option.some({ contextLength }),
    theme: themeOrder,
  })

describe("effort sits with the model and the gauge anchors right", () => {
  test("reports the effort without the context gauge", () => {
    const labels = buildModelLabels({
      reasoningLevel: Option.some("medium"),
      theme: themeOrder,
      debugMode: false,
    })
    expect(texts(labels)).toEqual(["medium"])
  })

  test("reports no effort when none is set", () => {
    const labels = buildModelLabels({
      reasoningLevel: Option.none(),
      theme: themeOrder,
      debugMode: false,
    })
    expect(texts(labels)).toEqual([])
  })

  test("reports a projected context percentage on its own", () => {
    const labels = contextLabelsOrder(0, NO_CONTEXT_LENGTH, {
      estimatedTokens: 2_000,
      availableInputTokens: 8_000,
      contextLimitTokens: 10_000,
      omittedMessages: 0,
      compactions: 0,
    })
    expect(texts(labels)).toEqual(["ctx 25%"])
  })

  test("falls back to a usage-derived percentage", () => {
    // A 10k window keeps a quarter for the reply: 7.5k of input.
    const labels = contextLabelsOrder(3_750, 10_000, NO_CONTEXT)
    expect(texts(labels)[0]).toContain("50%")
  })

  test("reports nothing when there is no context to report", () => {
    expect(texts(contextLabelsOrder(0, NO_CONTEXT_LENGTH, NO_CONTEXT))).toEqual([])
  })
})

// ── session ui state ────────────────────────────────────────────────────────

describe("transcript disclosure", () => {
  test("a fresh session starts collapsed", () => {
    expect(SessionUiState.initial().disclosure).toBe("collapsed")
  })

  test("ctrl+o walks collapsed, preview, full, then wraps", () => {
    expect(nextDisclosure("collapsed")).toBe("preview")
    expect(nextDisclosure("preview")).toBe("full")
    expect(nextDisclosure("full")).toBe("collapsed")
    const once = transitionSessionUi(SessionUiState.initial(), { _tag: "CycleDisclosure" })
    const twice = transitionSessionUi(once.state, { _tag: "CycleDisclosure" })
    expect(once.state.disclosure).toBe("preview")
    expect(twice.state.disclosure).toBe("full")
  })

  test("escape returns any level to collapsed without touching the transcript view", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), { _tag: "ToggleTranscript" })
    const full = transitionSessionUi(
      transitionSessionUi(opened.state, { _tag: "CycleDisclosure" }).state,
      { _tag: "CycleDisclosure" },
    )
    const collapsed = transitionSessionUi(full.state, { _tag: "CollapseDisclosure" })
    expect(collapsed.state.disclosure).toBe("collapsed")
    expect(collapsed.state.transcriptExpanded).toBe(true)
  })

  test("clearing the display keeps the chosen level", () => {
    const preview = transitionSessionUi(SessionUiState.initial(), { _tag: "CycleDisclosure" })
    const cleared = transitionSessionUi(preview.state, { _tag: "ClearDisplay" })
    expect(cleared.state.disclosure).toBe("preview")
  })
})

describe("one pane slot", () => {
  const open = (id: string) =>
    transitionSessionUi(SessionUiState.initial(), { _tag: "OpenPane", id }).state

  test("an extension pane replaces the open settings picker", () => {
    const picker = transitionSessionUi(SessionUiState.initial(), {
      _tag: "OpenSettingsPicker",
      picker: "model",
    }).state
    const pane = transitionSessionUi(picker, { _tag: "OpenPane", id: "agents.pane" }).state
    expect(pane.overlay).toEqual({ _tag: "pane", id: "agents.pane" })
  })

  test("a second pane replaces the first", () => {
    const next = transitionSessionUi(open("btw.pane"), { _tag: "OpenPane", id: "thread.pane" })
    expect(next.state.overlay).toEqual({ _tag: "pane", id: "thread.pane" })
  })

  test("a settings picker replaces an open pane", () => {
    const picker = transitionSessionUi(open("btw.pane"), {
      _tag: "OpenSettingsPicker",
      picker: "reasoning",
    })
    expect(picker.state.overlay).toEqual({ _tag: "reasoning" })
  })

  test("closing a pane that was replaced leaves the open one", () => {
    const thread = transitionSessionUi(open("btw.pane"), { _tag: "OpenPane", id: "thread.pane" })
    const late = transitionSessionUi(thread.state, { _tag: "ClosePane", id: "btw.pane" })
    expect(late.state.overlay).toEqual({ _tag: "pane", id: "thread.pane" })
    const closed = transitionSessionUi(late.state, { _tag: "ClosePane", id: "thread.pane" })
    expect(closed.state.overlay).toEqual({ _tag: "none" })
  })

  test("the boot branch picker and an enforced sign-in keep the slot until they close", () => {
    const opens: ReadonlyArray<Parameters<typeof transitionSessionUi>[1]> = [
      { _tag: "OpenPane", id: "agents.pane" },
      { _tag: "OpenFork", messages: [] },
      { _tag: "OpenMermaid" },
      { _tag: "OpenAuth", enforceAuth: false },
      { _tag: "OpenSettingsPicker", picker: "model" },
      { _tag: "OpenBranches", branches: [] },
      { _tag: "PromptSearch", event: { _tag: "Open", draftBeforeOpen: "draft" } },
      { _tag: "PromptSearch", event: { _tag: "Cancel" } },
    ]
    const branches = SessionUiState.initial(Option.some([]))
    const signIn = transitionSessionUi(SessionUiState.initial(), {
      _tag: "OpenAuth",
      enforceAuth: true,
    }).state
    for (const held of [branches, signIn]) {
      const kept = opens.filter((event) => transitionSessionUi(held, event).state === held)
      expect(kept).toEqual([...opens])
      expect(transitionSessionUi(held, { _tag: "CloseOverlay" }).state.overlay).toEqual({
        _tag: "none",
      })
    }
    // A sign-in the reader opened is theirs to leave for another pane.
    const optional = transitionSessionUi(SessionUiState.initial(), {
      _tag: "OpenAuth",
      enforceAuth: false,
    }).state
    const pane = transitionSessionUi(optional, { _tag: "OpenPane", id: "agents.pane" })
    expect(pane.state.overlay).toEqual({ _tag: "pane", id: "agents.pane" })
  })

  test("a pane leaves the composer and the session keys live; a picker holds them", () => {
    expect(overlayHoldsComposer(open("agents.pane").overlay)).toBe(false)
    expect(overlayHoldsComposer({ _tag: "model" })).toBe(true)
    expect(overlayHoldsComposer({ _tag: "none" })).toBe(false)
  })
})

describe("settings picker overlay", () => {
  test("/model and /think open their pane and escape closes it", () => {
    const model = transitionSessionUi(SessionUiState.initial(), {
      _tag: "OpenSettingsPicker",
      picker: "model",
    })
    expect(model.state.overlay).toEqual({ _tag: "model" })
    const reasoning = transitionSessionUi(model.state, {
      _tag: "OpenSettingsPicker",
      picker: "reasoning",
    })
    expect(reasoning.state.overlay).toEqual({ _tag: "reasoning" })
    const closed = transitionSessionUi(reasoning.state, { _tag: "CloseOverlay" })
    expect(closed.state.overlay).toEqual({ _tag: "none" })
  })
})

describe("prompt search overlay", () => {
  test("opening docks the palette over the draft", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
    })
    expect(opened.state.overlay).toEqual({
      _tag: "prompt-search",
      state: { _tag: "open", draftBeforeOpen: "draft", highlighted: Option.none() },
    })
    expect(opened.effects).toEqual([])
  })

  test("accepting a highlighted entry restores it to the composer and closes the palette", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
    })
    const moved = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "Highlight", entry: Option.some("second") },
    })
    expect(moved.effects).toEqual([{ _tag: "RestoreComposer", text: "second" }])
    const accepted = transitionSessionUi(moved.state, {
      _tag: "PromptSearch",
      event: { _tag: "Accept" },
    })
    expect(accepted.state.overlay).toEqual({ _tag: "none" })
    expect(accepted.effects).toEqual([{ _tag: "RestoreComposer", text: "second" }])
  })

  test("an overlay that replaces a previewing search gives the draft back, and a late event is ignored", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "mine" },
    })
    const previewing = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "Highlight", entry: Option.some("older prompt") },
    }).state
    const replacers: ReadonlyArray<Parameters<typeof transitionSessionUi>[1]> = [
      { _tag: "OpenPane", id: "agents.pane" },
      { _tag: "OpenFork", messages: [] },
      { _tag: "OpenMermaid" },
      { _tag: "OpenAuth", enforceAuth: false },
      { _tag: "OpenSettingsPicker", picker: "model" },
      { _tag: "OpenBranches", branches: [] },
      { _tag: "CloseOverlay" },
    ]
    for (const event of replacers) {
      const replaced = transitionSessionUi(previewing, event)
      expect(replaced.state.overlay._tag).not.toBe("prompt-search")
      expect(replaced.effects).toEqual([{ _tag: "RestoreComposer", text: "mine" }])
    }
    // The list's cleanup runs after the pane took the slot: it changes nothing.
    const pane = transitionSessionUi(previewing, { _tag: "OpenPane", id: "agents.pane" }).state
    const lates: ReadonlyArray<Parameters<typeof transitionSessionUi>[1]> = [
      { _tag: "PromptSearch", event: { _tag: "Highlight", entry: Option.none() } },
      { _tag: "PromptSearch", event: { _tag: "Cancel" } },
      { _tag: "PromptSearch", event: { _tag: "Accept" } },
    ]
    for (const late of lates) {
      const after = transitionSessionUi(pane, late)
      expect(after.state).toBe(pane)
      expect(after.effects).toEqual([])
    }
  })

  test("a list that emptied previews the draft, and accepting before a move keeps it", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
    })
    const emptied = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "Highlight", entry: Option.none() },
    })
    expect(emptied.effects).toEqual([{ _tag: "RestoreComposer", text: "draft" }])
    const accepted = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "Accept" },
    })
    expect(accepted.state.overlay).toEqual({ _tag: "none" })
    expect(accepted.effects).toEqual([{ _tag: "RestoreComposer", text: "draft" }])
  })

  test("cancelling restores the draft the palette opened over", () => {
    const opened = transitionSessionUi(SessionUiState.initial(), {
      _tag: "PromptSearch",
      event: { _tag: "Open", draftBeforeOpen: "draft" },
    })
    const cancelled = transitionSessionUi(opened.state, {
      _tag: "PromptSearch",
      event: { _tag: "Cancel" },
    })
    expect(cancelled.state.overlay).toEqual({ _tag: "none" })
    expect(cancelled.effects).toEqual([{ _tag: "RestoreComposer", text: "draft" }])
  })
})

// ── reconnect ───────────────────────────────────────────────────────────────

describe("reconnect", () => {
  const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

  it.live("a stream that became ready starts a fresh backoff when it ends", () =>
    Effect.gen(function* () {
      const starts: Array<number> = []
      const sixthStarted = yield* Deferred.make<void>()
      const loop = yield* runWithReconnect(
        (ready) =>
          Effect.gen(function* () {
            starts.push(yield* Clock.currentTimeMillis)
            // Four attempts end before they serve; the fifth serves, then drops.
            if (starts.length === 5) yield* ready
            if (starts.length === 6) {
              yield* Deferred.succeed(sixthStarted, void 0)
              return yield* Effect.never
            }
          }),
        { log: silentLog, waitForRetry: () => Effect.void },
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust("2 minutes")
      yield* Deferred.await(sixthStarted)
      yield* Fiber.interrupt(loop)
      // The unserved attempts back off 1 s, 2 s, 4 s, 8 s; the drop of a
      // served stream retries after 1 s again, not after the grown delay.
      expect(starts).toEqual([0, 1_000, 3_000, 7_000, 15_000, 16_000])
    }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("4 seconds")),
  )
})
