import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Stream } from "effect"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../extensions/helpers/test-preset"

const makeClient = (reply = "ok") =>
  Effect.gen(function* () {
    const { layer: providerLayer } = yield* createSequenceProvider([textStep(reply)])
    return yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
  })

const collectSessionEvents = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()

    yield* stream.pipe(
      Stream.runForEach(() => Deferred.succeed(ready, undefined).pipe(Effect.ignore)),
      Effect.ensuring(Deferred.succeed(closed, undefined).pipe(Effect.ignore)),
      Effect.forkScoped,
    )

    yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
    return closed
  })

describe("session.delete", () => {
  it.live("closes session event streams and removes the session from public queries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })
        const closed = yield* collectSessionEvents(
          client.session.events({
            sessionId: created.sessionId,
          }),
        )

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))

        const deleted = yield* client.session.get({ sessionId: created.sessionId })
        const sessions = yield* client.session.list()

        expect(deleted).toBeNull()
        expect(sessions.some((session) => session.id === created.sessionId)).toBe(false)
      }),
    ),
  )

  it.live("is idempotent when deleting an already deleted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* client.session.delete({ sessionId: created.sessionId })
        const deleted = yield* client.session.get({ sessionId: created.sessionId })

        expect(deleted).toBeNull()
      }),
    ),
  )
})

describe("message.send", () => {
  it.live(
    "persists the user message and assistant reply through the public snapshot contract",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userText = "hello from acceptance"
          const assistantText = "acceptance reply"
          const { client } = yield* makeClient(assistantText)
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: userText,
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === assistantText),
              ),
            5_000,
            "assistant reply in session snapshot",
          )

          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "user" &&
                message.parts.some((part) => part.type === "text" && part.text === userText),
            ),
          ).toBe(true)
          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          ).toBe(true)
        }),
      ),
  )
})
