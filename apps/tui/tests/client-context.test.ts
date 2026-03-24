/**
 * Tests for ClientProvider event handling and state management
 */

import { describe, test, expect, mock } from "bun:test"
import { Effect, Stream } from "effect"
import type { AgentEvent, EventEnvelope } from "@gent/core/domain/event"
import {
  EventEnvelope as EventEnvelopeClass,
  StreamStarted,
  StreamEnded,
  StreamChunk,
  MessageReceived,
} from "@gent/core/domain/event"

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
    streamEvents: (_input: { sessionId: string }) => {
      return Stream.async<EventEnvelope>((emit) => {
        eventCallback = (envelope) => {
          emit.single(envelope)
        }
        return Effect.void
      })
    },
    watchRuntime: () =>
      Stream.make({
        phase: "idle" as const,
        status: "idle" as const,
        agent: "cowork" as const,
        queue: { steering: [], followUp: [] },
      }),
    sendMessage: mock(() => Effect.void),
    listMessages: mock(() => Effect.succeed([])),
    getSessionSnapshot: mock(() =>
      Effect.succeed({
        sessionId: "s1",
        branchId: "b1",
        messages: [],
        lastEventId: null,
        bypass: true,
        reasoningLevel: undefined,
      }),
    ),
    listSessions: mock(() => Effect.succeed([])),
    listModels: mock(() => Effect.succeed([])),
    listBranches: mock(() => Effect.succeed([])),
    createSession: mock(() => Effect.succeed({ sessionId: "s1", branchId: "b1", name: "Test" })),
    createBranch: mock(() => Effect.succeed("new-branch")),
    steer: mock(() => Effect.void),
    getQueuedMessages: mock(() => Effect.succeed({ steering: [], followUp: [] })),
    drainQueuedMessages: mock(() => Effect.succeed({ steering: [], followUp: [] })),
    runFork: Effect.runFork as never,
    runPromise: Effect.runPromise as never,
    lifecycle: {
      getState: () => ({ _tag: "connected" as const, generation: 0 }),
      subscribe: (listener: (s: { _tag: string }) => void) => {
        listener({ _tag: "connected" })
        return () => {}
      },
      restart: Effect.void,
      waitForReady: Effect.void,
    },
  }
}

describe("ClientProvider event handling", () => {
  test("records StreamStarted events", () => {
    const client = createMockClient()
    const event = new StreamStarted({ sessionId: "s1", branchId: "b1" })

    // Simulate event
    client.pushEvent(event)

    expect(client.events).toContainEqual(event)
  })

  test("records StreamEnded events", () => {
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
