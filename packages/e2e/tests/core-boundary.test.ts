import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Ref, Stream } from "effect"
import { transportCases } from "./transport-harness"

const collectRuntime = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const values = yield* Ref.make<A[]>([])
    const ready = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()

    yield* stream.pipe(
      Stream.runForEach((value) =>
        Ref.update(values, (current) => [...current, value]).pipe(
          Effect.andThen(Deferred.succeed(ready, undefined).pipe(Effect.ignore)),
        ),
      ),
      Effect.ensuring(Deferred.succeed(closed, undefined).pipe(Effect.ignore)),
      Effect.forkScoped,
    )

    yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
    return { values, closed }
  })

describe("session RPC boundary", () => {
  for (const transport of transportCases) {
    const timeoutMs = transport.name === "worker-http" ? 35_000 : 10_000

    test(
      `${transport.name} closes session event streams when a session is deleted`,
      async () => {
        await transport.run(({ client }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const created = yield* client.session.create({ cwd: process.cwd() })
              const events = yield* collectRuntime(
                client.session.events({
                  sessionId: created.sessionId,
                }),
              )

              yield* client.session
                .delete({ sessionId: created.sessionId })
                .pipe(Effect.mapError((error) => new Error(String(error))))
              yield* Deferred.await(events.closed).pipe(Effect.timeout("15 seconds"))

              const sessions = yield* client.session
                .list()
                .pipe(Effect.mapError((error) => new Error(String(error))))
              const deleted = yield* client.session
                .get({ sessionId: created.sessionId })
                .pipe(Effect.mapError((error) => new Error(String(error))))

              expect(sessions.some((session) => session.id === created.sessionId)).toBe(false)
              expect(deleted).toBeNull()
            }),
          ),
        )
      },
      timeoutMs,
    )
  }
})
