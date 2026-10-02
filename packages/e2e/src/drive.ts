/**
 * Run a drive script on a live pty: `bun packages/e2e/src/drive.ts <script.json>`.
 * The script format is `DriveScript` in `./pty-fixture`; the README shows one.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Array as Arr, Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { DriveScript, runDriveScript } from "./pty-fixture"

class DriveUsageError extends Schema.TaggedError<DriveUsageError>()("@gent/e2e/DriveUsageError", {
  message: Schema.String,
}) {}

const decodeScript = Schema.decodeUnknownEffect(Schema.fromJsonString(DriveScript))

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = yield* Effect.fromOption(Arr.get(Bun.argv, 2)).pipe(
    Effect.mapError(() => new DriveUsageError({ message: "usage: bun drive.ts <script.json>" })),
  )
  const scriptPath = path.resolve(file)
  const script = yield* decodeScript(yield* fs.readFileString(scriptPath))
  const base = path.dirname(scriptPath)
  const code = yield* runDriveScript({
    ...script,
    cwd: path.resolve(base, script.cwd ?? "."),
    out: path.resolve(base, script.out),
  })
  yield* Console.log(`exit=${Option.getOrElse(code, () => "running")}`)
})

// The layer runs the script once as it is built; the scope closes after it.
BunRuntime.runMain(
  Effect.scoped(Layer.build(Layer.effectDiscard(program).pipe(Layer.provide(BunServices.layer)))),
)
