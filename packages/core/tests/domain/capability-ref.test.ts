/**
 * Asserts the typed-ref accessor invariants for capability tokens:
 *
 * 1. `request(...)` attaches a `CapabilityRef` under the `CAPABILITY_REF`
 *    symbol (private — only `ref(token)` reads it).
 * 2. `ref(requestToken)` returns the typed ref with the same id/intent
 *    metadata the author provided.
 * 3. `ref(toolToken)` and `ref(actionToken)` throw with a descriptive
 *    message — only request tokens carry a ref.
 *
 * The `CAPABILITY_REF` symbol's privacy is structural (a `unique symbol`
 * non-exported by name), so the runtime invariant "tool/action tokens
 * never carry a ref" is what `ref(...)` enforces in practice. If a future
 * factory accidentally attached the symbol, this test would not catch it
 * — that surface is fenced by the factories themselves at construction.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { action, ref, request, tool } from "@gent/core/extensions/api"

describe("ref(token)", () => {
  test("returns the typed ref for a request token, preserving id + intent", () => {
    const token = request({
      id: "test.read",
      extensionId: "ext-test",
      intent: "read",
      input: Schema.Struct({ q: Schema.String }),
      output: Schema.Struct({ n: Schema.Number }),
      execute: () => Effect.succeed({ n: 1 }),
    })

    const r = ref(token)
    expect(r.capabilityId).toBe("test.read")
    expect(r.extensionId).toBe("ext-test")
    expect(r.intent).toBe("read")
    expect(r.input).toBeDefined()
    expect(r.output).toBeDefined()
  })

  test("throws for a tool token (no ref attached) with a descriptive message", () => {
    const token = tool({
      id: "test.tool",
      description: "ephemeral",
      params: Schema.Struct({ x: Schema.String }),
      execute: () => Effect.succeed("ok"),
    })

    expect(() => ref(token)).toThrow(/test\.tool/)
    expect(() => ref(token)).toThrow(/only request tokens carry a ref/)
  })

  test("throws for an action token (no ref attached)", () => {
    const token = action({
      id: "test.action",
      name: "Test Action",
      description: "ephemeral",
      surface: "palette",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.succeed({}),
    })

    expect(() => ref(token)).toThrow(/test\.action/)
  })
})
