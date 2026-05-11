import { Effect, type FileSystem, Layer, type Path } from "effect"
import { FileIndex, type FileIndexService } from "../../domain/file-index.js"
import {
  isNativeFileIndexAvailable,
  makeNativeServiceFromModule,
  ensureDbDir,
} from "./native-adapter.js"
import { makeFallbackService, makeGitignoreCacheRef } from "./fallback-adapter.js"
import { RuntimeEnvironment } from "../runtime-environment.js"

export {
  FileIndex,
  FileIndexError,
  type IndexedFile,
  type FileIndexService,
} from "../../domain/file-index.js"
export { FallbackFileIndexLive } from "./fallback-adapter.js"
export { NativeFileIndexLive } from "./native-adapter.js"

/** Wrap a primary service with per-method fallback on FileIndexError. */
const withFallback = (primary: FileIndexService, fallback: FileIndexService): FileIndexService => ({
  listFiles: (params) =>
    primary
      .listFiles(params)
      .pipe(Effect.catchTag("FileIndexError", () => fallback.listFiles(params))),
})

/**
 * Native-first with per-method fallback. Always succeeds.
 *
 * - Native module unavailable → pure fallback
 * - Per-method native failure (create, scan timeout, listFiles) → fallback for that call
 * - Finder lifecycle cleanup on scope close
 */
export const FileIndexLive: Layer.Layer<
  FileIndex,
  never,
  FileSystem.FileSystem | Path.Path | RuntimeEnvironment
> = Layer.unwrap(
  Effect.gen(function* () {
    const cacheRef = yield* makeGitignoreCacheRef()
    const fallback = yield* makeFallbackService(cacheRef)
    const { platform } = yield* RuntimeEnvironment

    if (platform === "test" || !isNativeFileIndexAvailable()) {
      return Layer.succeed(FileIndex, fallback)
    }

    const dbDir = yield* ensureDbDir

    const { service, finalize } = yield* makeNativeServiceFromModule(dbDir)

    yield* Effect.addFinalizer(() => finalize)

    return Layer.succeed(FileIndex, withFallback(service, fallback))
  }),
)
