/** @jsxImportSource @opentui/solid */
import { DateTime, Deferred, Effect, Exit, Fiber, Option, Order, Schedule, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  type CliRenderer,
  type CliRendererExternalOutputEvent,
  SyntaxStyle,
  TextAttributes,
} from "@opentui/core"
import { describe, expect, it, test } from "effect-bun-test"
import {
  addRetry,
  addStep,
  currentMillis,
  emptyTurnSteps,
  flushTranscriptForExit,
  formatTurnLine,
  holdUntilRendererDestroyed,
  getSessionEventLabel,
  type Message as ListMessage,
  MessageList,
  NativeTranscript,
  promptOnScreen,
  readerPrompt,
  reasoningMarkdown,
  type AssistantSegment,
  type RetryOutcome,
  type SessionEvent,
  type SessionItem,
  splitFooterHeight,
  type ToolCall,
  transcriptFingerprint,
} from "../src/message-list"
import * as Prompt from "effect/ai/Prompt"
import {
  BranchId,
  dateFromMillis,
  Message,
  MessageId,
  MODEL_ATTEMPTS_MESSAGE_TYPE,
  MODEL_CHANGE_MESSAGE_TYPE,
  OutputCut,
  SessionId,
  ToolCallId,
  AgentEvent,
  EventEnvelope,
} from "@gent/core/protocol"
import {
  toolCallReceipts,
  projectMessagesWithToolInteractions,
  EventId,
} from "@gent/core/test-utils"
import {
  BTW_QUESTION_TYPE,
  CHILD_COMPLETION_TYPE,
  CHILD_TASK_TYPE,
  childTaskText,
  forkQuestionText,
  type SessionMessageDetails,
  sessionMessageText,
  THREAD_TASK_TYPE,
  threadTaskText,
} from "@gent/extensions/client"
import {
  batch,
  type ComponentProps,
  createSignal,
  For,
  mergeProps,
  onCleanup,
  Show,
  splitProps,
} from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { DisclosureLevel } from "../src/extensions/client-facets"
import { useTheme } from "../src/theme"
import { FrameClicks, ToolCallIdentityProvider, ToolFrame } from "../src/ui"
import {
  BUILTIN_TOOL_RENDERERS,
  FoldOperationsProvider,
  ToolRenderersProvider,
  EditToolRenderer,
  GenericToolRenderer,
  ReadToolRenderer,
  useToolRenderers,
} from "../src/tool-renderers"
import {
  destroyRenderSetup,
  renderFrame,
  renderScoped,
  TerminalOutput,
  terminalText,
} from "./render-harness-boundary"
import {
  highlightOutage,
  makeSettleHold,
  makeSettleTimeouts,
  refuseCommits,
} from "./scrollback-hold-boundary"
import { untilExtensionsLoaded, waitForFrame, waitForTerminal, waitUntil } from "./helpers-boundary"
import { useExtensionUI } from "../src/extensions/host"
import { makeHandover } from "../src/os"
import { builtinClientModules } from "../src/extensions/builtins"
import { clientContributions, defineClientExtension } from "../src/extensions/client-facets"

// ── split footer height ─────────────────────────────────────────────────────

/**
 * The split footer must always leave the terminal room to scroll.
 *
 * Scrollback only exists because committed rows scroll off the top of the
 * output region above the footer. OpenTUI derives that region from the footer
 * height, and the native commit turns it into a scroll region of
 * `ESC[1;<rows>r`. A footer that takes the whole screen leaves no region at
 * all, and a footer one row short leaves `ESC[1;1r`, which a terminal drops
 * rather than scrolls. Both spellings cost the reader the entire transcript:
 * measured on a 40-row terminal resuming a 23-step session, each gave 0 rows
 * of history where the fixed height gives 236.
 *
 * A tall live view is the case to hold: `liveHeight` grows with the streaming
 * reply, so the requested height passes the screen height long before the
 * reader notices. The heights below run to five times the screen.
 */

describe("split footer height", () => {
  it.effect("every requested height keeps a scrollable output region", () =>
    Effect.sync(() => {
      const terminalHeight = 40
      const requested = Array.from({ length: 200 }, (_, index) => index + 1)
      const regions = requested.map(
        (value) => terminalHeight - splitFooterHeight(terminalHeight, value),
      )
      // A region of 0 rows cannot be written and a region of 1 row cannot
      // scroll, so neither may ever be produced.
      expect(Math.min(...regions)).toBeGreaterThanOrEqual(2)
    }),
  )

  it.effect("a short footer is left alone", () =>
    Effect.sync(() => {
      expect(splitFooterHeight(40, 4)).toBe(4)
      expect(splitFooterHeight(40, 1)).toBe(1)
    }),
  )

  it.effect("a tiny terminal still reports a usable footer", () =>
    Effect.sync(() => {
      expect(splitFooterHeight(1, 10)).toBe(1)
      expect(splitFooterHeight(2, 10)).toBe(1)
      expect(splitFooterHeight(3, 10)).toBe(1)
    }),
  )
})

// ── reasoning text ──────────────────────────────────────────────────────────

/**
 * Reasoning summaries must read as separate lines.
 *
 * A model emits reasoning as a run of summaries, each its own bold markdown
 * heading, and `messagePartsReasoning` joins the parts with an empty string.
 * `reasoningMarkdown` splits the run into paragraphs, so the markdown element
 * draws each heading on its own line rather than one line with the asterisks
 * printed, as in:
 *
 *     **Verifying final test output****Refactoring LedgerStore.list…**
 */

describe("reasoning text", () => {
  it.effect("colliding summaries are split onto their own paragraphs", () =>
    Effect.sync(() => {
      const collided = "**Verifying final test output and diff summary****Refactoring LedgerStore**"
      expect(reasoningMarkdown(collided)).toBe(
        "**Verifying final test output and diff summary**\n\n**Refactoring LedgerStore**",
      )
    }),
  )

  it.effect("a run of three summaries keeps every one", () =>
    Effect.sync(() => {
      const collided = "**One****Two****Three**"
      expect(reasoningMarkdown(collided)).toBe("**One**\n\n**Two**\n\n**Three**")
    }),
  )

  it.effect("summaries already separated are left alone", () =>
    Effect.sync(() => {
      const spaced = "**One**\n\n**Two**"
      expect(reasoningMarkdown(spaced)).toBe(spaced)
    }),
  )

  it.effect("a single summary keeps its emphasis for markdown to render", () =>
    Effect.sync(() => {
      expect(reasoningMarkdown("**Only one**")).toBe("**Only one**")
    }),
  )

  it.effect("plain reasoning without emphasis passes through", () =>
    Effect.sync(() => {
      expect(reasoningMarkdown("thinking about the problem")).toBe("thinking about the problem")
    }),
  )

  it.effect("empty reasoning stays empty", () =>
    Effect.sync(() => {
      expect(reasoningMarkdown("")).toBe("")
    }),
  )
})

// ── session event indicator ─────────────────────────────────────────────────

describe("session event labels", () => {
  test("formats retrying progress", () => {
    const createdAt = 1_000
    const event: SessionEvent = {
      _tag: "retrying",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      outcome: "pending",
      reason: "overloaded (529)",
      createdAt,
      seq: 1,
    }

    expect(getSessionEventLabel(event, createdAt)).toBe("Retrying in 2s · 1/3 · overloaded (529)")
    expect(getSessionEventLabel(event, createdAt + 1_100)).toBe(
      "Retrying in 1s · 1/3 · overloaded (529)",
    )
    expect(getSessionEventLabel(event, createdAt + 2_000)).toBe(
      "Retrying now · 1/3 · overloaded (529)",
    )
    expect(getSessionEventLabel({ ...event, outcome: "retried" }, createdAt + 20_000)).toBe(
      "Retried 1/3 · overloaded (529)",
    )
    expect(getSessionEventLabel({ ...event, reason: "" }, createdAt)).toBe("Retrying in 2s · 1/3")
  })

  test("an error with a reset time names the wall-clock reset after its first line", () => {
    const utc = () => DateTime.zoneMakeOffset(0)
    const now = Date.parse("2026-10-04T12:00:00Z")
    const event: SessionEvent = {
      _tag: "error",
      error: "Rate limit exceeded\nThe usage limit has been reached",
      retryAt: Date.parse("2026-10-04T17:05:00Z"),
      createdAt: now,
      seq: 1,
    }
    expect(getSessionEventLabel(event, now, utc)).toBe(
      "Rate limit exceeded · resets 17:05\nThe usage limit has been reached",
    )
    const nextDay = { ...event, retryAt: Date.parse("2026-10-05T09:30:00Z") }
    expect(getSessionEventLabel(nextDay, now, utc)).toBe(
      "Rate limit exceeded · resets 2026-10-05 09:30\nThe usage limit has been reached",
    )
    // The wall clock is the viewer's zone, not UTC.
    expect(
      getSessionEventLabel(event, now, () => DateTime.zoneMakeOffset(2 * 60 * 60 * 1000)),
    ).toBe("Rate limit exceeded · resets 19:05\nThe usage limit has been reached")
    // A row with no reset never asks for the zone.
    let zoneReads = 0
    const counted = () => {
      zoneReads += 1
      return DateTime.zoneMakeOffset(0)
    }
    const plain: SessionEvent = { _tag: "error", error: event.error, createdAt: now, seq: 1 }
    expect(getSessionEventLabel(plain, now, counted)).toBe(event.error)
    expect(zoneReads).toBe(0)
  })

  test("an interruption row joins its parts with the separator every row uses", () => {
    const event: SessionEvent = { _tag: "interruption", createdAt: 1, seq: 1 }
    expect(getSessionEventLabel(event)).toBe("Interrupted · what should gent do instead?")
  })

  // A settled retry shows at the preview level, where it happened.
  it.scopedLive("a wrapped retry row hangs its next line under the text", () =>
    Effect.gen(function* () {
      const event: SessionEvent = {
        _tag: "retrying",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        outcome: "retried",
        reason: "overloaded (529) the provider asked us to slow down",
        createdAt: 1,
        seq: 1,
      }
      const setup = yield* renderScoped(
        () => <MessageList items={[event]} disclosure="preview" syntaxStyle={syntaxStyle} />,
        { width: 40, height: 10 },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("Retried 1/3"), "the row")
      const lines = frame.split("\n")
      const first = lines.findIndex((line) => line.includes("↻ Retried"))
      expect(lines[first]).toStartWith("  ↻ Retried")
      const next = lines[first + 1] ?? ""
      expect(next.trim().length).toBeGreaterThan(0)
      expect(next.search(/\S/)).toBe(4)
    }).pipe(Effect.timeout("4 seconds")),
  )

  test("a retry the turn's cancel cut short is not called finished", () => {
    const event: SessionEvent = {
      _tag: "retrying",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 2000,
      outcome: "cancelled",
      reason: "overloaded (529)",
      createdAt: 1_000,
      seq: 1,
    }
    expect(getSessionEventLabel(event, 30_000)).toBe("Retry 2/3 cancelled · overloaded (529)")
    // The runtime went idle before the feed saw how the retry ended.
    expect(getSessionEventLabel({ ...event, outcome: "stopped" }, 30_000)).toBe(
      "Retry 2/3 stopped · overloaded (529)",
    )
  })
})

describe("turn line", () => {
  const steps = [
    { outcome: "ToolCalls", costUsd: 0.02, usage: { inputTokens: 20_000, outputTokens: 1_200 } },
    { outcome: "Answered", costUsd: 0.02, usage: { inputTokens: 18_000, outputTokens: 900 } },
  ].reduce(addStep, emptyTurnSteps)
  const ended = (
    counted: typeof emptyTurnSteps,
    durationSeconds = 108,
  ): Extract<SessionEvent, { _tag: "turn-ended" }> => ({
    _tag: "turn-ended",
    durationSeconds,
    steps: counted,
    createdAt: 0,
    seq: 1,
  })

  test("the turn line names the time, the retries, the tokens and the cost", () => {
    expect(getSessionEventLabel(ended(addRetry(addRetry(steps))))).toBe(
      "Worked for 1m 48s · 2 retries · ↑38k ↓2.1k · $0.04",
    )
  })

  test("one retry is one, and a turn with none has no retry slot", () => {
    expect(getSessionEventLabel(ended(addRetry(steps)))).toBe(
      "Worked for 1m 48s · 1 retry · ↑38k ↓2.1k · $0.04",
    )
    expect(getSessionEventLabel(ended(steps))).toBe("Worked for 1m 48s · ↑38k ↓2.1k · $0.04")
  })

  test("a turn with no recorded steps keeps the plain duration", () => {
    expect(getSessionEventLabel(ended(emptyTurnSteps, 5))).toBe("Worked for 5s")
    // A step with no usage or price adds nothing to the line.
    expect(getSessionEventLabel(ended(addStep(emptyTurnSteps, { outcome: "Answered" }), 5))).toBe(
      "Worked for 5s",
    )
  })

  test("the preview adds the steps, and a narrow line drops parts from the right", () => {
    const event = ended(addRetry(addRetry(steps)))
    expect(formatTurnLine(event, { steps: true })).toBe(
      "Worked for 1m 48s · 2 retries · ↑38k ↓2.1k · $0.04 · 2 steps",
    )
    expect(formatTurnLine(event, { steps: false, width: 45 })).toBe(
      "Worked for 1m 48s · 2 retries · ↑38k ↓2.1k",
    )
    expect(formatTurnLine(event, { steps: false, width: 40 })).toBe("Worked for 1m 48s · 2 retries")
    // The duration stays.
    expect(formatTurnLine(event, { steps: true, width: 5 })).toBe("Worked for 1m 48s")
  })
})

/**
 * A turn with a model-call budget: its turn line counts the calls against
 * the limit from the newest step's receipt, the one notice near the limit
 * folds to a `⧗` row, and both keep their first part at every width.
 */
describe("model-call budget rows", () => {
  const budgeted = [
    { outcome: "ToolCalls", usage: { inputTokens: 20_000, outputTokens: 1_200 }, costUsd: 0.02 },
    { outcome: "ToolCalls", modelAttempts: { used: 5, limit: 8 } },
    {
      outcome: "Answered",
      usage: { inputTokens: 18_000, outputTokens: 900 },
      costUsd: 0.02,
      modelAttempts: { used: 6, limit: 8 },
    },
  ].reduce(addStep, addRetry(addRetry(emptyTurnSteps)))
  const turnLine: Extract<SessionEvent, { _tag: "turn-ended" }> = {
    _tag: "turn-ended",
    durationSeconds: 108,
    steps: budgeted,
    createdAt: 1,
    seq: 1,
  }
  const notice: ListMessage = {
    ...userMessage("regular-message", "m1:model-attempts", "BUDGET-NOTICE-BODY"),
    metadata: { customType: MODEL_ATTEMPTS_MESSAGE_TYPE, details: { used: 5, limit: 8 } },
  }
  const lastCall: ListMessage = {
    ...userMessage("regular-message", "m1:model-attempts-last", "BUDGET-LAST-CALL-BODY"),
    metadata: { customType: MODEL_ATTEMPTS_MESSAGE_TYPE, details: { used: 7, limit: 8 } },
  }

  test("the turn line counts the newest receipt's calls right after the time", () => {
    expect(getSessionEventLabel(turnLine)).toBe(
      "Worked for 1m 48s · 6/8 model calls · 2 retries · ↑38k ↓2.1k · $0.04",
    )
    // A turn with no budget has no slot.
    const unbudgeted = { ...turnLine, steps: addStep(emptyTurnSteps, { outcome: "Answered" }) }
    expect(getSessionEventLabel(unbudgeted)).toBe("Worked for 1m 48s")
  })

  test("a turn under a second keeps its model-call slot", () => {
    const short = { ...turnLine, durationSeconds: 0 }
    expect(getSessionEventLabel(short)).toBe(
      "Worked for <1s · 6/8 model calls · 2 retries · ↑38k ↓2.1k · $0.04",
    )
    expect(formatTurnLine(short, { steps: false, width: 40 })).toBe(
      "Worked for <1s · 6/8 model calls",
    )
  })

  const rowsAt = (width: number) =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[notice, lastCall, turnLine]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
          />
        ),
        { width, height: 10 },
      )
      return renderFrame(setup)
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
    })

  it.scopedLive("at 100 columns the notice, the last call and the turn line are whole", () =>
    Effect.gen(function* () {
      expect(yield* rowsAt(100)).toEqual([
        "  ⧗ 3 of 8 model calls left · the last runs without tools · a new message gets a fresh budget",
        "  ⧗ last of 8 model calls · tools off · the turn answers with what it has",
        "  ✻ Worked for 1m 48s · 6/8 model calls · 2 retries · ↑38k ↓2.1k · $0.04",
      ])
    }),
  )

  it.scopedLive("at 60 columns each row drops its last parts and keeps the count", () =>
    Effect.gen(function* () {
      expect(yield* rowsAt(60)).toEqual([
        "  ⧗ 3 of 8 model calls left · the last runs without tools",
        "  ⧗ last of 8 model calls · tools off",
        "  ✻ Worked for 1m 48s · 6/8 model calls · 2 retries",
      ])
    }),
  )

  it.scopedLive("at 40 columns each row keeps its first part", () =>
    Effect.gen(function* () {
      expect(yield* rowsAt(40)).toEqual([
        "  ⧗ 3 of 8 model calls left",
        "  ⧗ last of 8 model calls · tools off",
        "  ✻ Worked for 1m 48s · 6/8 model calls",
      ])
    }),
  )

  it.scopedLive("full detail draws the lines the model read", () =>
    Effect.gen(function* () {
      const frame = yield* renderLoaded([notice, lastCall], true)
      expect(frame).toContain("BUDGET-NOTICE-BODY")
      expect(frame).toContain("BUDGET-LAST-CALL-BODY")
      expect(frame).not.toContain("⧗")
    }),
  )
})

// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined

// ── message list render ─────────────────────────────────────────────────────

const syntaxStyle = () => SyntaxStyle.create()

const userMessage = (
  tag: "regular-message" | "interjection-message",
  id: string,
  content: string,
  images: ReadonlyArray<{ mediaType: string }> = [],
): ListMessage => {
  if (tag === "interjection-message") {
    return {
      _tag: tag,
      id,
      role: "user",
      content,
      reasoning: "",
      images: [...images],
      createdAt: 0,
    }
  }
  return {
    _tag: tag,
    id,
    role: "user",
    content,
    reasoning: "",
    images: [...images],
    createdAt: 0,
  }
}

/**
 * One assistant message carrying one tool call.
 *
 * The segments own a message's tool calls, as the feed writes them.
 */
const assistantToolMessage = (id: string, toolCall: ToolCall): ListMessage => ({
  _tag: "regular-message",
  id,
  role: "assistant",
  content: "",
  reasoning: "",
  images: [],
  createdAt: 0,
  segments: [{ _tag: "tool-call", toolCall }],
})

/**
 * A failed call as the runner stores it: the output is `{ error }` as pretty
 * JSON, and the summary is the error's first line cut to 100 characters, with
 * `...` after a cut (core `summarizeToolResult`).
 */
const runnerFailure = (
  id: string,
  toolName: string,
  input: ToolCall["input"],
  error: string,
): ToolCall => {
  const line = error.trim().split("\n")[0] ?? ""
  let summary = line
  if (line.length > 100) summary = `${line.slice(0, 100)}...`
  return {
    id,
    toolName,
    status: "error",
    input,
    summary,
    output: `{\n  "error": ${encodeJson(error)}\n}`,
  }
}

/**
 * A failed call as an older runner stored it, and as its stored rows keep it:
 * the summary is the compact `{ error }` JSON cut to 100 characters, with
 * `...` after a cut, so it does not parse.
 */
const jsonSummaryFailure = (
  id: string,
  toolName: string,
  input: ToolCall["input"],
  error: string,
): ToolCall => {
  const compact = encodeJson({ error })
  let summary = compact
  if (compact.length > 100) summary = `${compact.slice(0, 100)}...`
  return { ...runnerFailure(id, toolName, input, error), summary }
}

/** An error longer than the summary keeps, so the stored summary is cut. */
const LONG_TOOL_ERROR =
  "connection refused by the upstream server after three tries at the configured endpoint"

const unknownFailureMessage = (id: string): ListMessage =>
  assistantToolMessage(
    "assistant-unknown-tool",
    runnerFailure(
      id,
      "unknown_fx_tool",
      absent,
      `Tool 'unknown_fx_tool' failed: ${LONG_TOOL_ERROR}`,
    ),
  )

const registeredFailureMessage = (id: string): ListMessage =>
  assistantToolMessage("assistant-registered-tool", {
    id,
    toolName: "read",
    status: "error",
    input: { path: "/tmp/failure.txt" },
    summary: "read failed",
    output: absent,
  })

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const cellMessage = (id: string, display = "hello from a.txt"): ListMessage =>
  assistantToolMessage("assistant-cell", {
    id,
    toolName: "cell",
    status: "completed",
    input: { code: "const note = await tools.read({path: 'a.txt'})\nnote.content" },
    summary: absent,
    output: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
      display,
      bindings: ["note"],
      truncated: false,
      operations: [
        { toolCallId: `${id}-op`, tool: "read", outcome: "succeeded", summary: "12 lines" },
        { toolCallId: `${id}-op2`, tool: "write", outcome: "failed", summary: "denied" },
      ],
    }),
  })

/** A cell result that names the bindings it bound and counts the whole namespace. */
const cellBindingsMessage = (
  id: string,
  bindings: ReadonlyArray<string>,
  bindingCount: number,
): ListMessage =>
  assistantToolMessage(`assistant-${id}`, {
    id,
    toolName: "cell",
    status: "completed",
    input: { code: "let note = 1" },
    summary: absent,
    output: encodeJson({
      display: `${id} done`,
      bindings: [...bindings],
      bindingCount,
      truncated: false,
    }),
  })

const bashMessage = (id: string, lines: number): ListMessage =>
  assistantToolMessage("assistant-bash", {
    id,
    toolName: "bash",
    status: "completed",
    input: { command: "seq 25" },
    summary: absent,
    output: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
      stdout: Array.from({ length: lines }, (_, i) => `row ${i + 1}`).join("\n"),
      stderr: "",
      exitCode: 0,
    }),
  })

/** A bash row whose output fields are given as the tool wrote them. */
const bashOutputMessage = (
  id: string,
  output: { readonly stdout: string; readonly stderr: string; readonly status?: string },
): ListMessage =>
  assistantToolMessage(`assistant-${id}`, {
    id,
    toolName: "bash",
    status: "completed",
    input: { command: "echo hello" },
    summary: absent,
    output: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({ ...output, exitCode: 0 }),
  })

const compactionMessage = (): ListMessage => ({
  _tag: "regular-message",
  id: "context-handoff:b1:m3",
  role: "user",
  content: "Context handoff: the user renamed the loader.",
  reasoning: "",
  images: [],
  createdAt: 0,
  metadata: {
    customType: "context-window",
    details: {
      keepFromMessageId: "m4",
      summarized: { firstMessageId: "m1", lastMessageId: "m3", count: 3 },
    },
  },
})

function RegisteredToolMessageLists(props: { items: SessionItem[]; fullDetail?: boolean }) {
  const renderers = useToolRenderers()
  return (
    <Show when={renderers().size > 0} fallback={<text>loading renderers</text>}>
      <MessageList items={props.items} disclosure="collapsed" syntaxStyle={syntaxStyle} />
      <MessageList items={props.items} disclosure="preview" syntaxStyle={syntaxStyle} />
      <Show when={props.fullDetail}>
        <MessageList
          items={props.items}
          disclosure="preview"
          fullDetail
          syntaxStyle={syntaxStyle}
        />
      </Show>
    </Show>
  )
}

/**
 * The native transcript as the session mounts it with nothing open: settled,
 * idle, a 3-row footer, collapsed, and its rows drawn by `MessageList` at the
 * transcript's disclosure. A test passes only the props it varies; the props
 * stay reactive.
 */
type TranscriptProps = Omit<ComponentProps<typeof NativeTranscript>, "children">

const TRANSCRIPT_DEFAULTS: Omit<TranscriptProps, "items" | "renderItems"> = {
  settled: true,
  streaming: false,
  footerHeight: 3,
  paneOpen: false,
  expanded: false,
  disclosure: "collapsed",
  displayRevision: 0,
  overlayOpen: false,
}

function Transcript(
  props: Partial<TranscriptProps> & {
    readonly items: SessionItem[]
    /** Gets the renderer before the first frame: a test hooks commits, holds and timeouts there. */
    readonly onRenderer?: (renderer: CliRenderer) => void
  },
) {
  const renderer = useRenderer()
  const [own, shown] = splitProps(props, ["onRenderer"])
  Option.map(Option.fromNullishOr(own.onRenderer), (onRenderer) => onRenderer(renderer))
  const merged = mergeProps(
    TRANSCRIPT_DEFAULTS,
    {
      renderItems: (visible: SessionItem[]) => (
        <MessageList items={visible} disclosure={merged.disclosure} syntaxStyle={syntaxStyle} />
      ),
    },
    shown,
  )
  return (
    <NativeTranscript {...merged}>
      <box />
    </NativeTranscript>
  )
}

/** The text of one native history commit, with a line break after each row when asked. */
const committedTextOf = (event: CliRendererExternalOutputEvent, lineBreaks = false) =>
  new TextDecoder().decode(event.snapshot.getRealCharBytes(lineBreaks))

/** The transcript once the builtin client extensions, and so their message rows, have loaded. */
function LoadedMessageList(props: { items: SessionItem[]; fullDetail?: boolean }) {
  const extensionUI = useExtensionUI()
  return (
    <Show
      when={extensionUI.messageRenderers().size > 0}
      fallback={<text>loading message renderers</text>}
    >
      <MessageList
        items={props.items}
        disclosure="collapsed"
        fullDetail={props.fullDetail}
        syntaxStyle={syntaxStyle}
      />
    </Show>
  )
}

/** Render the loaded transcript and return its first frame past the load. */
const renderLoaded = (items: SessionItem[], fullDetail?: boolean) =>
  Effect.gen(function* () {
    const setup = yield* renderScoped(() => (
      <LoadedMessageList items={items} fullDetail={fullDetail} />
    ))
    return yield* waitForFrame(
      setup,
      (frame) => !frame.includes("loading message renderers"),
      "message renderers",
    )
  })

/** One op a cell admitted, as its tool reported it. */
interface CellOp {
  readonly id: string
  readonly toolName: string
  readonly input: Readonly<Record<string, string>>
  readonly summary: string
  readonly output: string
}

/**
 * One cell as the live feed carries it, each op whole, and as a reload
 * projects it from the branch's stored tool events.
 */
const cellBeforeAndAfterReload = (messageId: string, ops: ReadonlyArray<CellOp>) =>
  Effect.gen(function* () {
    const sessionId = SessionId.make(`session-${messageId}`)
    const branchId = BranchId.make(`branch-${messageId}`)
    const cell = ToolCallId.make(`${messageId}-cell`)
    const envelope = (id: number, event: AgentEvent) =>
      EventEnvelope.make({ id: EventId.make(id), createdAt: id, event })
    const events = ops.flatMap((op, index) => [
      envelope(
        2 * index + 1,
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make(op.id),
          toolName: op.toolName,
          input: op.input,
          parentToolCallId: cell,
        }),
      ),
      envelope(
        2 * index + 2,
        AgentEvent.cases.ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: ToolCallId.make(op.id),
          toolName: op.toolName,
          summary: op.summary,
          output: op.output,
          parentToolCallId: cell,
        }),
      ),
    ])
    const [projected] = projectMessagesWithToolInteractions(
      [
        Message.cases.regular.make({
          id: MessageId.make(messageId),
          sessionId,
          branchId,
          role: "assistant",
          parts: [
            Prompt.toolCallPart({
              id: cell,
              name: "cell",
              params: { code: "await tools.grep({pattern: 'value'})" },
              providerExecuted: false,
            }),
          ],
          createdAt: dateFromMillis(0),
        }),
      ],
      toolCallReceipts(events),
    )
    const interaction = Option.fromNullishOr(projected?.toolInteractions[0])
    if (Option.isNone(interaction)) return yield* Effect.die("no projected cell")
    const { operations, ...call } = interaction.value
    const reloaded: ToolCall = {
      ...call,
      status: "completed",
      operations: (operations ?? []).map((operation) => ({ ...operation })),
    }
    const live: ToolCall = {
      ...reloaded,
      operations: ops.map((op) => ({
        id: op.id,
        toolName: op.toolName,
        status: "completed",
        input: op.input,
        summary: op.summary,
        output: op.output,
      })),
    }
    return { live, reloaded }
  })

/** The frame a transcript holding one cell draws, once `ready` holds. */
const drawnCell = (
  messageId: string,
  call: ToolCall,
  ready: (frame: string) => boolean,
  label: string,
  height = 80,
) =>
  Effect.gen(function* () {
    const setup = yield* renderScoped(
      () => (
        <RegisteredToolMessageLists items={[assistantToolMessage(messageId, call)]} fullDetail />
      ),
      { width: 110, height },
    )
    const frame = yield* waitForFrame(setup, ready, label)
    destroyRenderSetup(setup)
    return frame
  })

describe("transcript message rows", () => {
  it.scopedLive("shows information excluded from model context in the transcript", () =>
    Effect.gen(function* () {
      const message: ListMessage = {
        ...compactionMessage(),
        id: "presented-information",
        content: "INFORMATION-SHOWN",
        metadata: { customType: "prompt-present", hidden: true },
      }
      const setup = yield* renderScoped(() => (
        <MessageList items={[message]} disclosure="collapsed" syntaxStyle={syntaxStyle} />
      ))
      expect(renderFrame(setup)).toContain("INFORMATION-SHOWN")
    }),
  )

  it.scopedLive("renders user rails and images at normal width", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        userMessage("regular-message", "queued-user", "first line\nsecond line", [
          { mediaType: "image/png" },
        ]),
        userMessage("interjection-message", "steer-user", "switch now"),
      ]
      const setup = yield* renderScoped(() => (
        <MessageList items={items} disclosure="collapsed" syntaxStyle={syntaxStyle} />
      ))
      const frame = renderFrame(setup)
      expect(frame).toContain("┃")
      expect(frame).toContain("[Image: png]")
      expect(frame).toContain("first line")
      expect(frame).toContain("second line")
      expect(frame).toContain("switch now")
    }),
  )

  for (const width of [32, 65]) {
    it.scopedLive(`keeps the user border on every scrollback row at width ${width}`, () =>
      Effect.gen(function* () {
        const [disclosure, setDisclosure] = createSignal<DisclosureLevel>("collapsed")
        const leadingCells: number[] = []
        const savedText: string[] = []
        // Native history waits for client extensions; the checks start after they load.
        let extensionsLoaded = () => false
        const answer: ListMessage = {
          _tag: "regular-message",
          id: "last-answer",
          role: "assistant",
          content: "ANSWER-END",
          reasoning: "",
          images: [],
          createdAt: 0,
          segments: [{ _tag: "text", content: "ANSWER-END" }],
        }
        const items: SessionItem[] = [
          userMessage(
            "regular-message",
            "long-user",
            Array.from(
              { length: 24 },
              (_, index) => `line ${index + 1}: wrapped user text with unicode café 日本語`,
            ).join("\n"),
            [{ mediaType: "image/png" }],
          ),
          answer,
        ]
        const setup = yield* renderScoped(
          () => {
            const renderer = useRenderer()
            extensionsLoaded = useExtensionUI().loaded
            // Check native cells: string offsets do not match terminal columns for wide glyphs.
            const capture = (event: CliRendererExternalOutputEvent) => {
              const { snapshot } = event
              const text = committedTextOf(event)
              savedText.push(text)
              // The answer has no border: only the user rows are checked.
              if (text.includes("ANSWER-END")) return
              for (let row = 0; row < snapshot.height; row++) {
                const cells = snapshot.buffers.char.subarray(
                  row * snapshot.width,
                  (row + 1) * snapshot.width,
                )
                const first = Option.fromUndefinedOr(
                  cells.find((cell) => cell !== 0 && cell !== 32),
                )
                if (Option.isSome(first)) leadingCells.push(first.value)
              }
            }
            renderer.on("external_output", capture)
            onCleanup(() => renderer.off("external_output", capture))
            return <Transcript items={items} disclosure={disclosure()} />
          },
          { width, height: 14 },
        )
        yield* untilExtensionsLoaded(setup, () => extensionsLoaded())
        let otherWidth = 32
        if (width === 32) otherWidth = 65
        const views: ReadonlyArray<{ width: number; disclosure: DisclosureLevel }> = [
          { width, disclosure: "collapsed" },
          { width, disclosure: "preview" },
          { width, disclosure: "full" },
          { width, disclosure: "collapsed" },
          { width: otherWidth, disclosure: "collapsed" },
          { width, disclosure: "collapsed" },
        ]
        for (const view of views) {
          setDisclosure(view.disclosure)
          if (setup.renderer.terminalWidth !== view.width) setup.resize(view.width, 14)
          // Each view lays the transcript out again: the rows above the live
          // tail move to history, and every row shows in one place.
          const whole = () => {
            const transcript = savedText.join("") + renderFrame(setup)
            return (
              transcript.split("ANSWER-END").length === 2 &&
              Array.from({ length: 24 }, (_, index) => `line ${index + 1}:`).every(
                (line) => transcript.split(line).length === 2,
              )
            )
          }
          yield* Effect.promise(() => setup.flush()).pipe(
            Effect.repeat({ until: whole, schedule: Schedule.spaced("10 millis") }),
            Effect.timeout("4 seconds"),
            Effect.ignore,
          )
          // The frame drawn after the last commit: a committed row leaves it.
          yield* Effect.promise(() => setup.renderOnce())
          const cells = leadingCells.splice(0)
          expect(cells.length).toBeGreaterThan(10)
          expect(cells.filter((cell) => cell !== 0x2503)).toEqual([])
          const transcript = savedText.splice(0).join("") + renderFrame(setup)
          for (let line = 1; line <= 24; line++)
            expect(transcript.split(`line ${line}:`)).toHaveLength(2)
          expect(transcript.split("ANSWER-END")).toHaveLength(2)
        }
      }),
    )
  }

  it.scopedLive("a message from another session is one line that names its sender", () =>
    Effect.gen(function* () {
      const sent: ListMessage = {
        ...userMessage(
          "interjection-message",
          "sent-1",
          'Message from your parent "auth\n\nrefactor" (session 0199aabbccdd):\n\nUse the v2 token route.\n\nThen rerun the suite.',
        ),
        metadata: {
          customType: "session-message",
          details: {
            from: { sessionId: "0199aabbccdd", name: "auth\n\nrefactor", relation: "parent" },
          },
        },
      }
      const frame = yield* renderLoaded([sent])
      // A blank line in the name or the body leaves the header strip whole.
      expect(frame).toContain("  » parent auth refactor · aabbccdd · Use the v2 token route.")
      // Collapsed is the head line: the rest of the body waits for ctrl+o.
      expect(frame).not.toContain("Then rerun the suite.")
      expect(frame).not.toContain("┃")
      expect(frame).not.toContain("Message from your parent")
      expect(frame).not.toContain("(session 0199aabbccdd)")
      const expandedFrame = yield* renderLoaded([sent], true)
      expect(expandedFrame).toContain("Message from your parent")
    }),
  )

  it.scopedLive(
    "a btw question in a fork opened as the session shows the question, not its frame",
    () =>
      Effect.gen(function* () {
        const asked: ListMessage = {
          ...userMessage(
            "regular-message",
            "btw-1",
            forkQuestionText(SessionId.make("01a0ca0cb3e7"), "Which README task looks hardest?"),
          ),
          metadata: { customType: BTW_QUESTION_TYPE },
        }
        const frame = yield* renderLoaded([asked])
        expect(frame).toContain("btw · side question")
        expect(frame).toContain("Which README task looks hardest?")
        expect(frame).not.toContain("A side question, asked in a fork")
        const expandedFrame = yield* renderLoaded([asked], true)
        expect(expandedFrame).toContain("A side question, asked in a fork")
      }),
  )

  it.scopedLive(
    "a thread's and a delegate child's first message show the task, not its frame",
    () =>
      Effect.gen(function* () {
        const task = (id: string, text: string, customType: string): ListMessage => ({
          ...userMessage("regular-message", id, text),
          metadata: { customType },
        })
        const thread = task(
          "thread-1",
          threadTaskText(SessionId.make("01a0ca0cb3e7"), "Tidy the changelog."),
          THREAD_TASK_TYPE,
        )
        const child = task(
          "child-1",
          childTaskText(SessionId.make("01a0ca0cb3e7"), "Fix the csv quoting."),
          CHILD_TASK_TYPE,
        )
        const frame = yield* renderLoaded([thread, child])
        // Another session wrote each task: neither draws on the reader's rail.
        expect(frame).toContain("  » task from session · Tidy the changelog.")
        expect(frame).not.toContain("Thread started by session")
        expect(frame).toContain("  » task from parent · Fix the csv quoting.")
        expect(frame).not.toContain("Task from your parent session")
        expect(frame).not.toContain("┃")
        const expandedFrame = yield* renderLoaded([thread, child], true)
        expect(expandedFrame).toContain("Thread started by session")
        expect(expandedFrame).toContain("Task from your parent session")
      }),
  )

  it.scopedLive("a long child name is cut so the id stays on the sender line", () =>
    Effect.gen(function* () {
      const from = {
        sessionId: SessionId.make("01a0ca0cb3e7"),
        name: "delegate: Use session.send with to: parent and the message hello",
        relation: "child",
      } satisfies SessionMessageDetails["from"]
      const sent: ListMessage = {
        ...userMessage(
          "interjection-message",
          "sent-2",
          sessionMessageText({ from, message: "hello from the child" }),
        ),
        metadata: {
          customType: "session-message",
          details: { from },
        },
      }
      const frame = yield* renderLoaded([sent])
      expect(frame).toContain(
        "  » child delegate: Use session.send with… · ca0cb3e7 · hello from the child",
      )
      // The status line is for the model; the row already says who is writing.
      expect(frame).not.toContain("not its completion")
    }),
  )

  it.scopedLive("a child row stored before the status line still shows only its text", () =>
    Effect.gen(function* () {
      const from = {
        sessionId: SessionId.make("01a0ca0cb3e7"),
        name: "日本語のタスク名がとても長い子エージェントの名前です、さらに続く",
        relation: "child",
      } satisfies SessionMessageDetails["from"]
      const sent: ListMessage = {
        ...userMessage(
          "interjection-message",
          "sent-3",
          // The header as it was written before the child status line existed.
          `Message from your child "${from.name}" (session ${from.sessionId}):\n\nold question`,
        ),
        metadata: {
          customType: "session-message",
          details: { from },
        },
      }
      const frame = yield* renderLoaded([sent])
      expect(frame).toContain("old question")
      expect(frame).not.toContain("Message from your child")
      // Wide characters count two columns: 15 of them fit before the ellipsis, and the id stays on the line.
      expect(frame).toContain(
        `» child ${Array.from(from.name).slice(0, 15).join("")}… · ca0cb3e7 · old question`,
      )
    }),
  )

  it.scopedLive("shares one resize subscription across transcript event rows", () =>
    Effect.gen(function* () {
      const outcomes: ReadonlyArray<RetryOutcome> = [...Array(11).fill("retried"), "pending"]
      const items: SessionItem[] = outcomes.map((outcome, seq) => ({
        _tag: "retrying",
        attempt: seq + 1,
        maxAttempts: 12,
        delayMs: 1_000,
        outcome,
        reason: "overloaded",
        createdAt: seq,
        seq,
      }))
      const setup = yield* renderScoped(() => (
        <MessageList items={items} disclosure="preview" syntaxStyle={syntaxStyle} />
      ))
      expect(setup.renderer.listenerCount("resize")).toBe(1)
    }),
  )
})

describe("native history before the client extensions load", () => {
  it.scopedLive(
    "native history holds rows until client extensions load, then commits them rendered",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>()
        const held = defineClientExtension("@test/held-load", {
          setup: Deferred.await(release).pipe(Effect.as(clientContributions())),
        })
        const savedText: string[] = []
        const goalMessage: ListMessage = {
          ...userMessage("regular-message", "goal-held", "RAW-GOAL-TEXT keep going."),
          metadata: { customType: "goal-context" },
        }
        const items: SessionItem[] = [
          goalMessage,
          ...Array.from({ length: 6 }, (_, index) =>
            userMessage(
              "regular-message",
              `filler-${index}`,
              `filler ${index}\nsecond line\nthird line`,
            ),
          ),
        ]
        const setup = yield* renderScoped(
          () => {
            const renderer = useRenderer()
            const capture = (event: CliRendererExternalOutputEvent) => {
              savedText.push(committedTextOf(event))
            }
            renderer.on("external_output", capture)
            onCleanup(() => renderer.off("external_output", capture))
            return <Transcript items={items} />
          },
          { width: 60, height: 14, builtins: [...builtinClientModules, held] },
        )
        // Held: the live view overflows, but nothing may reach scrollback yet.
        for (let pass = 0; pass < 20; pass++) {
          yield* Effect.promise(() => setup.flush())
          yield* Effect.yieldNow
        }
        expect(savedText.join("")).toBe("")
        yield* Deferred.complete(release, Effect.void)
        yield* waitForFrame(
          setup,
          () => savedText.join("").includes("goal continuation"),
          "goal row in scrollback",
        )
        expect(savedText.join("")).not.toContain("RAW-GOAL-TEXT")
      }),
  )

  it.scopedLive("native history holds rows while a notice-row source is still deriving", () =>
    Effect.gen(function* () {
      const [settled, setSettled] = createSignal(false)
      let extensionsLoaded = () => false
      const savedText: string[] = []
      const items: SessionItem[] = Array.from({ length: 8 }, (_, index) =>
        userMessage(
          "regular-message",
          `unsettled-${index}`,
          `unsettled ${index}\nsecond line\nthird line`,
        ),
      )
      const setup = yield* renderScoped(
        () => {
          const renderer = useRenderer()
          extensionsLoaded = useExtensionUI().loaded
          const capture = (event: CliRendererExternalOutputEvent) => {
            savedText.push(committedTextOf(event))
          }
          renderer.on("external_output", capture)
          onCleanup(() => renderer.off("external_output", capture))
          return <Transcript items={items} settled={settled()} />
        },
        { width: 60, height: 14 },
      )
      yield* untilExtensionsLoaded(setup, () => extensionsLoaded())
      // The live view overflows, but a source that has not answered holds every commit.
      for (let pass = 0; pass < 20; pass++) {
        yield* Effect.promise(() => setup.flush())
        yield* Effect.yieldNow
      }
      expect(savedText.join("")).toBe("")
      setSettled(true)
      yield* waitForFrame(
        setup,
        () => savedText.join("").includes("unsettled 0"),
        "first row in scrollback",
      )
    }),
  )
})

describe("rows that fold until full detail is on", () => {
  it.scopedLive("goal continuations collapse to one line until full detail is on", () =>
    Effect.gen(function* () {
      const goalMessage: ListMessage = {
        ...userMessage("regular-message", "goal-1", "Continue working toward the active goal."),
        metadata: { customType: "goal-context" },
      }
      const collapsedFrame = yield* renderLoaded([goalMessage])
      expect(collapsedFrame).toContain("goal continuation")
      expect(collapsedFrame).not.toContain("Continue working")
      const expandedFrame = yield* renderLoaded([goalMessage], true)
      expect(expandedFrame).toContain("Continue working")
      expect(expandedFrame).not.toContain("goal continuation")
    }),
  )

  it.scopedLive("a fired alarm collapses to its note until full detail is on", () =>
    Effect.gen(function* () {
      const wakeMessage: ListMessage = {
        ...userMessage(
          "regular-message",
          "wake-1",
          "Alarm w1 fired at 2026-09-15T05:51:35.262Z. Run bun test and report.",
        ),
        metadata: {
          customType: "wake",
          details: { outcome: "fired", note: "Run bun test and report." },
        },
      }
      const collapsedFrame = yield* renderLoaded([wakeMessage])
      expect(collapsedFrame).toContain("alarm fired · Run bun test and report.")
      expect(collapsedFrame).not.toContain("fired at 2026")
      const expandedFrame = yield* renderLoaded([wakeMessage], true)
      expect(expandedFrame).toContain("fired at 2026")
      expect(expandedFrame).not.toContain("alarm fired ·")
    }),
  )

  it.scopedLive("a context handoff folds to one line until full detail is on", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [compactionMessage()]
      const setup = yield* renderScoped(
        () => (
          <>
            <MessageList items={items} disclosure="collapsed" syntaxStyle={syntaxStyle} />
            <MessageList items={items} disclosure="full" syntaxStyle={syntaxStyle} />
            <MessageList
              items={items}
              disclosure="collapsed"
              fullDetail={true}
              syntaxStyle={syntaxStyle}
            />
          </>
        ),
        { width: 100, height: 20 },
      )
      const frame = renderFrame(setup)
      expect(frame.match(/⇣ context handoff · 3 messages summarized/g)?.length).toBe(2)
      expect(frame.match(/renamed the loader/g)?.length).toBe(1)
    }),
  )

  it.scopedLive("the runtime's model-change notice folds to one line", () =>
    Effect.gen(function* () {
      const notice: ListMessage = {
        ...compactionMessage(),
        id: "model-change:b1:m5",
        content: "MODEL-NOTICE-BODY",
        metadata: { customType: MODEL_CHANGE_MESSAGE_TYPE },
      }
      const setup = yield* renderScoped(
        () => <MessageList items={[notice]} disclosure="collapsed" syntaxStyle={syntaxStyle} />,
        { width: 100, height: 10 },
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("⇄ model changed")
      expect(frame).not.toContain("MODEL-NOTICE-BODY")
    }),
  )
})

/**
 * Speaker lanes: column 0 and the `┃` rail mean the reader. Whose message it
 * is comes from typed metadata (the server's client origin, or an older row
 * with no custom type and no author), never from its text. Everything gent or
 * another agent wrote starts at column 2 behind its own glyph.
 */
describe("speaker lanes", () => {
  const row = (
    id: string,
    content: string,
    metadata: NonNullable<ListMessage["metadata"]> = {},
    tag: "regular-message" | "interjection-message" = "regular-message",
  ): ListMessage => ({
    ...userMessage(tag, id, content),
    metadata,
  })
  const childFrom = {
    sessionId: SessionId.make("01a0ca0cb3e7"),
    name: "explore",
    relation: "child",
  } satisfies SessionMessageDetails["from"]
  const childMessage = row(
    "child-said",
    sessionMessageText({ from: childFrom, message: "CHILD-SAYS the loader is fine\nmore" }),
    {
      customType: "session-message",
      extensionId: "@gent/session-tools",
      details: { from: childFrom },
    },
    "interjection-message",
  )
  const items: SessionItem[] = [
    row("typed", "PROMPT-TYPED", { fromClient: true }),
    row("legacy", "PROMPT-LEGACY"),
    row("steer", "PROMPT-STEER", { fromClient: true }, "interjection-message"),
    childMessage,
    row("child-task", childTaskText(SessionId.make("01a0ca0cb3e7"), "Fix the csv quoting."), {
      customType: CHILD_TASK_TYPE,
      extensionId: "@gent/delegate",
    }),
    row("thread-task", threadTaskText(SessionId.make("01a0ca0cb3e7"), "Tidy the changelog."), {
      customType: THREAD_TASK_TYPE,
      extensionId: "@gent/session-tools",
    }),
    row("wake", "Alarm w1 fired at 2026-09-15T05:51:35.262Z. Run tests.", {
      customType: "wake",
      extensionId: "@gent/wake",
      details: { outcome: "fired", note: "Run tests." },
    }),
    row("goal", "Continue working toward the active goal.", {
      customType: "goal-context",
      extensionId: "@gent/goal",
    }),
    row("model", "MODEL-NOTICE-BODY", { customType: MODEL_CHANGE_MESSAGE_TYPE }),
    compactionMessage(),
    row("answer", "ANSWER-BODY", {
      customType: "question-answer",
      extensionId: "@gent/interaction-tools",
      details: { answers: [{ id: "q1", question: "Cache?", assume: "LRU", answer: "Redis" }] },
    }),
    row("merge", "MERGE-BODY", {
      customType: "btw-merge",
      extensionId: "@gent/btw",
      fromClient: true,
      details: {
        fork: { sessionId: "fork", branchId: "fork-branch", name: "btw: why?" },
        fromMessageId: "m-1",
        replyId: "m-2",
        turns: 1,
        question: "Bird?",
        reply: "Heron.",
      },
    }),
    row("note", "NOTE-BODY", { customType: "note", extensionId: "@user/notes" }),
  ]

  /** Each kind's first row: its glyph and the column it starts in. */
  const firstRows = [
    "┃ PROMPT-TYPED",
    "┃ PROMPT-LEGACY",
    "┃ PROMPT-STEER",
    "  » child explore · ca0cb3e7",
    "  » task from parent · Fix the csv",
    "  » task from session · Tidy the",
    "  ◷ alarm fired",
    "  ↻ goal continuation",
    "  ⇄ model changed",
    "  ⇣ context handoff",
    "  ↳ answered · Cache? → Redis",
    "  ↳ merged btw · Bird? → Heron.",
    "  » @user/notes · note",
  ]

  const drawLoaded = (width: number, fullDetail = false) =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => <LoadedMessageList items={items} fullDetail={fullDetail} />,
        { width, height: 120 },
      )
      const frame = yield* waitForFrame(
        setup,
        (text) => !text.includes("loading message renderers") && text.includes("PROMPT-TYPED"),
        "message renderers",
      )
      return { setup, lines: frame.split("\n").map((line) => line.trimEnd()) }
    })

  for (const width of [100, 60, 40]) {
    it.scopedLive(`each kind starts with its own glyph in its own lane at ${width} columns`, () =>
      Effect.gen(function* () {
        const { lines } = yield* drawLoaded(width)
        for (const first of firstRows)
          expect(lines.some((line) => line.startsWith(first.slice(0, width - 3)))).toBe(true)
        // Only the reader's own messages hold column 0.
        expect(lines.filter((line) => /^\S/.test(line))).toEqual([
          "┃ PROMPT-TYPED",
          "┃ PROMPT-LEGACY",
          "┃ PROMPT-STEER",
        ])
        // A child's message is muted text, not the reader's bold prompt.
        expect(lines.join("\n")).not.toContain("from your child")
        expect(lines.every((line) => line.length <= width - 1)).toBe(true)
      }),
    )
  }

  it.scopedLive("a delivered steer draws exactly like a typed prompt", () =>
    Effect.gen(function* () {
      const { setup } = yield* drawLoaded(100)
      const spansOf = (marker: string) =>
        Option.getOrThrow(
          Option.fromUndefinedOr(
            setup
              .captureSpans()
              .lines.find((line) => line.spans.some((span) => span.text.includes(marker))),
          ),
        ).spans
      const typed = spansOf("PROMPT-TYPED")
      const steer = spansOf("PROMPT-STEER")
      expect(steer.map((span) => span.text.replace("STEER", "TYPED"))).toEqual(
        typed.map((span) => span.text),
      )
      steer.forEach((span, index) => {
        expect(span.fg.equals(typed[index]?.fg ?? span.bg)).toBe(true)
        expect(span.attributes).toBe(typed[index]?.attributes ?? -1)
      })
    }),
  )

  it.scopedLive("the full transcript draws another session's raw text off the rail", () =>
    Effect.gen(function* () {
      const { lines } = yield* drawLoaded(100, true)
      expect(lines).toContain("  » @gent/session-tools · session-message")
      expect(lines).toContain('    Message from your child "explore" (session 01a0ca0cb3e7):')
      expect(lines).toContain("    CHILD-SAYS the loader is fine")
      // An older row with no client origin, no custom type and no author is the reader's.
      expect(lines).toContain("┃ PROMPT-LEGACY")
      expect(lines.filter((line) => /^\S/.test(line))).toEqual([
        "┃ PROMPT-TYPED",
        "┃ PROMPT-LEGACY",
        "┃ PROMPT-STEER",
        "┃ MERGE-BODY",
      ])
    }),
  )

  it.scopedLive("a session message whose details do not decode draws its raw text", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <LoadedMessageList
            items={[
              row("odd", "RAW-SENT-TEXT\nsecond", {
                customType: "session-message",
                extensionId: "@gent/session-tools",
                details: { unrelated: true },
              }),
            ]}
          />
        ),
        { width: 60, height: 10 },
      )
      const frame = yield* waitForFrame(setup, (text) => text.includes("RAW-SENT"), "the row")
      expect(frame).toContain("  » session · RAW-SENT-TEXT")
      expect(frame).not.toContain("┃")
    }),
  )
})

describe("tool frame identity", () => {
  it.scopedLive(
    "keeps tool identity and failure status on direct compact and expanded frames",
    () =>
      Effect.gen(function* () {
        const setup = yield* renderScoped(() => (
          <ToolCallIdentityProvider id="call-direct-7">
            <ToolFrame
              title="read"
              status="error"
              expanded={false}
              collapsedContent={<text>compact failure</text>}
            >
              <text>expanded failure</text>
            </ToolFrame>
            <ToolFrame
              title="read"
              status="error"
              expanded
              collapsedContent={<text>compact failure</text>}
            >
              <text>expanded failure</text>
            </ToolFrame>
          </ToolCallIdentityProvider>
        ))
        const frame = renderFrame(setup)
        expect(frame.match(/#call-direct-7/g)?.length).toBe(2)
        expect(frame.match(/failed/g)?.length).toBeGreaterThanOrEqual(2)
        expect(frame).toContain("compact failure")
        expect(frame).toContain("expanded failure")
      }),
  )

  it.scopedLive("inline, a frame draws no open mark and a click leaves it as it is", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(() => (
        <ToolFrame
          title="read"
          status="completed"
          expanded={false}
          collapsedContent={<text>FRAME-CLOSED</text>}
        >
          <text>FRAME-OPEN</text>
        </ToolFrame>
      ))
      const closed = yield* waitForFrame(setup, (next) => next.includes("FRAME-CLOSED"), "closed")
      expect(closed).not.toMatch(/[▸▾]/)
      const row = closed.split("\n").findIndex((line) => line.includes("read"))
      yield* Effect.promise(() => setup.mockMouse.click(2, row))
      yield* Effect.promise(() => setup.renderOnce())
      expect(renderFrame(setup)).toContain("FRAME-CLOSED")
      expect(renderFrame(setup)).not.toContain("FRAME-OPEN")
    }),
  )

  // The transcript view opens over the same mounted frames: clicks turn on
  // there, and the mark and the click follow at once.
  it.scopedLive("a frame mounted inline takes clicks once its surface turns them on", () =>
    Effect.gen(function* () {
      const [clicks, setClicks] = createSignal(false)
      const setup = yield* renderScoped(() => (
        <FrameClicks on={clicks()}>
          <ToolFrame
            title="read"
            status="completed"
            expanded={false}
            collapsedContent={<text>FRAME-CLOSED</text>}
          >
            <text>FRAME-OPEN</text>
          </ToolFrame>
        </FrameClicks>
      ))
      const inline = yield* waitForFrame(setup, (next) => next.includes("FRAME-CLOSED"), "inline")
      expect(inline).not.toMatch(/[▸▾]/)
      setClicks(true)
      const marked = yield* waitForFrame(setup, (next) => next.includes("▸"), "the click mark")
      const row = marked.split("\n").findIndex((line) => line.includes("read"))
      yield* Effect.promise(() => setup.mockMouse.click(2, row))
      yield* waitForFrame(setup, (next) => next.includes("FRAME-OPEN"), "opened by the click")
      // Back inline the frame takes its owner's form again, as history draws it.
      setClicks(false)
      const back = yield* waitForFrame(setup, (next) => !/[▸▾]/.test(next), "the mark gone")
      expect(back).toContain("FRAME-CLOSED")
    }),
  )

  it.scopedLive("a click toggles a tool frame, and a new expanded from its owner starts over", () =>
    Effect.gen(function* () {
      const [expanded, setExpanded] = createSignal(false)
      // The transcript view turns the mouse on; there a frame takes clicks.
      const setup = yield* renderScoped(() => (
        <FrameClicks on>
          <ToolFrame
            title="read"
            status="completed"
            expanded={expanded()}
            collapsedContent={<text>FRAME-CLOSED</text>}
          >
            <text>FRAME-OPEN</text>
          </ToolFrame>
        </FrameClicks>
      ))
      const closed = yield* waitForFrame(setup, (next) => next.includes("FRAME-CLOSED"), "closed")
      expect(closed).toContain("▸")
      const row = closed.split("\n").findIndex((line) => line.includes("read"))
      yield* Effect.promise(() => setup.mockMouse.click(2, row))
      yield* waitForFrame(setup, (next) => next.includes("FRAME-OPEN"), "opened by the click")
      setExpanded(true)
      yield* Effect.promise(() => setup.mockMouse.click(2, row))
      yield* waitForFrame(setup, (next) => next.includes("FRAME-CLOSED"), "closed by a click")
      setExpanded(false)
      yield* waitForFrame(setup, (next) => next.includes("FRAME-CLOSED"), "the owner's value")
      setExpanded(true)
      yield* waitForFrame(setup, (next) => next.includes("FRAME-OPEN"), "the owner's new value")
    }),
  )

  it.scopedLive(
    "a failed call with no renderer names its reason on its row, its identity only when open",
    () =>
      Effect.gen(function* () {
        const error = `Tool 'unknown_fx_tool' failed: ${LONG_TOOL_ERROR}`
        const items: SessionItem[] = [
          unknownFailureMessage("call-unknown-7"),
          // A reloaded call whose output did not come through reads its summary,
          // in the shape the runner stores today and in the older JSON shape.
          assistantToolMessage("assistant-unknown-summary", {
            ...runnerFailure("call-unknown-8", "unknown_fx_tool", absent, error),
            output: absent,
          }),
          assistantToolMessage("assistant-unknown-json-summary", {
            ...jsonSummaryFailure("call-unknown-9", "unknown_fx_tool", absent, error),
            output: absent,
          }),
        ]
        const setup = yield* renderScoped(
          () => (
            <>
              <MessageList items={items} disclosure="collapsed" syntaxStyle={syntaxStyle} />
              <MessageList items={items} disclosure="preview" syntaxStyle={syntaxStyle} />
            </>
          ),
          { width: 160, height: 40 },
        )
        const frame = renderFrame(setup)
        // A row says the tool and `failed` once; the reason follows without the runner's lead.
        expect(frame.match(/unknown_fx_tool · failed/g)?.length).toBe(6)
        expect(frame.match(/connection refused by the upstream/g)?.length).toBe(6)
        expect(frame).not.toContain("Tool 'unknown_fx_tool' failed")
        for (const id of ["call-unknown-7", "call-unknown-8", "call-unknown-9"])
          expect(frame).not.toContain(`#${id}`)
        expect(frame).not.toContain("[x unknown_fx_tool]")
        expect(frame).not.toContain('{"error"')
        const open = yield* renderScoped(
          () => <MessageList items={items} disclosure="full" syntaxStyle={syntaxStyle} />,
          { width: 160, height: 40 },
        ).pipe(Effect.map(renderFrame))
        for (const id of ["call-unknown-7", "call-unknown-8", "call-unknown-9"])
          expect(open.match(new RegExp(`#${id}\\b`, "g"))?.length).toBe(1)
        expect(open.match(/failed: connection refused by the upstream/g)?.length).toBe(3)
      }),
  )

  it.scopedLive(
    "a registered renderer's failure keeps its identity for the open view at narrow width",
    () =>
      Effect.gen(function* () {
        const setup = yield* renderScoped(
          () => (
            <RegisteredToolMessageLists
              items={[registeredFailureMessage("call-reg-7")]}
              fullDetail
            />
          ),
          { width: 42, height: 20 },
        )
        const frame = yield* waitForFrame(
          setup,
          (next) => next.includes("#call-reg-7") && next.includes("✕ failed"),
          "registered renderer failure",
        )
        // Collapsed and preview draw one row each; only the open frame names the call id.
        expect(frame.match(/└ Read \/tmp\/failure\.txt · failed/g)?.length).toBe(2)
        expect(frame.match(/#call-reg-7/g)?.length).toBe(1)
        expect(frame.match(/✕ failed/g)?.length).toBe(1)
        expect(frame).not.toContain("[x read]")
      }),
  )

  it.scopedLive("a failed builtin call shows its reason in every view, and as a cell op", () =>
    Effect.gen(function* () {
      const failed = (tool: string, input: Readonly<Record<string, string>>): ToolCall =>
        runnerFailure(
          `call-${tool}-failed`,
          tool,
          input,
          `Tool '${tool}' failed: REASON-${tool} ${LONG_TOOL_ERROR}`,
        )
      const calls: ReadonlyArray<ToolCall> = [
        failed("bash", { command: "false" }),
        failed("read", { path: "/tmp/missing.txt" }),
        failed("edit", { path: "/tmp/a.ts", oldString: "old", newString: "new" }),
        failed("write", { path: "/tmp/b.ts", content: "text" }),
        failed("read_session", { sessionId: "session-missing" }),
        // A call whose output did not come through keeps the summary the runner wrote.
        {
          id: "call-summary-failed",
          toolName: "read",
          status: "error",
          input: { path: "/tmp/summary.txt" },
          summary: "REASON-summary",
          output: absent,
        },
      ]
      const cell: ToolCall = {
        id: "call-cell-op-failed",
        toolName: "cell",
        status: "completed",
        input: { code: "await tools.read({ path: 'gone.txt' })" },
        output: encodeJson({ display: "cell done" }),
        operations: [
          failed("grep", { pattern: "x" }),
          failed("read", { path: "gone.txt" }),
          // No TUI renderer draws these: the op keeps its one-line receipt.
          failed("mcp_fetch", { url: "https://example.invalid" }),
          // A reloaded op whose output did not fit the snapshot keeps the cut summary.
          { ...failed("mcp_search", { query: "x" }), output: absent },
        ].map((op) => ({ ...op, id: `${op.id}-op` })),
      }
      const items: SessionItem[] = [...calls, cell].map((call) =>
        assistantToolMessage(`assistant-${call.id}`, call),
      )
      const setup = yield* renderScoped(
        () => <RegisteredToolMessageLists items={items} fullDetail />,
        { width: 110, height: 200 },
      )
      const reasons = ["bash", "read", "edit", "write", "read_session", "summary"]
      const frame = yield* waitForFrame(
        setup,
        (next) => reasons.every((tool) => next.includes(`REASON-${tool}`)),
        "failure reasons",
      )
      // Collapsed, preview and full detail each name the reason once per call.
      for (const tool of ["bash", "edit", "write", "read_session", "summary"]) {
        expect(frame.match(new RegExp(`REASON-${tool}\\b`, "g"))?.length).toBe(3)
      }
      // A cell's failed ops are rows of the run in every view, like direct calls:
      // the direct read and the read the cell admitted, each in three views.
      expect(frame.match(/REASON-read\b/g)?.length).toBe(6)
      expect(frame.match(/REASON-grep\b/g)?.length).toBe(3)
      expect(frame).toContain("Read gone.txt · failed · REASON-read")
      expect(frame).toContain("✕ mcp_fetch Tool 'mcp_fetch' failed: REASON-mcp_fetch")
      expect(frame).toContain("✕ mcp_search Tool 'mcp_search' failed: REASON-mcp_search")
      // A reason reads as its sentence, never as the stored JSON.
      expect(frame).not.toContain('{"error"')
    }),
  )

  it.scopedLive("shows worker recovery errors in collapsed, preview, and detail frames", () =>
    Effect.gen(function* () {
      const recovered: ToolCall = {
        id: "call-recovered",
        toolName: "cell",
        status: "error",
        input: { code: "await tools.ask_user({})" },
        summary: absent,
        output: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          error: "The cell worker state was lost. Its source was not replayed.",
          stateLost: true,
          operations: [
            {
              _tag: "Completed",
              operationId: "op-1",
              result: {
                type: "tool-result",
                id: "inner-1",
                name: "ask_user",
                isFailure: false,
                providerExecuted: false,
                result: { answers: [["Continue"]] },
              },
            },
          ],
        }),
      }
      const message: ListMessage = assistantToolMessage("assistant-cell", recovered)
      const setup = yield* renderScoped(
        () => <RegisteredToolMessageLists items={[message]} fullDetail />,
        {
          width: 110,
          height: 50,
        },
      )
      const frame = yield* waitForFrame(
        setup,
        (next) => (next.match(/Its source was not replayed/g)?.length ?? 0) >= 3,
        "cell recovery error",
      )
      expect(frame.match(/Its source was not replayed/g)?.length).toBe(3)
    }),
  )
})

describe("reloaded cell ops", () => {
  it.scopedLive("a reloaded cell draws its ops as the live feed drew them", () =>
    Effect.gen(function* () {
      const editInput = {
        path: "/workspace/src/module.ts",
        oldString: `export const value = "${"a".repeat(120)}"`,
        newString: `export const value = "${"b".repeat(120)}"\nexport const other = 1`,
      }
      const { live, reloaded } = yield* cellBeforeAndAfterReload("assistant-reloaded-cell", [
        {
          id: "op-bash",
          toolName: "bash",
          input: { command: "bun test" },
          summary: "done",
          output: encodeJson({ stdout: "1 fail", stderr: "", exitCode: 1 }),
        },
        {
          id: "op-edit",
          toolName: "edit",
          input: editInput,
          summary: "done",
          output: encodeJson({ path: editInput.path, replacements: 1 }),
        },
      ])
      const ready = (frame: string) => frame.includes("module.ts") && frame.includes("other = 1")
      const liveFrame = yield* drawnCell("assistant-reloaded-cell", live, ready, "live", 60)
      const frame = yield* drawnCell("assistant-reloaded-cell", reloaded, ready, "reloaded", 60)
      // A reload opens each op body exactly as far as the live feed did.
      expect(frame).toBe(liveFrame)
      // A failed command reads as failed after a reload, not as a bare success header.
      expect(frame).toContain("exit 1")
      // The diff is built from the whole strings: the new text changes the line and adds one.
      expect(frame).toContain("+2 -1")
      expect(frame).toContain("+export const other = 1")
    }),
  )

  it.scopedLive("a reloaded op cut to fit counts and numbers lines as in its whole output", () =>
    Effect.gen(function* () {
      const numbered = Array.from({ length: 3_000 }, (_, index) => `line ${index + 1}`)
      const { reloaded } = yield* cellBeforeAndAfterReload("assistant-cut-cell", [
        {
          id: "op-bash-long",
          toolName: "bash",
          input: { command: "seq 3000" },
          summary: "done",
          output: encodeJson({ stdout: numbered.join("\n"), stderr: "", exitCode: 0 }),
        },
        {
          id: "op-read-long",
          toolName: "read",
          input: { path: "/workspace/long.txt" },
          summary: "done",
          output: encodeJson({
            path: "/workspace/long.txt",
            content: numbered.map((text, index) => `${index + 1}\t${text}`).join("\n"),
            lineCount: 3_000,
          }),
        },
      ])
      const frame = yield* drawnCell(
        "assistant-cut-cell",
        reloaded,
        (next) => next.includes("long.txt"),
        "cut cell ops",
        60,
      )
      // bash: the whole count, its real last line, and the true number of hidden lines.
      expect(frame).toContain("exit 0 · 3000 lines")
      expect(frame).toContain("... [2994 lines truncated] ...")
      // read: the tail keeps its real line numbers.
      expect(frame).toMatch(/3000 │ line 3000/)
      expect(frame).toContain("2994 more lines")
    }),
  )

  it.scopedLive("a reloaded grep op and a large edit draw as the live feed drew them", () =>
    Effect.gen(function* () {
      const matches = Array.from({ length: 12 }, (_, index) => ({
        file: `src/module-${index % 4}.ts`,
        line: index + 1,
        content: `const value${index} = ${index}`,
      }))
      // Diff strings past the old 4 KB input share, still inside the 8 KB op budget.
      const editInput = {
        path: "/workspace/src/large.ts",
        oldString: Array.from({ length: 60 }, (_, i) => `old ${i} ${"a".repeat(40)}`).join("\n"),
        newString: Array.from({ length: 60 }, (_, i) => `new ${i} ${"b".repeat(40)}`).join("\n"),
      }
      const { live, reloaded } = yield* cellBeforeAndAfterReload("assistant-grep-edit", [
        {
          id: "op-grep",
          toolName: "grep",
          input: { pattern: "value" },
          summary: "12 matches for value",
          output: encodeJson({ matches, truncated: false }),
        },
        {
          id: "op-edit",
          toolName: "edit",
          input: editInput,
          summary: "/workspace/src/large.ts · 1 replacement",
          output: encodeJson({ path: editInput.path, replacements: 1 }),
        },
      ])
      const ready = (frame: string) => frame.includes("matches in") && frame.includes("+60 -60")
      const liveFrame = yield* drawnCell("assistant-grep-edit", live, ready, "live grep and edit")
      const frame = yield* drawnCell(
        "assistant-grep-edit",
        reloaded,
        ready,
        "reloaded grep and edit",
      )
      expect(frame).toBe(liveFrame)
      expect(frame).toContain("12 matches in 4 files")
      expect(frame).toContain("+1 more file")
      expect(frame).toContain("+new 59")
    }),
  )

  it.scopedLive(
    "a reloaded op too large for the snapshot counts what it cut or draws its summary",
    () =>
      Effect.gen(function* () {
        const matches = Array.from({ length: 200 }, (_, index) => ({
          file: `src/module-${Math.floor(index / 20)}.ts`,
          line: index + 1,
          content: `const value${index} = compute(${index})`,
        }))
        const editInput = {
          path: "/workspace/src/huge.ts",
          oldString: "a\n".repeat(6_000),
          newString: "b\n".repeat(6_000),
        }
        const { reloaded } = yield* cellBeforeAndAfterReload("assistant-large-ops", [
          {
            id: "op-grep-large",
            toolName: "grep",
            input: { pattern: "value" },
            summary: "200 matches for value",
            output: encodeJson({ matches, truncated: false }),
          },
          {
            id: "op-edit-large",
            toolName: "edit",
            input: editInput,
            summary: "/workspace/src/huge.ts · 1 replacement",
            output: encodeJson({ path: editInput.path, replacements: 1 }),
          },
        ])
        const frame = yield* drawnCell(
          "assistant-large-ops",
          reloaded,
          (next) => next.includes("matches in") && next.includes("1 replacement"),
          "reloaded large ops",
        )
        // Every match and every file counts, the ones between head and tail too.
        expect(frame).toContain("200 matches in 10 files")
        expect(frame).toContain("+7 more files")
        expect(frame).toContain("src/module-0.ts")
        // The diff strings do not fit, so the edit draws the summary its tool wrote.
        expect(frame).toContain("/workspace/src/huge.ts · 1 replacement")
      }),
  )

  it.scopedLive("a reloaded op cut inside one long line marks the characters it left out", () =>
    Effect.gen(function* () {
      const json = encodeJson({
        rows: Array.from({ length: 800 }, (_, index) => ({ id: index, name: `row-${index}` })),
      })
      const { reloaded } = yield* cellBeforeAndAfterReload("assistant-one-line", [
        {
          id: "op-bash-json",
          toolName: "bash",
          input: { command: "curl api" },
          summary: "exit 0 · 1 line",
          output: encodeJson({ stdout: json, stderr: "", exitCode: 0 }),
        },
        {
          id: "op-read-json",
          toolName: "read",
          input: { path: "/workspace/data.json" },
          summary: "/workspace/data.json · 1 line",
          output: encodeJson({ path: "/workspace/data.json", content: `1\t${json}`, lineCount: 1 }),
        },
      ])
      const frame = yield* drawnCell(
        "assistant-one-line",
        reloaded,
        (next) => next.includes("data.json") && next.includes("exit 0"),
        "reloaded one-line ops",
        // Each op draws its one line wrapped, a few thousand characters of it.
        400,
      )
      expect(frame).toMatch(/exit 0 · 1 line(?!s)/)
      expect(frame).toMatch(/1 line(?!s)\s+1 │/)
      expect(frame).toMatch(/\.\.\. \[[\d,]+ chars truncated\] \.\.\./)
      expect(frame).not.toContain("0 lines truncated")
      // The read gutter numbers the one line once; the other line 1 is the cell's code.
      expect(frame.match(/ 1 │/g)?.length).toBe(2)
      expect(frame).toContain('1 │ {"rows"')
    }),
  )

  it.scopedLive("a reloaded head or tail that keeps part of a line marks the side it lost", () =>
    Effect.gen(function* () {
      const long = (label: string) => `${label}${"x".repeat(20_000)}`
      const { reloaded } = yield* cellBeforeAndAfterReload("assistant-part-lines", [
        {
          id: "op-bash-head-part",
          toolName: "bash",
          input: { command: "gen head" },
          summary: "exit 0 · 3 lines",
          output: encodeJson({
            stdout: `${long("first")}\n${long("second")}\nshort-tail`,
            stderr: "",
            exitCode: 0,
          }),
        },
        {
          id: "op-bash-tail-part",
          toolName: "bash",
          input: { command: "gen tail" },
          summary: "exit 0 · 3 lines",
          output: encodeJson({
            stdout: `short-head\n${long("second")}\n${long("third")}y`,
            stderr: "",
            exitCode: 0,
          }),
        },
      ])
      const frame = yield* drawnCell(
        "assistant-part-lines",
        reloaded,
        (next) => next.includes("gen head") && next.includes("gen tail"),
        "reloaded part lines",
        400,
      )
      const text = frame.replace(/\s*\n\s*/g, "")
      // Line 1 stops early, line 2 is left out whole, line 3 is whole.
      expect(text).toContain("xxx …... [1 line truncated] ...short-tail")
      // Line 1 is whole, line 2 is left out whole, line 3 starts late.
      expect(text).toContain("short-head... [1 line truncated] ...…xxx")
    }),
  )

  it.scopedLive(
    "a blocked command an earlier version stored reads as declined and a background one as running on, not as exits",
    () =>
      Effect.gen(function* () {
        const { live } = yield* cellBeforeAndAfterReload("assistant-declined", [
          {
            id: "op-bash-declined",
            toolName: "bash",
            input: { command: "git checkout HEAD -- README.md" },
            summary: "exit 1 · 1 line",
            output: encodeJson({
              stdout: "Command blocked: git checkout that discards working-tree changes",
              stderr: "",
              exitCode: 1,
              status: "blocked",
            }),
          },
          {
            id: "op-bash-background",
            toolName: "bash",
            input: { command: "bun run dev" },
            summary: "started in background",
            output: encodeJson({
              stdout: "Command started in background: `bun run dev`",
              stderr: "",
              exitCode: 0,
              status: "background",
            }),
          },
        ])
        const frame = yield* drawnCell(
          "assistant-declined",
          live,
          (next) => next.includes("Command blocked"),
          "declined op",
        )
        expect(frame).toContain("declined")
        expect(frame).not.toContain("exit 1")
        // A background command has not ended: it has no exit code yet.
        expect(frame).toContain("in background")
        expect(frame).not.toContain("exit 0")
      }),
  )
})

describe("cell rows", () => {
  it.scopedLive("shows cell operation receipts in tree and detail frames", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => <RegisteredToolMessageLists items={[cellMessage("call-cell-7")]} fullDetail />,
        { width: 100, height: 40 },
      )
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("#call-cell-7") && next.includes("hello from a.txt"),
        "cell renderer",
      )
      // The header counts the ops in the past-tense words the preview rows
      // name them in; the open row names them as the cell ran them.
      expect(frame).toContain("● Read 1 file · wrote 1 file · 1 failed")
      expect(frame).toContain("├ Read")
      expect(frame).toContain("└ Wrote · failed")
      expect(frame).toContain("└ cell read · ✕ write")
      // The detail frame shows each receipt, the display value, and bindings.
      expect(frame).toContain("✓ read 12 lines")
      expect(frame).toContain("✕ write denied")
      expect(frame).toContain("hello from a.txt")
      expect(frame).toContain("note.content")
      // A result stored before counts existed listed the whole namespace.
      expect(frame).toContain("bindings: note")
      expect(frame).not.toContain("in all")
    }),
  )

  it.scopedLive("a cell result names the bindings it bound and counts them all", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <RegisteredToolMessageLists
            items={[
              cellBindingsMessage("call-cell-bound", ["note"], 3),
              cellBindingsMessage("call-cell-kept", [], 1),
            ]}
            fullDetail
          />
        ),
        { width: 100, height: 40 },
      )
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("call-cell-bound done") && next.includes("call-cell-kept done"),
        "cell bindings",
      )
      expect(frame).toContain("bound: note · 3 bindings in all")
      expect(frame).toContain("bound: none · 1 binding in all")
      expect(frame).not.toContain("bindings: note")
    }),
  )

  it.scopedLive("preview shows the head of the last output and names the rest", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [bashMessage("call-bash-7", 25)]
      const setup = yield* renderScoped(
        () => <MessageList items={items} disclosure="preview" syntaxStyle={syntaxStyle} />,
        { width: 80, height: 40 },
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("● Ran 1 command")
      expect(frame).toContain("└ Ran seq 25")
      expect(frame).toContain("│ row 1")
      expect(frame).toContain("│ row 5")
      expect(frame).not.toContain("row 6")
      expect(frame).toContain("│ … +20 lines (ctrl+o)")
    }),
  )

  it.scopedLive(
    "keeps the cell row across disclosure changes and renders transcript output once",
    () =>
      Effect.gen(function* () {
        const [disclosure, setDisclosure] = createSignal<DisclosureLevel>("preview")
        const [fullDetail, setFullDetail] = createSignal(false)
        const output = Array.from(
          { length: 25 },
          (_, index) => `CELL-OUTPUT-${String(index + 1).padStart(3, "0")}`,
        ).join("\n")
        const items = [cellMessage("call-stable", output)]
        const setup = yield* renderScoped(
          () => {
            const renderers = useToolRenderers()
            return (
              <Show when={renderers().size > 0}>
                <MessageList
                  items={items}
                  disclosure={disclosure()}
                  fullDetail={fullDetail()}
                  syntaxStyle={syntaxStyle}
                />
              </Show>
            )
          },
          { width: 110, height: 55 },
        )
        const preview = yield* waitForFrame(
          setup,
          (frame) => frame.includes("└ Wrote · failed"),
          "cell preview",
        )
        // The preview rows name the ops in past-tense words and no call id;
        // the failed op heads its own reason, never the cell's display.
        expect(preview).toContain("│ denied")
        expect(preview).not.toContain("CELL-OUTPUT")
        expect(preview).not.toContain("#call-stable")
        yield* Effect.sync(() => setDisclosure("full"))
        const full = yield* waitForFrame(
          setup,
          (frame) => frame.includes("CELL-OUTPUT-025") && frame.includes("note.content"),
          "full cell output",
        )
        // The open row names the cell, its line counts, and its id at the end.
        const row = Option.getOrThrow(
          Option.fromUndefinedOr(full.split("\n").find((line) => line.includes("└ cell"))),
        ).trim()
        expect(row).toContain("↑ 2 ↓ 25 lines")
        expect(row).toEndWith("#call-stable")
        const isOpenRow = (line: string) => line.trim() === row
        expect(full.match(/#call-stable/g)).toHaveLength(1)
        expect(full).not.toContain("… +5 lines")
        yield* Effect.sync(() => {
          setDisclosure("preview")
          setFullDetail(true)
        })
        const transcript = yield* waitForFrame(
          setup,
          (frame) => frame.includes("CELL-OUTPUT-025") && !frame.includes("2 tools ·"),
          "full transcript from preview",
        )
        expect(transcript.split("\n").some(isOpenRow)).toBe(true)
        expect(transcript).not.toContain("… +5 lines")
        for (let line = 1; line <= 25; line++) {
          const text = `CELL-OUTPUT-${String(line).padStart(3, "0")}`
          expect(transcript.split("\n").filter((value) => value.trim() === text)).toHaveLength(1)
        }
      }),
  )

  it.scopedLive("the glyph warns when only ops failed, and errs when a call failed", () =>
    Effect.gen(function* () {
      const cellWith = (id: string, status: ToolCall["status"], opStatus: ToolCall["status"]) =>
        assistantToolMessage(`assistant-${id}`, {
          id,
          toolName: "cell",
          status,
          input: { code: "await tools.bash({ command: 'x' })" },
          summary: absent,
          output: absent,
          operations: [
            { id: `${id}-op`, toolName: "bash", status: opStatus, input: { command: "x" } },
          ],
        })
      let colors = Option.none<ReturnType<typeof useTheme>["theme"]>()
      const setup = yield* renderScoped(
        () => {
          colors = Option.some(useTheme().theme)
          return (
            <box flexDirection="column">
              <MessageList
                items={[cellWith("glyph-done", "completed", "completed")]}
                disclosure="collapsed"
                syntaxStyle={syntaxStyle}
              />
              <MessageList
                items={[cellWith("glyph-warn", "completed", "error")]}
                disclosure="collapsed"
                syntaxStyle={syntaxStyle}
              />
              <MessageList
                items={[cellWith("glyph-fail", "error", "error")]}
                disclosure="collapsed"
                syntaxStyle={syntaxStyle}
              />
            </box>
          )
        },
        { width: 60, height: 30 },
      )
      const theme = Option.getOrThrow(colors)
      const glyphs = setup
        .captureSpans()
        .lines.flatMap((line) =>
          line.spans.filter((span) => /^\s*[●✗] Ran 1 command/.test(span.text)),
        )
        .map((span) => ({ glyph: span.text.trim().slice(0, 1), fg: span.fg }))
      expect(glyphs.map((entry) => entry.glyph)).toEqual(["●", "●", "✗"])
      expect(glyphs[0]?.fg.equals(theme.textMuted)).toBe(true)
      expect(glyphs[1]?.fg.equals(theme.warning)).toBe(true)
      expect(glyphs[2]?.fg.equals(theme.error)).toBe(true)
      expect(renderFrame(setup)).toContain("● Ran 1 command · 1 failed")
    }),
  )

  it.scopedLive("collapsed keeps the group header and hides finished rows and output", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [bashMessage("call-bash-8", 25)]
      const setup = yield* renderScoped(
        () => <MessageList items={items} disclosure="collapsed" syntaxStyle={syntaxStyle} />,
        { width: 80, height: 20 },
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("● Ran 1 command")
      expect(frame).not.toContain("└ Ran")
      expect(frame).not.toContain("row 1")
    }),
  )
})

describe("bash row line counts", () => {
  it.scopedLive("a bash row counts lines as its body does: a final newline ends a line", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        bashOutputMessage("call-one-line", { stdout: "hello\n", stderr: "" }),
        bashOutputMessage("call-two-streams", { stdout: "a\n", stderr: "b\n" }),
        bashOutputMessage("call-declined", {
          stdout: "Command blocked: destructive\n",
          stderr: "",
          status: "blocked",
        }),
        bashOutputMessage("call-background", {
          stdout: "started pid 42\nlog at /tmp/x\n",
          stderr: "",
          status: "background",
        }),
      ]
      // The open rows (the full level) count lines; the preview rows name the
      // command only. The four steps are one run: one group, a row each.
      const setup = yield* renderScoped(
        () => <MessageList items={items} disclosure="full" syntaxStyle={syntaxStyle} />,
        { width: 80, height: 60 },
      )
      const rows = renderFrame(setup)
        .split("\n")
        .filter((line) => /[├└] bash/.test(line))
        .map((line) => line.trim().split(/\s{2,}/)[0])
      expect(rows).toEqual([
        "├ bash echo hello · ↓ 1 line",
        "├ bash echo hello · ↓ 2 lines",
        "├ bash echo hello",
        "└ bash echo hello",
      ])
    }),
  )

  it.scopedLive("a cut bash row counts the whole output, as its body does", () =>
    Effect.gen(function* () {
      const list = yield* renderScoped(
        () => (
          <MessageList
            items={[assistantToolMessage("assistant-cut", cutBashCall)]}
            disclosure="full"
            syntaxStyle={syntaxStyle}
          />
        ),
        { width: 80, height: 30 },
      )
      const row = renderFrame(list)
        .split("\n")
        .find((line) => line.includes("└ bash"))
      expect(row?.trim().split(/\s{2,}/)[0]).toBe("└ bash seq 1 1000 · ↓ 1000 lines")
      const BashToolRenderer = builtinRenderer("bash")
      const body = yield* renderScoped(
        () => <BashToolRenderer expanded={true} toolCall={cutBashCall} />,
        {
          width: 80,
          height: 20,
        },
      )
      expect(renderFrame(body)).toContain("1000 lines")
    }),
  )
})

describe("compact file tool bodies", () => {
  // One owner spells the "more lines" footer, in the preview rows and in a closed frame.
  it.scopedLive("a closed generic frame names its hidden lines as the preview does", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <GenericToolRenderer
            expanded={false}
            toolCall={{
              id: "call-generic-footer",
              toolName: "unknown_fx_tool",
              status: "completed",
              input: absent,
              summary: "first line",
              output: "first line\nsecond line\nthird line",
            }}
          />
        ),
        { width: 80, height: 10 },
      )
      expect(renderFrame(setup)).toContain("… +2 lines (ctrl+o)")
    }),
  )
  it.scopedLive("keeps the first and last read lines with the omitted count", () =>
    Effect.gen(function* () {
      const lines = Array.from({ length: 10 }, (_, i) => `read-line-${i + 1}`)
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
        content: lines.join("\n"),
        lineCount: 10,
      })
      const setup = yield* renderScoped(() => (
        <ReadToolRenderer
          expanded={false}
          toolCall={{
            id: "read-excerpt",
            toolName: "read",
            status: "completed",
            input: { path: "/tmp/excerpt.txt" },
            summary: absent,
            output,
          }}
        />
      ))
      const frame = renderFrame(setup)
      expect(frame).toContain("read-line-1")
      expect(frame).toContain("read-line-3")
      expect(frame).toContain("read-line-8")
      expect(frame).toContain("read-line-10")
      expect(frame).toContain("4 more lines")
      expect(frame).not.toContain("read-line-4")
      expect(frame).not.toContain("read-line-7")
    }),
  )

  it.scopedLive("keeps the end of a long edit with an omitted-lines marker", () =>
    Effect.gen(function* () {
      const oldString = Array.from({ length: 10 }, (_, i) => `old-line-${i + 1}`).join("\n")
      const newString = Array.from({ length: 10 }, (_, i) => `new-line-${i + 1}`).join("\n")
      const setup = yield* renderScoped(() => (
        <EditToolRenderer
          expanded={false}
          toolCall={{
            id: "edit-excerpt",
            toolName: "edit",
            status: "completed",
            input: { path: "/tmp/excerpt.txt", oldString, newString },
            summary: absent,
            output: absent,
          }}
        />
      ))
      const frame = renderFrame(setup)
      expect(frame).toContain("new-line-10")
      expect(frame).toContain("more lines")
      expect(frame).not.toContain("old-line-5")
      expect(frame).not.toContain("new-line-5")
    }),
  )
})

// A reloaded 1000-line stdout keeps two head lines, the marker and two tail lines.
const cutBashCall: ToolCall = {
  id: "call-cut",
  toolName: "bash",
  status: "completed",
  input: { command: "seq 1 1000" },
  summary: absent,
  output: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
    stdout: "1\n2\n... [996 lines truncated] ...\n999\n1000",
    stderr: "",
    exitCode: 0,
  }),
  cuts: [OutputCut.cases.Text.make({ field: "stdout", lines: 1000, tailLine: 999, chars: 0 })],
}

const builtinRenderer = (tool: string) =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      BUILTIN_TOOL_RENDERERS.find((entry) => entry.toolNames.includes(tool))?.component,
    ),
  )

describe("cell frame header", () => {
  it.scopedLive("names the ops that ran once there are any, not the verbs its source spells", () =>
    Effect.gen(function* () {
      const CellToolRenderer = builtinRenderer("cell")
      const code =
        "const [a, b] = await Promise.all([tools.bash({command: 'sleep 2'}), tools.bash({command: 'git checkout HEAD -- a'})])"
      const header = (operations: ReadonlyArray<ToolCall>) =>
        renderScoped(
          () => (
            <CellToolRenderer
              expanded={false}
              toolCall={{
                id: "cell-header",
                toolName: "cell",
                status: "running",
                input: { code },
                summary: absent,
                output: absent,
                operations: [...operations],
              }}
            />
          ),
          { width: 100, height: 12 },
        ).pipe(Effect.map((setup) => renderFrame(setup).split("\n")[0] ?? ""))
      // No op has run: the source's verbs.
      expect(yield* header([])).toContain("cell bash ×2")
      // One op ran: that op, as the group header counts it.
      const ran = yield* header([
        {
          id: "op-sleep",
          toolName: "bash",
          status: "running",
          input: { command: "sleep 2" },
          summary: absent,
          output: absent,
        },
      ])
      expect(ran).toContain("cell bash sleep 2")
      expect(ran).not.toContain("×2")
    }),
  )
})

describe("transcript block spacing", () => {
  const cellStep = (index: number, command: string, stdout: string): ListMessage => {
    const toolCall: ToolCall = {
      id: `cell-${index}`,
      toolName: "cell",
      status: "completed",
      input: { code: `const r = await tools.bash({ command: "${command}" }); r` },
      summary: absent,
      output: encodeJson({
        display: `{ stdout: '${stdout.replaceAll("\n", "\\n")}', stderr: '', exitCode: 0 }`,
        bindings: ["r"],
        truncated: false,
      }),
      operations: [
        {
          id: `op-${index}`,
          toolName: "bash",
          status: "completed",
          input: { command },
          summary: absent,
          output: encodeJson({ stdout, stderr: "", exitCode: 0 }),
        },
      ],
    }
    return {
      _tag: "regular-message",
      id: `cell-step-${index}`,
      role: "assistant",
      content: "",
      reasoning: "",
      images: [],
      createdAt: index,
      segments: [{ _tag: "tool-call", toolCall }],
    }
  }
  const answer: ListMessage = {
    _tag: "regular-message",
    id: "cell-steps-done",
    role: "assistant",
    content: "done",
    reasoning: "",
    images: [],
    createdAt: 9,
    segments: [{ _tag: "text", content: "done" }],
  }
  const items: SessionItem[] = [
    cellStep(1, "git status --short", ""),
    cellStep(2, "seq 1 3", "1\n2\n3\n"),
    cellStep(3, "git log --oneline -1", "497f1c6 ledgerline\n"),
    answer,
  ]
  // The three tool-only steps are one run, one block, then the answer. The
  // full level parts the run's open rows by a blank line each, and the
  // transcript view (full detail) draws each step as its own block.
  const views: ReadonlyArray<{
    disclosure: DisclosureLevel
    fullDetail: boolean
    blocks: number
  }> = [
    { disclosure: "collapsed", fullDetail: false, blocks: 2 },
    { disclosure: "preview", fullDetail: false, blocks: 2 },
    { disclosure: "full", fullDetail: false, blocks: items.length },
    { disclosure: "collapsed", fullDetail: true, blocks: items.length },
  ]
  for (const view of views) {
    it.scopedLive(
      `one blank line separates each block at ${view.disclosure}, full detail ${view.fullDetail}`,
      () =>
        Effect.gen(function* () {
          const setup = yield* renderScoped(
            () => (
              <MessageList
                items={items}
                disclosure={view.disclosure}
                fullDetail={view.fullDetail}
                syntaxStyle={syntaxStyle}
              />
            ),
            { width: 100, height: 80 },
          )
          const lines = renderFrame(setup)
            .split("\n")
            .map((line) => line.trimEnd())
          const body = lines.slice(0, lines.findLastIndex((line) => line.length > 0) + 1)
          const blankRuns = body
            .join("\n")
            .split(/[^\n]+/)
            .map((run) => Math.max(0, run.length - 1))
            .filter((run) => run > 0)
          expect(blankRuns).toEqual(Array.from({ length: view.blocks - 1 }, () => 1))
          expect(body.findIndex((line) => line.trim() === "done")).toBeGreaterThan(0)
        }),
    )
  }

  const twoOpCell: ToolCall = {
    id: "cell-two-ops",
    toolName: "cell",
    status: "completed",
    input: {
      code: "await tools.bash({ command: 'seq 1 3' }); await tools.bash({ command: 'seq 4 6' })",
    },
    summary: absent,
    output: encodeJson({ display: "shown text", bindings: [], truncated: false }),
    operations: [
      {
        id: "two-op-1",
        toolName: "bash",
        status: "completed",
        input: { command: "seq 1 3" },
        summary: absent,
        output: encodeJson({ stdout: "1\n2\n3\n", stderr: "", exitCode: 0 }),
      },
      {
        id: "two-op-2",
        toolName: "bash",
        status: "completed",
        input: { command: "seq 4 6" },
        summary: absent,
        output: encodeJson({ stdout: "4\n5\n6\n", stderr: "", exitCode: 0 }),
      },
    ],
  }
  const builtinRenderers = () =>
    new Map(
      BUILTIN_TOOL_RENDERERS.flatMap((entry) =>
        entry.toolNames.map((name): [string, typeof entry.component] => [name, entry.component]),
      ),
    )
  for (const expanded of [false, true]) {
    it.scopedLive(
      `ops inside one cell and its shown text are one blank line apart, expanded ${expanded}`,
      () =>
        Effect.gen(function* () {
          const CellToolRenderer = builtinRenderer("cell")
          // The transcript view draws each op on its own, the two commands too.
          const setup = yield* renderScoped(
            () => (
              <ToolRenderersProvider value={builtinRenderers}>
                <FoldOperationsProvider value={false}>
                  <CellToolRenderer expanded={expanded} toolCall={twoOpCell} />
                </FoldOperationsProvider>
              </ToolRenderersProvider>
            ),
            { width: 100, height: 40 },
          )
          const lines = renderFrame(setup)
            .split("\n")
            .map((line) => line.trimEnd())
          // Row 0 is the cell's header, which names both ops; the second op's
          // own header is the next row that does.
          const second = lines.findIndex(
            (line, index) => index > 0 && line.includes("bash seq 4 6"),
          )
          const shown = lines.findIndex((line) => line.trim() === "shown text")
          expect(second).toBeGreaterThan(1)
          expect(shown).toBeGreaterThan(second)
          // The row above each later block is blank, and the row above that is
          // the earlier block's last row: one blank line, not zero or two.
          expect(lines[second - 1]?.trim()).toBe("")
          expect(lines[second - 2]?.trim().length).toBeGreaterThan(0)
          expect(lines[shown - 1]?.trim()).toBe("")
          expect(lines[shown - 2]?.trim().length).toBeGreaterThan(0)
        }),
    )
  }

  it.scopedLive("a run of one tool's ops folds into one frame that a click opens", () =>
    Effect.gen(function* () {
      const CellToolRenderer = builtinRenderer("cell")
      const reads: ReadonlyArray<ToolCall> = Array.from({ length: 30 }, (_, index) => ({
        id: `fold-read-${index}`,
        toolName: "read",
        status: "completed",
        input: { path: `/workspace/src/file-${index}.ts` },
        // The read tool's own summary: the absolute path, then the count.
        summary: `/workspace/src/file-${index}.ts · 3 lines`,
        output: encodeJson({ content: "1\ta\n2\tb\n3\tc", lineCount: 3 }),
      }))
      const foldedCell: ToolCall = {
        ...twoOpCell,
        id: "cell-thirty-reads",
        operations: [...reads, ...(twoOpCell.operations ?? [])],
      }
      // The transcript view, where the mouse is on and a frame takes clicks.
      const setup = yield* renderScoped(
        () => (
          <FrameClicks on>
            <ToolRenderersProvider value={builtinRenderers}>
              <CellToolRenderer expanded={true} toolCall={foldedCell} />
            </ToolRenderersProvider>
          </FrameClicks>
        ),
        { width: 100, height: 120 },
      )
      const frame = renderFrame(setup)
      // Thirty reads draw one frame, its body a tight list; the two commands another.
      expect(frame.match(/● read 30 files/g)).toHaveLength(1)
      expect(frame.match(/● bash 2 commands/g)).toHaveLength(1)
      // An op row has the shape of the tool's own row: the path once, then its count.
      expect(frame).toContain("✓ /workspace/src/file-0.ts · 3 lines")
      expect(frame).not.toContain("file-0.ts /workspace")
      expect(frame).toContain("✓ /workspace/src/file-29.ts")
      // The list has no blank line between its rows.
      const lines = frame.split("\n").map((line) => line.trim())
      const first = lines.findIndex((line) => line.includes("file-0.ts · 3 lines"))
      expect(lines[first + 1]).toContain("file-1.ts")
      // A click on the folded frame's header opens each read as its own frame.
      const row = lines.findIndex((line) => line.startsWith("● read 30 files"))
      yield* Effect.promise(() => setup.mockMouse.click(4, row))
      const opened = yield* waitForFrame(
        setup,
        (next) => next.includes("● read /workspace/src/file-0.ts"),
        "the folded reads opened",
      )
      expect(opened).toContain("● read /workspace/src/file-29.ts")
    }),
  )

  it.scopedLive(
    "a wrapped code line and a wrapped op row hang under their own text, not at the frame's edge",
    () =>
      Effect.gen(function* () {
        const CellToolRenderer = builtinRenderer("cell")
        const reads: ReadonlyArray<ToolCall> = [0, 1].map((index) => ({
          id: `hang-read-${index}`,
          toolName: "read",
          status: "completed",
          input: { path: `/workspace/a-rather-long-directory-name/file-${index}.ts` },
          summary: `/workspace/a-rather-long-directory-name/file-${index}.ts · 3 lines`,
          output: encodeJson({ content: "1\ta\n2\tb\n3\tc", lineCount: 3 }),
        }))
        const cell: ToolCall = {
          ...twoOpCell,
          id: "cell-hang",
          input: {
            code: "await tools.edit({ path: 'gent-debug-tools/a.ts', oldString: 'hello', newString: 'hello, world' })",
          },
          operations: [...reads],
        }
        const setup = yield* renderScoped(
          () => (
            <ToolRenderersProvider value={builtinRenderers}>
              <CellToolRenderer expanded={true} toolCall={cell} />
            </ToolRenderersProvider>
          ),
          { width: 44, height: 40 },
        )
        const lines = renderFrame(setup).split("\n")
        const indent = (line: string) => line.length - line.trimStart().length
        // The code line wraps; each continuation starts where the code starts.
        const code = lines.findIndex((line) => line.includes("1 │ await"))
        const codeColumn = (lines[code] ?? "").indexOf("await")
        expect(code).toBeGreaterThanOrEqual(0)
        expect(lines[code + 1]?.trim().length).toBeGreaterThan(0)
        expect(indent(lines[code + 1] ?? "")).toBe(codeColumn)
        // The op row wraps; its continuation starts past the outcome glyph.
        const op = lines.findIndex((line) => line.includes("✓ /workspace"))
        const opColumn = (lines[op] ?? "").indexOf("/workspace")
        expect(op).toBeGreaterThanOrEqual(0)
        expect(lines[op + 1]?.includes("✓")).toBe(false)
        expect(indent(lines[op + 1] ?? "")).toBe(opColumn)
      }),
  )

  it.scopedLive(
    "native history keeps one blank line between committed blocks in full disclosure",
    () =>
      Effect.gen(function* () {
        const savedText: string[] = []
        const [disclosure, setDisclosure] = createSignal<DisclosureLevel>("collapsed")
        let extensionsLoaded = () => false
        const history: SessionItem[] = [
          userMessage("regular-message", "cells-prompt", "run three steps"),
          ...items,
        ]
        const setup = yield* renderScoped(
          () => {
            const renderer = useRenderer()
            extensionsLoaded = useExtensionUI().loaded
            const capture = (event: CliRendererExternalOutputEvent) => {
              savedText.push(committedTextOf(event, true))
            }
            renderer.on("external_output", capture)
            onCleanup(() => renderer.off("external_output", capture))
            // The footer under the transcript is as tall as the transcript is told.
            return (
              <box flexDirection="column" flexGrow={1}>
                <Transcript items={history} disclosure={disclosure()} />
                <box height={3} flexShrink={0} />
              </box>
            )
          },
          { width: 100, height: 20 },
        )
        yield* untilExtensionsLoaded(setup, () => extensionsLoaded(), "3 seconds")
        // Each level change replays the whole history; the last replay is the one on screen.
        const levels: ReadonlyArray<DisclosureLevel> = ["preview", "full"]
        for (const level of levels) {
          savedText.splice(0)
          setDisclosure(level)
          // The replay moves the rows above the live tail to history; it is done
          // once history and the frame show the first prompt, once, and hold.
          let last = ""
          yield* Effect.promise(() => setup.flush()).pipe(
            Effect.repeat({
              until: () => {
                const next = savedText.join("") + renderFrame(setup)
                const done = next === last && next.split("run three steps").length === 2
                last = next
                return done
              },
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("4 seconds"),
            Effect.ignore,
          )
          yield* Effect.promise(() => setup.renderOnce())
        }
        const lines = (savedText.join("") + renderFrame(setup))
          .split("\n")
          .map((line) => line.trimEnd())
        const body = lines.slice(0, lines.findLastIndex((line) => line.length > 0) + 1)
        const blankRuns = body
          .join("\n")
          .split(/[^\n]+/)
          .map((run) => Math.max(0, run.length - 1))
          .filter((run) => run > 0)
        expect(body.some((line) => line.includes("git log --oneline -1"))).toBe(true)
        // One blank line between blocks, and inside each open cell one between
        // its code, its op and its shown text.
        const cells = items.length - 1
        expect(blankRuns).toEqual(Array.from({ length: history.length - 1 + 2 * cells }, () => 1))
      }),
  )
})

const GrepToolRenderer = Option.getOrThrow(
  Option.fromUndefinedOr(
    BUILTIN_TOOL_RENDERERS.find((entry) => entry.toolNames.includes("grep"))?.component,
  ),
)

describe("expanded grep body", () => {
  it.scopedLive("a cut result draws its total and a gap between head and tail matches", () =>
    Effect.gen(function* () {
      const matches = [
        { file: "src/a.ts", line: 1, content: "head one" },
        { file: "src/a.ts", line: 2, content: "head two" },
        { file: "src/a.ts", line: 90, content: "tail one" },
        { file: "src/b.ts", line: 5, content: "tail two" },
      ]
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
        matches,
        truncated: false,
      })
      const setup = yield* renderScoped(
        () => (
          <GrepToolRenderer
            expanded={true}
            toolCall={{
              id: "grep-cut",
              toolName: "grep",
              status: "completed",
              input: { pattern: "one" },
              summary: "50 matches for one",
              output,
              cuts: [
                OutputCut.cases.Items.make({
                  field: "matches",
                  items: 50,
                  tailItem: 49,
                  files: 7,
                }),
              ],
            }}
          />
        ),
        { width: 80, height: 30 },
      )
      const lines = renderFrame(setup)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      expect(lines).toContain("50 matches in 7 files")
      const headTwo = lines.findIndex((line) => line.endsWith("head two"))
      const gap = lines.findIndex((line) => line === "· ··· 46 more matches")
      const tailOne = lines.findIndex((line) => line.endsWith("tail one"))
      expect(headTwo).toBeGreaterThan(-1)
      expect(gap).toBeGreaterThan(headTwo)
      expect(tailOne).toBeGreaterThan(gap)
      // The same file on both sides of the cut draws its name again after the gap.
      expect(lines.slice(gap + 1, tailOne).some((line) => line.includes("src/a.ts"))).toBe(true)
    }),
  )

  it.scopedLive("a result with no body draws the summary expanded as it does collapsed", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <GrepToolRenderer
            expanded={true}
            toolCall={{
              id: "grep-no-body",
              toolName: "grep",
              status: "completed",
              input: { pattern: "one" },
              summary: "900 matches for one",
              output: absent,
            }}
          />
        ),
        { width: 80, height: 20 },
      )
      expect(renderFrame(setup)).toContain("900 matches for one")
    }),
  )

  // Grep reports absolute paths; the body names each file from the cwd, as the group row does.
  it.scopedLive("file headings read from the cwd, collapsed and expanded", () =>
    Effect.gen(function* () {
      const cwd = "/work/proj"
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
        matches: [{ file: `${cwd}/apps/tui/src/ops.ts`, line: 3, content: "match here" }],
        truncated: false,
      })
      const frames = yield* Effect.forEach([false, true], (expanded) =>
        Effect.gen(function* () {
          const setup = yield* renderScoped(
            () => (
              <GrepToolRenderer
                expanded={expanded}
                toolCall={{
                  id: "grep-abs",
                  toolName: "grep",
                  status: "completed",
                  input: { pattern: "match" },
                  summary: absent,
                  output,
                }}
              />
            ),
            { width: 100, height: 20, cwd },
          )
          const frame = renderFrame(setup)
          destroyRenderSetup(setup)
          return frame
        }),
      )
      for (const frame of frames) {
        expect(frame).toContain("apps/tui/src/ops.ts")
        expect(frame).not.toContain(cwd)
      }
    }),
  )
})

describe("write body", () => {
  // Preview draws one row a call, and the full level opens the renderer's body;
  // neither draws the call's raw result.
  it.scopedLive("a write is one row in the preview and its renderer's body when open", () =>
    Effect.gen(function* () {
      const cwd = "/work/proj"
      const path = `${cwd}/apps/tui/src/ops.ts`
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
        path,
        bytesWritten: 7373,
      })
      const items: SessionItem[] = [
        assistantToolMessage("assistant-write-preview", {
          id: "write-preview",
          toolName: "write",
          status: "completed",
          input: { path, content: "x" },
          summary: absent,
          output,
        }),
      ]
      const setup = yield* renderScoped(
        () => {
          const renderers = useToolRenderers()
          return (
            <Show when={renderers().size > 0}>
              <MessageList items={items} disclosure="preview" syntaxStyle={syntaxStyle} />
              <MessageList items={items} disclosure="full" syntaxStyle={syntaxStyle} />
            </Show>
          )
        },
        { width: 100, height: 20, cwd },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("written"), "the open body")
      expect(frame.split("\n").map((line) => line.trim())).toContain("└ Wrote apps/tui/src/ops.ts")
      expect(frame.match(/7\.2 KB written/g)).toHaveLength(1)
      expect(frame).not.toContain("bytesWritten")
      expect(frame).not.toContain(cwd)
    }),
  )
  // The header names the file, so the open body says only what the write did.
  it.scopedLive("an open write frame draws no raw path under its header", () =>
    Effect.gen(function* () {
      const cwd = "/work/proj"
      const path = `${cwd}/apps/tui/src/ops.ts`
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
        path,
        bytesWritten: 7373,
      })
      const WriteToolRenderer = builtinRenderer("write")
      const setup = yield* renderScoped(
        () => (
          <WriteToolRenderer
            expanded={true}
            toolCall={{
              id: "write-abs",
              toolName: "write",
              status: "completed",
              input: { path, content: "x" },
              summary: absent,
              output,
            }}
          />
        ),
        { width: 100, height: 10, cwd },
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("write apps/tui/src/ops.ts")
      expect(frame).toContain("7.2 KB written")
      expect(frame).not.toContain(cwd)
    }),
  )
})

describe("read_session row", () => {
  // A count of one reads singular, like every other count row.
  const counts = [
    { messages: 4, branches: 2, shown: "✓ 4 messages, 2 branches" },
    { messages: 1, branches: 1, shown: "✓ 1 message, 1 branch" },
  ]
  for (const { messages, branches, shown } of counts)
    it.scopedLive(`draws ${shown}`, () =>
      Effect.gen(function* () {
        const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
          sessionId: "session-read-1234",
          content: "READ-SESSION-TREE",
          messageCount: messages,
          branchCount: branches,
        })
        const items: SessionItem[] = [
          assistantToolMessage("assistant-read-session", {
            id: "call-read-session",
            toolName: "read_session",
            status: "completed",
            input: { sessionId: "session-read-1234" },
            summary: absent,
            output,
          }),
        ]
        const setup = yield* renderScoped(
          () => <MessageList items={items} disclosure="full" syntaxStyle={syntaxStyle} />,
          { width: 100, height: 40 },
        )
        const frame = yield* waitForFrame(setup, (text) => text.includes(shown), "read_session row")
        // The count ends its row: `1 branch` is not the start of `1 branches`.
        const row = frame.split("\n").find((line) => line.includes(shown)) ?? ""
        expect(row.trimEnd().endsWith(shown)).toBe(true)
      }),
    )

  it.scopedLive("a long read is cut after 500 characters, never inside an emoji", () =>
    Effect.gen(function* () {
      // 499 characters of short lines, then a toned emoji as the 500th.
      const content = `${"ab\n".repeat(166)}a👍🏽TAIL`
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
        sessionId: "session-read-1234",
        content,
        messageCount: 4,
      })
      const items: SessionItem[] = [
        assistantToolMessage("assistant-read-session", {
          id: "call-read-session",
          toolName: "read_session",
          status: "completed",
          input: { sessionId: "session-read-1234" },
          summary: absent,
          output,
        }),
      ]
      const setup = yield* renderScoped(
        () => <MessageList items={items} disclosure="full" syntaxStyle={syntaxStyle} />,
        { width: 100, height: 200 },
      )
      const cutLine = (text: string) =>
        Option.fromNullishOr(
          text.split("\n").find((line) => line.trim().startsWith("a") && line.includes("…")),
        ).pipe(Option.map((line) => line.trim()))
      const frame = yield* waitForFrame(setup, (text) => Option.isSome(cutLine(text)), "the cut")
      expect(cutLine(frame)).toEqual(Option.some("a👍🏽…"))
      expect(frame).not.toContain("TAIL")
    }),
  )

  // A cell draws each op as a collapsed sub-row. A click on the row's header
  // opens it, and the open row shows what the read returned.
  it.scopedLive("a read_session op opened by a click shows the session it read", () =>
    Effect.gen(function* () {
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
        sessionId: "session-read-1234",
        content: "READ-SESSION-TREE",
        messageCount: 4,
        branchCount: 2,
      })
      const cell: ToolCall = {
        id: "call-cell-read",
        toolName: "cell",
        status: "completed",
        input: { code: "await tools.read_session({sessionId: 'session-read-1234'})" },
        summary: absent,
        output: absent,
        operations: [
          {
            id: "op-read-session",
            toolName: "read_session",
            status: "completed",
            input: { sessionId: "session-read-1234" },
            summary: "done",
            output,
          },
        ],
      }
      // The transcript view, where the mouse is on and a frame takes clicks.
      const setup = yield* renderScoped(
        () => (
          <FrameClicks on>
            <MessageList
              items={[assistantToolMessage("assistant-cell-read", cell)]}
              disclosure="full"
              syntaxStyle={syntaxStyle}
            />
          </FrameClicks>
        ),
        { width: 100, height: 40 },
      )
      const closed = yield* waitForFrame(
        setup,
        (next) => next.includes("4 messages"),
        "the collapsed read_session op",
      )
      expect(closed).toContain("✓ 4 messages, 2 branches")
      expect(closed).not.toContain("READ-SESSION-TREE")
      const rows = closed.split("\n")
      const row = rows.findIndex((line) => line.includes("read_session") && line.includes("▸"))
      expect(row).toBeGreaterThanOrEqual(0)
      const column = (rows[row] ?? "").indexOf("read_session")
      yield* Effect.promise(() => setup.mockMouse.click(column, row))
      const open = yield* waitForFrame(
        setup,
        (next) => next.includes("READ-SESSION-TREE"),
        "the opened read_session op",
      )
      expect(open).toContain("✓ 4 messages, 2 branches")
    }),
  )
})

describe("write row", () => {
  // The path is the call's input, so the header names the file before the write lands.
  it.scopedLive("a running write op names its file", () =>
    Effect.gen(function* () {
      const cell: ToolCall = {
        id: "call-cell-write",
        toolName: "cell",
        status: "running",
        input: { code: "await tools.write({path: '/workspace/src/fresh-file.ts'})" },
        summary: absent,
        output: absent,
        operations: [
          {
            id: "op-write",
            toolName: "write",
            status: "running",
            input: { path: "/workspace/src/fresh-file.ts", content: "export {}" },
            summary: absent,
            output: absent,
          },
        ],
      }
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[assistantToolMessage("assistant-cell-write", cell)]}
            disclosure="full"
            syntaxStyle={syntaxStyle}
          />
        ),
        { width: 100, height: 40 },
      )
      // The op's own header row, apart from the cell row that also names the file.
      const opRow = (next: string) =>
        next.split("\n").find((line) => line.includes("#op-write")) ?? ""
      const frame = yield* waitForFrame(
        setup,
        (next) => opRow(next).includes("fresh-file.ts"),
        "the running write op header",
      )
      expect(opRow(frame)).toContain("fresh-file.ts")
    }),
  )
})

// ── native transcript markdown ──────────────────────────────────────────────

/** An answer as the streaming path writes it: `_tag` first, and no metadata. */
const assistant = (id: string, content: string): ListMessage => ({
  _tag: "regular-message",
  id,
  role: "assistant",
  content,
  reasoning: "",
  images: [],
  createdAt: 0,
  segments: [{ _tag: "text", content }],
})

/** A prompt the reader typed: the server stamps its client origin. */
const clientPrompt = (id: string, text: string): ListMessage => ({
  ...userMessage("regular-message", id, text),
  metadata: { fromClient: true },
})

describe("native transcript markdown", () => {
  it.scopedLive("a message enters native history with its markdown concealed", () =>
    Effect.gen(function* () {
      const savedText: string[] = []
      const firstCommit = yield* Deferred.make<void>()
      const body = Array.from({ length: 12 }, (_, index) => `line ${index + 1} of the answer`).join(
        "\n\n",
      )
      const items = [
        assistant("first", `## Known, pre-existing\n${body}\n\nsee \`money.test.ts\` for the rest`),
        // A later answer pushes the first above the live tail, so it commits.
        assistant("later", longBody("LATER")),
        assistant("second", "ANSWER-END"),
      ]
      const setup = yield* renderScoped(
        () => {
          const renderer = useRenderer()
          const capture = (event: CliRendererExternalOutputEvent) => {
            savedText.push(committedTextOf(event))
            Deferred.doneUnsafe(firstCommit, Effect.void)
          }
          renderer.on("external_output", capture)
          onCleanup(() => renderer.off("external_output", capture))
          return <Transcript items={items} />
        },
        { width: 60, height: 14 },
      )
      yield* Effect.promise(() => setup.flush())
      yield* Deferred.await(firstCommit)
      yield* Effect.promise(() => setup.flush())
      const history = savedText.join("")
      expect(history).toContain("Known, pre-existing")
      expect(history).toContain("money.test.ts")
      expect(history).not.toContain("## ")
      expect(history).not.toContain("`")
    }).pipe(Effect.timeout("10 seconds")),
  )

  // Scrollback is immutable, so a row that reaches it without its highlight
  // keeps that look for good. A highlight can miss its budget (a cold
  // tree-sitter worker, a loaded machine) or never land (a dead worker).
  it.scopedLive(
    "headings reach history without their marks when no highlight ever lands",
    () =>
      Effect.gen(function* () {
        const timeouts = makeSettleTimeouts(Number.MAX_SAFE_INTEGER)
        const committedText: string[] = []
        const sections = Array.from(
          { length: 8 },
          (_, index) => `## Section ${index + 1}\n\nbody ${index + 1}`,
        )
        // A later answer pushes the first above the live tail, so it commits whole.
        const items = [
          assistant("first", sections.join("\n\n")),
          assistant("later", longBody("LATER")),
          assistant("second", "TAIL"),
        ]
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              onRenderer={(renderer) => {
                timeouts.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({
            until: () => committedText.join("").includes("Section 8"),
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("8 seconds"),
          Effect.ignore,
        )
        const history = committedText.join("")
        for (const section of sections.keys()) {
          expect(history).toContain(`Section ${section + 1}`)
        }
        expect(history).not.toContain("#")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // A highlight that never lands leaves a code block and a quote with no
  // text to draw, and one that fails puts back the raw markdown, marks and
  // all. Past its last try an answer commits as plain text the transcript
  // draws itself: the heading without its marks, the code and the quote as
  // their text.
  for (const outage of ["stalled", "failing"] as const) {
    it.scopedLive(
      `an answer whose highlight is ${outage} reaches history readable`,
      () =>
        Effect.gen(function* () {
          yield* highlightOutage(outage)
          const timeouts = makeSettleTimeouts(Number.MAX_SAFE_INTEGER)
          const committedText: string[] = []
          const answer = [
            "## HEADING-MARKS",
            "Some **bold** words.",
            "```ts\nconst CODE_BODY = 1\n```",
            "> QUOTE_BODY quoted",
            "- LIST_ITEM one",
          ].join("\n\n")
          // A later answer pushes the first above the live tail, so it commits.
          const items = [
            assistant("first", answer),
            assistant("later", longBody("LATER")),
            assistant("second", "TAIL"),
          ]
          yield* renderScoped(
            () => (
              <Transcript
                items={items}
                onRenderer={(renderer) => {
                  timeouts.applyTo(renderer)
                  renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                    committedText.push(committedTextOf(event))
                  })
                }}
              />
            ),
            { width: 60, height: 14 },
          ).pipe(
            Effect.tap((setup) =>
              Effect.promise(() => setup.flush()).pipe(
                Effect.repeat({
                  until: () => committedText.join("").includes("LIST_ITEM"),
                  schedule: Schedule.spaced("10 millis"),
                }),
                Effect.timeout("6 seconds"),
                Effect.ignore,
              ),
            ),
          )
          const history = committedText.join("")
          for (const text of ["HEADING-MARKS", "bold", "CODE_BODY", "QUOTE_BODY", "LIST_ITEM"])
            expect(history).toContain(text)
          expect(history).not.toContain("#")
          expect(history).not.toContain("**")
          expect(history).not.toContain("```")
        }).pipe(Effect.timeout("10 seconds")),
      15_000,
    )
  }

  it.scopedLive(
    "a settle that times out is tried again, so history keeps the highlight",
    () =>
      Effect.gen(function* () {
        const timeouts = makeSettleTimeouts(1)
        // The snapshot is freed once the event returns, so its cells are read in the handler.
        const committed: Option.Option<ReadonlyArray<number>>[] = []
        const items = [
          assistant("first", `## Highlighted heading\n\n${longBody("BODY")}`),
          assistant("second", "TAIL"),
        ]
        const setup = yield* renderScoped(
          () => {
            const renderer = useRenderer()
            timeouts.applyTo(renderer)
            const capture = (event: CliRendererExternalOutputEvent) =>
              committed.push(cellsOf(event, "Highlighted heading"))
            renderer.on("external_output", capture)
            onCleanup(() => renderer.off("external_output", capture))
            return (
              <Transcript
                items={items}
                renderItems={(visible) => (
                  <MessageList items={visible} disclosure="collapsed" syntaxStyle={boldHeadings} />
                )}
              />
            )
          },
          { width: 60, height: 14 },
        )
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({
            until: () => committed.length > 0,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("8 seconds"),
          Effect.ignore,
        )
        const heading = Option.getOrThrow(Option.firstSomeOf(committed))
        // The first settle timed out before the highlight; the commit waited for a second.
        expect(timeouts.calls()).toBeGreaterThanOrEqual(2)
        expect(heading.every((attributes) => (attributes & TextAttributes.BOLD) !== 0)).toBe(true)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})

/** Headings draw bold once highlighted; the draft before the highlight is plain. */
const boldHeadings = () =>
  SyntaxStyle.fromTheme([
    {
      scope: ["markup.heading", "markup.heading.1", "markup.heading.2"],
      style: { bold: true },
    },
  ])

/** The attributes of each cell of `text` in a committed snapshot, or `None` when it is not there. */
const cellsOf = (
  event: CliRendererExternalOutputEvent,
  text: string,
): Option.Option<ReadonlyArray<number>> => {
  const { snapshot } = event
  const { char, attributes } = snapshot.buffers
  for (let row = 0; row < snapshot.height; row++) {
    const line = Array.from({ length: snapshot.width }, (_, column) =>
      String.fromCodePoint(char[row * snapshot.width + column] ?? 32),
    ).join("")
    const at = line.indexOf(text)
    if (at === -1) continue
    return Option.some(
      Array.from(
        { length: text.length },
        (_, offset) => attributes[row * snapshot.width + at + offset] ?? 0,
      ),
    )
  }
  return Option.none()
}

// ── native transcript footer room ───────────────────────────────────────────

/** A long resumed session: a model switch, four child completions, a cell with two ops. */
const longHistory = (): SessionItem[] => {
  const childCompletion = (index: number): ListMessage => ({
    ...assistant(`child-${index}`, `child ${index} finished\nCHILD-${index} answer`),
    role: "user",
    segments: absent,
    metadata: {
      customType: CHILD_COMPLETION_TYPE,
      details: { sessionId: `child-session-${index}`, agentName: "delegate", outcome: {} },
    },
  })
  const cellWithOps = assistantToolMessage("assistant-cell-ops", {
    id: "call-cell-ops",
    toolName: "cell",
    status: "completed",
    input: { code: "await tools.read({path: 'a.md'}); await tools.bash({command: 'ls'})" },
    summary: absent,
    output: encodeJson({ display: "done" }),
    operations: [
      {
        id: "op-read",
        toolName: "read",
        status: "completed",
        input: { path: "a.md" },
        summary: "3 lines",
        output: absent,
      },
      {
        id: "op-bash",
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
        summary: "exit 0",
        output: absent,
      },
    ],
  })
  return [
    assistant("a1", longBody("EARLY")),
    {
      ...compactionMessage(),
      id: "model-change:b1:m2",
      metadata: { customType: MODEL_CHANGE_MESSAGE_TYPE },
    },
    ...[1, 2, 3, 4].map(childCompletion),
    cellWithOps,
    assistant("a2", "one\ntwo\nthree"),
    assistant("a3", "four\nfive"),
    assistant("a4", "LAST-ANSWER"),
  ]
}

describe("native transcript footer room", () => {
  it.scopedLive(
    "a long session leaves the status line and the tray on screen",
    () =>
      Effect.gen(function* () {
        const firstCommit = yield* Deferred.make<void>()
        const setup = yield* renderScoped(
          () => {
            const renderer = useRenderer()
            const capture = () => Deferred.doneUnsafe(firstCommit, Effect.void)
            renderer.on("external_output", capture)
            onCleanup(() => renderer.off("external_output", capture))
            const [footer, setFooter] = createSignal(4)
            return (
              <box flexDirection="column" flexGrow={1}>
                <Transcript items={longHistory()} footerHeight={footer()} />
                <box
                  flexDirection="column"
                  flexShrink={0}
                  onSizeChange={function () {
                    setFooter(this.height)
                  }}
                >
                  <text>COMPOSER</text>
                  <text>STATUS-LINE</text>
                  <text>TRAY-ROW</text>
                </box>
              </box>
            )
          },
          { width: 107, height: 26 },
        )
        yield* Deferred.await(firstCommit)
        // The footer region is the terminal less the rows kept for scrollback:
        // the live tail and the footer share it, so the last footer row stays on screen.
        const frame = yield* waitForFrame(
          setup,
          (next) => next.includes("LAST-ANSWER") && next.includes("TRAY-ROW"),
          "footer on screen",
        )
        expect(frame).toContain("STATUS-LINE")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})

// ── native transcript rows under the footer ─────────────────────────────────

/**
 * The split region sits on the terminal's last rows. OpenTUI keeps the
 * region's top row when it shrinks, so a shrink that no commit fills leaves
 * the freed rows empty under the status row. These tests read the region's
 * place from the renderer: its top offset plus its height is the terminal's
 * height when no row is left under it.
 */

/** The renderer's region offset: the terminal rows above the split region. OpenTUI keeps it private. */
const RegionPlace = Schema.Struct({ renderOffset: Schema.Finite })

/** The rows between the split region's last row and the terminal's last row. */
const rowsUnderRegion = (renderer: CliRenderer): number =>
  renderer.terminalHeight -
  (Schema.decodeUnknownSync(RegionPlace)(renderer).renderOffset + renderer.height)

// OpenTUI writes each committed row, then erases to the line's end. After a
// row that fills the terminal's last column, the cursor still sits on that
// column (the wrap is pending), so an xterm-like terminal erases the row's
// last character: a table's right border is lost in history. Committed rows
// keep the last column free.
describe("native transcript rows in history", () => {
  it.scopedLive("a small answer table fits its content with space inside each border", () =>
    Effect.gen(function* () {
      const table = "| Name | Place |\n| --- | --- |\n| gent | home |"
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[assistant("table", table)]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
          />
        ),
        { width: 120, height: 14 },
      )
      const frame = yield* waitForFrame(
        setup,
        (text) => text.includes("gent") && text.includes("┌"),
        "the answer table",
      )
      expect(frame).toContain("│ Name │ Place │")
      expect(frame).toContain("│ gent │ home  │")
      const top = frame.split("\n").find((row) => row.includes("┌"))
      expect(top?.trim()).toBe("┌──────┬───────┐")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive(
    "a table wider than the answer keeps its right border in history",
    () =>
      Effect.gen(function* () {
        const width = 45
        const committedRows: string[] = []
        const table = [
          "| Name | Purpose | Where it lives |",
          "| --- | --- | --- |",
          "| NativeTranscript | owns native history snapshots | apps/tui/src/message-list.tsx |",
          "| DockFooter | the footer column the panes dock in | apps/tui/src/ui.tsx |",
        ].join("\n")
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={[
                assistant("table", `TABLE-ANSWER\n\n${table}`),
                assistant("tail", longBody("TAIL")),
              ]}
              onRenderer={(renderer) => {
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  const text = committedTextOf(event, true)
                  committedRows.push(...text.split("\n"))
                })
              }}
            />
          ),
          { width, height: 14 },
        )
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({
            until: () => committedRows.some((row) => row.includes("└")),
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("6 seconds"),
        )
        const tableRows = committedRows.filter((row) => /[┌├│└]/.test(row))
        expect(tableRows.some((row) => row.includes("└"))).toBe(true)
        // The cells wrap to fit the answer: more rows than the source's four.
        expect(tableRows.length).toBeGreaterThan(4)
        for (const row of tableRows) {
          expect(row.trimEnd()).toMatch(/[┐┤│┘]$/)
          expect(Bun.stringWidth(row.trimEnd())).toBeLessThan(width)
        }
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})

describe("native transcript rows under the footer", () => {
  // A short session's region sits under the shell's last line, with the
  // terminal's own empty rows under it. A pane grows the region into them,
  // and closing it gives them back: no empty row stays above the composer.
  it.scopedLive(
    "a docked pane that closes in a short session leaves no empty row above the composer",
    () =>
      Effect.gen(function* () {
        const [footer, setFooter] = createSignal(3)
        let screen = Option.none<CliRenderer>()
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={[assistant("short", "SHORT-ANSWER"), assistant("tail", "TAIL")]}
              footerHeight={footer()}
              onRenderer={(renderer) => {
                screen = Option.some(renderer)
              }}
            />
          ),
          { width: 60, height: 30 },
        )
        yield* waitForFrame(setup, (next) => next.includes("TAIL"), "the live tail")
        const renderer = Option.getOrThrow(screen)
        yield* Effect.promise(() => setup.flush())
        const regionRows = renderer.footerHeight
        // The region is not at the terminal's bottom: the session is short.
        expect(rowsUnderRegion(renderer)).toBeGreaterThan(0)
        // A pane docks in the footer, then closes.
        setFooter(9)
        yield* Effect.promise(() => setup.flush())
        yield* Effect.promise(() => setup.flush())
        expect(renderer.footerHeight).toBe(regionRows + 6)
        setFooter(3)
        yield* Effect.promise(() => setup.flush())
        yield* Effect.promise(() => setup.flush())
        expect(renderer.footerHeight).toBe(regionRows)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // A short session's region starts on the screen's top row. A picker draws
  // on the alternate screen; its return gives the region back on that row,
  // as it was. A region put a row lower, or at the bottom rows the picker's
  // screen mode pinned, leaves its old rows on screen above it, and the
  // rows of the next turn go where the terminal does not show them.
  it.scopedLive(
    "a picker that closes over a short session gives the region back on the screen's top row",
    () =>
      Effect.gen(function* () {
        const [items, setItems] = createSignal<ListMessage[]>([
          clientPrompt("ask", "FIRST-ASK"),
          assistant("short", "SHORT-ANSWER"),
        ])
        const [footer, setFooter] = createSignal(3)
        const [paneOpen, setPaneOpen] = createSignal(false)
        const [overlayOpen, setOverlayOpen] = createSignal(false)
        let screen = Option.none<CliRenderer>()
        const setup = yield* renderScoped(
          () =>
            bottomTranscript({
              items,
              streaming: () => false,
              footer,
              paneOpen,
              overlayOpen,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
              },
            }),
          { width: 60, height: 30 },
        )
        yield* waitForFrame(setup, (next) => next.includes("SHORT-ANSWER"), "the short session")
        const renderer = Option.getOrThrow(screen)
        const flush = Effect.promise(() => setup.flush())
        yield* flush
        const rowsAbove = () => Schema.decodeUnknownSync(RegionPlace)(renderer).renderOffset
        const regionRows = renderer.footerHeight
        expect(rowsAbove()).toBe(0)
        expect(rowsUnderRegion(renderer)).toBeGreaterThan(0)
        // The command suggestions grow the footer, then the picker opens.
        batch(() => {
          setPaneOpen(true)
          setFooter(9)
        })
        yield* flush
        yield* flush
        setOverlayOpen(true)
        yield* flush
        yield* flush
        // The picker closes; the footer's next measure is its base again.
        batch(() => {
          setPaneOpen(false)
          setOverlayOpen(false)
        })
        yield* flush
        setFooter(3)
        yield* flush
        yield* flush
        expect([rowsAbove(), renderer.footerHeight]).toEqual([0, regionRows])
        // The next turn grows the region down from the same top row.
        setItems([
          ...items(),
          clientPrompt("next", "NEXT-ASK"),
          assistant("turn", Array.from({ length: 6 }, (_, at) => `TURN-${at + 1}`).join("\n\n")),
        ])
        const frame = yield* waitForFrame(setup, (next) => next.includes("TURN-6"), "the turn")
        yield* flush
        expect(rowsAbove()).toBe(0)
        for (const text of ["FIRST-ASK", "SHORT-ANSWER", "NEXT-ASK", "TURN-1", "TURN-6"]) {
          expect([text, frame.includes(text)]).toEqual([text, true])
        }
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // A slash command opens a picker while a turn runs, and the turn ends
  // behind it. Once the picker closes, the region takes the tail's rows:
  // the turn's last rows show under its first ones.
  it.scopedLive(
    "a turn that ends behind a picker shows its last rows once the picker closes",
    () =>
      Effect.gen(function* () {
        const turn = (rows: number) =>
          assistant("turn", Array.from({ length: rows }, (_, at) => `TURN-${at + 1}`).join("\n\n"))
        const [items, setItems] = createSignal<ListMessage[]>([
          clientPrompt("ask", "FIRST-ASK"),
          { ...turn(2), draft: true },
        ])
        const [streaming, setStreaming] = createSignal(true)
        const [footer, setFooter] = createSignal(5)
        const [overlayOpen, setOverlayOpen] = createSignal(false)
        let screen = Option.none<CliRenderer>()
        const setup = yield* renderScoped(
          () =>
            bottomTranscript({
              items,
              streaming,
              footer,
              paneOpen: () => false,
              overlayOpen,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
              },
            }),
          { width: 60, height: 30 },
        )
        yield* waitForFrame(setup, (next) => next.includes("TURN-2"), "the running turn")
        const renderer = Option.getOrThrow(screen)
        const flush = Effect.promise(() => setup.flush())
        const rowsAbove = () => Schema.decodeUnknownSync(RegionPlace)(renderer).renderOffset
        yield* flush
        setOverlayOpen(true)
        yield* flush
        yield* flush
        // The turn ends while the picker holds the screen.
        batch(() => {
          setItems([clientPrompt("ask", "FIRST-ASK"), turn(8)])
          setStreaming(false)
          setFooter(3)
        })
        yield* flush
        yield* flush
        setOverlayOpen(false)
        yield* flush
        const frame = yield* waitForFrame(
          setup,
          (next) => next.includes("TURN-8") && next.includes("COMPOSER"),
          "the turn's last rows",
        )
        expect(rowsAbove()).toBe(0)
        for (const text of ["FIRST-ASK", "TURN-1", "TURN-8"]) {
          expect([text, frame.includes(text)]).toEqual([text, true])
        }
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // After the return's first frame the region follows the footer and the
  // live tail again: a turn that starts after the picker closed grows the
  // region in a short session, and a footer that grows takes rows too.
  it.scopedLive(
    "after a picker closes the region follows a turn that grows and a footer that grows",
    () =>
      Effect.gen(function* () {
        const turn = (rows: number): ListMessage => ({
          ...assistant(
            "turn",
            Array.from({ length: rows }, (_, at) => `TURN-${at + 1}`).join("\n\n"),
          ),
          draft: true,
        })
        const [items, setItems] = createSignal<ListMessage[]>([
          clientPrompt("ask", "FIRST-ASK"),
          assistant("short", "SHORT-ANSWER"),
        ])
        const [streaming, setStreaming] = createSignal(false)
        const [footer, setFooter] = createSignal(3)
        const [overlayOpen, setOverlayOpen] = createSignal(false)
        let screen = Option.none<CliRenderer>()
        const setup = yield* renderScoped(
          () =>
            bottomTranscript({
              items,
              streaming,
              footer,
              paneOpen: () => false,
              overlayOpen,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
              },
            }),
          { width: 60, height: 30 },
        )
        yield* waitForFrame(setup, (next) => next.includes("SHORT-ANSWER"), "the short session")
        const renderer = Option.getOrThrow(screen)
        const flush = Effect.promise(() => setup.flush())
        const rowsAbove = () => Schema.decodeUnknownSync(RegionPlace)(renderer).renderOffset
        yield* flush
        const regionRows = renderer.footerHeight
        setOverlayOpen(true)
        yield* flush
        yield* flush
        setOverlayOpen(false)
        yield* flush
        yield* flush
        expect([rowsAbove(), renderer.footerHeight]).toEqual([0, regionRows])
        // A turn starts on the terminal's own screen and grows.
        batch(() => {
          setItems([...items(), clientPrompt("next", "NEXT-ASK"), turn(2)])
          setStreaming(true)
        })
        yield* flush
        setItems([...items().slice(0, -1), turn(6)])
        const frame = yield* waitForFrame(
          setup,
          (next) => next.includes("TURN-6") && next.includes("COMPOSER"),
          "the grown turn",
        )
        yield* flush
        const grown = renderer.footerHeight
        expect(grown).toBeGreaterThan(regionRows)
        expect(rowsAbove()).toBe(0)
        for (const text of ["FIRST-ASK", "NEXT-ASK", "TURN-1", "TURN-6"]) {
          expect([text, frame.includes(text)]).toEqual([text, true])
        }
        // The footer grows by three rows, and the region with it.
        setFooter(6)
        yield* flush
        yield* flush
        expect(renderer.footerHeight).toBe(grown + 3)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive(
    "a turn's final items reach history while it runs, once the tail holds more than the region shows",
    () =>
      Effect.gen(function* () {
        const [items, setItems] = createSignal<ListMessage[]>([
          assistant("earlier", longBody("EARLIER")),
          { ...assistant("answer", longBody("STEP-ONE")), draft: true },
        ])
        const [streaming, setStreaming] = createSignal(true)
        const committedText: string[] = []
        let screen = Option.none<CliRenderer>()
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items()}
              streaming={streaming()}
              onRenderer={(renderer) => {
                screen = Option.some(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        const flushUntil = (marker: string) =>
          Effect.promise(() => setup.flush()).pipe(
            Effect.repeat({
              until: () => committedText.join("").includes(marker),
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("4 seconds"),
            Effect.ignore,
          )
        // The earlier answer is final and taller than the live tail's rows:
        // it moves to history whole while the turn runs; the draft stays.
        yield* flushUntil("EARLIER line 12")
        expect(committedText.join("")).toContain("EARLIER line 12")
        expect(committedText.join("")).not.toContain("STEP-ONE")
        // The stored answer replaces the draft, and the next step streams
        // under it: the answer moves to history once the step pushes it above.
        setItems([
          assistant("earlier", longBody("EARLIER")),
          assistant("answer", "STEP-ONE stored"),
          { ...assistant("next", longBody("STEP-TWO")), draft: true },
        ])
        yield* flushUntil("STEP-ONE stored")
        expect(committedText.join("")).toContain("STEP-ONE stored")
        expect(committedText.join("")).not.toContain("STEP-TWO")
        // The turn ends: the step's top rows move to history, and its last
        // rows stay on screen, so every row is in one place.
        setStreaming(false)
        yield* flushUntil("STEP-TWO line 1")
        const frame = yield* waitForFrame(
          setup,
          (next) => next.includes("STEP-TWO line 12"),
          "tail",
        )
        expect(committedText.join("")).not.toContain("STEP-TWO line 12")
        expect(frame).not.toMatch(/STEP-TWO line 1 *$/m)
        const renderer = Option.getOrThrow(screen)
        expect(rowsUnderRegion(renderer)).toBe(0)
        expect(renderer.footerHeight).toBe(splitFooterHeight(14, 14))
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})

// ── native transcript region at the terminal's bottom ───────────────────────

/**
 * A long session: the split region sits on the terminal's last rows, and
 * rows it pushes up go to the terminal's scrollback for good. Growing UI
 * (a docked pane, the suggestions) covers the transcript's last rows; it
 * never grows the region. The footer here is a stand-in: the composer row,
 * then the pane's row while one is open.
 */

interface BottomSetup {
  readonly items: () => SessionItem[]
  readonly streaming: () => boolean
  readonly footer: () => number
  readonly paneOpen: () => boolean
  readonly overlayOpen: () => boolean
}

const bottomTranscript = (
  options: BottomSetup & { readonly onRenderer: (renderer: CliRenderer) => void },
) => {
  const renderer = useRenderer()
  options.onRenderer(renderer)
  return (
    <box flexDirection="column" flexGrow={1}>
      <Transcript
        items={options.items()}
        streaming={options.streaming()}
        footerHeight={options.footer()}
        paneOpen={options.paneOpen()}
        overlayOpen={options.overlayOpen()}
      />
      <box height={options.footer()} flexShrink={0} flexDirection="column">
        <text>COMPOSER</text>
        <Show when={options.paneOpen()}>
          <text>PANE</text>
        </Show>
      </box>
    </box>
  )
}

/**
 * The row a turn's end adds to the transcript (`● Worked for …`), with its
 * spacer: as many rows as the activity row and its spacer give back.
 */
const turnEnded = (seq: number): SessionItem => ({
  _tag: "turn-ended",
  durationSeconds: 5,
  steps: emptyTurnSteps,
  createdAt: seq,
  seq,
})

/** The blank rows right above the composer row of `frame`. */
const blankRowsAboveComposer = (frame: string): number => {
  const rows = frame.split("\n")
  const composer = rows.findIndex((row) => row.includes("COMPOSER"))
  expect(composer).toBeGreaterThanOrEqual(0)
  let blank = 0
  while (composer - blank - 1 >= 0 && rows[composer - blank - 1]?.trim() === "") blank++
  return blank
}

/** How many times each `<label> line <n>` row shows in `text`, by row. */
const bodyRowCounts = (text: string): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const match of text.matchAll(/[A-Z]+-\d+ line \d+/g)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
  }
  return counts
}

const longSession = (): ListMessage[] =>
  Array.from({ length: 6 }, (_, index) => assistant(`item-${index}`, longBody(`ITEM-${index}`)))

describe("native transcript region at the terminal's bottom", () => {
  const height = 40
  const regionRows = splitFooterHeight(height, height)

  /** Renders until two looks in a row show the same frame and history. */
  const waitForStableFrame = (setup: Parameters<typeof renderFrame>[0]) =>
    Effect.gen(function* () {
      let last = ""
      yield* waitForFrame(
        setup,
        () => {
          const next = terminalText(setup)
          const same = next === last
          last = next
          return same
        },
        "a stable frame",
        6_000,
      )
      return renderFrame(setup)
    })

  /** Renders a long session over the footer stand-in and waits for it to settle at the bottom. */
  const settledLongSession = (
    options: BottomSetup,
    ready: (text: string) => boolean = (text) => bodyRowCounts(text).has("ITEM-0 line 1"),
  ) =>
    Effect.gen(function* () {
      let screen = Option.none<CliRenderer>()
      const setup = yield* renderScoped(
        () =>
          bottomTranscript({
            ...options,
            onRenderer: (renderer) => {
              screen = Option.some(renderer)
            },
          }),
        { width: 60, height },
      )
      const renderer = Option.getOrThrow(screen)
      yield* waitForFrame(
        setup,
        () =>
          rowsUnderRegion(renderer) === 0 &&
          renderer.footerHeight === regionRows &&
          ready(terminalText(setup)),
        "the long session at the terminal's bottom",
        6_000,
      )
      const settled = yield* waitForStableFrame(setup)
      return { setup, renderer, settled }
    })

  // Covered rows still belong to the live tail. A pane step checks the visible
  // prefix while covered, then the full row set once the pane gives it back.
  // A held settle/change/release is one action: before release the oversized
  // live item owns rows above its viewport that no terminal capture can show.
  for (const sequence of [
    { name: "partial answer and exit", oversized: true, actions: ["settle", "exit"] },
    {
      name: "partial answer changed and replayed",
      oversized: true,
      actions: ["settle", "change", "resize", "exit"],
    },
    {
      name: "answer changed while its cut settles",
      oversized: true,
      heldChange: true,
      actions: ["settle", "pane", "exit"],
    },
    {
      name: "cut whose highlight never settles",
      oversized: true,
      neverSettles: true,
      actions: ["settle", "resize", "exit"],
    },
    { name: "turn end after a live answer", actions: ["settle", "turn", "pane", "exit"] },
    { name: "pane around a resize replay", actions: ["settle", "pane", "resize", "pane", "exit"] },
    {
      name: "suggestions after a footer shrinks",
      actions: ["settle", "footer", "suggestions", "resize", "exit"],
    },
    {
      name: "changed history around a turn",
      actions: ["settle", "change", "turn", "resize", "exit"],
    },
  ]) {
    it.scopedLive(
      `history keeps every row once through ${sequence.name}`,
      () =>
        Effect.gen(function* () {
          const body = (label: string) =>
            Array.from({ length: 30 }, (_, index) => `${label} line ${index + 1}`).join("\n\n")
          let initial = [...longSession(), assistant("tail", "TAIL")]
          if (sequence.oversized) initial = [assistant("answer", body("OLD-0"))]
          const [items, setItems] = createSignal<ListMessage[]>(initial)
          const [streaming, setStreaming] = createSignal(false)
          const [footer, setFooter] = createSignal(3)
          const [paneOpen, setPaneOpen] = createSignal(false)
          const hold = yield* makeSettleHold
          const timeouts = makeSettleTimeouts(Number.MAX_SAFE_INTEGER)
          let screen = Option.none<CliRenderer>()
          const setup = yield* renderScoped(
            () =>
              bottomTranscript({
                items,
                streaming,
                footer,
                paneOpen,
                overlayOpen: () => false,
                onRenderer: (renderer) => {
                  screen = Option.some(renderer)
                  if (sequence.heldChange) hold.applyTo(renderer)
                  if (sequence.neverSettles) timeouts.applyTo(renderer)
                },
              }),
            { width: 60, height },
          )
          const renderer = Option.getOrThrow(screen)
          if (sequence.heldChange) {
            yield* hold.held
            setItems([assistant("answer", body("NEW-0"))])
            yield* Effect.promise(() => setup.flush())
            yield* hold.release
          }
          const expectedRows = () =>
            [
              ...bodyRowCounts(
                items()
                  .map((item) => item.content)
                  .join("\n"),
              ).keys(),
            ].sort()
          const assertRows = (step: string) => {
            const expected = expectedRows()
            const actual = [...bodyRowCounts(terminalText(setup))].sort(([a], [b]) =>
              Order.String(a, b),
            )
            expect([step, actual]).toEqual([step, expected.map((row) => [row, 1])])
            // An answer ends with its one paragraph gap. Extra empty rows are
            // a broken handover; the gap itself is part of the markdown layout.
            expect(blankRowsAboveComposer(renderFrame(setup))).toBeLessThanOrEqual(1)
          }
          const settle = (step: string) =>
            Effect.gen(function* () {
              // A replay keeps the old history on screen until its rows are
              // drawn and land with the clear: until then a row may show in
              // the old history and in the tail. Every row ends up once.
              yield* waitForFrame(
                setup,
                () => {
                  const counts = bodyRowCounts(terminalText(setup))
                  return expectedRows().every((row) => counts.get(row) === 1)
                },
                step,
                6_000,
              ).pipe(Effect.catch(() => Effect.sync(() => assertRows(step))))
              yield* waitForStableFrame(setup)
              assertRows(step)
            })
          for (const action of sequence.actions) {
            if (action === "change") {
              if (sequence.oversized) setItems([assistant("answer", body("NEW-0"))])
              else
                setItems([
                  ...longSession().map((_item, index) =>
                    assistant(`item-${index}`, longBody(`NEW-${index}`)),
                  ),
                  assistant("tail", "TAIL"),
                ])
            } else if (action === "resize") {
              setup.resize(50, height)
            } else if (action === "footer") {
              setFooter(1)
            } else if (action === "pane" || action === "suggestions") {
              const before = terminalText(setup)
              const base = footer()
              batch(() => {
                setPaneOpen(true)
                if (action === "pane") setFooter(15)
                else setFooter(8)
              })
              yield* waitForStableFrame(setup)
              const covered = bodyRowCounts(terminalText(setup))
              for (const [row, count] of covered)
                expect([action, row, count]).toEqual([action, row, 1])
              batch(() => {
                setPaneOpen(false)
                setFooter(base)
              })
              yield* waitForStableFrame(setup)
              expect(terminalText(setup)).toBe(before)
            } else if (action === "turn") {
              const base = items()
              const answer = assistant("turn", "ANSWER-0 line 1\n\nANSWER-0 line 2")
              batch(() => {
                setItems([...base, { ...answer, draft: true }])
                setStreaming(true)
                setFooter(5)
              })
              yield* waitForStableFrame(setup)
              // The growing activity footer takes the tail's top rows: history
              // has them, so every row stays in one place while the turn runs.
              assertRows("stream")
              batch(() => {
                setItems([...base, answer])
                setStreaming(false)
                setFooter(3)
              })
            } else if (action === "exit") {
              yield* flushTranscriptForExit(renderer)
            }
            yield* settle(action)
          }
        }).pipe(Effect.timeout("25 seconds")),
      30_000,
    )
  }

  it.scopedLive(
    "a docked pane covers the transcript's last rows and gives them back on close",
    () =>
      Effect.gen(function* () {
        const [footer, setFooter] = createSignal(3)
        const [paneOpen, setPaneOpen] = createSignal(false)
        const { setup, renderer, settled } = yield* settledLongSession({
          items: () => [...longSession(), assistant("tail", "TAIL")],
          streaming: () => false,
          footer,
          paneOpen,
          overlayOpen: () => false,
        })
        expect(blankRowsAboveComposer(settled)).toBe(0)
        const historyRows = terminalText(setup).length - settled.length

        // The pane docks: the region keeps its rows, and the transcript rows
        // above the pane stay where they were.
        batch(() => {
          setPaneOpen(true)
          setFooter(15)
        })
        const open = yield* waitForStableFrame(setup)
        expect(renderer.footerHeight).toBe(regionRows)
        expect(rowsUnderRegion(renderer)).toBe(0)
        expect(open).toContain("PANE")
        const kept = regionRows - 15
        expect(open.split("\n").slice(0, kept)).toEqual(settled.split("\n").slice(0, kept))
        expect(terminalText(setup).length - open.length).toBe(historyRows)

        // The pane closes: the rows it covered come back, none blank.
        batch(() => {
          setPaneOpen(false)
          setFooter(3)
        })
        const closed = yield* waitForStableFrame(setup)
        expect(closed).toBe(settled)
        expect(blankRowsAboveComposer(closed)).toBe(0)
        expect(renderer.footerHeight).toBe(regionRows)
        expect(rowsUnderRegion(renderer)).toBe(0)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // A short session's region grows into the empty rows under it while a
  // tall pane is open, and gives them back on close: the empty rows are
  // under the composer, as in a fresh terminal.
  it.scopedLive(
    "a tall pane in a short session gives its rows back under the composer",
    () =>
      Effect.gen(function* () {
        const [footer, setFooter] = createSignal(3)
        const [paneOpen, setPaneOpen] = createSignal(false)
        let screen = Option.none<CliRenderer>()
        const setup = yield* renderScoped(
          () =>
            bottomTranscript({
              items: () => [assistant("short", longBody("SHORT")), assistant("tail", "TAIL")],
              streaming: () => false,
              footer,
              paneOpen,
              overlayOpen: () => false,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
              },
            }),
          { width: 60, height },
        )
        const renderer = Option.getOrThrow(screen)
        const settled = yield* waitForStableFrame(setup)
        const regionBefore = renderer.footerHeight
        expect(rowsUnderRegion(renderer)).toBeGreaterThan(0)
        expect(blankRowsAboveComposer(settled)).toBe(0)
        batch(() => {
          setPaneOpen(true)
          setFooter(regionRows - 2)
        })
        yield* waitForStableFrame(setup)
        batch(() => {
          setPaneOpen(false)
          setFooter(3)
        })
        const closed = yield* waitForStableFrame(setup)
        expect(blankRowsAboveComposer(closed)).toBe(0)
        expect(closed).toBe(settled)
        expect(renderer.footerHeight).toBe(regionBefore)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // A turn ends on a 24-row screen: the activity row goes (a footer of 6
  // rows, then 4), and history takes the top row the region no longer shows.
  // A 19-row item leaves the screen one row short of full: history's row
  // sits at the top and the region starts on the next row, with a row free
  // under it.
  it.scopedLive(
    "the region starts right under the rows history took on a short screen",
    () =>
      Effect.gen(function* () {
        let historyRows = 0
        let screen = Option.none<CliRenderer>()
        const [streaming, setStreaming] = createSignal(true)
        const [footer, setFooter] = createSignal(6)
        // The one item draws one row per line.
        const body = Array.from({ length: 19 }, (_, index) => `CUT-0 line ${index + 1}`)
        const setup = yield* renderScoped(
          () => {
            const renderer = useRenderer()
            screen = Option.some(renderer)
            renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
              historyRows += event.snapshot.height
            })
            return (
              <box flexDirection="column" flexGrow={1}>
                <Transcript
                  items={[assistant("cut", body.join("\n"))]}
                  streaming={streaming()}
                  footerHeight={footer()}
                  renderItems={(visible) => (
                    <box flexDirection="column">
                      <For each={visible.flatMap(() => body)}>{(line) => <text>{line}</text>}</For>
                    </box>
                  )}
                />
                <box height={footer()} flexShrink={0}>
                  <text>COMPOSER</text>
                </box>
              </box>
            )
          },
          { width: 60, height: 24 },
        )
        const renderer = Option.getOrThrow(screen)
        yield* waitForFrame(setup, (frame) => frame.includes("CUT-0 line 19"), "the item")
        batch(() => {
          setStreaming(false)
          setFooter(4)
        })
        yield* waitForFrame(setup, () => historyRows > 0, "the cut row in history", 6_000)
        yield* waitForStableFrame(setup)
        const { renderOffset: top } = yield* Schema.decodeUnknownEffect(RegionPlace)(renderer)
        expect([historyRows, renderer.footerHeight]).toEqual([1, 22])
        expect(top).toBe(historyRows)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // History holds a prompt's top rows, and the live tail cuts them off. A
  // footer that shrinks then leaves rows above the tail: they are blank. The
  // prompt's rail goes only on the rows its text is on, never on the rows
  // above the tail or over history.
  it.scopedLive(
    "a prompt cut by history draws its rail only beside its own rows",
    () =>
      Effect.gen(function* () {
        const [footer, setFooter] = createSignal(3)
        const prompt = Array.from({ length: 6 }, (_, index) => `PROMPT-0 line ${index + 1}`)
        const answer = Array.from({ length: 16 }, (_, index) => `ANSWER-0 line ${index + 1}`)
        const { setup } = yield* settledLongSession(
          {
            items: () => [
              ...longSession(),
              clientPrompt("ask", prompt.join("\n")),
              assistant("answer", answer.join("\n\n")),
            ],
            streaming: () => false,
            footer,
            paneOpen: () => false,
            overlayOpen: () => false,
          },
          (text) => bodyRowCounts(text).has("ANSWER-0 line 16"),
        )
        const railRows = (frame: string) =>
          frame.split("\n").filter((row) => row.startsWith("┃") && !row.includes("PROMPT-0"))
        setFooter(1)
        const shrunk = yield* waitForStableFrame(setup)
        // History took the prompt's top rows: the tail shows the rest of it.
        expect(shrunk).not.toContain("PROMPT-0 line 1")
        expect(shrunk).toContain("PROMPT-0 line 6")
        expect(railRows(shrunk)).toEqual([])
        expect(railRows(terminalText(setup))).toEqual([])
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // History holds a prompt's top rows and the tail the rest. A footer that
  // shrinks gives the region rows the tail does not fill; held, they would
  // sit inside the prompt, between its rows in history and on screen.
  // Scrollback takes no row back, so the transcript is written again: the
  // prompt and the answer read with the spacing they had.
  it.scopedLive(
    "a footer that shrinks while history holds an item's top rows leaves no blank row inside it",
    () =>
      Effect.gen(function* () {
        const [footer, setFooter] = createSignal(3)
        const prompt = Array.from({ length: 6 }, (_, index) => `PROMPT-0 line ${index + 1}`)
        const answer = Array.from({ length: 16 }, (_, index) => `ANSWER-0 line ${index + 1}`)
        const { setup, renderer } = yield* settledLongSession(
          {
            items: () => [
              ...longSession(),
              clientPrompt("ask", prompt.join("\n")),
              assistant("answer", answer.join("\n\n")),
            ],
            streaming: () => false,
            footer,
            paneOpen: () => false,
            overlayOpen: () => false,
          },
          (text) => bodyRowCounts(text).has("ANSWER-0 line 16"),
        )
        /** The rows from the prompt's first row to the answer's last, history first. */
        const block = (text: string) => {
          const rows = text.split("\n").map((row) => row.trimEnd())
          const start = rows.findIndex((row) => row.includes("PROMPT-0 line 1"))
          const end = rows.findIndex((row) => row.includes("ANSWER-0 line 16"))
          return rows.slice(start, end + 1)
        }
        const before = block(terminalText(setup))
        expect(before.length).toBeGreaterThan(prompt.length + answer.length)
        setFooter(1)
        yield* waitForFrame(
          setup,
          () => block(terminalText(setup)).join("\n") === before.join("\n"),
          "the prompt and the answer with their spacing",
          6_000,
        ).pipe(Effect.ignore)
        yield* waitForStableFrame(setup)
        expect(block(terminalText(setup))).toEqual(before)
        expect(renderer.footerHeight).toBe(regionRows)
        expect(rowsUnderRegion(renderer)).toBe(0)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // A footer row that goes (an activity row a resumed turn drew, a status
  // row) leaves the region a row the tail does not fill. The row sits above
  // the tail, under history: the tail and the composer stay together.
  it.scopedLive(
    "a footer that shrinks below its first height leaves its row above the tail",
    () =>
      Effect.gen(function* () {
        const [footer, setFooter] = createSignal(3)
        const { setup, renderer, settled } = yield* settledLongSession({
          items: () => [...longSession(), assistant("tail", "TAIL")],
          streaming: () => false,
          footer,
          paneOpen: () => false,
          overlayOpen: () => false,
        })
        expect(blankRowsAboveComposer(settled)).toBe(0)
        setFooter(1)
        const shrunk = yield* waitForStableFrame(setup)
        expect(blankRowsAboveComposer(shrunk)).toBe(0)
        expect(renderer.footerHeight).toBe(regionRows)
        expect(rowsUnderRegion(renderer)).toBe(0)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // A resize writes history again at the new width. The rows written before
  // are in the terminal's saved lines: the replay clears them, else each row
  // shows twice.
  it.scopedLive(
    "a resize replay leaves every transcript row once",
    () =>
      Effect.gen(function* () {
        const { setup, renderer } = yield* settledLongSession({
          items: () => [...longSession(), assistant("tail", "TAIL")],
          streaming: () => false,
          footer: () => 3,
          paneOpen: () => false,
          overlayOpen: () => false,
        })
        const replayed: string[] = []
        renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
          replayed.push(committedTextOf(event))
        })
        setup.resize(50, height)
        yield* waitForFrame(
          setup,
          () => replayed.join("").includes("ITEM-0 line 1"),
          "the replay of the first item",
          6_000,
        )
        yield* waitForStableFrame(setup)
        const counts = bodyRowCounts(terminalText(setup))
        for (const item of longSession().keys()) {
          for (let line = 1; line <= 12; line++) {
            const row = `ITEM-${item} line ${line}`
            expect([row, counts.get(row)]).toEqual([row, 1])
          }
        }
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // A turn starts from idle: its prompt joins the tail, and the footer grows
  // by the activity row and its spacer, then by a tray row. The region has
  // all its rows already, so the tail shows fewer of them. The rows it no
  // longer shows go to history: no row is left above the tail's view, where
  // neither the screen nor scrollback has it.
  it.scopedLive(
    "a turn that starts at the bottom keeps every row in history or on screen as its footer grows",
    () =>
      Effect.gen(function* () {
        const settledItems = [...longSession(), assistant("tail", longBody("TAIL-0"))]
        const [items, setItems] = createSignal<ListMessage[]>(settledItems)
        const [streaming, setStreaming] = createSignal(false)
        const [footer, setFooter] = createSignal(3)
        const { setup } = yield* settledLongSession({
          items,
          streaming,
          footer,
          paneOpen: () => false,
          overlayOpen: () => false,
        })
        const expectRowsOnce = (step: string) => {
          const expected = [
            ...bodyRowCounts(
              items()
                .map((item) => item.content)
                .join("\n"),
            ).keys(),
          ].sort()
          const actual = [...bodyRowCounts(terminalText(setup))].sort(([a], [b]) =>
            Order.String(a, b),
          )
          expect([step, actual]).toEqual([step, expected.map((row) => [row, 1])])
        }
        expectRowsOnce("idle")
        batch(() => {
          setItems([
            ...settledItems,
            clientPrompt("ask", "ASK-0 line 1"),
            { ...assistant("answer", "ANSWER-0 line 1"), draft: true },
          ])
          setStreaming(true)
          setFooter(5)
        })
        yield* waitForStableFrame(setup)
        expectRowsOnce("turn start")
        setFooter(6)
        yield* waitForStableFrame(setup)
        expectRowsOnce("tray row")
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // The rows a growing footer takes from the tail commit once their surface
  // settles, a few frames later. Until they land, the tail keeps showing
  // them: a tail that scrolled at once would leave them in neither history
  // nor the screen, and the screen's top rows would read stale. The rows the
  // turn adds wait under them instead.
  it.scopedLive(
    "while the rows a turn's footer takes are in flight, every frame reads the transcript in order",
    () =>
      Effect.gen(function* () {
        const settledItems = [...longSession(), assistant("tail", longBody("TAIL-0"))]
        const [items, setItems] = createSignal<ListMessage[]>(settledItems)
        const [streaming, setStreaming] = createSignal(false)
        const [footer, setFooter] = createSignal(3)
        const { setup, renderer } = yield* settledLongSession({
          items,
          streaming,
          footer,
          paneOpen: () => false,
          overlayOpen: () => false,
        })
        const turnItems: ListMessage[] = [
          ...settledItems,
          clientPrompt("ask", "ASK-0 line 1"),
          { ...assistant("answer", "ANSWER-0 line 1"), draft: true },
        ]
        const expected = [...bodyRowCounts(turnItems.map((item) => item.content).join("\n")).keys()]
        /** The body rows history and the frame show, in order: a prefix of the transcript's. */
        const expectPrefix = (step: string) => {
          const shown = [...terminalText(setup).matchAll(/[A-Z]+-\d+ line \d+/g)].map(
            (match) => match[0],
          )
          expect([step, shown]).toEqual([step, expected.slice(0, shown.length)])
        }
        const hold = yield* makeSettleHold
        hold.applyTo(renderer)
        batch(() => {
          setItems(turnItems)
          setStreaming(true)
          setFooter(5)
        })
        yield* hold.held
        yield* Effect.promise(() => setup.renderOnce())
        yield* Effect.promise(() => setup.renderOnce())
        expectPrefix("commit in flight")
        yield* hold.release
        yield* waitForStableFrame(setup)
        expectPrefix("landed")
        expect(bodyRowCounts(terminalText(setup)).has("ANSWER-0 line 1")).toBe(true)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // A streamed answer grows the tail past the region: the final rows above
  // it go to history. Until they land, every frame keeps them in view.
  it.scopedLive(
    "while a streamed answer pushes final rows to history, every frame reads the transcript in order",
    () =>
      Effect.gen(function* () {
        const draft = (lines: number): ListMessage => ({
          ...assistant(
            "answer",
            Array.from({ length: lines }, (_, index) => `ANSWER-0 line ${index + 1}`).join("\n\n"),
          ),
          draft: true,
        })
        // The feed keeps each item it does not change, as the session store does.
        const settledItems = [
          ...longSession(),
          clientPrompt("ask", "ASK-0 line 1"),
          assistant("step", "STEP-0 line 1\n\nSTEP-0 line 2"),
        ]
        const turnItems = (lines: number): ListMessage[] => [...settledItems, draft(lines)]
        const [items, setItems] = createSignal<ListMessage[]>(turnItems(1))
        const { setup, renderer } = yield* settledLongSession({
          items,
          streaming: () => true,
          footer: () => 5,
          paneOpen: () => false,
          overlayOpen: () => false,
        })
        const expected = [
          ...bodyRowCounts(
            turnItems(6)
              .map((item) => item.content)
              .join("\n"),
          ).keys(),
        ]
        const frames: string[][] = []
        const look = () =>
          frames.push(
            [...terminalText(setup).matchAll(/[A-Z]+-\d+ line \d+/g)].map((match) => match[0]),
          )
        look()
        const hold = yield* makeSettleHold
        hold.applyTo(renderer)
        for (const lines of [2, 3, 4, 5, 6]) {
          setItems(turnItems(lines))
          yield* Effect.promise(() => setup.renderOnce())
          look()
          yield* Effect.promise(() => setup.renderOnce())
          look()
        }
        yield* hold.held
        yield* Effect.promise(() => setup.renderOnce())
        look()
        yield* hold.release
        yield* waitForStableFrame(setup)
        look()
        // Each frame shows a prefix of the transcript: no row missing between.
        const torn = frames.filter((shown) => shown.some((row, at) => row !== expected[at]))
        expect(torn).toEqual([])
        expect(frames.at(-1)).toEqual(expected)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // A terminal shows each synchronized update whole, and what comes outside
  // one as it arrives. A replay clears the screen and its saved lines and
  // writes every row again: written over many frames, the screen goes blank
  // and refills, a flicker that grows with the session. The clear, every
  // history row and the region's frame go in one update.
  it.scopedLive(
    "a replay writes its clear and all of history in one synchronized update",
    () =>
      Effect.gen(function* () {
        const output = new TerminalOutput(60, height)
        let screen = Option.none<CliRenderer>()
        const setup = yield* renderScoped(
          () =>
            bottomTranscript({
              items: () => [...longSession(), assistant("tail", "TAIL")],
              streaming: () => false,
              footer: () => 3,
              paneOpen: () => false,
              overlayOpen: () => false,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
              },
            }),
          { width: 60, height, output },
        )
        const renderer = Option.getOrThrow(screen)
        yield* waitForFrame(
          setup,
          () =>
            rowsUnderRegion(renderer) === 0 &&
            renderer.footerHeight === regionRows &&
            bodyRowCounts(terminalText(setup)).has("ITEM-0 line 1"),
          "the long session at the terminal's bottom",
          6_000,
        )
        yield* waitForStableFrame(setup)
        const before = output.written().length
        setup.resize(50, height)
        const replayed = () => output.written().slice(before)
        yield* waitForFrame(
          setup,
          () => replayed().includes("\u001b[3J") && replayed().includes("ITEM-5 line 12"),
          "the replay",
          6_000,
        )
        yield* waitForStableFrame(setup)
        const replay = replayed()
        const clear = replay.indexOf("\u001b[3J")
        const opened = replay.lastIndexOf("\u001b[?2026h", clear)
        const closed = replay.indexOf("\u001b[?2026l", clear)
        // The clear is inside an update, and that update is still open.
        expect([opened >= 0, closed > clear]).toEqual([true, true])
        expect(replay.slice(opened, clear)).not.toContain("\u001b[?2026l")
        const update = replay.slice(clear, closed)
        // Until then the screen keeps a whole frame: no update before the
        // clear paints the region blank.
        const blankUpdates = replay
          .slice(0, opened)
          .split("\u001b[?2026l")
          .map((written) => Bun.stripANSI(written))
          .filter((painted) => painted.length > regionRows && !/\S/.test(painted))
        expect(blankUpdates).toEqual([])
        const missing = [
          ...bodyRowCounts(
            longSession()
              .map((item) => item.content)
              .join("\n"),
          ).keys(),
        ].filter((row) => !update.includes(row))
        expect(missing).toEqual([])
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  it.scopedLive(
    "a turn that ends leaves no blank row above the composer",
    () =>
      Effect.gen(function* () {
        const [items, setItems] = createSignal<SessionItem[]>([
          ...longSession(),
          { ...assistant("answer", longBody("ANSWER-0")), draft: true },
        ])
        const [streaming, setStreaming] = createSignal(true)
        // The activity row and its spacer sit in the footer while the turn runs.
        const [footer, setFooter] = createSignal(5)
        const { setup, renderer } = yield* settledLongSession({
          items,
          streaming,
          footer,
          paneOpen: () => false,
          overlayOpen: () => false,
        })
        // The turn ends: the activity row and its spacer go, and the turn's
        // end row and its spacer join the transcript.
        batch(() => {
          setItems([...longSession(), assistant("answer", longBody("ANSWER-0")), turnEnded(1)])
          setStreaming(false)
          setFooter(3)
        })
        const idle = yield* waitForStableFrame(setup)
        expect(blankRowsAboveComposer(idle)).toBe(0)
        expect(idle.split("\n")[0]?.trim()).not.toBe("")
        expect(renderer.footerHeight).toBe(regionRows)
        expect(rowsUnderRegion(renderer)).toBe(0)
        const counts = bodyRowCounts(terminalText(setup))
        for (const [row, count] of counts) expect([row, count]).toEqual([row, 1])
        expect(counts.get("ANSWER-0 line 1")).toBe(1)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // An answer whose top rows went to history goes on in the region's first
  // row: no blank row between history and the tail, across turns that end.
  it.scopedLive(
    "the rows of an answer cut by history run on into the region with no blank row",
    () =>
      Effect.gen(function* () {
        const listAnswer = (id: string, label: string, rows: number): ListMessage =>
          assistant(
            id,
            Array.from({ length: rows }, (_, index) => `- ${label}-${index + 10} row`).join("\n"),
          )
        const [items, setItems] = createSignal<SessionItem[]>([
          clientPrompt("p1", "FIRST-ASK"),
          listAnswer("a1", "ROWA", 60),
        ])
        const [streaming, setStreaming] = createSignal(false)
        const [footer, setFooter] = createSignal(4)
        const { setup } = yield* settledLongSession(
          {
            items,
            streaming,
            footer,
            paneOpen: () => false,
            overlayOpen: () => false,
          },
          (text) => text.includes("ROWA-10 row"),
        )
        // A short turn runs and ends, with the activity row in the footer:
        // history takes the answer's rows the taller footer covers, and the
        // turn's end row takes the rows the footer gives back.
        batch(() => {
          setItems([
            clientPrompt("p1", "FIRST-ASK"),
            listAnswer("a1", "ROWA", 60),
            clientPrompt("p2", "SECOND-ASK"),
            { ...listAnswer("a2", "ROWB", 4), draft: true },
          ])
          setStreaming(true)
          setFooter(6)
        })
        yield* waitForStableFrame(setup)
        batch(() => {
          setItems([
            clientPrompt("p1", "FIRST-ASK"),
            listAnswer("a1", "ROWA", 60),
            clientPrompt("p2", "SECOND-ASK"),
            listAnswer("a2", "ROWB", 4),
            turnEnded(1),
          ])
          setStreaming(false)
          setFooter(4)
        })
        yield* waitForStableFrame(setup)
        const rows = terminalText(setup).split("\n")
        const at = (label: string) => rows.findIndex((row) => row.includes(`${label} row`))
        for (let index = 10; index < 69; index++) {
          expect([index, at(`ROWA-${index + 1}`) - at(`ROWA-${index}`)]).toEqual([index, 1])
        }
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  it.scopedLive(
    "a picker on the alternate screen gives the region back as it was",
    () =>
      Effect.gen(function* () {
        const [overlayOpen, setOverlayOpen] = createSignal(false)
        const { setup, renderer, settled } = yield* settledLongSession({
          items: () => [...longSession(), assistant("tail", "TAIL")],
          streaming: () => false,
          footer: () => 3,
          paneOpen: () => false,
          overlayOpen,
        })
        setOverlayOpen(true)
        yield* waitForStableFrame(setup)
        setOverlayOpen(false)
        const back = yield* waitForStableFrame(setup)
        expect(back).toBe(settled)
        expect(blankRowsAboveComposer(back)).toBe(0)
        expect(renderer.footerHeight).toBe(regionRows)
        expect(rowsUnderRegion(renderer)).toBe(0)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // A commit shrinks the region, and the next frame writes its rows into the
  // rows the region gave up. A region that grows again before that frame (the
  // footer grows back as a late runtime state marks the turn running) takes
  // those rows back, and the rows land over the history rows above them.
  it.scopedLive(
    "a region grows only after the frame that writes the rows it gave up",
    () =>
      Effect.gen(function* () {
        const [streaming, setStreaming] = createSignal(true)
        const [footer, setFooter] = createSignal(5)
        // The answer streams, taller than the region: history takes none of
        // its rows until the turn ends.
        const tall = Array.from({ length: 30 }, (_, index) => `TALL line ${index + 1}`).join("\n\n")
        const [items, setItems] = createSignal<SessionItem[]>([
          ...longSession(),
          { ...assistant("tall", tall), draft: true },
        ])
        let screen = Option.none<CliRenderer>()
        const sizes: Array<{ readonly shrunk: number; readonly after: number }> = []
        let grows = 0
        const setup = yield* renderScoped(
          () =>
            bottomTranscript({
              items,
              streaming,
              footer,
              paneOpen: () => false,
              overlayOpen: () => false,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
                renderer.on("external_output", () => {
                  if (grows === 0) return
                  grows--
                  const shrunk = renderer.footerHeight
                  setFooter(5)
                  sizes.push({ shrunk, after: renderer.footerHeight })
                })
              },
            }),
          { width: 60, height },
        )
        const renderer = Option.getOrThrow(screen)
        yield* waitForFrame(
          setup,
          () => rowsUnderRegion(renderer) === 0 && renderer.footerHeight === regionRows,
          "the session at the terminal's bottom",
          6_000,
        )
        yield* waitForStableFrame(setup)
        // The turn ends: history takes the tall answer's top rows, and the
        // footer shrinks while those commits are queued.
        grows = 1
        batch(() => {
          setItems([...longSession(), assistant("tall", tall)])
          setStreaming(false)
          setFooter(3)
        })
        yield* waitUntil(() => sizes.length > 0, "a commit after the turn's end", 6_000)
        const [size] = sizes
        expect(size?.after).toBe(size?.shrunk)
        // The frame wrote the rows; the region then takes the rows it wants.
        yield* waitForFrame(
          setup,
          () => renderer.footerHeight === regionRows && rowsUnderRegion(renderer) === 0,
          "the region back at its rows",
          6_000,
        )
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // History takes the rows above the canvas, which the footer's smallest base
  // sizes. A base that drops while those rows are on their way (the turn ends
  // and its status row goes) makes the canvas taller: rows offered for the
  // old base would leave the tail short of it, and the region at the
  // terminal's bottom would shrink and later grow back over history.
  it.scopedLive(
    "a footer that shrinks while history takes rows leaves the tail its full canvas",
    () =>
      Effect.gen(function* () {
        const [streaming, setStreaming] = createSignal(true)
        const [footer, setFooter] = createSignal(5)
        const { setup, renderer } = yield* settledLongSession({
          items: () => [...longSession(), assistant("tall", longBody("TALL"))],
          streaming,
          footer,
          paneOpen: () => false,
          overlayOpen: () => false,
        })
        setStreaming(false)
        setFooter(3)
        yield* waitForStableFrame(setup)
        expect(renderer.footerHeight).toBe(regionRows)
        expect(rowsUnderRegion(renderer)).toBe(0)
        expect(blankRowsAboveComposer(renderFrame(setup))).toBe(0)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )
})

// ── native transcript exit ──────────────────────────────────────────────────

describe("native transcript exit", () => {
  // The palette or a pane that holds the composer draws on the alternate
  // screen. Exit over it takes the terminal's own screen back first, so what
  // the live view holds still reaches history, after what history holds.
  for (const over of ["overlay", "expanded"] as const) {
    it.scopedLive(
      `exit over the ${over} view moves the live view into history, every row once`,
      () =>
        Effect.gen(function* () {
          const history: string[] = []
          let screen = Option.none<CliRenderer>()
          const [open, setOpen] = createSignal(false)
          const setup = yield* renderScoped(
            () => {
              const renderer = useRenderer()
              screen = Option.some(renderer)
              renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                history.push(committedTextOf(event))
              })
              return (
                <Transcript
                  items={[
                    assistant("first", longBody("KEPT-0")),
                    assistant("second", longBody("LIVE-0")),
                  ]}
                  expanded={over === "expanded" && open()}
                  overlayOpen={over === "overlay" && open()}
                />
              )
            },
            { width: 60, height: 14 },
          )
          yield* waitForFrame(
            setup,
            () => history.join("").includes("KEPT-0 line 1"),
            "history",
            6_000,
          )
          yield* waitForFrame(setup, (frame) => frame.includes("LIVE-0 line 12"), "the live tail")
          setOpen(true)
          yield* Effect.promise(() => setup.flush())
          const renderer = Option.getOrThrow(screen)
          expect(renderer.screenMode).toBe("alternate-screen")
          yield* flushTranscriptForExit(renderer)
          const counts = bodyRowCounts(history.join(""))
          for (const label of ["KEPT-0", "LIVE-0"]) {
            for (let line = 1; line <= 12; line++) {
              const row = `${label} line ${line}`
              expect([row, counts.get(row)]).toEqual([row, 1])
            }
          }
          const text = history.join("")
          expect(text.indexOf("KEPT-0 line 12")).toBeLessThan(text.indexOf("LIVE-0 line 1"))
        }).pipe(Effect.timeout("10 seconds")),
      15_000,
    )
  }

  // A signal interrupts the fiber that holds the process open. It leaves the
  // terminal as the reader's exit does (`leaveTerminal`): history first, in
  // transcript order, then the renderer.
  it.scopedLive(
    "a signal or exit moves a turn still in flight into history before the renderer goes",
    () =>
      Effect.gen(function* () {
        const committedText: string[] = []
        const written: string[] = []
        let screen = Option.none<CliRenderer>()
        const items: ListMessage[] = [
          assistant("earlier", "EARLIER-ANSWER"),
          { ...assistant("open", "SIGNALLED-DRAFT"), draft: true },
        ]
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              streaming
              onRenderer={(renderer) => {
                screen = Option.some(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        // A short session: the live tail holds both, and nothing is in history.
        yield* waitForFrame(
          setup,
          (next) => next.includes("EARLIER-ANSWER") && next.includes("SIGNALLED-DRAFT"),
          "the live tail",
        )
        expect(committedText.join("")).toBe("")
        const renderer = Option.getOrThrow(screen)
        const hold = yield* Effect.forkChild(
          holdUntilRendererDestroyed(renderer, (text) => written.push(text), Effect.void),
        )
        // The hold has started: it waits on the renderer, as the process entry does.
        yield* Effect.yieldNow
        yield* Fiber.interrupt(hold)
        const history = committedText.join("")
        expect(history).toContain("SIGNALLED-DRAFT")
        expect(history.indexOf("EARLIER-ANSWER")).toBeGreaterThanOrEqual(0)
        expect(history.indexOf("EARLIER-ANSWER")).toBeLessThan(history.indexOf("SIGNALLED-DRAFT"))
        expect(renderer.isDestroyed).toBe(true)
        // The cursor goes back over the cleared region, under the transcript.
        expect(written).toHaveLength(1)
        expect(written[0]).toMatch(new RegExp(`^${String.fromCharCode(27)}\\[[1-9][0-9]*A$`))
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // A signal while a program holds the terminal (an editor, the git pager):
  // the exit ends the handover first, the program stopped and the renderer
  // resumed, and only then leaves the terminal. A renderer destroyed while
  // suspended commits no row, and a program left running keeps the terminal.
  it.scopedLive(
    "a signal while a program holds the terminal stops it and resumes the renderer before the live view moves into history",
    () =>
      Effect.gen(function* () {
        const committedText: string[] = []
        const steps: string[] = []
        let screen = Option.none<CliRenderer>()
        const items: ListMessage[] = [
          assistant("earlier", "EARLIER-ANSWER"),
          { ...assistant("open", "SIGNALLED-DRAFT"), draft: true },
        ]
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              streaming
              onRenderer={(renderer) => {
                screen = Option.some(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        yield* waitForFrame(
          setup,
          (next) => next.includes("EARLIER-ANSWER") && next.includes("SIGNALLED-DRAFT"),
          "the live tail",
        )
        const renderer = Option.getOrThrow(screen)
        renderer.once("destroy", () => steps.push("destroy"))
        const terminal = makeHandover({
          suspend: () => {
            steps.push("suspend")
            renderer.suspend()
          },
          resume: () => {
            steps.push("resume")
            renderer.resume()
          },
        })
        const holding = yield* Deferred.make<void>()
        const program = yield* Effect.forkChild(
          terminal.handover(
            Deferred.succeed(holding, void 0).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Effect.sync(() => steps.push("program stopped"))),
            ),
          ),
        )
        yield* Deferred.await(holding)
        const hold = yield* Effect.forkChild(
          holdUntilRendererDestroyed(renderer, () => {}, terminal.close),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(hold)
        expect(steps).toEqual(["suspend", "program stopped", "resume", "destroy"])
        expect(committedText.join("")).toContain("SIGNALLED-DRAFT")
        const ended = yield* Fiber.await(program)
        expect(Exit.hasInterrupts(ended)).toBe(true)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    15_000,
  )

  // A highlight can hold a commit for its whole budget. Exit does not wait
  // for it: what the live view holds commits at once as plain text.
  it.scopedLive(
    "exit during a slow highlight still moves the live view into history",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const committedText: string[] = []
        let screen = Option.none<CliRenderer>()
        // A later answer pushes the first above the live tail, so it commits.
        const items: ListMessage[] = [
          assistant("earlier", "## SLOW-ANSWER\n\nbody"),
          assistant("later", longBody("LATER")),
          { ...assistant("open", "IN-FLIGHT-DRAFT"), draft: true },
        ]
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              streaming
              onRenderer={(renderer) => {
                screen = Option.some(renderer)
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        yield* Effect.promise(() => setup.flush())
        // The first answer's commit waits inside its settle, and never comes out.
        yield* hold.held
        yield* flushTranscriptForExit(Option.getOrThrow(screen))
        const history = committedText.join("")
        expect(history).toContain("SLOW-ANSWER")
        expect(history).not.toContain("#")
        expect(history).toContain("IN-FLIGHT-DRAFT")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})

// ── native transcript mouse ─────────────────────────────────────────────────

describe("native transcript mouse tracking", () => {
  it.scopedLive(
    "native history leaves the wheel to the terminal; the expanded view takes it back",
    () =>
      Effect.gen(function* () {
        const [expanded, setExpanded] = createSignal(false)
        const setup = yield* renderScoped(() => (
          <Transcript items={[]} expanded={expanded()} renderItems={() => <box />} />
        ))
        yield* Effect.promise(() => setup.renderOnce())
        expect(setup.renderer.useMouse).toBe(false)
        setExpanded(true)
        yield* Effect.promise(() => setup.renderOnce())
        expect(setup.renderer.useMouse).toBe(true)
        setExpanded(false)
        yield* Effect.promise(() => setup.renderOnce())
        expect(setup.renderer.useMouse).toBe(false)
      }),
  )
})

// ── native transcript fingerprint ───────────────────────────────────────────

/**
 * A committed item keeps its fingerprint when the feed rebuilds it.
 *
 * The transcript decides what already reached scrollback by comparing
 * fingerprints position by position. The feed builds one message two ways:
 * `createAssistantMessage` writes `_tag` first and omits `segments` and
 * `metadata`, while `buildMessages` spreads the body and appends `_tag` last.
 * The fingerprint names the drawn fields in a fixed order, so both spellings
 * give one string. Were they to differ, a rebuilt message would break the
 * committed prefix, force a replay, and clear the terminal's saved lines: the
 * reader would lose the session above the fold.
 */

/** The rebuild path spreads the body and appends `_tag` last. */
const rebuiltMessage = (id: string, content: string): ListMessage => {
  const body: Omit<ListMessage, "_tag"> = {
    id,
    role: "assistant",
    content,
    reasoning: "",
    images: [],
    createdAt: 0,
    segments: [{ _tag: "text", content }],
    metadata: absent,
  }
  return { ...body, _tag: "regular-message" }
}

const longBody = (label: string) =>
  Array.from({ length: 12 }, (_, index) => `${label} line ${index + 1}`).join("\n\n")

describe("transcript fingerprint", () => {
  test("the two construction paths agree on one message", () => {
    expect(transcriptFingerprint(assistant("m1", "hello"))).toBe(
      transcriptFingerprint(rebuiltMessage("m1", "hello")),
    )
  })

  test("new text still changes the fingerprint", () => {
    expect(transcriptFingerprint(rebuiltMessage("m1", "hello world"))).not.toBe(
      transcriptFingerprint(assistant("m1", "hello")),
    )
  })

  test("a tool call that completes changes the fingerprint", () => {
    const call: ToolCall = {
      id: "t1",
      toolName: "read",
      status: "running",
      input: absent,
      summary: absent,
      output: absent,
    }
    const base = rebuiltMessage("m1", "hello")
    const running: ListMessage = { ...base, segments: [{ _tag: "tool-call", toolCall: call }] }
    const done: ListMessage = {
      ...base,
      segments: [{ _tag: "tool-call", toolCall: { ...call, status: "completed", output: "ok" } }],
    }
    expect(transcriptFingerprint(running)).not.toBe(transcriptFingerprint(done))
  })

  test("a session event agrees across key orders", () => {
    const first: SessionItem = { _tag: "interruption", createdAt: 5, seq: 2 }
    const second: SessionItem = { createdAt: 5, seq: 2, _tag: "interruption" }
    expect(transcriptFingerprint(first)).toBe(transcriptFingerprint(second))
  })
})

describe("native transcript rebuild", () => {
  it.scopedLive(
    "a message rebuilt in the other key order does not replay scrollback",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const committedText: string[] = []
        const [items, setItems] = createSignal<ListMessage[]>([
          assistant("first", longBody("REBUILT-ITEM")),
          assistant("second", "TAIL"),
        ])

        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items()}
              onRenderer={(renderer) => {
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        yield* Effect.promise(() => setup.flush())
        yield* hold.held
        yield* hold.release
        yield* Effect.promise(() => setup.flush())
        yield* Effect.promise(() => setup.flush())
        yield* Effect.promise(() => setup.flush())

        expect(committedText.join("")).toContain("REBUILT-ITEM line 1")
        // One commit emits one snapshot, and the marker repeats inside it, so
        // the count is a fingerprint of the committed rows rather than a tally
        // of commits. What matters is that the rebuild adds nothing to it.
        const before = committedText.join("").split("REBUILT-ITEM line 1").length - 1

        // The feed re-reads the message and hands back the same text built the
        // other way. Nothing the reader sees has changed, so the committed rows
        // must stand instead of being written a second time.
        setItems([
          rebuiltMessage("first", longBody("REBUILT-ITEM")),
          rebuiltMessage("second", "TAIL"),
        ])
        yield* Effect.promise(() => setup.flush())
        yield* Effect.promise(() => setup.flush())
        yield* Effect.promise(() => setup.flush())

        const occurrences = committedText.join("").split("REBUILT-ITEM line 1").length - 1
        expect(occurrences).toBe(before)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})

// ── native transcript commit ────────────────────────────────────────────────

/**
 * Native history hands a completed item to scrollback and only then drops it
 * from the live view. Two things can interrupt that handover: an overlay that
 * takes the screen back while the surface settles, and a display clear that
 * lands between the settle and the commit. Both are held open here. An item
 * commits once the rows after it fill the live tail, so a test that needs
 * the whole item in history puts a long answer after it.
 */

describe("native transcript commit handover", () => {
  it.scopedLive(
    "an overlay that takes the screen mid-commit leaves the item in the live view",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const items = [assistant("first", longBody("FIRST-ITEM")), assistant("second", "TAIL")]
        const [overlayOpen, setOverlayOpen] = createSignal(false)
        const committedText: string[] = []

        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              overlayOpen={overlayOpen()}
              onRenderer={(renderer) => {
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        yield* Effect.promise(() => setup.flush())
        yield* hold.held

        // An overlay takes the screen while the commit is still held.
        setOverlayOpen(true)
        yield* Effect.promise(() => setup.flush())

        // Releasing now runs the commit against the alternate screen.
        yield* hold.release
        yield* Effect.promise(() => setup.flush())

        // The commit was refused, so nothing reached scrollback yet.
        expect(committedText.join("")).not.toContain("FIRST-ITEM line 1")

        // The overlay closes, the split footer returns, and the item that came
        // back is offered again. It must reach scrollback exactly once: an item
        // dropped from the live view without a commit is lost text.
        // The re-offer settles over several frames, and how many depends on
        // the machine's load; a fixed count of flushes failed under the
        // parallel gate. Flush until it lands, and let the assertion name the
        // failure when it never does.
        setOverlayOpen(false)
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({
            until: () => committedText.join("").includes("FIRST-ITEM line 1"),
            times: 200,
          }),
        )
        expect(committedText.join("")).toContain("FIRST-ITEM line 1")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // The terminal keeps its own screen under the alternate screen, so a
  // return finds history where it was. A replay would clear the screen and
  // the reader's own saved lines, then write history a second time.
  it.scopedLive(
    "closing an overlay keeps history as it is, with no replay",
    () =>
      Effect.gen(function* () {
        const items = [
          assistant("first", longBody("KEPT-ITEM")),
          assistant("later", longBody("LATER")),
          assistant("second", "TAIL"),
        ]
        const [overlayOpen, setOverlayOpen] = createSignal(false)
        const committedText: string[] = []
        const resets: string[] = []
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              overlayOpen={overlayOpen()}
              onRenderer={(renderer) => {
                const reset = renderer.resetSplitFooterForReplay.bind(renderer)
                Object.defineProperty(renderer, "resetSplitFooterForReplay", {
                  configurable: true,
                  value: (options?: { readonly clearSavedLines?: boolean }) => {
                    resets.push(`clearSavedLines=${String(options?.clearSavedLines === true)}`)
                    reset(options)
                  },
                })
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        const flushUntil = (done: () => boolean) =>
          Effect.promise(() => setup.flush()).pipe(
            Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }),
            Effect.timeout("3 seconds"),
            Effect.ignore,
          )
        yield* flushUntil(() => committedText.join("").includes("KEPT-ITEM line 12"))
        expect(committedText.join("")).toContain("KEPT-ITEM line 12")
        // The launch replays once; only what the overlay does counts here.
        resets.splice(0)

        setOverlayOpen(true)
        yield* Effect.promise(() => setup.flush())
        setOverlayOpen(false)
        // A replay would write the item again within these frames.
        yield* flushUntil(() => committedText.join("").split("KEPT-ITEM line 12").length > 2).pipe(
          Effect.timeout("1 second"),
          Effect.ignore,
        )
        expect(committedText.join("").split("KEPT-ITEM line 12").length - 1).toBe(1)
        expect(resets).toEqual([])
        expect(setup.renderer.screenMode).toBe("split-footer")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // A resize while the surface settles makes its rows the wrong width, and
  // the replay the resize asks for writes history again from the top. The
  // item must reach history once that replay runs, not vanish between them.
  it.scopedLive(
    "a resize mid-commit loses no item",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const items = [
          assistant("first", longBody("RESIZED-ITEM")),
          assistant("later", longBody("LATER")),
          assistant("second", "TAIL"),
        ]
        const committedText: string[] = []

        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              onRenderer={(renderer) => {
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        yield* Effect.promise(() => setup.flush())
        yield* hold.held
        setup.resize(50, 14)
        yield* Effect.promise(() => setup.flush())
        yield* hold.release
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({
            until: () => committedText.join("").includes("RESIZED-ITEM line 1"),
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("4 seconds"),
          Effect.ignore,
        )
        expect(committedText.join("")).toContain("RESIZED-ITEM line 1")
        // Written once, by the replay: the commit drawn for the old width wrote nothing.
        expect(committedText.join("").split("RESIZED-ITEM line 12").length - 1).toBe(1)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // The item leaves the live view only once scrollback has taken its rows:
  // a write scrollback refuses keeps it, and the next pass writes it.
  it.scopedLive(
    "a write scrollback refuses keeps the item and writes it on the next pass",
    () =>
      Effect.gen(function* () {
        const items = [
          assistant("first", longBody("REFUSED-ITEM")),
          assistant("later", longBody("LATER")),
          assistant("second", "TAIL"),
        ]
        const committedText: string[] = []
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              onRenderer={(renderer) => {
                refuseCommits(1)(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({
            until: () => committedText.join("").includes("REFUSED-ITEM line 1"),
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("4 seconds"),
          Effect.ignore,
        )
        const history = committedText.join("")
        expect(history).toContain("REFUSED-ITEM line 1")
        expect(history.split("REFUSED-ITEM line 12").length - 1).toBe(1)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive(
    "a display clear cancels a commit that is still settling",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const [displayRevision, setDisplayRevision] = createSignal(0)
        const committedText: string[] = []
        const items = [assistant("first", longBody("CLEARED-ITEM")), assistant("second", "TAIL")]

        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              displayRevision={displayRevision()}
              onRenderer={(renderer) => {
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        yield* Effect.promise(() => setup.flush())
        yield* hold.held

        // `/clear` bumps the revision while the commit is still held.
        setDisplayRevision(1)
        yield* Effect.promise(() => setup.flush())

        yield* hold.release
        yield* Effect.promise(() => setup.flush())
        yield* Effect.promise(() => setup.flush())

        expect(committedText.join("")).not.toContain("CLEARED-ITEM")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  /**
   * Scrollback is written by letting the committed rows scroll off the top of
   * the output region above the footer, so that region has to exist and has to
   * be scrollable. Two footer spellings destroy it: a footer grown to the
   * full screen leaves no region, and a per-commit footer change runs
   * OpenTUI's `applyScreenMode` mid-commit, which rewrites the screen with
   * `ESC[nS` and drops the rows instead of scrolling them away. Both report
   * success to the component while the terminal keeps no history at all.
   */
  it.scopedLive(
    "a tall live view still leaves the terminal rows to scroll",
    () =>
      Effect.gen(function* () {
        // Enough items that the live view wants far more than the 14 rows the
        // terminal has: an uncapped footer would grow to the full screen.
        const items = Array.from({ length: 8 }, (_, index) =>
          assistant(`item-${index}`, longBody(`ITEM-${index}`)),
        )
        const screenHeight = 14
        const footerHeights: number[] = []
        const committedFooterHeights: number[] = []

        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              onRenderer={(renderer) => {
                // Record the footer height the renderer actually holds at the
                // moment rows are handed to scrollback, and on every frame,
                // so a height that only exists mid-commit is still seen.
                renderer.on("external_output", () => {
                  committedFooterHeights.push(renderer.footerHeight)
                })
                renderer.on("frame", () => {
                  footerHeights.push(renderer.footerHeight)
                })
              }}
            />
          ),
          { width: 60, height: screenHeight },
        )
        for (let pass = 0; pass < 6; pass++) {
          yield* Effect.promise(() => setup.flush())
        }

        expect(footerHeights.length).toBeGreaterThan(0)
        // Every height the component asked for must leave a region the
        // terminal can scroll. One row cannot scroll, so two is the floor.
        for (const height of footerHeights) {
          expect(screenHeight - height).toBeGreaterThanOrEqual(2)
        }
        // And each commit ran against such a footer.
        for (const height of committedFooterHeights) {
          expect(screenHeight - height).toBeGreaterThanOrEqual(2)
        }
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive(
    "items reach scrollback in transcript order while an earlier commit still settles",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const items = [
          assistant("first", longBody("FIRST-ITEM")),
          assistant("second", longBody("SECOND-ITEM")),
          assistant("third", "TAIL"),
        ]
        const committedText: string[] = []

        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items}
              onRenderer={(renderer) => {
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        yield* Effect.promise(() => setup.flush())
        // The first item's commit waits in `settle`; the second is asked for
        // behind it. Scrollback is immutable, so the second must not land first.
        yield* hold.held
        yield* Effect.promise(() => setup.flush())
        yield* hold.release
        // Each settle waits on highlighting, whose time grows with the
        // machine's load: flush on a clock until the second item lands, with a
        // bound inside the test's own.
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({
            until: () => committedText.join("").includes("SECOND-ITEM line 1"),
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("8 seconds"),
          Effect.ignore,
        )
        const text = committedText.join("")
        expect(text).toContain("FIRST-ITEM line 1")
        expect(text).toContain("SECOND-ITEM line 1")
        expect(text.indexOf("FIRST-ITEM line 1")).toBeLessThan(text.indexOf("SECOND-ITEM line 1"))
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})

// ── sticky last prompt ──────────────────────────────────────────────────────

describe("sticky last prompt", () => {
  /** A user-role message an extension sent: a parent's message, a wake, a delegate start. */
  const extensionSent = (id: string, text: string): ListMessage => ({
    ...userMessage("regular-message", id, text),
    metadata: { extensionId: "@gent/delegate" },
  })
  const reply = (id: string, lines: number): ListMessage => {
    const text = Array.from({ length: lines }, (_, index) => `${id} line ${index + 1}`).join("\n\n")
    return {
      _tag: "regular-message",
      id,
      role: "assistant",
      content: text,
      reasoning: "",
      images: [],
      createdAt: 0,
      segments: [{ _tag: "text", content: text }],
    }
  }
  const count = (frame: string, text: string) => frame.split(text).length - 1

  /** The transcript over `items` with a three-row footer, as the session view mounts it. */
  const mountTranscript = (
    items: () => SessionItem[],
    options: { readonly streaming?: boolean; readonly height?: number; readonly footer?: number },
  ) =>
    Effect.gen(function* () {
      let extensionsLoaded = () => false
      const setup = yield* renderScoped(
        () => {
          extensionsLoaded = useExtensionUI().loaded
          return (
            <Transcript
              items={items()}
              streaming={options.streaming === true}
              footerHeight={options.footer ?? 3}
            />
          )
        },
        { width: 50, height: options.height ?? 16 },
      )
      yield* untilExtensionsLoaded(setup, () => extensionsLoaded())
      for (let pass = 0; pass < 6; pass++) yield* Effect.promise(() => setup.flush())
      return setup
    })

  it.scopedLive("no pinned row while the prompt is on screen", () =>
    Effect.gen(function* () {
      const setup = yield* mountTranscript(() => [clientPrompt("p1", "ASK-ONE"), reply("r1", 1)], {
        streaming: true,
      })
      // A short session: both items fit the live tail, and the terminal shows
      // the prompt once.
      const text = yield* waitForTerminal(
        setup,
        (next) => next.includes("ASK-ONE") && next.includes("r1 line 1"),
        "the prompt on screen",
      )
      expect(count(text, "ASK-ONE")).toBe(1)
      expect(text).not.toContain("↑ ASK-ONE")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a streaming reply that pushes the prompt out above pins it in one row", () =>
    Effect.gen(function* () {
      const setup = yield* mountTranscript(
        () => [clientPrompt("p1", "ASK-ONE"), reply("r1", 20), { ...reply("r2", 20), draft: true }],
        { streaming: true },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("↑ ASK-ONE"), "pinned")
      // The original is scrolled out, so the reader sees it once, pinned.
      expect(count(frame, "ASK-ONE")).toBe(1)
      const pinned = frame.split("\n").filter((line) => line.includes("↑ ASK-ONE"))
      expect(pinned).toHaveLength(1)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a prompt committed far into native history stays pinned, cut to the width", () =>
    Effect.gen(function* () {
      const long = `ASK-LONG ${"word ".repeat(40)}`
      const setup = yield* mountTranscript(
        () => [clientPrompt("p1", long), reply("r1", 20), { ...reply("r2", 20), draft: true }],
        { streaming: true },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("↑ ASK-LONG"), "pinned")
      const pinned = frame.split("\n").find((line) => line.includes("↑ ASK-LONG")) ?? ""
      expect(pinned.trimEnd()).toMatch(/…$/)
      expect(pinned.trimEnd().length).toBeLessThanOrEqual(50)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("the pinned row follows the branch in view", () =>
    Effect.gen(function* () {
      const [items, setItems] = createSignal<SessionItem[]>([
        clientPrompt("p1", "ASK-ONE"),
        reply("r1", 20),
        { ...reply("d1", 20), draft: true },
      ])
      const setup = yield* mountTranscript(items, { streaming: true })
      yield* waitForFrame(setup, (next) => next.includes("↑ ASK-ONE"), "pinned")
      // Another branch: its own last prompt, derived from its own messages.
      setItems([
        clientPrompt("p2", "ASK-TWO"),
        reply("r2", 20),
        { ...reply("d2", 20), draft: true },
      ])
      yield* waitForFrame(
        setup,
        (next) => next.includes("↑ ASK-TWO") && !next.includes("ASK-ONE"),
        "pinned on the other branch",
      )
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a message another agent sent after the reader's prompt leaves that prompt pinned",
    () =>
      Effect.gen(function* () {
        const setup = yield* mountTranscript(
          () => [
            clientPrompt("p1", "ASK-ONE"),
            reply("r1", 20),
            extensionSent("w1", "PARENT-SAYS"),
            // Still streaming: a finished reply would leave its top rows to
            // history, and a cut item pins nothing.
            { ...reply("r2", 20), draft: true },
          ],
          { streaming: true },
        )
        const frame = yield* waitForFrame(setup, (next) => next.includes("↑ ASK-ONE"), "pinned")
        expect(frame).not.toContain("↑ PARENT-SAYS")
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a steer the reader typed that joined the running turn is the pinned prompt", () =>
    Effect.gen(function* () {
      const steer: ListMessage = {
        ...userMessage("interjection-message", "s1", "STEER-NOW"),
        metadata: { fromClient: true },
      }
      const setup = yield* mountTranscript(
        () => [
          clientPrompt("p1", "ASK-ONE"),
          reply("r1", 4),
          steer,
          reply("r2", 20),
          { ...reply("r3", 20), draft: true },
        ],
        { streaming: true },
      )
      yield* waitForFrame(setup, (next) => next.includes("↑ STEER-NOW"), "pinned steer")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "in a /btw fork the fork's question is the pinned prompt, as the reader asked it",
    () =>
      Effect.gen(function* () {
        const asked: ListMessage = {
          ...userMessage(
            "regular-message",
            "btw-1",
            forkQuestionText(SessionId.make("01a0ca0cb3e7"), "WHY-THIS"),
          ),
          metadata: { customType: BTW_QUESTION_TYPE, extensionId: "@gent/btw" },
        }
        // A finished reply pushes the question deep into history, and a
        // streaming one keeps the turn running: the question is off screen.
        const setup = yield* mountTranscript(
          () => [asked, reply("r1", 20), { ...reply("r2", 20), draft: true }],
          { streaming: true },
        )
        const frame = yield* waitForFrame(setup, (next) => next.includes("↑ WHY-THIS"), "pinned")
        expect(frame).not.toContain("↑ A side question")
      }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a streaming reply's growth reads no history item: the pin work per frame is flat in history length",
    () =>
      Effect.gen(function* () {
        const HISTORY = 2_000
        let roleReads = 0
        /**
         * An assistant row that counts every read of its role: a scan of history
         * reads it. Each is a draft, so none commits while the turn runs and the
         * whole history stays in the live view, the largest view the pin reads.
         */
        const counted = (id: string): SessionItem => {
          const item: ListMessage = { ...reply(id, 1), draft: true }
          const { role } = item
          Object.defineProperty(item, "role", {
            get: () => {
              roleReads++
              return role
            },
          })
          return item
        }
        const history: SessionItem[] = [
          // A draft ahead of the prompt keeps the prompt in the live view too.
          { ...reply("d0", 1), draft: true },
          clientPrompt("p0", "ASK-ONE"),
          ...Array.from({ length: HISTORY }, (_, index) => counted(`h${index}`)),
        ]
        const tail = history.at(-1)
        const [grown, setGrown] = createSignal(1)
        let extensionsLoaded = () => false
        const setup = yield* renderScoped(
          () => {
            extensionsLoaded = useExtensionUI().loaded
            return (
              <Transcript
                items={history}
                streaming
                renderItems={(visible) => (
                  <Show when={visible[0] === tail} fallback={<text>row</text>}>
                    <text>{Array.from({ length: grown() }, () => "GROW").join("\n")}</text>
                  </Show>
                )}
              />
            )
          },
          { width: 50, height: 16 },
        )
        yield* untilExtensionsLoaded(setup, () => extensionsLoaded())
        yield* waitForFrame(setup, (next) => next.includes("↑ ASK-ONE"), "pinned")
        const before = roleReads
        for (let step = 2; step < 42; step++) {
          setGrown(step)
          yield* Effect.promise(() => setup.flush())
        }
        // Each growth step is a new measurement; none of them scans history.
        expect(roleReads - before).toBe(0)
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  it.scopedLive("a terminal too short for the row keeps the live tail and pins nothing", () =>
    Effect.gen(function* () {
      // Two rows left for the transcript: the live tail keeps them both.
      const setup = yield* mountTranscript(() => [clientPrompt("p1", "ASK-ONE"), reply("r1", 20)], {
        streaming: true,
        height: 12,
        footer: 9,
      })
      expect(renderFrame(setup)).not.toContain("↑ ASK-ONE")
    }).pipe(Effect.timeout("10 seconds")),
  )

  /**
   * Rows of exact heights: each draws `<ID>-TOP`, then `<id>-1` and on. The
   * text that reached native history collects in `committed`.
   */
  const mountExact = (
    rows: ReadonlyArray<{
      readonly item: SessionItem
      readonly name: string
      readonly lines: number
    }>,
  ) =>
    Effect.gen(function* () {
      let extensionsLoaded = () => false
      const committed: string[] = []
      const setup = yield* renderScoped(
        () => {
          extensionsLoaded = useExtensionUI().loaded
          useRenderer().on("external_output", (event: CliRendererExternalOutputEvent) => {
            committed.push(committedTextOf(event))
          })
          return (
            <Transcript
              items={rows.map((row) => row.item)}
              renderItems={(visible) => {
                const row = rows.find((candidate) => candidate.item === visible[0])
                const name = row?.name ?? ""
                const text = Array.from({ length: row?.lines ?? 1 }, (_, index) => {
                  if (index === 0) return `${name.toUpperCase()}-TOP`
                  return `${name}-${index}`
                }).join("\n")
                return <text>{text}</text>
              }}
            />
          )
        },
        { width: 50, height: 16 },
      )
      yield* untilExtensionsLoaded(setup, () => extensionsLoaded())
      for (let pass = 0; pass < 8; pass++) yield* Effect.promise(() => setup.flush())
      return { setup, committed }
    })

  it.scopedLive("a turn that starts over a cut answer pins nothing inside it", () =>
    Effect.gen(function* () {
      const settledItems: ListMessage[] = [
        clientPrompt("p1", "ASK-ONE"),
        reply("h1", 20),
        reply("a1", 20),
      ]
      const [items, setItems] = createSignal<ListMessage[]>(settledItems)
      const [streaming, setStreaming] = createSignal(false)
      let extensionsLoaded = () => false
      const setup = yield* renderScoped(
        () => {
          extensionsLoaded = useExtensionUI().loaded
          return bottomTranscript({
            items,
            streaming,
            footer: () => 3,
            paneOpen: () => false,
            overlayOpen: () => false,
            onRenderer: () => {},
          })
        },
        { width: 50, height: 16 },
      )
      yield* untilExtensionsLoaded(setup, () => extensionsLoaded())
      // At idle history takes the top rows of the answer; the rest stays live.
      yield* waitForTerminal(setup, (text) => text.includes("a1 line 1"), "the answer's top rows")
      // A turn another agent woke runs; the reader's last prompt is far up.
      setItems([
        ...settledItems,
        extensionSent("w1", "PARENT-SAYS"),
        { ...reply("d1", 1), draft: true },
      ])
      setStreaming(true)
      for (let pass = 0; pass < 6; pass++) yield* Effect.promise(() => setup.flush())
      const frame = yield* waitForFrame(setup, (next) => next.includes("d1 line 1"), "the draft")
      expect(frame).toContain("a1 line 20")
      expect(frame).not.toContain("↑ ASK-ONE")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("at idle a tail that fills its rows pins nothing and loses no line", () =>
    Effect.gen(function* () {
      // The tail's 11 rows fill the live rows exactly. At idle nothing is
      // pinned, so no row pushes the tail's top row out of view.
      const { setup, committed } = yield* mountExact([
        { item: clientPrompt("p0", "ASK-ONE"), name: "p0", lines: 1 },
        { item: reply("h1", 1), name: "h1", lines: 20 },
        { item: reply("tail", 1), name: "tail", lines: 11 },
      ])
      yield* waitForFrame(setup, (next) => next.includes("tail-10"), "the tail")
      for (let pass = 0; pass < 4; pass++) yield* Effect.promise(() => setup.flush())
      const frame = renderFrame(setup)
      const history = committed.join("")
      // A line is in view on screen or in native history, never in neither.
      const lost = ["TAIL-TOP", "tail-5", "tail-10"].filter(
        (line) => !frame.includes(line) && !history.includes(line),
      )
      expect(lost).toEqual([])
      expect(frame).not.toContain("↑ ASK-ONE")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a finished answer whose top rows history took pins nothing inside it", () =>
    Effect.gen(function* () {
      // At idle history takes the answer's top rows; the rest stays live under them.
      const { setup, committed } = yield* mountExact([
        { item: clientPrompt("p0", "ASK-ONE"), name: "p0", lines: 1 },
        { item: reply("h1", 1), name: "h1", lines: 20 },
        { item: reply("ans", 1), name: "ans", lines: 30 },
      ])
      yield* waitUntil(() => committed.join("").includes("ans-1"), "the answer's top rows")
      for (let pass = 0; pass < 4; pass++) yield* Effect.promise(() => setup.flush())
      const frame = renderFrame(setup)
      expect(frame).toContain("ans-29")
      // A pinned row here would sit between the answer's rows in history and on screen.
      expect(frame).not.toContain("↑ ASK-ONE")
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("readerPrompt", () => {
  const user = (
    metadata: ListMessage["metadata"],
    options: { readonly tag?: "regular-message" | "interjection-message" } = {},
  ): ListMessage => ({
    ...userMessage(options.tag ?? "regular-message", "m", "TEXT"),
    metadata,
  })
  const noTypes = () => Option.none<(content: string) => string>()
  const btwTypes = (customType: string) =>
    Option.liftPredicate(
      (content: string) => `asked: ${content}`,
      () => customType === "btw",
    )
  const read = (
    message: ListMessage,
    types: (customType: string) => Option.Option<(content: string) => string> = noTypes,
  ) => Option.getOrUndefined(readerPrompt(message, types))

  test("the reader's own messages are prompts: typed, or a steer that joined the turn", () => {
    expect(read(user({ fromClient: true }))).toBe("TEXT")
    expect(read(user({ fromClient: true }, { tag: "interjection-message" }))).toBe("TEXT")
  })

  test("a message another agent or an extension sent is not the reader's prompt", () => {
    // A parent's `session.send`, a delegate start, a wake, a legacy row with no origin.
    expect(read(user({ extensionId: "@gent/delegate" }))).toBeUndefined()
    expect(read(user({ extensionId: "@gent/wake", customType: "wake" }))).toBeUndefined()
    expect(read(user(absent))).toBeUndefined()
  })

  test("a hidden message is never a prompt", () => {
    expect(read(user({ fromClient: true, hidden: true }))).toBeUndefined()
  })

  test("a custom type whose renderer names it a prompt is the reader's, in its asked text", () => {
    expect(read(user({ extensionId: "@gent/btw", customType: "btw" }), btwTypes)).toBe(
      "asked: TEXT",
    )
    expect(read(user({ extensionId: "@gent/x", customType: "other" }), btwTypes)).toBeUndefined()
  })

  // A pane action the reader took (a `/btw` merge) is their own message, and
  // its renderer says what they asked; the text the model reads is not that.
  test("the reader's own message of a custom type that names a prompt pins its asked text", () => {
    expect(
      read(user({ fromClient: true, extensionId: "@gent/btw", customType: "btw" }), btwTypes),
    ).toBe("asked: TEXT")
    expect(read(user({ fromClient: true, customType: "other" }), btwTypes)).toBe("TEXT")
  })
})

describe("promptOnScreen", () => {
  const known =
    (rows: ReadonlyArray<number>) =>
    (index: number): Option.Option<number> =>
      Option.fromUndefinedOr(rows[index])

  test("a live prompt is on screen while its first row is at or below the viewport's top", () => {
    // Live content of 10 rows in a viewport of 6 (7 rows less the pinned one): rows 0-3 are cut.
    const at = (heights: ReadonlyArray<number>) =>
      promptOnScreen({
        heightAt: known(heights),
        index: 1,
        committed: 0,
        liveHeight: 10,
        liveRows: 7,
        scrollbackRows: 0,
      })
    // The prompt's text starts one row into its item, under the row's top margin.
    expect(at([3, 2, 5])).toBe(true)
    expect(at([2, 2, 6])).toBe(false)
  })

  test("a committed prompt is on screen while the history rows after it fit above the region", () => {
    const committed = (scrollbackRows: number) =>
      promptOnScreen({
        heightAt: known([2, 5, 4]),
        index: 0,
        committed: 2,
        liveHeight: 4,
        liveRows: 10,
        scrollbackRows,
      })
    // Its text row and the reply under it: 1 + 5 rows of history.
    expect(committed(6)).toBe(true)
    expect(committed(5)).toBe(false)
  })

  test("an unmeasured row counts as on screen, so nothing is pinned on a guess", () => {
    expect(
      promptOnScreen({
        heightAt: (index) => Option.liftPredicate(2, () => index === 1),
        index: 1,
        committed: 0,
        liveHeight: 40,
        liveRows: 5,
        scrollbackRows: 0,
      }),
    ).toBe(true)
  })

  test("a prompt deep in history reads only the rows on screen, not the history after it", () => {
    let reads = 0
    const onScreen = promptOnScreen({
      heightAt: () => {
        reads++
        return Option.some(2)
      },
      index: 0,
      committed: 2_000,
      liveHeight: 4,
      liveRows: 10,
      scrollbackRows: 12,
    })
    expect(onScreen).toBe(false)
    expect(reads).toBeLessThanOrEqual(8)
  })
})

describe("tool group rows", () => {
  const cwd = "/work/proj"
  const readCall = (id: string, path: string): ToolCall => ({
    id,
    toolName: "read",
    status: "completed",
    input: { path },
    summary: absent,
    output: "one\ntwo",
  })
  /** A session in view rooted at `sessionCwd`, while the TUI launched in `cwd`. */
  const sessionAt = (sessionCwd: string) => ({
    initialSession: {
      id: SessionId.make("session-elsewhere"),
      activeBranchId: BranchId.make("branch-elsewhere"),
      name: "Elsewhere",
      cwd: sessionCwd,
      createdAt: dateFromMillis(0),
      updatedAt: dateFromMillis(0),
    },
  })
  // The session in view runs where the TUI launched unless a test says otherwise.
  const groupRows = (items: SessionItem[], width: number, sessionCwd = cwd) =>
    renderScoped(
      () => <MessageList items={items} disclosure="preview" syntaxStyle={syntaxStyle} />,
      {
        width,
        height: 20,
        cwd,
        ...sessionAt(sessionCwd),
      },
    ).pipe(
      Effect.map((setup) =>
        renderFrame(setup)
          .split("\n")
          .filter((line) => line.trim().length > 0),
      ),
    )
  const callLabels = (lines: ReadonlyArray<string>) =>
    lines
      .values()
      .filter((line) => line.includes("├") || line.includes("└"))
      .map((line) => line.trim().split(/\s{2,}/)[0])
      .toArray()

  it.scopedLive("the group row and the read frame name the file from the cwd", () =>
    Effect.gen(function* () {
      const call = readCall("call-read-path", `${cwd}/apps/tui/src/app.tsx`)
      const rows = yield* groupRows([assistantToolMessage("assistant-read-path", call)], 80)
      expect(callLabels(rows)).toEqual(["└ Read apps/tui/src/app.tsx"])
      const ReadToolRenderer = builtinRenderer("read")
      const frame = yield* renderScoped(
        () => <ReadToolRenderer expanded={false} toolCall={call} />,
        {
          width: 80,
          height: 10,
          cwd,
        },
      )
      const header = renderFrame(frame).split("\n")[0] ?? ""
      expect(header).toContain("read apps/tui/src/app.tsx")
      expect(header).not.toContain(cwd)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("paths read from the cwd of the session in view, not the launch cwd", () =>
    Effect.gen(function* () {
      const inLaunch = readCall("call-read-launch", `${cwd}/config.ts`)
      const inSession = readCall("call-read-session", "/work/other/src/app.tsx")
      const rows = yield* groupRows(
        [
          assistantToolMessage("assistant-read-launch", inLaunch),
          assistantToolMessage("assistant-read-session", inSession),
        ],
        80,
        "/work/other",
      )
      // Two tool-only steps are one run: one row folds both reads.
      expect(callLabels(rows)).toEqual([`└ Read ${cwd}/config.ts, src/app.tsx`])
      const ReadToolRenderer = builtinRenderer("read")
      const frame = yield* renderScoped(
        () => <ReadToolRenderer expanded={false} toolCall={inSession} />,
        {
          width: 80,
          height: 10,
          cwd,
          ...sessionAt("/work/other"),
        },
      )
      expect(renderFrame(frame).split("\n")[0]).toContain("read src/app.tsx")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a path outside the cwd keeps its full spelling", () =>
    Effect.gen(function* () {
      const call = readCall("call-read-outside", "/etc/hosts")
      const rows = yield* groupRows([assistantToolMessage("assistant-read-outside", call)], 80)
      expect(callLabels(rows)).toEqual(["└ Read /etc/hosts"])
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a frame header with a long path keeps one line", () =>
    Effect.gen(function* () {
      const path = "/var/lib/very/long/path/that/does/not/fit/in/forty/columns/app.tsx"
      const ReadToolRenderer = builtinRenderer("read")
      const frame = yield* renderScoped(
        () => <ReadToolRenderer expanded={false} toolCall={readCall("call-long", path)} />,
        { width: 40, height: 10, cwd },
      )
      const lines = renderFrame(frame).split("\n")
      expect(lines[0]).toContain("read")
      expect(lines[1]).not.toContain("columns")
      expect(lines[1]).not.toContain("app.tsx")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive("a long row keeps one line and names no call id near 60 columns", () =>
    Effect.gen(function* () {
      const call: ToolCall = {
        id: "dbg-review",
        toolName: "bash",
        status: "completed",
        input: { command: "echo sanity-check the debug session bootstrap and the queue semantics" },
        summary: absent,
        output: absent,
      }
      for (const width of [59, 60, 61]) {
        const lines = yield* groupRows([assistantToolMessage("assistant-long-row", call)], width)
        const row = lines.findIndex((line) => line.includes("└ Ran"))
        expect(lines[row]).toContain("└ Ran echo sanity-")
        expect(lines.join("\n")).not.toContain("dbg-review")
        expect(lines.slice(row + 1).join("\n")).not.toContain("semantics")
      }
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("message rows", () => {
  it.scopedLive("a steer row draws its text, and an answer its reasoning from the preview on", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        {
          _tag: "interjection-message",
          id: "user-1",
          role: "user",
          content: "Stop and switch agent",
          reasoning: "",
          images: [],
          createdAt: 0,
        } satisfies ListMessage,
        {
          _tag: "regular-message",
          id: "assistant-1",
          role: "assistant",
          content: "Switching now",
          reasoning: "Considering current todo state",
          images: [],
          createdAt: 0,
          // The feed spells an assistant answer as segments in part order,
          // with the flat fields alongside for readers that want the whole
          // text at once.
          segments: [
            { _tag: "reasoning", content: "Considering current todo state" },
            { _tag: "text", content: "Switching now" },
          ],
        } satisfies ListMessage,
      ]
      const setup = yield* renderScoped(() => (
        <MessageList items={items} disclosure="preview" syntaxStyle={syntaxStyle} />
      ))
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("Stop and switch agent")
      expect(frame).toContain("∴ Thought · Considering current todo state")
    }),
  )
})

// ── tool runs across steps ──────────────────────────────────────────────────

describe("tool runs across steps", () => {
  /** One step: a cell whose ops are commands, then the segments given after it. */
  const step = (
    id: string,
    commands: ReadonlyArray<string>,
    options: {
      readonly before?: ReadonlyArray<AssistantSegment>
      readonly after?: ReadonlyArray<AssistantSegment>
      readonly tool?: string
      readonly stdout?: string
    } = {},
  ): ListMessage => {
    const tool = options.tool ?? "bash"
    const toolCall: ToolCall = {
      id: `${id}-cell`,
      toolName: "cell",
      status: "completed",
      input: { code: "await tools.bash({ command: 'x' })" },
      summary: absent,
      output: encodeJson({ display: "", bindings: [], truncated: false }),
      operations: commands.map((command, index) => ({
        id: `${id}-op-${index}`,
        toolName: tool,
        status: "completed",
        input: { command, question: command, path: command },
        summary: absent,
        output: encodeJson({
          stdout: options.stdout ?? `${command} ok\n`,
          stderr: "",
          exitCode: 0,
        }),
      })),
    }
    return {
      _tag: "regular-message",
      id,
      role: "assistant",
      content: "",
      reasoning: "",
      images: [],
      createdAt: 0,
      segments: [
        ...(options.before ?? []),
        { _tag: "tool-call", toolCall },
        ...(options.after ?? []),
      ],
    }
  }
  const text = (content: string): AssistantSegment => ({ _tag: "text", content })
  const reasoning = (content: string): AssistantSegment => ({ _tag: "reasoning", content })
  const headers = (frame: string) =>
    frame
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[●✗○] /.test(line))
  const draw = (items: SessionItem[], disclosure: DisclosureLevel, width = 100) =>
    renderScoped(
      () => <MessageList items={items} disclosure={disclosure} syntaxStyle={syntaxStyle} />,
      { width, height: 60 },
    ).pipe(Effect.map(renderFrame))

  it.scopedLive("the tool-only steps of a turn draw one group", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        clientPrompt("run-prompt", "check the tree"),
        step("s1", ["git status"]),
        step("s2", ["bun test", "bun run lint"]),
        step("s3", ["git diff"], { after: [text("All clean.")] }),
      ]
      const collapsed = yield* draw(items, "collapsed")
      expect(headers(collapsed)).toEqual(["● Ran 4 commands"])
      expect(collapsed).toContain("All clean.")
      const preview = yield* draw(items, "preview")
      expect(preview).toContain("└ Ran git status, bun test, bun run lint, git diff")
    }),
  )

  // The preview's output head belongs to the run's last call. While a step may
  // still join, that call changes with each step: a head drawn for one step
  // and dropped at the next would shrink the live tail, and the rows it
  // pushed into scrollback come back blank. So the head waits for the run's end.
  it.scopedLive("the preview heads the last command's output only once the run has ended", () =>
    Effect.gen(function* () {
      const open: SessionItem[] = [
        clientPrompt("head-prompt", "look around"),
        step("o1", ["ls"], { stdout: "FIRST-STEP-OUTPUT\n" }),
        step("o2", ["git status"], { stdout: "SECOND-STEP-OUTPUT\n" }),
      ]
      const [streaming, setStreaming] = createSignal(true)
      const committed: string[] = []
      const setup = yield* renderScoped(
        () => (
          <Transcript
            items={open}
            streaming={streaming()}
            disclosure="preview"
            onRenderer={(renderer) =>
              renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                committed.push(committedTextOf(event))
              })
            }
          />
        ),
        { width: 100, height: 40 },
      )
      // The screen and the rows already handed to native history.
      const shown = () =>
        Effect.promise(() => setup.renderOnce()).pipe(
          Effect.map(() => [...committed, renderFrame(setup)].join("\n")),
        )
      // A turn runs and no answer ended the run: a step may still join it.
      const running = yield* shown()
      expect(running).toContain("● Ran 2 commands")
      expect(running).not.toContain("STEP-OUTPUT")
      // A turn that ends with no answer (an interrupt) ends the run.
      setStreaming(false)
      // The tail's new bottom rows show a frame after it grows.
      yield* waitForFrame(setup, (frame) => frame.includes("SECOND-STEP-OUTPUT"), "the preview")
      const ended = yield* shown()
      expect(ended).toContain("│ SECOND-STEP-OUTPUT")
      expect(ended).not.toContain("FIRST-STEP-OUTPUT")
    }).pipe(Effect.timeout("8 seconds")),
  )

  it.scopedLive("answer text between steps ends a run, and a new one starts after it", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        step("t1", ["git status"]),
        step("t2", ["bun test"], { after: [text("Tests pass; now the lint.")] }),
        step("t3", ["bun run lint"]),
        step("t4", ["git diff"]),
      ]
      const frame = yield* draw(items, "collapsed")
      expect(headers(frame)).toEqual(["● Ran 2 commands", "● Ran 2 commands"])
      const first = frame.indexOf("● Ran 2 commands")
      const prose = frame.indexOf("Tests pass")
      expect(prose).toBeGreaterThan(first)
      expect(frame.indexOf("● Ran 2 commands", first + 1)).toBeGreaterThan(prose)
    }),
  )

  it.scopedLive("an ask ends a run after its call", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        step("a1", ["git status"]),
        step("a2", ["Ship it?"], { tool: "ask_user" }),
        step("a3", ["git push"]),
      ]
      const frame = yield* draw(items, "preview")
      expect(headers(frame)).toEqual(["● Ran 1 command · asked 1 question", "● Ran 1 command"])
      expect(frame).toContain("└ Asked Ship it?")
    }),
  )

  it.scopedLive(
    "reasoning before and between a run's steps stays out of its header and opens at full",
    () =>
      Effect.gen(function* () {
        const items: SessionItem[] = [
          step("r1", ["git status"], { before: [reasoning("FIRST-THOUGHT")] }),
          step("r2", ["bun test"], { before: [reasoning("SECOND-THOUGHT"), text("  ")] }),
        ]
        for (const disclosure of ["collapsed", "preview"] as const) {
          const frame = yield* draw(items, disclosure)
          expect(headers(frame)).toEqual(["● Ran 2 commands"])
          expect(frame).not.toContain("THOUGHT")
        }
        const full = yield* draw(items, "full")
        const lines = full.split("\n")
        const first = lines.findIndex((line) => line.includes("FIRST-THOUGHT"))
        const thought = lines.findIndex((line) => line.includes("SECOND-THOUGHT"))
        const firstRow = lines.findIndex((line) => line.includes("├ cell"))
        const secondRow = lines.findIndex((line) => line.includes("└ cell"))
        expect(first).toBeLessThan(firstRow)
        expect(first).toBeGreaterThan(lines.findIndex((line) => line.includes("● Ran 2 commands")))
        expect(thought).toBeGreaterThan(firstRow)
        expect(secondRow).toBeGreaterThan(thought)
      }),
  )

  it.scopedLive("a run's rows clip to one line each at 60 columns", () =>
    Effect.gen(function* () {
      const paths = Array.from({ length: 6 }, (_, index) => `src/module-${index}/file.ts`)
      const items: SessionItem[] = [
        step("w1", paths.slice(0, 3), { tool: "read" }),
        step("w2", paths.slice(3), { tool: "read" }),
        step("w3", ["bun run test --filter a-very-long-filter-name-that-does-not-fit"]),
      ]
      const frame = yield* draw(items, "preview", 60)
      const drawn = frame.split("\n").filter((line) => line.trim().length > 0)
      expect(drawn.every((line) => line.trimEnd().length <= 60)).toBe(true)
      expect(headers(frame)).toEqual(["● Read 6 files · ran 1 command"])
      // The reads fold into one row: the subjects that fit, then a count.
      const reads = drawn.find((line) => line.includes("├ Read")) ?? ""
      expect(reads.trimEnd()).toMatch(/├ Read src\/module-0\/file\.ts, .* \+\d$/)
      expect(drawn.some((line) => line.includes("└ Ran bun run test"))).toBe(true)
    }),
  )

  // The header fits the columns its row has: the answer indent, the glyph
  // and its space, and the column every transcript row keeps free.
  it.scopedLive(
    "a header as long as the row once had room for drops a kind, and the renderer cuts no word",
    () =>
      Effect.gen(function* () {
        const items: SessionItem[] = [
          step("x1", ["a.ts", "b.ts", "c.ts"], { tool: "read" }),
          step("x2", ["mkdir x", "ls"]),
          step("x3", ["TODO"], { tool: "grep" }),
          step("x4", ["a.ts"], { tool: "edit" }),
        ]
        // The transcript surface, which keeps the terminal's last column free.
        const drawLive = (width: number) =>
          renderScoped(() => <Transcript items={items} />, { width, height: 30 }).pipe(
            Effect.map(renderFrame),
          )
        const whole = "Read 3 files · ran 2 commands · searched 1 pattern · edited 1 file"
        expect(headers(yield* drawLive(100))).toEqual([`● ${whole}`])
        // At `whole.length + 4` the header filled the columns the old rule
        // gave it, one more than its row has.
        for (const width of [whole.length + 4, whole.length + 5]) {
          const [header = ""] = headers(yield* drawLive(width))
          expect(header).not.toMatch(/\.\.\.|…/)
          expect(header).toMatch(
            /^● Read 3 files( · (ran 2 commands|searched 1 pattern|edited 1 file))*$/,
          )
          expect(header.length).toBeLessThanOrEqual(width - 3)
        }
        expect(headers(yield* drawLive(whole.length + 5))).toEqual([`● ${whole}`])
      }),
  )

  it.scopedLive(
    "native history takes a run's head only once the run ends, with every step in it",
    () =>
      Effect.gen(function* () {
        const prompt = clientPrompt("history-prompt", "RUN-PROMPT")
        const thinking = (body: string): ListMessage => ({
          ...assistant("thinking", ""),
          segments: [reasoning(body)],
          draft: true,
        })
        const [items, setItems] = createSignal<ListMessage[]>([
          assistant("earlier", longBody("EARLIER")),
          prompt,
          step("h1", ["git status"]),
          step("h2", ["bun test"]),
          thinking(longBody("THINKING")),
        ])
        const committedText: string[] = []
        const setup = yield* renderScoped(
          () => (
            // At the full level the reasoning draws whole, so its rows push
            // the earlier items to history while the run is open.
            <Transcript
              items={items()}
              streaming={true}
              disclosure="full"
              onRenderer={(renderer) => {
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        const flushUntil = (done: () => boolean) =>
          Effect.promise(() => setup.flush()).pipe(
            Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }),
            Effect.timeout("4 seconds"),
            Effect.ignore,
          )
        // The prompt moves to history; the run is open (a step may still
        // join it), so its head waits in the live view with both steps.
        yield* flushUntil(() => committedText.join("").includes("RUN-PROMPT"))
        expect(committedText.join("")).toContain("RUN-PROMPT")
        expect(committedText.join("")).not.toContain("● Ran")
        yield* flushUntil(() => false).pipe(Effect.timeout("300 millis"), Effect.ignore)
        expect(committedText.join("")).not.toContain("● Ran")
        // A third step joins, and the stored answer ends the run: the head
        // moves to history once, with all three steps under one header.
        setItems([
          assistant("earlier", longBody("EARLIER")),
          prompt,
          step("h1", ["git status"]),
          step("h2", ["bun test"]),
          step("h3", ["git diff"]),
          assistant("answer", longBody("ANSWER")),
        ])
        yield* flushUntil(() => committedText.join("").includes("ANSWER line 1"))
        const history = committedText.join("")
        expect(history.match(/● Ran \d+ commands?/g)).toEqual(["● Ran 3 commands"])
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // Each step after a run's head draws nothing: the head took its call. An
  // item that draws nothing live writes no row to history either.
  it.scopedLive(
    "the tool-only steps of a run commit no blank rows to history",
    () =>
      Effect.gen(function* () {
        const rows: string[] = []
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={[
                clientPrompt("blank-prompt", "RUN-PROMPT"),
                step("b1", ["git status"]),
                step("b2", ["bun test"]),
                step("b3", ["git diff"]),
                step("b4", ["ls"]),
                assistant("blank-answer", "AFTER-RUN"),
                assistant("blank-tail", longBody("TAIL")),
              ]}
              onRenderer={(renderer) => {
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  // A commit ends on its last row: its rows, without the break after them.
                  rows.push(...committedTextOf(event, true).replace(/\n$/, "").split("\n"))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({
            until: () => rows.some((row) => row.includes("TAIL line 1")),
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("6 seconds"),
          Effect.ignore,
        )
        const header = rows.findIndex((row) => row.includes("● Ran 4 commands"))
        const answer = rows.findIndex((row) => row.includes("AFTER-RUN"))
        expect(header).toBeGreaterThanOrEqual(0)
        // One blank row parts the run from the answer, as on screen.
        expect(rows.slice(header + 1, answer).map((row) => row.trim())).toEqual([""])
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive("a run that grows after history took its head replays history", () =>
    Effect.gen(function* () {
      const stdout = Array.from({ length: 40 }, (_, index) => `OUT line ${index + 1}`).join("\n")
      const [items, setItems] = createSignal<ListMessage[]>([
        clientPrompt("grow-prompt", "GROW-PROMPT"),
        step("g1", ["seq 30"], { stdout }),
      ])
      const committedText: string[] = []
      const setup = yield* renderScoped(
        () => (
          <Transcript
            items={items()}
            disclosure="full"
            onRenderer={(renderer) => {
              renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                committedText.push(committedTextOf(event))
              })
            }}
          />
        ),
        { width: 60, height: 12 },
      )
      const flushUntil = (done: () => boolean) =>
        Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }),
          Effect.timeout("4 seconds"),
          Effect.ignore,
        )
      // At idle the run's top rows move to history: its header with one tool.
      yield* flushUntil(() => committedText.join("").includes("● Ran 1 command"))
      expect(committedText.join("")).toContain("● Ran 1 command")
      // A step joins the run history holds: history replays with the run's new header.
      committedText.splice(0)
      setItems([
        clientPrompt("grow-prompt", "GROW-PROMPT"),
        step("g1", ["seq 30"], { stdout }),
        step("g2", ["git diff"]),
      ])
      yield* flushUntil(() => committedText.join("").includes("● Ran 2 commands"))
      expect(committedText.join("")).toContain("● Ran 2 commands")
      expect(committedText.join("")).toContain("GROW-PROMPT")
    }).pipe(Effect.timeout("10 seconds")),
  )

  // A step streams its thought before its call. Drawn on its own, the thought
  // left the live tail when the call joined the run's head, and a tail that
  // shrinks under an item history holds the top of replays the transcript:
  // the screen clears and every row is written again, so the flicker grew
  // with the session. The run takes the thought at once instead.
  it.scopedLive(
    "a running turn's steps write history only for their own rows, however long the session",
    () =>
      Effect.gen(function* () {
        const thinking = (id: string): ListMessage => ({
          _tag: "regular-message",
          id,
          role: "assistant",
          content: "",
          reasoning: "",
          images: [],
          createdAt: 0,
          segments: [reasoning(`THOUGHT ${id}`)],
        })
        const joined = (id: string, command: string) =>
          step(id, [command], { before: [reasoning(`THOUGHT ${id}`)] })
        const turnOutput = (answers: number) =>
          Effect.gen(function* () {
            const history = [
              ...Array.from({ length: answers }, (_, index) =>
                assistant(`old-${index}`, `OLD-ANSWER ${index}`),
              ),
              assistant("last", longBody("LAST")),
              clientPrompt("turn-prompt", "TURN-PROMPT"),
            ]
            const [items, setItems] = createSignal<ListMessage[]>([
              ...history,
              step("t1", ["git status"]),
            ])
            const committedText: string[] = []
            const resets: string[] = []
            const setup = yield* renderScoped(
              () => (
                <Transcript
                  items={items()}
                  streaming
                  onRenderer={(renderer) => {
                    const reset = renderer.resetSplitFooterForReplay.bind(renderer)
                    Object.defineProperty(renderer, "resetSplitFooterForReplay", {
                      configurable: true,
                      value: (options?: { readonly clearSavedLines?: boolean }) => {
                        resets.push(`clearSavedLines=${String(options?.clearSavedLines === true)}`)
                        reset(options)
                      },
                    })
                    renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                      committedText.push(committedTextOf(event))
                    })
                  }}
                />
              ),
              { width: 60, height: 14 },
            )
            const flushUntil = (
              done: () => boolean,
              limit: "1 second" | "10 seconds" = "10 seconds",
            ) =>
              Effect.promise(() => setup.flush()).pipe(
                Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }),
                Effect.timeout(limit),
                Effect.ignore,
              )
            // History takes every row above the live tail: the last answer's top rows too.
            yield* flushUntil(() => committedText.join("").includes("LAST line 3"))
            expect(committedText.join("")).toContain("LAST line 3")
            // The launch replays once; only what the turn writes counts here.
            resets.splice(0)
            committedText.splice(0)
            const play = (next: ReadonlyArray<ListMessage>, frameHolds: string) =>
              Effect.gen(function* () {
                setItems([...history, ...next])
                yield* flushUntil(() => renderFrame(setup).includes(frameHolds))
                expect(renderFrame(setup)).toContain(frameHolds)
              })
            yield* play([step("t1", ["git status"]), thinking("t2")], "● Ran 1 command")
            yield* play([step("t1", ["git status"]), joined("t2", "bun test")], "● Ran 2 commands")
            // A replay comes once blank rows have stood inside an item for 300 ms.
            yield* flushUntil(() => resets.length > 0, "1 second")
            yield* play(
              [step("t1", ["git status"]), joined("t2", "bun test"), thinking("t3")],
              "● Ran 2 commands",
            )
            yield* play(
              [step("t1", ["git status"]), joined("t2", "bun test"), joined("t3", "git diff")],
              "● Ran 3 commands",
            )
            yield* flushUntil(() => resets.length > 0, "1 second")
            return { resets, committed: committedText.join("") }
          })
        const short = yield* turnOutput(10)
        const long = yield* turnOutput(200)
        expect(short.resets).toEqual([])
        expect(long.resets).toEqual([])
        expect(long.committed).not.toContain("OLD-ANSWER")
        expect(long.committed).toBe(short.committed)
      }).pipe(Effect.timeout("50 seconds")),
    55_000,
  )
})

// ── collapse ladder ─────────────────────────────────────────────────────────

/**
 * Every block is a node on one ladder. Collapsed is the head line and one
 * line a failure; preview is the head and a `├`/`└` row a child, one line
 * each, with a five-row head of its own output under a failed row and the
 * run's last command; full opens the bodies.
 */
describe("collapse ladder", () => {
  const DENIED = "ls: cannot access 'gent-debug-tools/d.ts': No such file or directory"
  /** What a cell's last expression showed: an inspect dump no preview draws. */
  const DUMP = `{ stdout: '', stderr: "${DENIED}\\n", exitCode: 2 }`
  const op = (
    id: string,
    toolName: string,
    input: Readonly<Record<string, string>>,
    output: string,
  ): ToolCall => ({ id, toolName, status: "completed", input, summary: absent, output })
  const bashOutput = (stdout: string, stderr: string, exitCode: number) =>
    encodeJson({ stdout, stderr, exitCode })
  /** One step of the scripted `debug tools` turn: reasoning, then one cell that runs `ops`. */
  const cellStep = (
    id: string,
    reasoningText: string,
    operations: ReadonlyArray<ToolCall>,
    display = "",
  ): ListMessage => ({
    _tag: "regular-message",
    id,
    role: "assistant",
    content: "",
    reasoning: reasoningText,
    images: [],
    createdAt: 0,
    segments: [
      { _tag: "reasoning", content: reasoningText },
      {
        _tag: "tool-call",
        toolCall: {
          id: `${id}-cell`,
          toolName: "cell",
          status: "completed",
          input: { code: "await tools.bash({ command: 'x' })" },
          summary: absent,
          output: encodeJson({ display, bindings: [], truncated: false }),
          operations: [...operations],
        },
      },
    ],
  })
  const file = (name: string) => `gent-debug-tools/${name}.ts`
  /** The scripted `debug tools` turn: six steps, the last bash exits 2, then the answer. */
  const debugTurn = (): SessionItem[] => [
    clientPrompt("dbg-prompt", "debug tools"),
    cellStep("dbg-0", "Set up a scratch fixture to work on.", [
      op(
        "dbg-0-0",
        "bash",
        { command: "mkdir -p gent-debug-tools && sleep 1" },
        bashOutput("", "", 0),
      ),
    ]),
    cellStep(
      "dbg-1",
      "Read the three files together.",
      ["a", "b", "c"].map((name) =>
        op(
          `dbg-1-${name}`,
          "read",
          { path: file(name) },
          encodeJson({ content: "1\tx", path: file(name), lineCount: 1, truncated: false }),
        ),
      ),
    ),
    cellStep("dbg-2", "Find the open TODOs.", [
      op(
        "dbg-2-0",
        "grep",
        { pattern: "TODO", path: "gent-debug-tools" },
        encodeJson({ matches: [], truncated: false }),
      ),
    ]),
    cellStep("dbg-3", "Widen the greeting.", [
      {
        ...op(
          "dbg-3-0",
          "edit",
          { path: file("a"), oldString: '"hello"', newString: '"hello, world"' },
          encodeJson({ path: file("a"), replacements: 1 }),
        ),
      },
    ]),
    cellStep(
      "dbg-4",
      "Check for the file the TODO wants; it does not exist yet.",
      [
        op(
          "dbg-4-0",
          "bash",
          { command: "sleep 2; ls gent-debug-tools/d.ts" },
          bashOutput("", `${DENIED}\n`, 2),
        ),
      ],
      DUMP,
    ),
    {
      ...assistant("dbg-answer", "The check for d.ts failed: it does not exist yet."),
      reasoning: "Summarize.",
      segments: [
        { _tag: "reasoning", content: "Summarize." },
        { _tag: "text", content: "The check for d.ts failed: it does not exist yet." },
      ],
    },
  ]
  const draw = (items: SessionItem[], disclosure: DisclosureLevel, width: number) =>
    renderScoped(
      () => <MessageList items={items} disclosure={disclosure} syntaxStyle={syntaxStyle} />,
      { width, height: 60 },
    ).pipe(Effect.map(renderFrame))
  const lines = (frame: string) => frame.split("\n").map((line) => line.trimEnd())
  /** The rows under the group header, up to the first blank row. */
  const groupRows = (frame: string) => {
    const all = lines(frame)
    const header = all.findIndex((line) => /^ {2}[●✗○] /.test(line))
    const end = all.findIndex((line, index) => index > header && line.trim().length === 0)
    return all.slice(header + 1, end)
  }

  it.scopedLive(
    "collapsed draws each failure as one row under the header, at 120 and 60 columns",
    () =>
      Effect.gen(function* () {
        const wide = yield* draw(debugTurn(), "collapsed", 120)
        const [failure, ...rest] = groupRows(wide)
        expect(rest).toEqual([])
        expect(failure).toStartWith(
          "  └ Ran sleep 2; ls gent-debug-tools/d.ts · exit 2 · ls: cannot access",
        )
        expect(failure?.length ?? 0).toBeLessThanOrEqual(119)
        expect(wide).not.toContain("Ran mkdir")
        const narrow = yield* draw(debugTurn(), "collapsed", 60)
        // The reason is cut first; the verb, the command and the exit status stay.
        expect(groupRows(narrow)).toEqual([
          "  └ Ran sleep 2; ls gent-debug-tools/d.ts · exit 2 · ls: c…",
        ])
        expect(lines(narrow).every((line) => line.length <= 59)).toBe(true)
      }),
  )

  it.scopedLive("a failed call's collapsed row names its reason, not its frame or call id", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        assistantToolMessage(
          "assistant-read-failed",
          runnerFailure(
            "call-read-failed",
            "read",
            { path: "/tmp/missing.txt" },
            "ENOENT: no such file",
          ),
        ),
      ]
      for (const width of [120, 60]) {
        const frame = yield* draw(items, "collapsed", width)
        expect(groupRows(frame)).toEqual([
          "  └ Read /tmp/missing.txt · failed · ENOENT: no such file",
        ])
        expect(frame).not.toContain("#call-read-failed")
      }
    }),
  )

  // The command exits 2 and returns; the cell then throws for a reason of its
  // own. Both failures show at collapsed and preview, the header counts both.
  it.scopedLive(
    "a cell that throws after a failed command shows both failures, at 120 and 60",
    () =>
      Effect.gen(function* () {
        const cell: ToolCall = {
          id: "both-cell",
          toolName: "cell",
          status: "error",
          input: { code: "await tools.bash({ command: 'ls d.ts' }); undefinedName()" },
          summary: "ReferenceError: undefinedName is not defined",
          output: encodeJson({ error: "ReferenceError: undefinedName is not defined" }),
          operations: [
            op("both-op", "bash", { command: "ls d.ts" }, bashOutput("", `${DENIED}\n`, 2)),
          ],
        }
        const items: SessionItem[] = [assistantToolMessage("both", cell)]
        for (const width of [120, 60]) {
          const collapsed = yield* draw(items, "collapsed", width)
          const header = lines(collapsed).find((line) => line.includes("● ") || line.includes("✗ "))
          expect(header).toContain("· 2 failed")
          const rows = groupRows(collapsed)
          expect(rows).toHaveLength(2)
          expect(rows[0]).toStartWith("  ├ Ran ls d.ts · exit 2")
          expect(rows[1]).toStartWith("  └ cell · failed · ReferenceError")
          const preview = groupRows(yield* draw(items, "preview", width))
          expect(preview[0]).toStartWith("  ├ Ran ls d.ts · exit 2")
          expect(preview.some((row) => row.startsWith("  └ cell · failed"))).toBe(true)
          expect(preview.at(-1)).toStartWith("    │ ReferenceError: undefinedName")
          expect(lines(collapsed).every((line) => line.length <= width - 1)).toBe(true)
        }
      }),
  )

  // A cell catches a failed read and goes on, then throws its own error. Only
  // a cell failure that is the op's own text folds into the op's row.
  it.scopedLive(
    "a cell that caught a failed read and threw its own error shows both, at 120 and 60",
    () =>
      Effect.gen(function* () {
        const readError = "Tool 'read' failed: ENOENT: no such file or directory, open 'missing.ts'"
        const cellCall = (id: string, message: string): ToolCall => ({
          id,
          toolName: "cell",
          status: "error",
          input: { code: "try { await tools.read({ path: 'missing.ts' }) } catch {}; throw x" },
          summary: message,
          output: encodeJson({
            _tag: "CellEvaluationError",
            phase: "execute",
            message,
            output: "",
          }),
          operations: [
            {
              id: `${id}-read`,
              toolName: "read",
              status: "error",
              input: { path: "missing.ts" },
              summary: readError,
              output: encodeJson({ error: readError }),
            },
          ],
        })
        const caught = [
          assistantToolMessage(
            "caught",
            cellCall("caught-cell", "Error: independent cell failure"),
          ),
        ]
        for (const width of [120, 60]) {
          const collapsed = yield* draw(caught, "collapsed", width)
          const header = lines(collapsed).find((line) => line.includes("✗ "))
          expect(header).toContain("· 2 failed")
          const rows = groupRows(collapsed)
          expect(rows).toHaveLength(2)
          expect(rows[0]).toStartWith("  ├ Read missing.ts · failed · ENOENT")
          expect(rows[1]).toStartWith("  └ cell · failed · Error: independent")
          const preview = groupRows(yield* draw(caught, "preview", width))
          expect(preview[0]).toStartWith("  ├ Read missing.ts · failed")
          expect(preview.some((row) => row.startsWith("  └ cell · failed"))).toBe(true)
          expect(preview.at(-1)).toStartWith("    │ Error: independent cell failure")
          expect(lines(collapsed).every((line) => line.length <= width - 1)).toBe(true)
        }
        // The read's failure went up uncaught: the cell's failure is its text, one row.
        const uncaught = [assistantToolMessage("uncaught", cellCall("uncaught-cell", readError))]
        const folded = yield* draw(uncaught, "collapsed", 120)
        expect(lines(folded).find((line) => line.includes("✗ "))).toContain("· 1 failed")
        expect(groupRows(folded)).toHaveLength(1)
      }),
  )

  // The owner's rule: a cancelled cell is one `cancelled` row, not a failure.
  // The turn's interrupt and the cell's own cancel both mark it; the op it cut
  // has no receipt (settled with the cell) or lost its output to the snapshot.
  it.scopedLive("a cancelled cell collapses to one cancelled row, at 120 and 60", () =>
    Effect.gen(function* () {
      const cutOp = (id: string, summary: ToolCall["summary"]): ToolCall => ({
        id,
        toolName: "bash",
        status: "error",
        input: { command: "sleep 20; echo cache wired" },
        summary,
        output: absent,
      })
      const cancelledCell = (id: string, output: string, op: ToolCall): ToolCall => ({
        id,
        toolName: "cell",
        status: "error",
        input: { code: "await tools.bash({ command: 'sleep 20; echo cache wired' })" },
        summary: absent,
        output,
        operations: [op],
      })
      const interrupted = encodeJson({
        error: "The tool did not finish: the turn was interrupted.",
        reason: "Interrupted",
      })
      const kernelCancel = encodeJson({
        _tag: "CellKernelError",
        reason: "cancelled",
        message: "Cell cancelled. 1 operation ran with no recorded result.",
      })
      const cases = [
        cancelledCell("turn-cut", interrupted, cutOp("turn-cut-op", absent)),
        cancelledCell("cell-cut", kernelCancel, cutOp("cell-cut-op", "cut by the snapshot")),
      ]
      for (const call of cases) {
        const items: SessionItem[] = [assistantToolMessage(`m-${call.id}`, call)]
        for (const width of [120, 60]) {
          const collapsed = yield* draw(items, "collapsed", width)
          const header = lines(collapsed).find((line) => /^ {2}[●✗○] /.test(line))
          expect(header).toContain("· 1 cancelled")
          expect(header).not.toContain("failed")
          expect(header).not.toContain("✗")
          expect(groupRows(collapsed)).toEqual(["  └ Ran sleep 20; echo cache wired · cancelled"])
          const preview = groupRows(yield* draw(items, "preview", width))
          expect(preview[0]).toBe("  └ Ran sleep 20; echo cache wired · cancelled")
          expect(preview.join("\n")).not.toContain("failed")
        }
      }
    }),
  )

  it.scopedLive("preview heads the failed row with its own output, never the cell's display", () =>
    Effect.gen(function* () {
      const wide = yield* draw(debugTurn(), "preview", 120)
      expect(groupRows(wide)).toEqual([
        "  ├ Ran mkdir -p gent-debug-tools && sleep 1",
        "  ├ Read gent-debug-tools/a.ts, gent-debug-tools/b.ts, gent-debug-tools/c.ts",
        "  ├ Searched /TODO/ in gent-debug-tools",
        "  ├ Edited gent-debug-tools/a.ts +1 / -1",
        "  └ Ran sleep 2; ls gent-debug-tools/d.ts · exit 2",
        `    │ ${DENIED}`,
      ])
      expect(wide).not.toContain("stdout:")
      const narrow = yield* draw(debugTurn(), "preview", 60)
      expect(groupRows(narrow).at(-1)).toStartWith("    │ ls: cannot access")
      expect(lines(narrow).every((line) => line.length <= 59)).toBe(true)
    }),
  )

  it.scopedLive("a command's preview head is five rows, then a count of the rest", () =>
    Effect.gen(function* () {
      for (const width of [120, 60]) {
        const frame = yield* draw([bashMessage("call-bash-head", 25)], "preview", width)
        expect(groupRows(frame)).toEqual([
          "  └ Ran seq 25",
          "    │ row 1",
          "    │ row 2",
          "    │ row 3",
          "    │ row 4",
          "    │ row 5",
          "    │ … +20 lines (ctrl+o)",
        ])
      }
    }),
  )

  // ── reasoning ──

  const thinkingOnly = (id: string, content: string): ListMessage => ({
    ...assistant(id, ""),
    reasoning: content,
    segments: [{ _tag: "reasoning", content }],
  })

  it.scopedLive(
    "a run takes the reasoning before, inside and after it, and its header counts none, at 120 and 60",
    () =>
      Effect.gen(function* () {
        const wide = yield* draw(debugTurn(), "collapsed", 120)
        expect(lines(wide)).toContain(
          "  ● Read 3 files · ran 2 commands · searched 1 pattern · edited 1 file · 1 failed",
        )
        // The run took the thought before its first call and the one before the answer.
        expect(wide).not.toContain("Set up a scratch fixture")
        expect(wide).not.toContain("Summarize.")
        expect(wide).not.toContain("∴")
        expect(wide).toContain("The check for d.ts failed: it does not exist yet.")
        const narrow = yield* draw(debugTurn(), "collapsed", 60)
        // A narrow header drops kinds from the right and keeps the failure.
        const [header = ""] = lines(narrow).filter((line) => line.includes("● Read 3 files"))
        expect(header).toContain("· 1 failed")
        expect(header.length).toBeLessThanOrEqual(59)
      }),
  )

  it.scopedLive("the full level draws a run's thoughts where they came: first, between, last", () =>
    Effect.gen(function* () {
      const full = lines(yield* draw(debugTurn(), "full", 120))
      const at = (text: string) => full.findIndex((line) => line.includes(text))
      expect(at("● Read 3 files")).toBeLessThan(at("Set up a scratch fixture"))
      expect(at("Set up a scratch fixture")).toBeLessThan(at("Read the three files"))
      expect(at("Check for the file")).toBeLessThan(at("Summarize."))
      expect(at("Summarize.")).toBeLessThan(at("The check for d.ts failed"))
      expect(full.filter((line) => line.includes("Summarize."))).toHaveLength(1)
    }),
  )

  it.scopedLive(
    "reasoning with no call hides at collapsed, is one line at preview, and its markdown at full",
    () =>
      Effect.gen(function* () {
        const reasoningText =
          "**Verifying final test output****Refactoring LedgerStore.list****Checking the lint**"
        const items: SessionItem[] = [
          clientPrompt("thought-prompt", "check it"),
          {
            ...assistant("thought-answer", "All green."),
            reasoning: reasoningText,
            segments: [
              { _tag: "reasoning", content: reasoningText },
              { _tag: "text", content: "All green." },
            ],
          },
        ]
        const collapsed = yield* draw(items, "collapsed", 120)
        expect(collapsed).not.toContain("∴")
        expect(collapsed).not.toContain("Verifying")
        expect(collapsed).toContain("All green.")
        const wide = yield* draw(items, "preview", 120)
        expect(lines(wide)).toContain("  ∴ Thought · Verifying final test output · 3 summaries")
        expect(wide).not.toContain("Refactoring")
        const narrow = yield* draw(items, "preview", 30)
        const [line = ""] = lines(narrow).filter((value) => value.includes("∴"))
        expect(line).toBe("  ∴ Thought · Verifying fina…")
        // The full level opens the thought under its glyph.
        const full = lines(yield* draw(items, "full", 120))
        expect(full.join("\n")).toContain("Refactoring LedgerStore.list")
        expect(full.filter((value) => value.includes("∴"))).toEqual([
          "  ∴ Verifying final test output",
        ])
      }),
  )

  it.scopedLive("a run takes no reasoning from an earlier message, nor any a turn end leaves", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        clientPrompt("held-prompt", "debug tools"),
        thinkingOnly("held-before", "EARLIER-THOUGHT"),
        cellStep("held-step", "", [
          op("held-op", "bash", { command: "ls" }, bashOutput("x\n", "", 0)),
        ]),
        thinkingOnly("held-after", "TRAILING-THOUGHT"),
      ]
      // Both stay lone thoughts: the collapsed level hides them, the preview draws each.
      const collapsed = lines(yield* draw(items, "collapsed", 120))
      expect(collapsed).toContain("  ● Ran 1 command")
      expect(collapsed.join("\n")).not.toContain("THOUGHT")
      const frame = lines(yield* draw(items, "preview", 120))
      expect(frame).toContain("  ● Ran 1 command")
      expect(frame).toContain("  ∴ Thought · EARLIER-THOUGHT")
      expect(frame).toContain("  ∴ Thought · TRAILING-THOUGHT")
    }),
  )

  it.scopedLive(
    "native history takes a run with its closing thought once, after the stored answer",
    () =>
      Effect.gen(function* () {
        const prompt = clientPrompt("closing-prompt", "RUN-PROMPT")
        const answer: ListMessage = {
          ...assistant("closing-answer", longBody("ANSWER")),
          reasoning: "CLOSING-THOUGHT",
          segments: [
            { _tag: "reasoning", content: "CLOSING-THOUGHT" },
            { _tag: "text", content: longBody("ANSWER") },
          ],
        }
        const steps = [
          cellStep("closing-1", "LEADING-THOUGHT", [
            op("closing-op-1", "bash", { command: "git status" }, bashOutput("ok\n", "", 0)),
          ]),
          cellStep("closing-2", "MIDDLE-THOUGHT", [
            op("closing-op-2", "bash", { command: "bun test" }, bashOutput("ok\n", "", 0)),
          ]),
        ]
        const [items, setItems] = createSignal<ListMessage[]>([
          assistant("closing-earlier", longBody("EARLIER")),
          prompt,
          ...steps,
          { ...answer, draft: true },
        ])
        const committed: string[] = []
        const setup = yield* renderScoped(
          () => (
            <Transcript
              items={items()}
              streaming={true}
              onRenderer={(renderer) => {
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committed.push(committedTextOf(event))
                })
              }}
            />
          ),
          { width: 60, height: 14 },
        )
        const flushUntil = (done: () => boolean) =>
          Effect.promise(() => setup.flush()).pipe(
            Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }),
            Effect.timeout("3 seconds"),
            Effect.ignore,
          )
        // The streamed answer ended the run, but its reasoning is the run's
        // closing thought: the head waits for the stored answer.
        yield* flushUntil(() => committed.join("").includes("RUN-PROMPT"))
        yield* flushUntil(() => false).pipe(Effect.timeout("300 millis"), Effect.ignore)
        expect(committed.join("")).toContain("RUN-PROMPT")
        expect(committed.join("")).not.toContain("● Ran")
        setItems([assistant("closing-earlier", longBody("EARLIER")), prompt, ...steps, answer])
        yield* flushUntil(() => committed.join("").includes("● Ran 2 commands"))
        const history = committed.join("")
        expect(history.match(/● Ran \d+ commands?/g)).toEqual(["● Ran 2 commands"])
        expect(history).not.toContain("THOUGHT")
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // ── full level ──

  it.scopedLive(
    "an edit op's body reads its hunks, and its frame shows a mark only in the transcript view",
    () =>
      Effect.gen(function* () {
        const items: SessionItem[] = [
          clientPrompt("edit-prompt", "widen it"),
          cellStep("edit-step", "", [
            op(
              "edit-op",
              "edit",
              {
                path: "src/a.ts",
                oldString: "const greeting = 1",
                newString: "const greeting = 2",
              },
              encodeJson({ path: "src/a.ts", replacements: 1 }),
            ),
          ]),
        ]
        for (const width of [120, 60]) {
          for (const expanded of [false, true]) {
            const setup = yield* renderScoped(
              () => <Transcript items={items} disclosure="full" expanded={expanded} />,
              { width, height: 40 },
            )
            const frame = yield* waitForFrame(setup, (next) => next.includes("@@"), "the edit body")
            expect(frame).toContain("-const greeting = 1")
            expect(frame).toContain("+const greeting = 2")
            expect(frame).not.toMatch(/Index:|={10}|\+\+\+ |--- src|No newline/)
            // Inline the mouse is off: no frame promises a click.
            expect(/[▸▾]/.test(frame)).toBe(expanded)
            destroyRenderSetup(setup)
          }
        }
      }),
  )

  // ── session error ──

  it.scopedLive("a long session error keeps four lines below full and counts the rest", () =>
    Effect.gen(function* () {
      const body = Array.from({ length: 10 }, (_, index) => `PROVIDER-LINE-${index + 1}`).join("\n")
      const items: SessionItem[] = [{ _tag: "error", error: body, createdAt: 1, seq: 1 }]
      for (const width of [120, 60]) {
        for (const disclosure of ["collapsed", "preview"] as const) {
          const frame = lines(yield* draw(items, disclosure, width)).filter(
            (line) => line.length > 0,
          )
          expect(frame).toEqual([
            "  ✗ PROVIDER-LINE-1",
            "    PROVIDER-LINE-2",
            "    PROVIDER-LINE-3",
            "    PROVIDER-LINE-4",
            "    … +6 lines (ctrl+o)",
          ])
        }
        const full = yield* draw(items, "full", width)
        expect(full).toContain("PROVIDER-LINE-10")
        expect(full).not.toContain("(ctrl+o)")
      }
      // A short error shows whole at every level.
      const short = yield* draw(
        [{ _tag: "error", error: "one\ntwo", createdAt: 1, seq: 1 }],
        "collapsed",
        60,
      )
      expect(lines(short).filter((line) => line.length > 0)).toEqual(["  ✗ one", "    two"])
    }),
  )

  // ── one-line summaries ──

  /** Two steps' usage and cost, as their `StreamEnded` events carry them. */
  const usedSteps = [
    { outcome: "ToolCalls", costUsd: 0.02, usage: { inputTokens: 20_000, outputTokens: 1_200 } },
    { outcome: "Answered", costUsd: 0.02, usage: { inputTokens: 18_000, outputTokens: 900 } },
  ].reduce(addStep, emptyTurnSteps)
  const turnLine = (retries = 0): SessionItem => ({
    _tag: "turn-ended",
    durationSeconds: 23,
    steps: Array.from({ length: retries }).reduce(addRetry, usedSteps),
    createdAt: 1,
    seq: 1,
  })
  const settledRetry: SessionItem = {
    _tag: "retrying",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1_000,
    outcome: "retried",
    reason: "Rate limit exceeded",
    createdAt: 1,
    seq: 1,
  }
  /** The rows a frame draws, from its first drawn row to its last. */
  const drawnRows = (frame: string) => {
    const all = lines(frame)
    const first = all.findIndex((line) => line.length > 0)
    const last = all.findLastIndex((line) => line.length > 0)
    return all.slice(first, last + 1)
  }
  const SUMMARY_WIDTHS = [
    {
      width: 100,
      header: "Read 3 files · ran 2 commands · searched 1 pattern · edited 1 file · 1 failed",
    },
    { width: 60, header: "Read 3 files · ran 2 commands · 1 failed" },
    { width: 40, header: "Read 3 files · 1 failed" },
  ] as const

  for (const { width, header } of SUMMARY_WIDTHS) {
    it.scopedLive(
      `a finished tool turn is its prompt, one header, its failure, its answer and the turn line at ${width} columns`,
      () =>
        Effect.gen(function* () {
          const rows = drawnRows(yield* draw([...debugTurn(), turnLine()], "collapsed", width))
          const text = rows.filter((line) => line.length > 0)
          const answer = text.filter((line) => /^ {2}[A-Za-z]/.test(line))
          expect(text[0]).toBe("┃ debug tools")
          expect(text[1]).toBe(`  ● ${header}`)
          expect(text[2]).toStartWith("  └ Ran sleep 2; ls ")
          expect(answer.join(" ")).toContain("The check for d.ts failed")
          expect(text.at(-1)).toStartWith("  ✻ Worked for 23s")
          // Nothing else: no thought, no step count, no second header.
          expect(text).toHaveLength(4 + answer.length)
          expect(rows.slice(1).join("\n")).not.toMatch(/∴|thought|\d+ tools?\b|\d+ steps?\b|Retr/)
          expect(rows.every((line) => line.length <= width)).toBe(true)
          // gent's own rows keep the terminal's last column free.
          expect(text[1]?.length ?? width).toBeLessThan(width)
          expect(text.at(-1)?.length ?? width).toBeLessThan(width)
          // The turn line is gent's: column 2, its own glyph, one blank row above.
          expect(rows.at(-2)).toBe("")
        }),
    )
  }

  it.scopedLive("the turn line names the retries, and the retry rows wait for the preview", () =>
    Effect.gen(function* () {
      // The prompt and the first step, a settled retry, then the step with the reads.
      const turn = debugTurn()
      const items: SessionItem[] = [
        ...turn.slice(0, 2),
        settledRetry,
        ...turn.slice(2, 3),
        assistant("retry-answer", "Read them."),
        turnLine(2),
      ]
      const collapsed = drawnRows(yield* draw(items, "collapsed", 100))
      // A settled retry passes the run: one header holds both steps.
      expect(collapsed.filter((line) => line.startsWith("  ● "))).toEqual([
        "  ● Read 3 files · ran 1 command",
      ])
      expect(collapsed.join("\n")).not.toContain("Retried")
      expect(collapsed.at(-1)).toBe("  ✻ Worked for 23s · 2 retries · ↑38k ↓2.1k · $0.04")
      const preview = drawnRows(yield* draw(items, "preview", 100))
      expect(preview.filter((line) => line.startsWith("  ● "))).toHaveLength(1)
      expect(preview).toContain("  ↻ Retried 1/3 · Rate limit exceeded")
      expect(preview.at(-1)).toBe("  ✻ Worked for 23s · 2 retries · ↑38k ↓2.1k · $0.04 · 2 steps")
      const narrow = drawnRows(yield* draw(items, "collapsed", 40))
      expect(narrow.at(-1)).toBe("  ✻ Worked for 23s · 2 retries")
    }),
  )

  it.scopedLive("a pending retry draws no transcript row: the live line carries it", () =>
    Effect.gen(function* () {
      const pending: SessionItem = {
        ...settledRetry,
        outcome: "pending",
        createdAt: currentMillis(),
      }
      for (const disclosure of ["collapsed", "preview", "full"] as const) {
        const frame = yield* draw([clientPrompt("wait", "WAITING"), pending], disclosure, 100)
        expect(frame).toContain("WAITING")
        expect(frame).not.toContain("Retr")
      }
    }),
  )

  it.scopedLive(
    "a lone thought hides at collapsed, is one line at preview, and every thought opens with ∴ at full",
    () =>
      Effect.gen(function* () {
        const lone: SessionItem[] = [
          clientPrompt("lone-prompt", "check it"),
          thinkingOnly("lone-thought", "**Weighing the cache**\n\nLRU fits the access pattern."),
          assistant("lone-answer", "Done."),
        ]
        // Collapsed: no row and no gap for the thought.
        expect(drawnRows(yield* draw(lone, "collapsed", 100))).toEqual([
          "┃ check it",
          "",
          "  Done.",
        ])
        const preview = drawnRows(yield* draw(lone, "preview", 100))
        expect(preview.some((line) => line.startsWith("  ∴ Thought · Weighing the cache"))).toBe(
          true,
        )
        // Tall enough for the whole turn at full: a frame that overflows packs its rows.
        const drawTall = (items: SessionItem[], width: number) =>
          renderScoped(
            () => <MessageList items={items} disclosure="full" syntaxStyle={syntaxStyle} />,
            { width, height: 200 },
          ).pipe(Effect.map(renderFrame))
        for (const width of [100, 60]) {
          const full = lines(yield* drawTall([...lone, ...debugTurn()], width))
          for (const thought of [
            "Weighing the cache",
            "Set up a scratch fixture",
            "Read the three files",
            "Summarize.",
          ]) {
            const row = full.find((line) => line.includes(thought)) ?? ""
            expect(row).toMatch(/^ {2}∴ /)
          }
        }
        // A thought that wraps hangs its next line under its text, at column 4.
        const long = "a thought long enough to wrap past the width of a narrow terminal"
        const narrow = lines(yield* draw([thinkingOnly("wrap", long)], "full", 40))
        const head = narrow.findIndex((line) => line.startsWith("  ∴ a thought"))
        expect(head).toBeGreaterThanOrEqual(0)
        expect(narrow[head + 1]).toMatch(/^ {4}\S/)
      }),
  )

  for (const width of [100, 60, 40]) {
    it.scopedLive(
      `turn, error, interruption and notice rows start at column 2 with their own glyph at ${width} columns`,
      () =>
        Effect.gen(function* () {
          const items: SessionItem[] = [
            { _tag: "error", error: "provider failed", createdAt: 1, seq: 1 },
            { _tag: "interruption", createdAt: 2, seq: 2 },
            turnLine(),
            {
              _tag: "notice",
              key: "miss",
              glyph: "◌",
              color: "textMuted",
              text: "cache miss",
              createdAt: 4,
              seq: 4,
            },
          ]
          for (const disclosure of ["collapsed", "preview"] as const) {
            const rows = drawnRows(yield* draw(items, disclosure, width))
            const firstRows = rows.filter((line) => /^ {2}\S/.test(line))
            expect(firstRows.map((line) => line.slice(0, 4))).toEqual([
              "  ✗ ",
              "  ■ ",
              "  ✻ ",
              "  ◌ ",
            ])
            expect(rows.join("\n")).toContain("Interrupted · what should gent do")
            // Column 0 is the reader's alone.
            expect(rows.filter((line) => /^\S/.test(line))).toEqual([])
            // A row that wraps hangs at column 4.
            expect(rows.filter((line) => /^ {3}\S|^ {5,}\S/.test(line))).toEqual([])
            expect(rows.every((line) => line.length <= width - 1)).toBe(true)
          }
        }),
    )
  }

  it.scopedLive("a running run blinks its bullet, never the child agent's diamond", () =>
    Effect.gen(function* () {
      const running = assistantToolMessage("blink", {
        id: "blink-cell",
        toolName: "cell",
        status: "running",
        input: { code: "await tools.bash({ command: 'sleep 9' })" },
        summary: absent,
        output: absent,
        operations: [{ ...op("blink-op", "bash", { command: "sleep 9" }, ""), status: "running" }],
      })
      const frame = yield* draw([running], "collapsed", 100)
      const header = lines(frame).find((line) => line.includes("Running 1 command")) ?? ""
      expect(header).toMatch(/^ {2}[○●] Running 1 command$/)
      expect(frame).not.toMatch(/[◇◈◆]/)
    }),
  )
})
