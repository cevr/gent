/** @jsxImportSource @opentui/solid */
/**
 * The thread view over sessions and context windows.
 *
 * A thread is the parent walk from the shell's session; a window is what one
 * handoff marker opened on a branch. These cover the shape the pane draws and
 * the keyboard it answers to.
 */
import { describe, expect, it } from "effect-bun-test"
import { test } from "bun:test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  BranchId,
  Message,
  MessageId,
  Session,
  SessionId,
  dateFromMillis,
} from "@gent/core/protocol"
import {
  ThreadPane,
  detailFor,
  summaryBody,
  threadChain,
  threadItems,
  windowLabel,
  windowsOf,
  type ThreadWindow,
} from "../../src/extensions/builtins/thread-view.client"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

const session = (id: string, parent: Option.Option<string> = Option.none()): Session =>
  new Session({
    id: SessionId.make(id),
    name: `Session ${id}`,
    activeBranchId: BranchId.make(`${id}-branch`),
    parentSessionId: Option.getOrUndefined(Option.map(parent, (value) => SessionId.make(value))),
    createdAt: dateFromMillis(1_000),
    updatedAt: dateFromMillis(2_000),
  })

const sessionId = SessionId.make("s1")
const branchId = BranchId.make("s1-branch")

const message = (id: string, role: "user" | "assistant", text: string, at: number): Message =>
  Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId,
    branchId,
    role,
    parts: [Prompt.textPart({ text })],
    createdAt: dateFromMillis(at),
  })

const marker = (anchor: string, summary: string, count: number, at: number): Message =>
  Message.cases.regular.make({
    id: MessageId.make(`context-handoff:${branchId}:${anchor}`),
    sessionId,
    branchId,
    role: "user",
    parts: [
      Prompt.textPart({ text: `Context handoff. Ids stay durable.\n\nSummary:\n${summary}` }),
    ],
    metadata: {
      customType: "context-window",
      details: { keepFromMessageId: anchor, summarized: { count } },
    },
    createdAt: dateFromMillis(at),
  })

describe("thread chain", () => {
  test("walks parent links to the root, root first, and stops at a missing parent", () => {
    const sessions = [
      session("root"),
      session("mid", Option.some("root")),
      session("leaf", Option.some("mid")),
      session("other"),
    ]
    expect(threadChain(sessions, SessionId.make("leaf")).map((entry) => String(entry.id))).toEqual([
      "root",
      "mid",
      "leaf",
    ])
    expect(
      threadChain([session("orphan", Option.some("gone"))], SessionId.make("orphan")).map((entry) =>
        String(entry.id),
      ),
    ).toEqual(["orphan"])
  })
})

describe("windows on a branch", () => {
  test("splits the branch at every marker anchor and carries the summary that opened each window", () => {
    const messages = [
      message("u1", "user", "first ask", 1),
      message("a1", "assistant", "reply one", 2),
      message("u2", "user", "second ask", 3),
      message("a2", "assistant", "reply two", 4),
      marker("u2", "what happened before", 2, 5),
      message("u3", "user", "third ask", 6),
    ]
    const windows = windowsOf(session("s1"), branchId, messages)
    expect(
      windows.map((window) => [
        window.index,
        window.firstMessageId,
        window.lastMessageId,
        window.count,
      ]),
    ).toEqual([
      [1, "u1", "a1", 2],
      [2, "u2", "u3", 3],
    ])
    expect(Option.isNone(windows[0]?.summary ?? Option.none())).toBe(true)
    expect(windows[1]?.summary).toEqual(Option.some("what happened before"))
    expect(windows[1]?.summarizedCount).toBe(2)
    expect(windows[1]?.preview).toBe("second ask")
  })

  test("previews a window that opens mid-turn from its first spoken line", () => {
    const messages = [
      message("u1", "user", "ask", 1),
      message("a1", "assistant", "", 2),
      marker("a1", "summary", 1, 3),
      message("a2", "assistant", "I will edit the rules file.", 4),
    ]
    expect(windowsOf(session("s1"), branchId, messages).map((window) => window.preview)).toEqual([
      "ask",
      "I will edit the rules file.",
    ])
  })

  test("ignores a marker whose anchor is gone", () => {
    const messages = [message("u1", "user", "ask", 1), marker("missing", "lost", 1, 2)]
    expect(windowsOf(session("s1"), branchId, messages).length).toBe(1)
  })

  test("labels a window with its size, what it summarized, and the ask that opened it", () => {
    const window: ThreadWindow = {
      sessionId,
      branchId,
      sessionName: "Session s1",
      index: 3,
      firstMessageId: "a",
      lastMessageId: "b",
      count: 12,
      summary: Option.some("state\nmore"),
      summarizedCount: 7,
      preview: "fix the tests",
      updatedAt: 0,
    }
    expect(windowLabel(window)).toBe("window 3 · 12 messages · 7 summarized · fix the tests")
    expect(detailFor(Option.some(window))).toBe("state")
    expect(detailFor(Option.some({ ...window, summary: Option.some("## Heading\n\nbody") }))).toBe(
      "body",
    )
    expect(detailFor(Option.some({ ...window, summary: Option.none() }))).toBe("a … b")
    expect(summaryBody("no preamble")).toBe("no preamble")
  })

  test("opens a heading per session", () => {
    const base: ThreadWindow = {
      sessionId,
      branchId,
      sessionName: "Session s1",
      index: 1,
      firstMessageId: "a",
      lastMessageId: "b",
      count: 1,
      summary: Option.none(),
      summarizedCount: 0,
      preview: "",
      updatedAt: 0,
    }
    const other = { ...base, sessionId: SessionId.make("s2"), sessionName: "Session s2" }
    expect(threadItems([base, { ...base, index: 2 }, other]).map((item) => item.kind)).toEqual([
      "heading",
      "window",
      "window",
      "heading",
      "window",
    ])
  })
})

describe("thread pane", () => {
  it.live("opens on the live window, moves with the keyboard, and closes with Escape", () =>
    Effect.gen(function* () {
      const base: ThreadWindow = {
        sessionId,
        branchId,
        sessionName: "Session s1",
        index: 1,
        firstMessageId: "u1",
        lastMessageId: "a1",
        count: 2,
        summary: Option.none(),
        summarizedCount: 0,
        preview: "first ask",
        updatedAt: 0,
      }
      const second: ThreadWindow = {
        ...base,
        index: 2,
        firstMessageId: "u2",
        lastMessageId: "u3",
        count: 3,
        summary: Option.some("what happened before"),
        summarizedCount: 2,
        preview: "second ask",
      }
      let selected = Option.none<ThreadWindow>()
      const [open, setOpen] = createSignal(true)
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => (
          <ThreadPane
            open={open()}
            controller={{
              windows: () => [base, second],
              sessions: () => 1,
              current: () => Option.some({ sessionId, branchId }),
              error: () => Option.none(),
              loading: () => false,
              refresh: () => {},
              open: () => true,
              setOpen: () => {},
            }}
            onSelect={(value) => {
              selected = Option.some(value)
            }}
            onClose={() => setOpen(false)}
          />
        )),
      )

      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("2 windows"), "thread pane"),
      )
      expect(renderFrame(setup)).toContain("what happened before")
      setup.mockInput.pressArrow("up")
      yield* Effect.promise(() => setup.renderOnce())
      setup.mockInput.pressEnter()
      expect(Option.map(selected, (value) => value.index)).toEqual(Option.some(1))

      setup.mockInput.pressEscape()
      yield* Effect.promise(() => waitForRenderedFrame(setup, () => !open(), "thread pane closed"))
      expect(renderFrame(setup)).not.toContain("Thread")
    }),
  )
})
