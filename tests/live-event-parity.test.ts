import { describe, expect, test } from "bun:test"
import { Effect, Ref, Stream } from "effect"
import { transportCases, waitFor } from "./transport-harness"

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
  for (const transport of transportCases) {
    const timeoutMs = transport.name === "worker-http" ? 30_000 : 15_000

    test(
      `${transport.name} subscribeLiveEvents does not replay buffered history`,
      async () => {
        await transport.run((client) =>
          Effect.gen(function* () {
            const created = yield* client
              .createSession({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            yield* client
              .createBranch(created.sessionId, "before-live")
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const liveEvents = yield* collectLiveEvents(
              client.subscribeLiveEvents({
                sessionId: created.sessionId,
              }),
            ).pipe(Effect.mapError((error) => new Error(String(error))))

            const initial = yield* Ref.get(liveEvents)
            expect(initial).toEqual([])

            yield* client
              .createBranch(created.sessionId, "after-live")
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const received = yield* waitFor(
              Ref.get(liveEvents),
              (current) => current.some((envelope) => envelope.event._tag === "BranchCreated"),
              timeoutMs,
            )

            expect(received.some((envelope) => envelope.event._tag === "BranchCreated")).toBe(true)
          }),
        )
      },
      timeoutMs,
    )
  }
})
