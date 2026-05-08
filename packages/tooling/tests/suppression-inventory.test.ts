import { describe, expect, test } from "bun:test"
import { findSuppressionInventoryFindings } from "../src/suppression-inventory"

const tsIgnore = ["@ts", "ignore"].join("-")
const effectDiagnostics = ["@effect", "diagnostics-next-line"].join("-")
const eslintDisable = ["eslint", "disable"].join("-")
const asAny = ["as", "any"].join(" ")
const extensionHostContextCast = ["as unknown", "as ExtensionHostContext"].join(" ")

describe("suppression inventory guard", () => {
  test("flags banned TypeScript escape hatches", () => {
    expect(
      findSuppressionInventoryFindings(
        "sample.ts",
        [
          `// ${tsIgnore}`,
          `const value = input ${asAny}`,
          `const ctx = raw ${extensionHostContextCast}`,
        ].join("\n"),
      ),
    ).toEqual([
      { file: "sample.ts", line: 1, kind: "ts-ignore" },
      { file: "sample.ts", line: 2, kind: "as-any" },
      { file: "sample.ts", line: 3, kind: "extension-host-context-cast" },
    ])
  })

  test("flags block eslint-disable comments", () => {
    expect(
      findSuppressionInventoryFindings(
        "sample.ts",
        `/* ${eslintDisable} @typescript-eslint/no-unsafe-type-assertion -- boundary */`,
      ),
    ).toEqual([{ file: "sample.ts", line: 1, kind: "eslint-disable-block" }])
  })

  test("flags effect diagnostics outside reviewed files", () => {
    expect(
      findSuppressionInventoryFindings(
        "sample.ts",
        `// ${effectDiagnostics} strictEffectProvide:off`,
      ),
    ).toEqual([{ file: "sample.ts", line: 1, kind: "effect-diagnostics" }])
  })

  test("allows exact reviewed effect diagnostics independent of line churn", () => {
    expect(
      findSuppressionInventoryFindings(
        "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
        [
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          `// ${effectDiagnostics} anyUnknownInErrorContext:off`,
        ].join("\n"),
      ),
    ).toEqual([])

    expect(
      findSuppressionInventoryFindings(
        "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
        `// ${effectDiagnostics} anyUnknownInErrorContext:off`,
      ),
    ).toEqual([])

    expect(
      findSuppressionInventoryFindings(
        "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
        `// ${effectDiagnostics} strictEffectProvide:off`,
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/extensions/extension-effect-membrane.ts",
        line: 1,
        kind: "effect-diagnostics",
      },
    ])
  })
})
