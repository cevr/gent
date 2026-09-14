import { describe, expect, test } from "bun:test"
import { Model, ModelId, ProviderId } from "@gent/core/protocol"
import { filterModels, resolveModelQuery } from "../src/client/model-query"

const model = (id: string, name: string): Model =>
  new Model({ id: ModelId.make(id), name, provider: ProviderId.make(id.split("/")[0] ?? "") })

const catalogue = [
  model("anthropic/claude-sonnet-5", "Claude Sonnet 5"),
  model("anthropic/claude-opus-5", "Claude Opus 5"),
  model("openai/gpt-5.6-luna", "GPT-5.6 Luna"),
]

describe("resolveModelQuery", () => {
  test("an exact id wins even when it is a prefix of another id", () => {
    const result = resolveModelQuery(
      [...catalogue, model("anthropic/claude-opus-5-fast", "Claude Opus 5 Fast")],
      "anthropic/claude-opus-5",
    )
    expect(result._tag).toBe("Match")
    if (result._tag === "Match")
      expect(result.model.id).toBe(ModelId.make("anthropic/claude-opus-5"))
  })

  test("a unique substring of the display name matches case-insensitively", () => {
    const result = resolveModelQuery(catalogue, "LUNA")
    expect(result._tag).toBe("Match")
    if (result._tag === "Match") expect(result.model.id).toBe(ModelId.make("openai/gpt-5.6-luna"))
  })

  test("a substring shared by several models is ambiguous and lists them", () => {
    const result = resolveModelQuery(catalogue, "claude")
    expect(result._tag).toBe("Ambiguous")
    if (result._tag === "Ambiguous")
      expect(result.candidates.map((m) => m.id)).toEqual([
        ModelId.make("anthropic/claude-sonnet-5"),
        ModelId.make("anthropic/claude-opus-5"),
      ])
  })

  test("no match reports none", () => {
    expect(resolveModelQuery(catalogue, "gemini")._tag).toBe("None")
  })

  test("an empty filter keeps the catalogue order", () => {
    expect(filterModels(catalogue, "  ")).toEqual(catalogue)
  })
})
