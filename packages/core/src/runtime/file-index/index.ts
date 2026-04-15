import { Effect, Layer } from "effect"
import { FileIndex, FileIndexError, type FileIndexService } from "../../domain/file-index.js"
import { loadNativeModule, makeNativeServiceFromModule } from "./native-adapter.js"
import { FallbackFileIndexLive, makeFallbackService } from "./fallback-adapter.js"

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
  searchFiles: (params) =>
    primary
      .searchFiles(params)
      .pipe(Effect.catchTag("FileIndexError", () => fallback.searchFiles(params))),
  trackSelection: (params) =>
    primary.trackSelection(params).pipe(Effect.catchCause(() => Effect.void)),
})

/**
 * Native-first with per-method fallback. Always succeeds.
 *
 * - Native module unavailable → pure fallback
 * - Per-method native failure (create, scan timeout, search) → fallback for that call
 * - Finder lifecycle cleanup on scope close
 */
export const FileIndexLive: Layer.Layer<FileIndex> = Layer.unwrap(
  Effect.gen(function* () {
    const fallback = makeFallbackService()

    // Try loading native module
    const mod = yield* loadNativeModule.pipe(Effect.option)
    if (mod._tag === "None" || !mod.value.FileFinder.isAvailable()) {
      return Layer.succeed(FileIndex, fallback)
    }

    const { service, finalize } = makeNativeServiceFromModule(mod.value)

    yield* Effect.addFinalizer(() => finalize)

    return Layer.succeed(FileIndex, withFallback(service, fallback))
  }),
)
