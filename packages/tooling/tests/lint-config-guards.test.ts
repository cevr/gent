import { describe, expect, test } from "bun:test"
import {
  findReadersWithoutWriters,
  findUnenabledPluginRules,
  findUnmatchedOverrideGlobs,
} from "../src/guards"

const CONFIG = ".oxlintrc.json"
const PLUGIN = "lint/no-direct-env.ts"

const messages = (findings: ReadonlyArray<{ readonly message: string }>): ReadonlyArray<string> =>
  findings.map((finding) => finding.message)

describe("an override must match a tracked file", () => {
  const configFor = (globs: ReadonlyArray<string>) => ({
    overrides: [{ files: globs }],
  })

  test("a glob naming a file that exists is silent", () => {
    const findings = findUnmatchedOverrideGlobs(
      CONFIG,
      `{ "files": ["packages/sdk/src/server.ts"] }`,
      configFor(["packages/sdk/src/server.ts"]),
      ["packages/sdk/src/server.ts", "packages/sdk/src/client.ts"],
    )
    expect(findings).toEqual([])
  })

  test("a glob naming a deleted file is reported", () => {
    // The supervisor.ts override outlived that file and kept a rule off.
    const findings = findUnmatchedOverrideGlobs(
      CONFIG,
      `{\n  "files": ["**/sdk/src/supervisor.ts"]\n}`,
      configFor(["**/sdk/src/supervisor.ts"]),
      ["packages/sdk/src/server.ts"],
    )
    expect(messages(findings)).toEqual([expect.stringContaining("matches no tracked file")])
  })

  test("the finding points at the line the glob sits on", () => {
    const findings = findUnmatchedOverrideGlobs(
      CONFIG,
      `{\n  "overrides": [\n    {\n      "files": ["packages/gone.ts"]\n`,
      configFor(["packages/gone.ts"]),
      ["packages/sdk/src/server.ts"],
    )
    expect(findings.map((finding) => finding.line)).toEqual([4])
  })

  test("a directory glob matches through its subdirectories", () => {
    const findings = findUnmatchedOverrideGlobs(
      CONFIG,
      "{}",
      configFor(["**/tests/**", "**/*.tsx"]),
      ["apps/tui/tests/deep/case.test.ts", "apps/tui/src/app.tsx"],
    )
    expect(findings).toEqual([])
  })
})

describe("a defined rule must be enabled", () => {
  const plugin = `  rules: {
    "no-sleep": {
      create() {},
    },
    "no-make-unsafe": {
      create() {},
    },
  }`

  test("a rule the root config enables is silent", () => {
    const findings = findUnenabledPluginRules(
      PLUGIN,
      plugin,
      new Set(["gent/no-sleep", "gent/no-make-unsafe"]),
    )
    expect(findings).toEqual([])
  })

  test("a rule the root config never enables is reported", () => {
    // no-make-unsafe shipped unenabled, and could not be enabled at all:
    // seven live makeUnsafe calls would have failed it.
    const findings = findUnenabledPluginRules(PLUGIN, plugin, new Set(["gent/no-sleep"]))
    expect(messages(findings)).toEqual([
      expect.stringContaining("`gent/no-make-unsafe` is defined but the root config never enables"),
    ])
  })

  test("the finding points at the line the rule is defined on", () => {
    const findings = findUnenabledPluginRules(PLUGIN, plugin, new Set(["gent/no-sleep"]))
    expect(findings.map((finding) => finding.line)).toEqual([5])
  })
})

describe("a read variable must have a writer", () => {
  test("a variable something in the tree sets is silent", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", `Config.option(Config.string("GENT_CHILD_ID"))\n`],
        ["packages/sdk/src/spawn.ts", `const env = { GENT_CHILD_ID: id }\n`],
      ]),
    )
    expect(findings).toEqual([])
  })

  test("a variable nothing sets is reported", () => {
    // GENT_TRACE_ID outlived its writer and kept an unreachable branch alive.
    const findings = findReadersWithoutWriters(
      new Map([["packages/sdk/src/reader.ts", `Config.option(Config.string("GENT_ORPHAN"))\n`]]),
    )
    expect(messages(findings)).toEqual([
      expect.stringContaining("`GENT_ORPHAN` is read but nothing in the tree sets it"),
    ])
  })

  test("a variable a person sets by hand is allowed, with its reason", () => {
    const findings = findReadersWithoutWriters(
      new Map([["packages/sdk/src/logger.ts", `Config.option(Config.string("GENT_LOG_LEVEL"))\n`]]),
    )
    expect(findings).toEqual([])
  })

  test("only a test sets it, so the production reader is still reported", () => {
    // A test that sets a variable proves the reader works, not that anything
    // in production supplies it.
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/reader.ts", `Config.option(Config.string("GENT_TEST_ONLY"))\n`],
        ["packages/sdk/tests/reader.test.ts", `const env = { GENT_TEST_ONLY: "1" }\n`],
      ]),
    )
    expect(messages(findings)).toEqual([
      expect.stringContaining("`GENT_TEST_ONLY` is read but nothing in the tree sets it"),
    ])
  })

  test("every reader of one dead variable is reported, not just the first", () => {
    const findings = findReadersWithoutWriters(
      new Map([
        ["packages/sdk/src/a.ts", `Config.option(Config.string("GENT_ORPHAN"))\n`],
        ["packages/sdk/src/b.ts", `Config.option(Config.string("GENT_ORPHAN"))\n`],
      ]),
    )
    expect(findings.map((finding) => finding.file)).toEqual([
      "packages/sdk/src/a.ts",
      "packages/sdk/src/b.ts",
    ])
  })
})
