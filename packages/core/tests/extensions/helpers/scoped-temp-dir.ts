import { Effect, FileSystem } from "effect"

export const makeScopedTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped()
})
