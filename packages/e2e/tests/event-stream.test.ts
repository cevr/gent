import { describe, expect, test } from "effect-bun-test"
import { Deferred, Effect, Ref, Stream } from "effect"
import type { EventEnvelope } from "@gent/core-internal/domain/event"
import type { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import type { GentClientBundle } from "@gent/sdk"
import { toTestFailure, transportCases, waitFor } from "./transport-harness-boundary"
import { waitDeferred } from "../src/effect-test-adapters"

type EventsClient = GentClientBundle["client"]

const startCollecting = (
  client: EventsClient,
  input: { sessionId: SessionId; branchId?: BranchId; after?: number },
) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<EventEnvelope[]>([])
    const ready = yield* Deferred.make<void>()
    const fiber = yield* (
      client.session.events(input) as Stream.Stream<EventEnvelope, unknown>
    ).pipe(
      Stream.runForEach((envelope) =>
        Effect.gen(function* () {
          yield* Ref.update(events, (current) => [...current, envelope])
          yield* Deferred.succeed(ready, void 0).pipe(Effect.ignore)
        }),
      ),
      Effect.forkScoped,
    )
    yield* waitDeferred(ready).pipe(Effect.timeout("50 millis"), Effect.ignore)
    return { events, fiber }
  })

const waitForAssistantTurn = (client: EventsClient, branchId: BranchId) =>
  waitFor(
    client.message.list({ branchId }).pipe(Effect.mapError(toTestFailure)),
    (messages: ReadonlyArray<{ role: string }>) =>
      messages.some((message) => message.role === "assistant"),
  )

const waitForUserMessage = (client: EventsClient, branchId: BranchId) =>
  waitFor(
    client.message.list({ branchId }).pipe(Effect.mapError(toTestFailure)),
    (messages: ReadonlyArray<{ role: string }>) =>
      messages.some((message) => message.role === "user"),
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

describe("event stream contracts", () => {
  for (const transport of transportCases) {
    test(
      `${transport.name} replays buffered events for a completed turn`,
      () =>
        transport.run(({ client }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const created = yield* client.session
                .create({ cwd: process.cwd() })
                .pipe(Effect.mapError(toTestFailure))

              yield* client.message
                .send({
                  sessionId: created.sessionId,
                  branchId: created.branchId,
                  content: "ad",
                })
                .pipe(Effect.mapError(toTestFailure))

              yield* waitForAssistantTurn(client, created.branchId)

              const buffered = yield* startCollecting(client, {
                sessionId: created.sessionId,
              })
              const replayed = yield* waitForCompletedTurn(buffered.events)

              expect(replayed.some((envelope) => envelope.event._tag === "StreamStarted")).toBe(
                true,
              )
              expect(replayed.some((envelope) => envelope.event._tag === "MessageReceived")).toBe(
                true,
              )
              expect(replayed.some((envelope) => envelope.event._tag === "TurnCompleted")).toBe(
                true,
              )
            }),
          ),
        ),
      15_000,
    )

    test(
      `${transport.name} live stream continues after turn completion`,
      () =>
        transport.run(({ client }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const created = yield* client.session
                .create({ cwd: process.cwd() })
                .pipe(Effect.mapError(toTestFailure))

              const live = yield* startCollecting(client, {
                sessionId: created.sessionId,
              })

              yield* client.branch
                .create({ sessionId: created.sessionId, name: "stream-ready-branch" })
                .pipe(Effect.mapError(toTestFailure))
              const ready = yield* waitForTaggedEvent(live.events, "BranchCreated")
              const readyId = ready[ready.length - 1]?.id

              yield* client.message
                .send({
                  sessionId: created.sessionId,
                  branchId: created.branchId,
                  content: "be",
                })
                .pipe(Effect.mapError(toTestFailure))

              const firstTurn = yield* waitForTaggedEvent(live.events, "TurnCompleted", readyId)
              const firstTurnMaxId = firstTurn[firstTurn.length - 1]?.id

              expect(firstTurnMaxId).toBeDefined()

              // This batch asserts stream liveness, not actor command timing.
              // Use a session event outside the turn loop to prove the stream stays alive.
              yield* client.branch
                .create({ sessionId: created.sessionId, name: "stream-live-branch" })
                .pipe(Effect.mapError(toTestFailure))

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
          ),
        ),
      15_000,
    )

    test(
      `${transport.name} branch-scoped live stream excludes sibling branch messages`,
      () =>
        transport.run(({ client }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const created = yield* client.session
                .create({ cwd: process.cwd() })
                .pipe(Effect.mapError(toTestFailure))
              const sibling = yield* client.branch
                .create({ sessionId: created.sessionId, name: "stream-sibling-branch" })
                .pipe(Effect.mapError(toTestFailure))
              const snapshot = yield* client.session
                .getSnapshot({ sessionId: created.sessionId, branchId: created.branchId })
                .pipe(Effect.mapError(toTestFailure))

              const live = yield* startCollecting(client, {
                sessionId: created.sessionId,
                branchId: created.branchId,
                ...(snapshot.lastEventId !== null ? { after: snapshot.lastEventId } : {}),
              })

              yield* client.message
                .send({
                  sessionId: created.sessionId,
                  branchId: sibling.branchId,
                  content: "sibling-only",
                })
                .pipe(Effect.mapError(toTestFailure))

              yield* waitForUserMessage(client, sibling.branchId)

              const seen = yield* Ref.get(live.events)
              expect(
                seen.some(
                  (envelope) =>
                    envelope.event._tag === "MessageReceived" &&
                    envelope.event.message.branchId === sibling.branchId,
                ),
              ).toBe(false)
            }),
          ),
        ),
      15_000,
    )

    test(
      `${transport.name} honors the after cursor`,
      () =>
        transport.run(({ client }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const created = yield* client.session
                .create({ cwd: process.cwd() })
                .pipe(Effect.mapError(toTestFailure))

              const firstLive = yield* startCollecting(client, {
                sessionId: created.sessionId,
              })

              yield* client.branch
                .create({ sessionId: created.sessionId, name: "stream-after-ready" })
                .pipe(Effect.mapError(toTestFailure))
              const ready = yield* waitForTaggedEvent(firstLive.events, "BranchCreated")
              const readyId = ready[ready.length - 1]?.id

              yield* client.message
                .send({
                  sessionId: created.sessionId,
                  branchId: created.branchId,
                  content: "dg",
                })
                .pipe(Effect.mapError(toTestFailure))

              const firstTurn = yield* waitForTaggedEvent(
                firstLive.events,
                "TurnCompleted",
                readyId,
              )
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
                .pipe(Effect.mapError(toTestFailure))

              const liveOnly = yield* waitFor(Ref.get(afterEvents.events), (current) =>
                current.some((envelope) => envelope.event._tag === "BranchCreated"),
              )

              expect(liveOnly.length).toBeGreaterThan(0)
              expect(
                liveOnly.every((envelope) => afterId !== undefined && envelope.id > afterId),
              ).toBe(true)
              expect(liveOnly.some((envelope) => envelope.event._tag === "BranchCreated")).toBe(
                true,
              )
            }),
          ),
        ),
      15_000,
    )
  }
})
