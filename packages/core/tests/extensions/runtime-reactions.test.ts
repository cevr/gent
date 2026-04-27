import { describe, it, expect } from "effect-bun-test"
import { Cause, Data, Effect, Exit } from "effect"
import type {
  ExtensionContributions,
  ExtensionReactions,
  LoadedExtension,
  TurnAfterInput,
} from "../../src/domain/extension.js"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { compileRuntimeSlots } from "../../src/runtime/extensions/runtime-slots"

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
  scope: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({ manifest: { id }, scope, sourcePath: `/test/${id}`, contributions })

class BoomError extends Data.TaggedError("@gent/core/tests/runtime-reactions/BoomError")<{
  readonly reason: string
}> {}

const turnAfterReactions = (
  failureMode: "continue" | "isolate" | "halt",
  handler: () => Effect.Effect<void, BoomError>,
): ExtensionReactions => ({
  turnAfter: { failureMode, handler },
})

describe("runtime reactions", () => {
  it.live('"continue": failure swallowed, later reactions still fire', () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const compiled = compileRuntimeSlots([
        ext("a", "builtin", {
          reactions: turnAfterReactions("continue", () => {
            calls.push("failing")
            return Effect.fail(new BoomError({ reason: "intentional" }))
          }),
        }),
        ext("b", "builtin", {
          reactions: turnAfterReactions("continue", () =>
            Effect.sync(() => {
              calls.push("after")
            }),
          ),
        }),
      ])

      const exit = yield* Effect.exit(compiled.emitTurnAfter(stubEvent, stubCtx))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual(["failing", "after"])
    }),
  )

  it.live('"isolate": failure swallowed with warning, later reactions still fire', () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const compiled = compileRuntimeSlots([
        ext("a", "builtin", {
          reactions: turnAfterReactions("isolate", () => {
            calls.push("failing")
            return Effect.fail(new BoomError({ reason: "intentional" }))
          }),
        }),
        ext("b", "builtin", {
          reactions: turnAfterReactions("isolate", () =>
            Effect.sync(() => {
              calls.push("after")
            }),
          ),
        }),
      ])

      const exit = yield* Effect.exit(compiled.emitTurnAfter(stubEvent, stubCtx))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual(["failing", "after"])
    }),
  )

  it.live('"halt": failure surfaces as defect; later reactions do not fire', () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const compiled = compileRuntimeSlots([
        ext("a", "builtin", {
          reactions: turnAfterReactions("halt", () => {
            calls.push("halting")
            return Effect.fail(new BoomError({ reason: "critical" }))
          }),
        }),
        ext("b", "builtin", {
          reactions: turnAfterReactions("continue", () =>
            Effect.sync(() => {
              calls.push("after-halt")
            }),
          ),
        }),
      ])

      const exit = yield* Effect.exit(compiled.emitTurnAfter(stubEvent, stubCtx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
      }
      expect(calls).toEqual(["halting"])
    }),
  )

  it.live("happy path: all reactions fire in scope order", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const make = (label: string) =>
        turnAfterReactions("continue", () =>
          Effect.sync(() => {
            calls.push(label)
          }),
        )

      const compiled = compileRuntimeSlots([
        ext("z-project", "project", { reactions: make("project") }),
        ext("a-builtin", "builtin", { reactions: make("builtin") }),
        ext("m-user", "user", { reactions: make("user") }),
      ])

      yield* compiled.emitTurnAfter(stubEvent, stubCtx)
      expect(calls).toEqual(["builtin", "user", "project"])
    }),
  )
})
