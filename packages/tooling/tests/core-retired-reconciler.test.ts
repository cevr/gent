import { describe, expect, test } from "bun:test"
import {
  RETIRED_IDENTIFIERS,
  RETIRED_MODULES,
  findRetiredReconcilerFindings,
} from "../src/core-retired-reconciler"

describe("retired reconciler guard", () => {
  test("flags a shipped file that imports a retired module", () => {
    const findings = findRetiredReconcilerFindings(
      "packages/core/src/runtime/session-profile.ts",
      'import { ResourceGraphHost } from "./extensions/resource-host/resource-graph-host.js"',
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "packages/core/src/runtime/session-profile.ts:1",
    ])
    expect(findings[0]?.message).toContain("resource-graph-host")
  })

  test("flags every retired identifier once per line", () => {
    for (const name of RETIRED_IDENTIFIERS) {
      const findings = findRetiredReconcilerFindings(
        "packages/extensions/src/cell/cell-dispatch.ts",
        `const value = ${name}.make()`,
      )
      expect(findings.length).toBe(1)
      expect(findings[0]?.message).toContain(name)
    }
  })

  test("matches whole identifiers only", () => {
    const findings = findRetiredReconcilerFindings(
      "packages/core/src/domain/resource.ts",
      "export const ResourceId = Schema.NonEmptyString.pipe(Schema.brand('ResourceId'))",
    )
    expect(findings).toEqual([])
  })

  test("matches retired modules by basename, not by substring", () => {
    for (const module of RETIRED_MODULES) {
      expect(
        findRetiredReconcilerFindings(
          "apps/server/src/main.ts",
          `import { x } from "../../packages/core/src/${module}.js"`,
        ).length,
      ).toBe(1)
    }
    expect(
      findRetiredReconcilerFindings(
        "packages/core/src/runtime/session-profile.ts",
        'import { buildResourceLayer } from "./extensions/resource-host/resource-layer.js"',
      ),
    ).toEqual([])
  })

  test("ignores tests and docs", () => {
    expect(
      findRetiredReconcilerFindings(
        "packages/core/tests/runtime/session-profile.test.ts",
        "const host = ResourceGraphHost",
      ),
    ).toEqual([])
    expect(findRetiredReconcilerFindings("ARCHITECTURE.md", "ResourceGraphHost")).toEqual([])
  })
})
