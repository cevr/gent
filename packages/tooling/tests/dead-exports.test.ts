import { describe, expect, test } from "bun:test"
import { declaredExports, findDeadExports, identifiersIn } from "../src/dead-exports"

const CORE_FILE = "packages/core/src/runtime/retry.ts"
const SDK_FILE = "packages/sdk/src/log-paths.ts"
const SDK_CONSUMER = "packages/sdk/src/logger.ts"

interface SourceEntry {
  readonly file: string
  readonly text: string
}

const declarationsFor = (entries: ReadonlyArray<SourceEntry>) =>
  entries.flatMap(({ file, text }) =>
    declaredExports(file, text).map((declaration) => ({ file, ...declaration })),
  )

const identifiersFor = (
  entries: ReadonlyArray<SourceEntry>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const byFile = new Map<string, ReadonlySet<string>>()
  for (const { file, text } of entries) byFile.set(file, identifiersIn(text))
  return byFile
}

describe("dead export guard", () => {
  test("reads declared exports from a scanned core file", () => {
    const source = `export const retrySchedule = 1
const notExported = 2
export interface RetryPolicy {}
`
    expect(declaredExports(CORE_FILE, source)).toEqual([
      { name: "retrySchedule", line: 1 },
      { name: "RetryPolicy", line: 3 },
    ])
  })

  test("reads declared exports from a scanned sdk file", () => {
    const source = `export const buildLogPaths = 1
export type LogPaths = { readonly dir: string }
`
    expect(declaredExports(SDK_FILE, source).map((entry) => entry.name)).toEqual([
      "buildLogPaths",
      "LogPaths",
    ])
  })

  test("a file in an unscanned package declares nothing", () => {
    const source = `export const ExtensionHelper = 1\n`
    expect(declaredExports("packages/extensions/src/wake/index.ts", source)).toEqual([])
    expect(declaredExports("apps/tui/src/app.tsx", source)).toEqual([])
  })

  test("core's exempt entry points declare nothing", () => {
    const source = `export const tool = 1\n`
    expect(declaredExports("packages/core/src/extensions/api.ts", source)).toEqual([])
    expect(declaredExports("packages/core/src/protocol.ts", source)).toEqual([])
    expect(declaredExports("packages/core/src/test-utils/fixtures.ts", source)).toEqual([])
  })

  test("a planted sdk export no other file names is reported with its line", () => {
    const planted = `export const buildLogPaths = 1

export const plantedDeadSdkExport = "nothing imports this"
`
    const consumer = `import { buildLogPaths } from "./log-paths.js"\n`
    const entries: ReadonlyArray<SourceEntry> = [
      { file: SDK_FILE, text: planted },
      { file: SDK_CONSUMER, text: consumer },
    ]

    const findings = findDeadExports(declarationsFor(entries), identifiersFor(entries))

    expect(findings).toHaveLength(1)
    expect(findings[0]?.file).toBe(SDK_FILE)
    expect(findings[0]?.line).toBe(3)
    expect(findings[0]?.message).toContain("`plantedDeadSdkExport`")
  })

  test("an sdk export another sdk file imports is live", () => {
    const source = `export const ensureLogDir = 1\n`
    const consumer = `import { ensureLogDir } from "./log-paths.js"\n`
    const entries: ReadonlyArray<SourceEntry> = [
      { file: SDK_FILE, text: source },
      { file: SDK_CONSUMER, text: consumer },
    ]

    expect(findDeadExports(declarationsFor(entries), identifiersFor(entries))).toEqual([])
  })

  test("a name an unscanned package reaches for is live", () => {
    const source = `export const sharedName = 1\n`
    const consumer = `import { sharedName } from "@gent/sdk"\n`
    const entries: ReadonlyArray<SourceEntry> = [
      { file: SDK_FILE, text: source },
      { file: "apps/tui/src/app.tsx", text: consumer },
    ]

    expect(findDeadExports(declarationsFor(entries), identifiersFor(entries))).toEqual([])
  })

  test("a name two scanned files both declare needs a third file to be live", () => {
    const core = `export const sameName = 1\n`
    const sdk = `export const sameName = 2\n`
    const entries: ReadonlyArray<SourceEntry> = [
      { file: CORE_FILE, text: core },
      { file: SDK_FILE, text: sdk },
    ]

    const findings = findDeadExports(declarationsFor(entries), identifiersFor(entries))
    expect(findings.map((finding) => finding.file).sort()).toEqual([CORE_FILE, SDK_FILE])
  })
})
