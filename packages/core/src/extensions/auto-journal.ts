/**
 * AutoJournal — append-only JSONL persistence for the auto loop.
 *
 * Files live at .gent/auto/<goal-slug>.jsonl relative to cwd.
 * An active.json pointer tracks which journal to resume on session start.
 *
 * Row types:
 * - config: initial goal + maxIterations
 * - checkpoint: per auto_checkpoint call
 * - counsel: per counsel tool completion
 */

import { ServiceMap, Effect, Layer } from "effect"
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
import { RuntimePlatform } from "../runtime/runtime-platform.js"

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

export interface CounselRow {
  readonly type: "counsel"
  readonly iteration: number
}

export type JournalRow = ConfigRow | CheckpointRow | CounselRow

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

  /** Append a counsel row to the active journal. */
  readonly appendCounsel: (iteration: number) => Effect.Effect<void>

  /** Mark the active journal as complete (clears the active pointer). */
  readonly finish: () => Effect.Effect<void>

  /** Read all rows from the active journal (for onInit replay). Returns undefined if no active journal. */
  readonly readActive: () => Effect.Effect<
    { rows: ReadonlyArray<JournalRow>; path: string; sessionId?: string } | undefined
  >

  /** Get the active journal path, if any. */
  readonly getActivePath: () => Effect.Effect<string | undefined>
}

export class AutoJournal extends ServiceMap.Service<AutoJournal, AutoJournalService>()(
  "@gent/core/src/extensions/auto-journal/AutoJournal",
) {
  static Live: Layer.Layer<AutoJournal> = Layer.effect(
    AutoJournal,
    Effect.gen(function* () {
      const platformOpt = yield* Effect.serviceOption(RuntimePlatform)
      if (platformOpt._tag === "None") {
        // No RuntimePlatform — return no-op journal (tests, headless without cwd)
        return {
          start: () => Effect.succeed("") as Effect.Effect<string>,
          appendCheckpoint: () => Effect.void,
          appendCounsel: () => Effect.void,
          finish: () => Effect.void,
          readActive: () =>
            Effect.succeed(undefined) as Effect.Effect<
              { rows: ReadonlyArray<JournalRow>; path: string; sessionId?: string } | undefined
            >,
          getActivePath: () => Effect.succeed(undefined) as Effect.Effect<string | undefined>,
        } satisfies AutoJournalService
      }
      const platform = platformOpt.value
      const autoDir = join(platform.cwd, ".gent", "auto")
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

      return {
        start: ({
          goal,
          maxIterations,
          sessionId,
        }: {
          goal: string
          maxIterations: number
          sessionId?: string
        }) =>
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
            // Overwrite if exists (new run for same goal)
            writeFileSync(journalPath, JSON.stringify(row) + "\n")
            // Set active pointer — sessionId scopes replay to this session's lineage
            writeFileSync(
              activePath,
              JSON.stringify({
                path: journalPath,
                ...(sessionId !== undefined ? { sessionId } : {}),
              }),
            )
            return journalPath
          }),

        appendCheckpoint: (params: Omit<CheckpointRow, "type">) =>
          Effect.sync(() => {
            const active = readActivePointerSync()?.path
            if (active === undefined) return
            appendRow(active, { type: "checkpoint", ...params })
          }),

        appendCounsel: (iteration: number) =>
          Effect.sync(() => {
            const active = readActivePointerSync()?.path
            if (active === undefined) return
            appendRow(active, { type: "counsel", iteration })
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
      } satisfies AutoJournalService

      function readActivePointerSync(): { path: string; sessionId?: string } | undefined {
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
    }),
  )
}
