import { describe, it, expect } from "effect-bun-test"
import { Cause, Context, Data, Effect, Exit, Ref } from "effect"
import { getBuiltinAgent } from "../../../extensions/tests/helpers/builtin-agents.js"
import type {
  ExtensionContributions,
  LoadedExtension,
  SystemPromptInput,
  TurnAfterInput,
} from "../../src/domain/extension.js"
import type { ExtensionHostContext } from "@gent/core-internal/domain/extension-host-context"
import { testExtensionHostContext } from "@gent/core-internal/test-utils"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { compileExtensionReactions } from "../../src/runtime/extensions/extension-reactions"
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
  "@gent/core/tests/extensions/extension-reactions.test/BoomError",
)<{
  readonly reason: string
}> {}

class ReactionCounter extends Context.Service<
  ReactionCounter,
  {
    readonly increment: Effect.Effect<void>
    readonly get: Effect.Effect<number>
  }
>()("@gent/core/tests/extensions/extension-reactions.test/ReactionCounter") {}

describe("runtime slots", () => {
  it.live("systemPrompt composes explicit reaction rewrites in scope order", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        reactions: {
          systemPrompt: (input) => Effect.succeed(`${input.basePrompt}[builtin]`),
        },
      }),
      makeExt("project", "project", {
        reactions: {
          systemPrompt: (input) => Effect.succeed(`${input.basePrompt}[project]`),
        },
      }),
    ]

    const slots = compileExtensionReactions(extensions)

    return slots
      .resolveSystemPrompt(
        { basePrompt: "base", agent: getBuiltinAgent("cowork")! } satisfies SystemPromptInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin][project]"))),
      )
  })

  it.live("systemPrompt isolates failing reaction rewrites", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        reactions: {
          systemPrompt: (input) => Effect.succeed(`${input.basePrompt}[builtin-reaction]`),
        },
      }),
      makeExt("project", "project", {
        reactions: {
          systemPrompt: () => Effect.fail(new BoomError({ reason: "bad prompt" })),
        },
      }),
    ]

    const slots = compileExtensionReactions(extensions)

    return slots
      .resolveSystemPrompt(
        { basePrompt: "base", agent: getBuiltinAgent("cowork")! } satisfies SystemPromptInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[builtin-reaction]"))),
      )
  })

  it.live("systemPrompt receives host authority through ExtensionContext", () =>
    Effect.gen(function* () {
      const sawProcessAuthority = yield* Ref.make(false)
      const slots = compileExtensionReactions([
        makeExt("readonly", "project", {
          reactions: {
            systemPrompt: () =>
              Effect.gen(function* () {
                const ctx = yield* ExtensionContext
                yield* Ref.set(sawProcessAuthority, "run" in ctx.Process)
                return "readonly"
              }),
          },
        }),
      ])

      const result = yield* slots.resolveSystemPrompt(
        {
          basePrompt: "base",
          agent: getBuiltinAgent("cowork")!,
        },
        {
          projection: stubProjectionCtx,
          host: stubHostCtx,
        },
      )

      expect(result).toBe("readonly")
      expect(yield* Ref.get(sawProcessAuthority)).toBe(true)
    }),
  )

  it.live("toolResult applies explicit resource enrichments in scope order", () => {
    const extensions = [
      makeExt("builtin", "builtin", {
        reactions: {
          toolResult: (input) => Effect.succeed(`${String(input.result)}-builtin`),
        },
      }),
      makeExt("explicit", "project", {
        reactions: {
          toolResult: (input) => Effect.succeed(`${String(input.result)}-explicit`),
        },
      }),
    ]

    const slots = compileExtensionReactions(extensions)

    return slots
      .transformToolResult(
        {
          toolCallId: ToolCallId.make("tc-1"),
          toolName: "echo",
          input: { text: "hello" },
          result: "base",
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          agentName: AgentName.make("cowork"),
        },
        stubHostCtx,
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("base-builtin-explicit"))))
  })

  it.live("turnAfter explicit reactions keep continue/isolate/halt semantics", () => {
    const calls: string[] = []
    const extensions = [
      makeExt("continue", "builtin", {
        reactions: {
          turnAfter: {
            failureMode: "continue",
            handler: () => {
              calls.push("continue")
              return Effect.fail(new BoomError({ reason: "continue" }))
            },
          },
        },
      }),
      makeExt("isolate", "user", {
        reactions: {
          turnAfter: {
            failureMode: "isolate",
            handler: () => {
              calls.push("isolate")
              return Effect.fail(new BoomError({ reason: "isolate" }))
            },
          },
        },
      }),
      makeExt("halt", "project", {
        reactions: {
          turnAfter: {
            failureMode: "halt",
            handler: () => {
              calls.push("halt")
              return Effect.fail(new BoomError({ reason: "halt" }))
            },
          },
        },
      }),
    ]

    const slots = compileExtensionReactions(extensions)

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        slots.emitTurnAfter(
          {
            sessionId: SessionId.make("test-session"),
            branchId: BranchId.make("test-branch"),
            durationMs: 10,
            agentName: AgentName.make("cowork"),
            interrupted: false,
          } satisfies TurnAfterInput,
          stubHostCtx,
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(false)
      expect(calls).toEqual(["continue", "isolate", "halt"])
    })
  })

  it.live("turnAfter receives host authority through ExtensionContext", () =>
    Effect.gen(function* () {
      const sawProcessAuthority = yield* Ref.make(false)
      const slots = compileExtensionReactions([
        makeExt("readonly-lifecycle", "project", {
          reactions: {
            turnAfter: {
              failureMode: "halt",
              handler: () =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  yield* Ref.set(sawProcessAuthority, "run" in ctx.Process)
                }),
            },
          },
        }),
      ])

      yield* slots.emitTurnAfter(
        {
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          durationMs: 10,
          agentName: AgentName.make("cowork"),
          interrupted: false,
        } satisfies TurnAfterInput,
        stubHostCtx,
      )

      expect(yield* Ref.get(sawProcessAuthority)).toBe(true)
    }),
  )

  it.live("turnAfter reactions run inside lifecycle capability context", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(0)
      const counter = {
        increment: Ref.update(ref, (n) => n + 1),
        get: Ref.get(ref),
      }
      const slots = compileExtensionReactions([
        makeExt("resource-backed", "builtin", {
          reactions: {
            turnAfter: {
              failureMode: "halt",
              handler: () =>
                Effect.gen(function* () {
                  const service = yield* ReactionCounter
                  yield* service.increment
                }),
            },
          },
        }),
      ])
      const hostCtx = {
        ...stubHostCtx,
        capabilityContext: Context.make(ReactionCounter, counter),
      } satisfies ExtensionHostContext

      yield* slots.emitTurnAfter(
        {
          sessionId: SessionId.make("test-session"),
          branchId: BranchId.make("test-branch"),
          durationMs: 10,
          agentName: AgentName.make("cowork"),
          interrupted: false,
        } satisfies TurnAfterInput,
        hostCtx,
      )

      const count = yield* counter.get
      expect(count).toBe(1)
    }),
  )
})
