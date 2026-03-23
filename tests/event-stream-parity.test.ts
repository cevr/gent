import { describe, expect, test } from "bun:test"
import { Effect, Ref, Stream } from "effect"
import type { EventEnvelope } from "@gent/core/domain/event"
import { transportCases, waitFor } from "./transport-harness"

const startCollecting = (
  client: {
    subscribeEvents: (input: {
      sessionId: string
      branchId?: string
      after?: number
    }) => Stream.Stream<EventEnvelope, unknown>
  },
  input: { sessionId: string; branchId?: string; after?: number },
) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<EventEnvelope[]>([])
    const fiber = yield* client.subscribeEvents(input).pipe(
      Stream.runForEach((envelope) => Ref.update(events, (current) => [...current, envelope])),
      Effect.forkScoped,
    )
    yield* Effect.sleep("50 millis")
    return { events, fiber }
  })

const waitForAssistantTurn = (
  client: {
    listMessages: (branchId: string) => Effect.Effect<readonly { role: string }[], unknown>
  },
  branchId: string,
) =>
  waitFor(
    client.listMessages(branchId).pipe(Effect.mapError((error) => new Error(String(error)))),
    (messages) => messages.some((message) => message.role === "assistant"),
  )

const waitForCompletedTurn = (events: Ref.Ref<EventEnvelope[]>) =>
  waitFor(Ref.get(events), (current) =>
    current.some((envelope) => envelope.event._tag === "TurnCompleted"),
  )

const waitForTaggedEvent = (
  events: Ref.Ref<EventEnvelope[]>,
  tag: EventEnvelope["event"]["_tag"],
  afterId?: number,
) =>
  waitFor(Ref.get(events), (current) =>
    current.some(
      (envelope) => envelope.event._tag === tag && (afterId === undefined || envelope.id > afterId),
    ),
  )

describe("event stream parity", () => {
  for (const transport of transportCases) {
    const timeoutMs = transport.name === "worker-http" ? 30_000 : 15_000

    test(
      `${transport.name} replays buffered events for a completed turn`,
      async () => {
        await transport.run((client) =>
          Effect.gen(function* () {
            const created = yield* client
              .createSession({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            yield* client
              .sendMessage({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: "ad",
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            yield* waitForAssistantTurn(client, created.branchId)

            const buffered = yield* startCollecting(client, {
              sessionId: created.sessionId,
            })
            const replayed = yield* waitForCompletedTurn(buffered.events)

            expect(replayed.some((envelope) => envelope.event._tag === "StreamStarted")).toBe(true)
            expect(replayed.some((envelope) => envelope.event._tag === "MessageReceived")).toBe(
              true,
            )
            expect(replayed.some((envelope) => envelope.event._tag === "TurnCompleted")).toBe(true)
          }),
        )
      },
      timeoutMs,
    )

    test(
      `${transport.name} live stream continues after turn completion`,
      async () => {
        await transport.run((client) =>
          Effect.gen(function* () {
            const created = yield* client
              .createSession({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const live = yield* startCollecting(client, {
              sessionId: created.sessionId,
            })

            yield* client
              .createBranch(created.sessionId, "stream-ready-branch")
              .pipe(Effect.mapError((error) => new Error(String(error))))
            const ready = yield* waitForTaggedEvent(live.events, "BranchCreated")
            const readyId = ready[ready.length - 1]?.id

            yield* client
              .sendMessage({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: "be",
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const firstTurn = yield* waitForTaggedEvent(live.events, "TurnCompleted", readyId)
            const firstTurnMaxId = firstTurn[firstTurn.length - 1]?.id

            expect(firstTurnMaxId).toBeDefined()

            // Batch 2 is stream parity, not actor command timing.
            // Use a session event outside the turn loop to prove the stream stays alive.
            yield* client
              .createBranch(created.sessionId, "stream-live-branch")
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const combined = yield* waitFor(
              Ref.get(live.events),
              (current) =>
                firstTurnMaxId !== undefined &&
                current.some(
                  (envelope) =>
                    envelope.id > firstTurnMaxId && envelope.event._tag === "BranchCreated",
                ),
            )

            expect(
              combined.some(
                (envelope) =>
                  firstTurnMaxId !== undefined &&
                  envelope.id > firstTurnMaxId &&
                  envelope.event._tag === "BranchCreated",
              ),
            ).toBe(true)
          }),
        )
      },
      timeoutMs,
    )

    test(
      `${transport.name} honors the after cursor`,
      async () => {
        await transport.run((client) =>
          Effect.gen(function* () {
            const created = yield* client
              .createSession({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const firstLive = yield* startCollecting(client, {
              sessionId: created.sessionId,
            })

            yield* client
              .createBranch(created.sessionId, "stream-after-ready")
              .pipe(Effect.mapError((error) => new Error(String(error))))
            const ready = yield* waitForTaggedEvent(firstLive.events, "BranchCreated")
            const readyId = ready[ready.length - 1]?.id

            yield* client
              .sendMessage({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: "dg",
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const firstTurn = yield* waitForTaggedEvent(firstLive.events, "TurnCompleted", readyId)
            const afterId = firstTurn[firstTurn.length - 1]?.id

            expect(afterId).toBeDefined()

            const afterEvents = yield* startCollecting(client, {
              sessionId: created.sessionId,
              ...(afterId !== undefined ? { after: afterId } : {}),
            })

            expect(yield* Ref.get(afterEvents.events)).toEqual([])

            yield* client
              .createBranch(created.sessionId, "stream-after-branch")
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const liveOnly = yield* waitFor(Ref.get(afterEvents.events), (current) =>
              current.some((envelope) => envelope.event._tag === "BranchCreated"),
            )

            expect(liveOnly.length).toBeGreaterThan(0)
            expect(
              liveOnly.every((envelope) => afterId !== undefined && envelope.id > afterId),
            ).toBe(true)
            expect(liveOnly.some((envelope) => envelope.event._tag === "BranchCreated")).toBe(true)
          }),
        )
      },
      timeoutMs,
    )
  }
})
