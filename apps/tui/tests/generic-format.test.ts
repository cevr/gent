import { describe, expect, test } from "bun:test"
import { formatGenericToolText } from "../src/components/tool-renderers/generic-format"
import { Schema } from "effect"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

describe("formatGenericToolText", () => {
  test("returns plain text unchanged", () => {
    expect(formatGenericToolText("plain failure")).toBe("plain failure")
  })

  test("extracts error message from json object", () => {
    expect(
      formatGenericToolText(
        encodeJson({
          error: "Tool input failed:\n - agent:\nExpected string | undefined, got null",
        }),
      ),
    ).toBe("Tool input failed:\n - agent:\nExpected string | undefined, got null")
  })

  test("combines message with details when present", () => {
    expect(
      formatGenericToolText(
        encodeJson({
          message: "Validation failed",
          details: "path is required",
        }),
      ),
    ).toBe("Validation failed\npath is required")
  })

  test("pretty prints json when no common message fields exist", () => {
    expect(formatGenericToolText(encodeJson({ files: ["a.ts", "b.ts"] }))).toBe(
      '{\n  "files": [\n    "a.ts",\n    "b.ts"\n  ]\n}',
    )
  })
})
