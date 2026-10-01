/** @jsxImportSource @opentui/solid */
import { Deferred, Effect, Fiber, Option, Schedule, Schema } from "effect"
import {
  type CliRenderer,
  type CliRendererExternalOutputEvent,
  SyntaxStyle,
  TextAttributes,
} from "@opentui/core"
import { describe, expect, it, test } from "effect-bun-test"
import {
  addStep,
  currentMillis,
  emptyTurnSteps,
  flushTranscriptForExit,
  holdUntilRendererDestroyed,
  getSessionEventLabel,
  type Message as ListMessage,
  MessageList,
  NativeTranscript,
  promptOnScreen,
  readerPrompt,
  reasoningMarkdown,
  type RetryOutcome,
  type SessionEvent,
  type SessionItem,
  SPLIT_FOOTER_RESERVED_OUTPUT_ROWS,
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
  MODEL_CHANGE_MESSAGE_TYPE,
  OutputCut,
  SessionId,
  ToolCallId,
  AgentEvent,
  EventEnvelope,
  type Message as DomainMessage,
} from "@gent/core/protocol"
import {
  toolCallReceipts,
  type MessagePart,
  projectMessagesWithToolInteractions,
  EventId,
} from "@gent/core/test-utils"
import {
  BTW_QUESTION_TYPE,
  CHILD_COMPLETION_TYPE,
  forkQuestionText,
  type SessionMessageDetails,
  sessionMessageText,
} from "@gent/extensions/client"
import { batch, createSignal, onCleanup, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { DisclosureLevel } from "../src/session"
import { ToolCallIdentityProvider, ToolFrame } from "../src/ui"
import {
  BUILTIN_TOOL_RENDERERS,
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
  terminalText,
} from "./render-harness-boundary"
import {
  highlightOutage,
  makeSettleHold,
  makeSettleTimeouts,
  refuseCommits,
} from "./scrollback-hold-boundary"
import { waitForFrame, waitForTerminal } from "./helpers-boundary"
import { useExtensionUI } from "../src/extensions/host"
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
 * A tall live view is the case that used to break it. `liveHeight` grows with
 * the streaming reply, so the requested height passes the screen height long
 * before the reader notices.
 */

describe("split footer height", () => {
  it.effect("a live view taller than the screen still leaves rows to scroll", () =>
    Effect.sync(() => {
      const terminalHeight = 40
      // The composer plus a live view that has outgrown the screen twice over.
      const height = splitFooterHeight(terminalHeight, 3 + 120)
      expect(height).toBeLessThan(terminalHeight)
      expect(terminalHeight - height).toBeGreaterThanOrEqual(2)
    }),
  )

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

  it.effect("the reserved region is at least the two rows a terminal will scroll", () =>
    Effect.sync(() => {
      expect(SPLIT_FOOTER_RESERVED_OUTPUT_ROWS).toBeGreaterThanOrEqual(2)
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
 * The pane showed the result as one unreadable line with the asterisks printed
 * literally, because reasoning rendered as plain text rather than through the
 * markdown element the reply already uses:
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

    expect(getSessionEventLabel(event, createdAt)).toBe("Retrying in 2s... 1/3 · overloaded (529)")
    expect(getSessionEventLabel(event, createdAt + 1_100)).toBe(
      "Retrying in 1s... 1/3 · overloaded (529)",
    )
    expect(getSessionEventLabel(event, createdAt + 2_000)).toBe(
      "Retrying now... 1/3 · overloaded (529)",
    )
    expect(getSessionEventLabel({ ...event, outcome: "retried" }, createdAt + 20_000)).toBe(
      "Retried 1/3 · overloaded (529)",
    )
    expect(getSessionEventLabel({ ...event, reason: "" }, createdAt)).toBe("Retrying in 2s... 1/3")
  })

  test("an interruption row joins its parts with the separator every row uses", () => {
    const event: SessionEvent = { _tag: "interruption", createdAt: 1, seq: 1 }
    expect(getSessionEventLabel(event)).toBe("Interrupted · what do you want to do instead?")
  })

  // A pending retry's row is the one row that follows the clock.
  it.scopedLive("a pending retry row counts down to now", () =>
    Effect.gen(function* () {
      const event: SessionEvent = {
        _tag: "retrying",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        outcome: "pending",
        reason: "",
        createdAt: currentMillis(),
        seq: 1,
      }
      const setup = yield* renderScoped(
        () => <MessageList items={[event]} disclosure="collapsed" syntaxStyle={syntaxStyle} />,
        { width: 80, height: 10 },
      )
      yield* waitForFrame(setup, (frame) => frame.includes("Retrying in 1s... 1/3"), "countdown")
      yield* waitForFrame(setup, (frame) => frame.includes("Retrying now... 1/3"), "now", 3000)
    }).pipe(Effect.timeout("8 seconds")),
  )

  // A row too long for the width wraps under its text: the glyph keeps its column.
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
        () => <MessageList items={[event]} disclosure="collapsed" syntaxStyle={syntaxStyle} />,
        { width: 40, height: 10 },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("Retried 1/3"), "the row")
      const lines = frame.split("\n")
      const first = lines.findIndex((line) => line.includes("● Retried"))
      const textColumn = (lines[first] ?? "").indexOf("Retried")
      const next = lines[first + 1] ?? ""
      expect(next.trim().length).toBeGreaterThan(0)
      expect(next.search(/\S/)).toBe(textColumn)
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

describe("worked-for row", () => {
  test("a turn's steps, tool calls, and cost follow the duration", () => {
    const steps = [
      { outcome: "ToolCalls", costUsd: 0.004 },
      { outcome: "ToolCalls", costUsd: 0.005 },
      { outcome: "Answered", costUsd: 0.003 },
    ].reduce(addStep, emptyTurnSteps)
    const event: SessionEvent = {
      _tag: "turn-ended",
      durationSeconds: 452,
      steps,
      createdAt: 0,
      seq: 1,
    }
    expect(getSessionEventLabel(event)).toBe("Worked for 7m 32s · 3 steps · 2 tool calls · $0.01")
  })

  test("a turn with no recorded steps keeps the plain duration", () => {
    const event: SessionEvent = {
      _tag: "turn-ended",
      durationSeconds: 5,
      steps: emptyTurnSteps,
      createdAt: 0,
      seq: 1,
    }
    expect(getSessionEventLabel(event)).toBe("Worked for 5s")
  })

  test("a single answered step without pricing reads as one step", () => {
    const event: SessionEvent = {
      _tag: "turn-ended",
      durationSeconds: 5,
      steps: addStep(emptyTurnSteps, { outcome: "Answered" }),
      createdAt: 0,
      seq: 1,
    }
    expect(getSessionEventLabel(event)).toBe("Worked for 5s · 1 step")
  })
})

// ── tool interaction projection ─────────────────────────────────────────────

// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined
let messageIndex = 0

// Core's projection owns running calls, pairing, the first-line summary and
// the 100-character cut (packages/core/tests/domain/message.test.ts). These
// cases core does not cover yet stay here until core takes them.
describe("projectMessagesWithToolInteractions", () => {
  const makeMsg = (role: "user" | "assistant" | "tool", parts: MessagePart[]): DomainMessage =>
    Message.cases.regular.make({
      id: MessageId.make(`message-sdk-utilities-${messageIndex++}`),
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      role,
      parts,
      createdAt: dateFromMillis(0),
      turnDurationMs: absent,
    })

  type ToolResultValue = string | { readonly files: ReadonlyArray<string> }
  const toolResult = (id: string, value: ToolResultValue, isError = false): MessagePart =>
    Prompt.toolResultPart({
      id: ToolCallId.make(id),
      name: "test-tool",
      isFailure: isError,
      providerExecuted: false,
      result: value,
    })

  test("returns empty interactions when no tool calls", () => {
    const projected = projectMessagesWithToolInteractions([
      makeMsg("assistant", [Prompt.textPart({ text: "Just text" })]),
    ])[0]
    expect(projected?.toolInteractions).toEqual([])
  })

  test("handles error results", () => {
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", "File not found", true)]),
    ]

    const projected = projectMessagesWithToolInteractions(messages)[0]
    expect(projected?.toolInteractions[0]).toEqual({
      id: ToolCallId.make("tc1"),
      toolName: "read",
      status: "error",
      input: {},
      summary: "File not found",
      output: "File not found",
      durationMs: absent,
    })
  })

  test("handles object output", () => {
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", { files: ["a.ts", "b.ts"] })]),
    ]

    const result = projectMessagesWithToolInteractions(messages)[0]!.toolInteractions[0]!
    expect(result.summary).toBe('{"files":["a.ts","b.ts"]}')
    expect(result.output).toContain('"files"')
  })

  test("ignores tool results without matching message-local calls", () => {
    const messages: DomainMessage[] = [
      makeMsg("user", [Prompt.textPart({ text: "Hello" })]),
      makeMsg("assistant", [Prompt.textPart({ text: "Hi there" })]),
      makeMsg("tool", [toolResult("tc1", "orphan")]),
    ]

    const projected = projectMessagesWithToolInteractions(messages)
    expect(projected.flatMap((message) => message.toolInteractions)).toEqual([])
  })
})

// ── message list render ─────────────────────────────────────────────────────

const syntaxStyle = () => SyntaxStyle.create()

const userMessage = (
  tag: "regular-message" | "interjection-message",
  id: string,
  content: string,
  pendingMode: "queued" | "steer",
  images: ReadonlyArray<{ mediaType: string }> = [],
): ListMessage => {
  if (tag === "interjection-message") {
    return {
      _tag: tag,
      id,
      role: "user",
      pendingMode,
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
    pendingMode,
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

const unknownFailureMessage = (id: string): ListMessage =>
  assistantToolMessage("assistant-unknown-tool", {
    id,
    toolName: "unknown_fx_tool",
    status: "error",
    input: absent,
    summary: "tool failed",
    output: absent,
  })

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
  assistantToolMessage("assistant-cell", {
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

  it.scopedLive("renders user rails, images, and pending labels at normal width", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        userMessage("regular-message", "queued-user", "first line\nsecond line", "queued", [
          { mediaType: "image/png" },
        ]),
        userMessage("interjection-message", "steer-user", "switch now", "steer"),
      ]
      const setup = yield* renderScoped(() => (
        <MessageList items={items} disclosure="collapsed" syntaxStyle={syntaxStyle} />
      ))
      const frame = renderFrame(setup)
      expect(frame).toContain("┃")
      expect(frame).toContain("[Image: png]")
      expect(frame).toContain("[queued]")
      expect(frame).toContain("[steer]")
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
            "queued",
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
              const text = new TextDecoder().decode(snapshot.getRealCharBytes(false))
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
            return (
              <NativeTranscript
                items={items}
                settled
                streaming={false}
                footerHeight={3}
                paneOpen={false}
                expanded={false}
                disclosure={disclosure()}
                displayRevision={0}
                overlayOpen={false}
                renderItems={(visible) => (
                  <MessageList
                    items={visible}
                    disclosure={disclosure()}
                    syntaxStyle={syntaxStyle}
                  />
                )}
              >
                <box />
              </NativeTranscript>
            )
          },
          { width, height: 14 },
        )
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({ until: () => extensionsLoaded() }),
          Effect.timeout("5 seconds"),
        )
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

  it.scopedLive("a message from another session names its sender above the text", () =>
    Effect.gen(function* () {
      const sent: ListMessage = {
        ...userMessage(
          "interjection-message",
          "sent-1",
          'Message from your parent "auth\n\nrefactor" (session 0199aabbccdd):\n\nUse the v2 token route.\n\nThen rerun the suite.',
          "steer",
        ),
        pendingMode: absent,
        metadata: {
          customType: "session-message",
          details: {
            from: { sessionId: "0199aabbccdd", name: "auth\n\nrefactor", relation: "parent" },
          },
        },
      }
      const frame = yield* renderLoaded([sent])
      // A blank line in the name or the body leaves the header strip whole.
      expect(frame).toContain('» from your parent "auth refactor" · aabbccdd')
      expect(frame).toContain("Use the v2 token route.")
      expect(frame).toContain("Then rerun the suite.")
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
            "queued",
          ),
          pendingMode: absent,
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
          "steer",
        ),
        pendingMode: absent,
        metadata: {
          customType: "session-message",
          details: { from },
        },
      }
      const frame = yield* renderLoaded([sent])
      expect(frame).toContain('» from your child "delegate: Use session.send with…" · ca0cb3e7')
      expect(frame).toContain("hello from the child")
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
          "steer",
        ),
        pendingMode: absent,
        metadata: {
          customType: "session-message",
          details: { from },
        },
      }
      const frame = yield* renderLoaded([sent])
      expect(frame).toContain("old question")
      expect(frame).not.toContain("Message from your child")
      // Wide characters count two columns: 15 of them fit before the ellipsis, and the id stays on the line.
      expect(frame).toContain(`"${Array.from(from.name).slice(0, 15).join("")}…" · ca0cb3e7`)
    }),
  )

  it.scopedLive("keeps multiline user text visible in a narrow transcript", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        userMessage(
          "regular-message",
          "narrow-user",
          "a long first line that wraps in a narrow terminal\nsecond line stays selectable",
          "queued",
        ),
      ]
      const setup = yield* renderScoped(
        () => <MessageList items={items} disclosure="collapsed" syntaxStyle={syntaxStyle} />,
        { width: 32, height: 16 },
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("┃")
      expect(frame).toContain("a long first")
      expect(frame).toContain("second line")
      expect(frame).toContain("selectable")
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
        <MessageList items={items} disclosure="collapsed" syntaxStyle={syntaxStyle} />
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
          ...userMessage("regular-message", "goal-held", "RAW-GOAL-TEXT keep going.", "queued"),
          pendingMode: absent,
          metadata: { customType: "goal-context" },
        }
        const items: SessionItem[] = [
          goalMessage,
          ...Array.from({ length: 6 }, (_, index) =>
            userMessage(
              "regular-message",
              `filler-${index}`,
              `filler ${index}\nsecond line\nthird line`,
              "queued",
            ),
          ),
        ]
        const setup = yield* renderScoped(
          () => {
            const renderer = useRenderer()
            const capture = (event: CliRendererExternalOutputEvent) => {
              savedText.push(new TextDecoder().decode(event.snapshot.getRealCharBytes(false)))
            }
            renderer.on("external_output", capture)
            onCleanup(() => renderer.off("external_output", capture))
            return (
              <NativeTranscript
                items={items}
                settled
                streaming={false}
                footerHeight={3}
                paneOpen={false}
                expanded={false}
                disclosure="collapsed"
                displayRevision={0}
                overlayOpen={false}
                renderItems={(visible) => (
                  <MessageList items={visible} disclosure="collapsed" syntaxStyle={syntaxStyle} />
                )}
              >
                <box />
              </NativeTranscript>
            )
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
          "queued",
        ),
      )
      const setup = yield* renderScoped(
        () => {
          const renderer = useRenderer()
          extensionsLoaded = useExtensionUI().loaded
          const capture = (event: CliRendererExternalOutputEvent) => {
            savedText.push(new TextDecoder().decode(event.snapshot.getRealCharBytes(false)))
          }
          renderer.on("external_output", capture)
          onCleanup(() => renderer.off("external_output", capture))
          return (
            <NativeTranscript
              items={items}
              settled={settled()}
              streaming={false}
              footerHeight={3}
              paneOpen={false}
              expanded={false}
              disclosure="collapsed"
              displayRevision={0}
              overlayOpen={false}
              renderItems={(visible) => (
                <MessageList items={visible} disclosure="collapsed" syntaxStyle={syntaxStyle} />
              )}
            >
              <box />
            </NativeTranscript>
          )
        },
        { width: 60, height: 14 },
      )
      yield* Effect.promise(() => setup.flush()).pipe(
        Effect.repeat({ until: () => extensionsLoaded() }),
        Effect.timeout("5 seconds"),
      )
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
        ...userMessage(
          "regular-message",
          "goal-1",
          "Continue working toward the active goal.",
          "queued",
        ),
        pendingMode: absent,
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
          "queued",
        ),
        pendingMode: absent,
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

  it.scopedLive("a click toggles a tool frame, and a new expanded from its owner starts over", () =>
    Effect.gen(function* () {
      const [expanded, setExpanded] = createSignal(false)
      const setup = yield* renderScoped(() => (
        <ToolFrame
          title="read"
          status="completed"
          expanded={expanded()}
          collapsedContent={<text>FRAME-CLOSED</text>}
        >
          <text>FRAME-OPEN</text>
        </ToolFrame>
      ))
      const closed = yield* waitForFrame(setup, (next) => next.includes("FRAME-CLOSED"), "closed")
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

  it.scopedLive("keeps unknown tool failure identity in both MessageList projections", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [unknownFailureMessage("call-unknown-7")]
      const setup = yield* renderScoped(() => (
        <>
          <MessageList items={items} disclosure="collapsed" syntaxStyle={syntaxStyle} />
          <MessageList items={items} disclosure="preview" syntaxStyle={syntaxStyle} />
        </>
      ))
      const frame = renderFrame(setup)
      expect(frame.match(/#call-unknown-7/g)?.length).toBe(2)
      expect(frame.match(/\[x unknown_fx_tool\]/g)?.length).toBe(2)
      expect(frame.match(/tool failed/g)?.length).toBe(2)
    }),
  )

  it.scopedLive("propagates identity through a registered renderer at narrow width", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => <RegisteredToolMessageLists items={[registeredFailureMessage("call-reg-7")]} />,
        { width: 42, height: 20 },
      )
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("#call-reg-7") && next.includes("failed"),
        "registered renderer failure",
      )
      expect(frame.match(/#call-reg-7/g)?.length).toBe(2)
      expect(frame.match(/failed/g)?.length).toBeGreaterThanOrEqual(2)
      expect(frame.match(/✕ failed/g)?.length).toBe(2)
      expect(frame).not.toContain("[x read]")
      expect(frame.match(/read/g)?.length).toBeGreaterThanOrEqual(2)
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
      const sessionId = SessionId.make("session-reloaded-ops")
      const branchId = BranchId.make("branch-reloaded-ops")
      const cell = ToolCallId.make("call-cell-reload")
      const editInput = {
        path: "/workspace/src/module.ts",
        oldString: `export const value = "${"a".repeat(120)}"`,
        newString: `export const value = "${"b".repeat(120)}"\nexport const other = 1`,
      }
      const envelope = (id: number, event: AgentEvent) =>
        EventEnvelope.make({ id: EventId.make(id), createdAt: id, event })
      const op = (
        id: number,
        toolCallId: string,
        toolName: string,
        input: Readonly<Record<string, string>>,
        output: string,
      ) => [
        envelope(
          id,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: ToolCallId.make(toolCallId),
            toolName,
            input,
            parentToolCallId: cell,
          }),
        ),
        envelope(
          id + 1,
          AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId: ToolCallId.make(toolCallId),
            toolName,
            summary: "done",
            output,
            parentToolCallId: cell,
          }),
        ),
      ]
      // The snapshot a reload reads: the cell's ops projected from its stored events.
      const [projected] = projectMessagesWithToolInteractions(
        [
          Message.cases.regular.make({
            id: MessageId.make("assistant-reloaded-cell"),
            sessionId,
            branchId,
            role: "assistant",
            parts: [
              Prompt.toolCallPart({
                id: cell,
                name: "cell",
                params: { code: "await tools.bash({command: 'bun test'})" },
                providerExecuted: false,
              }),
            ],
            createdAt: dateFromMillis(0),
          }),
        ],
        toolCallReceipts([
          ...op(
            1,
            "op-bash",
            "bash",
            { command: "bun test" },
            encodeJson({ stdout: "1 fail", stderr: "", exitCode: 1 }),
          ),
          ...op(
            3,
            "op-edit",
            "edit",
            editInput,
            encodeJson({ path: editInput.path, replacements: 1 }),
          ),
        ]),
      )
      const interaction = Option.fromNullishOr(projected?.toolInteractions[0])
      if (Option.isNone(interaction)) return yield* Effect.die("no projected cell")
      const { operations, ...call } = interaction.value
      const reloaded: ToolCall = {
        ...call,
        status: "completed",
        operations: (operations ?? []).map((operation) => ({ ...operation })),
      }
      // The same cell as the live feed carried it: each op with its whole
      // input and output, before any reload projected it.
      const live: ToolCall = {
        ...reloaded,
        operations: [
          {
            id: "op-bash",
            toolName: "bash",
            status: "completed",
            input: { command: "bun test" },
            summary: "done",
            output: encodeJson({ stdout: "1 fail", stderr: "", exitCode: 1 }),
          },
          {
            id: "op-edit",
            toolName: "edit",
            status: "completed",
            input: editInput,
            summary: "done",
            output: encodeJson({ path: editInput.path, replacements: 1 }),
          },
        ],
      }
      const drawn = (call: ToolCall, label: string) =>
        Effect.gen(function* () {
          const setup = yield* renderScoped(
            () => (
              <RegisteredToolMessageLists
                items={[assistantToolMessage("assistant-reloaded-cell", call)]}
                fullDetail
              />
            ),
            { width: 110, height: 60 },
          )
          const frame = yield* waitForFrame(
            setup,
            (next) => next.includes("module.ts") && next.includes("other = 1"),
            label,
          )
          destroyRenderSetup(setup)
          return frame
        })
      const liveFrame = yield* drawn(live, "live cell ops")
      const frame = yield* drawn(reloaded, "reloaded cell ops")
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
      const sessionId = SessionId.make("session-cut-ops")
      const branchId = BranchId.make("branch-cut-ops")
      const cell = ToolCallId.make("call-cell-cut")
      const envelope = (id: number, event: AgentEvent) =>
        EventEnvelope.make({ id: EventId.make(id), createdAt: id, event })
      const op = (
        id: number,
        toolCallId: string,
        toolName: string,
        input: Readonly<Record<string, string>>,
        output: string,
      ) => [
        envelope(
          id,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: ToolCallId.make(toolCallId),
            toolName,
            input,
            parentToolCallId: cell,
          }),
        ),
        envelope(
          id + 1,
          AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId: ToolCallId.make(toolCallId),
            toolName,
            summary: "done",
            output,
            parentToolCallId: cell,
          }),
        ),
      ]
      const numbered = Array.from({ length: 3_000 }, (_, index) => `line ${index + 1}`)
      const [projected] = projectMessagesWithToolInteractions(
        [
          Message.cases.regular.make({
            id: MessageId.make("assistant-cut-cell"),
            sessionId,
            branchId,
            role: "assistant",
            parts: [
              Prompt.toolCallPart({
                id: cell,
                name: "cell",
                params: { code: "await tools.bash({command: 'seq'})" },
                providerExecuted: false,
              }),
            ],
            createdAt: dateFromMillis(0),
          }),
        ],
        toolCallReceipts([
          ...op(
            1,
            "op-bash-long",
            "bash",
            { command: "seq 3000" },
            encodeJson({ stdout: numbered.join("\n"), stderr: "", exitCode: 0 }),
          ),
          ...op(
            3,
            "op-read-long",
            "read",
            { path: "/workspace/long.txt" },
            encodeJson({
              path: "/workspace/long.txt",
              content: numbered.map((text, index) => `${index + 1}\t${text}`).join("\n"),
              lineCount: 3_000,
            }),
          ),
        ]),
      )
      const interaction = Option.fromNullishOr(projected?.toolInteractions[0])
      if (Option.isNone(interaction)) return yield* Effect.die("no projected cell")
      const { operations, ...call } = interaction.value
      const reloaded: ToolCall = {
        ...call,
        status: "completed",
        operations: (operations ?? []).map((operation) => ({ ...operation })),
      }
      const setup = yield* renderScoped(
        () => (
          <RegisteredToolMessageLists
            items={[assistantToolMessage("assistant-cut-cell", reloaded)]}
            fullDetail
          />
        ),
        { width: 110, height: 60 },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("long.txt"), "cut cell ops")
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
      // The compact tree says what the cell did: ops counted in the header, named in the row.
      expect(frame).toContain("1 cell · 2 ops · 1 failed")
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
      expect(frame).toContain("└ bash seq 25 · ↓ 25 lines")
      expect(frame).toContain("row 1")
      expect(frame).toContain("row 20")
      expect(frame).not.toContain("row 21")
      expect(frame).toContain("… +5 lines (ctrl+o)")
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
          (frame) => frame.includes("… +5 lines (ctrl+o)"),
          "cell preview",
        )
        const row = Option.getOrThrow(
          Option.fromUndefinedOr(preview.split("\n").find((line) => line.includes("└ cell"))),
        ).trim()
        expect(row).toContain("↑ 2 ↓ 25 lines")
        // The preview row names no call id; the open rows add it at the end of the same words.
        expect(row).not.toContain("#call-stable")
        const isOpenRow = (line: string) =>
          line.trim().startsWith(row) && line.trim().endsWith("#call-stable")
        yield* Effect.sync(() => setDisclosure("full"))
        const full = yield* waitForFrame(
          setup,
          (frame) => frame.includes("CELL-OUTPUT-025") && frame.includes("note.content"),
          "full cell output",
        )
        expect(full.split("\n").some(isOpenRow)).toBe(true)
        expect(full.match(/#call-stable/g)).toHaveLength(1)
        expect(full).not.toContain("… +5 lines")
        yield* Effect.sync(() => {
          setDisclosure("preview")
          setFullDetail(true)
        })
        const transcript = yield* waitForFrame(
          setup,
          (frame) => frame.includes("CELL-OUTPUT-025") && !frame.includes("1 cell ·"),
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

  it.scopedLive("collapsed keeps the group header and hides finished rows and output", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [bashMessage("call-bash-8", 25)]
      const setup = yield* renderScoped(
        () => <MessageList items={items} disclosure="collapsed" syntaxStyle={syntaxStyle} />,
        { width: 80, height: 20 },
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("1 tool call · 1 bash")
      expect(frame).not.toContain("└ bash")
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
      const setup = yield* renderScoped(
        () => <MessageList items={items} disclosure="preview" syntaxStyle={syntaxStyle} />,
        { width: 80, height: 40 },
      )
      const rows = renderFrame(setup)
        .split("\n")
        .filter((line) => line.includes("└ bash"))
        .map((line) => line.trim().split(/\s{2,}/)[0])
      expect(rows).toEqual([
        "└ bash echo hello · ↓ 1 line",
        "└ bash echo hello · ↓ 2 lines",
        "└ bash echo hello",
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
            disclosure="preview"
            syntaxStyle={syntaxStyle}
          />
        ),
        { width: 80, height: 20 },
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
  const views: ReadonlyArray<{ disclosure: DisclosureLevel; fullDetail: boolean }> = [
    { disclosure: "collapsed", fullDetail: false },
    { disclosure: "preview", fullDetail: false },
    { disclosure: "full", fullDetail: false },
    { disclosure: "collapsed", fullDetail: true },
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
          expect(blankRuns).toEqual(Array.from({ length: items.length - 1 }, () => 1))
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
          const setup = yield* renderScoped(
            () => (
              <ToolRenderersProvider value={builtinRenderers}>
                <CellToolRenderer expanded={expanded} toolCall={twoOpCell} />
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

  it.scopedLive(
    "native history keeps one blank line between committed blocks in full disclosure",
    () =>
      Effect.gen(function* () {
        const savedText: string[] = []
        const [disclosure, setDisclosure] = createSignal<DisclosureLevel>("collapsed")
        let extensionsLoaded = () => false
        const history: SessionItem[] = [
          userMessage("regular-message", "cells-prompt", "run three steps", "queued"),
          ...items,
        ]
        const setup = yield* renderScoped(
          () => {
            const renderer = useRenderer()
            extensionsLoaded = useExtensionUI().loaded
            const capture = (event: CliRendererExternalOutputEvent) => {
              savedText.push(new TextDecoder().decode(event.snapshot.getRealCharBytes(true)))
            }
            renderer.on("external_output", capture)
            onCleanup(() => renderer.off("external_output", capture))
            // The footer under the transcript is as tall as the transcript is told.
            return (
              <box flexDirection="column" flexGrow={1}>
                <NativeTranscript
                  items={history}
                  settled
                  streaming={false}
                  footerHeight={3}
                  paneOpen={false}
                  expanded={false}
                  disclosure={disclosure()}
                  displayRevision={0}
                  overlayOpen={false}
                  renderItems={(visible) => (
                    <MessageList
                      items={visible}
                      disclosure={disclosure()}
                      syntaxStyle={syntaxStyle}
                    />
                  )}
                >
                  <box />
                </NativeTranscript>
                <box height={3} flexShrink={0} />
              </box>
            )
          },
          { width: 100, height: 20 },
        )
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({ until: () => extensionsLoaded() }),
          Effect.timeout("3 seconds"),
        )
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
  // The preview level draws the last call as the full level does, cut short:
  // one call has one owner for what shows beneath it, never its raw result.
  it.scopedLive("the preview draws a write through its renderer, not its JSON", () =>
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
            </Show>
          )
        },
        { width: 100, height: 20, cwd },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("written"), "the preview")
      expect(frame).toContain("7.2 KB written")
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
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[assistantToolMessage("assistant-cell-read", cell)]}
            disclosure="full"
            syntaxStyle={syntaxStyle}
          />
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

describe("native transcript markdown", () => {
  // The answer is indented, so a diagram fits the columns after the indent:
  // one fitted to the whole terminal wraps its right edge onto the next row.
  it.scopedLive("a diagram fits the answer's width, not the terminal's", () =>
    Effect.gen(function* () {
      const diagram = "```mermaid\ngraph LR\n  Alpha-->Beta-->Gamma\n```"
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[assistant("diagram", diagram)]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
          />
        ),
        { width: 48, height: 30 },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("┌"), "the diagram")
      const rows = frame.split("\n")
      const labelRow = Option.getOrThrow(
        Option.fromUndefinedOr(rows.find((row) => row.includes("Alpha"))),
      )
      expect(labelRow).toContain("Gamma")
      expect(labelRow.trimEnd().endsWith("│")).toBe(true)
    }),
  )

  // The diagram builds while its fence streams: each complete statement
  // draws, and the statement still being written waits for its line to end.
  it.scopedLive("a diagram draws while its fence streams, one complete statement at a time", () =>
    Effect.gen(function* () {
      const notice: SessionEvent = { _tag: "interruption", createdAt: 1, seq: 1 }
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[
              assistant("open", "```mermaid\ngraph LR\n  Alpha-->Beta\n  Beta-->Gam"),
              notice,
            ]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
          />
        ),
        { width: 60, height: 20 },
      )
      const frame = yield* waitForFrame(setup, (next) => next.includes("┌"), "the diagram")
      expect(frame).toContain("┌")
      expect(frame).toContain("Beta")
      expect(frame).not.toContain("Alpha-->Beta")
      expect(frame).not.toContain("Gam")
    }),
  )

  // A source the diagram library cannot read keeps its fence: the reader
  // sees the code as written, not an empty block. The diagram before it
  // shows the library has loaded.
  it.scopedLive("a diagram that does not parse shows its source as a code block", () =>
    Effect.gen(function* () {
      const content =
        "```mermaid\ngraph LR\n  Alpha-->Beta\n```\n\n```mermaid\nnot a diagram {{{\n```"
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[assistant("broken", content)]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
          />
        ),
        { width: 60, height: 20 },
      )
      const frame = yield* waitForFrame(
        setup,
        (next) => next.includes("┌") && next.includes("not a diagram {{{"),
        "the diagram and the source after it",
      )
      expect(frame).toContain("not a diagram {{{")
      expect(frame).not.toContain("Alpha-->Beta")
    }),
  )

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
            savedText.push(new TextDecoder().decode(event.snapshot.getRealCharBytes(false)))
            Deferred.doneUnsafe(firstCommit, Effect.void)
          }
          renderer.on("external_output", capture)
          onCleanup(() => renderer.off("external_output", capture))
          return (
            <NativeTranscript
              items={items}
              settled
              streaming={false}
              footerHeight={3}
              paneOpen={false}
              expanded={false}
              disclosure="collapsed"
              displayRevision={0}
              overlayOpen={false}
              renderItems={(visible) => (
                <MessageList items={visible} disclosure="collapsed" syntaxStyle={syntaxStyle} />
              )}
            >
              <box />
            </NativeTranscript>
          )
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
          () =>
            transcriptCommit({
              items,
              displayRevision: () => 0,
              overlayOpen: () => false,
              onRenderer: (renderer) => {
                timeouts.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(
                    new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                  )
                })
              },
            }),
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
            () =>
              transcriptCommit({
                items,
                displayRevision: () => 0,
                overlayOpen: () => false,
                onRenderer: (renderer) => {
                  timeouts.applyTo(renderer)
                  renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                    committedText.push(
                      new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                    )
                  })
                },
              }),
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
              <NativeTranscript
                items={items}
                settled
                streaming={false}
                footerHeight={3}
                paneOpen={false}
                expanded={false}
                disclosure="collapsed"
                displayRevision={0}
                overlayOpen={false}
                renderItems={(visible) => (
                  <MessageList items={visible} disclosure="collapsed" syntaxStyle={boldHeadings} />
                )}
              >
                <box />
              </NativeTranscript>
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
                <NativeTranscript
                  items={longHistory()}
                  settled
                  streaming={false}
                  footerHeight={footer()}
                  paneOpen={false}
                  expanded={false}
                  disclosure="collapsed"
                  displayRevision={0}
                  overlayOpen={false}
                  renderItems={(visible) => (
                    <MessageList items={visible} disclosure="collapsed" syntaxStyle={syntaxStyle} />
                  )}
                >
                  <box />
                </NativeTranscript>
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

interface RoomSetup {
  readonly items: () => ListMessage[]
  readonly streaming: () => boolean
  readonly footer: () => number
  readonly onRenderer: (renderer: CliRenderer) => void
}

const roomTranscript = (options: RoomSetup) => {
  const renderer = useRenderer()
  options.onRenderer(renderer)
  return (
    <NativeTranscript
      items={options.items()}
      settled
      streaming={options.streaming()}
      footerHeight={options.footer()}
      paneOpen={false}
      expanded={false}
      disclosure="collapsed"
      displayRevision={0}
      overlayOpen={false}
      renderItems={(visible) => (
        <MessageList items={visible} disclosure="collapsed" syntaxStyle={syntaxStyle} />
      )}
    >
      <box />
    </NativeTranscript>
  )
}

/** The renderer's region offset: the terminal rows above the split region. OpenTUI keeps it private. */
const RegionPlace = Schema.Struct({ renderOffset: Schema.Finite })

/** The rows between the split region's last row and the terminal's last row. */
const rowsUnderRegion = (renderer: CliRenderer): number =>
  renderer.terminalHeight -
  (Schema.decodeUnknownSync(RegionPlace)(renderer).renderOffset + renderer.height)

const committedTextOf = (event: CliRendererExternalOutputEvent) =>
  new TextDecoder().decode(event.snapshot.getRealCharBytes(false))

// OpenTUI writes each committed row, then erases to the line's end. After a
// row that fills the terminal's last column, the cursor still sits on that
// column (the wrap is pending), so an xterm-like terminal erases the row's
// last character: a table's right border is lost in history. Committed rows
// keep the last column free.
describe("native transcript rows in history", () => {
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
          () =>
            roomTranscript({
              items: () => [
                assistant("table", `TABLE-ANSWER\n\n${table}`),
                assistant("tail", "TAIL"),
              ],
              streaming: () => false,
              footer: () => 3,
              onRenderer: (renderer) => {
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  const text = new TextDecoder().decode(event.snapshot.getRealCharBytes(true))
                  committedRows.push(...text.split("\n"))
                })
              },
            }),
          { width, height: 14 },
        )
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({
            until: () => committedRows.some((row) => row.includes("└")),
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("6 seconds"),
          Effect.ignore,
        )
        const tableRows = committedRows.filter((row) => /[┌├│└]/.test(row))
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
          () =>
            roomTranscript({
              items: () => [assistant("short", "SHORT-ANSWER"), assistant("tail", "TAIL")],
              streaming: () => false,
              footer,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
              },
            }),
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
          () =>
            roomTranscript({
              items,
              streaming,
              footer: () => 3,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              },
            }),
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
  readonly items: () => ListMessage[]
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
      <NativeTranscript
        items={options.items()}
        settled
        streaming={options.streaming()}
        footerHeight={options.footer()}
        paneOpen={options.paneOpen()}
        expanded={false}
        disclosure="collapsed"
        displayRevision={0}
        overlayOpen={options.overlayOpen()}
        renderItems={(visible) => (
          <MessageList items={visible} disclosure="collapsed" syntaxStyle={syntaxStyle} />
        )}
      >
        <box />
      </NativeTranscript>
      <box height={options.footer()} flexShrink={0} flexDirection="column">
        <text>COMPOSER</text>
        <Show when={options.paneOpen()}>
          <text>PANE</text>
        </Show>
      </box>
    </box>
  )
}

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
  const settledLongSession = (options: BottomSetup) =>
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
          bodyRowCounts(terminalText(setup)).has("ITEM-0 line 1"),
        "the long session at the terminal's bottom",
        6_000,
      ).pipe(Effect.ignore)
      const settled = yield* waitForStableFrame(setup)
      return { setup, renderer, settled }
    })

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

  it.scopedLive(
    "every transcript row is in history or on screen, once",
    () =>
      Effect.gen(function* () {
        const { setup } = yield* settledLongSession({
          items: () => [...longSession(), assistant("tail", "TAIL")],
          streaming: () => false,
          footer: () => 3,
          paneOpen: () => false,
          overlayOpen: () => false,
        })
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

  it.scopedLive(
    "a turn that ends leaves no blank row above the composer",
    () =>
      Effect.gen(function* () {
        const [items, setItems] = createSignal<ListMessage[]>([
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
        batch(() => {
          setItems([...longSession(), assistant("answer", longBody("ANSWER-0"))])
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

  // An answer whose top rows are in history writes the rest at exit from the
  // same layout: the plain layout has other rows, so the rest would start
  // at the wrong row and lose or repeat rows.
  it.scopedLive(
    "exit writes the rest of an answer cut by history, every row once",
    () =>
      Effect.gen(function* () {
        const history: string[] = []
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
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  history.push(committedTextOf(event))
                })
              },
            }),
          { width: 60, height },
        )
        yield* waitForFrame(
          setup,
          () => bodyRowCounts(history.join("")).has("ITEM-0 line 1"),
          "history",
          6_000,
        )
        yield* waitForStableFrame(setup)
        // The live tail starts inside an answer: its top rows are in history.
        const shown = bodyRowCounts(renderFrame(setup))
        const kept = bodyRowCounts(history.join(""))
        expect([...shown.keys()].some((row) => kept.has(row.replace(/line \d+/, "line 1")))).toBe(
          true,
        )
        yield* flushTranscriptForExit(Option.getOrThrow(screen))
        const counts = bodyRowCounts(history.join(""))
        for (const item of longSession().keys()) {
          for (let line = 1; line <= 12; line++) {
            const row = `ITEM-${item} line ${line}`
            expect([row, counts.get(row)]).toEqual([row, 1])
          }
        }
      }).pipe(Effect.timeout("20 seconds")),
    25_000,
  )

  // An answer whose highlight never settles commits plain, and the plain
  // layout has other rows than the live view: its top rows never go alone,
  // so no row reaches history twice or shows in history and on screen.
  it.scopedLive(
    "an answer that never settles goes to history whole, no row twice",
    () =>
      Effect.gen(function* () {
        const timeouts = makeSettleTimeouts(Number.MAX_SAFE_INTEGER)
        const history: string[] = []
        const setup = yield* renderScoped(
          () =>
            bottomTranscript({
              items: () => [...longSession(), assistant("tail", "TAIL")],
              streaming: () => false,
              footer: () => 3,
              paneOpen: () => false,
              overlayOpen: () => false,
              onRenderer: (renderer) => {
                timeouts.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  history.push(committedTextOf(event))
                })
              },
            }),
          { width: 60, height },
        )
        yield* waitForFrame(
          setup,
          () => bodyRowCounts(history.join("")).has("ITEM-0 line 12"),
          "history",
          8_000,
        )
        yield* waitForStableFrame(setup)
        const counts = bodyRowCounts(history.join("") + renderFrame(setup))
        for (const [row, count] of counts) expect([row, count]).toEqual([row, 1])
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
        const asked = (id: string, text: string): ListMessage => ({
          ...userMessage("regular-message", id, text, "queued"),
          pendingMode: absent,
          metadata: { fromClient: true },
        })
        const [items, setItems] = createSignal<ListMessage[]>([
          asked("p1", "FIRST-ASK"),
          listAnswer("a1", "ROWA", 60),
        ])
        const [streaming, setStreaming] = createSignal(false)
        const [footer, setFooter] = createSignal(4)
        const { setup } = yield* settledLongSession({
          items,
          streaming,
          footer,
          paneOpen: () => false,
          overlayOpen: () => false,
        })
        // A short turn runs and ends, with the activity row in the footer.
        batch(() => {
          setItems([
            asked("p1", "FIRST-ASK"),
            listAnswer("a1", "ROWA", 60),
            asked("p2", "SECOND-ASK"),
            { ...listAnswer("a2", "ROWB", 4), draft: true },
          ])
          setStreaming(true)
          setFooter(6)
        })
        yield* waitForStableFrame(setup)
        batch(() => {
          setItems([
            asked("p1", "FIRST-ASK"),
            listAnswer("a1", "ROWA", 60),
            asked("p2", "SECOND-ASK"),
            listAnswer("a2", "ROWB", 4),
          ])
          setStreaming(false)
          setFooter(3)
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
})

// ── native transcript exit ──────────────────────────────────────────────────

describe("native transcript exit", () => {
  it.scopedLive(
    "exit moves a turn still in flight into history before the renderer goes",
    () =>
      Effect.gen(function* () {
        const committedText: string[] = []
        let screen = Option.none<CliRenderer>()
        const items: ListMessage[] = [
          assistant("earlier", "EARLIER-ANSWER"),
          { ...assistant("open", "IN-FLIGHT-DRAFT"), draft: true },
        ]
        const setup = yield* renderScoped(
          () =>
            roomTranscript({
              items: () => items,
              streaming: () => true,
              footer: () => 3,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              },
            }),
          { width: 60, height: 14 },
        )
        // A short session: the live tail holds both, and nothing is in history.
        yield* waitForFrame(
          setup,
          (next) => next.includes("EARLIER-ANSWER") && next.includes("IN-FLIGHT-DRAFT"),
          "the live tail",
        )
        expect(committedText.join("")).toBe("")
        yield* flushTranscriptForExit(Option.getOrThrow(screen))
        const history = committedText.join("")
        expect(history).toContain("EARLIER-ANSWER")
        expect(history).toContain("IN-FLIGHT-DRAFT")
        expect(history.indexOf("EARLIER-ANSWER")).toBeLessThan(history.indexOf("IN-FLIGHT-DRAFT"))
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )

  // A signal interrupts the fiber that holds the process open. It leaves the
  // terminal as the reader's exit does: history first, then the renderer.
  it.scopedLive(
    "a signal moves a turn still in flight into history before the renderer goes",
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
          () =>
            roomTranscript({
              items: () => items,
              streaming: () => true,
              footer: () => 3,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              },
            }),
          { width: 60, height: 14 },
        )
        yield* waitForFrame(setup, (next) => next.includes("SIGNALLED-DRAFT"), "the live tail")
        const renderer = Option.getOrThrow(screen)
        const hold = yield* Effect.forkChild(
          holdUntilRendererDestroyed(renderer, (text) => written.push(text)),
        )
        // The hold has started: it waits on the renderer, as the process entry does.
        yield* Effect.yieldNow
        yield* Fiber.interrupt(hold)
        expect(committedText.join("")).toContain("SIGNALLED-DRAFT")
        expect(renderer.isDestroyed).toBe(true)
        // The cursor goes back over the cleared region, under the transcript.
        expect(written).toHaveLength(1)
        expect(written[0]).toMatch(new RegExp(`^${String.fromCharCode(27)}\\[[1-9][0-9]*A$`))
      }).pipe(Effect.timeout("10 seconds")),
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
          () =>
            roomTranscript({
              items: () => items,
              streaming: () => true,
              footer: () => 3,
              onRenderer: (renderer) => {
                screen = Option.some(renderer)
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(committedTextOf(event))
                })
              },
            }),
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
          <NativeTranscript
            items={[]}
            settled
            streaming={false}
            footerHeight={3}
            paneOpen={false}
            expanded={expanded()}
            disclosure="collapsed"
            displayRevision={0}
            overlayOpen={false}
            renderItems={() => <box />}
          >
            <box />
          </NativeTranscript>
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
 * Encoding the object itself gave those two spellings different strings, so a
 * rebuilt message broke the committed prefix, forced a replay, and cleared the
 * terminal's saved lines — the reader lost the session above the fold. The
 * fingerprint therefore names the drawn fields in a fixed order.
 */

/** The streaming path writes `_tag` first and carries no metadata. */
const streamedMessage = (id: string, content: string): ListMessage => ({
  _tag: "regular-message",
  id,
  role: "assistant",
  content,
  reasoning: "",
  images: [],
  createdAt: 0,
  segments: [{ _tag: "text", content }],
})

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
    expect(transcriptFingerprint(streamedMessage("m1", "hello"))).toBe(
      transcriptFingerprint(rebuiltMessage("m1", "hello")),
    )
  })

  test("new text still changes the fingerprint", () => {
    expect(transcriptFingerprint(rebuiltMessage("m1", "hello world"))).not.toBe(
      transcriptFingerprint(streamedMessage("m1", "hello")),
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

const transcript = (options: {
  readonly items: () => ListMessage[]
  readonly onRenderer: (renderer: CliRenderer) => void
}) => {
  const renderer = useRenderer()
  options.onRenderer(renderer)
  return (
    <NativeTranscript
      items={options.items()}
      settled
      streaming={false}
      footerHeight={3}
      paneOpen={false}
      expanded={false}
      disclosure="collapsed"
      displayRevision={0}
      overlayOpen={false}
      renderItems={(visible) => (
        <MessageList items={visible} disclosure="collapsed" syntaxStyle={syntaxStyle} />
      )}
    >
      <box />
    </NativeTranscript>
  )
}

describe("native transcript rebuild", () => {
  it.scopedLive(
    "a message rebuilt in the other key order does not replay scrollback",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const committedText: string[] = []
        const [items, setItems] = createSignal<ListMessage[]>([
          streamedMessage("first", longBody("REBUILT-ITEM")),
          streamedMessage("second", "TAIL"),
        ])

        const setup = yield* renderScoped(
          () =>
            transcript({
              items,
              onRenderer: (renderer) => {
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(
                    new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                  )
                })
              },
            }),
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

const transcriptCommit = (options: {
  readonly items: ListMessage[]
  readonly displayRevision: () => number
  readonly overlayOpen: () => boolean
  readonly onRenderer: (renderer: CliRenderer) => void
}) => {
  const renderer = useRenderer()
  options.onRenderer(renderer)
  return (
    <NativeTranscript
      items={options.items}
      settled
      streaming={false}
      footerHeight={3}
      paneOpen={false}
      expanded={false}
      disclosure="collapsed"
      displayRevision={options.displayRevision()}
      overlayOpen={options.overlayOpen()}
      renderItems={(visible) => (
        <MessageList items={visible} disclosure="collapsed" syntaxStyle={syntaxStyle} />
      )}
    >
      <box />
    </NativeTranscript>
  )
}

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
          () =>
            transcriptCommit({
              items,
              displayRevision: () => 0,
              overlayOpen,
              onRenderer: (renderer) => {
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(
                    new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                  )
                })
              },
            }),
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
          () =>
            transcriptCommit({
              items,
              displayRevision: () => 0,
              overlayOpen,
              onRenderer: (renderer) => {
                const reset = renderer.resetSplitFooterForReplay.bind(renderer)
                Object.defineProperty(renderer, "resetSplitFooterForReplay", {
                  configurable: true,
                  value: (options?: { readonly clearSavedLines?: boolean }) => {
                    resets.push(`clearSavedLines=${String(options?.clearSavedLines === true)}`)
                    reset(options)
                  },
                })
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(
                    new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                  )
                })
              },
            }),
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
          () =>
            transcriptCommit({
              items,
              displayRevision: () => 0,
              overlayOpen: () => false,
              onRenderer: (renderer) => {
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(
                    new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                  )
                })
              },
            }),
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
          () =>
            transcriptCommit({
              items,
              displayRevision: () => 0,
              overlayOpen: () => false,
              onRenderer: (renderer) => {
                refuseCommits(1)(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(
                    new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                  )
                })
              },
            }),
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
          () =>
            transcriptCommit({
              items,
              displayRevision,
              overlayOpen: () => false,
              onRenderer: (renderer) => {
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(
                    new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                  )
                })
              },
            }),
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
   * be scrollable. Two footer spellings used to destroy it: a footer grown to
   * the full screen left no region, and a per-commit footer change ran
   * OpenTUI's `applyScreenMode` mid-commit, which rewrites the screen with
   * `ESC[nS` and drops the rows instead of scrolling them away. Both reported
   * success to the component while the terminal kept no history at all.
   */
  it.scopedLive(
    "a tall live view still leaves the terminal rows to scroll",
    () =>
      Effect.gen(function* () {
        // Enough items that the live view wants far more than the 14 rows the
        // terminal has, which is what used to push the footer to full screen.
        const items = Array.from({ length: 8 }, (_, index) =>
          assistant(`item-${index}`, longBody(`ITEM-${index}`)),
        )
        const screenHeight = 14
        const footerHeights: number[] = []
        let committedFooterHeights: number[] = []

        const setup = yield* renderScoped(
          () =>
            transcriptCommit({
              items,
              displayRevision: () => 0,
              overlayOpen: () => false,
              onRenderer: (renderer) => {
                // Record the footer height the renderer actually holds at the
                // moment rows are handed to scrollback, and on every frame,
                // so a height that only exists mid-commit is still seen.
                renderer.on("external_output", () => {
                  committedFooterHeights.push(renderer.footerHeight)
                })
                renderer.on("frame", () => {
                  footerHeights.push(renderer.footerHeight)
                })
              },
            }),
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
        committedFooterHeights = []
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
          () =>
            transcriptCommit({
              items,
              displayRevision: () => 0,
              overlayOpen: () => false,
              onRenderer: (renderer) => {
                hold.applyTo(renderer)
                renderer.on("external_output", (event: CliRendererExternalOutputEvent) => {
                  committedText.push(
                    new TextDecoder().decode(event.snapshot.getRealCharBytes(false)),
                  )
                })
              },
            }),
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
  /** A prompt the reader typed: the server stamps its client origin. */
  const prompt = (id: string, text: string): ListMessage => ({
    ...userMessage("regular-message", id, text, "queued"),
    pendingMode: absent,
    metadata: { fromClient: true },
  })
  /** A user-role message an extension sent: a parent's message, a wake, a delegate start. */
  const extensionSent = (id: string, text: string): ListMessage => ({
    ...userMessage("regular-message", id, text, "queued"),
    pendingMode: absent,
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
            <NativeTranscript
              items={items()}
              settled
              streaming={options.streaming === true}
              footerHeight={options.footer ?? 3}
              paneOpen={false}
              expanded={false}
              disclosure="collapsed"
              displayRevision={0}
              overlayOpen={false}
              renderItems={(visible) => (
                <MessageList items={visible} disclosure="collapsed" syntaxStyle={syntaxStyle} />
              )}
            >
              <box />
            </NativeTranscript>
          )
        },
        { width: 50, height: options.height ?? 16 },
      )
      yield* Effect.promise(() => setup.flush()).pipe(
        Effect.repeat({ until: () => extensionsLoaded() }),
        Effect.timeout("5 seconds"),
      )
      for (let pass = 0; pass < 6; pass++) yield* Effect.promise(() => setup.flush())
      return setup
    })

  it.scopedLive("no pinned row while the prompt is on screen", () =>
    Effect.gen(function* () {
      const setup = yield* mountTranscript(() => [prompt("p1", "ASK-ONE"), reply("r1", 1)], {})
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
        () => [prompt("p1", "ASK-ONE"), reply("r1", 20), { ...reply("r2", 20), draft: true }],
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
      const setup = yield* mountTranscript(() => [prompt("p1", long), reply("r1", 20)], {})
      const frame = yield* waitForFrame(setup, (next) => next.includes("↑ ASK-LONG"), "pinned")
      const pinned = frame.split("\n").find((line) => line.includes("↑ ASK-LONG")) ?? ""
      expect(pinned.trimEnd()).toMatch(/…$/)
      expect(pinned.trimEnd().length).toBeLessThanOrEqual(50)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "the pinned row follows the branch in view, and a queued follow-up is not posted",
    () =>
      Effect.gen(function* () {
        const [items, setItems] = createSignal<SessionItem[]>([
          prompt("p1", "ASK-ONE"),
          reply("r1", 20),
          { ...reply("d1", 20), draft: true },
          // Waiting in the queue: the reader has not seen it run.
          userMessage("regular-message", "q1", "QUEUED-ASK", "queued"),
        ])
        const setup = yield* mountTranscript(items, { streaming: true })
        const frame = yield* waitForFrame(setup, (next) => next.includes("↑ ASK-ONE"), "pinned")
        expect(frame).not.toContain("↑ QUEUED-ASK")
        // Another branch: its own last prompt, derived from its own messages.
        setItems([prompt("p2", "ASK-TWO"), reply("r2", 20), { ...reply("d2", 20), draft: true }])
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
            prompt("p1", "ASK-ONE"),
            reply("r1", 20),
            extensionSent("w1", "PARENT-SAYS"),
            reply("r2", 20),
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
        ...userMessage("interjection-message", "s1", "STEER-NOW", "steer"),
        pendingMode: absent,
        metadata: { fromClient: true },
      }
      const setup = yield* mountTranscript(
        () => [
          prompt("p1", "ASK-ONE"),
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
            "queued",
          ),
          pendingMode: absent,
          metadata: { customType: BTW_QUESTION_TYPE, extensionId: "@gent/btw" },
        }
        const setup = yield* mountTranscript(() => [asked, reply("r1", 20)], { streaming: true })
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
          prompt("p0", "ASK-ONE"),
          ...Array.from({ length: HISTORY }, (_, index) => counted(`h${index}`)),
        ]
        const tail = history.at(-1)
        const [grown, setGrown] = createSignal(1)
        let extensionsLoaded = () => false
        const setup = yield* renderScoped(
          () => {
            extensionsLoaded = useExtensionUI().loaded
            return (
              <NativeTranscript
                items={history}
                settled
                streaming
                footerHeight={3}
                paneOpen={false}
                expanded={false}
                disclosure="collapsed"
                displayRevision={0}
                overlayOpen={false}
                renderItems={(visible) => (
                  <Show when={visible[0] === tail} fallback={<text>row</text>}>
                    <text>{Array.from({ length: grown() }, () => "GROW").join("\n")}</text>
                  </Show>
                )}
              >
                <box />
              </NativeTranscript>
            )
          },
          { width: 50, height: 16 },
        )
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({ until: () => extensionsLoaded() }),
          Effect.timeout("5 seconds"),
        )
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
      const setup = yield* mountTranscript(() => [prompt("p1", "ASK-ONE"), reply("r1", 20)], {
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
            committed.push(new TextDecoder().decode(event.snapshot.getRealCharBytes(false)))
          })
          return (
            <NativeTranscript
              items={rows.map((row) => row.item)}
              settled
              streaming={false}
              footerHeight={3}
              paneOpen={false}
              expanded={false}
              disclosure="collapsed"
              displayRevision={0}
              overlayOpen={false}
              renderItems={(visible) => {
                const row = rows.find((candidate) => candidate.item === visible[0])
                const name = row?.name ?? ""
                const text = Array.from({ length: row?.lines ?? 1 }, (_, index) => {
                  if (index === 0) return `${name.toUpperCase()}-TOP`
                  return `${name}-${index}`
                }).join("\n")
                return <text>{text}</text>
              }}
            >
              <box />
            </NativeTranscript>
          )
        },
        { width: 50, height: 16 },
      )
      yield* Effect.promise(() => setup.flush()).pipe(
        Effect.repeat({ until: () => extensionsLoaded() }),
        Effect.timeout("5 seconds"),
      )
      for (let pass = 0; pass < 8; pass++) yield* Effect.promise(() => setup.flush())
      return { setup, committed }
    })

  it.scopedLive("under the pinned row every line of the live tail stays in view", () =>
    Effect.gen(function* () {
      // The tail's 11 rows fill the live rows exactly; the pinned row takes one.
      const { setup, committed } = yield* mountExact([
        { item: prompt("p0", "ASK-ONE"), name: "p0", lines: 1 },
        { item: reply("h1", 1), name: "h1", lines: 20 },
        { item: reply("tail", 1), name: "tail", lines: 11 },
      ])
      yield* waitForFrame(setup, (next) => next.includes("↑ ASK-ONE"), "pinned")
      for (let pass = 0; pass < 4; pass++) yield* Effect.promise(() => setup.flush())
      const frame = renderFrame(setup)
      const history = committed.join("")
      // A line is in view on screen or in native history, never in neither.
      const lost = ["TAIL-TOP", "tail-5", "tail-10"].filter(
        (line) => !frame.includes(line) && !history.includes(line),
      )
      expect(lost).toEqual([])
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("readerPrompt", () => {
  const user = (
    metadata: ListMessage["metadata"],
    options: {
      readonly tag?: "regular-message" | "interjection-message"
      readonly queued?: true
    } = {},
  ): ListMessage => {
    const base = userMessage(options.tag ?? "regular-message", "m", "TEXT", "queued")
    if (options.queued === true) return { ...base, metadata }
    return { ...base, pendingMode: absent, metadata }
  }
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

  test("a queued follow-up is not a prompt until it runs, and a hidden message never is", () => {
    expect(read(user({ fromClient: true }, { queued: true }))).toBeUndefined()
    expect(read(user({ fromClient: true, hidden: true }))).toBeUndefined()
  })

  test("a custom type whose renderer names it a prompt is the reader's, in its asked text", () => {
    expect(read(user({ extensionId: "@gent/btw", customType: "btw" }), btwTypes)).toBe(
      "asked: TEXT",
    )
    expect(read(user({ extensionId: "@gent/x", customType: "other" }), btwTypes)).toBeUndefined()
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
      expect(callLabels(rows)).toEqual(["└ read apps/tui/src/app.tsx"])
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
      expect(callLabels(rows)).toEqual([`└ read ${cwd}/config.ts`, "└ read src/app.tsx"])
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
      expect(callLabels(rows)).toEqual(["└ read /etc/hosts"])
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
        const row = lines.findIndex((line) => line.includes("└ bash"))
        expect(lines[row]).toContain("└ bash echo sanity-")
        expect(lines.join("\n")).not.toContain("dbg-review")
        expect(lines.slice(row + 1).join("\n")).not.toContain("semantics")
      }
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("message rows", () => {
  it.scopedLive("a steer row carries its label, and an answer its reasoning", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        {
          _tag: "interjection-message",
          id: "user-1",
          role: "user",
          pendingMode: "steer",
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
        <MessageList items={items} disclosure="collapsed" syntaxStyle={syntaxStyle} />
      ))
      yield* Effect.promise(() => setup.renderOnce())
      const frame = renderFrame(setup)
      expect(frame).toContain("[steer]")
      expect(frame).toContain("Stop and switch agent")
      expect(frame).toContain("Considering current todo state")
    }),
  )
})
