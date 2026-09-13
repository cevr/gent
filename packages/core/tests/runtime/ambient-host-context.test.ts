/**
 * The ambient host context resolves each facet from its own service Tag.
 *
 * A facet whose service is absent from the ambient context is not an error at
 * build time: the context still assembles, and the facet reports the absence
 * only if something calls it. That keeps a deployment that ships no approval
 * flow from having to provide a stub for one.
 */
import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { BranchId, SessionId } from "../../src/domain/ids.js"
import { makeExtensionHostContextProvider } from "../../src/runtime/make-extension-host-context.js"
import { ApprovalService } from "../../src/runtime/approval-service.js"
import { resolveExtensions } from "../../src/runtime/extensions/registry.js"

const sessionId = SessionId.make("ambient-host-session")
const branchId = BranchId.make("ambient-host-branch")
const request = { text: "Approve?", metadata: {} }

const resolved = resolveExtensions([])

const ambientContext = Effect.gen(function* () {
  const provider = yield* makeExtensionHostContextProvider({
    extensionRegistry: { extensionHooks: resolved.extensionHooks, getResolved: () => resolved },
  })
  return provider.forRun({ sessionId, branchId })
})

describe("ambient extension host context", () => {
  it.live("assembles with no host services in scope", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      expect(ctx.sessionId).toBe(sessionId)
      expect(ctx.branchId).toBe(branchId)
    }),
  )

  it.live("reports the absence only when an unwired facet is called", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      const exit = yield* Effect.exit(ctx.Interaction.approve(request))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(exit.cause.toString()).toContain("ApprovalService not available")
      }
    }),
  )

  it.live("uses the real service once its Tag is in scope", () =>
    Effect.gen(function* () {
      const ctx = yield* ambientContext
      expect(yield* ctx.Interaction.approve(request)).toStrictEqual({ approved: true })
    }).pipe(
      Effect.provideService(ApprovalService, {
        present: () => Effect.succeed({ approved: true }),
        pendingRequestId: () => Effect.die("not used"),
        storeResolution: () => Effect.die("not used"),
        respond: () => Effect.void,
        rehydrate: () => Effect.void,
      }),
    ),
  )
})
