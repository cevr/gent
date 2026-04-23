import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { StorageError } from "./sqlite-storage.js"

const mapError = (message: string) => (e: unknown) => new StorageError({ message, cause: e })

/**
 * Sanitize user input for safe FTS5 MATCH queries.
 * Removes special syntax chars and wraps each token in double quotes
 * so they're treated as literal terms (quoting neutralizes FTS5 operators).
 */
export const sanitizeFts5Query = (raw: string): string => {
  // Remove FTS5 special characters: *, ^, quotes, parentheses, colons, plus, minus, braces
  const cleaned = raw.replace(/[*^"'(){}:+-]/g, " ")
  return cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" ")
}

const buildSearchFilters = (
  sql: SqlClient.SqlClient,
  options?: {
    sessionId?: string
    dateAfter?: number
    dateBefore?: number
  },
) =>
  sql.and([
    ...(options?.sessionId !== undefined ? [sql`m.session_id = ${options.sessionId}`] : []),
    ...(options?.dateAfter !== undefined ? [sql`m.created_at > ${options.dateAfter}`] : []),
    ...(options?.dateBefore !== undefined ? [sql`m.created_at < ${options.dateBefore}`] : []),
  ])

export interface SearchResult {
  readonly sessionId: string
  readonly sessionName: string | null
  readonly branchId: string
  readonly snippet: string
  readonly createdAt: number
}

export interface SearchStorageService {
  readonly searchMessages: (
    query: string,
    options?: {
      sessionId?: string
      dateAfter?: number
      dateBefore?: number
      limit?: number
    },
  ) => Effect.Effect<ReadonlyArray<SearchResult>, StorageError>
}

export class SearchStorage extends Context.Service<SearchStorage, SearchStorageService>()(
  "@gent/core/src/storage/search-storage/SearchStorage",
) {
  static Live: Layer.Layer<SearchStorage, never, SqlClient.SqlClient> = Layer.effect(
    SearchStorage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return {
        searchMessages: Effect.fn("SearchStorage.searchMessages")(
          function* (query, options) {
            const limit = options?.limit ?? 20

            const ftsQuery = sanitizeFts5Query(query)
            if (ftsQuery.length === 0) return []
            const filters = buildSearchFilters(sql, options)

            const rows = yield* sql<{
              session_id: string
              session_name: string | null
              branch_id: string
              snippet_text: string
              created_at: number
            }>`SELECT
                m.session_id,
                s.name as session_name,
                m.branch_id,
                snippet(messages_fts, 0, '>>>', '<<<', '...', 40) as snippet_text,
                m.created_at
              FROM messages_fts fts
              JOIN messages m ON m.id = fts.message_id
              JOIN sessions s ON s.id = m.session_id
              WHERE messages_fts MATCH ${ftsQuery}
                AND ${filters}
              ORDER BY m.created_at DESC
              LIMIT ${limit}`

            return rows.map((row) => ({
              sessionId: row.session_id,
              sessionName: row.session_name,
              branchId: row.branch_id,
              snippet: row.snippet_text,
              createdAt: row.created_at,
            }))
          },
          Effect.mapError(mapError("Failed to search messages")),
        ),
      }
    }),
  )
}
