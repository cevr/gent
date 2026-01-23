import { Context, Effect, Layer } from "effect"
import { FileSystem, Path } from "@effect/platform"

export interface InstructionsLoaderService {
  readonly load: (cwd: string) => Effect.Effect<string>
}

export class InstructionsLoader extends Context.Tag("InstructionsLoader")<
  InstructionsLoader,
  InstructionsLoaderService
>() {
  static Live: Layer.Layer<InstructionsLoader, never, FileSystem.FileSystem | Path.Path> =
    Layer.scoped(
      InstructionsLoader,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = process.env["HOME"] ?? "~"

        const readIfExists = (filePath: string): Effect.Effect<string> =>
          fs.exists(filePath).pipe(
            Effect.flatMap((exists) => (exists ? fs.readFileString(filePath) : Effect.succeed(""))),
            Effect.map((content) => content.trim()),
            Effect.catchAll(() => Effect.succeed("")),
          )

        return {
          load: (cwd) =>
            Effect.gen(function* () {
              const candidates = [
                path.join(home, ".gent", "AGENTS.md"),
                path.join(cwd, "AGENTS.md"),
                path.join(cwd, ".gent", "AGENTS.md"),
              ]

              const contents: string[] = []
              for (const filePath of candidates) {
                const content = yield* readIfExists(filePath)
                if (content.length > 0) contents.push(content)
              }

              return contents.join("\n---\n")
            }),
        }
      }),
    )

  static Test = (content: string = ""): Layer.Layer<InstructionsLoader> =>
    Layer.succeed(InstructionsLoader, {
      load: () => Effect.succeed(content),
    })
}
