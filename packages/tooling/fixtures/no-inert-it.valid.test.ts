// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-inert-it` does NOT fire on the callable forms —
// the four `it` runners, `test(...)` from "bun:test", and a bare `it(...)`
// in a file whose `it` comes from "bun:test" rather than "effect-bun-test".

import { it, test } from "bun:test"
import { describe, expect, it as effectIt } from "effect-bun-test"
import * as ebt from "effect-bun-test"
import { Effect } from "effect"

describe("callable forms", () => {
  test("synchronous body runs on bun:test", () => {
    expect(1).toBe(1)
  })

  it("bun:test it is a function", () => {
    expect(1).toBe(1)
  })

  effectIt.live("effect body on the live runner", () => Effect.void)

  effectIt.scopedLive("effect body on the scoped runner", () => Effect.void)

  effectIt.effect("effect body on the test-clock runner", () => Effect.void)

  effectIt.scoped("scoped effect body on the test-clock runner", () => Effect.void)

  ebt.it.live("a runner reached through a namespace import", () => Effect.void)
})
