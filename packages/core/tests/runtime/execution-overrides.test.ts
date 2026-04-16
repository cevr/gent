/**
 * RunSpec threading tests.
 *
 * Verifies that RunSpec (including parentToolCallId)
 * survive the full chain: client.message.send → RPC → session-commands
 * → actor-process → agentLoop.submit → resolveTurnContext → deriveAll.
 *
 * Also tests the CLI serialization round-trip used by SubprocessRunner.
 */

import { describe, test, expect } from "bun:test"
import { it } from "effect-bun-test"
import { Effect, Schema } from "effect"
import type { LoadedExtension, ExtensionTurnContext } from "@gent/core/domain/extension"
import { ToolCallId } from "@gent/core/domain/ids"
import { textStep, createSequenceProvider } from "@gent/core/debug/provider"
import { RunSpecSchema } from "@gent/core/domain/agent"
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

describe("runSpec through RPC", () => {
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
            runSpec: {
              parentToolCallId: ToolCallId.of("tc-from-parent"),
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

describe("RunSpec CLI serialization", () => {
  const codec = Schema.fromJsonString(RunSpecSchema)

  test("round-trips through JSON encode/decode", () => {
    const runSpec = {
      persistence: "ephemeral" as const,
      overrides: {
        modelId: "anthropic/claude-sonnet-4-6",
        allowedTools: ["grep", "glob", "read"],
        deniedTools: ["bash"],
        reasoningEffort: "high" as const,
        systemPromptAddendum: "Be concise.",
      },
      tags: ["subprocess-test"],
      parentToolCallId: ToolCallId.of("tc-abc-123"),
    }

    const json = Schema.encodeSync(codec)(runSpec)
    expect(typeof json).toBe("string")

    const decoded = Schema.decodeUnknownSync(codec)(json)
    expect(decoded).toEqual(runSpec)
  })

  test("round-trips with minimal runSpec", () => {
    const runSpec = { parentToolCallId: ToolCallId.of("tc-only") }
    const json = Schema.encodeSync(codec)(runSpec)
    const decoded = Schema.decodeUnknownSync(codec)(json)
    expect(decoded.parentToolCallId).toBe("tc-only")
  })

  test("round-trips empty runSpec", () => {
    const runSpec = {}
    const json = Schema.encodeSync(codec)(runSpec)
    const decoded = Schema.decodeUnknownSync(codec)(json)
    expect(decoded).toEqual({})
  })
})
