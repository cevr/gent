// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-inert-it` fires for every bare call of the `it`
// binding imported from "effect-bun-test".
//
// Cases (3 total):
//   1. `it("name", () => {...})` with an arrow body
//   2. `it("name", fn)` with a function reference
//   3. `spec("name", () => {...})` where the import was renamed

import { describe, expect, it } from "effect-bun-test"
import { it as spec } from "effect-bun-test"

const fn = () => {
  expect(1).toBe(1)
}

describe("inert forms", () => {
  it("arrow body", () => {
    expect(1).toBe(2)
  })

  it("function reference", fn)

  spec("renamed import", () => {
    expect(1).toBe(2)
  })
})
