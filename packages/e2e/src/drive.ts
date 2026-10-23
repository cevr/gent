/**
 * Run a drive script on a live pty:
 * `bun packages/e2e/src/drive.ts <script.json> [--no-record] [--print]`.
 * The script format is `DriveScript` in `./pty-fixture`; the README shows one.
 * Each step prints one line on stderr; a line on stdout names how the program
 * ended and the recording, one for each size of a sweep. A missed or failed
 * step, or an exit the script does not expect, fails the run with exit 1.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import {
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Runtime,
  Schema,
} from "effect"
import { DriveScript, keepPassed, passProblems, runDrivePasses } from "./pty-fixture"

class DriveUsageError extends Schema.TaggedError<
  DriveUsageError,
  { readonly brand: unique symbol }
>()("@gent/e2e/DriveUsageError", {
  message: Schema.String,
}) {}

class DriveFailed extends Schema.TaggedError<DriveFailed, { readonly brand: unique symbol }>()(
  "@gent/e2e/DriveFailed",
  { problems: Schema.Array(Schema.String) },
) {
  override readonly [Runtime.errorExitCode] = 1
}

const decodeScript = Schema.decodeUnknownEffect(Schema.fromJsonString(DriveScript))

const FLAGS = new Set(["--no-record", "--print"])
const USAGE = "usage: bun drive.ts <script.json> [--no-record] [--print]"

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const [file, ...flags] = Bun.argv.slice(2)
  if (Predicate.isUndefined(file) || flags.some((flag) => !FLAGS.has(flag))) {
    return yield* new DriveUsageError({ message: USAGE })
  }
  const scriptPath = path.resolve(file)
  const script = yield* decodeScript(yield* fs.readFileString(scriptPath))
  const base = path.dirname(scriptPath)
  const out = path.resolve(base, script.out)
  const passes = yield* runDrivePasses(
    { ...script, cwd: path.resolve(base, script.cwd ?? "."), out },
    { record: !flags.includes("--no-record"), print: flags.includes("--print") },
  )
  yield* Effect.forEach(passes, (pass) => {
    const recording = Option.match(pass.outcome.recording, {
      onNone: () => "none",
      onSome: (file) => path.relative(out, file),
    })
    const line = `end=${pass.outcome.end._tag} recording=${recording}`
    if (passes.length === 1) return Console.log(line)
    return Console.log(`size=${pass.size} ${line}`)
  })
  // A pass keeps its captures even when another size failed.
  yield* Effect.forEach(passes, (pass) => {
    if (passProblems([pass]).length > 0) return Effect.void
    return keepPassed(pass.script.out, pass.outcome)
  })
  const problems = passProblems(passes)
  if (problems.length > 0) return yield* new DriveFailed({ problems })
})

// The layer runs the script once as it is built; the scope closes after it.
BunRuntime.runMain(
  Effect.scoped(Layer.build(Layer.effectDiscard(program).pipe(Layer.provide(BunServices.layer)))),
)
