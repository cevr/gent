import { Effect, Schema } from "effect"

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

/** One oxlint run over a fixture set did not produce a report. */
export class OxlintRunError extends Schema.TaggedError<OxlintRunError>()("OxlintRunError", {
  message: Schema.String,
}) {}

const FIXTURES_DIR = Bun.fileURLToPath(new URL("../fixtures", import.meta.url))
const FIXTURES_CONFIG = Bun.fileURLToPath(new URL("../fixtures/.oxlintrc.json", import.meta.url))

/** The bound on one oxlint run over a fixture set; about a second on an idle machine. */
const OXLINT_RUN_BOUND_MS = 20_000

const decodeOxlintReport = Schema.decodeUnknownEffect(Schema.fromJsonString(OxlintReportSchema))

/**
 * Lint a fixture set in one oxlint process. The run is synchronous, so a test
 * file can lint its fixtures while it registers its tests, and its own bound
 * is the only bound: an overrun is one `OxlintRunError` that names the bound,
 * not a test timeout that kills the process mid-report.
 */
export const runOxlint = Effect.fn("Tooling.runOxlint")(function* (
  fixtureFiles: ReadonlyArray<string>,
) {
  const proc = Bun.spawnSync(
    ["bunx", "oxlint", "-c", FIXTURES_CONFIG, "--format=json", ...fixtureFiles],
    { cwd: FIXTURES_DIR, stdout: "pipe", stderr: "pipe", timeout: OXLINT_RUN_BOUND_MS },
  )
  const stderr = proc.stderr.toString()
  if (proc.exitedDueToTimeout === true) {
    return yield* new OxlintRunError({
      message: `oxlint did not lint ${fixtureFiles.length} fixture files within ${OXLINT_RUN_BOUND_MS} ms`,
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
