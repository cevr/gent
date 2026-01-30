/**
 * Tests for ClientProvider event handling and state management
 */

import { describe, test, expect, mock } from "bun:test"
import { Effect, Stream, Runtime } from "effect"
import type { AgentEvent, EventEnvelope } from "@gent/core"
import {
  EventEnvelope as EventEnvelopeClass,
  StreamStarted,
  StreamEnded,
  StreamChunk,
  MessageReceived,
} from "@gent/core"

// Mock client for testing
function createMockClient() {
  const events: AgentEvent[] = []
  let eventCallback: ((event: EventEnvelope) => void) | null = null
  let nextId = 0

  return {
    events,
    pushEvent: (event: AgentEvent) => {
      events.push(event)
      if (eventCallback) {
        nextId += 1
        eventCallback(
          new EventEnvelopeClass({
            id: nextId as EventEnvelope["id"],
            event,
            createdAt: Date.now(),
          }),
        )
      }
    },
    subscribeEvents: (_input: { sessionId: string }) => {
      return Stream.async<EventEnvelope>((emit) => {
        eventCallback = (envelope) => {
          emit.single(envelope)
        }
        return Effect.void
      })
    },
    sendMessage: mock(() => Effect.void),
    listMessages: mock(() => Effect.succeed([])),
    getSessionState: mock(() =>
      Effect.succeed({
        sessionId: "s1",
        branchId: "b1",
        messages: [],
        lastEventId: null,
        isStreaming: false,
        agent: "cowork" as const,
      }),
    ),
    listSessions: mock(() => Effect.succeed([])),
    listModels: mock(() => Effect.succeed([])),
    listBranches: mock(() => Effect.succeed([])),
    createSession: mock(() => Effect.succeed({ sessionId: "s1", branchId: "b1", name: "Test" })),
    createBranch: mock(() => Effect.succeed("new-branch")),
    steer: mock(() => Effect.void),
    runtime: Runtime.defaultRuntime,
  }
}

describe("ClientProvider event handling", () => {
  test("StreamStarted sets status to streaming", () => {
    const client = createMockClient()
    const event = new StreamStarted({ sessionId: "s1", branchId: "b1" })

    // Simulate event
    client.pushEvent(event)

    expect(client.events).toContainEqual(event)
  })

  test("StreamEnded sets status to idle", () => {
    const client = createMockClient()
    const event = new StreamEnded({ sessionId: "s1", branchId: "b1" })

    client.pushEvent(event)

    expect(client.events).toContainEqual(event)
  })

  test("StreamChunk event is emitted", () => {
    const client = createMockClient()
    const event = new StreamChunk({
      sessionId: "s1",
      branchId: "b1",
      chunk: "Hello",
    })

    client.pushEvent(event)

    expect(client.events).toContainEqual(event)
  })

  test("MessageReceived event is emitted", () => {
    const client = createMockClient()
    const event = new MessageReceived({
      sessionId: "s1",
      branchId: "b1",
      messageId: "m1",
      role: "assistant",
    })

    client.pushEvent(event)

    expect(client.events).toContainEqual(event)
  })

  test("multiple events in sequence", () => {
    const client = createMockClient()

    const events: AgentEvent[] = [
      new StreamStarted({ sessionId: "s1", branchId: "b1" }),
      new StreamChunk({ sessionId: "s1", branchId: "b1", chunk: "Hello " }),
      new StreamChunk({ sessionId: "s1", branchId: "b1", chunk: "world" }),
      new StreamEnded({ sessionId: "s1", branchId: "b1" }),
    ]

    for (const event of events) {
      client.pushEvent(event)
    }

    expect(client.events.length).toBe(4)
    expect(client.events[0]?._tag).toBe("StreamStarted")
    expect(client.events[3]?._tag).toBe("StreamEnded")
  })
})

describe("event listener management", () => {
  test("listeners receive events", async () => {
    const received: AgentEvent[] = []
    const listeners = new Set<(event: AgentEvent) => void>()

    // Add listener
    const listener = (event: AgentEvent) => received.push(event)
    listeners.add(listener)

    // Emit event
    const event = new StreamStarted({ sessionId: "s1", branchId: "b1" })
    for (const l of listeners) {
      l(event)
    }

    expect(received.length).toBe(1)
    expect(received[0]?._tag).toBe("StreamStarted")
  })

  test("removed listeners don't receive events", async () => {
    const received: AgentEvent[] = []
    const listeners = new Set<(event: AgentEvent) => void>()

    const listener = (event: AgentEvent) => received.push(event)
    listeners.add(listener)
    listeners.delete(listener)

    const event = new StreamStarted({ sessionId: "s1", branchId: "b1" })
    for (const l of listeners) {
      l(event)
    }

    expect(received.length).toBe(0)
  })

  test("multiple listeners receive same event", async () => {
    const received1: AgentEvent[] = []
    const received2: AgentEvent[] = []
    const listeners = new Set<(event: AgentEvent) => void>()

    listeners.add((event) => received1.push(event))
    listeners.add((event) => received2.push(event))

    const event = new StreamChunk({
      sessionId: "s1",
      branchId: "b1",
      chunk: "test",
    })
    for (const l of listeners) {
      l(event)
    }

    expect(received1.length).toBe(1)
    expect(received2.length).toBe(1)
    expect(received1[0]).toBe(received2[0])
  })
})
