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
  findEffectVersionDrift,
  findRepoTempDirectories,
  findSharedTestHomes,
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
  findUnconsumedExports,
  findUnenabledPluginRules,
  findUnmatchedIgnoreRows,
  findUnmatchedOverrideGlobs,
  findUnmatchedTsconfigOverrides,
  findUnhashedSteeringFiles,
  findUnshippedSkillFiles,
  BUNDLED_SKILLS_MODULE,
  findUnusedSuppressionApprovals,
  HOOK_FILE,
  isSteeringFile,
  OxlintConfigSchema,
  type DependencyScope,
  findUnusedCatalogEntries,
  findUnusedDependencies,
  type InstalledDependency,
  installedDependency,
  InstalledPackageSchema,
  type PackageJson,
  PackageJsonSchema,
  type TsConfigJson,
  TsConfigPluginsSchema,
  TsConfigSchema,
  TurboTypecheckInputsSchema,
  workspaceManifests,
  workspaceTsconfigs,
} from "./guards"
import gentRules from "./gent-rules"

const fileNames = (output: string): ReadonlyArray<string> =>
  output.split("\n").filter((file) => file.length > 0)

/**
 * The one file set every guard reads: the git index of the repository at
 * `root`, under git's environment `env`. It answers both which files the scan
 * reads and every existence question (a config row, a steering path, a
 * dependency use, an export consumer). In CI the index is `HEAD`; in a
 * pre-commit hook git sets `GIT_INDEX_FILE` to the index the commit is made
 * from (a temporary one for `git commit -- <path>`), so it is the commit being
 * made; outside a hook it is what the next commit holds. An untracked file
 * never satisfies a check: a clean clone would not hold it.
 */
export const indexFileNames = (root: string, env: typeof Bun.env) =>
  Effect.promise(() =>
    Bun.$`git ls-files --cached`
      .cwd(root)
      .env({ ...env })
      .text(),
  ).pipe(Effect.map(fileNames))

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

/**
 * Every config the guards read goes through one reader. Tsconfigs and the
 * lint config are JSON with comments and trailing commas; a manifest is plain
 * JSON, a subset. The schema names only the fields a check reads.
 */
const readJsonc = Effect.fn("Tooling.readJsonc")(function* <
  S extends Schema.Top & { readonly DecodingServices: never },
>(path: string, schema: S) {
  const text = yield* Effect.promise(() => Bun.file(path).text())
  const parsed = yield* Effect.try({
    try: (): unknown => Bun.JSONC.parse(text),
    catch: (error) => `${path}: ${String(error)}`,
  })
  const value = yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.mapError((error) => `${path}: ${error.message}`),
  )
  return { text, value }
})

const OXLINT_CONFIG = ".oxlintrc.json"
const OXLINT_IGNORE = ".oxlintignore"
const ROOT_TSCONFIG = "tsconfig.json"
const LINT_PLUGIN = "packages/tooling/src/gent-rules.ts"

/** The findings that read the lint and compiler configs rather than one source file. */
const lintConfigFindings = Effect.fn("Tooling.lintConfigFindings")(function* (
  indexFiles: ReadonlyArray<string>,
  sourceTexts: ReadonlyMap<string, string>,
) {
  const { text: configText, value: config } = yield* readJsonc(OXLINT_CONFIG, OxlintConfigSchema)
  const tsconfig = yield* readJsonc(ROOT_TSCONFIG, TsConfigPluginsSchema)
  const ignoreText = Option.match(yield* readTrackedFile(OXLINT_IGNORE), {
    onNone: () => "",
    onSome: (read) => read.text,
  })
  const rootRules = new Set(Object.keys(config.rules ?? {}))
  const pluginText = Option.getOrElse(Option.fromNullishOr(sourceTexts.get(LINT_PLUGIN)), () => "")
  return [
    ...findUnmatchedOverrideGlobs(OXLINT_CONFIG, configText, config, indexFiles),
    ...findUnmatchedIgnoreRows(OXLINT_IGNORE, ignoreText, indexFiles),
    ...findUnmatchedTsconfigOverrides(ROOT_TSCONFIG, tsconfig.text, tsconfig.value, indexFiles),
    ...findUnenabledPluginRules(LINT_PLUGIN, pluginText, Object.keys(gentRules.rules), rootRules),
  ]
})

/** The package whose typecheck runs the guide check (`check-guide-code.ts`). */
const GUIDE_CHECK_TURBO = "examples/turbo.json"

/** The guide check's cache key against the steering files, new ones included. */
const guideInputFindings = Effect.fn("Tooling.guideInputFindings")(function* (
  indexFiles: ReadonlyArray<string>,
) {
  const { value } = yield* readJsonc(GUIDE_CHECK_TURBO, TurboTypecheckInputsSchema)
  return findUnhashedSteeringFiles(GUIDE_CHECK_TURBO, value.tasks.typecheck.inputs, indexFiles)
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
  findRepoTempDirectories,
  findSharedTestHomes,
  findIdentityEncodes,
  findTuiSessionIdentityReads,
]

const isSourceFile = (file: string): boolean => /\.[cm]?[jt]sx?$/.test(file)

const ROOT_MANIFEST = "package.json"

/** A manifest as read: its text, for finding lines, and the decoded fields. */
interface ManifestRead {
  readonly text: string
  readonly value: PackageJson
}

/** The installed manifest of `name` under the first base that has it, or none. */
const readInstalled = Effect.fn("Tooling.readInstalled")(function* (
  bases: ReadonlyArray<string>,
  name: string,
) {
  for (const base of bases) {
    const path = `${base}node_modules/${name}/package.json`
    if (!(yield* Effect.promise(() => Bun.file(path).exists()))) continue
    const read = yield* Effect.result(readJsonc(path, InstalledPackageSchema))
    if (Result.isSuccess(read)) return Option.some(installedDependency(name, read.success.value))
  }
  return Option.none<InstalledDependency>()
})

/** Each declared dependency of `packageJson` as the scope resolves it: its own install first. */
const installedOf = Effect.fn("Tooling.installedOf")(function* (
  bases: ReadonlyArray<string>,
  packageJson: PackageJson,
) {
  const names = Object.keys({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  })
  const installed = new Map<string, InstalledDependency>()
  for (const name of names) {
    for (const found of Option.toArray(yield* readInstalled(bases, name)))
      installed.set(name, found)
  }
  return installed
})

/** Files that can load, name or run a dependency: source, config, hooks and CI steps. */
const isDependencyUseFile = (file: string): boolean =>
  /\.(?:[cm]?[jt]sx?|jsonc?|toml|ya?ml)$/.test(file) &&
  !file.includes("/dist/") &&
  !file.includes("node_modules/")

const scriptsOf = (packageJson: PackageJson): ReadonlyArray<string> =>
  Object.values(packageJson.scripts ?? {})

/**
 * One scope per manifest. A workspace's dependencies serve its own directory
 * and scripts. The root's serve the whole tree: every package script, the
 * hook and the CI steps can run them, and it installs the peers the
 * workspaces use.
 */
const dependencyScopes = Effect.fn("Tooling.dependencyScopes")(function* (
  root: ManifestRead,
  manifests: ReadonlyMap<string, ManifestRead>,
  indexFiles: ReadonlyArray<string>,
) {
  const reads = yield* Effect.forEach(indexFiles.filter(isDependencyUseFile), readTrackedFile, {
    concurrency: 32,
  })
  const useTexts = new Map<string, string>(
    reads.flatMap(Option.toArray).map(({ file, text }) => [file, text]),
  )
  const rootScope: DependencyScope = {
    manifest: ROOT_MANIFEST,
    manifestText: root.text,
    packageJson: root.value,
    files: useTexts,
    commands: [
      ...[root, ...manifests.values()].flatMap((read) => scriptsOf(read.value)),
      ...[...useTexts].filter(([file]) => /\.ya?ml$/.test(file)).map(([, text]) => text),
    ],
    installed: yield* installedOf([""], root.value),
  }
  const workspaceScopes = yield* Effect.forEach([...manifests], ([manifest, read]) => {
    const directory = manifest.slice(0, -"package.json".length)
    return Effect.map(installedOf([directory, ""], read.value), (installed): DependencyScope => ({
      manifest,
      manifestText: read.text,
      packageJson: read.value,
      files: new Map([...useTexts].filter(([file]) => file.startsWith(directory))),
      commands: scriptsOf(read.value),
      installed,
    }))
  })
  return { root: rootScope, workspaces: workspaceScopes }
})

/** The findings that read every manifest and every workspace tsconfig. */
const packageSurfaceFindings = Effect.fn("Tooling.packageSurfaceFindings")(function* (
  indexFiles: ReadonlyArray<string>,
) {
  const root = yield* readJsonc(ROOT_MANIFEST, PackageJsonSchema)
  const manifestPaths = workspaceManifests(root.value.workspaces ?? [], indexFiles)
  const manifestReads = yield* Effect.forEach(
    manifestPaths,
    (path) => readJsonc(path, PackageJsonSchema),
    { concurrency: 8 },
  )
  const manifests = new Map<string, ManifestRead>(
    manifestReads.map((read, index) => [manifestPaths[index] ?? "", read]),
  )
  const tsconfigPaths = workspaceTsconfigs(indexFiles)
  const tsconfigs = yield* Effect.forEach(
    tsconfigPaths,
    (path) => Effect.result(readJsonc(path, TsConfigSchema)),
    { concurrency: 8 },
  )
  const unreadable: Array<Finding> = []
  const tsconfigByPath = new Map<string, TsConfigJson>()
  for (const [index, read] of tsconfigs.entries()) {
    const path = tsconfigPaths.at(index) ?? "tsconfig.json"
    if (Result.isSuccess(read)) tsconfigByPath.set(path, read.success.value)
    else
      unreadable.push({ file: path, line: 1, message: `not a readable tsconfig: ${read.failure}` })
  }
  const packageJsonByPath = new Map<string, PackageJson>(
    [...manifests].map(([path, read]) => [path, read.value]),
  )
  return [
    ...unreadable,
    ...findPackageSurfaceFindings(packageJsonByPath, tsconfigByPath),
    ...findUnusedDependencies(yield* dependencyScopes(root, manifests, indexFiles)),
    ...findUnusedCatalogEntries(
      { manifest: ROOT_MANIFEST, text: root.text, packageJson: root.value },
      [...manifests.values()].map((read) => read.value),
    ),
    ...findEffectVersionDrift(
      { manifest: ROOT_MANIFEST, text: root.text, packageJson: root.value },
      [...manifests].map(([manifest, read]) => ({
        manifest,
        text: read.text,
        packageJson: read.value,
      })),
    ),
  ]
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
  indexFiles: ReadonlyArray<string>,
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
    findings.push(...findSteeringFilePaths(file, text, indexFiles))
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
    // A bundled skill file the skills module does not import never ships.
    ...findUnshippedSkillFiles(sourceTexts.get(BUNDLED_SKILLS_MODULE) ?? "", indexFiles),
  )
  return { findings, sourceTexts }
}

const program = Effect.gen(function* () {
  const indexFiles = yield* indexFileNames(".", Bun.env)
  const symlinks = yield* trackedSymlinks
  const textFiles = yield* Effect.forEach(
    indexFiles
      // The steering files and docs are Markdown and the hook is YAML; they
      // join the pass so their own scans get the text.
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
    indexFiles,
  )
  const findings: Array<Finding> = [
    ...treeFindings,
    // The lint config must not name a file or a rule that is gone.
    ...(yield* lintConfigFindings(indexFiles, sourceTexts)),
    ...(yield* packageSurfaceFindings(indexFiles)),
    ...(yield* guideInputFindings(indexFiles)),
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
