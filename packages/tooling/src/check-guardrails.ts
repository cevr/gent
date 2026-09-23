import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Option, Schema } from "effect"
import {
  adaptedSeamsIn,
  collectExportFacts,
  type ExportFacts,
  type Finding,
  findAliasTestLayers,
  findBannedEslintDisableBlocks,
  findBlanketEslintDisables,
  findCoreFeatureIndependenceFindings,
  findCoreVendorModelPins,
  findE2eFixtureImportFindings,
  findHookWithoutGuards,
  findIdentityEncodes,
  findPackageSurfaceFindings,
  findPlatformDuplicationViolations,
  findReadersWithoutWriters,
  findRetiredSurfaces,
  findSteeringFilePaths,
  findSuppressionInventoryFindings,
  findTuiSessionIdentityReads,
  findUnadaptedSeams,
  findUnadmittedChildSessionWriters,
  findUnconsumedExports,
  findUnenabledPluginRules,
  findUnmatchedOverrideGlobs,
  findUnusedSuppressionApprovals,
  HOOK_FILE,
  isSteeringFile,
  OxlintConfigSchema,
  PACKAGE_SURFACE_MANIFESTS,
  type PackageJson,
} from "./guards"
import gentRules from "./gent-rules"

const trackedFileNames = Effect.promise(() =>
  Bun.$`git ls-files --cached --others --exclude-standard`.text(),
).pipe(Effect.map((output) => output.split("\n").filter((file) => file.length > 0)))

/**
 * Tracked symlinks (git mode 120000). A symlink is not a second file: its
 * target is read under its own name, so reading the link too would report
 * every finding twice.
 */
const trackedSymlinks = Effect.promise(() => Bun.$`git ls-files --stage`.text()).pipe(
  Effect.map(
    (output) =>
      new Set(
        output
          .split("\n")
          .filter((row) => row.startsWith("120000 "))
          .map((row) => row.slice(row.indexOf("\t") + 1)),
      ),
  ),
)

const readTrackedFile = Effect.fn("Tooling.readTrackedFile")(function* (file: string) {
  const source = Bun.file(file)
  if (!(yield* Effect.promise(() => source.exists()))) return Option.none()
  return Option.some({ file, text: yield* Effect.promise(() => source.text()) })
})

const readJsonFile = Effect.fn("Tooling.readJsonFile")(function* (path: string) {
  return yield* Effect.promise(() => Bun.file(path).json())
})

const OXLINT_CONFIG = ".oxlintrc.json"
const LINT_PLUGIN = "packages/tooling/src/gent-rules.ts"

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
  return [
    ...findUnmatchedOverrideGlobs(OXLINT_CONFIG, configText, config, trackedFiles),
    ...findUnenabledPluginRules(LINT_PLUGIN, pluginText, Object.keys(gentRules.rules), rootRules),
  ]
})

type FileFinder = (file: string, text: string) => ReadonlyArray<Finding>

/** Findings any scanned file answers on its own: source, config, docs and the hook. */
const ANY_FILE_FINDERS: ReadonlyArray<FileFinder> = [
  findBlanketEslintDisables,
  findBannedEslintDisableBlocks,
  findSuppressionInventoryFindings,
  findHookWithoutGuards,
]

/** Findings a source file answers on its own, without the rest of the tree. */
const SOURCE_FILE_FINDERS: ReadonlyArray<FileFinder> = [
  findPlatformDuplicationViolations,
  findCoreFeatureIndependenceFindings,
  findRetiredSurfaces,
  findCoreVendorModelPins,
  findAliasTestLayers,
  findE2eFixtureImportFindings,
  findUnadmittedChildSessionWriters,
  findIdentityEncodes,
  findTuiSessionIdentityReads,
]

const isSourceFile = (file: string): boolean => /\.[cm]?[jt]sx?$/.test(file)

/** The findings that read the package manifests and the root tsconfig. */
const packageSurfaceFindings = Effect.fn("Tooling.packageSurfaceFindings")(function* () {
  const packageJsonPaths = PACKAGE_SURFACE_MANIFESTS
  const [tsconfigJson, ...packageJsons] = yield* Effect.all(
    [readJsonFile("tsconfig.json"), ...packageJsonPaths.map(readJsonFile)],
    { concurrency: "unbounded" },
  )
  const packageJsonByPath = new Map<string, PackageJson>(
    packageJsonPaths.map((path, index) => [path, packageJsons[index]]),
  )
  return findPackageSurfaceFindings(packageJsonByPath, tsconfigJson)
})

/** One tracked file the scan reads: its path and its text. */
export interface TrackedText {
  readonly file: string
  readonly text: string
}

/** A manifest: its `scripts` can set a `GENT_*` variable, the way an operator's shell does. */
const isManifest = (file: string): boolean => /(?:^|\/)package\.json$/.test(file)

/**
 * Route every scanned file to the finders that read it, then run the scans
 * that need the whole tree. The lint config and the package surfaces read
 * their own files; everything else answers from `files`.
 */
export const scanTrackedTexts = (
  files: ReadonlyArray<TrackedText>,
  trackedFiles: ReadonlyArray<string>,
) => {
  const findings: Array<Finding> = []

  // Export-consumer scan needs the whole tree: collect every declared export
  // in the scanned surfaces, then count which names any other file reaches.
  const exportFacts = new Map<string, ExportFacts>()
  // Seam scan needs the whole tree too: the declarations live in core, the
  // adapters that fill them live in the shipped extensions and the apps.
  const sourceTexts = new Map<string, string>()
  const adaptedSeams = new Set<string>()
  // A package script is a writer of the variables it sets.
  const manifestTexts = new Map<string, string>()

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

  for (const { file, text } of files) {
    for (const finder of ANY_FILE_FINDERS) findings.push(...finder(file, text))
    findings.push(...findSteeringFilePaths(file, text, trackedFiles))
    if (isManifest(file)) manifestTexts.set(file, text)
    if (!isSourceFile(file)) continue
    for (const finder of SOURCE_FILE_FINDERS) findings.push(...finder(file, text))
    collectWholeTreeFacts(file, text)
  }

  findings.push(
    ...findUnusedSuppressionApprovals(sourceTexts),
    ...findUnconsumedExports(exportFacts),
    ...findUnadaptedSeams(sourceTexts, adaptedSeams),
    // A GENT_* variable whose writer left: its reader is a branch nothing takes.
    ...findReadersWithoutWriters(new Map([...sourceTexts, ...manifestTexts])),
  )
  return { findings, sourceTexts }
}

const program = Effect.gen(function* () {
  const trackedFiles = yield* trackedFileNames
  const symlinks = yield* trackedSymlinks
  const textFiles = yield* Effect.forEach(
    trackedFiles
      // The steering files are Markdown and the hook is YAML; both join the
      // pass so their own scans get the text.
      .filter(
        (file) =>
          /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(file) || isSteeringFile(file) || file === HOOK_FILE,
      )
      .filter((file) => !file.includes("/dist/") && !symlinks.has(file)),
    readTrackedFile,
    { concurrency: 32 },
  )

  const { findings: treeFindings, sourceTexts } = scanTrackedTexts(
    textFiles.flatMap(Option.toArray),
    trackedFiles,
  )
  const findings: Array<Finding> = [
    ...treeFindings,
    // The lint config must not name a file or a rule that is gone.
    ...(yield* lintConfigFindings(trackedFiles, sourceTexts)),
    ...(yield* packageSurfaceFindings()),
  ]

  // Two finders may report one line with one message; say it once.
  const failures = [
    ...new Set(findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`)),
  ]
  if (failures.length === 0) return
  yield* Console.error("Gent guardrails failed:")
  yield* Effect.forEach(failures, (failure) => Console.error(`  ${failure}`), { discard: true })
  return yield* Effect.fail("Gent guardrails failed")
})

if (import.meta.main) BunRuntime.runMain(program)
