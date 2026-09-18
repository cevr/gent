import { describe, expect, test } from "bun:test"
import { findE2eFixtureImportFindings } from "../src/guards"

const noFixtureSource = [
  'import { describe, expect, it } from "effect-bun-test"',
  'import { Effect } from "effect"',
  'import { Gent } from "@gent/sdk"',
  'import { makeTempDirectoryScoped } from "@gent/core-internal/test-utils/fixtures"',
].join("\n")

describe("e2e fixture import guard", () => {
  test("ignores test files outside packages/e2e", () => {
    expect(
      findE2eFixtureImportFindings("packages/sdk/tests/server.test.ts", noFixtureSource),
    ).toEqual([])
  })

  test("ignores e2e helpers that are not test files", () => {
    expect(
      findE2eFixtureImportFindings("packages/e2e/tests/test-failure-boundary.ts", noFixtureSource),
    ).toEqual([])
  })

  test("accepts a single-line pty fixture import", () => {
    expect(
      findE2eFixtureImportFindings(
        "packages/e2e/tests/e2e.test.ts",
        `${noFixtureSource}\nimport { seedAndSpawn } from "../src/pty-fixture"\n`,
      ),
    ).toEqual([])
  })

  test("accepts a multi-line server process fixture import", () => {
    expect(
      findE2eFixtureImportFindings(
        "packages/e2e/tests/server-lifecycle.test.ts",
        `${noFixtureSource}\nimport {\n  killProcess,\n  spawnServer,\n} from "../src/server-process-fixture.js"\n`,
      ),
    ).toEqual([])
  })

  test("flags an e2e test file that imports neither fixture", () => {
    expect(
      findE2eFixtureImportFindings(
        "packages/e2e/tests/workspace-isolation.test.ts",
        noFixtureSource,
      ),
    ).toEqual([
      {
        file: "packages/e2e/tests/workspace-isolation.test.ts",
        line: 1,
        message:
          "e2e test files must import ../src/server-process-fixture or ../src/pty-fixture; an in-process test belongs in the owning package's tests/",
      },
    ])
  })

  test("does not accept the fixture path inside a comment or string body", () => {
    expect(
      findE2eFixtureImportFindings(
        "packages/e2e/tests/notes.test.ts",
        `${noFixtureSource}\n// see ../src/pty-fixture\nconst hint = "../src/server-process-fixture"\n`,
      ),
    ).toHaveLength(1)
  })
})
