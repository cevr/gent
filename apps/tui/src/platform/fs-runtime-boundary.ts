import { BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime, Option } from "effect"

const runtime = ManagedRuntime.make(BunFileSystem.layer)

export const makeDirectory = (path: string, options?: { recursive?: boolean }) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* fs.makeDirectory(path, options)
    }),
  )

export const writeFileString = (path: string, content: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* fs.writeFileString(path, content)
    }),
  )

export const readFileStringOption = (path: string): Promise<Option.Option<string>> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const exists = yield* fs.exists(path)
      if (!exists) return Option.none()
      return Option.some(yield* fs.readFileString(path))
    }).pipe(Effect.orElseSucceed(() => Option.none())),
  )
