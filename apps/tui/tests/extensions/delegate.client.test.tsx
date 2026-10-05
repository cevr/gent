/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Schedule, Schema, Struct } from "effect"
import { type CliRendererExternalOutputEvent, SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { BranchId, SessionId, ToolCallId } from "@gent/core/protocol"
import {
  CHILD_COMPLETION_TYPE,
  CHILD_TASK_TYPE,
  childTaskText,
  DELEGATE_EXTENSION_ID,
} from "@gent/extensions/client"
import {
  type AssistantSegment,
  MessageList,
  NativeTranscript,
  type SessionItem,
  type ToolCall,
} from "../../src/message-list"
import type { Session } from "../../src/client"
import { useExtensionUI } from "../../src/extensions/host"
import { createMockClient, renderScoped } from "../render-harness-boundary"
import { untilExtensionsLoaded, waitForFrame } from "../helpers-boundary"
import { delegateSubtitle } from "../../src/extensions/delegate.client"

/**
 * A child never blocks its parent: `delegate.start` settles at admission, and
 * the child's result arrives later as a `child-completion` message. Native
 * scrollback commits a row once, so each row draws complete from its own
 * props: the start op a static handle, the completion row the child's agent,
 * outcome, usage, and calls from the message details.
 */

// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined
const syntaxStyle = () => SyntaxStyle.create()
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const parentSession: Session = {
  sessionId: SessionId.make("session-parent"),
  branchId: BranchId.make("branch-parent"),
  name: "parent",
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
  id = "child-completion",
): SessionItem => ({
  _tag: "regular-message",
  id,
  role: "user",
  content,
  reasoning: "",
  images: [],
  createdAt: 1,
  metadata: { customType: CHILD_COMPLETION_TYPE, details },
})

/** The details as the wire carries them. */
const fullDetails = {
  requestId: "op-delegate",
  sessionId: "childsess-1234",
  branchId: "branch-child",
  agentName: "delegate",
  name: "delegate: review the loader",
  outcome: {},
  usage: { input: 1200, output: 300 },
  tools: [
    { name: "read", summary: "CHILD-NOTE.md 12 lines", status: "completed" },
    { name: "bash", summary: "exit 1", status: "error" },
  ],
  toolCount: 7,
  toolCounts: [
    { name: "read", status: "completed", count: 6 },
    { name: "bash", status: "error", count: 1 },
  ],
  durationMs: 12_000,
}

const renderList = (items: ReadonlyArray<SessionItem>, height = 40) =>
  renderScoped(
    () => <MessageList items={[...items]} disclosure="full" syntaxStyle={syntaxStyle} />,
    { initialSession: parentSession, width: 100, height },
  )

/** A frame once the delegate client has loaded: its start row draws only then. */
const loadedFrame = (items: ReadonlyArray<SessionItem>, height = 40) =>
  Effect.gen(function* () {
    const setup = yield* renderList([assistant("m0", [startOp]), ...items], height)
    return yield* waitForFrame(
      setup,
      (text) => text.includes("result arrives as a message"),
      "delegate client loaded",
    )
  })

describe("delegate rows in native scrollback", () => {
  it.scopedLive(
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
        const setup = yield* renderScoped(
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
                settled
                streaming={false}
                footerHeight={3}
                paneOpen={false}
                expanded={false}
                disclosure="full"
                displayRevision={0}
                overlayOpen={false}
                renderItems={(visible) => (
                  <MessageList items={visible} disclosure="full" syntaxStyle={syntaxStyle} />
                )}
              >
                <box />
              </NativeTranscript>
            )
          },
          { client: createMockClient(), initialSession: parentSession, width: 70, height: 20 },
        )
        yield* untilExtensionsLoaded(setup, () => loaded())
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
        expect(scrollback).toContain("Read CHILD-NOTE.md 12 lines")
        expect(scrollback).toContain("CHILD-ANSWER: the loader is fine")
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )
})

describe("child-completion row", () => {
  it.scopedLive(
    "draws the child by name, its calls in run words, and its answer, not the envelope",
    () =>
      Effect.gen(function* () {
        const frame = yield* loadedFrame([completion(fullDetails)])
        // Full: the head names the child and adds its id, as a call shows its id only there.
        expect(frame).toContain("◆ delegate: review the loader · ess-1234 · Read 6 files")
        expect(frame).toContain("↑1.2k ↓300")
        expect(frame).not.toContain("completed")
        expect(frame).toContain("├ Read CHILD-NOTE.md 12 lines")
        expect(frame).toContain("└ Ran exit 1 · failed")
        // The row lists the last calls; the details count the rest.
        expect(frame).toContain("5 earlier calls")
        expect(frame).not.toContain("Completion is a turn receipt")
      }),
  )

  it.scopedLive("siblings read apart by the task each was given", () =>
    Effect.gen(function* () {
      // UUIDv7 ids of children started in the same millisecond share their head.
      const first = "01a0ce0a-b3e7-7000-8000-00000000aaaa"
      const second = "01a0ce0a-b3e7-7000-8000-00000000bbbb"
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[
              completion(
                { ...fullDetails, sessionId: first, name: "delegate: read the docs" },
                envelope("CHILD-ANSWER: a"),
                "completion-a",
              ),
              completion(
                { ...fullDetails, sessionId: second, name: "delegate: run the tests" },
                envelope("CHILD-ANSWER: b"),
                "completion-b",
              ),
            ]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
          />
        ),
        { initialSession: parentSession, width: 100, height: 20 },
      )
      const frame = yield* waitForFrame(setup, (text) => text.includes("◆"), "completion rows")
      expect(frame).toContain("◆ delegate: read the docs · Read 6 files")
      expect(frame).toContain("◆ delegate: run the tests · Read 6 files")
      // Collapsed, the name stands for the child: no id beside it.
      expect(frame).not.toContain("0000aaaa")
    }),
  )

  it.scopedLive("a long call summary keeps to one row", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        completion({
          ...fullDetails,
          tools: [{ name: "read", summary: `LONG-${"x".repeat(150)}-TAIL`, status: "completed" }],
          toolCount: 1,
        }),
      ])
      expect(frame).toContain("└ Read LONG-")
      expect(frame).not.toContain("-TAIL")
    }),
  )

  it.scopedLive("names how the child's turn ended badly", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        completion({ ...fullDetails, outcome: { interrupted: true } }),
      ])
      expect(frame).toContain("✕ delegate: review the loader")
      expect(frame).toContain("· interrupted")
      expect(frame).not.toContain("ended (")
    }),
  )

  it.scopedLive("draws the error a failed child ended on", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        completion({
          ...fullDetails,
          outcome: { streamFailed: true },
          error: "CHILD-ERROR: sign-in failed, the keychain is locked",
        }),
      ])
      expect(frame).toContain("✕ delegate: review the loader")
      expect(frame).toContain("· model stream failed")
      expect(frame).toContain("CHILD-ERROR: sign-in failed")
    }),
  )

  /** The three ids an older completion row carries, and nothing else. */
  const oldDetails = {
    requestId: "op-delegate",
    sessionId: "childsess-1234",
    branchId: "branch-child",
  }

  it.scopedLive("a row saved before the details grew reads its status from the envelope", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([completion(oldDetails)])
      // No name was written: the agent and the id stand for the child.
      expect(frame).toContain("◆ delegate · ess-1234")
      expect(frame).toContain("CHILD-ANSWER")
      expect(frame).not.toContain("completed")
      expect(frame).not.toContain("Completion is a turn receipt")
    }),
  )

  it.scopedLive("an older row for an interrupted child never draws a done mark", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        completion(oldDetails, envelope("CHILD-ANSWER: partial", "ended (interrupted)")),
      ])
      expect(frame).toContain("✕ delegate · ess-1234 · ended (interrupted)")
      expect(frame).not.toContain("◆ delegate")
    }),
  )

  it.scopedLive("an older row for a failed child never draws a done mark", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        completion(oldDetails, envelope("CHILD-ANSWER: none", "ended (model stream failed)")),
      ])
      expect(frame).toContain("✕ delegate · ess-1234 · ended (model stream failed)")
    }),
  )

  it.scopedLive("an older row whose envelope does not parse draws a neutral mark", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([completion(oldDetails, "CHILD-ANSWER: bare text")])
      expect(frame).toContain("· child · ess-1234")
      expect(frame).not.toContain("◆ child")
    }),
  )

  it.scopedLive("an older row with more calls than it kept counts them, not their kinds", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([completion(Struct.omit(fullDetails, ["toolCounts"]))])
      // Seven calls, two kept: the kinds of the kept two would undercount.
      expect(frame).toContain("◆ delegate: review the loader · ess-1234 · 7 tools")
    }),
  )

  it.scopedLive("a call's path reads against where the TUI launched, as run rows read theirs", () =>
    Effect.gen(function* () {
      const cwd = "/work"
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[
              completion({
                ...fullDetails,
                tools: [{ name: "read", summary: `${cwd}/src/loader.ts`, status: "completed" }],
                toolCount: 1,
                toolCounts: [{ name: "read", status: "completed", count: 1 }],
              }),
            ]}
            disclosure="full"
            syntaxStyle={syntaxStyle}
          />
        ),
        { initialSession: parentSession, width: 100, height: 20, cwd },
      )
      const frame = yield* waitForFrame(setup, (text) => text.includes("└ Read"), "call row")
      expect(frame).toContain("└ Read src/loader.ts")
    }),
  )

  it.scopedLive("details that do not decode draw the raw text off the reader's rail", () =>
    Effect.gen(function* () {
      const frame = (yield* loadedFrame([completion({ unrelated: true })])).replace(/ +$/gm, "")
      expect(frame).toContain("  » child completion\n")
      expect(frame).toContain("    Completion is a turn receipt")
      expect(frame).not.toContain("┃")
    }),
  )

  it.scopedLive("a child's own task draws as its parent's message, off the reader's rail", () =>
    Effect.gen(function* () {
      const task: SessionItem = {
        _tag: "regular-message",
        id: "child-task",
        role: "user",
        content: childTaskText(SessionId.make("01a0ca0cb3e7"), "Fix the csv quoting.\nThen test."),
        reasoning: "",
        images: [],
        createdAt: 1,
        metadata: { customType: CHILD_TASK_TYPE, extensionId: DELEGATE_EXTENSION_ID },
      }
      const frame = (yield* loadedFrame([task])).replace(/ +$/gm, "")
      expect(frame).toContain("  » task from parent\n")
      expect(frame).toContain("    Fix the csv quoting.\n    Then test.")
      expect(frame).not.toContain("Task from your parent session")
      expect(frame).not.toContain("┃")
    }),
  )
})

describe("child-completion row on the ctrl+o ladder", () => {
  const answer = Array.from({ length: 8 }, (_, i) => `ANSWER-LINE-${i + 1}`).join("\n")
  const ladderDetails = {
    ...fullDetails,
    name: "delegate: loader audit",
    usage: { input: 1200, output: 300, costUsd: 0.0123 },
    tools: Array.from({ length: 7 }, (_, i) => ({
      name: "read",
      summary: `file-${i + 1}.ts`,
      status: "completed",
    })),
    toolCount: 14,
    toolCounts: [
      { name: "read", status: "completed", count: 10 },
      { name: "bash", status: "completed", count: 3 },
      { name: "bash", status: "error", count: 1 },
    ],
    durationMs: 72_000,
  }
  const drawAt = (
    disclosure: "collapsed" | "preview" | "full",
    width: number,
    details: Schema.JsonObject = ladderDetails,
  ) =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[completion(details, envelope(answer))]}
            disclosure={disclosure}
            syntaxStyle={syntaxStyle}
          />
        ),
        { initialSession: parentSession, width, height: 30 },
      )
      const frame = yield* waitForFrame(
        setup,
        (text) => /[◆✕] delegate/.test(text),
        "completion row",
      )
      return frame.split("\n").map((line) => line.trimEnd())
    })
  const headOf = (frame: ReadonlyArray<string>) =>
    frame.find((line) => /^ {2}[◆✕] /.test(line)) ?? ""

  it.scopedLive(
    "collapsed is one head line: the name, its work in run words, its time and its bill",
    () =>
      Effect.gen(function* () {
        const wide = yield* drawAt("collapsed", 100)
        expect(headOf(wide)).toBe(
          "  ◆ delegate: loader audit · Read 10 files · ran 4 commands · 1 failed · 1m 12s · ↑1.2k ↓300 $0.01",
        )
        expect(wide.join("\n")).not.toContain("file-7.ts")
        expect(wide.join("\n")).not.toContain("ANSWER-LINE")
        // A child is no tool run and no reader's message: its own glyph, no rail, no state word.
        expect(wide.join("\n")).not.toContain("┃")
        expect(wide.join("\n")).not.toContain("completed")
        expect(wide.join("\n")).not.toContain("●")
      }),
  )

  it.scopedLive(
    "narrow, the work's later kinds drop, then the bill, then the time, then the work",
    () =>
      Effect.gen(function* () {
        const narrow = yield* drawAt("collapsed", 60)
        expect(headOf(narrow)).toBe("  ◆ delegate: loader audit · Read 10 files · 1 failed")
        const tight = yield* drawAt("collapsed", 40)
        expect(headOf(tight)).toBe("  ◆ delegate: loader audit")
        for (const [frame, width] of [
          [narrow, 60],
          [tight, 40],
        ] as const)
          expect(frame.every((line) => line.length <= width - 1)).toBe(true)
      }),
  )

  it.scopedLive("a failed child says how it ended, and its error is cut first", () =>
    Effect.gen(function* () {
      const failed = {
        ...ladderDetails,
        outcome: { streamFailed: true },
        error: "CHILD-ERROR: sign-in failed, the keychain is locked\nmore detail",
      }
      const wide = headOf(yield* drawAt("collapsed", 100, failed))
      expect(
        wide.startsWith("  ✕ delegate: loader audit · model stream failed · Read 10 files"),
      ).toBe(true)
      expect(wide).toContain("· CHILD-ERROR")
      expect(wide).not.toContain("more detail")
      expect(wide.length).toBeLessThanOrEqual(99)
      // The work and the bill drop before the error does.
      expect(headOf(yield* drawAt("collapsed", 60, failed))).toBe(
        "  ✕ delegate: loader audit · model stream failed · CHILD-E…",
      )
      // The way it ended never drops: the name is cut for it.
      expect(headOf(yield* drawAt("collapsed", 40, failed))).toBe(
        "  ✕ delegate: lo… · model stream failed",
      )
    }),
  )

  it.scopedLive("preview adds the last five calls as run rows and a five-line answer head", () =>
    Effect.gen(function* () {
      for (const [width, row] of [
        [100, "  └ Read file-3.ts, file-4.ts, file-5.ts, file-6.ts, file-7.ts"],
        [60, "  └ Read file-3.ts, file-4.ts, file-5.ts, file-6.ts +1"],
      ] as const) {
        const frame = yield* drawAt("preview", width)
        const start = frame.findIndex((line) => line.includes("◆ delegate"))
        expect(frame.slice(start + 1, start + 10)).toEqual([
          "  ├ … 9 earlier calls",
          row,
          "    │ ANSWER-LINE-1",
          "    │ ANSWER-LINE-2",
          "    │ ANSWER-LINE-3",
          "    │ ANSWER-LINE-4",
          "    │ ANSWER-LINE-5",
          "    │ … +3 lines (ctrl+o)",
          "",
        ])
      }
    }),
  )

  it.scopedLive("full draws a row per kept call, the child's id and the whole answer", () =>
    Effect.gen(function* () {
      const lines = yield* drawAt("full", 100)
      expect(headOf(lines).startsWith("  ◆ delegate: loader audit · ess-1234 · ")).toBe(true)
      const frame = lines.join("\n")
      expect(frame).toContain("├ … 7 earlier calls")
      expect(frame).toContain("├ Read file-1.ts")
      expect(frame).toContain("└ Read file-7.ts")
      expect(frame).toContain("ANSWER-LINE-8")
      expect(frame).not.toContain("(ctrl+o)")
    }),
  )
})

describe("delegate.start row", () => {
  it.scopedLive("draws the task and the child handle", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([])
      expect(frame).toContain("review the loader")
      expect(frame).toContain("child ess-1234")
    }),
  )

  it.scopedLive("a refused start says why in a sentence, not as the stored JSON", () =>
    Effect.gen(function* () {
      const error = "Tool 'delegate.start' failed: Child start failed: the branch is at its limit"
      const refused: ToolCall = {
        id: ToolCallId.make("op-delegate-refused"),
        toolName: "delegate.start",
        status: "error",
        input: { todo: "review the parser" },
        summary: `{"error":${encodeJsonText(error)}}`,
        output: `{\n  "error": ${encodeJsonText(error)}\n}`,
      }
      const frame = yield* loadedFrame([assistant("m-refused", [refused])])
      expect(frame).toContain("review the parser")
      expect(frame).toContain("Child start failed: the branch is at its limit")
      expect(frame).not.toContain('"error"')
    }),
  )

  it.scopedLive("a cell's ops draw through the renderers registered for their tools", () =>
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
      const frame = yield* waitForFrame(
        setup,
        (text) =>
          text.includes("result arrives as a message") &&
          text.includes("OP-READ-LINE-40") &&
          text.includes("UNKNOWN-OP-SUMMARY"),
        "cell ops through their renderers",
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

describe("delegate subtitle", () => {
  it.live("a long task is cut on a grapheme boundary, never inside an emoji", () =>
    Effect.sync(() => {
      const todo = `${"a".repeat(59)}😀 and the rest of the task`
      expect(delegateSubtitle({ todo })).toEqual(Option.some(`${"a".repeat(59)}…`))
      expect(delegateSubtitle({ todo: "short task" })).toEqual(Option.some("short task"))
    }),
  )
})
