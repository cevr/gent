import { describe, expect, test } from "bun:test"
import {
  consumedNamesIn,
  findUnconsumedPublicApi,
  publicApiNames,
} from "../src/core-public-api-consumers"

const API_FILE = "packages/core/src/extensions/api.ts"

const apiSource = `export { defineExtension } from "../domain/extension.js"
export {
  tool,
  type ToolCapability,
} from "../domain/capability/tool.js"
export { CapabilityError, CapabilityNotFoundError } from "../domain/capability.js"
`

describe("public API consumer guard", () => {
  test("reads names from single-line and multi-line export blocks", () => {
    expect(publicApiNames(apiSource).map((entry) => entry.name)).toEqual([
      "defineExtension",
      "tool",
      "ToolCapability",
      "CapabilityError",
      "CapabilityNotFoundError",
    ])
  })

  test("a name nothing outside core reaches for is reported with its line", () => {
    const findings = findUnconsumedPublicApi(
      new Map([[API_FILE, apiSource]]),
      new Set(["defineExtension", "tool", "ToolCapability", "CapabilityError"]),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('"CapabilityNotFoundError"')
    expect(findings[0]?.line).toBe(6)
  })

  test("core's own source never counts as a consumer", () => {
    // Core naming its own export proves nothing about whether the public
    // entry point needs to expose it.
    expect(consumedNamesIn("packages/core/src/domain/capability.ts", "CapabilityError").size).toBe(
      0,
    )
    expect(consumedNamesIn("packages/core-internal/src/x.ts", "CapabilityError").size).toBe(0)
  })

  test("an extension naming a symbol counts as consuming it", () => {
    expect(consumedNamesIn("packages/extensions/src/notes/index.ts", "tool({")).toContain("tool")
  })
})
