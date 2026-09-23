import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Option, Result, Schema } from "effect"
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
  isRetiredSurfaceProse,
  isSteeringFile,
  OxlintConfigSchema,
  type PackageJson,
  workspaceManifests,
  workspaceTsconfigs,
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
  findRetiredSurfaces,
]

/** Findings a source file answers on its own, without the rest of the tree. */
const SOURCE_FILE_FINDERS: ReadonlyArray<FileFinder> = [
  findPlatformDuplicationViolations,
  findCoreFeatureIndependenceFindings,
  findCoreVendorModelPins,
  findAliasTestLayers,
  findE2eFixtureImportFindings,
  findUnadmittedChildSessionWriters,
  findIdentityEncodes,
  findTuiSessionIdentityReads,
]

const isSourceFile = (file: string): boolean => /\.[cm]?[jt]sx?$/.test(file)

/** The one root manifest field the package-surface check reads. */
const RootManifestSchema = Schema.Struct({
  workspaces: Schema.optional(Schema.Array(Schema.String)),
})

/** The one tsconfig field the paths check reads. */
const TsConfigSchema = Schema.Struct({
  compilerOptions: Schema.optional(
    Schema.Struct({
      paths: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
    }),
  ),
})

/** A tsconfig is JSON with comments and trailing commas, which TypeScript accepts. */
const readTsconfig = Effect.fn("Tooling.readTsconfig")(function* (path: string) {
  const text = yield* Effect.promise(() => Bun.file(path).text())
  return yield* Effect.try({
    try: () => Bun.JSONC.parse(text),
    catch: (error) => String(error),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(TsConfigSchema)(parsed).pipe(
        Effect.mapError((error) => error.message),
      ),
    ),
    Effect.result,
  )
})

/** The findings that read every workspace manifest and every workspace tsconfig. */
const packageSurfaceFindings = Effect.fn("Tooling.packageSurfaceFindings")(function* (
  trackedFiles: ReadonlyArray<string>,
) {
  const rootManifest = yield* readJsonFile("package.json")
  const { workspaces } = yield* Schema.decodeUnknownEffect(RootManifestSchema)(rootManifest)
  const manifests = workspaceManifests(workspaces ?? [], trackedFiles)
  const packageJsons = yield* Effect.forEach(manifests, readJsonFile, { concurrency: 8 })
  const packageJsonByPath = new Map<string, PackageJson>(
    manifests.map((path, index) => [path, packageJsons[index]]),
  )
  const tsconfigPaths = workspaceTsconfigs(trackedFiles)
  const tsconfigs = yield* Effect.forEach(tsconfigPaths, readTsconfig, { concurrency: 8 })
  const unreadable: Array<Finding> = []
  const tsconfigByPath = new Map<string, typeof TsConfigSchema.Type>()
  for (const [index, read] of tsconfigs.entries()) {
    const path = tsconfigPaths.at(index) ?? "tsconfig.json"
    if (Result.isSuccess(read)) tsconfigByPath.set(path, read.success)
    else
      unreadable.push({ file: path, line: 1, message: `not a readable tsconfig: ${read.failure}` })
  }
  return [...unreadable, ...findPackageSurfaceFindings(packageJsonByPath, tsconfigByPath)]
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
      // The steering files and docs are Markdown and the hook is YAML; they
      // join the pass so their own scans get the text.
      .filter(
        (file) =>
          /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(file) ||
          isSteeringFile(file) ||
          isRetiredSurfaceProse(file) ||
          file === HOOK_FILE,
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
    ...(yield* packageSurfaceFindings(trackedFiles)),
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
