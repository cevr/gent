/**
 * Execution overrides threading tests.
 *
 * Verifies that AgentExecutionOverrides (including parentToolCallId)
 * survive the full chain: client.message.send → RPC → session-commands
 * → actor-process → agentLoop.submit → resolveTurnContext → deriveAll.
 *
 * Also tests the CLI serialization round-trip used by SubprocessRunner.
 */

import { describe, test, expect } from "bun:test"
import { it } from "effect-bun-test"
import { Effect, Schema } from "effect"
import type { LoadedExtension, ExtensionTurnContext } from "@gent/core/domain/extension"
import type { ToolCallId } from "@gent/core/domain/ids"
import { textStep, createSequenceProvider } from "@gent/core/debug/provider"
import { AgentExecutionOverridesSchema } from "@gent/core/domain/agent"
import { reducerActor } from "../extensions/helpers/reducer-actor"
import { createRpcHarness } from "../extensions/helpers/rpc-harness"

// ── Test extension that captures ExtensionTurnContext ──

let capturedCtx: ExtensionTurnContext | undefined

const contextCaptureActor = reducerActor({
  id: "ctx-capture",
  initial: { seen: 0 },
  reduce: (state) => ({ state: { seen: state.seen + 1 } }),
  derive: (state, ctx) => {
    if (ctx !== undefined) {
      capturedCtx = ctx
    }
    return { uiModel: state }
  },
})

const contextCaptureExtension: LoadedExtension = {
  manifest: { id: "ctx-capture" },
  kind: "builtin",
  sourcePath: "builtin",
  setup: { actor: contextCaptureActor },
}

// ── Tests ──

describe("executionOverrides through RPC", () => {
  it.live(
    "parentToolCallId reaches ExtensionTurnContext via message.send",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          capturedCtx = undefined

          const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
          const { client } = yield* createRpcHarness({
            providerLayer,
            extensions: [contextCaptureExtension],
          })

          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          yield* client.message.send({
            sessionId,
            branchId,
            content: "test message",
            executionOverrides: {
              parentToolCallId: "tc-from-parent" as ToolCallId,
              tags: ["subprocess-test"],
            },
          })

          // Wait for the turn to complete (derive is called during turn resolution)
          yield* Effect.sleep("200 millis")

          expect(capturedCtx).toBeDefined()
          expect(capturedCtx!.parentToolCallId).toBe("tc-from-parent")
          expect(capturedCtx!.tags).toEqual(["subprocess-test"])
        }),
      ),
    { timeout: 15_000 },
  )
})

describe("AgentExecutionOverrides CLI serialization", () => {
  const codec = Schema.fromJsonString(AgentExecutionOverridesSchema)

  test("round-trips through JSON encode/decode", () => {
    const overrides = {
      modelId: "anthropic/claude-sonnet-4-6",
      allowedTools: ["grep", "glob", "read"],
      deniedTools: ["bash"],
      reasoningEffort: "high" as const,
      systemPromptAddendum: "Be concise.",
      tags: ["subprocess-test"],
      parentToolCallId: "tc-abc-123" as ToolCallId,
    }

    const json = Schema.encodeSync(codec)(overrides)
    expect(typeof json).toBe("string")

    const decoded = Schema.decodeUnknownSync(codec)(json)
    expect(decoded).toEqual(overrides)
  })

  test("round-trips with minimal overrides", () => {
    const overrides = { parentToolCallId: "tc-only" as ToolCallId }
    const json = Schema.encodeSync(codec)(overrides)
    const decoded = Schema.decodeUnknownSync(codec)(json)
    expect(decoded.parentToolCallId).toBe("tc-only")
  })

  test("round-trips empty overrides", () => {
    const overrides = {}
    const json = Schema.encodeSync(codec)(overrides)
    const decoded = Schema.decodeUnknownSync(codec)(json)
    expect(decoded).toEqual({})
  })
})
