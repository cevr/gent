import { Layer } from "effect"
import type { FileIndex } from "../../domain/file-index.js"
import { NativeFileIndexLive } from "./native-adapter.js"
import { FallbackFileIndexLive } from "./fallback-adapter.js"

export {
  FileIndex,
  FileIndexError,
  type IndexedFile,
  type FileIndexService,
} from "../../domain/file-index.js"
export { FallbackFileIndexLive } from "./fallback-adapter.js"
export { NativeFileIndexLive } from "./native-adapter.js"

/** Native-first, fallback on any failure. Always succeeds. */
export const FileIndexLive: Layer.Layer<FileIndex> = NativeFileIndexLive.pipe(
  Layer.catchTag("FileIndexError", () => FallbackFileIndexLive),
)
