/**
 * Guards: the lint config and the environment must not name things that are gone.
 *
 * Three findings, all of the same shape -- a declaration whose subject left the
 * tree, which stays green because nothing ever reads it again:
 *
 * - An `.oxlintrc.json` override whose `files` glob matches no tracked file.
 *   The override for `packages/sdk/src/supervisor.ts` outlived that file and
 *   kept turning a rule off for nothing.
 * - A rule defined under `lint/` that the root config never enables. Five such
 *   rules accumulated; one of them (`no-make-unsafe`) could not be enabled at
 *   all, because shipped code would have failed it.
 * - A `GENT_*` environment variable read in the source with nothing to set it.
 *   The subprocess trace variables kept two readers alive after their writer
 *   was deleted, so a branch nothing could take looked like working code.
 *
 * Each list of exceptions is a claim with a reason beside it, not a switch.
 *
 * @module
 */
import { Option, Schema } from "effect"

export interface LintConfigFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

// ---------------------------------------------------------------------------
// (a) An override whose files glob matches nothing
// ---------------------------------------------------------------------------

/**
 * Turn one oxlint `files` glob into a matcher.
 *
 * The globs in this config are paths, `**` segments and a `*.ext` tail, so the
 * translation stays small on purpose: a glob needing more than this should be
 * simplified rather than matched by a bigger regex here.
 */
const globMatcher = (glob: string): RegExp => {
  const pattern = glob.split("").reduce(
    (acc: { out: string; skip: number }, char, index, chars) => {
      if (acc.skip > 0) return { out: acc.out, skip: acc.skip - 1 }
      if (char === "*" && chars[index + 1] === "*" && chars[index + 2] === "/") {
        return { out: `${acc.out}(?:.*/)?`, skip: 2 }
      }
      if (char === "*" && chars[index + 1] === "*") {
        return { out: `${acc.out}.*`, skip: 1 }
      }
      if (char === "*") return { out: `${acc.out}[^/]*`, skip: 0 }
      if (char === "?") return { out: `${acc.out}[^/]`, skip: 0 }
      if (".+^${}()|[]\\".includes(char)) return { out: `${acc.out}\\${char}`, skip: 0 }
      return { out: acc.out + char, skip: 0 }
    },
    { out: "", skip: 0 },
  ).out
  return new RegExp(`^${pattern}$`)
}

/**
 * The two parts of `.oxlintrc.json` these guards read. Everything else in the
 * file passes through untouched, so the schema names only these.
 */
export const OxlintConfigSchema = Schema.Struct({
  overrides: Schema.optional(
    Schema.Array(Schema.Struct({ files: Schema.optional(Schema.Array(Schema.String)) })),
  ),
  /** Rule names only; the severity values are the caller's business. */
  rules: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export type OxlintConfig = typeof OxlintConfigSchema.Type

/** The line an override's glob sits on, for a finding that points at it. */
const lineOfGlob = (configText: string, glob: string): number => {
  const needle = `"${glob}"`
  for (const [index, line] of configText.split("\n").entries()) {
    if (line.includes(needle)) return index + 1
  }
  return 1
}

export const findUnmatchedOverrideGlobs = (
  configFile: string,
  configText: string,
  config: OxlintConfig,
  trackedFiles: ReadonlyArray<string>,
): ReadonlyArray<LintConfigFinding> => {
  const findings: Array<LintConfigFinding> = []
  for (const override of config.overrides ?? []) {
    for (const glob of override.files ?? []) {
      const matcher = globMatcher(glob)
      if (trackedFiles.some((file) => matcher.test(file))) continue
      findings.push({
        file: configFile,
        line: lineOfGlob(configText, glob),
        message: `oxlint override \`files: "${glob}"\` matches no tracked file; delete the override, or fix the glob`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// (b) A plugin rule the root config never enables
// ---------------------------------------------------------------------------

/** `"<name>": {` inside the plugin's `rules` object literal. */
const RULE_KEY = /^\s{4}"([a-z0-9-]+)":\s*\{/

/**
 * Rules defined in the plugin but deliberately not enabled at the root, each
 * with the reason. An entry here is a claim; prefer deleting the rule.
 */
const UNENABLED_RULES_WITH_REASON: ReadonlyMap<string, string> = new Map()

export const findUnenabledPluginRules = (
  pluginFile: string,
  pluginText: string,
  rootRules: ReadonlySet<string>,
): ReadonlyArray<LintConfigFinding> => {
  const findings: Array<LintConfigFinding> = []
  for (const [index, line] of pluginText.split("\n").entries()) {
    const name = Option.flatMap(Option.fromNullishOr(RULE_KEY.exec(line)), (match) =>
      Option.fromNullishOr(match[1]),
    )
    if (Option.isNone(name)) continue
    const rule = name.value
    if (rootRules.has(`gent/${rule}`)) continue
    if (UNENABLED_RULES_WITH_REASON.has(rule)) continue
    findings.push({
      file: pluginFile,
      line: index + 1,
      message: `lint rule \`gent/${rule}\` is defined but the root config never enables it; enable it, or delete the rule and its fixtures`,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// (c) A GENT_* variable with a reader but nothing to set it
// ---------------------------------------------------------------------------

/**
 * Variables a person or an external launcher supplies, so the tree holds no
 * writer for them by design. Each entry says who sets it.
 */
const EXTERNALLY_SET: ReadonlyMap<string, string> = new Map([
  ["GENT_LOG_LEVEL", "a developer sets this by hand to raise log verbosity"],
  ["GENT_PORT", "the operator of a standalone server picks its port"],
  ["GENT_DATA_DIR", "the operator names the directory holding data.db"],
  ["GENT_AUTH_DIRECTORY", "the operator names the auth directory"],
  ["GENT_SERVER_MODE", "the launcher picks standalone or shared"],
  ["GENT_PERSISTENCE_MODE", "the launcher picks sqlite or memory"],
  ["GENT_PROVIDER_MODE", "the launcher picks the live or scripted provider"],
  ["GENT_IDLE_TIMEOUT_MS", "the launcher of a shared server sets its idle window"],
  ["GENT_BUILD_FINGERPRINT", "an operator pins the build fingerprint to override the computed one"],
])

/** `Config.string("GENT_NAME")` and friends -- the shapes that read a variable. */
const READER = /Config\.[a-zA-Z]+\(\s*["'](GENT_[A-Z0-9_]+)["']/g

/** Setting a variable: an env record literal, or an assignment into one. */
const WRITER = /["']?(GENT_[A-Z0-9_]+)["']?\s*[:=]\s*[^=]/g

interface VariableUse {
  readonly file: string
  readonly line: number
}

/** Where each `GENT_*` variable is read, and which ones anything sets. */
export interface GentVariableUses {
  readonly readers: ReadonlyMap<string, ReadonlyArray<VariableUse>>
  readonly writers: ReadonlySet<string>
}

const isTestFile = (file: string): boolean =>
  /\.test\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)tests\//.test(file)

/** The names one line reads through `Config.*("GENT_...")`. */
const readsOn = (line: string): ReadonlyArray<string> =>
  [...line.matchAll(READER)].flatMap((match) => Option.toArray(Option.fromNullishOr(match[1])))

/** The names one line sets, as an env record entry or an assignment. */
const writesOn = (line: string): ReadonlyArray<string> => {
  // The read shape also matches the write shape on a `Config.string(...)` line,
  // so a line that reads is never counted as a line that writes.
  if (line.includes("Config.")) return []
  return [...line.matchAll(WRITER)].flatMap((match) =>
    Option.toArray(Option.fromNullishOr(match[1])),
  )
}

/** Every `GENT_*` read and write in the tree, by variable name. */
export const collectGentVariableUses = (
  sourceTexts: ReadonlyMap<string, string>,
): GentVariableUses => {
  const readers = new Map<string, Array<VariableUse>>()
  const writers = new Set<string>()
  for (const [file, text] of sourceTexts) {
    // This finder and its fixtures name variables to describe the finder
    // itself. Neither file is a call site, so neither is scanned.
    if (file.startsWith("packages/tooling/src/lint-config-guards")) continue
    if (file.startsWith("packages/tooling/tests/lint-config-guards")) continue
    // A test may set a variable to drive a reader; that proves the reader
    // works, not that anything in production supplies it.
    const skipWrites = isTestFile(file)
    for (const [index, line] of text.split("\n").entries()) {
      for (const name of readsOn(line)) {
        const found = readers.get(name) ?? []
        found.push({ file, line: index + 1 })
        readers.set(name, found)
      }
      if (skipWrites) continue
      for (const name of writesOn(line)) writers.add(name)
    }
  }
  return { readers, writers }
}

export const findReadersWithoutWriters = (
  sourceTexts: ReadonlyMap<string, string>,
): ReadonlyArray<LintConfigFinding> => {
  const { readers, writers } = collectGentVariableUses(sourceTexts)
  const findings: Array<LintConfigFinding> = []
  for (const [name, uses] of readers) {
    if (writers.has(name)) continue
    if (EXTERNALLY_SET.has(name)) continue
    for (const use of uses) {
      findings.push({
        file: use.file,
        line: use.line,
        message: `\`${name}\` is read but nothing in the tree sets it; delete the reader, or record who sets it in EXTERNALLY_SET`,
      })
    }
  }
  return findings
}
