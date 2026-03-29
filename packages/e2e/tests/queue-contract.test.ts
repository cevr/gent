import { describe, expect, test } from "bun:test"
import { Effect, Ref, Stream } from "effect"
import { extractText } from "@gent/sdk"
import { queueTransportCases, waitFor } from "./transport-harness"

// See event-stream-parity.test.ts for why streaming tests are direct-only.
const streamingQueueCases = queueTransportCases.filter((c) => c.name === "direct")

const flattenRestoreText = (snapshot: {
  steering: ReadonlyArray<{ content: string }>
  followUp: ReadonlyArray<{ content: string }>
}) => [...snapshot.steering, ...snapshot.followUp].map((entry) => entry.content).join("\n")

const collectRuntime = <A, E>(stream: Stream.Stream<A, E>): Effect.Effect<Ref.Ref<A[]>, E, never> =>
  Effect.gen(function* () {
    const values = yield* Ref.make<A[]>([])
    yield* stream.pipe(
      Stream.runForEach((value) => Ref.update(values, (current) => [...current, value])),
      Effect.forkScoped,
    )
    yield* Effect.sleep("50 millis")
    return values
  })

describe("queue seam contract", () => {
  for (const transport of streamingQueueCases) {
    test(`${transport.name} exposes queued follow-ups and drain matches restore semantics`, async () => {
      await transport.run(({ client }) =>
        Effect.gen(function* () {
          const created = yield* client.session
            .create({
              cwd: process.cwd(),
              bypass: true,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          const runtime = yield* collectRuntime(
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
            (states) => states.some((state) => state.status !== "idle"),
            10_000,
          )

          yield* client.message
            .send({
              sessionId: created.sessionId,
              branchId: created.branchId,
              content: "queued a",
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          yield* client.message
            .send({
              sessionId: created.sessionId,
              branchId: created.branchId,
              content: "queued b",
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          const queued = yield* waitFor(
            client.queue
              .get({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Effect.mapError((error) => new Error(String(error)))),
            (snapshot) => flattenRestoreText(snapshot) === "queued a\nqueued b",
            10_000,
          )

          expect(queued.steering).toEqual([])
          expect(flattenRestoreText(queued)).toBe("queued a\nqueued b")

          const drained = yield* client.queue
            .drain({
              sessionId: created.sessionId,
              branchId: created.branchId,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          expect(flattenRestoreText(drained)).toBe("queued a\nqueued b")

          const afterDrain = yield* waitFor(
            client.queue
              .get({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Effect.mapError((error) => new Error(String(error)))),
            (snapshot) => snapshot.steering.length === 0 && snapshot.followUp.length === 0,
            10_000,
          )

          expect(afterDrain.steering).toEqual([])
          expect(afterDrain.followUp).toEqual([])
        }),
      )
    }, 20_000)

    test(`${transport.name} runs steer before queued follow-up`, async () => {
      await transport.run(({ client }) =>
        Effect.gen(function* () {
          const created = yield* client.session
            .create({
              cwd: process.cwd(),
              bypass: true,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          const runtime = yield* collectRuntime(
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
            (states) => states.some((state) => state.status !== "idle"),
            10_000,
          )

          yield* client.message
            .send({
              sessionId: created.sessionId,
              branchId: created.branchId,
              content: "queued follow-up",
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          yield* client.steer
            .command({
              command: {
                _tag: "Interject",
                sessionId: created.sessionId,
                branchId: created.branchId,
                message: "urgent steer",
              },
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          const queued = yield* waitFor(
            client.queue
              .get({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Effect.mapError((error) => new Error(String(error)))),
            (snapshot) =>
              snapshot.steering.some((entry) => entry.content.includes("urgent steer")) &&
              snapshot.followUp.some((entry) => entry.content.includes("queued follow-up")),
            10_000,
          )

          expect(queued.steering[0]?.content).toContain("urgent steer")
          expect(queued.followUp[0]?.content).toContain("queued follow-up")

          const messages = yield* waitFor(
            client.message
              .list({ branchId: created.branchId })
              .pipe(Effect.mapError((error) => new Error(String(error)))),
            (items) => {
              const userTexts = items
                .filter((message) => message.role === "user")
                .map((message) => extractText(message.parts))
              return (
                userTexts.includes("first turn") &&
                userTexts.includes("urgent steer") &&
                userTexts.includes("queued follow-up")
              )
            },
            15_000,
          )

          const userTexts = messages
            .filter((message) => message.role === "user")
            .map((message) => extractText(message.parts))
            .filter((text) => ["first turn", "urgent steer", "queued follow-up"].includes(text))

          expect(userTexts).toEqual(["first turn", "urgent steer", "queued follow-up"])

          const settledQueue = yield* waitFor(
            client.queue
              .get({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Effect.mapError((error) => new Error(String(error)))),
            (snapshot) => snapshot.steering.length === 0 && snapshot.followUp.length === 0,
            10_000,
          )

          expect(settledQueue.steering).toEqual([])
          expect(settledQueue.followUp).toEqual([])
        }),
      )
    }, 20_000)
  }
})
