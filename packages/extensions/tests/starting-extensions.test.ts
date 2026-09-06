import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ExtensionId } from "@gent/core/extensions/api"
import { BuiltinExtensions } from "../src/index.js"

const hasPublicExtensionContract = (extension: (typeof BuiltinExtensions)[number]) =>
  Schema.is(ExtensionId)(extension.manifest.id) && Effect.isEffect(extension.setup)

describe("starting extensions", () => {
  test("exported starting set uses the public extension shape", () => {
    expect(BuiltinExtensions.length).toBeGreaterThan(0)
    expect(BuiltinExtensions.every(hasPublicExtensionContract)).toBe(true)
  })
})
