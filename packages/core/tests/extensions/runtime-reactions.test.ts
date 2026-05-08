import { describe, it, expect } from "effect-bun-test"
import { Cause, Data, Effect, Exit, Option, Schema } from "effect"
import type {
  ExtensionContributions,
  ExtensionReactions,
  LoadedExtension,
  TurnAfterInput,
} from "../../src/domain/extension.js"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"
import { BranchId, ExtensionId, SessionId } from "@gent/core-internal/domain/ids"
import {
  compileExtensionReactions,
  ExtensionReactionHaltError,
} from "../../src/runtime/extensions/extension-reactions"
import { AgentName } from "@gent/core-internal/domain/agent"

const stubCtx = testExtensionHostContext()

const stubEvent: TurnAfterInput = {
  sessionId: SessionId.make("019da5c0-0000-7000-0000-000000000001"),
  branchId: BranchId.make("019da5c0-0000-7001-0000-000000000001"),
  durationMs: 100,
  agentName: AgentName.make("cowork"),
  interrupted: false,
}

const ext = (
  id: string,
  scope: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope,
  sourcePath: `/test/${id}`,
  contributions,
})

class BoomError extends Data.TaggedError(
  "@gent/core/tests/extensions/runtime-reactions.test/BoomError",
)<{
  readonly reason: string
}> {}

const turnAfterReactions = (
  failureMode: "continue" | "isolate" | "halt",
  handler: () => Effect.Effect<void, BoomError>,
): ExtensionReactions<BoomError> => ({
  turnAfter: {
    failureMode,
    handler: (_input: TurnAfterInput) => handler(),
  },
})

describe("runtime reactions", () => {
  it.live('"continue": failure swallowed, later reactions still fire', () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const compiled = compileExtensionReactions([
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
      const compiled = compileExtensionReactions([
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

  it.live('"halt": failure surfaces as typed error; later reactions do not fire', () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const compiled = compileExtensionReactions([
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
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error)).toBe(true)
        if (Option.isSome(error)) {
          expect(Schema.is(ExtensionReactionHaltError)(error.value)).toBe(true)
        }
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

      const compiled = compileExtensionReactions([
        ext("z-project", "project", { reactions: make("project") }),
        ext("a-builtin", "builtin", { reactions: make("builtin") }),
        ext("m-user", "user", { reactions: make("user") }),
      ])

      yield* compiled.emitTurnAfter(stubEvent, stubCtx)
      expect(calls).toEqual(["builtin", "user", "project"])
    }),
  )
})
