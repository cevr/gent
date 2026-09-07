import { Effect, Path, Schema } from "effect"

export class CellIsolationError extends Schema.TaggedError<CellIsolationError>()(
  "CellIsolationError",
  { message: Schema.String },
) {}

const pathCodec = Schema.fromJsonString(Schema.String)

/** Paths must refer to the parent's canonical, trusted runtime and worker artifact.
 * This profile permits directory listings and metadata, but not project file contents.
 */
export const makeMacosCellSandboxProfile = Effect.fn("CellSandbox.macos")(function* (input: {
  readonly binaryPath: string
  readonly workerPath: string
}) {
  const path = yield* Path.Path
  const paths = new Set<string>()
  for (const file of [input.binaryPath, input.workerPath]) {
    if (!path.isAbsolute(file)) {
      return yield* new CellIsolationError({ message: "Cell sandbox paths must be absolute" })
    }
    let current = path.normalize(file)
    while (!paths.has(current)) {
      paths.add(current)
      current = path.dirname(current)
    }
  }
  const quote = (value: string) =>
    Schema.encodeEffect(pathCodec)(value).pipe(
      Effect.mapError((error) => new CellIsolationError({ message: String(error) })),
    )
  const literals = yield* Effect.forEach(paths, (file) =>
    quote(file).pipe(Effect.map((encoded) => `(literal ${encoded})`)),
  )
  const binary = yield* quote(path.normalize(input.binaryPath))
  return [
    "(version 1)",
    "(deny default)",
    "(allow dynamic-code-generation)",
    "(allow file-map-executable)",
    "(allow file-read-metadata)",
    `(allow process-exec (literal ${binary}))`,
    `(allow file-read* ${literals.join(" ")}`,
    ' (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share")',
    ' (literal "/dev/urandom") (literal "/dev/null"))',
    "(allow sysctl-read)",
  ].join("\n")
})
