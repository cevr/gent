import { BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime } from "effect"

const runtime = ManagedRuntime.make(BunFileSystem.layer)
const encoder = new TextEncoder()

export const makeDirectory = (path: string, options?: { recursive?: boolean }) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* fs.makeDirectory(path, options)
    }),
  )

export const removeFile = (path: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* fs.remove(path)
    }).pipe(Effect.catchEager(() => Effect.void)),
  )

export const appendFileString = (path: string, content: string) =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* fs.open(path, { flag: "a+" })
        yield* file.writeAll(encoder.encode(content))
      }),
    ),
  )

export const writeFileString = (path: string, content: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* fs.writeFileString(path, content)
    }),
  )
