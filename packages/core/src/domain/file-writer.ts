import { Effect, type FileSystem } from "effect"

/** File facade wiring shared by production and tool test composition. */
export const makeFileWriter = (fs: FileSystem.FileSystem, dirname: (path: string) => string) =>
  Effect.fn("ExtensionFiles.write")(function* (
    path: string,
    content: string,
    options?: { readonly atomic?: boolean },
  ) {
    if (options?.atomic !== true) return yield* fs.writeFileString(path, content)
    // Replace the directory entry, including a symlink, without changing its target.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const staging = yield* fs.makeTempFileScoped({
          directory: dirname(path),
          prefix: ".gent-write-",
        })
        yield* fs.writeFileString(staging, content)
        yield* fs.rename(staging, path)
      }),
    )
  })
