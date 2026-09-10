import { describe, expect, test } from "bun:test"
import { adaptedSeamsIn, findUnadaptedSeams } from "../src/core-unadapted-seams"

const FACETS_FILE = "packages/core/src/domain/extension-services.ts"
const SCOPE_FILE = "packages/core/src/domain/resource.ts"

const facetsSource = `export interface ExtensionContextService {
  readonly extensionId: ExtensionId
  readonly cwd: string
  readonly Files: ExtensionFilesService
  readonly Telepathy: ExtensionTelepathyService
}
`

const scopeSource = `export type ResourceScope = "process" | "branch"
`

describe("unadapted seam guard", () => {
  test("reads facets from a yielded context and scopes from a resource definition", () => {
    const seams = adaptedSeamsIn(
      "packages/extensions/src/notes/index.ts",
      `const ctx = yield* ExtensionContext
       yield* ctx.Files.listFiles()
       defineResource({ id: "notes", scope: "process", layer })`,
    )
    expect([...seams].sort()).toEqual(["Files", "process"])
  })

  test("a facet nothing reaches is reported", () => {
    const findings = findUnadaptedSeams(new Map([[FACETS_FILE, facetsSource]]), new Set(["Files"]))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('extension context facet "Telepathy"')
    expect(findings[0]?.line).toBe(5)
  })

  test("plain context facts are not seams", () => {
    // `extensionId` and `cwd` are data an extension reads, not facades it
    // reaches through. Reporting them would make the guard unusable.
    const findings = findUnadaptedSeams(
      new Map([[FACETS_FILE, facetsSource]]),
      new Set(["Files", "Telepathy"]),
    )
    expect(findings).toHaveLength(0)
  })

  test("a resource scope nothing declares is reported", () => {
    const findings = findUnadaptedSeams(new Map([[SCOPE_FILE, scopeSource]]), new Set(["process"]))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('resource scope "branch"')
  })

  test("a resource scope named like an extension load scope is not credited by one", () => {
    // Both concepts spell the field `scope:`, so a load-scope site would
    // silently satisfy a same-named resource scope. Such a name is skipped
    // rather than reported as filled by something that never filled it.
    const findings = findUnadaptedSeams(
      new Map([[SCOPE_FILE, `export type ResourceScope = "process" | "builtin"\n`]]),
      new Set(["process"]),
    )
    expect(findings).toHaveLength(0)
  })

  test("test files never count as adapters", () => {
    expect(adaptedSeamsIn("packages/extensions/tests/notes.test.ts", "ctx.Telepathy").size).toBe(0)
  })
})
