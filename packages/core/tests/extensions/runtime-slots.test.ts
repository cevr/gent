import { describe, it, expect } from "effect-bun-test"
import { Cause, Data, Effect, Exit, Layer } from "effect"
import { Agents } from "@gent/extensions/all-agents"
import type {
  ContextMessagesInput,
  ExtensionContributions,
  LoadedExtension,
  SystemPromptInput,
  TurnAfterInput,
} from "@gent/core/domain/extension"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { Message, TextPart } from "@gent/core/domain/message"
import { pipeline, defineResource } from "@gent/core/domain/contribution"
import { compilePipelines } from "@gent/core/runtime/extensions/pipeline-host"
import { compileSubscriptions } from "@gent/core/runtime/extensions/subscription-host"
import { compileRuntimeSlots } from "@gent/core/runtime/extensions/runtime-slots"

const stubHostCtx = {
  sessionId: "test-session",
  branchId: "test-branch",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as ExtensionHostContext

const stubProjectionCtx = {
  sessionId: SessionId.of("test-session"),
  branchId: BranchId.of("test-branch"),
  cwd: "/tmp",
  home: "/tmp",
  turn: {
    sessionId: SessionId.of("test-session"),
    branchId: BranchId.of("test-branch"),
    agent: Agents.cowork,
    allTools: [],
    agentName: "cowork",
  },
}

const makeExt = (
  id: string,
  kind: "builtin" | "user" | "project",
  contributions: ExtensionContributions,
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  contributions,
})

class BoomError extends Data.TaggedError("@gent/core/tests/runtime-slots/BoomError")<{
  readonly reason: string
}> {}

describe("runtime slots", () => {
  it.live("systemPrompt applies legacy pipeline first, then explicit projection rewrite", () => {
    const extensions = [
      makeExt("legacy", "builtin", {
        pipelines: [
          pipeline("prompt.system", (input, next) =>
            next(input).pipe(Effect.map((out) => `${out}[legacy]`)),
          ),
        ],
      }),
      makeExt("explicit", "project", {
        projections: [
          {
            id: "prompt",
            query: () => Effect.succeed("[projection]"),
            systemPrompt: (suffix, input) => Effect.succeed(`${input.basePrompt}${suffix}`),
          },
        ],
      }),
    ]

    const slots = compileRuntimeSlots(
      extensions,
      compilePipelines(extensions),
      compileSubscriptions(extensions),
    )

    return slots
      .resolveSystemPrompt(
        { basePrompt: "base", agent: Agents.cowork } satisfies SystemPromptInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result).toBe("base[legacy][projection]"))),
      )
  })

  it.live("contextMessages applies explicit projection rewrite after legacy pipeline", () => {
    const baseMessage = new Message({
      id: "m1",
      sessionId: SessionId.of("test-session"),
      branchId: BranchId.of("test-branch"),
      role: "user",
      parts: [new TextPart({ type: "text", text: "hello" })],
      createdAt: new Date(),
    })
    const injectedMessage = new Message({
      id: "m2",
      sessionId: SessionId.of("test-session"),
      branchId: BranchId.of("test-branch"),
      role: "system",
      parts: [new TextPart({ type: "text", text: "extra" })],
      createdAt: new Date(),
    })
    const extensions = [
      makeExt("legacy", "builtin", {
        pipelines: [
          pipeline("context.messages", (input, next) =>
            next(input).pipe(Effect.map((messages) => [...messages].reverse())),
          ),
        ],
      }),
      makeExt("explicit", "project", {
        projections: [
          {
            id: "messages",
            query: () => Effect.succeed(injectedMessage),
            contextMessages: (message, input) => Effect.succeed([...input.messages, message]),
          },
        ],
      }),
    ]

    const slots = compileRuntimeSlots(
      extensions,
      compilePipelines(extensions),
      compileSubscriptions(extensions),
    )

    return slots
      .resolveContextMessages(
        {
          messages: [baseMessage],
          agent: Agents.cowork,
          sessionId: SessionId.of("test-session"),
          branchId: BranchId.of("test-branch"),
        } satisfies ContextMessagesInput,
        { projection: stubProjectionCtx, host: stubHostCtx },
      )
      .pipe(
        Effect.tap((messages) =>
          Effect.sync(() => expect(messages.map((message) => message.id)).toEqual(["m1", "m2"])),
        ),
      )
  })

  it.live("toolResult applies legacy pipeline first, then explicit resource enrichment", () => {
    const extensions = [
      makeExt("legacy", "builtin", {
        pipelines: [
          pipeline("tool.result", (input, next) =>
            next(input).pipe(Effect.map((result) => `${String(result)}-legacy`)),
          ),
        ],
      }),
      makeExt("explicit", "project", {
        resources: [
          defineResource({
            scope: "process",
            layer: Layer.empty,
            runtime: {
              toolResult: (input) => Effect.succeed(`${String(input.result)}-explicit`),
            },
          }),
        ],
      }),
    ]

    const slots = compileRuntimeSlots(
      extensions,
      compilePipelines(extensions),
      compileSubscriptions(extensions),
    )

    return slots
      .transformToolResult(
        {
          toolCallId: "tc-1",
          toolName: "echo",
          input: { text: "hello" },
          result: "base",
          sessionId: SessionId.of("test-session"),
          branchId: BranchId.of("test-branch"),
          agentName: "cowork",
        },
        stubHostCtx,
      )
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result).toBe("base-legacy-explicit"))))
  })

  it.live("turnAfter explicit reactions keep continue/isolate/halt semantics", () => {
    const calls: string[] = []
    const extensions = [
      makeExt("continue", "builtin", {
        resources: [
          defineResource({
            scope: "process",
            layer: Layer.empty,
            runtime: {
              turnAfter: {
                failureMode: "continue",
                handler: () => {
                  calls.push("continue")
                  return Effect.fail(new BoomError({ reason: "continue" }))
                },
              },
            },
          }),
        ],
      }),
      makeExt("isolate", "user", {
        resources: [
          defineResource({
            scope: "process",
            layer: Layer.empty,
            runtime: {
              turnAfter: {
                failureMode: "isolate",
                handler: () => {
                  calls.push("isolate")
                  return Effect.fail(new BoomError({ reason: "isolate" }))
                },
              },
            },
          }),
        ],
      }),
      makeExt("halt", "project", {
        resources: [
          defineResource({
            scope: "process",
            layer: Layer.empty,
            runtime: {
              turnAfter: {
                failureMode: "halt",
                handler: () => {
                  calls.push("halt")
                  return Effect.fail(new BoomError({ reason: "halt" }))
                },
              },
            },
          }),
        ],
      }),
    ]

    const slots = compileRuntimeSlots(
      extensions,
      compilePipelines(extensions),
      compileSubscriptions(extensions),
    )

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        slots.emitTurnAfter(
          {
            sessionId: SessionId.of("test-session"),
            branchId: BranchId.of("test-branch"),
            durationMs: 10,
            agentName: "cowork",
            interrupted: false,
          } satisfies TurnAfterInput,
          stubHostCtx,
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
      }
      expect(calls).toEqual(["continue", "isolate", "halt"])
    })
  })
})
