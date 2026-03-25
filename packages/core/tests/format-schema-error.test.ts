import { describe, test, expect } from "bun:test"
import { Schema, Effect } from "effect"
import { formatSchemaError } from "@gent/core/runtime/format-schema-error"

const EditParams = Schema.Struct({
  file_path: Schema.String,
  old_string: Schema.String,
  new_string: Schema.String,
})

const decode = Schema.decodeUnknownEffect(EditParams)

const getSchemaError = (input: unknown): Schema.SchemaError => {
  const result = Effect.runSync(decode(input).pipe(Effect.result))
  if (result._tag !== "Failure") throw new Error("Expected failure")
  const failure = result.failure
  if (!Schema.isSchemaError(failure)) throw new Error("Expected SchemaError")
  return failure
}

describe("formatSchemaError", () => {
  test("formats missing key with tool name and field path", () => {
    const error = getSchemaError({})
    const message = formatSchemaError("edit", error)
    expect(message).toContain("Tool 'edit' input failed:")
    expect(message).toContain("Missing key")
  })

  test("formats type mismatch with field path", () => {
    const error = getSchemaError({ file_path: 123, old_string: "a", new_string: "b" })
    const message = formatSchemaError("edit", error)
    expect(message).toContain("Tool 'edit' input failed:")
    expect(message).toContain("file_path")
    expect(message).toContain("Expected string")
  })

  test("includes tool name in output", () => {
    const error = getSchemaError({})
    const message = formatSchemaError("write", error)
    expect(message).toContain("Tool 'write'")
  })

  test("produces actionable output for the agent", () => {
    const error = getSchemaError({ file_path: 42 })
    const message = formatSchemaError("edit", error)
    // Should be structured enough for an agent to understand what went wrong
    expect(message).toMatch(/Tool 'edit' input failed:/)
    expect(message).toMatch(/file_path.*Expected string|Expected string.*file_path/)
  })
})
