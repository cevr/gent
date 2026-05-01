import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { BranchId, InteractionRequestId, SessionId } from "../../src/domain/ids.js"
import { HostApprovalServiceRef } from "../../src/runtime/make-extension-host-context.js"

describe("HostApprovalServiceRef", () => {
  it.live("default pendingRequestId fails when ApprovalService is missing", () =>
    Effect.gen(function* () {
      const approval = yield* HostApprovalServiceRef
      const exit = yield* Effect.exit(
        approval.pendingRequestId({
          sessionId: SessionId.make("missing-approval-session"),
          branchId: BranchId.make("missing-approval-branch"),
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(exit.cause.toString()).toContain("ApprovalService not available")
      }
    }),
  )

  it.live("default storeResolution fails when ApprovalService is missing", () =>
    Effect.gen(function* () {
      const approval = yield* HostApprovalServiceRef
      const exit = yield* Effect.exit(
        approval.storeResolution(InteractionRequestId.make("missing-approval-request"), {
          approved: true,
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(exit.cause.toString()).toContain("ApprovalService not available")
      }
    }),
  )
})
