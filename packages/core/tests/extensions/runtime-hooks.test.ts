import { describe, it, expect } from "effect-bun-test"
import { Data, Effect, Exit } from "effect"
import { BunServices } from "@effect/platform-bun"
import type {
  ExtensionContributions,
  LoadedExtension,
  TurnAfterInput,
} from "../../src/domain/extension.js"
import { hook } from "../../src/domain/extension.js"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"
import { BranchId, ExtensionId, SessionId } from "@gent/core-internal/domain/ids"
import { compileExtensionHooks } from "../../src/runtime/extensions/extension-hooks"
import { provideHookHostContext } from "../../src/runtime/extensions/extension-hook-context"
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
  "@gent/core/tests/extensions/runtime-hooks.test/BoomError",
)<{
  readonly reason: string
}> {}

const turnAfterHooks = (handler: () => Effect.Effect<void, BoomError>) => [
  hook.turnAfter((_input: TurnAfterInput) => handler()),
]

describe("runtime hooks", () => {
  const test = it.live.layer(BunServices.layer)

  test("failure is isolated; later hooks still fire", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const compiled = compileExtensionHooks([
        ext("a", "builtin", {
          hooks: turnAfterHooks(() => {
            calls.push("failing")
            return Effect.fail(new BoomError({ reason: "intentional" }))
          }),
        }),
        ext("b", "builtin", {
          hooks: turnAfterHooks(() =>
            Effect.sync(() => {
              calls.push("after")
            }),
          ),
        }),
      ])

      const exit = yield* Effect.exit(
        compiled.emitTurnAfter(stubEvent).pipe(provideHookHostContext(stubCtx)),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual(["failing", "after"])
    }))

  test("happy path: all hooks fire in scope order", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const make = (label: string) =>
        turnAfterHooks(() =>
          Effect.sync(() => {
            calls.push(label)
          }),
        )

      const compiled = compileExtensionHooks([
        ext("z-project", "project", { hooks: make("project") }),
        ext("a-builtin", "builtin", { hooks: make("builtin") }),
        ext("m-user", "user", { hooks: make("user") }),
      ])

      yield* compiled.emitTurnAfter(stubEvent).pipe(provideHookHostContext(stubCtx))
      expect(calls).toEqual(["builtin", "user", "project"])
    }))
})
