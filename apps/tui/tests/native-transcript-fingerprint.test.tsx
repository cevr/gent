/** @jsxImportSource @opentui/solid */
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
import { describe, expect, it } from "effect-bun-test"
import { test } from "bun:test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { SyntaxStyle } from "@opentui/core"
import type { CliRenderer, CliRendererExternalOutputEvent } from "@opentui/core"
import {
  type Message,
  MessageList,
  NativeTranscript,
  type SessionItem,
  type ToolCall,
  transcriptFingerprint,
} from "../src/message-list"
import { renderWithProviders } from "./render-harness-boundary"
import { makeSettleHold } from "./scrollback-hold-boundary"

const absent = Option.getOrUndefined(Option.none())
const noToolCalls = Option.getOrUndefined(Option.none<ToolCall[]>())
const syntaxStyle = () => SyntaxStyle.create()

/** The streaming path writes `_tag` first and carries no metadata. */
const streamedMessage = (id: string, content: string): Message => ({
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
const rebuiltMessage = (id: string, content: string): Message => {
  const body: Omit<Message, "_tag"> = {
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
    const running: Message = { ...base, toolCalls: [call] }
    const done: Message = { ...base, toolCalls: [{ ...call, status: "completed", output: "ok" }] }
    expect(transcriptFingerprint(running)).not.toBe(transcriptFingerprint(done))
  })

  test("a session event agrees across key orders", () => {
    const first: SessionItem = { _tag: "interruption", createdAt: 5, seq: 2 }
    const second: SessionItem = { createdAt: 5, seq: 2, _tag: "interruption" }
    expect(transcriptFingerprint(first)).toBe(transcriptFingerprint(second))
  })
})

const transcript = (options: {
  readonly items: () => Message[]
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
        const [items, setItems] = createSignal<Message[]>([
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
