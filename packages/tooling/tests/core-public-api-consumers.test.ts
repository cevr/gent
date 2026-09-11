import { describe, expect, test } from "bun:test"
import {
  consumedNamesIn,
  findUnconsumedPublicApi,
  publicApiNames,
} from "../src/core-public-api-consumers"

const API_FILE = "packages/core/src/extensions/api.ts"
const CONSUMER = "packages/extensions/src/notes/index.ts"

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

  test("only an import through the public path counts", () => {
    // The same symbol reached over a relative path is not consumption of the
    // public API -- nothing gets it from `extensions/api`, which is the only
    // question this guard asks.
    expect(
      consumedNamesIn(CONSUMER, `import { tool } from "../../../core/src/domain/capability/tool"`),
    ).not.toContain("tool")
    expect(consumedNamesIn(CONSUMER, `import { tool } from "@gent/core/extensions/api"`)).toContain(
      "tool",
    )
  })

  test("an alias credits the original name, not the local one", () => {
    // `X as Y` still requires the public API to export `X`.
    const names = consumedNamesIn(
      CONSUMER,
      `import { messagePartText as renderText } from "@gent/core/extensions/api"`,
    )
    expect(names).toContain("messagePartText")
    expect(names).not.toContain("renderText")
  })

  test("a multi-line import block is read as one statement", () => {
    const names = consumedNamesIn(
      CONSUMER,
      `import {
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"`,
    )
    expect([...names].sort()).toEqual(["ToolCapability", "tool"])
  })

  test("a namespace import credits every member it reads", () => {
    const names = consumedNamesIn(
      CONSUMER,
      `import * as Api from "@gent/core/extensions/api"
const x: Api.ToolCapability = Api.tool({})`,
    )
    expect([...names].sort()).toEqual(["ToolCapability", "tool"])
  })

  test("a @ts-expect-error reference asserts absence, so it never counts", () => {
    // The surface-lock suites reach for removed names precisely to prove they
    // are gone. Crediting those would pin removed surface in place forever.
    const names = consumedNamesIn(
      CONSUMER,
      `import * as Api from "@gent/core/extensions/api"
    // @ts-expect-error — action factory was removed
    type Bad = typeof Api.action`,
    )
    expect(names).not.toContain("action")
  })

  test("core's own source never counts as a consumer", () => {
    expect(
      consumedNamesIn(
        "packages/core/src/domain/capability.ts",
        `import { tool } from "@gent/core/extensions/api"`,
      ).size,
    ).toBe(0)
  })
})
