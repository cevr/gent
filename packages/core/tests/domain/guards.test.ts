import { describe, expect, test } from "effect-bun-test"
import { Option } from "effect"
import { causeMessage, omitUndefined } from "../../src/domain/guards.js"

describe("guards", () => {
  test("a failure's message is read from errors, message objects, and primitives", () => {
    // oxlint-disable-next-line effect/noNewError -- The formatter accepts native host error values at its boundary.
    expect(causeMessage(new Error("native boom"))).toBe("native boom")
    expect(causeMessage({ message: "structured boom" })).toBe("structured boom")
    expect(causeMessage("plain boom")).toBe("plain boom")
  })

  test("absent-valued keys are dropped, not kept as present-and-empty", () => {
    const b = Option.getOrUndefined(Option.none<number>())
    expect(Object.keys(omitUndefined({ a: 1, b }))).toEqual(["a"])
  })
})
