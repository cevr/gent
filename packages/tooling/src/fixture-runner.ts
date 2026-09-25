import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { type LintDiagnostic, overrideOffs, rootOffs } from "./guards"

const DiagnosticSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  rule_id: Schema.optional(Schema.String),
  message: Schema.String,
  filename: Schema.optional(Schema.String),
})
export type Diagnostic = typeof DiagnosticSchema.Type

const OxlintReportSchema = Schema.Struct({
  diagnostics: Schema.Array(DiagnosticSchema),
  number_of_files: Schema.Int,
})
export type OxlintReport = typeof OxlintReportSchema.Type

export interface OxlintRun {
  readonly report: OxlintReport
  readonly exitCode: number
  readonly stderr: string
}

/** One oxlint run did not produce a report. */
export class OxlintRunError extends Schema.TaggedError<OxlintRunError>()("OxlintRunError", {
  message: Schema.String,
}) {}

const FIXTURES_DIR = Bun.fileURLToPath(new URL("../fixtures", import.meta.url))
const FIXTURES_CONFIG = Bun.fileURLToPath(new URL("../fixtures/.oxlintrc.json", import.meta.url))
const REPO_ROOT = Bun.fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "")

/** The bound on one oxlint run over a fixture set; about a second on an idle machine. */
const OXLINT_RUN_BOUND_MS = 20_000

const decodeOxlintReport = Schema.decodeUnknownEffect(Schema.fromJsonString(OxlintReportSchema))

/**
 * One synchronous oxlint process with a JSON report. Its own bound is the
 * only bound: an overrun is one `OxlintRunError` that names the bound, not a
 * test timeout that kills the process mid-report.
 */
const spawnOxlint = Effect.fn("Tooling.spawnOxlint")(function* (
  args: ReadonlyArray<string>,
  cwd: string,
  boundMs: number,
  subject: string,
) {
  const proc = Bun.spawnSync(["bunx", "oxlint", "--format=json", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: boundMs,
  })
  const stderr = proc.stderr.toString()
  if (proc.exitedDueToTimeout === true) {
    return yield* new OxlintRunError({
      message: `oxlint did not lint ${subject} within ${boundMs} ms`,
    })
  }
  const report = yield* decodeOxlintReport(proc.stdout.toString()).pipe(
    Effect.mapError(
      (error) =>
        new OxlintRunError({
          message: `oxlint exited ${proc.exitCode} without a JSON report: ${error.message}\nstderr:\n${stderr}`,
        }),
    ),
  )
  return { report, exitCode: proc.exitCode, stderr }
})

/**
 * Lint a fixture set in one oxlint process. The run is synchronous, so a test
 * file can lint its fixtures while it registers its tests.
 */
export const runOxlint = (fixtureFiles: ReadonlyArray<string>) =>
  spawnOxlint(
    ["-c", FIXTURES_CONFIG, ...fixtureFiles],
    FIXTURES_DIR,
    OXLINT_RUN_BOUND_MS,
    `${fixtureFiles.length} fixture files`,
  )

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

/**
 * The parts of the root config the copy rewrites. Every other key, at the
 * root and in each override, passes through unchanged, so the copy lints
 * exactly as the real config does apart from the removed offs.
 */
const ProbedConfigSchema = Schema.StructWithRest(
  Schema.Struct({
    jsPlugins: Schema.Array(Schema.String),
    rules: UnknownRecord,
    overrides: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          files: Schema.Array(Schema.String),
          rules: UnknownRecord,
        }),
        [UnknownRecord],
      ),
    ),
  }),
  [UnknownRecord],
)
type ProbedConfig = typeof ProbedConfigSchema.Type

const withoutRules = (
  rules: ProbedConfig["rules"],
  removed: ReadonlyArray<string>,
): ProbedConfig["rules"] =>
  Object.fromEntries(Object.entries(rules).filter(([rule]) => !removed.includes(rule)))

/**
 * The root config minus every "off", in the root `rules` block and in each
 * override, for a copy that lives outside the repo: relative plugin paths and
 * override globs become absolute under `root`, and a package plugin is
 * resolved from it.
 */
export const probeConfig = (
  config: ProbedConfig,
  root: string,
  resolvePlugin: (plugin: string) => string,
): ProbedConfig => {
  const offs = overrideOffs(config)
  return {
    ...config,
    jsPlugins: config.jsPlugins.map((plugin) => {
      if (plugin.startsWith("./")) return `${root}/${plugin.slice(2)}`
      return resolvePlugin(plugin)
    }),
    rules: withoutRules(config.rules, rootOffs(config)),
    overrides: config.overrides.map((override, index) => ({
      ...override,
      files: override.files.map((glob) => `${root}/${glob}`),
      rules: withoutRules(override.rules, offs[index] ?? []),
    })),
  }
}

/**
 * Each diagnostic as the file it names and its rule, read from `code` or,
 * when a report carries only that, `rule_id`. A diagnostic missing either is
 * returned apart: dropping it would make the "off" it belongs to look unneeded.
 */
export const labeledDiagnostics = (report: OxlintReport) => {
  const labeled: Array<LintDiagnostic> = []
  const unlabeled: Array<Diagnostic> = []
  for (const diagnostic of report.diagnostics) {
    const label = Option.all({
      file: Option.fromNullishOr(diagnostic.filename),
      code: Option.firstSomeOf([
        Option.fromNullishOr(diagnostic.code),
        Option.fromNullishOr(diagnostic.rule_id),
      ]),
    })
    if (Option.isSome(label)) labeled.push(label.value)
    else unlabeled.push(diagnostic)
  }
  return { labeled, unlabeled }
}

/** One oxlint process whose wait an interruption stops: the process is killed on release. */
const spawnOxlintInterruptibly = Effect.fn("Tooling.spawnOxlintInterruptibly")(function* (
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const { stdout, stderr, exitCode } = yield* Effect.acquireUseRelease(
    Effect.sync(() =>
      Bun.spawn(["bunx", "oxlint", "--format=json", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }),
    ),
    (proc) =>
      Effect.all(
        {
          stdout: Effect.promise(() => new Response(proc.stdout).text()),
          stderr: Effect.promise(() => new Response(proc.stderr).text()),
          exitCode: Effect.promise(() => proc.exited),
        },
        { concurrency: "unbounded" },
      ),
    (proc) => Effect.sync(() => proc.kill()),
  )
  const report = yield* decodeOxlintReport(stdout).pipe(
    Effect.mapError(
      (error) =>
        new OxlintRunError({
          message: `oxlint exited ${exitCode} without a JSON report: ${error.message}\nstderr:\n${stderr}`,
        }),
    ),
  )
  return { report, exitCode, stderr }
})

/**
 * Lint the whole tree with `probeConfig`'s copy of the root config, from a
 * scoped temporary directory. The result is what each "off" would let
 * through; `findUnneededOffs` reads it. The caller bounds the run
 * with `Effect.timeout`; the process is killed when it fires.
 */
export const lintWithoutOffs = Effect.fn("Tooling.lintWithoutOffs")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const configText = yield* fs.readFileString(path.join(REPO_ROOT, ".oxlintrc.json"))
  const raw: unknown = Bun.JSONC.parse(configText)
  const config = yield* Schema.decodeUnknownEffect(ProbedConfigSchema)(raw)
  const variant = probeConfig(config, REPO_ROOT, (plugin) => Bun.resolveSync(plugin, REPO_ROOT))
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-lint-offs-" })
  const variantPath = path.join(directory, "oxlintrc.json")
  yield* fs.writeFileString(
    variantPath,
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(variant),
  )
  const run = yield* spawnOxlintInterruptibly(
    ["--ignore-path=.oxlintignore", "-c", variantPath],
    REPO_ROOT,
  )
  return { configText, config, run }
})
