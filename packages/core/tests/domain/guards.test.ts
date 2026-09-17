import { describe, expect, test } from "effect-bun-test"
import { Option } from "effect"
import { causeChainMessage, causeMessage, omitUndefined } from "../../src/domain/guards.js"

describe("guards", () => {
  test("a failure's message is read from errors, message objects, and primitives", () => {
    // oxlint-disable-next-line effect/noNewError -- The formatter accepts native host error values at its boundary.
    expect(causeMessage(new Error("native boom"))).toBe("native boom")
    expect(causeMessage({ message: "structured boom" })).toBe("structured boom")
    expect(causeMessage("plain boom")).toBe("plain boom")
  })

  test("a wrapped failure reads as its messages, outermost first, with no frames", () => {
    const wrapped = {
      message: "Failed to create message",
      cause: { message: "Failed to execute statement", cause: { message: "no such table: x" } },
    }
    expect(causeChainMessage(wrapped)).toBe(
      "Failed to create message: Failed to execute statement: no such table: x",
    )
    // A wrapper that repeats its cause's message says it once.
    expect(causeChainMessage({ message: "boom", cause: { message: "boom" } })).toBe("boom")
    expect(causeChainMessage("plain boom")).toBe("plain boom")
  })

  test("absent-valued keys are dropped, not kept as present-and-empty", () => {
    const b = Option.getOrUndefined(Option.none<number>())
    expect(Object.keys(omitUndefined({ a: 1, b }))).toEqual(["a"])
  })
})
