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

        // Try primary, then fallback for a location
        const readWithFallback = (primary: string, fallback: string): Effect.Effect<string> =>
          readIfExists(primary).pipe(
            Effect.flatMap((content) =>
              content.length > 0 ? Effect.succeed(content) : readIfExists(fallback),
            ),
          )

        return {
          load: (cwd) =>
            Effect.gen(function* () {
              // Locations with AGENTS.md primary, CLAUDE.md fallback
              const locations = [
                {
                  primary: path.join(home, ".gent", "AGENTS.md"),
                  fallback: path.join(home, ".gent", "CLAUDE.md"),
                },
                { primary: path.join(cwd, "AGENTS.md"), fallback: path.join(cwd, "CLAUDE.md") },
                {
                  primary: path.join(cwd, ".gent", "AGENTS.md"),
                  fallback: path.join(cwd, ".gent", "CLAUDE.md"),
                },
              ]

              const contents: string[] = []
              for (const loc of locations) {
                const content = yield* readWithFallback(loc.primary, loc.fallback)
                if (content.length > 0) contents.push(content)
              }

              // Global fallback: ~/.claude/CLAUDE.md only if nothing else found
              if (contents.length === 0) {
                const globalFallback = path.join(home, ".claude", "CLAUDE.md")
                const content = yield* readIfExists(globalFallback)
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
