/**
 * SubscriptionHost failure-mode locks (Phase 6 Gate 6).
 *
 * Pins the per-subscription `failureMode` semantics:
 *   - "continue" — log debug, swallow, fan-out continues
 *   - "isolate"  — log warning with extension id, swallow, fan-out continues
 *   - "halt"     — log error, surface as defect; subsequent subscribers DO NOT fire
 *
 * The plan calls Subscription "the codex C6 correction" — `Interceptor<I, void>`
 * was a deceptive shape because `next` was bookkeeping. The honest split is
 * Pipeline (transformer with real `next`) vs Subscription (ordered observer
 * with declared failure policy). These tests are the runtime proof.
 */
import { describe, it, expect } from "effect-bun-test"
import { Cause, Data, Effect, Exit } from "effect"
import { defineSubscription } from "@gent/core/domain/subscription"
import type {
  ExtensionContributions,
  LoadedExtension,
  TurnAfterInput,
} from "@gent/core/domain/extension"
import { compileSubscriptions } from "@gent/core/runtime/extensions/subscription-host"
import { subscription as subscriptionContribution } from "@gent/core/domain/contribution"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { BranchId, SessionId } from "@gent/core/domain/ids"

const stubCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const stubEvent: TurnAfterInput = {
  sessionId: SessionId.make("019da5c0-0000-7000-0000-000000000001"),
  branchId: BranchId.make("019da5c0-0000-7001-0000-000000000001"),
  durationMs: 100,
  agentName: "cowork",
  interrupted: false,
}

const ext = (
  id: string,
  kind: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({ manifest: { id }, kind, sourcePath: `/test/${id}`, contributions })

class BoomError extends Data.TaggedError("@gent/core/tests/subscription-host/BoomError")<{
  readonly reason: string
}> {}

describe("subscription host", () => {
  it.live('"continue": failure swallowed, next subscriber still fires', () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const failing = defineSubscription("turn.after", "continue", () => {
        calls.push("failing")
        return Effect.fail(new BoomError({ reason: "intentional" }))
      })
      const after = defineSubscription("turn.after", "continue", () =>
        Effect.sync(() => {
          calls.push("after")
        }),
      )

      const compiled = compileSubscriptions([
        ext("a", "builtin", { subscriptions: [subscriptionContribution(failing)] }),
        ext("b", "builtin", { subscriptions: [subscriptionContribution(after)] }),
      ])

      const exit = yield* Effect.exit(compiled.emit("turn.after", stubEvent, stubCtx))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual(["failing", "after"])
    }),
  )

  it.live('"isolate": failure swallowed with warning, next subscriber still fires', () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const failing = defineSubscription("turn.after", "isolate", () => {
        calls.push("failing")
        return Effect.fail(new BoomError({ reason: "intentional" }))
      })
      const after = defineSubscription("turn.after", "isolate", () =>
        Effect.sync(() => {
          calls.push("after")
        }),
      )

      const compiled = compileSubscriptions([
        ext("a", "builtin", { subscriptions: [subscriptionContribution(failing)] }),
        ext("b", "builtin", { subscriptions: [subscriptionContribution(after)] }),
      ])

      const exit = yield* Effect.exit(compiled.emit("turn.after", stubEvent, stubCtx))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual(["failing", "after"])
    }),
  )

  it.live('"halt": failure surfaces as defect; subsequent subscribers DO NOT fire', () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const halting = defineSubscription("turn.after", "halt", () => {
        calls.push("halting")
        return Effect.fail(new BoomError({ reason: "critical" }))
      })
      const afterHalt = defineSubscription("turn.after", "continue", () =>
        Effect.sync(() => {
          calls.push("after-halt")
        }),
      )

      const compiled = compileSubscriptions([
        ext("a", "builtin", { subscriptions: [subscriptionContribution(halting)] }),
        ext("b", "builtin", { subscriptions: [subscriptionContribution(afterHalt)] }),
      ])

      const exit = yield* Effect.exit(compiled.emit("turn.after", stubEvent, stubCtx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
      }
      // halt fires, after-halt does NOT
      expect(calls).toEqual(["halting"])
    }),
  )

  it.live("happy path: all subscribers fire in scope order (builtin → user → project)", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const make = (label: string) =>
        defineSubscription("turn.after", "continue", () =>
          Effect.sync(() => {
            calls.push(label)
          }),
        )

      const compiled = compileSubscriptions([
        // pass out of order to prove sorting
        ext("z-project", "project", { subscriptions: [subscriptionContribution(make("project"))] }),
        ext("a-builtin", "builtin", { subscriptions: [subscriptionContribution(make("builtin"))] }),
        ext("m-user", "user", { subscriptions: [subscriptionContribution(make("user"))] }),
      ])

      yield* compiled.emit("turn.after", stubEvent, stubCtx)
      expect(calls).toEqual(["builtin", "user", "project"])
    }),
  )

  it.live("empty registry is a no-op", () =>
    Effect.gen(function* () {
      const compiled = compileSubscriptions([])
      const exit = yield* Effect.exit(compiled.emit("turn.after", stubEvent, stubCtx))
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )
})
