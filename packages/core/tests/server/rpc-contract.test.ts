import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { GentRpcs, WorkspaceRpcMiddleware } from "../../src/server/rpcs"
import { BranchRpcs } from "../../src/server/rpcs/branch"
import { SessionRpcs } from "../../src/server/rpcs/session"

const decodeSuccess = (
  group: typeof SessionRpcs | typeof BranchRpcs,
  key: string,
  value: unknown,
): unknown => {
  const rpc = group.requests.get(key)
  if (rpc === undefined) throw new Error(`Missing RPC ${key}`)
  return Schema.decodeUnknownSync(rpc.successSchema)(value)
}

describe("RPC contract schemas", () => {
  test("decode inlined session success payloads", () => {
    expect(
      decodeSuccess(SessionRpcs, "session.create", {
        sessionId: "session-1",
        branchId: "branch-1",
        name: "Session",
      }),
    ).toEqual({
      sessionId: "session-1",
      branchId: "branch-1",
      name: "Session",
    })

    expect(
      decodeSuccess(SessionRpcs, "session.updateReasoningLevel", {
        reasoningLevel: "medium",
      }),
    ).toEqual({ reasoningLevel: "medium" })
  })

  test("decode inlined branch success payloads", () => {
    expect(decodeSuccess(BranchRpcs, "branch.create", { branchId: "branch-1" })).toEqual({
      branchId: "branch-1",
    })
    expect(decodeSuccess(BranchRpcs, "branch.fork", { branchId: "branch-2" })).toEqual({
      branchId: "branch-2",
    })
  })

  test("all RPCs require workspace header middleware", () => {
    for (const rpc of GentRpcs.requests.values()) {
      expect(rpc.middlewares.has(WorkspaceRpcMiddleware)).toBe(true)
    }
  })
})
