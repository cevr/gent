import { describe, expect, test } from "bun:test"
import type { GentExtension } from "@gent/core/extensions/api"
import { BuiltinExtensions } from "../src/index.js"

const hasPublicExtensionShape = (extension: GentExtension) =>
  typeof extension.manifest.id === "string" && typeof extension.setup === "function"

describe("starting extensions", () => {
  test("exported starting set uses the public extension shape", () => {
    expect(BuiltinExtensions.length).toBeGreaterThan(0)
    expect(BuiltinExtensions.every(hasPublicExtensionShape)).toBe(true)
  })
})
