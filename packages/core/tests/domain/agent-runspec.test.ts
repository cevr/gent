import { describe, expect, test } from "bun:test"
import { makeRunSpec, ModelId } from "../../src/domain/agent"
import { ToolCallId } from "../../src/domain/ids"

describe("run spec construction", () => {
  test("empty input produces empty spec — no spurious keys", () => {
    const spec = makeRunSpec()
    expect(Object.keys(spec)).toEqual([])
  })

  test("undefined fields are omitted, not stored", () => {
    const spec = makeRunSpec({
      // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
      visibility: undefined,
      // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
      overrides: undefined,
      // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
      parentToolCallId: undefined,
    })
    expect(Object.keys(spec)).toEqual([])
    expect("visibility" in spec).toBe(false)
    expect("overrides" in spec).toBe(false)
    expect("parentToolCallId" in spec).toBe(false)
  })

  test("threads each provided field through", () => {
    const tcid = ToolCallId.make("tc-1")
    const spec = makeRunSpec({
      history: "inherit",
      visibility: "private",
      overrides: {
        modelId: ModelId.make("custom/model"),
        allowedTools: ["bash"],
        deniedTools: ["read"],
        reasoningEffort: "high",
        systemPromptAddendum: "extra",
      },
      parentToolCallId: tcid,
    })
    expect(spec.history).toBe("inherit")
    expect(spec.visibility).toBe("private")
    expect(spec.overrides?.modelId).toBe(ModelId.make("custom/model"))
    expect(spec.overrides?.allowedTools).toEqual(["bash"])
    expect(spec.overrides?.deniedTools).toEqual(["read"])
    expect(spec.overrides?.reasoningEffort).toBe("high")
    expect(spec.overrides?.systemPromptAddendum).toBe("extra")
    expect(spec.parentToolCallId).toBe(tcid)
  })

  test("partial input — only visibility", () => {
    const spec = makeRunSpec({ visibility: "private" })
    expect(Object.keys(spec)).toEqual(["visibility"])
  })
})
