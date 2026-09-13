import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Option } from "effect"
import { findBannedEslintDisableBlocks, findBlanketEslintDisables } from "./blanket-eslint-disable"
import {
  findCorePublicExportFindings,
  findExtensionsPublicExportFindings,
  findSdkPublicExportFindings,
} from "./core-public-exports"
import { findCoreFeatureIndependenceFindings } from "./core-feature-independence"
import { findRetiredReconcilerFindings } from "./core-retired-reconciler"
import { findCoreVendorModelPins } from "./core-vendor-model-pins"
import { findAliasTestLayers } from "./core-alias-test-layers"
import { declaredCoreExports, findCoreDeadExports, identifiersIn } from "./core-dead-exports"
import { findPlatformDuplicationViolations } from "./platform-duplication-guards"
import { findSuppressionInventoryFindings } from "./suppression-inventory"
import { adaptedSeamsIn, findUnadaptedSeams } from "./core-unadapted-seams"
import { consumedNamesIn, findUnconsumedPublicApi } from "./core-public-api-consumers"

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
  const textFiles = yield* Effect.all(
    trackedFiles
      .filter((file) => /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(file))
      .filter((file) => !file.includes("/dist/"))
      .map(readTrackedFile),
    { concurrency: 32 },
  )

  const failures: string[] = []
  const pushFailure = (message: string): void => {
    if (!failures.includes(message)) failures.push(message)
  }

  // Dead-export scan needs the whole tree: collect every declared core export,
  // then count which names any other file mentions.
  const coreDeclarations: Array<{ file: string; name: string; line: number }> = []
  const identifiersByFile = new Map<string, ReadonlySet<string>>()
  // Seam scan needs the whole tree too: the declarations live in core, the
  // adapters that fill them live in the shipped extensions and the apps.
  const sourceTexts = new Map<string, string>()
  const adaptedSeams = new Set<string>()
  // Public-API scan needs it as well: the names live in core's entry point,
  // the consumers live everywhere else.
  const consumedApiNames = new Set<string>()

  /**
   * Facts the cross-file scans need, gathered in the single pass over the
   * tree. Each of these is answerable only once every file has been read:
   * whether an export is dead, and whether a seam has an adapter.
   */
  const collectWholeTreeFacts = (file: string, text: string): void => {
    for (const declaration of declaredCoreExports(file, text)) {
      coreDeclarations.push({ file, ...declaration })
    }
    identifiersByFile.set(file, identifiersIn(text))
    sourceTexts.set(file, text)
    for (const seam of adaptedSeamsIn(file, text)) adaptedSeams.add(seam)
    for (const name of consumedNamesIn(file, text)) consumedApiNames.add(name)
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
      ]) {
        pushFailure(`${finding.file}:${finding.line}: ${finding.message}`)
      }

      collectWholeTreeFacts(file, text)
    }
  }

  for (const finding of findCoreDeadExports(coreDeclarations, identifiersByFile)) {
    pushFailure(`${finding.file}:${finding.line}: ${finding.message}`)
  }

  for (const finding of findUnadaptedSeams(sourceTexts, adaptedSeams)) {
    pushFailure(`${finding.file}:${finding.line}: ${finding.message}`)
  }

  for (const finding of findUnconsumedPublicApi(sourceTexts, consumedApiNames)) {
    pushFailure(`${finding.file}:${finding.line}: ${finding.message}`)
  }

  const [
    packageJson,
    tsconfigJson,
    coreInternalPackageJson,
    extensionsPackageJson,
    sdkPackageJson,
  ] = yield* Effect.all(
    [
      readJsonFile("packages/core/package.json"),
      readJsonFile("tsconfig.json"),
      readJsonFile("packages/core-internal/package.json"),
      readJsonFile("packages/extensions/package.json"),
      readJsonFile("packages/sdk/package.json"),
    ],
    { concurrency: "unbounded" },
  )

  for (const finding of [
    ...findCorePublicExportFindings(
      packageJson,
      tsconfigJson,
      Option.some(coreInternalPackageJson),
    ),
    ...findExtensionsPublicExportFindings(extensionsPackageJson, tsconfigJson),
    ...findSdkPublicExportFindings(sdkPackageJson),
  ]) {
    pushFailure(`${finding.path}: ${finding.message}`)
  }

  if (failures.length === 0) return
  yield* Console.error("Gent guardrails failed:")
  yield* Effect.forEach(failures, (failure) => Console.error(`  ${failure}`), { discard: true })
  return yield* Effect.fail("Gent guardrails failed")
})

BunRuntime.runMain(program)
