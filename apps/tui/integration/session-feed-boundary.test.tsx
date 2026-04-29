/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
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
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { Gent } from "@gent/sdk"
import { waitForFrame, makeSessionState, repoRoot } from "./helpers"
const baseLocalLayerWithProvider = (p: Parameters<typeof _baseLocalLayerWithProvider>[0]) =>
  _baseLocalLayerWithProvider(p, { agents: AllBuiltinAgents, extraLayers: [GitReader.Test] })
describe("session feed boundary", () => {
  it.live(
    "projects streaming state and assistant output",
    () =>
      Effect.gen(function* () {
        yield* Effect.scoped(
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
            yield* client.message.send({
              sessionId: created.sessionId,
              branchId: created.branchId,
              content: "queued",
            })
            // controls.waitForStreamStart is the actual readiness signal — it
            // resolves once provider.stream() has been called, which can only
            // happen after the feed fiber is consuming events.
            yield* controls.waitForStreamStart
            // Emit all chunks + finish
            yield* controls.emitAll()
            // Wait for idle state with response content
            const responseFrame = yield* waitForFrame(
              setup,
              (frame) => frame.includes("debug response") && frame.includes("idle"),
              "assistant debug response with idle",
              5000,
            )
            expect(responseFrame).toContain("debug response")
            expect(responseFrame).toContain("idle")
          }),
        )
      }),
    10000,
  )
  it.live(
    "projects queue widget updates while the active turn is running",
    () =>
      Effect.gen(function* () {
        yield* Effect.scoped(
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
            // Send first message — will be gated by signal provider
            yield* client.message.send({
              sessionId: created.sessionId,
              branchId: created.branchId,
              content: "first",
            })
            // Wait for first turn's stream to start. waitForStreamStart is the
            // readiness signal — provider.stream() is only called once the feed
            // fiber has consumed the MessageReceived event.
            yield* controls.waitForStreamStart
            // Send second message while first is still streaming (gated)
            yield* client.message.send({
              sessionId: created.sessionId,
              branchId: created.branchId,
              content: "queued follow-up",
            })
            // waitForFrame polls until the queue widget appears — no need to
            // pre-sleep for state to propagate.
            const frame = yield* waitForFrame(
              setup,
              (next) =>
                next.includes("queue") &&
                next.includes("[queued 1]") &&
                next.includes("queued follow-up"),
              "queue widget",
              5000,
            )
            expect(frame).toContain("queue")
            expect(frame).toContain("[queued 1] queued follow-up")
            // Emit first turn's chunks to unblock
            yield* controls.emitAll()
            // The agent loop will dequeue the follow-up and call stream() again.
            // The signal provider's shared queue needs tokens for the second turn too.
            yield* controls.emitAll()
          }),
        )
      }),
    10000,
  )
  it.live(
    "projects provider failures into session events instead of composer text",
    () =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client, runtime } = yield* Gent.test(
              baseLocalLayerWithProvider(Provider.Failing),
            )
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
            yield* client.message.send({
              sessionId: created.sessionId,
              branchId: created.branchId,
              content: "boom",
            })
            // waitForFrame polls until the error event appears — no pre-sleep
            // needed; the error event itself confirms feed delivery.
            const frame = yield* waitForFrame(
              setup,
              (next) => next.includes("provider exploded"),
              "error event",
              5000,
            )
            expect(frame).toContain("provider exploded")
            expect(frame).not.toContain("❯ provider exploded")
          }),
        )
      }),
    10000,
  )
  it.live("interrupts the feed fiber through runtime cleanup on unmount", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("session-test")
      const branchId = BranchId.make("branch-test")
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
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <Session sessionId={sessionId} branchId={branchId} />, {
          client: createMockClient(),
          runtime,
          initialSession: {
            id: sessionId,
            branchId,
            name: "Test Session",
            createdAt: 0,
            updatedAt: 0,
          },
          initialRoute: Route.session(sessionId, branchId),
          cwd: repoRoot,
          width: 100,
          height: 32,
        }),
      )
      const castCountBeforeDestroy = interrupted.length
      destroyRenderSetup(setup)
      expect(interrupted.length).toBeGreaterThan(castCountBeforeDestroy)
    }),
  )
})
