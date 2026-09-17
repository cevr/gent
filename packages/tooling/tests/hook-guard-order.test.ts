import { describe, expect, test } from "bun:test"
import { findHookGuardOrder, HOOK_FILE } from "../src/hook-guard-order"

const messagesOf = (text: string, file = HOOK_FILE): ReadonlyArray<string> =>
  findHookGuardOrder(file, text).map((finding) => finding.message)

const hook = (...jobs: ReadonlyArray<string>): string =>
  ["pre-commit:", "  parallel: false", "  jobs:", ...jobs].join("\n")

const GUARDS = ["    - name: guards", "      run: bun run guards"]
const LINT = [
  "    - name: lint+fmt",
  "      run: bun run lint:fix && bun run fmt",
  "      stage_fixed: true",
]
const TEST = ["    - name: test", "      run: bun run test"]

describe("pre-commit guard order", () => {
  test("allows the guards as the first job", () => {
    expect(messagesOf(hook(...GUARDS, ...LINT, ...TEST))).toEqual([])
  })

  test("flags the guards running after another job", () => {
    const messages = messagesOf(hook(...LINT, ...GUARDS, ...TEST))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("1 job(s) into the pre-commit hook")
  })

  test("reports the guards job at its own line", () => {
    const findings = findHookGuardOrder(HOOK_FILE, hook(...LINT, ...GUARDS))
    // 3 header lines + 3 lint lines, so the guards entry is line 7.
    expect(findings[0]?.line).toBe(7)
  })

  test("flags a hook with no guards job", () => {
    const messages = messagesOf(hook(...LINT, ...TEST))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("runs no `bun run guards` job")
  })

  test("finds the job by its command, not its name", () => {
    const renamed = ["    - name: fast-checks", "      run: bun run guards"]
    expect(messagesOf(hook(...renamed, ...LINT))).toEqual([])
  })

  test("reads the pre-commit block only", () => {
    const text = [
      "pre-push:",
      "  jobs:",
      "    - name: guards",
      "      run: bun run guards",
      "pre-commit:",
      "  jobs:",
      ...LINT,
    ].join("\n")
    expect(messagesOf(text)).toHaveLength(1)
  })

  test("leaves every other file alone", () => {
    expect(findHookGuardOrder("package.json", hook(...LINT, ...TEST))).toEqual([])
  })
})
