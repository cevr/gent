import { describe, expect, test } from "bun:test"
import { Effect, Ref, Stream } from "effect"
import { slowTransportCases, transportCases, waitFor } from "./transport-harness"

// See event-stream-parity.test.ts for why streaming tests are direct-only.
const streamingCases = transportCases.filter((c) => c.name === "direct")
const slowStreamingCases = slowTransportCases.filter((c) => c.name === "direct")

const collectLiveEvents = <A, E>(
  stream: Stream.Stream<A, E>,
): Effect.Effect<Ref.Ref<A[]>, E, never> =>
  Effect.gen(function* () {
    const values = yield* Ref.make<A[]>([])
    yield* stream.pipe(
      Stream.runForEach((value) => Ref.update(values, (current) => [...current, value])),
      Effect.forkScoped,
    )
    yield* Effect.sleep("50 millis")
    return values
  })

describe("live event parity", () => {
  for (const transport of streamingCases) {
    const timeoutMs = 15_000

    test(
      `${transport.name} streamEvents with latest cursor behaves as future-only live stream`,
      async () => {
        await transport.run(({ client }) =>
          Effect.gen(function* () {
            const created = yield* client.session
              .create({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            yield* client.branch
              .create({ sessionId: created.sessionId, name: "before-live" })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const snapshot = yield* client.session
              .getSnapshot({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const liveEvents = yield* collectLiveEvents(
              client.session.events({
                sessionId: created.sessionId,
                branchId: created.branchId,
                after: snapshot.lastEventId ?? undefined,
              }),
            ).pipe(Effect.mapError((error) => new Error(String(error))))

            // Any events replayed in the initial window must respect the cursor
            const initial = yield* Ref.get(liveEvents)
            const afterId = snapshot.lastEventId ?? 0
            expect(initial.every((env) => env.id > afterId)).toBe(true)

            yield* client.message
              .send({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: "after-live",
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const received = yield* waitFor(
              Ref.get(liveEvents),
              (current) => current.some((envelope) => envelope.event._tag === "MessageReceived"),
              timeoutMs,
            )

            expect(received.some((envelope) => envelope.event._tag === "MessageReceived")).toBe(
              true,
            )
          }),
        )
      },
      timeoutMs,
    )
  }

  for (const transport of slowStreamingCases) {
    const timeoutMs = 15_000

    test(
      `${transport.name} streamEvents keeps streamed chunks across replay-to-live handoff`,
      async () => {
        await transport.run(({ client }) =>
          Effect.gen(function* () {
            const created = yield* client.session
              .create({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const snapshot = yield* client.session
              .getSnapshot({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const liveEvents = yield* collectLiveEvents(
              client.session.events({
                sessionId: created.sessionId,
                branchId: created.branchId,
                after: snapshot.lastEventId ?? undefined,
              }),
            ).pipe(Effect.mapError((error) => new Error(String(error))))

            yield* client.message
              .send({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: "after-live-chunks",
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const received = yield* waitFor(
              Ref.get(liveEvents),
              (current) => current.some((envelope) => envelope.event._tag === "StreamChunk"),
              timeoutMs,
            )

            expect(received.some((envelope) => envelope.event._tag === "StreamStarted")).toBe(true)
            expect(received.some((envelope) => envelope.event._tag === "StreamChunk")).toBe(true)
          }),
        )
      },
      timeoutMs,
    )
  }
})
