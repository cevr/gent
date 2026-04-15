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

import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"

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

const ConfigRowSchema = Schema.Struct({
  type: Schema.Literal("config"),
  goal: Schema.String,
  maxIterations: Schema.Number,
  startedAt: Schema.Number,
})

const ActivePointerSchema = Schema.Struct({
  path: Schema.String,
  sessionId: Schema.optional(Schema.String),
})

const encodeConfigRowJson = Schema.encodeSync(Schema.fromJsonString(ConfigRowSchema))
const encodeActivePointerJson = Schema.encodeSync(Schema.fromJsonString(ActivePointerSchema))

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

  static Live = (params: {
    cwd: string
  }): Layer.Layer<AutoJournal, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      AutoJournal,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const autoDir = path.join(params.cwd, ".gent", "auto")
        const activeFilePath = path.join(autoDir, "active.json")

        const ensureDir = fs.makeDirectory(autoDir, { recursive: true }).pipe(Effect.ignore)

        const slugify = (text: string): string =>
          text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60)

        const appendRow = (filePath: string, row: JournalRow) =>
          fs.writeFileString(filePath, JSON.stringify(row) + "\n", { flag: "a" })

        const readRows = (filePath: string) =>
          fs.readFileString(filePath).pipe(
            Effect.map((content) =>
              content
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line): JournalRow | undefined => {
                  try {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                    return JSON.parse(line) as JournalRow
                  } catch {
                    return undefined
                  }
                })
                .filter((row): row is JournalRow => row !== undefined),
            ),
            Effect.orElseSucceed((): JournalRow[] => []),
          )

        const readActivePointer = fs.readFileString(activeFilePath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ActivePointerSchema))),
          Effect.map((pointer): { path: string; sessionId?: string } => pointer),
          Effect.option,
          Effect.map(Option.getOrUndefined),
        )

        return AutoJournal.of({
          start: ({ goal, maxIterations, sessionId }) =>
            Effect.gen(function* () {
              yield* ensureDir
              const slug = slugify(goal)
              const journalPath = path.join(autoDir, `${slug}.jsonl`)
              const row: ConfigRow = {
                type: "config",
                goal,
                maxIterations,
                startedAt: yield* Clock.currentTimeMillis,
              }
              yield* fs.writeFileString(journalPath, encodeConfigRowJson(row) + "\n")
              yield* fs.writeFileString(
                activeFilePath,
                encodeActivePointerJson({
                  path: journalPath,
                  ...(sessionId !== undefined ? { sessionId } : {}),
                }),
              )
              return journalPath
            }).pipe(Effect.orDie),

          appendCheckpoint: (params) =>
            Effect.gen(function* () {
              const active = yield* readActivePointer
              if (active === undefined) return
              yield* appendRow(active.path, { type: "checkpoint", ...params })
            }).pipe(Effect.orDie),

          appendReview: (iteration) =>
            Effect.gen(function* () {
              const active = yield* readActivePointer
              if (active === undefined) return
              yield* appendRow(active.path, { type: "review", iteration })
            }).pipe(Effect.orDie),

          finish: () => fs.remove(activeFilePath).pipe(Effect.ignore),

          readActive: () =>
            Effect.gen(function* () {
              const active = yield* readActivePointer
              if (active === undefined) return undefined
              const exists = yield* fs.exists(active.path)
              if (!exists) return undefined
              const rows = yield* readRows(active.path)
              return { rows, path: active.path, sessionId: active.sessionId }
            }).pipe(Effect.orDie),

          getActivePath: () => readActivePointer.pipe(Effect.map((a) => a?.path)),
        } satisfies AutoJournalService)
      }),
    )
}
