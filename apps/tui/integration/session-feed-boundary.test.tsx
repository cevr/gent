/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Option, Stream } from "effect"
import type { GentClient } from "@gent/sdk"
import * as path from "node:path"
import { Route } from "../src/router"
import { Session } from "../src/routes/session"
import { destroyRenderSetup, renderFrame, renderWithProviders } from "../tests/render-harness"
import {
  createTempDirFixture,
  createWorkerEnv,
  startWorkerWithSupervisor,
} from "../../../tests/seam-fixture"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-session-feed-")

const waitForFrame = (
  setup: Awaited<ReturnType<typeof renderWithProviders>>,
  client: GentClient,
  session: { sessionId: string; branchId: string },
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 5_000,
): Effect.Effect<string, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const match = yield* Deferred.make<string>()
      let lastFrame = ""

      const renderAndMatch = Effect.gen(function* () {
        yield* Effect.promise(() => setup.renderOnce())
        yield* Effect.promise(() => Promise.resolve())
        yield* Effect.promise(() => setup.renderOnce())
        const frame = renderFrame(setup)
        lastFrame = frame
        if (predicate(frame)) {
          yield* Deferred.succeed(match, frame).pipe(Effect.ignore)
        }
      })

      yield* renderAndMatch

      yield* Effect.forkScoped(
        client.watchRuntime(session).pipe(Stream.runForEach(() => renderAndMatch)),
      )
      yield* Effect.forkScoped(
        client.streamEvents(session).pipe(Stream.runForEach(() => renderAndMatch)),
      )

      return yield* Deferred.await(match).pipe(
        Effect.timeoutOption(`${timeoutMs} millis`),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new Error(`timed out waiting for rendered frame: ${label}\n${lastFrame}`),
              ),
            onSome: Effect.succeed,
          }),
        ),
      )
    }),
  )

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
  test("projects thinking state and assistant output from worker transport", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithSupervisor({
            cwd: repoRoot,
            startupTimeoutMs: 20_000,
            env: createWorkerEnv(root, { providerMode: "debug-slow" }),
          })

          const created = yield* worker.client.createSession({
            cwd: repoRoot,
            bypass: true,
          })

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => <Session sessionId={created.sessionId} branchId={created.branchId} />,
              {
                client: worker.client,
                initialSession: makeSessionState(created),
                initialRoute: Route.session(created.sessionId, created.branchId),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))

          const initialFrame = renderFrame(setup)
          expect(initialFrame).toContain("ready")

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued",
          })

          const thinkingFrame = yield* waitForFrame(
            setup,
            worker.client,
            created,
            (frame) => frame.includes("thinking"),
            "thinking label",
            10_000,
          )
          expect(thinkingFrame).toContain("thinking")

          const streamingFrame = yield* waitForFrame(
            setup,
            worker.client,
            created,
            (frame) =>
              frame.includes("debug response.") &&
              frame.includes("thinking") &&
              !frame.includes("Latest user message:"),
            "partial assistant chunk",
            10_000,
          )
          expect(streamingFrame).toContain("debug response.")
          expect(streamingFrame).toContain("thinking")
          expect(streamingFrame).not.toContain("Latest user message:")

          const responseFrame = yield* waitForFrame(
            setup,
            worker.client,
            created,
            (frame) => frame.includes("debug response") && frame.includes("idle"),
            "assistant debug response",
            10_000,
          )
          expect(responseFrame).toContain("debug response")
          expect(responseFrame).toContain("idle")

          yield* Effect.sync(() => destroyRenderSetup(setup))
          yield* worker.stop
        }),
      ),
    )
  }, 20_000)

  test("projects queue widget updates while the active turn is running", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithSupervisor({
            cwd: repoRoot,
            startupTimeoutMs: 20_000,
            env: createWorkerEnv(root, { providerMode: "debug-scripted" }),
          })

          const created = yield* worker.client.createSession({
            cwd: repoRoot,
            bypass: true,
          })

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => <Session sessionId={created.sessionId} branchId={created.branchId} />,
              {
                client: worker.client,
                initialSession: makeSessionState(created),
                initialRoute: Route.session(created.sessionId, created.branchId),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "first",
          })
          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued follow-up",
          })

          const frame = yield* waitForFrame(
            setup,
            worker.client,
            created,
            (next) =>
              next.includes("queue") &&
              next.includes("[queued 1]") &&
              next.includes("queued follow-up"),
            "queue widget",
            10_000,
          )

          expect(frame).toContain("queue")
          expect(frame).toContain("[queued 1] queued follow-up")

          yield* Effect.sync(() => destroyRenderSetup(setup))
          yield* worker.stop
        }),
      ),
    )
  }, 20_000)

  test("projects provider failures into session events instead of composer text", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithSupervisor({
            cwd: repoRoot,
            startupTimeoutMs: 20_000,
            env: createWorkerEnv(root, { providerMode: "debug-failing" }),
          })

          const created = yield* worker.client.createSession({
            cwd: repoRoot,
            bypass: true,
          })

          const setup = yield* Effect.promise(() =>
            renderWithProviders(
              () => <Session sessionId={created.sessionId} branchId={created.branchId} />,
              {
                client: worker.client,
                initialSession: makeSessionState(created),
                initialRoute: Route.session(created.sessionId, created.branchId),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => destroyRenderSetup(setup)))

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "boom",
          })

          const frame = yield* waitForFrame(
            setup,
            worker.client,
            created,
            (next) => next.includes("provider exploded"),
            "error event",
            10_000,
          )

          expect(frame).toContain("provider exploded")
          expect(frame).not.toContain("❯ provider exploded")

          yield* Effect.sync(() => destroyRenderSetup(setup))
          yield* worker.stop
        }),
      ),
    )
  }, 15_000)
})
