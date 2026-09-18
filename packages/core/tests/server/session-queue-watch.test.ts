/**
 * The queue as a client reads it, while a turn is still in flight.
 *
 * `session-idempotency.test.ts` covers `queue.drain` for steering entries and
 * `runtime/session-runtime.test.ts` covers follow-up draining at the service
 * level. This file covers the public pair neither does: two follow-ups queued
 * mid-turn, read back in order through `queue.get` and returned in the same
 * order by `queue.drain`, and the follow-up queue reaching a client through
 * the `watchRuntime` stream rather than a poll.
 */
import { describe, expect, it } from "effect-bun-test"
import type { Scope } from "effect"
import { Deferred, Effect, Ref, Stream } from "effect"
import { Gent } from "@gent/sdk"
import { LanguageModelLayers, waitFor } from "../../src/test-utils/language-model"
import { createE2ELayer } from "../../src/test-utils/e2e-layer"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"

/**
 * The signal model gates every chunk on a queue, so the first turn stays in
 * flight until the test releases it. That is what lets a second `message.send`
 * land as a queued follow-up rather than starting its own turn.
 */
const makeSignalClient = (reply: string) =>
  Effect.gen(function* () {
    const { layer: providerLayer, controls } = yield* LanguageModelLayers.signal(reply)
    const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
    return { client, controls }
  })

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
    // watchRuntime emits the current snapshot on subscribe, so this typically
    // resolves in <1ms. Cap at 50ms as a safety net.
    yield* Deferred.await(ready).pipe(Effect.timeout("50 millis"), Effect.ignore)
    return values
  })

describe("session queue and runtime watch", () => {
  it.live(
    "two follow-ups queued mid-turn keep their order through queue.get and queue.drain",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, controls } = yield* makeSignalClient("done.")
          const created = yield* client.session.create({ cwd: process.cwd() })

          const runtime = yield* collectRuntime(
            client.session.watchRuntime({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "first turn",
          })

          // Wait for the stream to start so the runtime is genuinely non-idle.
          yield* controls.waitForStreamStart

          yield* waitFor(
            Ref.get(runtime),
            (states) => states.some((state) => state._tag !== "Idle"),
            10_000,
          )

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued a",
          })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued b",
          })

          const queued = yield* waitFor(
            client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) => flattenRestoreText(snapshot) === "queued a\nqueued b",
            10_000,
          )

          expect(queued.steering).toEqual([])
          expect(flattenRestoreText(queued)).toBe("queued a\nqueued b")

          const drained = yield* client.queue.drain({
            sessionId: created.sessionId,
            branchId: created.branchId,
            requestId: "req-queue-contract-drain",
          })

          expect(flattenRestoreText(drained)).toBe("queued a\nqueued b")

          const afterDrain = yield* waitFor(
            client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (snapshot) => snapshot.steering.length === 0 && snapshot.followUp.length === 0,
            10_000,
          )

          expect(afterDrain.steering).toEqual([])
          expect(afterDrain.followUp).toEqual([])

          // Release the stream so the run can complete and scope cleanup is fast.
          yield* controls.emitAll
        }),
      ).pipe(Effect.timeout("18 seconds")),
    20_000,
  )

  it.live(
    "watchRuntime pushes a queued follow-up out to the client mid-turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client, controls } = yield* makeSignalClient("done.")
          const created = yield* client.session.create({ cwd: process.cwd() })

          const runtime = yield* collectRuntime(
            client.session.watchRuntime({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )

          const initial = yield* waitFor(
            Ref.get(runtime),
            (current) => current[0]?._tag === "Idle",
            10_000,
          )
          expect(initial[0]?._tag).toBe("Idle")
          expect(initial[0]?.queue.followUp).toEqual([])
          expect(initial[0]?.queue.steering).toEqual([])

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "first turn",
          })

          // Stream is now paused mid-flight on the chunk gate.
          yield* controls.waitForStreamStart

          yield* waitFor(
            Ref.get(runtime),
            (current) => current.some((state) => state._tag !== "Idle"),
            10_000,
          )

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued follow-up",
          })

          const updated = yield* waitFor(
            Ref.get(runtime),
            (current) =>
              current.some((state) =>
                state.queue.followUp.some((entry) => entry.content.includes("queued follow-up")),
              ),
            10_000,
          )

          expect(
            updated.some((state) =>
              state.queue.followUp.some((entry) => entry.content.includes("queued follow-up")),
            ),
          ).toBe(true)

          // Release chunks for both turns so scope cleanup is fast.
          yield* controls.emitAll
          yield* controls.emitAll
        }),
      ).pipe(Effect.timeout("18 seconds")),
    20_000,
  )
})
