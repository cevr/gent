/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import { Route } from "../src/router"
import { Session } from "../src/routes/session"
import { destroyRenderSetup, renderFrame, renderWithProviders } from "../tests/render-harness"
import { createSignalProvider, DebugFailingProvider } from "@gent/core/debug/provider.js"
import { baseLocalLayerWithProvider } from "@gent/core/test-utils/in-process-layer.js"
import { Gent } from "@gent/sdk"

const repoRoot = path.resolve(import.meta.dir, "../../..")

const waitForFrame = (
  setup: Awaited<ReturnType<typeof renderWithProviders>>,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 5_000,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    let lastFrame = ""

    while (Date.now() - startedAt < timeoutMs) {
      yield* Effect.promise(() => setup.renderOnce())
      yield* Effect.promise(() => Promise.resolve())
      yield* Effect.promise(() => setup.renderOnce())

      const frame = renderFrame(setup)
      lastFrame = frame
      if (predicate(frame)) return frame

      yield* Effect.sleep("50 millis")
    }

    return yield* Effect.fail(
      new Error(`timed out waiting for rendered frame: ${label}\n${lastFrame}`),
    )
  })

const makeSessionState = (created: {
  sessionId: string
  branchId: string
  name: string
  bypass: boolean
}) => ({
  sessionId: created.sessionId,
  branchId: created.branchId,
  name: created.name,
  bypass: created.bypass,
  reasoningLevel: undefined,
})

describe("session feed boundary", () => {
  test("projects streaming state and assistant output", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: signalLayer, controls } = yield* createSignalProvider(
            "cowork debug response. Latest user message: queued. This turn is flowing through the real agent loop with a scripted provider.",
          )
          const { client, runtime } = yield* Gent.test(baseLocalLayerWithProvider(signalLayer))

          const created = yield* client.session.create({ cwd: repoRoot, bypass: true })

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => <Session sessionId={created.sessionId} branchId={created.branchId} />,
              {
                client,
                runtime,
                initialSession: makeSessionState(created),
                initialRoute: Route.session(created.sessionId, created.branchId),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))

          // Allow feed to subscribe
          yield* Effect.sleep("200 millis")

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued",
          })

          // Wait for stream to start (provider.stream was called)
          yield* controls.waitForStreamStart

          // Emit all chunks + finish
          yield* controls.emitAll()

          // Wait for idle state with response content
          const responseFrame = yield* waitForFrame(
            setup,
            (frame) => frame.includes("debug response") && frame.includes("idle"),
            "assistant debug response with idle",
            5_000,
          )
          expect(responseFrame).toContain("debug response")
          expect(responseFrame).toContain("idle")
        }),
      ),
    )
  }, 10_000)

  test("projects queue widget updates while the active turn is running", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: signalLayer, controls } = yield* createSignalProvider(
            "cowork debug response. First turn complete.",
          )
          const { client, runtime } = yield* Gent.test(baseLocalLayerWithProvider(signalLayer))

          const created = yield* client.session.create({ cwd: repoRoot, bypass: true })

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => <Session sessionId={created.sessionId} branchId={created.branchId} />,
              {
                client,
                runtime,
                initialSession: makeSessionState(created),
                initialRoute: Route.session(created.sessionId, created.branchId),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))

          // Allow feed to subscribe
          yield* Effect.sleep("200 millis")

          // Send first message — will be gated by signal provider
          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "first",
          })

          // Wait for first turn's stream to start
          yield* controls.waitForStreamStart

          // Send second message while first is still streaming (gated)
          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued follow-up",
          })

          // Allow queue state to propagate
          yield* Effect.sleep("200 millis")

          const frame = yield* waitForFrame(
            setup,
            (next) =>
              next.includes("queue") &&
              next.includes("[queued 1]") &&
              next.includes("queued follow-up"),
            "queue widget",
            5_000,
          )

          expect(frame).toContain("queue")
          expect(frame).toContain("[queued 1] queued follow-up")

          // Emit first turn's chunks to unblock
          yield* controls.emitAll()
          // The agent loop will dequeue the follow-up and call stream() again.
          // The signal provider's shared queue needs tokens for the second turn too.
          yield* controls.emitAll()
        }),
      ),
    )
  }, 10_000)

  test("projects provider failures into session events instead of composer text", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client, runtime } = yield* Gent.test(
            baseLocalLayerWithProvider(DebugFailingProvider),
          )

          const created = yield* client.session.create({ cwd: repoRoot, bypass: true })

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => <Session sessionId={created.sessionId} branchId={created.branchId} />,
              {
                client,
                runtime,
                initialSession: makeSessionState(created),
                initialRoute: Route.session(created.sessionId, created.branchId),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))

          // Allow feed to subscribe
          yield* Effect.sleep("200 millis")

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "boom",
          })

          const frame = yield* waitForFrame(
            setup,
            (next) => next.includes("provider exploded"),
            "error event",
            5_000,
          )

          expect(frame).toContain("provider exploded")
          expect(frame).not.toContain("❯ provider exploded")
        }),
      ),
    )
  }, 10_000)
})
