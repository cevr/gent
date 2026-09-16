import { describe, it, expect } from "effect-bun-test"
import { Context, Data, Effect, Exit, Ref } from "effect"
import { BunServices } from "@effect/platform-bun"
import { getBuiltinAgent } from "../../../extensions/tests/helpers/builtin-agents.js"
import type {
  ExtensionContributions,
  LoadedExtension,
  SystemPromptInput,
  TurnAfterInput,
} from "../../src/domain/extension.js"
import { hook } from "../../src/domain/extension.js"
import type { ExtensionHostContext } from "../../src/domain/extension-services"
import { testExtensionHostContext } from "../../src/test-utils"
import { BranchId, ExtensionId, SessionId } from "../../src/domain/ids"
import { compileExtensionHooks } from "../../src/runtime/extensions/extension-hooks"
import { provideCurrentCapabilityContext } from "../../src/runtime/extensions/extension-capability-context"
import { CurrentExtensionHostContext } from "../../src/runtime/agent/current-extension-host-context"
import { AgentName } from "../../src/domain/agent"
import { ExtensionContext } from "../../src/domain/extension-services.js"

const stubHostCtx = testExtensionHostContext()

const makeExt = (
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
  "@gent/core/tests/extensions/extension-hooks.test/BoomError",
)<{
  readonly reason: string
}> {}

class HookCounter extends Context.Service<
  HookCounter,
  {
    readonly increment: Effect.Effect<void>
    readonly get: Effect.Effect<number>
  }
>()("@gent/core/tests/extensions/extension-hooks.test/HookCounter") {}

describe("runtime slots", () => {
  const test = it.live.layer(BunServices.layer)

  test("systemPrompt composes explicit hook rewrites in scope order", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        hooks: [hook("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}[builtin]`))],
      }),
      makeExt("project", "project", {
        hooks: [hook("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}[project]`))],
      }),
    ]

    const slots = compileExtensionHooks(extensions)

    return slots
      .resolveSystemPrompt({
        basePrompt: "base",
        agent: getBuiltinAgent("cowork")!,
      } satisfies SystemPromptInput)
      .pipe(
        Effect.provideService(CurrentExtensionHostContext, stubHostCtx),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin][project]"))),
      )
  })

  test("systemPrompt isolates failing hook rewrites", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        hooks: [
          hook("systemPrompt", (input) => Effect.succeed(`${input.basePrompt}[builtin-hook]`)),
        ],
      }),
      makeExt("project", "project", {
        hooks: [hook("systemPrompt", () => Effect.fail(new BoomError({ reason: "bad prompt" })))],
      }),
    ]

    const slots = compileExtensionHooks(extensions)

    return slots
      .resolveSystemPrompt({
        basePrompt: "base",
        agent: getBuiltinAgent("cowork")!,
      } satisfies SystemPromptInput)
      .pipe(
        Effect.provideService(CurrentExtensionHostContext, stubHostCtx),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin-hook]"))),
      )
  })

  test("systemPrompt receives host authority through ExtensionContext", () =>
    Effect.gen(function* () {
      const sawProcessAuthority = yield* Ref.make(false)
      const slots = compileExtensionHooks([
        makeExt("readonly", "project", {
          hooks: [
            hook("systemPrompt", () =>
              Effect.gen(function* () {
                const ctx = yield* ExtensionContext
                yield* Ref.set(sawProcessAuthority, "run" in ctx.Process)
                return "readonly"
              }),
            ),
          ],
        }),
      ])

      const result = yield* slots
        .resolveSystemPrompt({
          basePrompt: "base",
          agent: getBuiltinAgent("cowork")!,
        })
        .pipe(Effect.provideService(CurrentExtensionHostContext, stubHostCtx))

      expect(result).toBe("readonly")
      expect(yield* Ref.get(sawProcessAuthority)).toBe(true)
    }))

  test("turnAfter isolates failing hooks; all handlers still run", () => {
    const calls: string[] = []
    const extensions = [
      makeExt("first", "builtin", {
        hooks: [
          hook("turnAfter", () => {
            calls.push("first")
            return Effect.fail(new BoomError({ reason: "first" }))
          }),
        ],
      }),
      makeExt("second", "user", {
        hooks: [
          hook("turnAfter", () => {
            calls.push("second")
            return Effect.fail(new BoomError({ reason: "second" }))
          }),
        ],
      }),
      makeExt("third", "project", {
        hooks: [
          hook("turnAfter", () => {
            calls.push("third")
            return Effect.fail(new BoomError({ reason: "third" }))
          }),
        ],
      }),
    ]

    const slots = compileExtensionHooks(extensions)

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        slots
          .emitTurnAfter({
            sessionId: SessionId.make("test-session"),
            branchId: BranchId.make("test-branch"),
            durationMs: 10,
            agentName: AgentName.make("cowork"),
            interrupted: false,
            streamFailed: false,
            usage: { inputTokens: 0, outputTokens: 0 },
          } satisfies TurnAfterInput)
          .pipe(Effect.provideService(CurrentExtensionHostContext, stubHostCtx)),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual(["first", "second", "third"])
    })
  })

  test("turnAfter receives host authority through ExtensionContext", () =>
    Effect.gen(function* () {
      const sawProcessAuthority = yield* Ref.make(false)
      const slots = compileExtensionHooks([
        makeExt("readonly-lifecycle", "project", {
          hooks: [
            hook("turnAfter", () =>
              Effect.gen(function* () {
                const ctx = yield* ExtensionContext
                yield* Ref.set(sawProcessAuthority, "run" in ctx.Process)
              }),
            ),
          ],
        }),
      ])

      yield* slots
        .emitTurnAfter({
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          durationMs: 10,
          agentName: AgentName.make("cowork"),
          interrupted: false,
          streamFailed: false,
          usage: { inputTokens: 0, outputTokens: 0 },
        } satisfies TurnAfterInput)
        .pipe(Effect.provideService(CurrentExtensionHostContext, stubHostCtx))

      expect(yield* Ref.get(sawProcessAuthority)).toBe(true)
    }))

  test("turnAfter hooks run inside lifecycle capability context", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(0)
      const counter = {
        increment: Ref.update(ref, (n) => n + 1),
        get: Ref.get(ref),
      }
      const slots = compileExtensionHooks([
        makeExt("resource-backed", "builtin", {
          hooks: [
            hook("turnAfter", () =>
              Effect.gen(function* () {
                const service = yield* HookCounter
                yield* service.increment
              }),
            ),
          ],
        }),
      ])
      const hostCtx: ExtensionHostContext = stubHostCtx

      yield* slots
        .emitTurnAfter({
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          durationMs: 10,
          agentName: AgentName.make("cowork"),
          interrupted: false,
          streamFailed: false,
          usage: { inputTokens: 0, outputTokens: 0 },
        } satisfies TurnAfterInput)
        .pipe(
          Effect.provideService(CurrentExtensionHostContext, hostCtx),
          provideCurrentCapabilityContext(Context.make(HookCounter, counter)),
        )

      const count = yield* counter.get
      expect(count).toBe(1)
    }))
})
