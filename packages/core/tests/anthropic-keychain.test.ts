import { describe, it, expect } from "bun:test"
import {
  getModelBetas,
  isLongContextError,
  getExcludedBetas,
  addExcludedBeta,
  getNextBetaToExclude,
  LONG_CONTEXT_BETAS,
} from "@gent/core/extensions/anthropic/oauth"

describe("getModelBetas", () => {
  it("includes context-1m for opus 4.6", () => {
    const betas = getModelBetas("claude-opus-4-6")
    expect(betas).toContain("context-1m-2025-08-07")
    expect(betas).toContain("claude-code-20250219")
  })

  it("includes context-1m for sonnet 4.6", () => {
    const betas = getModelBetas("claude-sonnet-4-6")
    expect(betas).toContain("context-1m-2025-08-07")
  })

  it("excludes context-1m for pre-4.6 models", () => {
    const sonnet45 = getModelBetas("claude-sonnet-4-5-20250514")
    expect(sonnet45).not.toContain("context-1m-2025-08-07")
    expect(sonnet45).toContain("claude-code-20250219")

    const opus45 = getModelBetas("claude-opus-4-5-20250514")
    expect(opus45).not.toContain("context-1m-2025-08-07")
  })

  it("excludes context-1m for date-suffixed models without minor version", () => {
    expect(getModelBetas("claude-opus-4-20250514")).not.toContain("context-1m-2025-08-07")
    expect(getModelBetas("claude-sonnet-4-20250514")).not.toContain("context-1m-2025-08-07")
  })

  it("excludes context-1m for unversioned aliases", () => {
    expect(getModelBetas("sonnet")).not.toContain("context-1m-2025-08-07")
    expect(getModelBetas("opus")).not.toContain("context-1m-2025-08-07")
  })

  it("drops claude-code-20250219 for haiku", () => {
    const betas = getModelBetas("claude-haiku-4-5")
    expect(betas).not.toContain("claude-code-20250219")
  })

  it("filters excluded betas", () => {
    const excluded = new Set(["interleaved-thinking-2025-05-14"])
    const betas = getModelBetas("claude-sonnet-4-6", excluded)
    expect(betas).not.toContain("interleaved-thinking-2025-05-14")
    expect(betas).toContain("context-1m-2025-08-07")
  })

  it("filters multiple excluded betas", () => {
    const excluded = new Set(["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"])
    const betas = getModelBetas("claude-sonnet-4-6", excluded)
    expect(betas).not.toContain("interleaved-thinking-2025-05-14")
    expect(betas).not.toContain("context-1m-2025-08-07")
    expect(betas).toContain("claude-code-20250219")
  })
})

describe("isLongContextError", () => {
  it("detects extra usage error", () => {
    expect(isLongContextError("Extra usage is required for long context requests")).toBe(true)
  })

  it("detects subscription error", () => {
    expect(
      isLongContextError("The long context beta is not yet available for this subscription."),
    ).toBe(true)
  })

  it("detects errors in JSON", () => {
    expect(
      isLongContextError(
        '{"error": {"message": "Extra usage is required for long context requests"}}',
      ),
    ).toBe(true)
  })

  it("does not match other errors", () => {
    expect(isLongContextError("Some other error message")).toBe(false)
    expect(isLongContextError("")).toBe(false)
  })
})

describe("beta exclusion tracking", () => {
  it("getNextBetaToExclude returns first non-excluded beta", () => {
    const modelId = "test-model-exclusion"
    // Clear any prior state
    getExcludedBetas(modelId)

    const first = getNextBetaToExclude(modelId)
    expect(first).toBe(LONG_CONTEXT_BETAS[0])

    addExcludedBeta(modelId, first!)
    const second = getNextBetaToExclude(modelId)
    expect(second).toBe(LONG_CONTEXT_BETAS[1])

    addExcludedBeta(modelId, second!)
    const third = getNextBetaToExclude(modelId)
    expect(third).toBeNull()
  })
})
