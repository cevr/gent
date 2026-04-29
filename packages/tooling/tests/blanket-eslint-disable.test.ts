import { describe, expect, test } from "bun:test"
import { findBlanketEslintDisables } from "../src/blanket-eslint-disable"

const directive = ["eslint", "disable"].join("-")

describe("blanket eslint disable checker", () => {
  test("flags blanket file comments", () => {
    expect(
      findBlanketEslintDisables("sample.ts", `/* ${directive} */\nexport const x = 1`),
    ).toEqual([{ file: "sample.ts", line: 1 }])
  })

  test("flags blanket line comments", () => {
    expect(
      findBlanketEslintDisables(
        "sample.ts",
        [
          "export const x = 1",
          `// ${directive}-next-line -- blanket suppression`,
          "export const y = 2",
        ].join("\n"),
      ),
    ).toEqual([{ file: "sample.ts", line: 2 }])
  })

  test("allows rule-named suppressions", () => {
    expect(
      findBlanketEslintDisables(
        "sample.ts",
        [
          `// ${directive}-next-line @typescript-eslint/no-unsafe-type-assertion -- boundary`,
          "const value = foreign as Local",
        ].join("\n"),
      ),
    ).toEqual([])
  })
})
