import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Ref, Stream } from "effect"
import { transportCases, waitFor } from "./transport-harness"

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
  const directCases = transportCases.filter((transport) => transport.name === "direct")

  for (const transport of directCases) {
    test(`${transport.name} persists session traffic across the public boundary`, async () => {
      await transport.run(({ client }) =>
        Effect.gen(function* () {
          const userText = `boundary ${transport.name}`
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: userText,
          })

          const snapshot = yield* waitFor(
            client.session
              .getSnapshot({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Effect.mapError((error) => new Error(String(error)))),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some(
                (message) =>
                  message.role === "user" &&
                  message.parts.some((part) => part.type === "text" && part.text === userText),
              ),
            5_000,
          )

          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "user" &&
                message.parts.some((part) => part.type === "text" && part.text === userText),
            ),
          ).toBe(true)
          expect(snapshot.runtime._tag).toBe("Idle")
        }),
      )
    }, 10_000)
  }

  for (const transport of directCases) {
    test(`${transport.name} closes session event streams when a session is deleted`, async () => {
      await transport.run(({ client }) =>
        Effect.gen(function* () {
          const created = yield* client.session.create({ cwd: process.cwd() })
          const events = yield* collectRuntime(
            client.session.events({
              sessionId: created.sessionId,
            }),
          )
          yield* Effect.sleep("50 millis")

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
      )
    })
  }
})
