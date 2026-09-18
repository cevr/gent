/**
 * A tool's optional declarations survive the trip into its capability.
 *
 * Each one is declared once and copied twice -- input to metadata, metadata to
 * capability -- and an absent one must stay absent rather than arrive as
 * `undefined`, because both are exact optional properties.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { getToolMetadata, tool } from "../../src/domain/capability.js"

const params = Schema.Struct({ text: Schema.String })
const output = Schema.String

const bareTool = tool({
  id: "bare",
  description: "declares nothing optional",
  params,
  output,
  execute: () => Effect.succeed("done"),
})

const declaredTool = tool({
  id: "declared",
  description: "declares everything optional",
  params,
  output,
  promptSnippet: "a one-liner",
  promptGuidelines: ["prefer this tool"],
  interactive: true,
  dispatches: true,
  prompt: { id: "declared", content: "how to use it", priority: 50 },
  execute: () => Effect.succeed("done"),
})

describe("tool declarations", () => {
  test("reach the metadata annotation", () => {
    const metadata = getToolMetadata(declaredTool)
    expect(metadata.promptSnippet).toBe("a one-liner")
    expect(metadata.promptGuidelines).toEqual(["prefer this tool"])
    expect(metadata.interactive).toBe(true)
    expect(metadata.dispatches).toBe(true)
    expect(metadata.prompt?.id).toBe("declared")
  })

  test("reach the capability itself", () => {
    expect(declaredTool.promptSnippet).toBe("a one-liner")
    expect(declaredTool.promptGuidelines).toEqual(["prefer this tool"])
    expect(declaredTool.interactive).toBe(true)
    expect(declaredTool.dispatches).toBe(true)
    expect(declaredTool.prompt?.id).toBe("declared")
  })

  test("stay absent, not undefined, when the tool declares none", () => {
    const metadata = getToolMetadata(bareTool)
    for (const key of [
      "promptSnippet",
      "promptGuidelines",
      "interactive",
      "dispatches",
      "prompt",
    ]) {
      expect(Object.hasOwn(metadata, key)).toBe(false)
      expect(Object.hasOwn(bareTool, key)).toBe(false)
    }
  })
})
