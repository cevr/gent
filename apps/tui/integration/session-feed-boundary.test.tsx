/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Route } from "../src/router"
import { Session } from "../src/routes/session"
import {
  createMockClient,
  createMockRuntime,
  destroyRenderSetup,
  renderWithProviders,
} from "../tests/render-harness"
import { baseLocalLayerWithProvider as _baseLocalLayerWithProvider } from "@gent/core/test-utils/in-process-layer.js"
import { AllBuiltinAgents } from "@gent/extensions/all-agents.js"
import { GitReader } from "@gent/extensions/librarian/git-reader.js"
import { Provider } from "@gent/core/providers/provider.js"
import { Gent } from "@gent/sdk"
import { waitForFrame, makeSessionState, repoRoot } from "./helpers"

const baseLocalLayerWithProvider = (p: Parameters<typeof _baseLocalLayerWithProvider>[0]) =>
  _baseLocalLayerWithProvider(p, { agents: AllBuiltinAgents, extraLayers: [GitReader.Test] })

describe("session feed boundary", () => {
  test("projects streaming state and assistant output", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: signalLayer, controls } = yield* Provider.Signal(
            "cowork debug response. Latest user message: queued. This turn is flowing through the real agent loop with a scripted provider.",
          )
          const { client, runtime } = yield* Gent.test(baseLocalLayerWithProvider(signalLayer))

          const created = yield* client.session.create({ cwd: repoRoot })

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
          const { layer: signalLayer, controls } = yield* Provider.Signal(
            "cowork debug response. First turn complete.",
          )
          const { client, runtime } = yield* Gent.test(baseLocalLayerWithProvider(signalLayer))

          const created = yield* client.session.create({ cwd: repoRoot })

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
          const { client, runtime } = yield* Gent.test(baseLocalLayerWithProvider(Provider.Failing))

          const created = yield* client.session.create({ cwd: repoRoot })

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

  test("interrupts the feed fiber through runtime cleanup on unmount", async () => {
    const interrupted: Array<Effect.Effect<void>> = []
    const runtime = (() => {
      const base = createMockRuntime()
      return {
        ...base,
        fork: () => Effect.runFork(Effect.never),
        cast: (effect: Effect.Effect<void>) => {
          interrupted.push(effect)
          Effect.runFork(effect)
        },
      }
    })()

    const setup = await renderWithProviders(
      () => <Session sessionId={"session-test" as never} branchId={"branch-test" as never} />,
      {
        client: createMockClient(),
        runtime,
        initialSession: {
          id: "session-test" as never,
          branchId: "branch-test" as never,
          name: "Test Session",
          createdAt: 0,
          updatedAt: 0,
        },
        initialRoute: Route.session("session-test" as never, "branch-test" as never),
        cwd: repoRoot,
        width: 100,
        height: 32,
      },
    )

    const castCountBeforeDestroy = interrupted.length
    destroyRenderSetup(setup)

    expect(interrupted.length).toBeGreaterThan(castCountBeforeDestroy)
  })
})
