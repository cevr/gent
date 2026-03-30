import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import * as path from "node:path"
import { resolveInitialState } from "../src/app-bootstrap"
import { baseLocalLayer } from "@gent/core/test-utils/in-process-layer.js"
import { Gent } from "@gent/sdk"

const repoRoot = path.resolve(import.meta.dir, "../../..")

describe("app bootstrap boundary", () => {
  test("continue mode resumes the latest session for cwd", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* Gent.test(baseLocalLayer())

          const first = yield* client.session.create({ cwd: repoRoot, bypass: true })
          yield* Effect.sleep("5 millis")
          const second = yield* client.session.create({ cwd: repoRoot, bypass: false })

          const state = yield* resolveInitialState({
            client,
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
  }, 5_000)

  test("continue mode creates a session from prompt when none exists", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* Gent.test(baseLocalLayer())

          const state = yield* resolveInitialState({
            client,
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
  }, 5_000)
})
