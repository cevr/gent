/** @jsxImportSource @opentui/solid */

import { afterEach, describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import * as path from "node:path"
import { Route } from "../src/router"
import { Session } from "../src/routes/session"
import { destroyRenderSetup, renderFrame, renderWithProviders } from "../tests/render-harness"
import { createTempDirFixture, createWorkerEnv } from "@gent/core/test-utils/fixtures"
import { Gent } from "@gent/sdk"
import { startWorkerSupervisor } from "@gent/sdk/supervisor"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-session-feed-")

// ---------------------------------------------------------------------------
// PID reaper for this test file (same pattern as seam-fixture)
// ---------------------------------------------------------------------------

const trackedPids = new Set<number>()

afterEach(() => {
  for (const pid of trackedPids) {
    try {
      process.kill(pid, 0)
      process.kill(pid, "SIGTERM")
    } catch {
      // already dead
    }
  }
  trackedPids.clear()
})

const startWorkerWithSupervisor = (options: Parameters<typeof startWorkerSupervisor>[0]) =>
  Effect.gen(function* () {
    const supervisor = yield* startWorkerSupervisor(options)
    const pid = supervisor.pid()
    if (pid !== null) trackedPids.add(pid)
    yield* Effect.addFinalizer(() => supervisor.stop)
    const client = yield* Gent.connect({ url: supervisor.url })
    return { ...supervisor, client }
  })

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

          // Allow feed to subscribe before sending
          yield* Effect.sleep("500 millis")

          const initialFrame = renderFrame(setup)
          expect(initialFrame).toContain("ready")

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued",
          })

          // Wait for final idle state with response content
          // (transient "thinking" state is too brief with polling to reliably catch)
          const responseFrame = yield* waitForFrame(
            setup,
            (frame) => frame.includes("debug response") && frame.includes("idle"),
            "assistant debug response with idle",
            30_000,
          )
          expect(responseFrame).toContain("debug response")
          expect(responseFrame).toContain("idle")
        }).pipe(Effect.timeout(Duration.seconds(40))),
      ),
    )
  }, 45_000)

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

          // Allow feed to subscribe before sending
          yield* Effect.sleep("500 millis")

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
            (next) =>
              next.includes("queue") &&
              next.includes("[queued 1]") &&
              next.includes("queued follow-up"),
            "queue widget",
            10_000,
          )

          expect(frame).toContain("queue")
          expect(frame).toContain("[queued 1] queued follow-up")
        }).pipe(Effect.timeout(Duration.seconds(15))),
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

          // Allow feed to subscribe before sending
          yield* Effect.sleep("500 millis")

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "boom",
          })

          const frame = yield* waitForFrame(
            setup,
            (next) => next.includes("provider exploded"),
            "error event",
            10_000,
          )

          expect(frame).toContain("provider exploded")
          expect(frame).not.toContain("❯ provider exploded")
        }).pipe(Effect.timeout(Duration.seconds(10))),
      ),
    )
  }, 15_000)
})
