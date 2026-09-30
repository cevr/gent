import { describe, expect, it, test } from "effect-bun-test"
import { Clock, Deferred, Effect, Fiber, FileSystem, Option, Exit, Predicate, Stream } from "effect"
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
  slashAutocompleteItems,
  useSessionFeed,
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
  type ActiveInteraction,
  AgentEvent,
  AgentName,
  assistantMessageIdForTurn,
  dateFromMillis,
  EventEnvelope,
  Message,
  projectMessage,
  type SessionSnapshot,
  ToolCallId,
  ToolInteraction,
  OutputCut,
} from "@gent/core/protocol"
import { BunServices } from "@effect/platform-bun"
import { RGBA } from "@opentui/core"
import type { Command } from "../src/commands"
import { emptyFrecencyStore, frecencyLookup, recordPick } from "../src/autocomplete"
import { emptyQueueSnapshot, EventId, type SessionRuntimeState } from "@gent/core/test-utils"
import type { GentRuntime } from "@gent/sdk"
import { ExtensionId } from "@gent/core/extensions/api"
import { type Session } from "../src/client"
import { createRoot, createSignal } from "solid-js"
import { createMockClient, createMockRuntime } from "./render-harness-boundary"
import { waitUntil, waitUntilAdvancing } from "./helpers-boundary"
import * as Prompt from "effect/ai/Prompt"
import { InteractionRequestId } from "@gent/core/extensions/branch-tools"
import {
  getSessionEventLabel,
  type Message as FeedMessage,
  messageToolCalls,
} from "../src/message-list"
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError"

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
    return `[Pasted ${text.length} chars #1]`
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
    const initial = initialSessionControllerState()
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
    const checking = beginAuthCheck(initialSessionControllerState())
    const closed = closeAuthGateState(checking, Option.some("deep"))
    const staleResult = completeAuthCheck(closed, {
      version: checking.authCheckVersion,
      agent: "fast",
      missing: true,
    })

    expect(closed.authGate).toBe("closed")
    expect(closed.validatedAgent).toEqual(Option.some("deep"))
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

    const withQueue = setQueue(initialSessionControllerState(), queue)
    const cleared = clearQueue(withQueue)

    expect(queuedDraftText(withQueue.queue)).toEqual(
      Option.some("switch agents\nthen continue\nand summarize"),
    )
    expect(queuedDraftText(cleared.queue)).toEqual(Option.none())
  })
})

// ── session labels ──────────────────────────────────────────────────────────

// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined

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

// ── slash autocomplete ──────────────────────────────────────────────────────

/**
 * The `/` items a reader's keystrokes reach, ranked by the session registry.
 *
 * The scorer has its own tests, but a scorer nobody calls ranks nothing, and a
 * pick history nobody passes through changes no popup. These drive
 * `slashAutocompleteItems` and assert the order a reader would see, so
 * disconnecting it from the ranking or from the history fails here.
 */

/**
 * A registration order that a substring filter gets wrong: `/fork` and
 * `/auth` carry "ag" in their titles and register before `/agents` carries it
 * in its name.
 */
const commands: ReadonlyArray<Command> = [
  { id: "message.fork", title: "Fork from Message", slash: "fork", onSelect: () => {} },
  { id: "auth.manage", title: "Manage API Keys", slash: "auth", onSelect: () => {} },
  { id: "agents.view", title: "Agents", slash: "agents", aliases: ["tree"], onSelect: () => {} },
  { id: "session.model", title: "Set Model", slash: "model", onSelect: () => {} },
  { id: "session.think", title: "Set Reasoning", slash: "think", onSelect: () => {} },
]

const ids = (items: ReadonlyArray<{ readonly id: string }>): ReadonlyArray<string> =>
  items.map((item) => item.id)

describe("slash autocomplete contribution", () => {
  test("puts the command named by the filter first", () => {
    // Registration order would answer `fork, auth, agents`, and the
    // preselected row is the one Tab completes and Enter runs.
    expect(ids(slashAutocompleteItems(commands, "ag"))[0]).toBe("agents")
  })

  test("drops commands that match only through their title", () => {
    const ranked = ids(slashAutocompleteItems(commands, "ag"))
    expect(ranked).not.toContain("fork")
    expect(ranked).not.toContain("auth")
  })

  test("still offers aliases", () => {
    expect(ids(slashAutocompleteItems(commands, "tre"))).toContain("tree")
  })

  test("ranks a partially typed name onto its command", () => {
    expect(ids(slashAutocompleteItems(commands, "mod"))[0]).toBe("model")
    expect(ids(slashAutocompleteItems(commands, "thi"))[0]).toBe("think")
  })

  test("offers every command when nothing is typed yet", () => {
    // One row per slash name plus the alias.
    expect(ids(slashAutocompleteItems(commands, ""))).toEqual([
      "fork",
      "auth",
      "agents",
      "tree",
      "model",
      "think",
    ])
  })

  test("offers nothing for a filter no command matches", () => {
    expect(slashAutocompleteItems(commands, "zzzz")).toEqual([])
  })
})

const NOW = 1_800_000_000_000

/** `/think` and `/thread` tie on everything the matcher can see but length. */
const commandsSeam: ReadonlyArray<Command> = [
  { id: "session.think", title: "Set Reasoning", slash: "think", onSelect: () => {} },
  { id: "session.thread", title: "Thread over sessions", slash: "thread", onSelect: () => {} },
]

describe("slash autocomplete reads pick history", () => {
  test("answers /t with think for a reader who has picked nothing", () => {
    expect(ids(slashAutocompleteItems(commandsSeam, "t"))[0]).toBe("think")
  })

  test("answers /thr with thread once the reader has picked it", () => {
    // The seam: the contribution has to pass the history through to the
    // ranker. A build that drops the third argument still answers `think`.
    //
    // Three characters, not one: ranking ignores pick history below
    // FRECENCY_MIN_FILTER, so a one-character filter would pass this test for
    // the wrong reason — it would answer `think` whether or not the history
    // reached the ranker at all.
    const store = recordPick(emptyFrecencyStore(), "/", "thread", NOW)
    expect(ids(slashAutocompleteItems(commandsSeam, "thr", frecencyLookup(store, NOW)))[0]).toBe(
      "thread",
    )
  })

  test("keeps a picked command out of a filter it does not match", () => {
    const store = recordPick(emptyFrecencyStore(), "/", "thread", NOW)
    expect(ids(slashAutocompleteItems(commandsSeam, "think", frecencyLookup(store, NOW)))[0]).toBe(
      "think",
    )
  })
})

// ── session feed ────────────────────────────────────────────────────────────

type FeedClient = Parameters<typeof useSessionFeed>[2]

/** A feed client whose every member a test does not name does nothing. */
const feedClientStub = (
  parts: Pick<FeedClient, "sessionIdentity" | "client" | "runtime"> & Partial<FeedClient>,
): FeedClient => ({
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  setConnectionIssue: () => {},
  waitForTransportReady: Effect.void,
  applySessionRuntime: () => {},
  applySessionSnapshot: () => {},
  applySessionEvent: () => {},
  resetSessionEvents: () => {},
  applyBufferedSessionEvent: () => {},
  finishReplay: () => {},
  pathPlace: () => ({ cwd: "/work/proj", home: "/home/test" }),
  ...parts,
})

const snapshotFor = (
  sessionId: SessionId,
  branchId: BranchId,
  lastEventId?: number,
): SessionSnapshot => ({
  sessionId,
  branchId,
  messages: [],
  lastEventId: Option.getOrNull(Option.fromNullishOr(lastEventId)),
  resolvedModelId: ModelId.make("anthropic/claude-sonnet-5"),
  agent: AgentName.make("primary"),
  runtime: {
    _tag: "Idle",
    queue: emptyQueueSnapshot(),
  },
  metrics: {
    turns: 0,
    durationMs: 0,
    costUsd: 0,
    lastInputTokens: 0,
  },
})

const runtimeSnapshot = (): SessionRuntimeState => ({
  _tag: "Idle",
  queue: emptyQueueSnapshot(),
})

const makeEnvelope = (id: number, event: AgentEvent, createdAt = 0): EventEnvelope =>
  EventEnvelope.make({
    id: EventId.make(id),
    event,
    createdAt,
  })

const makeUserMessage = (sessionId: SessionId, branchId: BranchId): Message =>
  Message.cases.regular.make({
    id: MessageId.make("message-feed-duplicate-user"),
    sessionId,
    branchId,
    role: "user",
    parts: [],
    createdAt: dateFromMillis(0),
  })

const makeCompactionMessage = (sessionId: SessionId, branchId: BranchId): Message =>
  Message.cases.regular.make({
    id: MessageId.make("context-handoff:branch-feed-compaction:anchor"),
    sessionId,
    branchId,
    role: "user",
    parts: [Prompt.textPart({ text: "Context handoff: stored summary" })],
    metadata: {
      customType: "context-window",
      details: {
        keepFromMessageId: "anchor",
        summarized: { firstMessageId: "m1", lastMessageId: "m3", count: 3 },
      },
    },
    createdAt: dateFromMillis(0),
  })

const makeSession = (sessionId: SessionId, branchId: BranchId): Session => ({
  sessionId,
  branchId,
  name: "Test Session",
})

/** The feed reads only which session is active, so the probe supplies only that. */
const identityOf = (active: () => Session) => () => ({
  sessionId: active().sessionId,
  branchId: active().branchId,
})

const isSessionEvent = Predicate.or(
  Predicate.isTagged("turn-ended"),
  Predicate.or(Predicate.isTagged("retrying"), Predicate.isTagged("error")),
)

/** A message's tool calls; none for a message that is not there. */
const toolCallsOf = (message: Option.Option<FeedMessage>): ReturnType<typeof messageToolCalls> =>
  Option.match(message, { onNone: () => [], onSome: messageToolCalls })

describe("useSessionFeed", () => {
  it.live("an unmount interrupts the feed fiber", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("feed-unmount-session")
      const branchId = BranchId.make("feed-unmount-branch")
      const base = createMockRuntime()
      const forked: Array<Fiber.Fiber<unknown, unknown>> = []
      const runtime: GentRuntime = {
        ...base,
        fork: (effect) => {
          const fiber = base.fork(effect)
          forked.push(fiber)
          return fiber
        },
      }
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        useSessionFeed(
          () => sessionId,
          () => branchId,
          feedClientStub({
            sessionIdentity: identityOf(active),
            // The feed waits on its snapshot forever: only an interrupt ends it.
            client: createMockClient({ session: { getSnapshot: () => Effect.never } }),
            runtime,
          }),
          {
            onInteraction: () => {},
            onInteractionDismissed: () => {},
            onQueueSnapshot: () => {},
            onBranchSwitch: () => {},
          },
        )
        return disposeRoot
      })
      expect(forked.length).toBe(1)
      dispose()
      const exits = yield* Effect.forEach(forked, (fiber) => Fiber.await(fiber))
      expect(exits.map(Exit.hasInterrupts)).toEqual([true])
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.live("changes route when a branch event changes the active client identity", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("branch-navigation-session")
      const branchId = BranchId.make("branch-navigation-first")
      const nextBranchId = BranchId.make("branch-navigation-second")
      const switched = yield* Deferred.make<void>()
      let snapshotCount = 0
      const dispose = createRoot((disposeRoot) => {
        const [active, setActive] = createSignal(makeSession(sessionId, branchId))
        const runtime = createMockRuntime()
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(
                    makeEnvelope(
                      1,
                      AgentEvent.cases.BranchSwitched.make({
                        sessionId,
                        fromBranchId: branchId,
                        toBranchId: nextBranchId,
                      }),
                    ),
                  ),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime,
          applySessionSnapshot: () => {
            snapshotCount += 1
            setActive(makeSession(sessionId, branchId))
          },
          applySessionEvent: () => setActive(makeSession(sessionId, nextBranchId)),
        })
        useSessionFeed(
          () => sessionId,
          () => branchId,
          client,
          {
            onInteraction: () => {},
            onInteractionDismissed: () => {},
            onQueueSnapshot: () => {},
            onBranchSwitch: (nextSession, nextBranch) => {
              expect(nextSession).toBe(sessionId)
              expect(nextBranch).toBe(nextBranchId)
              runtime.cast(Deferred.succeed(switched, void 0))
            },
          },
        )
        return disposeRoot
      })
      yield* Deferred.await(switched).pipe(
        Effect.timeout("1 second"),
        Effect.ensuring(Effect.sync(dispose)),
      )
      expect(snapshotCount).toBe(1)
    }),
  )

  /**
   * Mount a feed on a test clock whose events stream delivers `served` and
   * then fails, while the runtime watch delivers its current state and stays
   * open. Answers the test-clock time of the first five snapshot fetches and
   * the most runtime watches open at once.
   */
  const failingFeedFetches = (served: ReadonlyArray<EventEnvelope>) =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-hot-loop")
      const branchId = BranchId.make("branch-feed-hot-loop")
      const fetches: Array<number> = []
      let openWatches = 0
      let mostWatches = 0
      let watchDelivered = yield* Deferred.make<void>()
      // The feed runs on a test clock, so the backoff runs in test time.
      const clock = yield* TestClock.make()
      const withClock = createMockRuntime(new Map([[Clock.Clock.key, clock]]))
      const runtime: GentRuntime = {
        ...createMockRuntime(),
        cast: withClock.cast,
        fork: withClock.fork,
      }
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () =>
                Effect.gen(function* () {
                  fetches.push(yield* Clock.currentTimeMillis)
                  watchDelivered = yield* Deferred.make<void>()
                  return snapshotFor(sessionId, branchId)
                }),
              // The events stream fails once the watch delivered, as a
              // decode failure does on a live connection.
              events: () =>
                Stream.concat(
                  Stream.fromEffect(Deferred.await(watchDelivered)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromIterable(served)),
                  ),
                  Stream.fail(
                    new RpcClientError({
                      reason: new RpcClientDefect({
                        message: "Error decoding message",
                        cause: "bad frame",
                      }),
                    }),
                  ),
                ),
              watchRuntime: () =>
                Stream.make(runtimeSnapshot()).pipe(
                  Stream.concat(
                    Stream.fromEffect(Deferred.succeed(watchDelivered, void 0)).pipe(Stream.drain),
                  ),
                  Stream.concat(Stream.never),
                  Stream.onStart(
                    Effect.sync(() => {
                      openWatches += 1
                      mostWatches = Math.max(mostWatches, openWatches)
                    }),
                  ),
                  Stream.ensuring(Effect.sync(() => (openWatches -= 1))),
                ),
            },
          }),
          runtime,
        })
        useSessionFeed(
          () => sessionId,
          () => branchId,
          client,
          {
            onInteraction: () => {},
            onInteractionDismissed: () => {},
            onQueueSnapshot: () => {},
            onBranchSwitch: () => {},
          },
        )
        return disposeRoot
      })
      yield* waitUntilAdvancing(
        clock.adjust("1 second"),
        () => fetches.length >= 5,
        "five snapshot fetches",
        3_000,
      ).pipe(Effect.ensuring(Effect.sync(dispose)))
      return { fetches: fetches.slice(0, 5), mostWatches }
    })

  // A feed that fails right after it opens (an envelope the client cannot
  // decode, a failing branch stream) never served, so it backs off instead
  // of refetching the snapshot every second.
  it.scopedLive("a feed that fails before its replay arrives backs off", () =>
    Effect.gen(function* () {
      const { fetches, mostWatches } = yield* failingFeedFetches([])
      // Unserved attempts back off 1 s, 2 s, 4 s, 8 s.
      expect(fetches).toEqual([0, 1_000, 3_000, 7_000, 15_000])
      // Each attempt's runtime watch closes with it.
      expect(mostWatches).toBe(1)
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a feed that served its replay retries a second after it drops", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-hot-loop")
      const branchId = BranchId.make("branch-feed-hot-loop")
      const { fetches } = yield* failingFeedFetches([
        makeEnvelope(
          0,
          AgentEvent.cases.StreamSynchronized.make({
            sessionId,
            branchId,
            lastEventId: EventId.make(0),
          }),
        ),
      ])
      // Each attempt served, so each drop starts a fresh sequence.
      expect(fetches).toEqual([0, 1_000, 2_000, 3_000, 4_000])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("displays repeated events and resumed tool calls once with their final status", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-duplicates")
      const branchId = BranchId.make("branch-feed-duplicates")
      const toolCallId = ToolCallId.make("tool-call-feed-duplicates")
      const messageEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.MessageReceived.make({ message: makeUserMessage(sessionId, branchId) }),
      )
      const streamStartedEnvelope = makeEnvelope(
        2,
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId }),
      )
      const streamChunkEnvelope = makeEnvelope(
        3,
        AgentEvent.cases.StreamChunk.make({
          sessionId,
          branchId,
          chunk: "assistant text",
        }),
      )
      const toolStartedEnvelope = makeEnvelope(
        4,
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "bash",
          input: { command: "printf hi" },
        }),
        10_000,
      )
      const toolSucceededEnvelope = makeEnvelope(
        6,
        AgentEvent.cases.ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "bash",
          summary: "printed hi",
          output: "hi",
        }),
        11_200,
      )
      const streamEndedEnvelope = makeEnvelope(
        7,
        AgentEvent.cases.StreamEnded.make({
          sessionId,
          branchId,
          outcome: "ToolCalls",
          costUsd: 0.01,
        }),
      )
      const turnCompletedEnvelope = makeEnvelope(
        8,
        AgentEvent.cases.TurnCompleted.make({
          sessionId,
          branchId,
          durationMs: 1_000,
        }),
      )
      const retryEnvelope = makeEnvelope(
        9,
        AgentEvent.cases.ProviderRetrying.make({
          sessionId,
          branchId,
          attempt: 1,
          maxAttempts: 3,
          delayMs: 100,
          error: "temporary provider failure",
        }),
      )
      const errorEnvelope = makeEnvelope(
        10,
        AgentEvent.cases.ErrorOccurred.make({
          sessionId,
          branchId,
          error: "provider failed",
        }),
      )
      const uniqueEnvelopes = [
        messageEnvelope,
        streamStartedEnvelope,
        streamChunkEnvelope,
        toolStartedEnvelope,
        makeEnvelope(5, toolStartedEnvelope.event),
        toolSucceededEnvelope,
        streamEndedEnvelope,
        turnCompletedEnvelope,
        retryEnvelope,
        errorEnvelope,
      ]
      const errorSeen = yield* Deferred.make<void>()
      let appliedEvents = 0
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()

      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(...uniqueEnvelopes.flatMap((envelope) => [envelope, envelope])),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          log: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: (message: string) => {
              if (message === "sessionFeed.error")
                client.runtime.cast(Deferred.succeed(errorSeen, void 0))
            },
          },
          applySessionEvent: () => {
            appliedEvents += 1
          },
        })

        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* Deferred.await(errorSeen)
      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value.messages().some((message) => message.role === "assistant") &&
          feed.value.items().some((item) => item._tag === "error"),
      )
      yield* Effect.sync(() => {
        if (Option.isNone(feed)) return
        const messages = feed.value.messages()
        const userMessages = messages.filter((message) => message.role === "user")
        const assistantMessage = messages.find((message) => message.role === "assistant")
        const events = feed.value.items().filter(isSessionEvent)
        expect(appliedEvents).toBe(uniqueEnvelopes.length)
        expect(userMessages).toHaveLength(1)
        expect(assistantMessage?.content).toBe("assistant text")
        expect(toolCallsOf(Option.fromUndefinedOr(assistantMessage))).toHaveLength(1)
        expect(toolCallsOf(Option.fromUndefinedOr(assistantMessage))[0]?.status).toBe("completed")
        // The duration is the gap between the started and terminal envelope times.
        expect(toolCallsOf(Option.fromUndefinedOr(assistantMessage))[0]?.durationMs).toBe(1_200)
        const toolSegments = assistantMessage?.segments?.filter(
          (segment) => segment._tag === "tool-call",
        )
        expect(toolSegments).toHaveLength(1)
        expect(toolSegments?.[0]?.toolCall.status).toBe("completed")
        expect(toolSegments?.[0]?.toolCall.durationMs).toBe(1_200)
        expect(events.map((event) => event._tag)).toEqual(["turn-ended", "retrying", "error"])
        // The single StreamEnded before TurnCompleted is the turn's only step.
        expect(events[0]).toMatchObject({
          _tag: "turn-ended",
          steps: { count: 1, toolCalls: 1, costUsd: 0.01 },
        })
        // The retry ran and failed; the error row says how the turn ended.
        const retry = events.find((event) => event._tag === "retrying")
        expect(retry?._tag === "retrying" && retry.outcome).toBe("retried")
        dispose()
      })
    }),
  )

  it.live("a notice draws a notice row, not an error row", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("notice-session")
      const branchId = BranchId.make("notice-branch")
      const envelopes = [
        makeEnvelope(
          1,
          AgentEvent.cases.ProviderRetrying.make({
            sessionId,
            branchId,
            attempt: 1,
            maxAttempts: 3,
            delayMs: 100,
            error: "temporary provider failure",
          }),
        ),
        makeEnvelope(
          2,
          AgentEvent.cases.ErrorOccurred.make({
            sessionId,
            branchId,
            error: "compaction fell back to a trimmed window",
            notice: true,
          }),
        ),
      ]
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () => Stream.concat(Stream.make(...envelopes), Stream.never),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
        })
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })
      yield* waitUntil(
        () => Option.isSome(feed) && feed.value.items().some((item) => item._tag === "notice"),
      )
      yield* Effect.sync(() => {
        if (Option.isNone(feed)) return
        const events = feed.value
          .items()
          .filter(Predicate.or(isSessionEvent, Predicate.isTagged("notice")))
        expect(events.map((event) => event._tag)).toEqual(["retrying", "notice"])
        const notice = events[1]
        expect(notice?._tag === "notice" && notice.text).toBe(
          "compaction fell back to a trimmed window",
        )
        dispose()
      })
    }),
  )

  it.live("a retry row sits above the answer of the attempt it waited for, and says why", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("retry-order-session")
      const branchId = BranchId.make("retry-order-branch")
      // The step opens its answer, the first attempt fails, and the retry answers.
      const envelopes = [
        makeEnvelope(1, AgentEvent.cases.StreamStarted.make({ sessionId, branchId })),
        makeEnvelope(
          2,
          AgentEvent.cases.ProviderRetrying.make({
            sessionId,
            branchId,
            attempt: 1,
            maxAttempts: 3,
            delayMs: 2_000,
            error: "overloaded (529)\nretry-after: 2",
          }),
        ),
        makeEnvelope(
          3,
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "the answer" }),
        ),
      ]
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () => Stream.concat(Stream.make(...envelopes), Stream.never),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
        })
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })
      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value.messages().some((message) => message.content === "the answer"),
      )
      yield* Effect.sync(() => {
        if (Option.isNone(feed)) return
        const items = feed.value.items()
        expect(items.map((item) => item._tag)).toEqual(["retrying", "regular-message"])
        const retry = items[0]
        if (retry?._tag !== "retrying") return
        // The answer streams, so the retry ran; its row names the provider's reason.
        expect(retry.outcome).toBe("retried")
        expect(getSessionEventLabel(retry)).toBe("Retried 1/3 · overloaded (529)")
        dispose()
      })
    }).pipe(Effect.timeout("4 seconds")),
  )

  /** The retry row a feed shows once a cancel during the backoff ended the turn. */
  const retryRowAfterBackoffCancel = (lastEventId: Option.Option<number>) =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("retry-cancel-session")
      const branchId = BranchId.make("retry-cancel-branch")
      // Core ends the cut stream before it completes the turn.
      const envelopes = [
        makeEnvelope(1, AgentEvent.cases.StreamStarted.make({ sessionId, branchId })),
        makeEnvelope(
          2,
          AgentEvent.cases.ProviderRetrying.make({
            sessionId,
            branchId,
            attempt: 1,
            maxAttempts: 3,
            delayMs: 2_000,
            error: "overloaded (529)",
          }),
        ),
        makeEnvelope(
          3,
          AgentEvent.cases.StreamEnded.make({
            sessionId,
            branchId,
            interrupted: true,
            outcome: "Interrupted",
          }),
        ),
        makeEnvelope(
          4,
          AgentEvent.cases.TurnCompleted.make({
            sessionId,
            branchId,
            durationMs: 1_000,
            interrupted: true,
          }),
        ),
      ]
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () =>
                Effect.succeed(
                  snapshotFor(sessionId, branchId, Option.getOrUndefined(lastEventId)),
                ),
              events: () => Stream.concat(Stream.make(...envelopes), Stream.never),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
        })
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })
      yield* waitUntil(
        () =>
          Option.isSome(feed) && feed.value.items().some((item) => item._tag === "interruption"),
      )
      const retry = Option.flatMap(feed, (value) =>
        Option.fromNullishOr(value.items().find((item) => item._tag === "retrying")),
      )
      dispose()
      return retry
    })

  it.live("a cancel during the backoff reads cancelled, live and on replay", () =>
    Effect.gen(function* () {
      for (const lastEventId of [Option.none<number>(), Option.some(4)]) {
        const retry = yield* retryRowAfterBackoffCancel(lastEventId)
        expect(Option.isSome(retry)).toBe(true)
        if (Option.isNone(retry) || retry.value._tag !== "retrying") continue
        expect(getSessionEventLabel(retry.value)).toBe("Retry 1/3 cancelled · overloaded (529)")
      }
    }).pipe(Effect.timeout("4 seconds")),
  )

  const expectNestedCellOperation = (
    feed: ReturnType<typeof useSessionFeed>,
    innerId: ToolCallId,
  ) => {
    const assistant = feed.messages().find((message) => message.role === "assistant")
    // The inner read is not a transcript sibling of the cell.
    expect(toolCallsOf(Option.fromUndefinedOr(assistant)).map((call) => call.toolName)).toEqual([
      "cell",
    ])
    const operation = toolCallsOf(Option.fromUndefinedOr(assistant))[0]?.operations?.[0]
    expect(toolCallsOf(Option.fromUndefinedOr(assistant))[0]?.operations).toHaveLength(1)
    expect(operation?.id).toBe(innerId)
    expect(operation?.toolName).toBe("read")
    expect(operation?.status).toBe("error")
    expect(operation?.summary).toBe("missing file")
    const segment = assistant?.segments?.find((entry) => entry._tag === "tool-call")
    expect(segment?._tag === "tool-call" && segment.toolCall.operations?.[0]?.status).toBe("error")
    expect(feed.activeTool()).toBeUndefined()
  }

  const cellNestingEnvelopes = (
    sessionId: SessionId,
    branchId: BranchId,
    cellId: ToolCallId,
    innerId: ToolCallId,
  ): EventEnvelope[] => [
    makeEnvelope(1, AgentEvent.cases.StreamStarted.make({ sessionId, branchId })),
    makeEnvelope(
      2,
      AgentEvent.cases.ToolCallStarted.make({
        sessionId,
        branchId,
        toolCallId: cellId,
        toolName: "cell",
        input: { code: "await tools.read({path: 'a.txt'})" },
      }),
    ),
    makeEnvelope(
      3,
      AgentEvent.cases.ToolCallStarted.make({
        sessionId,
        branchId,
        toolCallId: innerId,
        toolName: "read",
        input: { path: "a.txt" },
        parentToolCallId: cellId,
      }),
    ),
    makeEnvelope(
      4,
      AgentEvent.cases.ToolCallFailed.make({
        sessionId,
        branchId,
        toolCallId: innerId,
        toolName: "read",
        summary: "missing file",
        parentToolCallId: cellId,
      }),
    ),
    makeEnvelope(
      5,
      AgentEvent.cases.ToolCallSucceeded.make({
        sessionId,
        branchId,
        toolCallId: cellId,
        toolName: "cell",
        summary: "done",
        output: "{}",
      }),
    ),
    makeEnvelope(6, AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 1 })),
  ]

  it.live("nests cell-admitted tool calls under their cell with final status", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-cell")
      const branchId = BranchId.make("branch-feed-cell")
      const cellId = ToolCallId.make("tool-call-cell")
      const innerId = ToolCallId.make("tool-call-cell-read")
      const envelopes = cellNestingEnvelopes(sessionId, branchId, cellId, innerId)
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () => Stream.concat(Stream.make(...envelopes), Stream.never),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
        })
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value
            .messages()
            .some(
              (message) => toolCallsOf(Option.fromUndefinedOr(message))[0]?.status === "completed",
            ),
      )
      yield* Effect.sync(() => {
        if (Option.isNone(feed)) return
        expectNestedCellOperation(feed.value, innerId)
        dispose()
      })
    }),
  )

  /** A feed over one snapshot and a live event stream. */
  const openFeed = (snapshot: SessionSnapshot, envelopes: ReadonlyArray<EventEnvelope>) => {
    let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
    const dispose = createRoot((disposeRoot) => {
      const [active] = createSignal(makeSession(snapshot.sessionId, snapshot.branchId))
      const client = feedClientStub({
        sessionIdentity: identityOf(active),
        client: createMockClient({
          session: {
            getSnapshot: () => Effect.succeed(snapshot),
            events: () => Stream.concat(Stream.make(...envelopes), Stream.never),
            watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
          },
        }),
        runtime: createMockRuntime(),
      })
      feed = Option.some(
        useSessionFeed(
          () => snapshot.sessionId,
          () => snapshot.branchId,
          client,
          {
            onInteraction: () => {},
            onInteractionDismissed: () => {},
            onBranchSwitch: () => {},
            onQueueSnapshot: () => {},
          },
        ),
      )
      return disposeRoot
    })
    const cellOf = () =>
      Option.flatMap(feed, (value) =>
        Option.fromNullishOr(
          toolCallsOf(
            Option.fromUndefinedOr(
              value.messages().find((message) => message.role === "assistant"),
            ),
          )[0],
        ),
      )
    const activeTool = () =>
      Option.flatMap(feed, (value) => Option.fromUndefinedOr(value.activeTool()))
    return { cellOf, activeTool, dispose }
  }

  it.live("a cell's running ops show side by side while one of them waits", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-sibling-ops")
      const branchId = BranchId.make("branch-feed-sibling-ops")
      const cellId = ToolCallId.make("tool-call-sibling-cell")
      const opStarted = (id: string, command: string) =>
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make(id),
          toolName: "bash",
          input: { command },
          parentToolCallId: cellId,
        })
      const { activeTool, dispose } = openFeed(snapshotFor(sessionId, branchId), [
        makeEnvelope(1, AgentEvent.cases.StreamStarted.make({ sessionId, branchId })),
        makeEnvelope(
          2,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: cellId,
            toolName: "cell",
            input: { code: "await Promise.all([tools.bash(a), tools.bash(b)])" },
          }),
        ),
        makeEnvelope(3, opStarted("tool-call-ticks", "sleep 2; echo SLEPT")),
        makeEnvelope(4, opStarted("tool-call-asks", "git checkout HEAD -- README.md")),
      ])
      yield* waitUntil(() =>
        Option.exists(activeTool(), (label) => label.includes("git checkout")),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            // The asking op does not hide the one that runs on; the cell waits on both.
            const label = Option.getOrElse(activeTool(), () => "")
            expect(label).toContain("sleep 2")
            expect(label).toContain("git checkout")
            expect(label).not.toContain("cell")
          }),
        ),
        Effect.ensuring(Effect.sync(dispose)),
      )
    }),
  )

  it.live("a running read names its file from the cwd, as its row does", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-running-read")
      const branchId = BranchId.make("branch-feed-running-read")
      const { activeTool, dispose } = openFeed(snapshotFor(sessionId, branchId), [
        makeEnvelope(1, AgentEvent.cases.StreamStarted.make({ sessionId, branchId })),
        makeEnvelope(
          2,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("tool-call-running-read"),
            toolName: "read",
            input: { path: "/work/proj/src/app.tsx" },
          }),
        ),
      ])
      yield* waitUntil(() => Option.isSome(activeTool())).pipe(
        Effect.andThen(
          Effect.sync(() =>
            expect(Option.getOrElse(activeTool(), () => "")).toBe("read(src/app.tsx)"),
          ),
        ),
        Effect.ensuring(Effect.sync(dispose)),
      )
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("an op still running when its cell fails reads as failed, as a reload draws it", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-interrupted-cell")
      const branchId = BranchId.make("branch-feed-interrupted-cell")
      const cellId = ToolCallId.make("tool-call-interrupted-cell")
      const opId = ToolCallId.make("tool-call-interrupted-op")
      const { cellOf, dispose } = openFeed(snapshotFor(sessionId, branchId), [
        makeEnvelope(1, AgentEvent.cases.StreamStarted.make({ sessionId, branchId })),
        makeEnvelope(
          2,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: cellId,
            toolName: "cell",
            input: { code: "await tools.bash({command: 'sleep 60'})" },
          }),
        ),
        makeEnvelope(
          3,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: opId,
            toolName: "bash",
            input: { command: "sleep 60" },
            parentToolCallId: cellId,
          }),
        ),
        makeEnvelope(
          4,
          AgentEvent.cases.ToolCallFailed.make({
            sessionId,
            branchId,
            toolCallId: cellId,
            toolName: "cell",
            summary: "The tool did not finish: the turn was interrupted.",
          }),
        ),
      ])
      yield* waitUntil(() => Option.exists(cellOf(), (cell) => cell.status === "error")).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const cell = Option.getOrUndefined(cellOf())
            expect(cell?.operations?.map((operation) => operation.status)).toEqual(["error"])
          }),
        ),
        Effect.ensuring(Effect.sync(dispose)),
      )
    }),
  )

  it.live("a live result on a reloaded op drops the cuts of the output it replaces", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-stale-cuts")
      const branchId = BranchId.make("branch-feed-stale-cuts")
      const cellId = ToolCallId.make("tool-call-stale-cuts-cell")
      const opId = ToolCallId.make("tool-call-stale-cuts-op")
      const cutOperation: NonNullable<ToolInteraction["operations"]>[number] = {
        id: opId,
        toolName: "bash",
        status: "running",
        input: { command: "seq 3000" },
        summary: absent,
        output: '{"stdout":"1\\n…\\n3000","stderr":"","exitCode":0}',
        durationMs: absent,
        cuts: [
          OutputCut.cases.Text.make({ field: "stdout", lines: 3000, tailLine: 3000, chars: 9 }),
        ],
      }
      const snapshot: SessionSnapshot = {
        ...snapshotFor(sessionId, branchId, 1),
        messages: [
          projectMessage(
            Message.cases.regular.make({
              id: MessageId.make("stale-cuts-assistant"),
              sessionId,
              branchId,
              role: "assistant",
              // A stored interaction projects from the call part the assistant wrote.
              parts: [
                Prompt.textPart({ text: "" }),
                Prompt.toolCallPart({
                  id: cellId,
                  name: "cell",
                  params: {},
                  providerExecuted: false,
                }),
              ],
              createdAt: dateFromMillis(0),
            }),
            [
              new ToolInteraction({
                id: cellId,
                toolName: "cell",
                status: "running",
                input: {},
                summary: absent,
                output: absent,
                durationMs: absent,
                operations: [cutOperation],
              }),
            ],
          ),
        ],
      }
      const wholeOutput = '{"stdout":"done","stderr":"","exitCode":0}'
      const { cellOf, dispose } = openFeed(snapshot, [
        makeEnvelope(
          2,
          AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId: opId,
            toolName: "bash",
            summary: "exit 0 · 1 line",
            output: wholeOutput,
            parentToolCallId: cellId,
          }),
        ),
      ])
      yield* waitUntil(() =>
        Option.exists(cellOf(), (cell) => cell.operations?.[0]?.status === "completed"),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const operation = Option.getOrUndefined(cellOf())?.operations?.[0]
            expect(operation?.output).toBe(wholeOutput)
            expect(operation?.cuts).toBeUndefined()
          }),
        ),
        Effect.ensuring(Effect.sync(dispose)),
      )
    }),
  )

  it.live("replays buffered event-only state before the snapshot cursor", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-buffered")
      const branchId = BranchId.make("branch-feed-buffered")
      const extensionId = ExtensionId.make("buffered-extension")
      const bufferedPulse = makeEnvelope(
        1,
        AgentEvent.cases.ExtensionStateChanged.make({ sessionId, branchId, extensionId }),
      )
      const bufferedInteraction = makeEnvelope(
        2,
        AgentEvent.cases.InteractionPresented.make({
          sessionId,
          branchId,
          requestId: InteractionRequestId.make("interaction-buffered"),
          text: "approve this",
          metadata: absent,
        }),
      )
      const bufferedBranchSwitch = makeEnvelope(
        3,
        AgentEvent.cases.BranchSwitched.make({
          sessionId,
          fromBranchId: branchId,
          toBranchId: BranchId.make("historical-other-branch"),
        }),
      )
      const liveEvent = makeEnvelope(
        4,
        AgentEvent.cases.TurnCompleted.make({ sessionId, branchId, durationMs: 1 }),
      )
      const interactionSeen = yield* Deferred.make<ActiveInteraction>()
      const liveSeen = yield* Deferred.make<void>()
      let requestedAfter: Option.Option<number> = Option.none()
      const bufferedTags: string[] = []
      const branchSwitches: Array<{ sessionId: SessionId; branchId: BranchId }> = []

      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId, 3)),
              events: ({ after }: { readonly after?: number }) => {
                requestedAfter = Option.fromNullishOr(after)
                return Stream.concat(
                  Stream.make(bufferedPulse, bufferedInteraction, bufferedBranchSwitch, liveEvent),
                  Stream.never,
                )
              },
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          applySessionEvent: (envelope) => {
            if (envelope.id === liveEvent.id)
              client.runtime.cast(Deferred.succeed(liveSeen, void 0))
          },
          applyBufferedSessionEvent: (envelope) => {
            bufferedTags.push(envelope.event._tag)
          },
        })

        useSessionFeed(
          () => sessionId,
          () => branchId,
          client,
          {
            onInteraction: (interaction) => {
              client.runtime.cast(Deferred.succeed(interactionSeen, interaction))
            },
            onInteractionDismissed: () => {},
            onBranchSwitch: (nextSessionId, nextBranchId) => {
              branchSwitches.push({ sessionId: nextSessionId, branchId: nextBranchId })
            },
            onQueueSnapshot: () => {},
          },
        )
        return disposeRoot
      })

      const interaction = yield* Deferred.await(interactionSeen)
      yield* Deferred.await(liveSeen)
      yield* Effect.sync(() => {
        expect(Option.getOrElse(requestedAfter, () => -1)).toBe(0)
        expect(bufferedTags).toEqual(["ExtensionStateChanged", "InteractionPresented"])
        expect(interaction.requestId).toBe(InteractionRequestId.make("interaction-buffered"))
        expect(branchSwitches).toEqual([])
        dispose()
      })
    }),
  )

  for (const saved of [false, true]) {
    it.live(`keeps answers and tools with their owning message (saved: ${saved})`, () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-feed-compaction-live")
        const branchId = BranchId.make("branch-feed-compaction-live")
        const inputId = MessageId.make("first-input")
        const nextInputId = MessageId.make("follow-up-input")
        const toolCallId = ToolCallId.make("first-stream-tool")
        const events = [
          AgentEvent.cases.StreamStarted.make({ sessionId, branchId, messageId: inputId, step: 1 }),
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "First " }),
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "answer" }),
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId,
            toolName: "cell",
            input: {},
          }),
          AgentEvent.cases.StreamEnded.make({ sessionId, branchId }),
          AgentEvent.cases.StreamStarted.make({ sessionId, branchId, messageId: inputId, step: 2 }),
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "Next step" }),
          AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId,
            toolName: "cell",
            summary: "done",
            output: "result",
          }),
          AgentEvent.cases.TurnCompleted.make({
            sessionId,
            branchId,
            messageId: inputId,
            durationMs: 0,
          }),
          AgentEvent.cases.StreamStarted.make({
            sessionId,
            branchId,
            messageId: nextInputId,
            step: 1,
          }),
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "Follow-up " }),
          AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "answer" }),
          AgentEvent.cases.TurnCompleted.make({
            sessionId,
            branchId,
            messageId: nextInputId,
            durationMs: 0,
          }),
        ]
        // The snapshot projects a cell's operations from the branch's stored receipts.
        const savedOperation: NonNullable<ToolInteraction["operations"]>[number] = {
          id: ToolCallId.make("saved-read-op"),
          toolName: "read",
          status: "completed",
          input: { path: "a.md" },
          summary: "3 lines",
          output: "one",
          durationMs: 30,
        }
        let snapshot = snapshotFor(sessionId, branchId)
        if (saved) {
          const messages = [
            { id: assistantMessageIdForTurn(inputId, 1), text: "First answer" },
            { id: assistantMessageIdForTurn(inputId, 2), text: "Next step" },
            { id: assistantMessageIdForTurn(nextInputId, 1), text: "Follow-up answer" },
          ].map(({ id, text }, index) => {
            const calls: ToolInteraction[] = []
            if (index === 0)
              calls.push(
                new ToolInteraction({
                  id: toolCallId,
                  toolName: "cell",
                  status: "completed",
                  input: {},
                  summary: "done",
                  output: "result",
                  durationMs: 1_200,
                  operations: [savedOperation],
                }),
              )
            // A stored interaction projects from the call part the assistant wrote.
            const parts: Array<Prompt.Part> = [Prompt.textPart({ text })]
            if (calls.length > 0)
              parts.push(
                Prompt.toolCallPart({
                  id: toolCallId,
                  name: "cell",
                  params: {},
                  providerExecuted: false,
                }),
              )
            return projectMessage(
              Message.cases.regular.make({
                id,
                sessionId,
                branchId,
                role: "assistant",
                parts,
                createdAt: dateFromMillis(index),
              }),
              calls,
            )
          })
          snapshot = { ...snapshot, lastEventId: events.length, messages }
        }
        let applied = 0
        let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
        const dispose = createRoot((disposeRoot) => {
          const [active] = createSignal(makeSession(sessionId, branchId))
          const client = feedClientStub({
            sessionIdentity: identityOf(active),
            client: createMockClient({
              session: {
                getSnapshot: () => Effect.succeed(snapshot),
                events: () =>
                  Stream.concat(
                    Stream.make(
                      ...events.map((event, index) => makeEnvelope(index + 1, event, index * 300)),
                    ),
                    Stream.never,
                  ),
                watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
              },
            }),
            runtime: createMockRuntime(),
            applySessionEvent: () => {
              applied += 1
            },
            applyBufferedSessionEvent: () => {
              applied += 1
            },
          })
          feed = Option.some(
            useSessionFeed(
              () => sessionId,
              () => branchId,
              client,
              {
                onInteraction: () => {},
                onInteractionDismissed: () => {},
                onBranchSwitch: () => {},
                onQueueSnapshot: () => {},
              },
            ),
          )
          return disposeRoot
        })

        yield* waitUntil(
          () =>
            applied === events.length &&
            Option.isSome(feed) &&
            feed.value.messages().some((message) => message.content.includes("Follow-up answer")),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (Option.isNone(feed)) return
              const messages = feed.value.messages()
              expect(messages.map((message) => message.content)).toEqual([
                "First answer",
                "Next step",
                "Follow-up answer",
              ])
              expect(messages.map((message) => message.id)).toEqual([
                assistantMessageIdForTurn(inputId, 1),
                assistantMessageIdForTurn(inputId, 2),
                assistantMessageIdForTurn(nextInputId, 1),
              ])
              expect(toolCallsOf(Option.fromUndefinedOr(messages[0]))[0]?.status).toBe("completed")
              // A saved interaction keeps the duration the snapshot projected from receipts.
              expect(toolCallsOf(Option.fromUndefinedOr(messages[0]))[0]?.durationMs).toBe(1_200)
              if (saved) {
                // After a reload the cell draws its operations, not only its receipts.
                expect(toolCallsOf(Option.fromUndefinedOr(messages[0]))[0]?.operations).toEqual([
                  savedOperation,
                ])
              }
              expect(toolCallsOf(Option.fromUndefinedOr(messages[1]))).toEqual([])
              expect(toolCallsOf(Option.fromUndefinedOr(messages[2]))).toEqual([])
            }),
          ),
          Effect.ensuring(Effect.sync(dispose)),
        )
      }),
    )
  }

  it.live("starts a late tool call on the message the event names, not the newest one", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-late-tool")
      const branchId = BranchId.make("branch-feed-late-tool")
      const inputId = MessageId.make("late-tool-input")
      const firstAnswerId = assistantMessageIdForTurn(inputId, 1)
      const secondAnswerId = assistantMessageIdForTurn(inputId, 2)
      const lateToolCallId = ToolCallId.make("late-tool-call")
      const events = [
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId, messageId: inputId, step: 1 }),
        AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "First answer" }),
        AgentEvent.cases.StreamEnded.make({ sessionId, branchId }),
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId, messageId: inputId, step: 2 }),
        AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk: "Second answer" }),
        // The first step's tool receipt arrives after the second step began.
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: lateToolCallId,
          toolName: "read",
          input: {},
          assistantMessageId: firstAnswerId,
        }),
      ]
      let applied = 0
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(
                    ...events.map((event, index) => makeEnvelope(index + 1, event, index * 100)),
                  ),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
          applySessionEvent: () => {
            applied += 1
          },
          applyBufferedSessionEvent: () => {
            applied += 1
          },
        })
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* waitUntil(
        () =>
          applied === events.length &&
          Option.isSome(feed) &&
          feed.value.messages().length === 2 &&
          feed.value
            .messages()
            .some((message) => toolCallsOf(Option.fromUndefinedOr(message)).length > 0),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (Option.isNone(feed)) return
            const messages = feed.value.messages()
            const first = messages.find((message) => message.id === firstAnswerId)
            const second = messages.find((message) => message.id === secondAnswerId)
            expect(toolCallsOf(Option.fromUndefinedOr(first)).map((call) => call.id)).toEqual([
              lateToolCallId,
            ])
            expect(toolCallsOf(Option.fromUndefinedOr(second))).toEqual([])
          }),
        ),
        Effect.ensuring(Effect.sync(dispose)),
      )
    }),
  )

  it.live("shows a live compaction message as soon as its event arrives", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-compaction-live")
      const branchId = BranchId.make("branch-feed-compaction-live")
      const messageEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.MessageReceived.make({
          message: makeCompactionMessage(sessionId, branchId),
        }),
      )
      const streamStartedEnvelope = makeEnvelope(
        2,
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId }),
      )
      const streamChunkEnvelope = makeEnvelope(
        3,
        AgentEvent.cases.StreamChunk.make({
          sessionId,
          branchId,
          chunk: "native response",
        }),
      )
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(messageEnvelope, streamStartedEnvelope, streamChunkEnvelope),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
        })
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value.messages().some((message) => message.content.includes("native response")),
      )
      if (Option.isNone(feed)) return yield* Effect.die("feed did not initialize")
      expect(feed.value.messages()).toHaveLength(2)
      const summary = feed.value
        .messages()
        .find((message) => message.metadata?.customType === "context-window")
      const response = feed.value
        .messages()
        .find((message) => message.content.includes("native response"))
      expect(summary?.content).toBe("Context handoff: stored summary")
      expect(response?.id).toBeDefined()
      expect(response?.id).not.toBe(summary?.id)
      expect(response?.content).toBe("native response")
      dispose()
    }),
  )

  it.live("shows a live notice separately from later model output", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-compaction-live")
      const branchId = BranchId.make("branch-feed-compaction-live")
      const messageEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.MessageReceived.make({
          message: {
            ...makeCompactionMessage(sessionId, branchId),
            metadata: { customType: "prompt-present", hidden: true },
          },
        }),
      )
      const streamStartedEnvelope = makeEnvelope(
        2,
        AgentEvent.cases.StreamStarted.make({ sessionId, branchId }),
      )
      const streamChunkEnvelope = makeEnvelope(
        3,
        AgentEvent.cases.StreamChunk.make({
          sessionId,
          branchId,
          chunk: "native response",
        }),
      )
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () => Effect.succeed(snapshotFor(sessionId, branchId)),
              events: () =>
                Stream.concat(
                  Stream.make(messageEnvelope, streamStartedEnvelope, streamChunkEnvelope),
                  Stream.never,
                ),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
        })
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value.messages().some((message) => message.content.includes("native response")),
      )
      if (Option.isNone(feed)) return yield* Effect.die("feed did not initialize")
      expect(feed.value.messages()).toHaveLength(2)
      const summary = feed.value
        .messages()
        .find((message) => message.metadata?.customType === "prompt-present")
      const response = feed.value
        .messages()
        .find((message) => message.content.includes("native response"))
      expect(summary?.content).toBe("Context handoff: stored summary")
      expect(response?.id).toBeDefined()
      expect(response?.id).not.toBe(summary?.id)
      expect(response?.content).toBe("native response")
      dispose()
    }),
  )

  it.live("reconstructs retry history and completion state during reload", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-feed-compaction-reload")
      const branchId = BranchId.make("branch-feed-compaction-reload")
      const retryEnvelope = makeEnvelope(
        1,
        AgentEvent.cases.ProviderRetrying.make({
          sessionId,
          branchId,
          attempt: 1,
          maxAttempts: 3,
          delayMs: 100,
          error: "temporary provider failure",
        }),
      )
      const interruptedEnvelope = makeEnvelope(
        2,
        AgentEvent.cases.TurnCompleted.make({
          sessionId,
          branchId,
          durationMs: 1_000,
          interrupted: true,
        }),
      )
      // The handoff marker is a durable user message, so a reload reads it
      // from the snapshot rather than from the buffered event stream.
      let feed: Option.Option<ReturnType<typeof useSessionFeed>> = Option.none()
      const dispose = createRoot((disposeRoot) => {
        const [active] = createSignal(makeSession(sessionId, branchId))
        const client = feedClientStub({
          sessionIdentity: identityOf(active),
          client: createMockClient({
            session: {
              getSnapshot: () =>
                Effect.succeed({
                  ...snapshotFor(sessionId, branchId, 3),
                  messages: [projectMessage(makeCompactionMessage(sessionId, branchId), [])],
                }),
              events: () =>
                Stream.concat(Stream.make(retryEnvelope, interruptedEnvelope), Stream.never),
              watchRuntime: () => Stream.concat(Stream.make(runtimeSnapshot()), Stream.never),
            },
          }),
          runtime: createMockRuntime(),
        })
        feed = Option.some(
          useSessionFeed(
            () => sessionId,
            () => branchId,
            client,
            {
              onInteraction: () => {},
              onInteractionDismissed: () => {},
              onBranchSwitch: () => {},
              onQueueSnapshot: () => {},
            },
          ),
        )
        return disposeRoot
      })

      yield* waitUntil(
        () =>
          Option.isSome(feed) &&
          feed.value.items().some((item) => item._tag === "interruption") &&
          feed.value
            .messages()
            .some((message) => message.metadata?.customType === "context-window"),
      )
      if (Option.isNone(feed)) return yield* Effect.die("feed did not initialize")
      const retry = feed.value.items().find((item) => item._tag === "retrying")
      // The cancel cut the retry short: it did not finish.
      expect(retry?._tag === "retrying" && retry.outcome).toBe("cancelled")
      if (retry?._tag === "retrying") {
        expect(getSessionEventLabel(retry)).toBe("Retry 1/3 cancelled · temporary provider failure")
      }
      expect(feed.value.items().some((item) => item._tag === "interruption")).toBe(true)
      expect(feed.value.messages()[0]?.content).toContain("stored summary")
      dispose()
    }),
  )
})
