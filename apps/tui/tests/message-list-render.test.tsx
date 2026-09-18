/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Schema } from "effect"
import { Show, createSignal, onCleanup } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { DisclosureLevel } from "../src/routes/session-ui-state"
import { NativeTranscript } from "../src/components/native-transcript"
import {
  MessageList,
  type Message,
  type SessionItem,
  type ToolCall,
} from "../src/components/message-list"
import { ToolCallIdentityProvider, ToolFrame } from "../src/ui"
import { EditToolRenderer, ReadToolRenderer } from "../src/tool-renderers"
import { renderFrame, renderWithProviders } from "./render-harness-boundary"
import { waitForRenderedFrame } from "./helpers-boundary"
import { useExtensionUI } from "../src/extensions/context"
import { SyntaxStyle, type CliRendererExternalOutputEvent } from "@opentui/core"

const absent = Option.getOrUndefined(Option.none())
const syntaxStyle = () => SyntaxStyle.create()

const userMessage = (
  tag: "regular-message" | "interjection-message",
  id: string,
  content: string,
  pendingMode: "queued" | "steer",
  images: ReadonlyArray<{ mediaType: string }> = [],
): Message => {
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
const assistantToolMessage = (id: string, toolCall: ToolCall): Message => ({
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

const unknownFailureMessage = (id: string): Message =>
  assistantToolMessage("assistant-unknown-tool", {
    id,
    toolName: "unknown_fx_tool",
    status: "error",
    input: absent,
    summary: "tool failed",
    output: absent,
  })

const registeredFailureMessage = (id: string): Message =>
  assistantToolMessage("assistant-registered-tool", {
    id,
    toolName: "read",
    status: "error",
    input: { path: "/tmp/failure.txt" },
    summary: "read failed",
    output: absent,
  })

const cellMessage = (id: string, display = "hello from a.txt"): Message =>
  assistantToolMessage("assistant-cell", {
    id,
    toolName: "cell",
    status: "completed",
    input: { code: "const note = await tools.call('read', {path: 'a.txt'})\nnote.content" },
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

const bashMessage = (id: string, lines: number): Message =>
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

const compactionMessage = (): Message => ({
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
  const extensionUI = useExtensionUI()
  return (
    <Show when={!extensionUI.loading()} fallback={<text>loading renderers</text>}>
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

describe("FX transcript treatment", () => {
  it.live("shows information excluded from model context in the transcript", () =>
    Effect.gen(function* () {
      const message: Message = {
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
        const answer: Message = {
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

  it.live("goal continuations collapse to one line until full detail is on", () =>
    Effect.gen(function* () {
      const goalMessage: Message = {
        ...userMessage(
          "regular-message",
          "goal-1",
          "Continue working toward the active goal.",
          "queued",
        ),
        pendingMode: absent,
        metadata: { customType: "goal-context", extensionId: "@gent/goal" },
      }
      const collapsed = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessageList
            items={[goalMessage]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
            streaming={false}
          />
        )),
      )
      const collapsedFrame = renderFrame(collapsed)
      expect(collapsedFrame).toContain("goal continuation")
      expect(collapsedFrame).not.toContain("Continue working")
      const expanded = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessageList
            items={[goalMessage]}
            disclosure="collapsed"
            fullDetail={true}
            syntaxStyle={syntaxStyle}
            streaming={false}
          />
        )),
      )
      expect(renderFrame(expanded)).toContain("Continue working")
    }),
  )

  it.live("a fired alarm collapses to its note until full detail is on", () =>
    Effect.gen(function* () {
      const wakeMessage: Message = {
        ...userMessage(
          "regular-message",
          "wake-1",
          "Alarm w1 fired at 2026-09-15T05:51:35.262Z. Run bun test and report.",
          "queued",
        ),
        pendingMode: absent,
        metadata: {
          customType: "wake",
          extensionId: "@gent/wake",
          details: { outcome: "fired", note: "Run bun test and report." },
        },
      }
      const collapsed = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessageList
            items={[wakeMessage]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
            streaming={false}
          />
        )),
      )
      const collapsedFrame = renderFrame(collapsed)
      expect(collapsedFrame).toContain("alarm fired · Run bun test and report.")
      expect(collapsedFrame).not.toContain("fired at 2026")
      const expanded = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <MessageList
            items={[wakeMessage]}
            disclosure="collapsed"
            fullDetail={true}
            syntaxStyle={syntaxStyle}
            streaming={false}
          />
        )),
      )
      expect(renderFrame(expanded)).toContain("fired at 2026")
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
        input: { code: "await tools.call('ask_user', {})" },
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
      const message: Message = assistantToolMessage("assistant-cell", recovered)
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
            const extensionUI = useExtensionUI()
            return (
              <Show when={!extensionUI.loading()}>
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
