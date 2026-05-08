import { describe, expect, test } from "bun:test"
import { parseModelId, parseModelProvider, ProviderId } from "@gent/core-internal/domain/model"

describe("model id parsing", () => {
  test("extracts provider and model segments", () => {
    expect(parseModelProvider("anthropic/claude-sonnet")).toBe(ProviderId.make("anthropic"))
    expect(parseModelId("anthropic/claude-sonnet")).toEqual([
      ProviderId.make("anthropic"),
      "claude-sonnet",
    ])
  })

  test("rejects missing provider or model segment", () => {
    expect(parseModelProvider("anthropic")).toBeUndefined()
    expect(parseModelProvider("/claude-sonnet")).toBeUndefined()
    expect(parseModelProvider("anthropic/")).toBeUndefined()
    expect(parseModelId("anthropic")).toBeUndefined()
    expect(parseModelId("/claude-sonnet")).toBeUndefined()
    expect(parseModelId("anthropic/")).toBeUndefined()
  })
})
