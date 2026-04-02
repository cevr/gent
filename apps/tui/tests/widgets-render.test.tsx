/** @jsxImportSource @opentui/solid */

import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { SyntaxStyle } from "@opentui/core"
import type { QueueEntryInfo } from "@gent/sdk"
import { MessageList, type Message, type SessionItem } from "../src/components/message-list"
import { ConnectionWidget } from "../src/components/connection-widget"
import { QueueWidget } from "../src/components/queue-widget"
import { TaskWidget } from "../src/components/task-widget"
import { renderFrame, renderWithProviders } from "./render-harness"

const syntaxStyle = () => SyntaxStyle.create()

describe("TUI renderer surfaces", () => {
  test("MessageList renders user labels and assistant reasoning", async () => {
    const items: SessionItem[] = [
      {
        _tag: "message",
        id: "user-1",
        role: "user",
        kind: "interjection",
        pendingMode: "steer",
        content: "Stop and switch agent",
        reasoning: "",
        images: [],
        createdAt: Date.now(),
        toolCalls: undefined,
      } satisfies Message,
      {
        _tag: "message",
        id: "assistant-1",
        role: "assistant",
        kind: "regular",
        content: "Switching now",
        reasoning: "Considering current task state",
        images: [],
        createdAt: Date.now(),
        toolCalls: undefined,
      } satisfies Message,
    ]

    const setup = await renderWithProviders(() => (
      <MessageList
        items={items}
        toolsExpanded={false}
        syntaxStyle={syntaxStyle}
        streaming={false}
      />
    ))
    await setup.renderOnce()

    const frame = renderFrame(setup)
    expect(frame).toContain("[steer]")
    expect(frame).toContain("Stop and switch agent")
    expect(frame).toContain("Considering current task state")
  })

  test("QueueWidget renders steer and queued summaries", async () => {
    const steerMessages: QueueEntryInfo[] = [
      {
        id: "m1",
        kind: "steering",
        content: "switch to deepwork",
        createdAt: Date.now(),
      },
    ]
    const queuedMessages: QueueEntryInfo[] = [
      {
        id: "m2",
        kind: "follow-up",
        content: "line one\nline two\nline three",
        createdAt: Date.now(),
      },
    ]

    const setup = await renderWithProviders(() => (
      <QueueWidget queuedMessages={queuedMessages} steerMessages={steerMessages} />
    ))

    const frame = renderFrame(setup)
    expect(frame).toContain("queue")
    expect(frame).toContain("[steer 1] switch to deepwork")
    expect(frame).toContain("[queued 1] line one +2 lines")
    expect(frame).toContain("cmd+up restore")
  })

  test("TaskWidget preview renders summary and overflow", async () => {
    const setup = await renderWithProviders(() => (
      <TaskWidget
        previewTasks={[
          { subject: "Resolve transport DTOs", status: "completed" },
          { subject: "Add renderer coverage", status: "in_progress" },
          { subject: "Clean debug boot", status: "pending" },
          { subject: "Document final architecture", status: "failed" },
          { subject: "Overflow 1", status: "pending" },
          { subject: "Overflow 2", status: "pending" },
          { subject: "Overflow 3", status: "pending" },
          { subject: "Overflow 4", status: "pending" },
          { subject: "Overflow 5", status: "pending" },
          { subject: "Overflow 6", status: "pending" },
          { subject: "Overflow 7", status: "pending" },
        ]}
      />
    ))

    const frame = renderFrame(setup)
    expect(frame).toContain("tasks")
    expect(frame).toContain("11 tasks")
    expect(frame).toContain("Resolve transport DTOs")
    expect(frame).toContain("Add renderer coverage")
    expect(frame).toContain("+1 more")
  })

  test("ConnectionWidget renders nothing when no connection issue", async () => {
    // ConnectionWidget now self-sources from useClient() — no props.
    // Default mock client has no connection issues, so widget renders nothing.
    const setup = await renderWithProviders(() => <ConnectionWidget />)

    const frame = renderFrame(setup)
    expect(frame).not.toContain("connection")
  })
})

describe("uiModel schema validation", () => {
  const PlanUiModel = Schema.Struct({
    mode: Schema.Literals(["normal", "plan", "executing"]),
    steps: Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        text: Schema.String,
        status: Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]),
      }),
    ),
    progress: Schema.Struct({
      total: Schema.Number,
      completed: Schema.Number,
      inProgress: Schema.Number,
    }),
  })
  const decode = Schema.decodeUnknownOption(PlanUiModel)

  test("valid plan snapshot decodes correctly", () => {
    const valid = {
      mode: "plan",
      steps: [{ id: 1, text: "Do thing", status: "pending" }],
      progress: { total: 1, completed: 0, inProgress: 0 },
    }
    const result = decode(valid)
    expect(result._tag).toBe("Some")
  })

  test("all step statuses decode correctly", () => {
    const valid = {
      mode: "executing",
      steps: [
        { id: 1, text: "A", status: "completed" },
        { id: 2, text: "B", status: "in_progress" },
        { id: 3, text: "C", status: "failed" },
        { id: 4, text: "D", status: "stopped" },
        { id: 5, text: "E", status: "pending" },
      ],
      progress: { total: 5, completed: 1, inProgress: 1 },
    }
    const result = decode(valid)
    expect(result._tag).toBe("Some")
  })

  test("malformed snapshot decodes to None (not crash)", () => {
    const malformed = { mode: "invalid-mode", steps: "not-an-array" }
    const result = decode(malformed)
    expect(result._tag).toBe("None")
  })

  test("missing fields decode to None", () => {
    const partial = { mode: "plan" }
    const result = decode(partial)
    expect(result._tag).toBe("None")
  })

  test("null snapshot decodes to None", () => {
    const result = decode(null)
    expect(result._tag).toBe("None")
  })
})
