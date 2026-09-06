import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { parseModelId, parseModelProvider, ProviderId } from "@gent/core-internal/domain/model"

describe("model id parsing", () => {
  test("extracts provider and model segments", () => {
    expect(parseModelProvider("anthropic/claude-sonnet")).toEqual(
      Option.some(ProviderId.make("anthropic")),
    )
    expect(parseModelId("anthropic/claude-sonnet")).toEqual(
      Option.some([ProviderId.make("anthropic"), "claude-sonnet"]),
    )
  })

  test("rejects missing provider or model segment", () => {
    expect(parseModelProvider("anthropic")).toEqual(Option.none())
    expect(parseModelProvider("/claude-sonnet")).toEqual(Option.none())
    expect(parseModelProvider("anthropic/")).toEqual(Option.none())
    expect(parseModelId("anthropic")).toEqual(Option.none())
    expect(parseModelId("/claude-sonnet")).toEqual(Option.none())
    expect(parseModelId("anthropic/")).toEqual(Option.none())
  })
})
