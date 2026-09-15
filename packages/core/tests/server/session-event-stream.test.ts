/**
 * What `client.session.events` delivers around a real turn.
 *
 * `domain/event-stream-delivery.test.ts` proves the store's replay, cursor and
 * branch filter with synthetic events; `extension-commands-rpc.test.ts` proves
 * the RPC stream marks the replay-to-live move. This file covers what neither
 * can: which events a real turn leaves in the replay buffer, that the stream
 * stays live past `TurnCompleted`, and that chunks published during the
 * replay-to-live handoff are not dropped.
 */
import { describe, expect, it } from "effect-bun-test"
import type { Scope } from "effect"
import { Deferred, Effect, Option, Ref, Stream } from "effect"
import { Gent } from "@gent/sdk"
import type { EventEnvelope } from "../../src/domain/event"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { createE2ELayer } from "../../src/test-utils/e2e-layer"
import { waitFor } from "../../src/test-utils/fixtures"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"

// `retries: false` turns off the debug model's synthetic 429s, which fire on
// a hash of the user text; without it a message's own wording decides whether
// the turn retries.
const makeClient = () =>
  Gent.test(
    createE2ELayer({
      ...e2ePreset,
      providerLayer: LanguageModelLayers.debug({ retries: false }),
    }),
  )

const startCollecting = <A, E>(
  stream: Stream.Stream<A, E>,
): Effect.Effect<Ref.Ref<A[]>, E, Scope.Scope> =>
  Effect.gen(function* () {
    const values = yield* Ref.make<A[]>([])
    const ready = yield* Deferred.make<void>()
    yield* stream.pipe(
      Stream.runForEach((value) =>
        Effect.gen(function* () {
          yield* Ref.update(values, (current) => [...current, value])
          yield* Deferred.succeed(ready, void 0).pipe(Effect.ignore)
        }),
      ),
      Effect.forkScoped,
    )
    // Resolve once the first value has been written into `values`. Cap at 50ms
    // because events-after-cursor only emits when new events are appended --
    // downstream waitFor() polls absorb any remaining race.
    yield* Deferred.await(ready).pipe(Effect.timeout("50 millis"), Effect.ignore)
    return values
  })

const waitForTaggedEvent = (
  events: Ref.Ref<EventEnvelope[]>,
  tag: EventEnvelope["event"]["_tag"],
  afterId = Option.none<number>(),
) =>
  waitFor(Ref.get(events), (current) =>
    current.some(
      (envelope) =>
        envelope.event._tag === tag && (Option.isNone(afterId) || envelope.id > afterId.value),
    ),
  )

describe("session event stream", () => {
  it.live(
    "replays a completed turn's stream start, message and completion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeClient()
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "replay this turn",
          })

          yield* waitFor(client.message.list({ branchId: created.branchId }), (messages) =>
            messages.some((message) => message.role === "assistant"),
          )

          const buffered = yield* startCollecting(
            client.session.events({ sessionId: created.sessionId }),
          )
          const replayed = yield* waitForTaggedEvent(buffered, "TurnCompleted")

          expect(replayed.some((envelope) => envelope.event._tag === "StreamStarted")).toBe(true)
          expect(replayed.some((envelope) => envelope.event._tag === "MessageReceived")).toBe(true)
          expect(replayed.some((envelope) => envelope.event._tag === "TurnCompleted")).toBe(true)
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )

  it.live(
    "a live stream keeps delivering session events after a turn completes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeClient()
          const created = yield* client.session.create({ cwd: process.cwd() })

          const live = yield* startCollecting(
            client.session.events({ sessionId: created.sessionId }),
          )

          yield* client.branch.create({
            sessionId: created.sessionId,
            name: "stream-ready-branch",
          })
          const ready = yield* waitForTaggedEvent(live, "BranchCreated")
          const readyId = Option.fromNullishOr(ready[ready.length - 1]?.id)

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "finish one turn",
          })

          const firstTurn = yield* waitForTaggedEvent(live, "TurnCompleted", readyId)
          const firstTurnMaxId = Option.fromNullishOr(firstTurn[firstTurn.length - 1]?.id)

          expect(Option.isSome(firstTurnMaxId)).toBe(true)

          // This asserts stream liveness, not actor command timing. Use a
          // session event outside the turn loop to prove the stream stays alive.
          yield* client.branch.create({
            sessionId: created.sessionId,
            name: "stream-live-branch",
          })

          const combined = yield* waitFor(
            Ref.get(live),
            (current) =>
              Option.isSome(firstTurnMaxId) &&
              current.some(
                (envelope) =>
                  envelope.id > firstTurnMaxId.value && envelope.event._tag === "BranchCreated",
              ),
          )

          expect(
            combined.some(
              (envelope) =>
                Option.isSome(firstTurnMaxId) &&
                envelope.id > firstTurnMaxId.value &&
                envelope.event._tag === "BranchCreated",
            ),
          ).toBe(true)
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )

  it.live(
    "subscribing at the latest cursor replays nothing and delivers the next message live",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeClient()
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.branch.create({ sessionId: created.sessionId, name: "before-live" })

          const snapshot = yield* client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })

          const live = yield* startCollecting(
            client.session.events({
              sessionId: created.sessionId,
              branchId: created.branchId,
              after: Option.getOrUndefined(Option.fromNullishOr(snapshot.lastEventId)),
            }),
          )

          // Any events replayed in the initial window must respect the cursor.
          const initial = yield* Ref.get(live)
          const afterId = Option.getOrElse(Option.fromNullishOr(snapshot.lastEventId), () => 0)
          expect(initial.every((envelope) => envelope.id > afterId)).toBe(true)

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "after-live",
          })

          const received = yield* waitFor(
            Ref.get(live),
            (current) => current.some((envelope) => envelope.event._tag === "MessageReceived"),
            13_000,
          )

          expect(received.some((envelope) => envelope.event._tag === "MessageReceived")).toBe(true)
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )

  // The replay-to-live handoff needs StreamChunk events to be observed while
  // the turn is still in flight. The signal model gates each chunk so the test
  // releases them on demand instead of paying real wall-clock per chunk.
  it.live(
    "streamed chunks survive the replay-to-live handoff",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } =
            yield* LanguageModelLayers.signal("handoff payload.")
          const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
          const created = yield* client.session.create({ cwd: process.cwd() })

          const snapshot = yield* client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })

          const live = yield* startCollecting(
            client.session.events({
              sessionId: created.sessionId,
              branchId: created.branchId,
              after: Option.getOrUndefined(Option.fromNullishOr(snapshot.lastEventId)),
            }),
          )

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "after-live-chunks",
          })

          // Wait for the stream to start, then release the chunks.
          yield* controls.waitForStreamStart
          yield* controls.emitAll

          const received = yield* waitFor(
            Ref.get(live),
            (current) => current.some((envelope) => envelope.event._tag === "StreamChunk"),
            13_000,
          )

          expect(received.some((envelope) => envelope.event._tag === "StreamStarted")).toBe(true)
          expect(received.some((envelope) => envelope.event._tag === "StreamChunk")).toBe(true)
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )
})
