import { describe, expect, test } from "bun:test"
import { Effect, Ref, Stream } from "effect"
import { extractText } from "@gent/sdk"
import { slowTransportCases, transportCases, waitFor } from "./transport-harness"

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

describe("watched state parity", () => {
  for (const transport of transportCases) {
    const timeoutMs = transport.name === "worker-http" ? 30_000 : 15_000

    test(
      `${transport.name} watchSessionState emits current snapshot and later updates`,
      async () => {
        await transport.run((client) =>
          Effect.gen(function* () {
            const created = yield* client
              .createSession({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const states = yield* collectSnapshots(
              client.watchSessionState({
                sessionId: created.sessionId,
                branchId: created.branchId,
              }),
            ).pipe(Effect.mapError((error) => new Error(String(error))))

            const initial = yield* waitFor(
              Ref.get(states),
              (current) => current.length > 0,
              timeoutMs,
            )
            expect(initial[0]?.messages).toEqual([])

            yield* client
              .sendMessage({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: `watch-state ${transport.name}`,
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const updated = yield* waitFor(
              Ref.get(states),
              (current) =>
                current.some((state) =>
                  state.messages.some(
                    (message) =>
                      message.role === "user" &&
                      extractText(message.parts) === `watch-state ${transport.name}`,
                  ),
                ),
              timeoutMs,
            )

            expect(
              updated.some((state) =>
                state.messages.some(
                  (message) =>
                    message.role === "user" &&
                    extractText(message.parts) === `watch-state ${transport.name}`,
                ),
              ),
            ).toBe(true)
          }),
        )
      },
      timeoutMs,
    )
  }

  for (const transport of slowTransportCases) {
    const timeoutMs = transport.name === "worker-http" ? 30_000 : 20_000

    test(
      `${transport.name} watchQueue emits current queue snapshots`,
      async () => {
        await transport.run((client) =>
          Effect.gen(function* () {
            const created = yield* client
              .createSession({ cwd: process.cwd(), bypass: true })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const queues = yield* collectSnapshots(
              client.watchQueue({
                sessionId: created.sessionId,
                branchId: created.branchId,
              }),
            ).pipe(Effect.mapError((error) => new Error(String(error))))

            yield* client
              .sendMessage({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: "first turn",
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            yield* waitFor(
              client
                .getSessionState({
                  sessionId: created.sessionId,
                  branchId: created.branchId,
                })
                .pipe(Effect.mapError((error) => new Error(String(error)))),
              (state) => state.isStreaming,
              timeoutMs,
            )

            yield* client
              .sendMessage({
                sessionId: created.sessionId,
                branchId: created.branchId,
                content: "queued follow-up",
              })
              .pipe(Effect.mapError((error) => new Error(String(error))))

            const updated = yield* waitFor(
              Ref.get(queues),
              (current) =>
                current.some((snapshot) =>
                  snapshot.followUp.some((entry) => entry.content.includes("queued follow-up")),
                ),
              timeoutMs,
            )

            expect(
              updated.some((snapshot) =>
                snapshot.followUp.some((entry) => entry.content.includes("queued follow-up")),
              ),
            ).toBe(true)
          }),
        )
      },
      timeoutMs,
    )
  }
})
