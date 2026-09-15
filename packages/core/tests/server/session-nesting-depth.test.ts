import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { DEFAULT_MAX_AGENT_RUN_DEPTH } from "../../src/domain/agent"
import type { BranchId, SessionId } from "../../src/domain/ids"
import { makeClient } from "./session-mutations/helpers"

describe("session.create nesting depth", () => {
  it.live("handoff chain stops at the shared agent-run depth cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const root = yield* client.session.create({ cwd: process.cwd() })
        // Root is depth 0; each handoff nests one level deeper.
        let parent: { sessionId: SessionId; branchId: BranchId } = root
        for (let depth = 1; depth <= DEFAULT_MAX_AGENT_RUN_DEPTH; depth++) {
          parent = yield* client.session.create({
            cwd: process.cwd(),
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
          })
        }
        const error = yield* client.session
          .create({
            cwd: process.cwd(),
            parentSessionId: parent.sessionId,
            parentBranchId: parent.branchId,
          })
          .pipe(Effect.flip)
        expect(error._tag).toBe("SessionDepthLimitError")
        expect(error.message).toContain(`max ${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
      }).pipe(Effect.timeout("6 seconds")),
    ),
  )

  it.live("handoff below the cap still creates a child session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const root = yield* client.session.create({ cwd: process.cwd() })
        const child = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: root.sessionId,
          parentBranchId: root.branchId,
        })
        const stored = yield* client.session.get({ sessionId: child.sessionId })
        expect(stored?.parentSessionId).toBe(root.sessionId)
      }).pipe(Effect.timeout("6 seconds")),
    ),
  )
})
