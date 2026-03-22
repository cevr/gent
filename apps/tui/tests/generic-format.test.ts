import { describe, expect, test } from "bun:test"
import { formatGenericToolText } from "../src/components/tool-renderers/generic-format"

describe("formatGenericToolText", () => {
  test("returns plain text unchanged", () => {
    expect(formatGenericToolText("plain failure")).toBe("plain failure")
  })

  test("extracts error message from json object", () => {
    expect(
      formatGenericToolText(
        JSON.stringify({
          error: "Tool input failed:\n - agent:\nExpected string | undefined, got null",
        }),
      ),
    ).toBe("Tool input failed:\n - agent:\nExpected string | undefined, got null")
  })

  test("combines message with details when present", () => {
    expect(
      formatGenericToolText(
        JSON.stringify({
          message: "Validation failed",
          details: "path is required",
        }),
      ),
    ).toBe("Validation failed\npath is required")
  })

  test("pretty prints json when no common message fields exist", () => {
    expect(formatGenericToolText(JSON.stringify({ files: ["a.ts", "b.ts"] }))).toBe(
      '{\n  "files": [\n    "a.ts",\n    "b.ts"\n  ]\n}',
    )
  })
})
