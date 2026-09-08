/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Schema } from "effect"
import { Show, createSignal } from "solid-js"
import type { DisclosureLevel } from "../src/routes/session-ui-state"
import { MessageList, type Message, type SessionItem } from "../src/components/message-list"
import { ToolCallIdentityProvider, ToolFrame } from "../src/components/tool-frame"
import { renderFrame, renderWithProviders } from "./render-harness-boundary"
import { waitForRenderedFrame } from "./helpers-boundary"
import { useExtensionUI } from "../src/extensions/context"
import { SyntaxStyle } from "@opentui/core"

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

const unknownFailureMessage = (id: string): Message => ({
  _tag: "regular-message",
  id: "assistant-unknown-tool",
  role: "assistant",
  content: "",
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: [
    {
      id,
      toolName: "unknown_fx_tool",
      status: "error",
      input: absent,
      summary: "tool failed",
      output: absent,
    },
  ],
})

const registeredFailureMessage = (id: string): Message => ({
  _tag: "regular-message",
  id: "assistant-registered-tool",
  role: "assistant",
  content: "",
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: [
    {
      id,
      toolName: "read",
      status: "error",
      input: { path: "/tmp/failure.txt" },
      summary: "read failed",
      output: absent,
    },
  ],
})

const cellMessage = (id: string, display = "hello from a.txt"): Message => ({
  _tag: "regular-message",
  id: "assistant-cell",
  role: "assistant",
  content: "",
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: [
    {
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
    },
  ],
})

const bashMessage = (id: string, lines: number): Message => ({
  _tag: "regular-message",
  id: "assistant-bash",
  role: "assistant",
  content: "",
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: [
    {
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
    },
  ],
})

const compactionMessage = (): Message => ({
  _tag: "regular-message",
  id: "model-compaction:b1:r2",
  role: "assistant",
  content: "Historical context summary: the user renamed the loader.",
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: absent,
  metadata: {
    customType: "model-compaction",
    details: { sourceMessageIds: ["m1", "m2", "m3"], sourceRevision: "r1" },
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
      const message: Message = {
        ...cellMessage("call-recovered"),
        toolCalls: [
          {
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
          },
        ],
      }
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
      expect(frame).toContain("└ bash seq 25 · ↓25")
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
      expect(row).toContain("↑2 ↓25")
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

  it.live("a compaction record folds to one line until the full level opens it", () =>
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
            </>
          ),
          { width: 100, height: 20 },
        ),
      )
      const frame = renderFrame(setup)
      expect(frame.match(/⇣ Compacted 3 messages into ~14 tokens/g)?.length).toBe(2)
      expect(frame.match(/renamed the loader/g)?.length).toBe(1)
    }),
  )
})
