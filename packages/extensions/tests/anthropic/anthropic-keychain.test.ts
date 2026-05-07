import { describe, it, expect } from "bun:test"
import { getModelBetas, isLongContextError } from "@gent/extensions/anthropic/oauth"

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

  it("drops interleaved-thinking-2025-05-14 for haiku (model-config override)", () => {
    // The previous haiku rule dropped claude-code-20250219; the
    // model-config.ts port (matching opencode-claude-auth) excludes
    // interleaved-thinking-2025-05-14 for the haiku family instead, so
    // haiku rejects the combo of effort + thinking. Lock the new
    // expectation here so future haiku regressions surface immediately.
    const betas = getModelBetas("claude-haiku-4-5")
    expect(betas).not.toContain("interleaved-thinking-2025-05-14")
    expect(betas).toContain("claude-code-20250219")
    expect(betas).toContain("oauth-2025-04-20")
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
