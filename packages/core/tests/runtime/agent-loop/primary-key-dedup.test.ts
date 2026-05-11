/**
 * Regression: distinct `commandId` values for the same `(workspaceId,
 * sessionId, branchId)` must produce distinct `primaryKey` components in
 * each op's `ExecId`. Otherwise concurrent intents collapse via dedup —
 * a second `GetState`/`GetQueue`/`TerminateBranch` would silently piggyback
 * on the first instead of running independently.
 *
 * `ExecId` encoding is `${entityId}\x00${tag}\x00${primaryKey}` (see
 * effect-encore/src/actor.ts), so checking the encoded ExecId lets us
 * assert primaryKey divergence purely from the op-handle layer without
 * spinning up a runtime.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { ActorCommandId, BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { DefaultWorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { AgentLoop } from "../../../src/runtime/agent/agent-loop.actor"

describe("agent-loop op primary keys", () => {
  const workspaceId = DefaultWorkspaceId
  const sessionId = SessionId.make("primary-key-session")
  const branchId = BranchId.make("primary-key-branch")
  const cmd1 = ActorCommandId.make("cmd-1")
  const cmd2 = ActorCommandId.make("cmd-2")

  it.live("GetState with distinct commandIds produces distinct ExecIds on the same entity", () =>
    Effect.gen(function* () {
      const id1 = yield* AgentLoop.GetState.executionId({
        workspaceId,
        sessionId,
        branchId,
        commandId: cmd1,
      })
      const id2 = yield* AgentLoop.GetState.executionId({
        workspaceId,
        sessionId,
        branchId,
        commandId: cmd2,
      })
      expect(String(id1)).not.toBe(String(id2))
      expect(String(id1).endsWith(`\x00${cmd1}`)).toBe(true)
      expect(String(id2).endsWith(`\x00${cmd2}`)).toBe(true)
    }),
  )

  it.live("GetQueue with distinct commandIds produces distinct ExecIds on the same entity", () =>
    Effect.gen(function* () {
      const id1 = yield* AgentLoop.GetQueue.executionId({
        workspaceId,
        sessionId,
        branchId,
        commandId: cmd1,
      })
      const id2 = yield* AgentLoop.GetQueue.executionId({
        workspaceId,
        sessionId,
        branchId,
        commandId: cmd2,
      })
      expect(String(id1)).not.toBe(String(id2))
      expect(String(id1).endsWith(`\x00${cmd1}`)).toBe(true)
      expect(String(id2).endsWith(`\x00${cmd2}`)).toBe(true)
    }),
  )

  it.live(
    "TerminateBranch with distinct commandIds produces distinct ExecIds on the same entity",
    () =>
      Effect.gen(function* () {
        const id1 = yield* AgentLoop.TerminateBranch.executionId({
          workspaceId,
          sessionId,
          branchId,
          commandId: cmd1,
        })
        const id2 = yield* AgentLoop.TerminateBranch.executionId({
          workspaceId,
          sessionId,
          branchId,
          commandId: cmd2,
        })
        expect(String(id1)).not.toBe(String(id2))
        expect(String(id1).endsWith(`\x00${cmd1}`)).toBe(true)
        expect(String(id2).endsWith(`\x00${cmd2}`)).toBe(true)
      }),
  )
})
