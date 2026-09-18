import { describe, expect, test } from "bun:test"
import { REMOVED_IDENTIFIERS, findProcessRunnerFindings } from "../src/guards"

describe("process runner guard", () => {
  test("flags every removed identifier once per line", () => {
    for (const name of REMOVED_IDENTIFIERS) {
      const findings = findProcessRunnerFindings(
        "packages/core/src/runtime/extension-host.ts",
        `const runner = ${name}`,
      )
      expect(findings.length).toBe(1)
      expect(findings[0]?.message).toContain(name)
    }
  })

  test("flags a test that builds the removed layer", () => {
    const findings = findProcessRunnerFindings(
      "packages/core/tests/runtime/session-runtime.test.ts",
      'import { ProcessRunnerLive } from "../../src/runtime/run-process"',
    )
    expect(findings.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "packages/core/tests/runtime/session-runtime.test.ts:1",
    ])
  })

  test("scans apps source as well as packages", () => {
    expect(
      findProcessRunnerFindings("apps/tui/src/services/boundary.ts", "yield* ProcessRunner").length,
    ).toBe(1)
  })

  test("leaves InProcessRunner and runProcess alone", () => {
    expect(
      findProcessRunnerFindings(
        "packages/core/src/server/server.ts",
        'import { InProcessRunner } from "../runtime/agent/agent-runner.js"',
      ),
    ).toEqual([])
    expect(
      findProcessRunnerFindings(
        "packages/core/src/runtime/extension-host.ts",
        "runProcess: (command, args, options) => runProcess(command, args, options)",
      ),
    ).toEqual([])
  })

  test("ignores docs, plans and the tooling package itself", () => {
    expect(findProcessRunnerFindings("ARCHITECTURE.md", "ProcessRunner")).toEqual([])
    expect(findProcessRunnerFindings("plans/arch-core.md", "ProcessRunnerLive")).toEqual([])
    expect(findProcessRunnerFindings("packages/tooling/src/guards.ts", "ProcessRunner")).toEqual([])
    expect(
      findProcessRunnerFindings(
        "packages/tooling/tests/core-process-runner.test.ts",
        "ProcessRunner",
      ),
    ).toEqual([])
  })
})
