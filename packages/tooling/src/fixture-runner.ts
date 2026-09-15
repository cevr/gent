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

const FIXTURES_DIR = Bun.fileURLToPath(new URL("../fixtures", import.meta.url))
const FIXTURES_CONFIG = Bun.fileURLToPath(new URL("../fixtures/.oxlintrc.json", import.meta.url))

const decodeOxlintReport = Schema.decodeUnknownEffect(Schema.fromJsonString(OxlintReportSchema))

export const runOxlint = Effect.fn("Tooling.runOxlint")(function* (
  fixtureFiles: ReadonlyArray<string>,
) {
  const proc = Bun.spawn(
    ["bunx", "oxlint", "-c", FIXTURES_CONFIG, "--format=json", ...fixtureFiles],
    { cwd: FIXTURES_DIR, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Effect.promise(() => new Response(proc.stdout).text()),
      Effect.promise(() => new Response(proc.stderr).text()),
      Effect.promise(() => proc.exited),
    ],
    { concurrency: "unbounded" },
  )
  return { report: yield* decodeOxlintReport(stdout), exitCode, stderr }
})
