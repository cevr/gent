import { resolve as pathResolve } from "node:path"

export interface Diagnostic {
  readonly code?: string
  readonly rule_id?: string
  readonly message: string
  readonly filename?: string
}

export interface OxlintReport {
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly number_of_files: number
}

export interface OxlintRun {
  readonly report: OxlintReport
  readonly exitCode: number | null
  readonly stderr: string
}

const FIXTURES_DIR = pathResolve(import.meta.dir, "..", "fixtures")
const FIXTURES_CONFIG = pathResolve(FIXTURES_DIR, ".oxlintrc.json")

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const parseOxlintReport = (stdout: string): OxlintReport => {
  const parsed: unknown = JSON.parse(stdout)
  if (!isRecord(parsed)) {
    throw new Error("oxlint JSON report was not an object")
  }

  const diagnostics = parsed.diagnostics
  const numberOfFiles = parsed.number_of_files
  if (!Array.isArray(diagnostics) || typeof numberOfFiles !== "number") {
    throw new Error("oxlint JSON report had an unexpected shape")
  }

  return {
    diagnostics: diagnostics.map((diagnostic): Diagnostic => {
      if (!isRecord(diagnostic) || typeof diagnostic.message !== "string") {
        throw new Error("oxlint diagnostic had an unexpected shape")
      }
      return {
        code: typeof diagnostic.code === "string" ? diagnostic.code : undefined,
        rule_id: typeof diagnostic.rule_id === "string" ? diagnostic.rule_id : undefined,
        message: diagnostic.message,
        filename: typeof diagnostic.filename === "string" ? diagnostic.filename : undefined,
      }
    }),
    number_of_files: numberOfFiles,
  }
}

export const runOxlint = async (fixtureFiles: ReadonlyArray<string>): Promise<OxlintRun> => {
  const proc = Bun.spawn(
    ["bunx", "oxlint", "-c", FIXTURES_CONFIG, "--format=json", ...fixtureFiles],
    {
      cwd: FIXTURES_DIR,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  const report = parseOxlintReport(stdout)
  return { report, exitCode, stderr }
}
