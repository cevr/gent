/** @jsxImportSource @opentui/solid */
import { Deferred, Effect, Option, Schema } from "effect"
import { type CliRenderer, type CliRendererExternalOutputEvent, SyntaxStyle } from "@opentui/core"
import { describe, expect, it, test } from "effect-bun-test"
import {
  addStep,
  emptyTurnSteps,
  getSessionEventLabel,
  type Message as ListMessage,
  MessageList,
  NativeTranscript,
  reasoningMarkdown,
  type SessionEvent,
  type SessionItem,
  SPLIT_FOOTER_RESERVED_OUTPUT_ROWS,
  splitFooterHeight,
  type ToolCall,
  transcriptFingerprint,
} from "../src/message-list"
import * as Prompt from "effect/unstable/ai/Prompt"
import { type Message as DomainMessage } from "@gent/sdk"
import {
  BranchId,
  dateFromMillis,
  Message,
  MessageId,
  MODEL_CHANGE_MESSAGE_TYPE,
  type MessagePart,
  SessionId,
  ToolCallId,
  projectMessagesWithToolInteractions,
} from "@gent/core/protocol"
import { type SessionMessageDetails, sessionMessageText } from "@gent/extensions/client"
import { createSignal, onCleanup, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { DisclosureLevel } from "../src/session"
import { ToolCallIdentityProvider, ToolFrame } from "../src/ui"
import { EditToolRenderer, ReadToolRenderer, useToolRenderers } from "../src/tool-renderers"
import { renderFrame, renderWithProviders } from "./render-harness-boundary"
import { makeSettleHold } from "./scrollback-hold-boundary"
import { waitForRenderedFrame } from "./helpers-boundary"
import { useExtensionUI } from "../src/extensions/host"
import { builtinClientModules } from "../src/extensions/builtins"
import { clientContributions, defineClientExtension } from "../src/extensions/client-facets"

// ── message-list.test ───────────────────────────────────────────────────────

// ── split-footer-height.test ────────────────────────────────────────────────

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

// ── reasoning-text.test ─────────────────────────────────────────────────────

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

// ── session-event-indicator.test ────────────────────────────────────────────

describe("session event labels", () => {
  test("formats retrying progress", () => {
    const createdAt = 1_000
    const event: SessionEvent = {
      _tag: "retrying",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      resolved: false,
      createdAt,
      seq: 1,
    }

    expect(getSessionEventLabel(event, createdAt)).toBe("Retrying in 2s... 1/3")
    expect(getSessionEventLabel(event, createdAt + 1_100)).toBe("Retrying in 1s... 1/3")
    expect(getSessionEventLabel(event, createdAt + 2_000)).toBe("Retrying now... 1/3")
    expect(getSessionEventLabel({ ...event, resolved: true }, createdAt + 20_000)).toBe(
      "Retry 1/3 finished",
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
    expect(getSessionEventLabel(event)).toBe("Worked for 7m 32s · 3 steps · 2 tool calls · $0.012")
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

// ── sdk-utilities.test ──────────────────────────────────────────────────────

const absent = Option.getOrUndefined(Option.none())
let messageIndex = 0

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

  test("exposes running tool calls on projected messages", () => {
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: { path: "/foo" },
          providerExecuted: false,
        }),
        Prompt.textPart({ text: "Some text" }),
        Prompt.toolCallPart({
          id: ToolCallId.make("tc2"),
          name: "edit",
          params: { path: "/bar" },
          providerExecuted: false,
        }),
      ]),
    ]

    const projected = projectMessagesWithToolInteractions(messages)[0]
    expect(projected?.toolInteractions).toEqual([
      {
        id: ToolCallId.make("tc1"),
        toolName: "read",
        status: "running",
        input: { path: "/foo" },
        summary: absent,
        output: absent,
        durationMs: absent,
      },
      {
        id: ToolCallId.make("tc2"),
        toolName: "edit",
        status: "running",
        input: { path: "/bar" },
        summary: absent,
        output: absent,
        durationMs: absent,
      },
    ])
  })

  test("returns empty interactions when no tool calls", () => {
    const projected = projectMessagesWithToolInteractions([
      makeMsg("assistant", [Prompt.textPart({ text: "Just text" })]),
    ])[0]
    expect(projected?.toolInteractions).toEqual([])
  })

  test("joins tool calls with tool-message results", () => {
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", "file contents here")]),
    ]

    const projected = projectMessagesWithToolInteractions(messages)[0]
    expect(projected?.toolInteractions[0]).toEqual({
      id: ToolCallId.make("tc1"),
      toolName: "read",
      status: "completed",
      input: {},
      summary: "file contents here",
      output: "file contents here",
      durationMs: absent,
    })
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

  test("truncates long output in summary", () => {
    const longText = "x".repeat(150)
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", longText)]),
    ]

    const result = projectMessagesWithToolInteractions(messages)[0]!.toolInteractions[0]!
    const summary = Option.getOrElse(Option.fromNullishOr(result.summary), () => "")
    expect(summary.length).toBe(103) // 100 + "..."
    expect(summary.endsWith("...")).toBe(true)
    expect(result.output).toBe(longText) // full output preserved
  })

  test("summary uses first line only", () => {
    const multiline = "First line\nSecond line\nThird line"
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", multiline)]),
    ]

    expect(projectMessagesWithToolInteractions(messages)[0]?.toolInteractions[0]?.summary).toBe(
      "First line",
    )
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

  test("handles multiple tool results", () => {
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
        Prompt.toolCallPart({
          id: ToolCallId.make("tc2"),
          name: "edit",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", "result1"), toolResult("tc2", "result2")]),
    ]

    const interactions = projectMessagesWithToolInteractions(messages)[0]!.toolInteractions
    expect(interactions.length).toBe(2)
    expect(interactions[0]?.output).toBe("result1")
    expect(interactions[1]?.output).toBe("result2")
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

// ── message-list-render.test ────────────────────────────────────────────────

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
      toolCalls: absent,
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
    toolCalls: absent,
  }
}

/**
 * One assistant message carrying one tool call.
 *
 * The feed writes `segments` for every assistant message, so a fixture that
 * carries only `toolCalls` draws nothing. Both fields name the same call here,
 * the way the feed spells it.
 */
const assistantToolMessage = (id: string, toolCall: ToolCall): ListMessage => ({
  _tag: "regular-message",
  id,
  role: "assistant",
  content: "",
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: [toolCall],
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

const compactionMessage = (): ListMessage => ({
  _tag: "regular-message",
  id: "context-handoff:b1:m3",
  role: "user",
  content: "Context handoff: the user renamed the loader.",
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: absent,
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
      <MessageList
        items={props.items}
        disclosure="collapsed"
        syntaxStyle={syntaxStyle}
        streaming={false}
      />
      <MessageList
        items={props.items}
        disclosure="preview"
        syntaxStyle={syntaxStyle}
        streaming={false}
      />
      <Show when={props.fullDetail}>
        <MessageList
          items={props.items}
          disclosure="preview"
          fullDetail
          syntaxStyle={syntaxStyle}
          streaming={false}
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
        streaming={false}
      />
    </Show>
  )
}

/** Render the loaded transcript and return its first frame past the load. */
const renderLoaded = (items: SessionItem[], fullDetail?: boolean) =>
  Effect.gen(function* () {
    const setup = yield* Effect.promise(() =>
      renderWithProviders(() => <LoadedMessageList items={items} fullDetail={fullDetail} />),
    )
    return yield* Effect.promise(() =>
      waitForRenderedFrame(
        setup,
        (frame) => !frame.includes("loading message renderers"),
        "message renderers",
      ),
    )
  })

describe("FX transcript treatment", () => {
  it.live("shows information excluded from model context in the transcript", () =>
    Effect.gen(function* () {
      const message: ListMessage = {
        ...compactionMessage(),
        id: "presented-information",
        content: "INFORMATION-SHOWN",
        metadata: { customType: "prompt-present", hidden: true },
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessageList
            items={[message]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
            streaming={false}
          />
        )),
      )
      expect(renderFrame(setup)).toContain("INFORMATION-SHOWN")
    }),
  )

  it.live("renders user rails, images, and pending labels at normal width", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        userMessage("regular-message", "queued-user", "first line\nsecond line", "queued", [
          { mediaType: "image/png" },
        ]),
        userMessage("interjection-message", "steer-user", "switch now", "steer"),
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessageList
            items={items}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
            streaming={false}
          />
        )),
      )
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
    it.live(`keeps the user border on every scrollback row at width ${width}`, () =>
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
          toolCalls: absent,
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
        const setup = yield* Effect.promise(() =>
          renderWithProviders(
            () => {
              const renderer = useRenderer()
              extensionsLoaded = useExtensionUI().loaded
              // Check native cells: string offsets do not match terminal columns for wide glyphs.
              const capture = (event: CliRendererExternalOutputEvent) => {
                const { snapshot } = event
                savedText.push(new TextDecoder().decode(snapshot.getRealCharBytes(false)))
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
                  streaming={false}
                  footerHeight={3}
                  expanded={false}
                  disclosure={disclosure()}
                  displayRevision={0}
                  overlayOpen={false}
                  renderItems={(visible) => (
                    <MessageList
                      items={visible}
                      disclosure={disclosure()}
                      syntaxStyle={syntaxStyle}
                      streaming={false}
                    />
                  )}
                >
                  <box />
                </NativeTranscript>
              )
            },
            { width, height: 14 },
          ),
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
          yield* Effect.promise(() => setup.flush())
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

  it.live(
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
        const setup = yield* Effect.promise(() =>
          renderWithProviders(
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
                  streaming={false}
                  footerHeight={3}
                  expanded={false}
                  disclosure="collapsed"
                  displayRevision={0}
                  overlayOpen={false}
                  renderItems={(visible) => (
                    <MessageList
                      items={visible}
                      disclosure="collapsed"
                      syntaxStyle={syntaxStyle}
                      streaming={false}
                    />
                  )}
                >
                  <box />
                </NativeTranscript>
              )
            },
            { width: 60, height: 14, builtins: [...builtinClientModules, held] },
          ),
        )
        // Held: the live view overflows, but nothing may reach scrollback yet.
        for (let pass = 0; pass < 20; pass++) {
          yield* Effect.promise(() => setup.flush())
          yield* Effect.yieldNow
        }
        expect(savedText.join("")).toBe("")
        yield* Deferred.complete(release, Effect.void)
        yield* Effect.promise(() =>
          waitForRenderedFrame(
            setup,
            () => savedText.join("").includes("goal continuation"),
            "goal row in scrollback",
          ),
        )
        expect(savedText.join("")).not.toContain("RAW-GOAL-TEXT")
      }),
  )

  it.live("goal continuations collapse to one line until full detail is on", () =>
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

  it.live("a fired alarm collapses to its note until full detail is on", () =>
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

  it.live("a message from another session names its sender above the text", () =>
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
      expect(frame).toContain('» from your parent "auth refactor" · 0199aabb')
      expect(frame).toContain("Use the v2 token route.")
      expect(frame).toContain("Then rerun the suite.")
      expect(frame).not.toContain("Message from your parent")
      expect(frame).not.toContain("(session 0199aabbccdd)")
      const expandedFrame = yield* renderLoaded([sent], true)
      expect(expandedFrame).toContain("Message from your parent")
    }),
  )

  it.live("a long child name is cut so the id stays on the sender line", () =>
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
      expect(frame).toContain('» from your child "delegate: Use session.send with…" · 01a0ca0c')
      expect(frame).toContain("hello from the child")
      // The status line is for the model; the row already says who is writing.
      expect(frame).not.toContain("not its completion")
    }),
  )

  it.live("a child row stored before the status line still shows only its text", () =>
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
      expect(frame).toContain(`"${Array.from(from.name).slice(0, 15).join("")}…" · 01a0ca0c`)
    }),
  )

  it.live("keeps multiline user text visible in a narrow transcript", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [
        userMessage(
          "regular-message",
          "narrow-user",
          "a long first line that wraps in a narrow terminal\nsecond line stays selectable",
          "queued",
        ),
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <MessageList
              items={items}
              disclosure="collapsed"
              syntaxStyle={syntaxStyle}
              streaming={false}
            />
          ),
          { width: 32, height: 16 },
        ),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("┃")
      expect(frame).toContain("a long first")
      expect(frame).toContain("second line")
      expect(frame).toContain("selectable")
    }),
  )

  it.live("shares one resize subscription across transcript event rows", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = Array.from({ length: 12 }, (_, seq) => ({
        _tag: "retrying",
        attempt: seq + 1,
        maxAttempts: 12,
        delayMs: 1_000,
        resolved: seq < 11,
        createdAt: seq,
        seq,
      }))
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessageList
            items={items}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
            streaming={false}
          />
        )),
      )
      expect(setup.renderer.listenerCount("resize")).toBe(1)
    }),
  )

  it.live("keeps tool identity and failure status on direct compact and expanded frames", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
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
        )),
      )
      const frame = renderFrame(setup)
      expect(frame.match(/#call-direct-7/g)?.length).toBe(2)
      expect(frame.match(/failed/g)?.length).toBeGreaterThanOrEqual(2)
      expect(frame).toContain("compact failure")
      expect(frame).toContain("expanded failure")
    }),
  )

  it.live("keeps unknown tool failure identity in both MessageList projections", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [unknownFailureMessage("call-unknown-7")]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <>
            <MessageList
              items={items}
              disclosure="collapsed"
              syntaxStyle={syntaxStyle}
              streaming={false}
            />
            <MessageList
              items={items}
              disclosure="preview"
              syntaxStyle={syntaxStyle}
              streaming={false}
            />
          </>
        )),
      )
      const frame = renderFrame(setup)
      expect(frame.match(/#call-unknown-7/g)?.length).toBe(2)
      expect(frame.match(/\[x unknown_fx_tool\]/g)?.length).toBe(2)
      expect(frame.match(/tool failed/g)?.length).toBe(2)
    }),
  )

  it.live("propagates identity through a registered renderer at narrow width", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => <RegisteredToolMessageLists items={[registeredFailureMessage("call-reg-7")]} />,
          { width: 42, height: 20 },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) => next.includes("#call-reg-7") && next.includes("failed"),
          "registered renderer failure",
        ),
      )
      expect(frame.match(/#call-reg-7/g)?.length).toBe(2)
      expect(frame.match(/failed/g)?.length).toBeGreaterThanOrEqual(2)
      expect(frame.match(/✕ failed/g)?.length).toBe(2)
      expect(frame).not.toContain("[x read]")
      expect(frame.match(/read/g)?.length).toBeGreaterThanOrEqual(2)
    }),
  )

  it.live("shows worker recovery errors in collapsed, preview, and detail frames", () =>
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <RegisteredToolMessageLists items={[message]} fullDetail />, {
          width: 110,
          height: 50,
        }),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) => (next.match(/Its source was not replayed/g)?.length ?? 0) >= 3,
          "cell recovery error",
        ),
      )
      expect(frame.match(/Its source was not replayed/g)?.length).toBe(3)
    }),
  )

  it.live("shows cell operation receipts in tree and detail frames", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => <RegisteredToolMessageLists items={[cellMessage("call-cell-7")]} fullDetail />,
          { width: 100, height: 40 },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (next) => next.includes("#call-cell-7") && next.includes("hello from a.txt"),
          "cell renderer",
        ),
      )
      // The compact tree says what the cell did: ops counted in the header, named in the row.
      expect(frame).toContain("1 cell · 2 ops · 1 failed")
      expect(frame).toContain("└ cell read · ✕ write")
      // The detail frame shows each receipt, the display value, and bindings.
      expect(frame).toContain("✓ read 12 lines")
      expect(frame).toContain("✕ write denied")
      expect(frame).toContain("hello from a.txt")
      expect(frame).toContain("note.content")
      expect(frame).toContain("bindings: note")
    }),
  )

  it.live("preview shows the head of the last output and names the rest", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [bashMessage("call-bash-7", 25)]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <MessageList
              items={items}
              disclosure="preview"
              syntaxStyle={syntaxStyle}
              streaming={false}
            />
          ),
          { width: 80, height: 40 },
        ),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("└ bash seq 25 · ↓ 25 lines")
      expect(frame).toContain("row 1")
      expect(frame).toContain("row 20")
      expect(frame).not.toContain("row 21")
      expect(frame).toContain("… +5 lines (ctrl+o)")
    }),
  )

  it.live("keeps the cell row across disclosure changes and renders transcript output once", () =>
    Effect.gen(function* () {
      const [disclosure, setDisclosure] = createSignal<DisclosureLevel>("preview")
      const [fullDetail, setFullDetail] = createSignal(false)
      const output = Array.from(
        { length: 25 },
        (_, index) => `CELL-OUTPUT-${String(index + 1).padStart(3, "0")}`,
      ).join("\n")
      const items = [cellMessage("call-stable", output)]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => {
            const renderers = useToolRenderers()
            return (
              <Show when={renderers().size > 0}>
                <MessageList
                  items={items}
                  disclosure={disclosure()}
                  fullDetail={fullDetail()}
                  syntaxStyle={syntaxStyle}
                  streaming={false}
                />
              </Show>
            )
          },
          { width: 110, height: 55 },
        ),
      )
      const preview = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("… +5 lines (ctrl+o)"),
          "cell preview",
        ),
      )
      const row = Option.getOrThrow(
        Option.fromUndefinedOr(preview.split("\n").find((line) => line.includes("└ cell"))),
      ).trim()
      expect(row).toContain("↑ 2 ↓ 25 lines")
      yield* Effect.sync(() => setDisclosure("full"))
      const full = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("CELL-OUTPUT-025") && frame.includes("note.content"),
          "full cell output",
        ),
      )
      expect(full.split("\n").some((line) => line.trim() === row)).toBe(true)
      expect(full.match(/#call-stable/g)).toHaveLength(1)
      expect(full).not.toContain("… +5 lines")
      yield* Effect.sync(() => {
        setDisclosure("preview")
        setFullDetail(true)
      })
      const transcript = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (frame) => frame.includes("CELL-OUTPUT-025") && !frame.includes("1 cell ·"),
          "full transcript from preview",
        ),
      )
      expect(transcript.split("\n").some((line) => line.trim() === row)).toBe(true)
      expect(transcript).not.toContain("… +5 lines")
      for (let line = 1; line <= 25; line++) {
        const text = `CELL-OUTPUT-${String(line).padStart(3, "0")}`
        expect(transcript.split("\n").filter((value) => value.trim() === text)).toHaveLength(1)
      }
    }),
  )

  it.live("collapsed keeps the group header and hides finished rows and output", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [bashMessage("call-bash-8", 25)]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <MessageList
              items={items}
              disclosure="collapsed"
              syntaxStyle={syntaxStyle}
              streaming={false}
            />
          ),
          { width: 80, height: 20 },
        ),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("1 tool call · 1 bash")
      expect(frame).not.toContain("└ bash")
      expect(frame).not.toContain("row 1")
    }),
  )

  it.live("a context handoff folds to one line until full detail is on", () =>
    Effect.gen(function* () {
      const items: SessionItem[] = [compactionMessage()]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <>
              <MessageList
                items={items}
                disclosure="collapsed"
                syntaxStyle={syntaxStyle}
                streaming={false}
              />
              <MessageList
                items={items}
                disclosure="full"
                syntaxStyle={syntaxStyle}
                streaming={false}
              />
              <MessageList
                items={items}
                disclosure="collapsed"
                fullDetail={true}
                syntaxStyle={syntaxStyle}
                streaming={false}
              />
            </>
          ),
          { width: 100, height: 20 },
        ),
      )
      const frame = renderFrame(setup)
      expect(frame.match(/⇣ context handoff · 3 messages summarized/g)?.length).toBe(2)
      expect(frame.match(/renamed the loader/g)?.length).toBe(1)
    }),
  )

  it.live("the runtime's model-change notice folds to one line", () =>
    Effect.gen(function* () {
      const notice: ListMessage = {
        ...compactionMessage(),
        id: "model-change:b1:m5",
        content: "MODEL-NOTICE-BODY",
        metadata: { customType: MODEL_CHANGE_MESSAGE_TYPE },
      }
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <MessageList
              items={[notice]}
              disclosure="collapsed"
              syntaxStyle={syntaxStyle}
              streaming={false}
            />
          ),
          { width: 100, height: 10 },
        ),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("⇄ model changed")
      expect(frame).not.toContain("MODEL-NOTICE-BODY")
    }),
  )
})

describe("compact file tool bodies", () => {
  it.live("keeps the first and last read lines with the omitted count", () =>
    Effect.gen(function* () {
      const lines = Array.from({ length: 10 }, (_, i) => `read-line-${i + 1}`)
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
        content: lines.join("\n"),
        lineCount: 10,
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
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
        )),
      )
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

  it.live("keeps the end of a long edit with an omitted-lines marker", () =>
    Effect.gen(function* () {
      const oldString = Array.from({ length: 10 }, (_, i) => `old-line-${i + 1}`).join("\n")
      const newString = Array.from({ length: 10 }, (_, i) => `new-line-${i + 1}`).join("\n")
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
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
        )),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("new-line-10")
      expect(frame).toContain("more lines")
      expect(frame).not.toContain("old-line-5")
      expect(frame).not.toContain("new-line-5")
    }),
  )
})

describe("read_session row", () => {
  it.live("draws the counts the result carries", () =>
    Effect.gen(function* () {
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
        sessionId: "session-read-1234",
        content: "READ-SESSION-TREE",
        messageCount: 4,
        branchCount: 2,
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <MessageList
              items={items}
              disclosure="full"
              syntaxStyle={syntaxStyle}
              streaming={false}
            />
          ),
          { width: 100, height: 40 },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (text) => text.includes("4 messages"), "read_session row"),
      )
      expect(frame).toContain("✓ 4 messages, 2 branches")
    }),
  )
})

// ── native-transcript-markdown.test ─────────────────────────────────────────

const assistant = (id: string, content: string): ListMessage => ({
  _tag: "regular-message",
  id,
  role: "assistant",
  content,
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: absent,
  segments: [{ _tag: "text", content }],
})

describe("native transcript markdown", () => {
  it.live("a message enters native history with its markdown concealed", () =>
    Effect.gen(function* () {
      const savedText: string[] = []
      const firstCommit = yield* Deferred.make<void>()
      const body = Array.from({ length: 12 }, (_, index) => `line ${index + 1} of the answer`).join(
        "\n\n",
      )
      const items = [
        assistant("first", `## Known, pre-existing\n${body}\n\nsee \`money.test.ts\` for the rest`),
        assistant("second", "ANSWER-END"),
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
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
                streaming={false}
                footerHeight={3}
                expanded={false}
                disclosure="collapsed"
                displayRevision={0}
                overlayOpen={false}
                renderItems={(visible) => (
                  <MessageList
                    items={visible}
                    disclosure="collapsed"
                    syntaxStyle={syntaxStyle}
                    streaming={false}
                  />
                )}
              >
                <box />
              </NativeTranscript>
            )
          },
          { width: 60, height: 14 },
        ),
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
})

// ── native-transcript-mouse.test ────────────────────────────────────────────

describe("native transcript mouse tracking", () => {
  it.live("native history leaves the wheel to the terminal; the expanded view takes it back", () =>
    Effect.gen(function* () {
      const [expanded, setExpanded] = createSignal(false)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <NativeTranscript
            items={[]}
            streaming={false}
            footerHeight={3}
            expanded={expanded()}
            disclosure="collapsed"
            displayRevision={0}
            overlayOpen={false}
            renderItems={() => <box />}
          >
            <box />
          </NativeTranscript>
        )),
      )
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

// ── native-transcript-fingerprint.test ──────────────────────────────────────

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

const noToolCalls = Option.getOrUndefined(Option.none<ToolCall[]>())

/** The streaming path writes `_tag` first and carries no metadata. */
const streamedMessage = (id: string, content: string): ListMessage => ({
  _tag: "regular-message",
  id,
  role: "assistant",
  content,
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: noToolCalls,
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
    toolCalls: noToolCalls,
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
    const running: ListMessage = { ...base, toolCalls: [call] }
    const done: ListMessage = {
      ...base,
      toolCalls: [{ ...call, status: "completed", output: "ok" }],
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
      streaming={false}
      footerHeight={3}
      expanded={false}
      disclosure="collapsed"
      displayRevision={0}
      overlayOpen={false}
      renderItems={(visible) => (
        <MessageList
          items={visible}
          disclosure="collapsed"
          syntaxStyle={syntaxStyle}
          streaming={false}
        />
      )}
    >
      <box />
    </NativeTranscript>
  )
}

describe("native transcript rebuild", () => {
  it.live(
    "a message rebuilt in the other key order does not replay scrollback",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const committedText: string[] = []
        const [items, setItems] = createSignal<ListMessage[]>([
          streamedMessage("first", longBody("REBUILT-ITEM")),
          streamedMessage("second", "TAIL"),
        ])

        const setup = yield* Effect.promise(() =>
          renderWithProviders(
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
          ),
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

// ── native-transcript-commit.test ───────────────────────────────────────────

/**
 * Native history hands a completed item to scrollback and only then drops it
 * from the live view. Two things can interrupt that handover: an overlay that
 * takes the screen back while the surface settles, and a display clear that
 * lands between the settle and the commit. Both are held open here.
 */

/** Long enough that the transcriptCommit wants to move the leading item to history. */

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
      streaming={false}
      footerHeight={3}
      expanded={false}
      disclosure="collapsed"
      displayRevision={options.displayRevision()}
      overlayOpen={options.overlayOpen()}
      renderItems={(visible) => (
        <MessageList
          items={visible}
          disclosure="collapsed"
          syntaxStyle={syntaxStyle}
          streaming={false}
        />
      )}
    >
      <box />
    </NativeTranscript>
  )
}

describe("native transcript commit handover", () => {
  it.live(
    "an overlay that takes the screen mid-commit leaves the item in the live view",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const items = [assistant("first", longBody("FIRST-ITEM")), assistant("second", "TAIL")]
        const [overlayOpen, setOverlayOpen] = createSignal(false)
        const committedText: string[] = []

        const setup = yield* Effect.promise(() =>
          renderWithProviders(
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
          ),
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

  it.live(
    "a display clear cancels a commit that is still settling",
    () =>
      Effect.gen(function* () {
        const hold = yield* makeSettleHold
        const [displayRevision, setDisplayRevision] = createSignal(0)
        const committedText: string[] = []
        const items = [assistant("first", longBody("CLEARED-ITEM")), assistant("second", "TAIL")]

        const setup = yield* Effect.promise(() =>
          renderWithProviders(
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
          ),
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
  it.live(
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

        const setup = yield* Effect.promise(() =>
          renderWithProviders(
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
          ),
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
})
