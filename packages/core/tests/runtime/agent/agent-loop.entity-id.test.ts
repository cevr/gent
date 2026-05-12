import { describe, expect, it, test } from "effect-bun-test"
import { Effect } from "effect"
import { entityIdOf, parseEntityId } from "../../../src/runtime/agent/agent-loop.entity-id"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { DefaultWorkspaceId, WorkspaceId } from "@gent/core-internal/server/workspace-rpc"

const cases: ReadonlyArray<{ readonly session: string; readonly branch: string }> = [
  { session: "session-a", branch: "branch-main" },
  // Pairs that would collide under naive `${session}:${branch}` encoding.
  { session: "a:", branch: "x" },
  { session: "a", branch: ":x" },
  // Slash and percent — legal in branded strings, must round-trip.
  { session: "a/b", branch: "c%d" },
  // Empty branch is legal (branded String has no length lower bound).
  { session: "lone-session", branch: "" },
]

describe("agent-loop.entity-id", () => {
  it.effect("encode + parse round-trips for all cases", () =>
    Effect.gen(function* () {
      for (const { session, branch } of cases) {
        const sid = SessionId.make(session)
        const bid = BranchId.make(branch)
        const encoded = entityIdOf(DefaultWorkspaceId, sid, bid)
        const decoded = yield* parseEntityId(encoded)
        expect(decoded.workspaceId).toBe(DefaultWorkspaceId)
        expect(decoded.sessionId).toBe(sid)
        expect(decoded.branchId).toBe(bid)
      }
    }),
  )

  test("does not collide on tricky pairs", () => {
    const a = entityIdOf(DefaultWorkspaceId, SessionId.make("a:"), BranchId.make("x"))
    const b = entityIdOf(DefaultWorkspaceId, SessionId.make("a"), BranchId.make(":x"))
    expect(a).not.toBe(b)
  })

  test("does not collide across workspaces", () => {
    const a = entityIdOf(
      WorkspaceId.make("a".repeat(64)),
      SessionId.make("same"),
      BranchId.make("same"),
    )
    const b = entityIdOf(
      WorkspaceId.make("b".repeat(64)),
      SessionId.make("same"),
      BranchId.make("same"),
    )
    expect(a).not.toBe(b)
  })

  it.effect("rejects entity ids with no separator", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parseEntityId("no-separator"))
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("rejects entity ids with malformed percent encoding", () =>
    Effect.gen(function* () {
      // `%ZZ` is not a valid percent-encoding; decodeURIComponent throws.
      const exit = yield* Effect.exit(parseEntityId("%ZZ:x"))
      expect(exit._tag).toBe("Failure")
    }),
  )
})
