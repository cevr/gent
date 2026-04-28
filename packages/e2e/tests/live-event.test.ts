import { describe, expect, test } from "bun:test"
import type { Scope } from "effect"
import { Deferred, Effect, Ref, Stream } from "effect"
import { directSignalCase, transportCases, waitFor } from "./transport-harness"
import { waitDeferred } from "../src/effect-test-adapters"

const collectLiveEvents = <A, E>(
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
    // because events-after-cursor only emits when new events are appended —
    // downstream waitFor() polls absorb any remaining race.
    yield* waitDeferred(ready).pipe(Effect.timeout("50 millis"), Effect.ignore)
    return values
  })

describe("live event contracts", () => {
  for (const transport of transportCases) {
    const timeoutMs = transport.name === "worker-http" ? 30_000 : 15_000

    test(
      `${transport.name} streamEvents with latest cursor behaves as future-only live stream`,
      () =>
        transport.run(({ client }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const created = yield* client.session
                .create({ cwd: process.cwd() })
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
          ),
        ),
      timeoutMs,
    )
  }

  // The replay-to-live handoff test needs StreamChunk events to be observed.
  // Signal provider gates each chunk so we can release them on demand without
  // paying real wall-clock per chunk. Direct-only: the worker subprocess
  // cannot share the in-memory controls handle with the test process.
  const timeoutMs = 15_000
  test(
    `${directSignalCase.name} streamEvents keeps streamed chunks across replay-to-live handoff`,
    () =>
      directSignalCase.run("handoff payload.", ({ client }, controls) =>
        Effect.scoped(
          Effect.gen(function* () {
            const created = yield* client.session
              .create({ cwd: process.cwd() })
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

            // Wait for the stream to start, then release the chunks
            yield* controls.waitForStreamStart
            yield* controls.emitAll()

            const received = yield* waitFor(
              Ref.get(liveEvents),
              (current) => current.some((envelope) => envelope.event._tag === "StreamChunk"),
              timeoutMs,
            )

            expect(received.some((envelope) => envelope.event._tag === "StreamStarted")).toBe(true)
            expect(received.some((envelope) => envelope.event._tag === "StreamChunk")).toBe(true)
          }),
        ),
      ),
    timeoutMs,
  )
})
