import { describe, expect, test } from "bun:test"
import type { Scope } from "effect"
import { Deferred, Effect, Ref, Stream } from "effect"
import { extractText } from "@gent/sdk"
import { directSignalCase, waitFor } from "./transport-harness"
import { waitDeferred } from "../src/effect-test-adapters"

const flattenRestoreText = (snapshot: {
  steering: ReadonlyArray<{ content: string }>
  followUp: ReadonlyArray<{ content: string }>
}) => [...snapshot.steering, ...snapshot.followUp].map((entry) => entry.content).join("\n")

const collectRuntime = <A, E>(
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
    // because some streams (events-after-cursor) only emit when state changes
    // — downstream waitFor() polls absorb any remaining race.
    yield* waitDeferred(ready).pipe(Effect.timeout("50 millis"), Effect.ignore)
    return values
  })

describe("queue seam contract", () => {
  test(
    `${directSignalCase.name} exposes queued follow-ups and drain matches restore semantics`,
    () =>
      directSignalCase.run("done.", ({ client }, controls) =>
        Effect.scoped(
          Effect.gen(function* () {
            const created = yield* client.session
              .create({
                cwd: process.cwd(),
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

            // Wait for the stream to start so the runtime is genuinely non-idle
            yield* controls.waitForStreamStart

            yield* waitFor(
              Ref.get(runtime),
              (states) => states.some((state) => state._tag !== "Idle"),
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

            // Release the stream so the run can complete and scope cleanup is fast
            yield* controls.emitAll()
          }),
        ),
      ),
    20_000,
  )

  test(
    `${directSignalCase.name} runs steer before queued follow-up`,
    () =>
      directSignalCase.run("done.", ({ client }, controls) =>
        Effect.scoped(
          Effect.gen(function* () {
            const created = yield* client.session
              .create({
                cwd: process.cwd(),
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

            yield* controls.waitForStreamStart

            yield* waitFor(
              Ref.get(runtime),
              (states) => states.some((state) => state._tag !== "Idle"),
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

            // Release chunks so the first turn finishes and the steer + follow-up
            // can drain through the run loop. Each subsequent turn re-uses the
            // same gated stream — emitAll covers the chunk count for one turn,
            // so we keep emitting until the full sequence has been processed.
            yield* controls.emitAll()
            yield* controls.emitAll()
            yield* controls.emitAll()

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
        ),
      ),
    20_000,
  )
})
