/**
 * FileTracker — in-memory tracking of file changes for undo support.
 *
 * Records file state before edit/write mutations. Only valid within
 * the current session lifetime (not persisted).
 */

import { ServiceMap, Effect, Layer, Ref } from "effect"

export interface FileChange {
  readonly path: string
  readonly before: string
  readonly after: string
  readonly toolCallId: string
  readonly timestamp: number
}

export interface FileTrackerService {
  /** Record file state before a mutation */
  readonly snapshot: (
    path: string,
    before: string,
    after: string,
    toolCallId: string,
  ) => Effect.Effect<void>
  /** Restore the most recent change for a file, returns the change or undefined */
  readonly restore: (path: string) => Effect.Effect<FileChange | undefined>
  /** List files that have recorded changes */
  readonly listUndoable: () => Effect.Effect<ReadonlyArray<{ path: string; changeCount: number }>>
}

export class FileTracker extends ServiceMap.Service<FileTracker, FileTrackerService>()(
  "@gent/runtime/src/file-tracker/FileTracker",
) {
  static layer = Layer.effect(
    FileTracker,
    Effect.gen(function* () {
      const changesRef = yield* Ref.make<FileChange[]>([])

      return {
        snapshot: (path: string, before: string, after: string, toolCallId: string) =>
          Ref.update(changesRef, (changes) => [
            ...changes,
            { path, before, after, toolCallId, timestamp: Date.now() },
          ]),

        restore: (path: string) =>
          Ref.modify(changesRef, (changes) => {
            // Find most recent change for this path
            let latestIdx = -1
            for (let i = changes.length - 1; i >= 0; i--) {
              if (changes[i]?.path === path) {
                latestIdx = i
                break
              }
            }

            if (latestIdx === -1) return [undefined, changes]

            const change = changes[latestIdx]
            // Remove the change from history
            const remaining = [...changes.slice(0, latestIdx), ...changes.slice(latestIdx + 1)]
            return [change, remaining]
          }),

        listUndoable: () =>
          Ref.get(changesRef).pipe(
            Effect.map((changes) => {
              const counts = new Map<string, number>()
              for (const c of changes) {
                counts.set(c.path, (counts.get(c.path) ?? 0) + 1)
              }
              return [...counts.entries()].map(([path, changeCount]) => ({ path, changeCount }))
            }),
          ),
      }
    }),
  )

  static layerNoop = Layer.succeed(FileTracker, {
    snapshot: () => Effect.void,
    restore: () => Effect.succeed(undefined),
    listUndoable: () => Effect.succeed([]),
  })
}
