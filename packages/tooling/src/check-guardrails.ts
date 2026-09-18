import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Option, Schema } from "effect"
import {
  adaptedSeamsIn,
  collectExportFacts,
  type ExportFacts,
  findAliasTestLayers,
  findBannedEslintDisableBlocks,
  findBlanketEslintDisables,
  findCoreFeatureIndependenceFindings,
  findCoreVendorModelPins,
  findDiagnosticSuppressionAnchors,
  findE2eFixtureImportFindings,
  findHookGuardOrder,
  findIdentityEncodes,
  findPackageSurfaceFindings,
  findPlatformDuplicationViolations,
  findProcessRunnerFindings,
  findReadersWithoutWriters,
  findRetiredReconcilerFindings,
  findSteeringFilePaths,
  findSuppressionInventoryFindings,
  findTuiSessionIdentityReads,
  findUnadaptedSeams,
  findUnadmittedChildSessionWriters,
  findUnconsumedExports,
  findUnenabledPluginRules,
  findUnmatchedOverrideGlobs,
  findMissingLockIncludes,
  LocksTsconfigSchema,
  findUnusedSuppressionApprovals,
  HOOK_FILE,
  isSteeringFile,
  OxlintConfigSchema,
  type PackageJson,
} from "./guards"

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

const OXLINT_CONFIG = ".oxlintrc.json"
const LINT_PLUGIN = "lint/no-direct-env.ts"

/** The two findings that read the lint config rather than one source file. */
const lintConfigFindings = Effect.fn("Tooling.lintConfigFindings")(function* (
  trackedFiles: ReadonlyArray<string>,
  sourceTexts: ReadonlyMap<string, string>,
) {
  const configText = yield* Effect.promise(() => Bun.file(OXLINT_CONFIG).text())
  // The config is JSONC: it carries a `//` note above most rules.
  const config = yield* Schema.decodeEffect(Schema.fromJsonString(OxlintConfigSchema))(
    configText.replace(/^\s*\/\/.*$/gm, ""),
  )
  const rootRules = new Set(Object.keys(config.rules ?? {}))
  const pluginText = Option.getOrElse(Option.fromNullishOr(sourceTexts.get(LINT_PLUGIN)), () => "")
  const lockFindings = yield* Effect.forEach(
    trackedFiles.filter((file) => file.endsWith("/tsconfig.locks.json")),
    Effect.fn("Tooling.lockIncludeFindings")(function* (lockFile: string) {
      const lockText = yield* Effect.promise(() => Bun.file(lockFile).text())
      const lock = yield* Schema.decodeEffect(Schema.fromJsonString(LocksTsconfigSchema))(lockText)
      return findMissingLockIncludes(lockFile, lockText, lock, trackedFiles)
    }),
  )
  return [
    ...findUnmatchedOverrideGlobs(OXLINT_CONFIG, configText, config, trackedFiles),
    ...lockFindings.flat(),
    ...findUnenabledPluginRules(LINT_PLUGIN, pluginText, rootRules),
  ]
})

/** Every finding one file answers on its own, without the rest of the tree. */
const singleFileFailures = (file: string, text: string): ReadonlyArray<string> => {
  const blanket = [
    ...findBlanketEslintDisables(file, text),
    ...findBannedEslintDisableBlocks(file, text),
  ].map(
    (finding) =>
      `${finding.file}:${finding.line}: blanket eslint-disable comments and block eslint-disable comments are banned; use line-local suppressions with exact rules`,
  )
  const suppressions = findSuppressionInventoryFindings(file, text).map(
    (finding) => `${finding.file}:${finding.line}: unreviewed suppression ${finding.kind}`,
  )
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [...blanket, ...suppressions]
  const sourceOnly = [
    ...findPlatformDuplicationViolations(file, text),
    ...findCoreFeatureIndependenceFindings(file, text),
    ...findRetiredReconcilerFindings(file, text),
    ...findCoreVendorModelPins(file, text),
    ...findAliasTestLayers(file, text),
    ...findE2eFixtureImportFindings(file, text),
    ...findUnadmittedChildSessionWriters(file, text),
    ...findIdentityEncodes(file, text),
    ...findProcessRunnerFindings(file, text),
    ...findTuiSessionIdentityReads(file, text),
    ...findDiagnosticSuppressionAnchors(file, text),
  ].map((finding) => `${finding.file}:${finding.line}: ${finding.message}`)
  return [...blanket, ...suppressions, ...sourceOnly]
}

/**
 * The findings on the files that describe the project rather than run it: the
 * steering documents and the pre-commit hook. Each answers from one file, but
 * the path scan needs the tracked list to resolve what a document names.
 */
const projectFileFailures = (
  file: string,
  text: string,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  [...findSteeringFilePaths(file, text, trackedFiles), ...findHookGuardOrder(file, text)].map(
    (finding) => `${finding.file}:${finding.line}: ${finding.message}`,
  )

/** The findings that read the package manifests and the root tsconfig. */
const packageSurfaceFindings = Effect.fn("Tooling.packageSurfaceFindings")(function* () {
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
  return findPackageSurfaceFindings(packageJsonByPath, tsconfigJson)
})

const program = Effect.gen(function* () {
  const trackedFiles = yield* trackedFileNames
  const textFiles = yield* Effect.forEach(
    trackedFiles
      // The steering files are Markdown and the hook is YAML; both join the
      // pass so their own scans get the text.
      .filter(
        (file) =>
          /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(file) || isSteeringFile(file) || file === HOOK_FILE,
      )
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
    for (const failure of singleFileFailures(file, text)) pushFailure(failure)
    for (const failure of projectFileFailures(file, text, trackedFiles)) pushFailure(failure)
    if (/\.[cm]?[jt]sx?$/.test(file)) collectWholeTreeFacts(file, text)
  }

  for (const finding of findUnusedSuppressionApprovals(sourceTexts)) {
    pushFailure(
      `${finding.file}: approved suppression has no matching comment; drop it from packages/tooling/src/guards.ts: ${finding.comment}`,
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

  // A GENT_* variable whose writer left: its reader is a branch nothing takes.
  for (const finding of findReadersWithoutWriters(sourceTexts)) {
    pushFailure(`${finding.file}:${finding.line}: ${finding.message}`)
  }

  // The lint config must not name a file or a rule that is gone.
  for (const finding of yield* lintConfigFindings(trackedFiles, sourceTexts)) {
    pushFailure(`${finding.file}:${finding.line}: ${finding.message}`)
  }

  for (const finding of yield* packageSurfaceFindings()) {
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
