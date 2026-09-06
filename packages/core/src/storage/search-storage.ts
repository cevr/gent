import { Context, Effect, Layer, Option, Predicate } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { StorageError } from "../domain/storage-error.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

// oxlint-disable-next-line effect/noUnknownParameters -- SQL effects expose unknown failure causes at this storage boundary.
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

export interface SearchResult {
  readonly sessionId: string
  // oxlint-disable-next-line effect/noNullish -- This storage result mirrors a nullable SQL session name.
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

      const buildSearchFilters = (
        workspaceId: string,
        options?: {
          sessionId?: string
          dateAfter?: number
          dateBefore?: number
        },
      ) => {
        const conditions = [sql`s.workspace_id = ${workspaceId}`]
        if (!Predicate.isUndefined(options?.sessionId)) {
          conditions.push(sql`m.session_id = ${options.sessionId}`)
        }
        if (!Predicate.isUndefined(options?.dateAfter)) {
          conditions.push(sql`m.created_at > ${options.dateAfter}`)
        }
        if (!Predicate.isUndefined(options?.dateBefore)) {
          conditions.push(sql`m.created_at < ${options.dateBefore}`)
        }
        return sql.and(conditions)
      }

      return SearchStorage.of({
        searchMessages: Effect.fn("SearchStorage.searchMessages")(
          function* (query, options) {
            const limit = Option.match(Option.fromUndefinedOr(options?.limit), {
              onNone: () => 20,
              onSome: (value) => value,
            })

            const ftsQuery = sanitizeFts5Query(query)
            if (ftsQuery.length === 0) return []
            const workspaceId = yield* CurrentWorkspaceId
            const filters = buildSearchFilters(workspaceId, options)

            const rows = yield* sql<{
              session_id: string
              // oxlint-disable-next-line effect/noNullish -- Raw SQL rows preserve the database NULL representation.
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
      })
    }),
  )
}
