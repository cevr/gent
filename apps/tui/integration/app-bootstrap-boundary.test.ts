import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import * as path from "node:path"
import { resolveInitialState } from "../src/app-bootstrap"
import {
  createTempDirFixture,
  createWorkerEnv,
  startWorkerWithClient,
} from "@gent/e2e/tests/seam-fixture"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const makeTempDir = createTempDirFixture("gent-bootstrap-")

describe("app bootstrap boundary", () => {
  test("continue mode resumes the latest worker-backed session for cwd", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* startWorkerWithClient({
            cwd: repoRoot,
            env: createWorkerEnv(root, { providerMode: "debug-scripted" }),
          })

          const first = yield* client.createSession({ cwd: repoRoot, bypass: true })
          yield* Effect.sleep("5 millis")
          const second = yield* client.createSession({ cwd: repoRoot, bypass: false })

          const state = yield* resolveInitialState({
            client: client,
            cwd: repoRoot,
            session: Option.none(),
            continue_: true,
            headless: false,
            prompt: Option.none(),
            promptArg: Option.none(),
            bypass: true,
          })

          expect(state._tag).toBe("session")
          if (state._tag !== "session") return
          expect(state.session.id).toBe(second.sessionId)
          expect(state.session.id).not.toBe(first.sessionId)
        }),
      ),
    )
  }, 15_000)

  test("continue mode creates a worker-backed session from prompt when none exists", async () => {
    const root = makeTempDir()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* startWorkerWithClient({
            cwd: repoRoot,
            env: createWorkerEnv(root, { providerMode: "debug-scripted" }),
          })

          const state = yield* resolveInitialState({
            client: client,
            cwd: repoRoot,
            session: Option.none(),
            continue_: true,
            headless: false,
            prompt: Option.some("bootstrap prompt"),
            promptArg: Option.none(),
            bypass: true,
          })

          expect(state._tag).toBe("session")
          if (state._tag !== "session") return
          expect(state.prompt).toBe("bootstrap prompt")
          expect(state.session.branchId).toBeDefined()
        }),
      ),
    )
  }, 15_000)
})
