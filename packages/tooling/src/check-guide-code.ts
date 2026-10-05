/**
 * Process entry: the ```ts, ```typescript and ```tsx blocks of the steering
 * prose compile and lint with the repo's compiler options and Effect policies.
 *
 * The examples package runs it after its own `tsc`, since both check code an
 * author copies. Each block is written as its own module to a scoped temp
 * directory, one subdirectory per compile context (`guideCodeContextOf`):
 * its tsconfig extends the context's tsconfig and its `node_modules` is the
 * context's, so a block resolves `effect`, `@gent/core` or `@opentui/solid`
 * the way the code it teaches does. A `tsc` exit other than 0 fails the
 * check, as does oxlint, with each diagnostic at its original Markdown line.
 * Extracted modules mirror extension/TUI paths; `lint=test` on the fence
 * selects the corresponding test scope without changing compile dependencies:
 * its module is a `tests/b<n>.test.ts`, which every test rule reads as test
 * code by its name (the generated lint config does not inherit the repo's
 * `effect.testFiles` setting).
 *
 * The steering files come from the guards' one file set, the git index
 * (`fileSet` in `check-guardrails.ts`), and each is read by its real path, so
 * `CLAUDE.md`, a symlink to `AGENTS.md`, is read once. In a pre-commit hook
 * the text is the staged text: the check compiles the commit being made.
 *
 * A block that cannot compile on its own is marked by the line
 * `<!-- illustrative: <why> -->` directly above its fence and is skipped. The
 * reason is required: a mark without one marks nothing, and the block
 * compiles.
 *
 * @module
 */

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { fencedBlocks, isSteeringFile } from "./guards"
import { fileSet } from "./check-guardrails"

// ── the blocks and their compile contexts ───────────────────────────────────

/**
 * Where a block compiles: the tsconfig it extends and the `node_modules` it
 * resolves from. A block under `apps/tui/` compiles with the TUI tsconfig and
 * the TUI's dependencies (Solid JSX from `@opentui/solid`); every other block
 * with the root tsconfig and the examples package's dependencies (`effect`,
 * `@gent/core` and its entries), the way an extension resolves them.
 */
interface GuideCodeContext {
  readonly name: string
  readonly tsconfig: string
  readonly modules: string
}

const EXTENSION_CONTEXT: GuideCodeContext = {
  name: "extension",
  tsconfig: "tsconfig.json",
  modules: "examples/node_modules",
}

const TUI_CONTEXT: GuideCodeContext = {
  name: "tui",
  tsconfig: "apps/tui/tsconfig.json",
  modules: "apps/tui/node_modules",
}

export const guideCodeContextOf = (file: string): GuideCodeContext => {
  if (file.startsWith("apps/tui/")) return TUI_CONTEXT
  return EXTENSION_CONTEXT
}

/** One code block: its file, the file line of its first code line, and its code. */
interface GuideBlock {
  readonly file: string
  readonly line: number
  readonly code: string
  readonly extension: "ts" | "tsx"
  readonly testCode: boolean
}

/** The fence languages that compile, and the module extension each is written with. */
const BLOCK_EXTENSION = new Map<string, GuideBlock["extension"]>([
  ["ts", "ts"],
  ["typescript", "ts"],
  ["tsx", "tsx"],
])
const ILLUSTRATIVE_MARK = /^\s*<!--\s*illustrative:\s*\S.*-->\s*$/

/** Whether the line above the fence at `fence` marks its block illustrative. */
const markedIllustrative = (lines: ReadonlyArray<string>, fence: number): boolean =>
  fence > 0 && ILLUSTRATIVE_MARK.test(lines[fence - 1] ?? "")

/**
 * The compiling blocks of a steering file, from the guards' fence reader
 * (`fencedBlocks`), so a fence the guards skip is a fence this check reads:
 * at any indent, of tildes, of any length, with attributes after the
 * language. A code line drops up to the opener's indent of its leading space.
 */
export const guideCodeBlocks = (file: string, text: string): ReadonlyArray<GuideBlock> => {
  const lines = text.split("\n")
  return fencedBlocks(text).flatMap(({ open, close, indent, info }) => {
    const extension = Option.fromNullishOr(BLOCK_EXTENSION.get(info.split(/\s/)[0] ?? ""))
    if (Option.isNone(extension) || markedIllustrative(lines, open)) return []
    const code = lines
      .slice(open + 1, close)
      .map((line) => line.slice(Math.min(indent.length, line.length - line.trimStart().length)))
    return [
      {
        file,
        line: open + 2,
        code: code.join("\n"),
        extension: extension.value,
        testCode: info.split(/\s+/).includes("lint=test"),
      },
    ]
  })
}

/** Mirror the block's lint audience while keeping its globally numbered diagnostic identity. */
export const guideBlockFile = (index: number, block: GuideBlock): string => {
  const tui = guideCodeContextOf(block.file) === TUI_CONTEXT
  let root = "examples"
  let directory = "extensions"
  let kind = ""
  if (tui) {
    root = "apps/tui"
    directory = "src"
  }
  if (block.testCode) {
    directory = "tests"
    kind = ".test"
  }
  return `${root}/${directory}/b${index + 1}${kind}.${block.extension}`
}

const BLOCK_DIAGNOSTIC = /(?:^|[/\\])b(\d+)(?:\.test)?\.tsx?\((\d+),(\d+)\)/

/** A `tsc` output line with its block position replaced by the position in the block's file. */
export const guideDiagnosticLine = (line: string, blocks: ReadonlyArray<GuideBlock>): string =>
  Option.fromNullishOr(BLOCK_DIAGNOSTIC.exec(line)).pipe(
    Option.flatMap((match) =>
      Option.fromNullishOr(blocks.at(Number(match[1]) - 1)).pipe(
        Option.map(
          (block) =>
            `${block.file}:${block.line + Number(match[2]) - 1}:${match[3]}${line.slice(match.index + match[0].length)}`,
        ),
      ),
    ),
    Option.getOrElse(() => line),
  )

// ── the check ───────────────────────────────────────────────────────────────

class GuideCodeError extends Schema.TaggedError<GuideCodeError>()("GuideCodeError", {
  message: Schema.String,
}) {}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const GuideLintReport = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      message: Schema.String,
      code: Schema.optional(Schema.String),
      filename: Schema.String,
      labels: Schema.optional(
        Schema.Array(
          Schema.Struct({ span: Schema.Struct({ line: Schema.Int, column: Schema.Int }) }),
        ),
      ),
    }),
  ),
  number_of_files: Schema.Int,
})
const decodeLintReport = Schema.decodeUnknownEffect(Schema.fromJsonString(GuideLintReport))

/** One process run in `cwd`: its exit code and its output. The scope kills it. */
const run = Effect.fn("Tooling.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
) {
  const handle = yield* ChildProcess.make(command, args, {
    cwd,
    env,
    extendEnv: true,
    forceKillAfter: "2 seconds",
  })
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: 3 },
  )
  return { exitCode: Number(exitCode), stdout, stderr, output: stdout + stderr }
})

/**
 * The steering files among `listed` (repo paths), each once by its real path.
 * A listed file missing on disk (trashed, its removal not staged yet) is
 * skipped: there is no text to compile.
 */
export const steeringFilesAmong = Effect.fn("Tooling.steeringFilesAmong")(function* (
  repoRoot: string,
  listed: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = yield* Effect.filter(listed.filter(isSteeringFile), (file) =>
    fs.exists(path.join(repoRoot, file)),
  )
  // The root's own real path: a root under a symlink (macOS `/var`) is not a link inside the repo.
  const realRoot = yield* fs.realPath(repoRoot)
  const real = yield* Effect.forEach(files, (file) => fs.realPath(path.join(repoRoot, file)), {
    concurrency: 16,
  })
  return files.filter((file, index) => path.join(realRoot, file) === real[index])
})

/**
 * A context's `node_modules`, which must be installed. The temp directory
 * links to it, so a missing one would leave every import unresolved and read
 * as a wall of unrelated diagnostics; it fails here, by name, instead.
 */
export const requireContextModules = Effect.fn("Tooling.requireContextModules")(function* (
  repoRoot: string,
  context: GuideCodeContext,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const modules = path.join(repoRoot, context.modules)
  if (yield* fs.exists(modules)) return modules
  return yield* new GuideCodeError({
    message: `  the ${context.name} blocks resolve from \`${context.modules}\`, which is missing; run \`bun install\``,
  })
})

/** Compile and lint one context's blocks; each failure keeps its module position. */
export const compileContext = Effect.fn("Tooling.compileContext")(function* (
  repoRoot: string,
  directory: string,
  context: GuideCodeContext,
  names: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const tsconfig = {
    extends: path.join(repoRoot, context.tsconfig),
    // The root's `types: ["bun"]` resolves from the root; the rest from the context's modules.
    compilerOptions: { noEmit: true, typeRoots: [path.join(repoRoot, "node_modules", "@types")] },
    include: names,
  }
  yield* fs.writeFileString(path.join(directory, "tsconfig.json"), yield* encodeJson(tsconfig))
  const modules = yield* requireContextModules(repoRoot, context)
  yield* fs.symlink(modules, path.join(directory, "node_modules"))
  const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc")
  const result = yield* run(tsc, ["-p", directory, "--pretty", "false"], directory)
  const failures: Array<string> = []
  if (result.exitCode !== 0)
    failures.push(
      `tsc exited ${result.exitCode} on the ${context.name} blocks:`,
      ...result.output.split("\n").filter((line) => line.trim().length > 0),
    )
  // Lint owns workspace-import declarations. Add its manifest after compiling:
  // a generated module name must not redefine a guide's service identity keys.
  const workspace = path.dirname(context.modules)
  yield* fs.makeDirectory(path.join(directory, workspace), { recursive: true })
  yield* fs.copyFile(
    path.join(repoRoot, workspace, "package.json"),
    path.join(directory, workspace, "package.json"),
  )
  // Standalone snippets can define a value for the reader without using it
  // in that same block. Every other rule inherits the actual repo policy.
  yield* fs.writeFileString(
    path.join(directory, ".oxlintrc.json"),
    yield* encodeJson({
      extends: [path.join(repoRoot, ".oxlintrc.json")],
      rules: { "no-unused-vars": "off" },
    }),
  )
  const lint = yield* run(
    path.join(repoRoot, "node_modules/.bin/oxlint"),
    [
      "--format=json",
      "--report-unused-disable-directives-severity=error",
      "-c",
      path.join(directory, ".oxlintrc.json"),
      ...names,
    ],
    directory,
    { OXLINT_TSGOLINT_PATH: path.join(repoRoot, "node_modules/.bin/tsgolint") },
  )
  const report = yield* decodeLintReport(lint.stdout).pipe(
    Effect.mapError(
      (error) =>
        new GuideCodeError({
          message: `oxlint exited ${lint.exitCode} without a valid report: ${error.message}\n${lint.output}`,
        }),
    ),
  )
  if (report.number_of_files !== names.length)
    return yield* new GuideCodeError({
      message: `oxlint checked ${report.number_of_files} of ${names.length} ${context.name} blocks`,
    })
  if (lint.exitCode === 0) return failures
  return [
    ...failures,
    `oxlint exited ${lint.exitCode} on the ${context.name} blocks:`,
    ...report.diagnostics.map((diagnostic) => {
      const span = Option.fromNullishOr(diagnostic.labels?.[0]?.span)
      const position = span.pipe(
        Option.map((value) => `(${value.line},${value.column})`),
        Option.getOrElse(() => ""),
      )
      const code = Option.fromNullishOr(diagnostic.code).pipe(Option.getOrElse(() => "oxlint"))
      return `${diagnostic.filename}${position}: lint ${code}: ${diagnostic.message}`
    }),
  ]
})

const checkGuideCode = Effect.fn("Tooling.checkGuideCode")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repoRoot = path.resolve(yield* path.fromFileUrl(new URL("../../..", import.meta.url)))
  // The guards' one file set: the git index. An untracked file is not read, since a
  // clean clone would not hold it. In a hook, the staged text: the check compiles
  // the commit being made.
  const set = fileSet(repoRoot)
  const texts = yield* set.texts(yield* steeringFilesAmong(repoRoot, yield* set.files))
  const blocks = texts.flatMap(({ file, text }) => guideCodeBlocks(file, text))
  if (blocks.length === 0) {
    return yield* new GuideCodeError({ message: "  the steering prose has no ```ts block" })
  }
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-code-" })
  const byContext = new Map<GuideCodeContext, Array<string>>()
  for (const [index, block] of blocks.entries()) {
    const context = guideCodeContextOf(block.file)
    const name = guideBlockFile(index, block)
    byContext.set(context, [...(byContext.get(context) ?? []), name])
    yield* fs.makeDirectory(path.dirname(path.join(root, context.name, name)), { recursive: true })
    yield* fs.writeFileString(path.join(root, context.name, name), `${block.code}\n`)
  }
  const failures = yield* Effect.forEach(
    [...byContext],
    ([context, names]) => compileContext(repoRoot, path.join(root, context.name), context, names),
    { concurrency: "unbounded" },
  )
  const lines = failures.flat()
  if (lines.length === 0) return
  return yield* new GuideCodeError({
    message: lines.map((line) => `  ${guideDiagnosticLine(line, blocks)}`).join("\n"),
  })
})

const program = checkGuideCode().pipe(
  Effect.catchTag("GuideCodeError", (error) =>
    Console.error(
      `The steering prose's code blocks failed compilation or lint:\n${error.message}`,
    ).pipe(Effect.andThen(Effect.fail("guide code failed"))),
  ),
)

if (import.meta.main)
  BunRuntime.runMain(
    program.pipe(
      Effect.scoped,
      Effect.timeout("60 seconds"),
      // @effect-diagnostics-next-line strictEffectProvide:off -- the script's process entry provides the platform once.
      Effect.provide(BunServices.layer),
    ),
  )
