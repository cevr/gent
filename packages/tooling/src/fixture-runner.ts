import { Effect, FileSystem, Path, Schema } from "effect"
import { overrideOffs } from "./guards"

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

/** The bound on one type-aware oxlint run over the whole tree; about 6 s on an idle machine. */
const REPO_RUN_BOUND_MS = 60_000

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

/** The parts of the root config the copy rewrites. */
const ProbedConfigSchema = Schema.Struct({
  jsPlugins: Schema.Array(Schema.String),
  overrides: Schema.Array(
    Schema.Struct({
      files: Schema.Array(Schema.String),
      rules: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
})

/**
 * Lint the whole tree with the root config minus every override "off".
 * The copy lives in a scoped temporary directory, so its relative plugin
 * paths and override globs are made absolute. The result is what each "off"
 * would let through; `findUnneededOverrideOffs` reads it.
 */
export const lintWithoutOverrideOffs = Effect.fn("Tooling.lintWithoutOverrideOffs")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const configText = yield* fs.readFileString(path.join(REPO_ROOT, ".oxlintrc.json"))
  const raw: unknown = Bun.JSONC.parse(configText)
  const config = yield* Schema.decodeUnknownEffect(ProbedConfigSchema)(raw)
  const offs = overrideOffs(config)
  const variant = {
    ...(yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(raw)),
    jsPlugins: config.jsPlugins.map((plugin) => {
      if (plugin.startsWith("./")) return path.join(REPO_ROOT, plugin)
      return Bun.resolveSync(plugin, REPO_ROOT)
    }),
    overrides: config.overrides.map((override, index) => ({
      files: override.files.map((glob) => path.join(REPO_ROOT, glob)),
      rules: Object.fromEntries(
        Object.entries(override.rules).filter(([rule]) => !(offs[index] ?? []).includes(rule)),
      ),
    })),
  }
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-override-offs-" })
  const variantPath = path.join(directory, "oxlintrc.json")
  yield* fs.writeFileString(
    variantPath,
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(variant),
  )
  const run = yield* spawnOxlint(
    ["--ignore-path=.oxlintignore", "-c", variantPath],
    REPO_ROOT,
    REPO_RUN_BOUND_MS,
    "the tree",
  )
  return { configText, config, run }
})
