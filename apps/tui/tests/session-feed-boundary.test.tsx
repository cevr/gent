/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import { Route } from "../src/router"
import { Session } from "../src/routes/session"
import { renderFrame, renderWithProviders } from "./render-harness"
import {
  createTempDirFixture,
  createWorkerEnv,
  startWorkerWithClient,
} from "../../../tests/seam-fixture"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-session-feed-")

const waitForFrame = async (
  setup: Awaited<ReturnType<typeof renderWithProviders>>,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs
  let lastFrame = ""

  const poll = async (): Promise<string> => {
    await setup.renderOnce()
    const frame = renderFrame(setup)
    lastFrame = frame
    if (predicate(frame)) return frame
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for rendered frame: ${label}\n${lastFrame}`)
    }
    await Bun.sleep(25)
    return poll()
  }

  return poll()
}

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
          const worker = yield* startWorkerWithClient({
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
                supervisor: worker,
                initialSession: makeSessionState(created),
                initialRoute: Route.session(created.sessionId, created.branchId),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "queued",
          })

          const thinkingFrame = yield* Effect.promise(() =>
            waitForFrame(setup, (frame) => frame.includes("thinking"), "thinking label", 10_000),
          )
          expect(thinkingFrame).toContain("thinking")

          const responseFrame = yield* Effect.promise(() =>
            waitForFrame(
              setup,
              (frame) => frame.includes("debug response"),
              "assistant debug response",
              10_000,
            ),
          )
          expect(responseFrame).toContain("debug response")
        }),
      ),
    )
  }, 20_000)

  test("projects queue widget updates while the active turn is running", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithClient({
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
                supervisor: worker,
                initialSession: makeSessionState(created),
                initialRoute: Route.session(created.sessionId, created.branchId),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )

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

          const frame = yield* Effect.promise(() =>
            waitForFrame(
              setup,
              (next) =>
                next.includes("queue") &&
                next.includes("[queued 1]") &&
                next.includes("queued follow-up"),
              "queue widget",
              10_000,
            ),
          )

          expect(frame).toContain("queue")
          expect(frame).toContain("[queued 1] queued follow-up")
        }),
      ),
    )
  }, 20_000)

  test("projects provider failures into session events instead of composer text", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* startWorkerWithClient({
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
                supervisor: worker,
                initialSession: makeSessionState(created),
                initialRoute: Route.session(created.sessionId, created.branchId),
                cwd: repoRoot,
                width: 100,
                height: 32,
              },
            ),
          )

          yield* worker.client.sendMessage({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "boom",
          })

          const frame = yield* Effect.promise(() =>
            waitForFrame(
              setup,
              (next) => next.includes("provider exploded"),
              "error event",
              10_000,
            ),
          )

          expect(frame).toContain("provider exploded")
          expect(frame).not.toContain("❯ provider exploded")
        }),
      ),
    )
  }, 15_000)
})
