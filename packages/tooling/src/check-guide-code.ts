/**
 * Process entry: the ```ts, ```typescript and ```tsx blocks of the steering
 * prose compile with the repo's compiler options and Effect diagnostics.
 *
 * The examples package runs it after its own `tsc`, since both check code an
 * author copies. Each block is written as its own module to a scoped temp
 * directory, one subdirectory per compile context (`guideCodeContextOf`):
 * its tsconfig extends the context's tsconfig and its `node_modules` is the
 * context's, so a block resolves `effect`, `@gent/core` or `@opentui/solid`
 * the way the code it teaches does. A `tsc` exit other than 0 fails the
 * check, with each diagnostic at its line in the file that holds the block.
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
import { isSteeringFile } from "./guards"
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
}

/** The fence languages that compile, and the module extension each is written with. */
const BLOCK_EXTENSION = new Map<string, GuideBlock["extension"]>([
  ["ts", "ts"],
  ["typescript", "ts"],
  ["tsx", "tsx"],
])
const FENCE_OPEN = /^```\S*\s*$/
const FENCE_CLOSE = /^```\s*$/
const ILLUSTRATIVE_MARK = /^<!--\s*illustrative:\s*\S.*-->\s*$/

/** Whether the line above the fence at `fence` marks its block illustrative. */
const markedIllustrative = (lines: ReadonlyArray<string>, fence: number): boolean =>
  fence > 0 && ILLUSTRATIVE_MARK.test(lines[fence - 1] ?? "")

export const guideCodeBlocks = (file: string, text: string): ReadonlyArray<GuideBlock> => {
  const blocks: Array<GuideBlock> = []
  const lines = text.split("\n")
  let open = Option.none<{ readonly start: number; readonly language: string }>()
  for (const [index, line] of lines.entries()) {
    if (Option.isNone(open)) {
      if (!FENCE_OPEN.test(line)) continue
      open = Option.some({ start: index + 1, language: line.slice(3).trim() })
      continue
    }
    if (!FENCE_CLOSE.test(line)) continue
    const { start, language } = open.value
    open = Option.none()
    const extension = Option.fromNullishOr(BLOCK_EXTENSION.get(language))
    if (Option.isNone(extension) || markedIllustrative(lines, start - 1)) continue
    blocks.push({
      file,
      line: start + 1,
      code: lines.slice(start, index).join("\n"),
      extension: extension.value,
    })
  }
  return blocks
}

/** The module file a block is written to: `b1.ts` for the first, `b2.tsx` for a TSX second. */
export const guideBlockFile = (index: number, block: GuideBlock): string =>
  `b${index + 1}.${block.extension}`

const BLOCK_DIAGNOSTIC = /(?:^|[/\\])b(\d+)\.tsx?\((\d+),(\d+)\)/

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

/** One process run in `cwd`: its exit code and its output. The scope kills it. */
const run = Effect.fn("Tooling.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const handle = yield* ChildProcess.make(command, args, { cwd })
  const [exitCode, output] = yield* Effect.all(
    [handle.exitCode, Stream.mkString(Stream.decodeText(handle.all))],
    { concurrency: "unbounded" },
  )
  return { exitCode: Number(exitCode), output }
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

/** Compile one context's blocks in `directory`; the lines of any failure. */
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
  if (result.exitCode === 0) return []
  return [
    `tsc exited ${result.exitCode} on the ${context.name} blocks:`,
    ...result.output.split("\n").filter((line) => line.trim().length > 0),
  ]
})

const checkGuideCode = Effect.fn("Tooling.checkGuideCode")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..")
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
    yield* fs.makeDirectory(path.join(root, context.name), { recursive: true })
    yield* fs.writeFileString(path.join(root, context.name, name), `${block.code}\nexport {}\n`)
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
    Console.error(`The steering prose's code blocks do not compile:\n${error.message}`).pipe(
      Effect.andThen(Effect.fail("guide code failed")),
    ),
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
