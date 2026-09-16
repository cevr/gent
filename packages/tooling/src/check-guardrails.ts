import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Option } from "effect"
import { findBannedEslintDisableBlocks, findBlanketEslintDisables } from "./blanket-eslint-disable"
import { findCoreFeatureIndependenceFindings } from "./core-feature-independence"
import { findRetiredReconcilerFindings } from "./core-retired-reconciler"
import { findCoreVendorModelPins } from "./core-vendor-model-pins"
import { findAliasTestLayers } from "./core-alias-test-layers"
import { findUnadmittedChildSessionWriters } from "./core-child-session-depth"
import { findIdentityEncodes } from "./core-identity-encode"
import {
  collectExportFacts,
  findPackageSurfaceFindings,
  findUnconsumedExports,
  type ExportFacts,
  type PackageJson,
} from "./export-consumers"
import { findE2eFixtureImportFindings } from "./e2e-fixture-imports"
import { findPlatformDuplicationViolations } from "./platform-duplication-guards"
import {
  findSuppressionInventoryFindings,
  findUnusedSuppressionApprovals,
} from "./suppression-inventory"
import { adaptedSeamsIn, findUnadaptedSeams } from "./core-unadapted-seams"

const trackedFileNames = Effect.promise(() =>
  Bun.$`git ls-files --cached --others --exclude-standard`.text(),
).pipe(Effect.map((output) => output.split("\n").filter((file) => file.length > 0)))

const readTrackedFile = Effect.fn("Tooling.readTrackedFile")(function* (file: string) {
  const source = Bun.file(file)
  if (!(yield* Effect.promise(() => source.exists()))) return Option.none()
  return Option.some({ file, text: yield* Effect.promise(() => source.text()) })
})

const readJsonFile = Effect.fn("Tooling.readJsonFile")(function* (path: string) {
  return yield* Effect.promise(() => Bun.file(path).json())
})

const program = Effect.gen(function* () {
  const trackedFiles = yield* trackedFileNames
  const textFiles = yield* Effect.forEach(
    trackedFiles
      .filter((file) => /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(file))
      .filter((file) => !file.includes("/dist/")),
    readTrackedFile,
    { concurrency: 32 },
  )

  const failures: string[] = []
  const pushFailure = (message: string): void => {
    if (!failures.includes(message)) failures.push(message)
  }

  // Export-consumer scan needs the whole tree: collect every declared export
  // in the scanned surfaces, then count which names any other file reaches.
  const exportFacts = new Map<string, ExportFacts>()
  // Seam scan needs the whole tree too: the declarations live in core, the
  // adapters that fill them live in the shipped extensions and the apps.
  const sourceTexts = new Map<string, string>()
  const adaptedSeams = new Set<string>()

  /**
   * Facts the cross-file scans need, gathered in the single pass over the
   * tree. Each of these is answerable only once every file has been read:
   * whether an export is consumed, and whether a seam has an adapter.
   */
  const collectWholeTreeFacts = (file: string, text: string): void => {
    exportFacts.set(file, collectExportFacts(file, text))
    sourceTexts.set(file, text)
    for (const seam of adaptedSeamsIn(file, text)) adaptedSeams.add(seam)
  }

  for (const maybeEntry of textFiles) {
    if (Option.isNone(maybeEntry)) continue
    const { file, text } = maybeEntry.value

    for (const finding of [
      ...findBlanketEslintDisables(file, text),
      ...findBannedEslintDisableBlocks(file, text),
    ]) {
      pushFailure(
        `${finding.file}:${finding.line}: blanket eslint-disable comments and block eslint-disable comments are banned; use line-local suppressions with exact rules`,
      )
    }

    for (const finding of findSuppressionInventoryFindings(file, text)) {
      pushFailure(`${finding.file}:${finding.line}: unreviewed suppression ${finding.kind}`)
    }

    if (/\.[cm]?[jt]sx?$/.test(file)) {
      for (const finding of [
        ...findPlatformDuplicationViolations(file, text),
        ...findCoreFeatureIndependenceFindings(file, text),
        ...findRetiredReconcilerFindings(file, text),
        ...findCoreVendorModelPins(file, text),
        ...findAliasTestLayers(file, text),
        ...findE2eFixtureImportFindings(file, text),
        ...findUnadmittedChildSessionWriters(file, text),
        ...findIdentityEncodes(file, text),
      ]) {
        pushFailure(`${finding.file}:${finding.line}: ${finding.message}`)
      }

      collectWholeTreeFacts(file, text)
    }
  }

  for (const finding of findUnusedSuppressionApprovals(sourceTexts)) {
    pushFailure(
      `${finding.file}: approved suppression has no matching comment; drop it from packages/tooling/src/suppression-inventory.ts: ${finding.comment}`,
    )
  }

  const reportOnly: string[] = []
  for (const finding of findUnconsumedExports(exportFacts)) {
    const line = `${finding.file}:${finding.line}: ${finding.message}`
    if (finding.enforced) pushFailure(line)
    else reportOnly.push(line)
  }

  for (const finding of findUnadaptedSeams(sourceTexts, adaptedSeams)) {
    pushFailure(`${finding.file}:${finding.line}: ${finding.message}`)
  }

  const packageJsonPaths = [
    "packages/core/package.json",
    "packages/core-internal/package.json",
    "packages/extensions/package.json",
    "packages/sdk/package.json",
  ]
  const [tsconfigJson, ...packageJsons] = yield* Effect.all(
    [readJsonFile("tsconfig.json"), ...packageJsonPaths.map(readJsonFile)],
    { concurrency: "unbounded" },
  )
  const packageJsonByPath = new Map<string, PackageJson>(
    packageJsonPaths.map((path, index) => [path, packageJsons[index]]),
  )

  for (const finding of findPackageSurfaceFindings(packageJsonByPath, tsconfigJson)) {
    pushFailure(`${finding.path}: ${finding.message}`)
  }

  if (reportOnly.length > 0) {
    yield* Console.warn("Gent guardrails report-only findings:")
    yield* Effect.forEach(reportOnly, (line) => Console.warn(`  ${line}`), { discard: true })
  }

  if (failures.length === 0) return
  yield* Console.error("Gent guardrails failed:")
  yield* Effect.forEach(failures, (failure) => Console.error(`  ${failure}`), { discard: true })
  return yield* Effect.fail("Gent guardrails failed")
})

BunRuntime.runMain(program)
