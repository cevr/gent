/**
 * Process entry: the ```ts blocks of the extension guide compile with the
 * repo's compiler options and Effect diagnostics.
 *
 * The examples package runs it after its own `tsc`, since both check the code
 * an extension author writes. Each block is written as its own module to a
 * scoped temp directory, whose tsconfig extends the root one and whose
 * `node_modules` is the examples package's, so the blocks resolve `effect` and
 * `@gent/core/extensions/api` the way an extension does. A `tsc` exit other
 * than 0 fails the check, with each diagnostic at its line in the guide.
 *
 * @module
 */

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { GUIDE_FILE, guideBlockFile, guideCodeBlocks, guideDiagnosticLine } from "./guards"

class GuideCodeError extends Schema.TaggedError<GuideCodeError>()("GuideCodeError", {
  message: Schema.String,
}) {}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** One `tsc` run over `directory`: its exit code and its output. The scope kills it. */
const runTsc = Effect.fn("Tooling.runTsc")(function* (repoRoot: string, directory: string) {
  const path = yield* Path.Path
  const handle = yield* ChildProcess.make(
    path.join(repoRoot, "node_modules", ".bin", "tsc"),
    ["-p", directory, "--pretty", "false"],
    { cwd: directory },
  )
  const [exitCode, output] = yield* Effect.all(
    [handle.exitCode, Stream.mkString(Stream.decodeText(handle.all))],
    { concurrency: "unbounded" },
  )
  return { exitCode: Number(exitCode), output }
})

const checkGuideCode = Effect.fn("Tooling.checkGuideCode")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..")
  const blocks = guideCodeBlocks(yield* fs.readFileString(path.join(repoRoot, GUIDE_FILE)))
  if (blocks.length === 0) {
    return yield* new GuideCodeError({ message: `${GUIDE_FILE} has no \`\`\`ts block` })
  }
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-guide-code-" })
  yield* Effect.forEach(
    blocks,
    (block, index) =>
      fs.writeFileString(path.join(directory, guideBlockFile(index)), `${block.code}\nexport {}\n`),
    { discard: true },
  )
  const tsconfig = {
    extends: path.join(repoRoot, "tsconfig.json"),
    // The root's `types: ["bun"]` resolves from the root; the rest from the examples package.
    compilerOptions: { noEmit: true, typeRoots: [path.join(repoRoot, "node_modules", "@types")] },
    include: blocks.map((_, index) => guideBlockFile(index)),
  }
  yield* fs.writeFileString(path.join(directory, "tsconfig.json"), yield* encodeJson(tsconfig))
  yield* fs.symlink(
    path.join(repoRoot, "examples", "node_modules"),
    path.join(directory, "node_modules"),
  )
  const run = yield* runTsc(repoRoot, directory)
  if (run.exitCode === 0) return
  const lines = run.output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => `  ${guideDiagnosticLine(line, blocks)}`)
  return yield* new GuideCodeError({
    message: [`tsc exited ${run.exitCode} on the guide's code blocks:`, ...lines].join("\n"),
  })
})

const program = checkGuideCode().pipe(
  Effect.catchTag("GuideCodeError", (error) =>
    Console.error(error.message).pipe(Effect.andThen(Effect.fail("guide code failed"))),
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
