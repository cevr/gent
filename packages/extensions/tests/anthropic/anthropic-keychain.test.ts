import { describe, it, expect } from "bun:test"
import { isLongContextError } from "../../src/anthropic.js"

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
