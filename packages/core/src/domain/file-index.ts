import { Context, Layer, Schema } from "effect"
import type { Effect } from "effect"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexedFile {
  readonly path: string
  readonly relativePath: string
  readonly fileName: string
  readonly size: number
  readonly modifiedMs: number
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class FileIndexError extends Schema.TaggedErrorClass<FileIndexError>()("FileIndexError", {
  message: Schema.String,
  cwd: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface FileIndexService {
  /** List all indexed files for a directory. */
  readonly listFiles: (params: {
    readonly cwd: string
    readonly waitForScanMs?: number
  }) => Effect.Effect<ReadonlyArray<IndexedFile>, FileIndexError>

  /** Fuzzy search files by query. Native-only — fallback returns empty. */
  readonly searchFiles: (params: {
    readonly cwd: string
    readonly query: string
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<IndexedFile>, FileIndexError>

  /** Track a selection for frecency learning. */
  readonly trackSelection: (params: {
    readonly cwd: string
    readonly query: string
    readonly path: string
  }) => Effect.Effect<void>
}

export class FileIndex extends Context.Service<FileIndex, FileIndexService>()(
  "@gent/core/src/domain/file-index/FileIndex",
) {
  static Test = (impl: FileIndexService): Layer.Layer<FileIndex> => Layer.succeed(FileIndex, impl)
}
