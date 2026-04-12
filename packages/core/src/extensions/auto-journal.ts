/**
 * AutoJournal — append-only JSONL persistence for the auto loop.
 *
 * Files live at .gent/auto/<goal-slug>.jsonl relative to cwd.
 * An active.json pointer tracks which journal to resume on session start.
 *
 * Row types:
 * - config: initial goal + maxIterations
 * - checkpoint: per auto_checkpoint call
 * - review: per review tool completion (peer review)
 */

import { Context, Effect, Layer } from "effect"
// @effect-diagnostics nodeBuiltinImport:off
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs"
// @effect-diagnostics nodeBuiltinImport:off
import { join } from "node:path"

// ── Row types ──

export interface ConfigRow {
  readonly type: "config"
  readonly goal: string
  readonly maxIterations: number
  readonly startedAt: number
}

export interface CheckpointRow {
  readonly type: "checkpoint"
  readonly iteration: number
  readonly status: "continue" | "complete" | "abandon"
  readonly summary: string
  readonly learnings?: string
  readonly metrics?: Record<string, number>
  readonly nextIdea?: string
}

export interface ReviewRow {
  readonly type: "review"
  readonly iteration: number
}

export type JournalRow = ConfigRow | CheckpointRow | ReviewRow

// ── Service ──

export interface AutoJournalService {
  /** Start a new journal for a goal. Creates the JSONL file + sets active pointer.
   *  Pass sessionId to scope the journal — only child sessions of this session will replay it. */
  readonly start: (params: {
    goal: string
    maxIterations: number
    sessionId?: string
  }) => Effect.Effect<string> // returns journal path

  /** Append a checkpoint row to the active journal. */
  readonly appendCheckpoint: (row: Omit<CheckpointRow, "type">) => Effect.Effect<void>

  /** Append a review row to the active journal. */
  readonly appendReview: (iteration: number) => Effect.Effect<void>

  /** Mark the active journal as complete (clears the active pointer). */
  readonly finish: () => Effect.Effect<void>

  /** Read all rows from the active journal (for onInit replay). Returns undefined if no active journal. */
  readonly readActive: () => Effect.Effect<
    { rows: ReadonlyArray<JournalRow>; path: string; sessionId?: string } | undefined
  >

  /** Get the active journal path, if any. */
  readonly getActivePath: () => Effect.Effect<string | undefined>
}

export class AutoJournal extends Context.Service<AutoJournal, AutoJournalService>()(
  "@gent/core/src/extensions/auto-journal/AutoJournal",
) {
  static Noop: Layer.Layer<AutoJournal> = Layer.succeed(AutoJournal, {
    start: () => Effect.succeed("") as Effect.Effect<string>,
    appendCheckpoint: () => Effect.void,
    appendReview: () => Effect.void,
    finish: () => Effect.void,
    readActive: (): Effect.Effect<
      { rows: ReadonlyArray<JournalRow>; path: string; sessionId?: string } | undefined
    > => Effect.void.pipe(Effect.as(undefined)),
    getActivePath: (): Effect.Effect<string | undefined> => Effect.void.pipe(Effect.as(undefined)),
  } satisfies AutoJournalService)

  static Live = (params: { cwd: string }): Layer.Layer<AutoJournal> => {
    const autoDir = join(params.cwd, ".gent", "auto")
    const activePath = join(autoDir, "active.json")

    const ensureDir = () => {
      if (!existsSync(autoDir)) mkdirSync(autoDir, { recursive: true })
    }

    const slugify = (text: string): string =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60)

    const appendRow = (path: string, row: JournalRow) => {
      appendFileSync(path, JSON.stringify(row) + "\n")
    }

    const readRows = (path: string): JournalRow[] => {
      if (!existsSync(path)) return []
      const content = readFileSync(path, "utf8")
      return content
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          try {
            return JSON.parse(line) as JournalRow
          } catch {
            return undefined
          }
        })
        .filter((row): row is JournalRow => row !== undefined)
    }

    const readActivePointerSync = (): { path: string; sessionId?: string } | undefined => {
      if (!existsSync(activePath)) return undefined
      try {
        const content = JSON.parse(readFileSync(activePath, "utf8"))
        if (typeof content.path !== "string") return undefined
        return {
          path: content.path,
          sessionId: typeof content.sessionId === "string" ? content.sessionId : undefined,
        }
      } catch {
        return undefined
      }
    }

    return Layer.succeed(AutoJournal, {
      start: ({ goal, maxIterations, sessionId }) =>
        Effect.sync(() => {
          ensureDir()
          const slug = slugify(goal)
          const journalPath = join(autoDir, `${slug}.jsonl`)
          const row: ConfigRow = {
            type: "config",
            goal,
            maxIterations,
            startedAt: Date.now(),
          }
          writeFileSync(journalPath, JSON.stringify(row) + "\n")
          writeFileSync(
            activePath,
            JSON.stringify({
              path: journalPath,
              ...(sessionId !== undefined ? { sessionId } : {}),
            }),
          )
          return journalPath
        }),

      appendCheckpoint: (params) =>
        Effect.sync(() => {
          const active = readActivePointerSync()?.path
          if (active === undefined) return
          appendRow(active, { type: "checkpoint", ...params })
        }),

      appendReview: (iteration) =>
        Effect.sync(() => {
          const active = readActivePointerSync()?.path
          if (active === undefined) return
          appendRow(active, { type: "review", iteration })
        }),

      finish: () =>
        Effect.sync(() => {
          if (existsSync(activePath)) unlinkSync(activePath)
        }),

      readActive: () =>
        Effect.sync(() => {
          const active = readActivePointerSync()
          if (active === undefined || !existsSync(active.path)) return undefined
          return {
            rows: readRows(active.path),
            path: active.path,
            sessionId: active.sessionId,
          }
        }),

      getActivePath: () => Effect.sync(() => readActivePointerSync()?.path),
    } satisfies AutoJournalService)
  }
}
