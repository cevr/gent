import { describe, expect, test } from "bun:test"
import type { Scope } from "effect"
import { Deferred, Effect, Ref, Stream } from "effect"
import { extractText } from "@gent/sdk"
import { directSignalCase, transportCases, waitFor } from "./transport-harness"
import { waitDeferred } from "../src/effect-test-adapters"

const collectSnapshots = <A, E>(
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
    // Resolve once the first value has been written into `values`.
    // watchRuntime emits the current snapshot on subscribe, so this typically
    // resolves in <1ms. Cap at 50ms as a safety net.
    yield* waitDeferred(ready).pipe(Effect.timeout("50 millis"), Effect.ignore)
    return values
  })

describe("runtime watch contracts", () => {
  for (const transport of transportCases) {
    const timeoutMs = transport.name === "worker-http" ? 30_000 : 15_000

    test(
      `${transport.name} watchRuntime emits current runtime and later updates`,
      () =>
        transport.run(({ client }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const created = yield* client.session
                .create({ cwd: process.cwd() })
                .pipe(Effect.mapError((error) => new Error(String(error))))

              const runtime = yield* collectSnapshots(
                client.session.watchRuntime({
                  sessionId: created.sessionId,
                  branchId: created.branchId,
                }),
              ).pipe(Effect.mapError((error) => new Error(String(error))))

              const initial = yield* waitFor(
                Ref.get(runtime),
                (current) => current[0]?._tag === "Idle",
                timeoutMs,
              )
              expect(initial[0]?._tag).toBe("Idle")
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
                (current) => current.some((state) => state._tag !== "Idle"),
                timeoutMs,
              )

              expect(updated.some((state) => state._tag !== "Idle")).toBe(true)

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
          ),
        ),
      timeoutMs,
    )
  }

  // The queued-follow-up snapshot test needs the first turn to still be in
  // flight when the second message arrives. Signal provider keeps the stream
  // paused on the chunk gate without paying real wall-clock per chunk.
  // Direct-only: the worker subprocess cannot share the in-memory controls
  // handle with the test process.
  const timeoutMs = 20_000
  test(
    `${directSignalCase.name} watchRuntime emits queued follow-up snapshots`,
    () =>
      directSignalCase.run("done.", ({ client }, controls) =>
        Effect.scoped(
          Effect.gen(function* () {
            const created = yield* client.session
              .create({ cwd: process.cwd() })
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

            // Stream is now paused mid-flight on the chunk gate
            yield* controls.waitForStreamStart

            yield* waitFor(
              Ref.get(runtime),
              (current) => current.some((state) => state._tag !== "Idle"),
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

            // Release chunks for both turns so scope cleanup is fast
            yield* controls.emitAll()
            yield* controls.emitAll()
          }),
        ),
      ),
    timeoutMs,
  )
})
