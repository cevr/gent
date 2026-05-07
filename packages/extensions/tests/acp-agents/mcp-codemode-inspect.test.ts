/**
 * `inspectForMcp` — pure stringifier for the MCP codemode `execute`
 * result. Verifies the three non-trivial branches that JSON.stringify
 * cannot handle on its own: circular refs, BigInt values, and the
 * stringify-throws fallback.
 */
import { describe, expect, test } from "bun:test"
import { inspectForMcp } from "@gent/extensions/acp-agents/mcp-codemode"

describe("inspectForMcp", () => {
  test("renders plain JSON-able values", () => {
    expect(inspectForMcp({ a: 1, b: ["x", "y"] })).toBe(
      '{\n  "a": 1,\n  "b": [\n    "x",\n    "y"\n  ]\n}',
    )
  })

  test("substitutes [Circular] for self-referential objects", () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj["self"] = obj
    const out = inspectForMcp(obj)
    expect(out).toContain('"self": "[Circular]"')
    expect(out).toContain('"a": 1')
  })

  test("preserves object shape when a property is a BigInt", () => {
    const out = inspectForMcp({ id: 1n, ok: true })
    expect(out).toContain('"id": "1n"')
    expect(out).toContain('"ok": true')
    expect(out).not.toBe("[object Object]")
  })

  test("renders a top-level BigInt as its `Nn` form", () => {
    expect(inspectForMcp(42n)).toBe('"42n"')
  })

  test("falls back to String() when the replacer itself throws", () => {
    // A getter that throws at access time triggers JSON.stringify's
    // throw path, which inspectForMcp catches and falls back to
    // `String(value)`.
    const exploding: Record<string, unknown> = {}
    Object.defineProperty(exploding, "boom", {
      enumerable: true,
      get: () => {
        throw new Error("nope")
      },
    })
    expect(inspectForMcp(exploding)).toBe("[object Object]")
  })
})
