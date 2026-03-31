import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { convertTools } from "@gent/core/providers/provider"
import { defineTool } from "@gent/core/domain/tool"

describe("Tool Schema", () => {
  test("convertTools produces type: object for Schema.Struct({})", () => {
    const emptyTool = defineTool({
      name: "empty_params",
      concurrency: "parallel",
      description: "Tool with no params",
      params: Schema.Struct({}),
      execute: () => Effect.succeed({ ok: true }),
    })

    const tools = convertTools([emptyTool])
    const converted = tools["empty_params"]
    expect(converted).toBeDefined()

    // Access the inputSchema from the tool wrapper — AI SDK tool() wraps it
    // The schema should have type: "object" after the guard
    const schema = (converted as { inputSchema: { jsonSchema: Record<string, unknown> } })
      .inputSchema.jsonSchema
    expect(schema["type"]).toBe("object")
    expect(schema["anyOf"]).toBeUndefined()
  })
})
