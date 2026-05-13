import { describe, it, expect } from "effect-bun-test"
import { Context, Data, Effect, Exit, Ref } from "effect"
import { BunServices } from "@effect/platform-bun"
import { getBuiltinAgent } from "../../../extensions/tests/helpers/builtin-agents.js"
import type {
  ExtensionContributions,
  LoadedExtension,
  SystemPromptInput,
  ToolCallInput,
  TurnAfterInput,
} from "../../src/domain/extension.js"
import { hook } from "../../src/domain/extension.js"
import type { ExtensionHostContext } from "@gent/core-internal/domain/extension-host-context"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { compileExtensionHooks } from "../../src/runtime/extensions/extension-hooks"
import { provideCurrentCapabilityContext } from "../../src/runtime/extensions/extension-capability-context"
import {
  provideExtensionHookContext,
  provideHookHostContext,
} from "../../src/runtime/extensions/extension-hook-context"
import { AgentName } from "@gent/core-internal/domain/agent"
import { ExtensionContext } from "../../src/domain/extension-services.js"

const stubHostCtx = testExtensionHostContext()

const stubProjectionCtx = {
  sessionId: SessionId.make("test-session"),
  branchId: BranchId.make("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.make("test-session"),
    branchId: BranchId.make("test-branch"),
    agent: getBuiltinAgent("cowork")!,
    allTools: [],
    agentName: AgentName.make("cowork"),
  },
}

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
        hooks: [hook.systemPrompt((input) => Effect.succeed(`${input.basePrompt}[builtin]`))],
      }),
      makeExt("project", "project", {
        hooks: [hook.systemPrompt((input) => Effect.succeed(`${input.basePrompt}[project]`))],
      }),
    ]

    const slots = compileExtensionHooks(extensions)

    return slots
      .resolveSystemPrompt({
        basePrompt: "base",
        agent: getBuiltinAgent("cowork")!,
      } satisfies SystemPromptInput)
      .pipe(
        provideExtensionHookContext({ projection: stubProjectionCtx, host: stubHostCtx }),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin][project]"))),
      )
  })

  test("systemPrompt isolates failing hook rewrites", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        hooks: [hook.systemPrompt((input) => Effect.succeed(`${input.basePrompt}[builtin-hook]`))],
      }),
      makeExt("project", "project", {
        hooks: [hook.systemPrompt(() => Effect.fail(new BoomError({ reason: "bad prompt" })))],
      }),
    ]

    const slots = compileExtensionHooks(extensions)

    return slots
      .resolveSystemPrompt({
        basePrompt: "base",
        agent: getBuiltinAgent("cowork")!,
      } satisfies SystemPromptInput)
      .pipe(
        provideExtensionHookContext({ projection: stubProjectionCtx, host: stubHostCtx }),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin-hook]"))),
      )
  })

  test("systemPrompt receives host authority through ExtensionContext", () =>
    Effect.gen(function* () {
      const sawProcessAuthority = yield* Ref.make(false)
      const slots = compileExtensionHooks([
        makeExt("readonly", "project", {
          hooks: [
            hook.systemPrompt(() =>
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
        .pipe(provideExtensionHookContext({ projection: stubProjectionCtx, host: stubHostCtx }))

      expect(result).toBe("readonly")
      expect(yield* Ref.get(sawProcessAuthority)).toBe(true)
    }))

  test("toolResult applies explicit resource enrichments in scope order", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        hooks: [hook.toolResult((input) => Effect.succeed(`${String(input.result)}-builtin`))],
      }),
      makeExt("explicit", "project", {
        hooks: [hook.toolResult((input) => Effect.succeed(`${String(input.result)}-explicit`))],
      }),
    ]

    const slots = compileExtensionHooks(extensions)

    return slots
      .transformToolResult({
        toolCallId: ToolCallId.make("tc-1"),
        toolName: "echo",
        input: { text: "hello" },
        result: "base",
        sessionId: SessionId.make("test-session"),
        branchId: BranchId.make("test-branch"),
        agentName: AgentName.make("cowork"),
      })
      .pipe(
        provideHookHostContext(stubHostCtx),
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base-builtin-explicit"))),
      )
  })

  test("toolCall hook returns first deny decision in scope order", () => {
    const slots = compileExtensionHooks([
      makeExt("builtin", "builtin", {
        hooks: [
          hook.toolCall(() => Effect.undefined),
          hook.toolCall(() =>
            Effect.succeed({
              _tag: "deny" as const,
              message: "blocked by hook",
              result: { error: "blocked" },
            }),
          ),
        ],
      }),
      makeExt("project", "project", {
        hooks: [
          hook.toolCall(() =>
            Effect.succeed({
              _tag: "deny" as const,
              message: "project should not run",
            }),
          ),
        ],
      }),
    ])

    return slots
      .preflightToolCall({
        toolCallId: ToolCallId.make("tc-1"),
        toolName: "echo",
        input: {},
        sessionId: SessionId.make("test-session"),
        branchId: BranchId.make("test-branch"),
        agentName: AgentName.make("cowork"),
      } satisfies ToolCallInput)
      .pipe(
        provideHookHostContext(stubHostCtx),
        Effect.tap((result) =>
          Effect.sync(() =>
            expect(result).toEqual({
              _tag: "deny",
              message: "blocked by hook",
              result: { error: "blocked" },
            }),
          ),
        ),
      )
  })

  test("turnAfter isolates failing hooks; all handlers still run", () => {
    const calls: string[] = []
    const extensions = [
      makeExt("first", "builtin", {
        hooks: [
          hook.turnAfter(() => {
            calls.push("first")
            return Effect.fail(new BoomError({ reason: "first" }))
          }),
        ],
      }),
      makeExt("second", "user", {
        hooks: [
          hook.turnAfter(() => {
            calls.push("second")
            return Effect.fail(new BoomError({ reason: "second" }))
          }),
        ],
      }),
      makeExt("third", "project", {
        hooks: [
          hook.turnAfter(() => {
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
          } satisfies TurnAfterInput)
          .pipe(provideHookHostContext(stubHostCtx)),
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
            hook.turnAfter(() =>
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
        } satisfies TurnAfterInput)
        .pipe(provideHookHostContext(stubHostCtx))

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
            hook.turnAfter(() =>
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
        } satisfies TurnAfterInput)
        .pipe(
          provideHookHostContext(hostCtx),
          provideCurrentCapabilityContext(Context.make(HookCounter, counter)),
        )

      const count = yield* counter.get
      expect(count).toBe(1)
    }))
})
