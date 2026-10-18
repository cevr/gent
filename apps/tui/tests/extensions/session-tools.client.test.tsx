/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Schedule, Schema } from "effect"
import { type CliRendererExternalOutputEvent, SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { BranchId, SessionId, ToolCallId } from "@gent/core/protocol"
import {
  SESSION_TOOLS_EXTENSION_ID,
  THREAD_ROUND_END_TYPE,
  THREAD_ROUND_TYPE,
  threadRoundText,
} from "@gent/extensions/client"
import {
  AssistantSegment,
  MessageList,
  NativeTranscript,
  type SessionItem,
  type ToolCall,
  Message,
} from "../../src/message-list"
import type { Session } from "../../src/client"
import { useExtensionUI } from "../../src/extensions/host"
import { createMockClient, renderFrame, renderScoped } from "../render-harness-boundary"
import { untilExtensionsLoaded, waitForFrame } from "../helpers-boundary"
import { threadStartSubtitle } from "../../src/extensions/session-tools.client"
import { useTheme } from "../../src/theme"

/**
 * A thread never blocks its starter: `thread.start` settles at admission,
 * and with `notify: "starter"` a round's answer arrives later as a
 * `thread-round-end` message. Native scrollback commits a row once, so each
 * row draws complete from its own props: the start op a static handle, the
 * round-end row the thread's name, outcome, usage, and calls from the
 * message details.
 */

// eslint-disable-next-line effect/noNullish -- a wire field the server leaves unset is present and undefined.
const absent = undefined
const syntaxStyle = () => SyntaxStyle.create()
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const starterSession: Session = {
  sessionId: SessionId.make("session-starter"),
  branchId: BranchId.make("branch-starter"),
  name: "starter",
}

const startOp: ToolCall = {
  id: ToolCallId.make("op-thread"),
  toolName: "thread.start",
  status: "completed",
  input: { task: "review the loader", agent: "delegate", notify: "starter" },
  summary: absent,
  output:
    '{"thread":"childsess-1234","sessionId":"childsess-1234","branchId":"branch-child","round":{"round":"round-1","number":1}}',
}

const cellWith = (operations: ToolCall[]): ToolCall => ({
  id: "cell-call",
  toolName: "cell",
  status: "completed",
  input: {
    code: "await tools.thread.start({ task: 'review the loader', agent: 'delegate', notify: 'starter' })",
  },
  summary: absent,
  output: absent,
  operations,
})

const assistant = (id: string, calls: ToolCall[], text = ""): SessionItem => {
  const segments: AssistantSegment[] = calls.map((toolCall) =>
    AssistantSegment.cases["tool-call"].make({ toolCall }),
  )
  if (text.length > 0) segments.push(AssistantSegment.cases.text.make({ content: text }))
  return Message.cases["regular-message"].make({
    id,
    role: "assistant",
    content: text,
    reasoning: "",
    images: [],
    createdAt: 0,
    segments,
  })
}

/** The text the starter's model reads; the row shows only the answer between the header and the closing note. */
const roundEndText = (answer: string, outcome = "completed") =>
  [
    `Thread "review the loader" (agent delegate) round 1 ${outcome}. Thread childsess-1234; round round-1; session childsess-1234; branch branch-child.`,
    "A round's end is a turn receipt, not task success. Read the answer before relying on it.",
    "",
    answer,
    "",
    'thread.round({ round: "round-1" }) returns its whole text and reply.',
  ].join("\n")

const roundEnd = (
  details: Schema.JsonObject,
  content = roundEndText("THREAD-ANSWER: the loader is fine"),
  id = "round-end",
): SessionItem =>
  Message.cases["regular-message"].make({
    id,
    role: "user",
    content,
    reasoning: "",
    images: [],
    createdAt: 1,
    metadata: { customType: THREAD_ROUND_END_TYPE, details },
  })

/** The details as the wire carries them. */
const fullDetails = {
  round: "round-1",
  thread: "childsess-1234",
  number: 1,
  sessionId: "childsess-1234",
  branchId: "branch-child",
  agentName: "delegate",
  name: "review the loader",
  interrupted: false,
  streamFailed: false,
  unanswered: false,
  usage: { input: 1200, output: 300 },
  tools: [
    { name: "read", summary: "THREAD-NOTE.md 12 lines", status: "completed" },
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
    { initialSession: starterSession, width: 100, height },
  )

/** A frame once the session-tools client has loaded: its start row draws only then. */
const loadedFrame = (items: ReadonlyArray<SessionItem>, height = 40) =>
  Effect.gen(function* () {
    const setup = yield* renderList([assistant("m0", [startOp]), ...items], height)
    return yield* waitForFrame(
      setup,
      (text) => text.includes("result arrives as a message"),
      "session-tools client loaded",
    )
  })

describe("thread rows in native scrollback", () => {
  it.scopedLive(
    "a thread's calls reach scrollback with its round-end row",
    () =>
      Effect.gen(function* () {
        const items: SessionItem[] = [
          assistant("m1", [cellWith([startOp])]),
          roundEnd(fullDetails),
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
          { client: createMockClient(), initialSession: starterSession, width: 70, height: 20 },
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
        expect(scrollback).toContain("Read THREAD-NOTE.md 12 lines")
        expect(scrollback).toContain("THREAD-ANSWER: the loader is fine")
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )
})

describe("round-end row", () => {
  it.scopedLive(
    "the round-end row heads with the thread's name and outcome, and draws its last calls",
    () =>
      Effect.gen(function* () {
        const frame = yield* loadedFrame([roundEnd(fullDetails)])
        // Full: the head names the thread and adds its id, as a call shows its id only there.
        expect(frame).toContain("◆ review the loader · ess-1234 · completed · Read 6 files")
        expect(frame).toContain("↑1.2k ↓300")
        expect(frame).toContain("├ Read THREAD-NOTE.md 12 lines")
        expect(frame).toContain("└ Ran exit 1 · failed")
        // The row lists the last calls; the details count the rest.
        expect(frame).toContain("5 earlier calls")
        // The answer, without the header and the closing note the model reads.
        expect(frame).toContain("THREAD-ANSWER: the loader is fine")
        expect(frame).not.toContain("a turn receipt")
        expect(frame).not.toContain("returns its whole text")
      }),
  )

  it.scopedLive("sibling threads read apart by the task each was given", () =>
    Effect.gen(function* () {
      // UUIDv7 ids of threads started in the same millisecond share their head.
      const first = "01a0ce0a-b3e7-7000-8000-00000000aaaa"
      const second = "01a0ce0a-b3e7-7000-8000-00000000bbbb"
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[
              roundEnd(
                { ...fullDetails, sessionId: first, name: "read the docs" },
                roundEndText("THREAD-ANSWER: a"),
                "round-end-a",
              ),
              roundEnd(
                { ...fullDetails, sessionId: second, name: "run the tests" },
                roundEndText("THREAD-ANSWER: b"),
                "round-end-b",
              ),
            ]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
          />
        ),
        { initialSession: starterSession, width: 100, height: 20 },
      )
      const frame = yield* waitForFrame(setup, (text) => text.includes("◆"), "round-end rows")
      expect(frame).toContain("◆ read the docs · completed · Read 6 files")
      expect(frame).toContain("◆ run the tests · completed · Read 6 files")
      // Collapsed, the name stands for the thread: no id beside it.
      expect(frame).not.toContain("0000aaaa")
    }),
  )

  it.scopedLive("a long call summary keeps to one row", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        roundEnd({
          ...fullDetails,
          tools: [{ name: "read", summary: `LONG-${"x".repeat(150)}-TAIL`, status: "completed" }],
          toolCount: 1,
          toolCounts: [{ name: "read", status: "completed", count: 1 }],
        }),
      ])
      expect(frame).toContain("└ Read LONG-")
      expect(frame).not.toContain("-TAIL")
    }),
  )

  it.scopedLive("names how the round's turn ended badly", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        roundEnd(
          { ...fullDetails, interrupted: true },
          roundEndText("THREAD-ANSWER: partial", "ended (interrupted)"),
        ),
      ])
      expect(frame).toContain("✕ review the loader · ess-1234 · interrupted")
      expect(frame).not.toContain("ended (")
      expect(frame).not.toContain("◆ review the loader")
    }),
  )

  it.scopedLive("draws the error a failed round ended on", () =>
    Effect.gen(function* () {
      const frame = yield* loadedFrame([
        roundEnd({
          ...fullDetails,
          streamFailed: true,
          error: "THREAD-ERROR: sign-in failed, the keychain is locked",
        }),
      ])
      expect(frame).toContain("✕ review the loader")
      expect(frame).toContain("· model stream failed")
      expect(frame).toContain("THREAD-ERROR: sign-in failed")
    }),
  )

  it.scopedLive("a thread with no session name is named by its agent and its id", () =>
    Effect.gen(function* () {
      const { name: _name, ...unnamed } = fullDetails
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[roundEnd(unnamed)]}
            disclosure="collapsed"
            syntaxStyle={syntaxStyle}
          />
        ),
        { initialSession: starterSession, width: 100, height: 20 },
      )
      const frame = yield* waitForFrame(setup, (text) => text.includes("◆"), "round-end row")
      expect(frame).toContain("◆ delegate · ess-1234 · completed")
    }),
  )

  it.scopedLive("a call's path reads against where the TUI launched, as run rows read theirs", () =>
    Effect.gen(function* () {
      const cwd = "/work"
      const setup = yield* renderScoped(
        () => (
          <MessageList
            items={[
              roundEnd({
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
        { initialSession: starterSession, width: 100, height: 20, cwd },
      )
      const frame = yield* waitForFrame(setup, (text) => text.includes("└ Read"), "call row")
      expect(frame).toContain("└ Read src/loader.ts")
    }),
  )

  it.scopedLive(
    "round-end details that do not decode draw the raw text off the reader's rail",
    () =>
      Effect.gen(function* () {
        const frame = (yield* loadedFrame([roundEnd({ unrelated: true })])).replace(/ +$/gm, "")
        expect(frame).toContain("  » round end\n")
        expect(frame).toContain("    A round's end is a turn receipt")
        expect(frame).not.toContain("┃")
      }),
  )

  it.scopedLive("a thread's round draws as its starter's message, off the reader's rail", () =>
    Effect.gen(function* () {
      const task: SessionItem = Message.cases["regular-message"].make({
        id: "thread-round",
        role: "user",
        content: threadRoundText({
          number: 1,
          starter: SessionId.make("01a0ca0cb3e7"),
          message: "Fix the csv quoting.\nThen test.",
          reply: Option.none(),
          notify: "starter",
          place: Option.none(),
        }),
        reasoning: "",
        images: [],
        createdAt: 1,
        metadata: { customType: THREAD_ROUND_TYPE, extensionId: SESSION_TOOLS_EXTENSION_ID },
      })
      const frame = (yield* loadedFrame([task])).replace(/ +$/gm, "")
      expect(frame).toContain("  » task from session\n")
      expect(frame).toContain("    Fix the csv quoting.\n    Then test.")
      expect(frame).not.toContain("Round 1 from session")
      expect(frame).not.toContain("┃")
    }),
  )
})

describe("round-end row on the ctrl+o ladder", () => {
  const answer = Array.from({ length: 8 }, (_, i) => `ANSWER-LINE-${i + 1}`).join("\n")
  const ladderDetails = {
    ...fullDetails,
    name: "loader audit",
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
            items={[roundEnd(details, roundEndText(answer))]}
            disclosure={disclosure}
            syntaxStyle={syntaxStyle}
          />
        ),
        { initialSession: starterSession, width, height: 30 },
      )
      const frame = yield* waitForFrame(setup, (text) => /[◆✕] lo/.test(text), "round-end row")
      return frame.split("\n").map((line) => line.trimEnd())
    })
  const headOf = (frame: ReadonlyArray<string>) =>
    frame.find((line) => /^ {2}[◆✕] /.test(line)) ?? ""

  it.scopedLive(
    "collapsed is one head line: the name, how it ended, its work in run words, its time and its bill",
    () =>
      Effect.gen(function* () {
        const wide = yield* drawAt("collapsed", 110)
        expect(headOf(wide)).toBe(
          "  ◆ loader audit · completed · Read 10 files · ran 4 commands · 1 failed · 1m 12s · ↑1.2k ↓300 $0.01",
        )
        expect(wide.join("\n")).not.toContain("file-7.ts")
        expect(wide.join("\n")).not.toContain("ANSWER-LINE")
        // A thread is no tool run and no reader's message: its own glyph, no rail.
        expect(wide.join("\n")).not.toContain("┃")
        expect(wide.join("\n")).not.toContain("●")
      }),
  )

  it.scopedLive(
    "narrow, the work's later kinds drop, then the bill, then the time, then the work",
    () =>
      Effect.gen(function* () {
        const narrow = yield* drawAt("collapsed", 60)
        expect(headOf(narrow)).toBe("  ◆ loader audit · completed · Read 10 files · 1 failed")
        const tight = yield* drawAt("collapsed", 40)
        expect(headOf(tight)).toBe("  ◆ loader audit · completed")
        for (const [frame, width] of [
          [narrow, 60],
          [tight, 40],
        ] as const)
          expect(frame.every((line) => line.length <= width - 1)).toBe(true)
      }),
  )

  it.scopedLive("a failed round says how it ended, and its error is cut first", () =>
    Effect.gen(function* () {
      const failed = {
        ...ladderDetails,
        streamFailed: true,
        error: "THREAD-ERROR: sign-in failed, the keychain is locked\nmore detail",
      }
      const wide = headOf(yield* drawAt("collapsed", 120, failed))
      expect(wide.startsWith("  ✕ loader audit · model stream failed · Read 10 files")).toBe(true)
      expect(wide).toContain("· ↑1.2k ↓300 $0.01 · THREA")
      expect(wide).not.toContain("more detail")
      expect(wide.length).toBeLessThanOrEqual(119)
      // Narrower, the bill drops before the error's first columns do.
      expect(headOf(yield* drawAt("collapsed", 100, failed))).toBe(
        "  ✕ loader audit · model stream failed · Read 10 files · ran 4 commands · 1 failed · 1m 12s · THRE…",
      )
      // The work and the bill drop before the error does.
      expect(headOf(yield* drawAt("collapsed", 60, failed))).toBe(
        "  ✕ loader audit · model stream failed · THREAD-ERROR: sig…",
      )
      // The way it ended never drops: the name is cut for it.
      expect(headOf(yield* drawAt("collapsed", 30, failed))).toBe("  ✕ lo… · model stream failed")
    }),
  )

  // Codex draws an agent's nickname in its accent: the name takes the names'
  // colour, a round that ended badly its `✕` in the error colour, and its work
  // draws as a run header does, `1 failed` in the error colour; the rest muted.
  for (const width of [100, 60, 40]) {
    it.scopedLive(
      `the head colours the thread's name, a bad end's mark and its failures at ${width} columns`,
      () =>
        Effect.gen(function* () {
          const failed = { ...ladderDetails, streamFailed: true }
          for (const details of [ladderDetails, failed]) {
            let colors = Option.none<ReturnType<typeof useTheme>["theme"]>()
            const setup = yield* renderScoped(
              () => {
                colors = Option.some(useTheme().theme)
                return (
                  <MessageList
                    items={[roundEnd(details, roundEndText(answer))]}
                    disclosure="collapsed"
                    syntaxStyle={syntaxStyle}
                  />
                )
              },
              { initialSession: starterSession, width, height: 30 },
            )
            yield* waitForFrame(setup, (text) => /[◆✕] lo/.test(text), "round-end row")
            const theme = Option.getOrThrow(colors)
            const colored = setup
              .captureSpans()
              .lines.flatMap((line) => line.spans.filter((span) => span.text.trim().length > 0))
              .filter((span) => !span.fg.equals(theme.textMuted))
            const name = colored.find((span) => span.fg.equals(theme.info))
            expect(name?.text.startsWith("lo")).toBe(true)
            const showsFailures = renderFrame(setup).includes("· 1 failed")
            const expected: Array<string> = []
            if (details === failed) expected.push("✕")
            expected.push(name?.text.trim() ?? "")
            if (showsFailures) expected.push("1 failed")
            expect(colored.map((span) => span.text.trim())).toEqual(expected)
            for (const span of colored.filter((span) => span !== name))
              expect(span.fg.equals(theme.error)).toBe(true)
            // Wide, the work holds the failure; narrow, it may drop with the work.
            if (width === 100) expect(showsFailures).toBe(true)
          }
        }),
    )
  }

  it.scopedLive("preview adds the last five calls as run rows and a five-line answer head", () =>
    Effect.gen(function* () {
      for (const [width, row] of [
        [100, "  └ Read file-3.ts, file-4.ts, file-5.ts, file-6.ts, file-7.ts"],
        [60, "  └ Read file-3.ts, file-4.ts, file-5.ts, file-6.ts +1"],
      ] as const) {
        const frame = yield* drawAt("preview", width)
        const start = frame.findIndex((line) => line.includes("◆ loader audit"))
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

  it.scopedLive("full draws a row per kept call, the thread's id and the whole answer", () =>
    Effect.gen(function* () {
      const lines = yield* drawAt("full", 100)
      expect(headOf(lines).startsWith("  ◆ loader audit · ess-1234 · completed · ")).toBe(true)
      const frame = lines.join("\n")
      expect(frame).toContain("├ … 7 earlier calls")
      expect(frame).toContain("├ Read file-1.ts")
      expect(frame).toContain("└ Read file-7.ts")
      expect(frame).toContain("ANSWER-LINE-8")
      expect(frame).not.toContain("(ctrl+o)")
      expect(frame).not.toContain("returns its whole text")
    }),
  )
})

describe("thread.start row", () => {
  it.scopedLive(
    "draws the task and the thread handle, and says the result arrives as a message",
    () =>
      Effect.gen(function* () {
        const frame = yield* loadedFrame([])
        expect(frame).toContain("review the loader")
        expect(frame).toContain("thread ess-1234 · result arrives as a message")
      }),
  )

  it.scopedLive("a start whose replies go to the user says they stay in the thread", () =>
    Effect.gen(function* () {
      const side: ToolCall = {
        ...startOp,
        id: ToolCallId.make("op-thread-side"),
        input: { task: "tidy the changelog", name: "changelog" },
      }
      const frame = yield* loadedFrame([assistant("m-side", [side])])
      expect(frame).toContain("changelog · tidy the changelog")
      expect(frame).toContain("thread ess-1234 · replies stay in the thread")
    }),
  )

  it.scopedLive("a refused start says why in a sentence, not as the stored JSON", () =>
    Effect.gen(function* () {
      const error =
        "Tool 'thread.start' failed: Cannot start the thread: This session's thread already runs 4 threads"
      const refused: ToolCall = {
        id: ToolCallId.make("op-thread-refused"),
        toolName: "thread.start",
        status: "error",
        input: { task: "review the parser", agent: "delegate", notify: "starter" },
        summary: `{"error":${encodeJsonText(error)}}`,
        output: `{\n  "error": ${encodeJsonText(error)}\n}`,
      }
      const frame = yield* loadedFrame([assistant("m-refused", [refused])])
      expect(frame).toContain("review the parser")
      expect(frame).toContain("Cannot start the thread: This session's thread already runs 4")
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
      // The session-tools renderer draws the start and the read renderer the
      // file body; neither op falls back to its one-line receipt. The op with
      // no renderer keeps its line.
      expect(frame).not.toContain("✓ thread.start")
      expect(frame).not.toContain("✓ read OP-READ-SUMMARY")
      expect(frame).toContain("✓ no_renderer_tool UNKNOWN-OP-SUMMARY")
      // An op is a collapsed sub-row: it draws its own header and an excerpt,
      // never its full body, even inside the full cell body.
      expect(frame).toContain("#cell-read-op")
      expect(frame).not.toContain("OP-READ-LINE-20")
    }),
  )
})

describe("thread.start subtitle", () => {
  it.live("a long task is cut on a grapheme boundary, never inside an emoji", () =>
    Effect.sync(() => {
      const task = `${"a".repeat(59)}😀 and the rest of the task`
      expect(threadStartSubtitle({ task })).toEqual(Option.some(`${"a".repeat(59)}…`))
      expect(threadStartSubtitle({ task: "short task" })).toEqual(Option.some("short task"))
    }),
  )

  it.live("a start's own name leads the task", () =>
    Effect.sync(() => {
      expect(
        threadStartSubtitle({ task: "check the greeting files", name: "greeting audit" }),
      ).toEqual(Option.some("greeting audit · check the greeting files"))
      // A worker started with no task shows its name.
      expect(threadStartSubtitle({ name: "implementor" })).toEqual(Option.some("implementor"))
    }),
  )
})
