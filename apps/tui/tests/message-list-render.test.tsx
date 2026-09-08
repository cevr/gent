/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Schema } from "effect"
import { Show } from "solid-js"
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

const cellMessage = (id: string): Message => ({
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
        display: "hello from a.txt",
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

function RegisteredToolMessageLists(props: { items: SessionItem[]; fullDetail?: boolean }) {
  const extensionUI = useExtensionUI()
  return (
    <Show when={!extensionUI.loading()} fallback={<text>loading renderers</text>}>
      <MessageList
        items={props.items}
        toolsExpanded={false}
        syntaxStyle={syntaxStyle}
        streaming={false}
      />
      <MessageList items={props.items} toolsExpanded syntaxStyle={syntaxStyle} streaming={false} />
      <Show when={props.fullDetail}>
        <MessageList
          items={props.items}
          toolsExpanded
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
            toolsExpanded={false}
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
              toolsExpanded={false}
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
            toolsExpanded={false}
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
              toolsExpanded={false}
              syntaxStyle={syntaxStyle}
              streaming={false}
            />
            <MessageList items={items} toolsExpanded syntaxStyle={syntaxStyle} streaming={false} />
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
})
