/**
 * AutoJournal — append-only JSONL persistence for the auto loop.
 *
 * Files live at .gent/auto/<goal-slug>.jsonl relative to cwd.
 * An "active" pointer (KeyValueStore-backed) tracks which journal to resume
 * on session start.
 *
 * Row types:
 * - config: initial goal + maxIterations
 * - checkpoint: per auto_checkpoint call
 * - review: per review tool completion (peer review)
 */

import type { PlatformError } from "effect"
import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { KeyValueStoreError } from "effect/unstable/persistence/KeyValueStore"

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
  maxIterations: Schema.Finite,
  startedAt: Schema.Finite,
})

const CheckpointRowSchema = Schema.Struct({
  type: Schema.Literal("checkpoint"),
  iteration: Schema.Finite,
  status: Schema.Literals(["continue", "complete", "abandon"]),
  summary: Schema.String,
  learnings: Schema.optional(Schema.String),
  metrics: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  nextIdea: Schema.optional(Schema.String),
})

const ReviewRowSchema = Schema.Struct({
  type: Schema.Literal("review"),
  iteration: Schema.Finite,
})

const JournalRowSchema = Schema.Union([ConfigRowSchema, CheckpointRowSchema, ReviewRowSchema])

const ActivePointerSchema = Schema.Struct({
  path: Schema.String,
  sessionId: Schema.optional(Schema.String),
})

const ACTIVE_POINTER_KEY = "active"

type AutoJournalError = KeyValueStoreError | PlatformError.PlatformError | Schema.SchemaError

const encodeConfigRowJson = Schema.encodeSync(Schema.fromJsonString(ConfigRowSchema))
const encodeJournalRowJson = Schema.encodeSync(Schema.fromJsonString(JournalRowSchema))
const decodeJournalRow = Schema.decodeUnknownOption(Schema.fromJsonString(JournalRowSchema))

// ── Service ──

export interface AutoJournalService {
  /** Start a new journal for a goal. Creates the JSONL file + sets active pointer.
   *  Pass sessionId to scope the journal — only child sessions of this session will replay it. */
  readonly start: (params: {
    goal: string
    maxIterations: number
    sessionId?: string
  }) => Effect.Effect<string, AutoJournalError> // returns journal path

  /** Append a checkpoint row to the active journal. */
  readonly appendCheckpoint: (
    row: Omit<CheckpointRow, "type">,
  ) => Effect.Effect<void, AutoJournalError>

  /** Append a review row to the active journal. */
  readonly appendReview: (iteration: number) => Effect.Effect<void, AutoJournalError>

  /** Mark the active journal as complete (clears the active pointer). */
  readonly finish: Effect.Effect<void>

  /** Read all rows from the active journal (for onInit replay). Returns undefined if no active journal. */
  readonly readActive: Effect.Effect<
    Option.Option<{
      rows: ReadonlyArray<JournalRow>
      path: string
      sessionId: Option.Option<string>
    }>,
    AutoJournalError
  >

  /** Get the active journal path, if any. */
  readonly getActivePath: Effect.Effect<Option.Option<string>>
}

export class AutoJournal extends Context.Service<AutoJournal, AutoJournalService>()(
  "@gent/extensions/src/auto/journal/AutoJournal",
) {
  static Noop: Layer.Layer<AutoJournal> = Layer.succeed(
    AutoJournal,
    AutoJournal.of({
      start: () => Effect.succeed(""),
      appendCheckpoint: () => Effect.void,
      appendReview: () => Effect.void,
      finish: Effect.void,
      readActive: Effect.succeedNone,
      getActivePath: Effect.succeedNone,
    }),
  )

  static Live = (params: {
    cwd: string
  }): Layer.Layer<AutoJournal, AutoJournalError, FileSystem.FileSystem | Path.Path> => {
    const autoDir = `${params.cwd}/.gent/auto`
    return Layer.effect(
      AutoJournal,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const kv = yield* KeyValueStore.KeyValueStore

        const ensureDir = fs.makeDirectory(autoDir, { recursive: true }).pipe(Effect.ignore)

        const slugify = (text: string): string =>
          text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60)

        const appendRow = (filePath: string, row: JournalRow) =>
          fs.writeFileString(filePath, encodeJournalRowJson(row) + "\n", { flag: "a" })

        const readRows = (filePath: string) =>
          fs.readFileString(filePath).pipe(
            Effect.flatMap((content) =>
              Effect.gen(function* () {
                const lines = content.split("\n").filter((line) => line.trim() !== "")
                const rows: JournalRow[] = []
                for (const line of lines) {
                  const decoded = decodeJournalRow(line)
                  if (Option.isSome(decoded)) {
                    rows.push(decoded.value)
                  } else {
                    yield* Effect.logWarning("auto-journal.row.decode-failed").pipe(
                      Effect.annotateLogs({ path: filePath, line }),
                    )
                  }
                }
                return rows
              }),
            ),
            Effect.orElseSucceed((): JournalRow[] => []),
          )

        const pointerStore = KeyValueStore.toSchemaStore(kv, ActivePointerSchema)

        const readActivePointer = pointerStore.get(ACTIVE_POINTER_KEY).pipe(
          Effect.map(
            Option.map((pointer) => ({
              path: pointer.path,
              sessionId: Option.fromNullishOr(pointer.sessionId),
            })),
          ),
          Effect.orElseSucceed(() =>
            Option.none<{ path: string; sessionId: Option.Option<string> }>(),
          ),
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
              yield* pointerStore.set(ACTIVE_POINTER_KEY, {
                path: journalPath,
                sessionId: Option.getOrUndefined(Option.fromNullishOr(sessionId)),
              })
              return journalPath
            }),

          appendCheckpoint: (params) =>
            Effect.gen(function* () {
              const active = yield* readActivePointer
              if (Option.isNone(active)) return
              yield* appendRow(active.value.path, { type: "checkpoint", ...params })
            }),

          appendReview: (iteration) =>
            Effect.gen(function* () {
              const active = yield* readActivePointer
              if (Option.isNone(active)) return
              yield* appendRow(active.value.path, { type: "review", iteration })
            }),

          finish: pointerStore.remove(ACTIVE_POINTER_KEY).pipe(Effect.ignore),

          readActive: Effect.gen(function* () {
            const active = yield* readActivePointer
            if (Option.isNone(active)) return Option.none()
            const exists = yield* fs.exists(active.value.path)
            if (!exists) return Option.none()
            const rows = yield* readRows(active.value.path)
            return Option.some({
              rows,
              path: active.value.path,
              sessionId: active.value.sessionId,
            })
          }),

          getActivePath: readActivePointer.pipe(Effect.map(Option.map((a) => a.path))),
        } satisfies AutoJournalService)
      }),
    ).pipe(Layer.provide(KeyValueStore.layerFileSystem(autoDir)))
  }
}
