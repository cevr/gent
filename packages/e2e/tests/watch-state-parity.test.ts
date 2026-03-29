import { describe, expect, test } from "bun:test"
import { Effect, Ref, Stream } from "effect"
import { extractText } from "@gent/sdk"
import { slowTransportCases, transportCases, waitFor } from "./transport-harness"

// See event-stream-parity.test.ts for why streaming tests are direct-only.
const streamingCases = transportCases.filter((c) => c.name === "direct")
const slowStreamingCases = slowTransportCases.filter((c) => c.name === "direct")

const collectSnapshots = <A, E>(
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

describe("runtime watch parity", () => {
  for (const transport of streamingCases) {
    const timeoutMs = 15_000

    test(
      `${transport.name} watchRuntime emits current runtime and later updates`,
      async () => {
        await transport.run(({ client }) =>
          Effect.gen(function* () {
            const created = yield* client.session
              .create({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const runtime = yield* collectSnapshots(
              client.session.watchRuntime({
                sessionId: created.sessionId,
                branchId: created.branchId,
              }),
            ).pipe(Effect.mapError((error) => new Error(String(error))))

            const initial = yield* Ref.get(runtime)
            expect(initial[0]?.status).toBe("idle")
            expect(initial[0]?.queue.followUp).toEqual([])
            expect(initial[0]?.queue.steering).toEqual([])

            yield* client.message
              .send({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: `watch-runtime ${transport.name}`,
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const updated = yield* waitFor(
              Ref.get(runtime),
              (current) => current.some((state) => state.status !== "idle"),
              timeoutMs,
            )

            expect(updated.some((state) => state.status !== "idle")).toBe(true)

            const persisted = yield* waitFor(
              client.session
                .getSnapshot({
                  sessionId: created.sessionId,
                  branchId: created.branchId,
                })
                .pipe(Effect.mapError((error) => new Error(String(error)))),
              (snapshot) =>
                snapshot.messages.some(
                  (message) =>
                    message.role === "user" &&
                    extractText(message.parts) === `watch-runtime ${transport.name}`,
                ),
              timeoutMs,
            )

            expect(
              persisted.messages.some(
                (message) =>
                  message.role === "user" &&
                  extractText(message.parts) === `watch-runtime ${transport.name}`,
              ),
            ).toBe(true)
          }),
        )
      },
      timeoutMs,
    )
  }

  for (const transport of slowStreamingCases) {
    const timeoutMs = 20_000

    test(
      `${transport.name} watchRuntime emits queued follow-up snapshots`,
      async () => {
        await transport.run(({ client }) =>
          Effect.gen(function* () {
            const created = yield* client.session
              .create({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const runtime = yield* collectSnapshots(
              client.session.watchRuntime({
                sessionId: created.sessionId,
                branchId: created.branchId,
              }),
            ).pipe(Effect.mapError((error) => new Error(String(error))))

            yield* client.message
              .send({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: "first turn",
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            yield* waitFor(
              Ref.get(runtime),
              (current) => current.some((state) => state.status !== "idle"),
              timeoutMs,
            )

            yield* client.message
              .send({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: "queued follow-up",
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const updated = yield* waitFor(
              Ref.get(runtime),
              (current) =>
                current.some((state) =>
                  state.queue.followUp.some((entry) => entry.content.includes("queued follow-up")),
                ),
              timeoutMs,
            )

            expect(
              updated.some((state) =>
                state.queue.followUp.some((entry) => entry.content.includes("queued follow-up")),
              ),
            ).toBe(true)
          }),
        )
      },
      timeoutMs,
    )
  }
})
