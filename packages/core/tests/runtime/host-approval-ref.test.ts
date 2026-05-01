import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { BranchId, InteractionRequestId, SessionId } from "../../src/domain/ids.js"
import { HostApprovalServiceRef } from "../../src/runtime/make-extension-host-context.js"

const sessionId = SessionId.make("missing-approval-session")
const branchId = BranchId.make("missing-approval-branch")
const requestId = InteractionRequestId.make("missing-approval-request")

const expectMissingApprovalDefect = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(exit.cause.toString()).toContain("ApprovalService not available")
    }
  })

describe("HostApprovalServiceRef", () => {
  it.live("default present fails when ApprovalService is missing", () =>
    Effect.gen(function* () {
      const approval = yield* HostApprovalServiceRef
      yield* expectMissingApprovalDefect(
        approval.present(
          {
            text: "Approve?",
            metadata: {},
          },
          { sessionId, branchId },
        ),
      )
    }),
  )

  it.live("default pendingRequestId fails when ApprovalService is missing", () =>
    Effect.gen(function* () {
      const approval = yield* HostApprovalServiceRef
      yield* expectMissingApprovalDefect(
        approval.pendingRequestId({
          sessionId,
          branchId,
        }),
      )
    }),
  )

  it.live("default storeResolution fails when ApprovalService is missing", () =>
    Effect.gen(function* () {
      const approval = yield* HostApprovalServiceRef
      yield* expectMissingApprovalDefect(
        approval.storeResolution(requestId, {
          approved: true,
        }),
      )
    }),
  )

  it.live("default respond fails when ApprovalService is missing", () =>
    Effect.gen(function* () {
      const approval = yield* HostApprovalServiceRef
      yield* expectMissingApprovalDefect(approval.respond(requestId))
    }),
  )

  it.live("default rehydrate fails when ApprovalService is missing", () =>
    Effect.gen(function* () {
      const approval = yield* HostApprovalServiceRef
      yield* expectMissingApprovalDefect(
        approval.rehydrate(
          requestId,
          {
            text: "Approve?",
            metadata: {},
          },
          { sessionId, branchId },
        ),
      )
    }),
  )
})
