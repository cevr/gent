import { describe, expect, test } from "effect-bun-test"
import {
  addStep,
  emptyTurnSteps,
  getSessionEventLabel,
  type SessionEvent,
} from "../src/message-list"

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
