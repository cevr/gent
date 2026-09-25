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
 * The steering files are read by their real path, so `CLAUDE.md`, a symlink
 * to `AGENTS.md`, is read once.
 *
 * @module
 */

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import {
  type GuideCodeContext,
  guideBlockFile,
  guideCodeBlocks,
  guideCodeContextOf,
  guideDiagnosticLine,
  isSteeringFile,
} from "./guards"

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

/** The steering files git knows, tracked or new, each once by its real path. */
const steeringFiles = Effect.fn("Tooling.steeringFiles")(function* (repoRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const listed = yield* run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    repoRoot,
  )
  const files = listed.output.split("\n").filter(isSteeringFile)
  const real = yield* Effect.forEach(files, (file) => fs.realPath(path.join(repoRoot, file)), {
    concurrency: 16,
  })
  return files.filter((file, index) => path.join(repoRoot, file) === real[index])
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
const compileContext = Effect.fn("Tooling.compileContext")(function* (
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
  const files = yield* steeringFiles(repoRoot)
  const texts = yield* Effect.forEach(files, (file) => fs.readFileString(path.join(repoRoot, file)))
  const blocks = files.flatMap((file, index) => guideCodeBlocks(file, texts[index] ?? ""))
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

// The layer runs the check once as it is built; the scope closes after it.
if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(program.pipe(Effect.scoped, Effect.timeout("60 seconds"))).pipe(
          Layer.provide(BunServices.layer),
        ),
      ),
    ),
  )
