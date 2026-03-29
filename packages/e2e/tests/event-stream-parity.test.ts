import { describe, expect, test } from "bun:test"
import { Effect, Ref, Stream } from "effect"
import type { EventEnvelope } from "@gent/core/domain/event"
import { transportCases, waitFor } from "./transport-harness"

// Bun does not fire request.signal abort for streaming HTTP responses,
// so server-side streaming fibers are never interrupted on client disconnect.
// This causes 100% CPU spin on the shared worker after streaming tests complete.
// Until Bun fixes this, streaming tests only run on the direct transport.
const streamingCases = transportCases.filter((c) => c.name === "direct")

const startCollecting = (
  client: {
    session: {
      events: (input: {
        sessionId: string
        branchId?: string
        after?: number
      }) => Stream.Stream<EventEnvelope, unknown>
    }
  },
  input: { sessionId: string; branchId?: string; after?: number },
) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<EventEnvelope[]>([])
    const fiber = yield* client.session.events(input).pipe(
      Stream.runForEach((envelope) => Ref.update(events, (current) => [...current, envelope])),
      Effect.forkScoped,
    )
    yield* Effect.sleep("50 millis")
    return { events, fiber }
  })

const waitForAssistantTurn = (
  client: {
    message: {
      list: (input: { branchId: string }) => Effect.Effect<readonly { role: string }[], unknown>
    }
  },
  branchId: string,
) =>
  waitFor(
    client.message.list({ branchId }).pipe(Effect.mapError((error) => new Error(String(error)))),
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
  for (const transport of streamingCases) {
    const timeoutMs = transport.name === "worker-http" ? 30_000 : 15_000

    test(
      `${transport.name} replays buffered events for a completed turn`,
      async () => {
        await transport.run(({ client }) =>
          Effect.gen(function* () {
            const created = yield* client.session
              .create({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            yield* client.message
              .send({
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
        await transport.run(({ client }) =>
          Effect.gen(function* () {
            const created = yield* client.session
              .create({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const live = yield* startCollecting(client, {
              sessionId: created.sessionId,
            })

            yield* client.branch
              .create({ sessionId: created.sessionId, name: "stream-ready-branch" })
              .pipe(Effect.mapError((error) => new Error(String(error))))
            const ready = yield* waitForTaggedEvent(live.events, "BranchCreated")
            const readyId = ready[ready.length - 1]?.id

            yield* client.message
              .send({
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
            yield* client.branch
              .create({ sessionId: created.sessionId, name: "stream-live-branch" })
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
        await transport.run(({ client }) =>
          Effect.gen(function* () {
            const created = yield* client.session
              .create({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const firstLive = yield* startCollecting(client, {
              sessionId: created.sessionId,
            })

            yield* client.branch
              .create({ sessionId: created.sessionId, name: "stream-after-ready" })
              .pipe(Effect.mapError((error) => new Error(String(error))))
            const ready = yield* waitForTaggedEvent(firstLive.events, "BranchCreated")
            const readyId = ready[ready.length - 1]?.id

            yield* client.message
              .send({
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

            const initialAfterEvents = yield* Ref.get(afterEvents.events)
            expect(
              initialAfterEvents.every(
                (envelope) => afterId !== undefined && envelope.id > afterId,
              ),
            ).toBe(true)

            yield* client.branch
              .create({ sessionId: created.sessionId, name: "stream-after-branch" })
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
