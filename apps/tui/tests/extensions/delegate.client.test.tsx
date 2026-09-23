/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Schedule, Schema } from "effect"
import { type CliRendererExternalOutputEvent, SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { BranchId, SessionId, ToolCallId } from "@gent/core/protocol"
import { CHILD_COMPLETION_TYPE } from "@gent/extensions/client"
import {
  type AssistantSegment,
  MessageList,
  NativeTranscript,
  type SessionItem,
  type ToolCall,
} from "../../src/message-list"
import type { Session } from "../../src/client"
import { useExtensionUI } from "../../src/extensions/host"
import { createMockClient, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

// ── delegate.client.test ────────────────────────────────────────────────────

/**
 * A child never blocks its parent: `delegate.start` settles at admission, and
 * the child's result arrives later as a `child-completion` message. Native
 * scrollback commits a row once, so each row draws complete from its own
 * props: the start op a static handle, the completion row the child's agent,
 * outcome, usage, and calls from the message details.
 */

const absent = Option.getOrUndefined(Option.none<string>())
const syntaxStyle = () => SyntaxStyle.create()
const parentSession: Session = {
  sessionId: SessionId.make("session-parent"),
  branchId: BranchId.make("branch-parent"),
  name: "parent",
  modelId: Option.getOrUndefined(Option.none()),
  reasoningLevel: Option.getOrUndefined(Option.none()),
}

const startOp: ToolCall = {
  id: ToolCallId.make("op-delegate"),
  toolName: "delegate.start",
  status: "completed",
  input: { todo: "review the loader" },
  summary: absent,
  output: '{"requestId":"op-delegate","sessionId":"childsess-1234","branchId":"branch-child"}',
}

const cellWith = (operations: ToolCall[]): ToolCall => ({
  id: "cell-call",
  toolName: "cell",
  status: "completed",
  input: { code: "await tools.delegate.start({ todo: 'review the loader' })" },
  summary: absent,
  output: absent,
  operations,
})

const assistant = (id: string, calls: ToolCall[], text = ""): SessionItem => {
  const segments: AssistantSegment[] = calls.map((toolCall) => ({ _tag: "tool-call", toolCall }))
  if (text.length > 0) segments.push({ _tag: "text", content: text })
  return {
    _tag: "regular-message",
    id,
    role: "assistant",
    content: text,
    reasoning: "",
    images: [],
    createdAt: 0,
    toolCalls: Option.getOrUndefined(Option.liftPredicate(calls, (list) => list.length > 0)),
    segments,
  }
}

/** The text the parent model reads; the row shows only the answer after the blank line. */
const envelope = (preview: string, status = "completed") =>
  [
    `Child agent "delegate" ${status}. requestId op-delegate; session childsess-1234; branch branch-child.`,
    "Completion is a turn receipt, not task success. Read the output before relying on it.",
    "",
    preview,
  ].join("\n")

const completion = (
  details: Schema.JsonObject,
  content = envelope("CHILD-ANSWER: the loader is fine"),
): SessionItem => ({
  _tag: "regular-message",
  id: "child-completion",
  role: "user",
  content,
  reasoning: "",
  images: [],
  createdAt: 1,
  toolCalls: Option.getOrUndefined(Option.none()),
  metadata: { customType: CHILD_COMPLETION_TYPE, details },
})

/** The details as the wire carries them. */
const fullDetails = {
  requestId: "op-delegate",
  sessionId: "childsess-1234",
  branchId: "branch-child",
  agentName: "delegate",
  outcome: {},
  usage: { input: 1200, output: 300 },
  tools: [
    { name: "read", summary: "CHILD-NOTE.md 12 lines", status: "completed" },
    { name: "bash", summary: "exit 1", status: "error" },
  ],
  toolCount: 7,
}

const renderList = (items: ReadonlyArray<SessionItem>, height = 40) =>
  Effect.promise(() =>
    renderWithProviders(
      () => (
        <MessageList
          items={[...items]}
          disclosure="full"
          syntaxStyle={syntaxStyle}
          streaming={false}
        />
      ),
      { initialSession: parentSession, width: 100, height },
    ),
  )

/** A frame once the delegate client has loaded: its start row draws only then. */
const loadedFrame = (items: ReadonlyArray<SessionItem>, height = 40) =>
  Effect.gen(function* () {
    const setup = yield* renderList([assistant("m0", [startOp]), ...items], height)
    return yield* Effect.promise(() =>
      waitForRenderedFrame(
        setup,
        (text) => text.includes("result arrives as a message"),
        "delegate client loaded",
      ),
    )
  })

describe("delegate rows in native scrollback", () => {
  it.live(
    "the child's calls reach scrollback with its completion row",
    () =>
      Effect.gen(function* () {
        const items: SessionItem[] = [
          assistant("m1", [cellWith([startOp])]),
          completion(fullDetails),
          ...Array.from({ length: 8 }, (_, i) =>
            assistant(`f${i}`, [], `filler ${i}\n\nsecond para ${i}`),
          ),
        ]
        const saved: string[] = []
        let loaded = () => false
        const setup = yield* Effect.promise(() =>
          renderWithProviders(
            () => {
              const renderer = useRenderer()
              loaded = useExtensionUI().loaded
              const capture = (event: CliRendererExternalOutputEvent) =>
                saved.push(new TextDecoder().decode(event.snapshot.getRealCharBytes(true)))
              renderer.on("external_output", capture)
              onCleanup(() => renderer.off("external_output", capture))
              return (
                <NativeTranscript
                  items={items}
                  streaming={false}
                  footerHeight={3}
                  expanded={false}
                  disclosure="full"
                  displayRevision={0}
                  overlayOpen={false}
                  renderItems={(visible) => (
                    <MessageList
                      items={visible}
                      disclosure="full"
                      syntaxStyle={syntaxStyle}
                      streaming={false}
                    />
                  )}
                >
                  <box />
                </NativeTranscript>
              )
            },
            { client: createMockClient(), initialSession: parentSession, width: 70, height: 20 },
          ),
        )
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({ until: () => loaded() }),
          Effect.timeout("5 seconds"),
        )
        // The rows commit once; nothing arrives later to redraw them. The last
        // fillers stay in the live view, so an early filler marks the commit.
        yield* Effect.promise(() => setup.flush()).pipe(
          Effect.repeat({
            until: () => saved.join("\n").includes("filler 3"),
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("5 seconds"),
        )
        const scrollback = saved.join("\n")
        expect(scrollback).toContain("review the loader")
        expect(scrollback).toContain("read CHILD-NOTE.md 12 lines")
        expect(scrollback).toContain("CHILD-ANSWER: the loader is fine")
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )
})

describe("child-completion row", () => {
  it.live("draws the agent, usage, calls, and answer, not the model's envelope", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([completion(fullDetails)])
      expect(frame).toContain("delegate completed")
      expect(frame).toContain("childses")
      expect(frame).toContain("↑1.2k ↓300")
      expect(frame).toContain("✓ read CHILD-NOTE.md 12 lines")
      expect(frame).toContain("✕ bash exit 1")
      // The row lists the last calls; the details count the rest.
      expect(frame).toContain("5 earlier calls")
      expect(frame).not.toContain("Completion is a turn receipt")
    }),
  )

  it.live("a long call summary keeps to one row", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        completion({
          ...fullDetails,
          tools: [{ name: "read", summary: `LONG-${"x".repeat(150)}-TAIL`, status: "completed" }],
          toolCount: 1,
        }),
      ])
      expect(frame).toContain("✓ read LONG-")
      expect(frame).not.toContain("-TAIL")
    }),
  )

  it.live("names how the child's turn ended badly", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        completion({ ...fullDetails, outcome: { interrupted: true } }),
      ])
      expect(frame).toContain("delegate ended (interrupted)")
    }),
  )

  /** The three ids an older completion row carries, and nothing else. */
  const oldDetails = {
    requestId: "op-delegate",
    sessionId: "childsess-1234",
    branchId: "branch-child",
  }

  it.live("a row saved before the details grew reads its status from the envelope", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([completion(oldDetails)])
      expect(frame).toContain("✓ delegate completed · childses")
      expect(frame).toContain("CHILD-ANSWER")
      expect(frame).not.toContain("Completion is a turn receipt")
    }),
  )

  it.live("an older row for an interrupted child never draws a success mark", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        completion(oldDetails, envelope("CHILD-ANSWER: partial", "ended (interrupted)")),
      ])
      expect(frame).toContain("✕ delegate ended (interrupted)")
      expect(frame).not.toContain("✓ delegate")
    }),
  )

  it.live("an older row for a failed child never draws a success mark", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        completion(oldDetails, envelope("CHILD-ANSWER: none", "ended (model stream failed)")),
      ])
      expect(frame).toContain("✕ delegate ended (model stream failed)")
    }),
  )

  it.live("an older row whose envelope does not parse draws a neutral mark", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([completion(oldDetails, "CHILD-ANSWER: bare text")])
      expect(frame).toContain("· child finished · childses")
      expect(frame).not.toContain("✓ child")
    }),
  )

  it.live("details that do not decode draw the plain row", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([completion({ unrelated: true })])
      expect(frame).toContain("Completion is a turn receipt")
    }),
  )
})

describe("delegate.start row", () => {
  it.live("draws the task and the child handle", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([])
      expect(frame).toContain("review the loader")
      expect(frame).toContain("child childses")
    }),
  )

  it.live("a cell's ops draw through the renderers registered for their tools", () =>
    Effect.gen(function* () {
      const cell = cellWith([
        startOp,
        {
          id: "cell-read-op",
          toolName: "read",
          status: "completed",
          input: { path: "/tmp/op-read.md" },
          summary: "OP-READ-SUMMARY",
          output: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))({
            content: Array.from({ length: 40 }, (_, i) => `OP-READ-LINE-${i + 1}`).join("\n"),
            lineCount: 40,
          }),
        },
        {
          id: "cell-unknown-op",
          toolName: "no_renderer_tool",
          status: "completed",
          input: {},
          summary: "UNKNOWN-OP-SUMMARY",
          output: absent,
        },
      ])
      const setup = yield* renderList([assistant("assistant-cell", [cell])], 80)
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (text) =>
            text.includes("result arrives as a message") &&
            text.includes("OP-READ-LINE-40") &&
            text.includes("UNKNOWN-OP-SUMMARY"),
          "cell ops through their renderers",
        ),
      )
      // The delegate renderer draws the start and the read renderer the file
      // body; neither op falls back to its one-line receipt. The op with no
      // renderer keeps its line.
      expect(frame).not.toContain("✓ delegate.start")
      expect(frame).not.toContain("✓ read OP-READ-SUMMARY")
      expect(frame).toContain("✓ no_renderer_tool UNKNOWN-OP-SUMMARY")
      // An op is a collapsed sub-row: it draws its own header and an excerpt,
      // never its full body, even inside the full cell body.
      expect(frame).toContain("#cell-read-op")
      expect(frame).not.toContain("OP-READ-LINE-20")
    }),
  )
})
