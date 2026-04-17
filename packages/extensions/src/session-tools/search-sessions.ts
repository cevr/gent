import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core/extensions/api"

// Search Sessions Error

export class SearchSessionsError extends Schema.TaggedErrorClass<SearchSessionsError>()(
  "SearchSessionsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// Search Sessions Params

export const SearchSessionsParams = Schema.Struct({
  query: Schema.optional(
    Schema.String.annotate({
      description: "Keyword to search for in session content",
    }),
  ),
  file: Schema.optional(
    Schema.String.annotate({
      description: "File path to search for in session history",
    }),
  ),
  dateRange: Schema.optional(
    Schema.String.annotate({
      description: "Date filter: ISO date or relative (7d, 2w, 1m)",
    }),
  ),
  limit: Schema.optional(Schema.Number),
})

// Date parsing

export function parseRelativeDate(s: string): number | undefined {
  const match = s.match(/^(\d+)([dwm])$/)
  if (match === null) {
    // Try ISO date
    const ts = Date.parse(s)
    if (Number.isNaN(ts)) return undefined
    return ts
  }

  const amount = parseInt(match[1] ?? "0", 10)
  const unit = match[2] ?? ""
  const now = Date.now()
  const MS_DAY = 86400000

  switch (unit) {
    case "d":
      return now - amount * MS_DAY
    case "w":
      return now - amount * 7 * MS_DAY
    case "m":
      return now - amount * 30 * MS_DAY
    default:
      return undefined
  }
}

// Search Sessions Tool

export const SearchSessionsTool = defineTool({
  name: "search_sessions",
  idempotent: true,
  description:
    "Search past session content by keyword, file path, or date range. Returns session summaries with match excerpts.",
  params: SearchSessionsParams,
  execute: Effect.fn("SearchSessionsTool.execute")(function* (params, ctx) {
    if (params.query === undefined && params.file === undefined) {
      return yield* new SearchSessionsError({
        message: "Provide at least one of: query, file",
      })
    }

    // Build search query
    const searchQuery = [params.query, params.file].filter(Boolean).join(" ")

    // Parse date range
    let dateAfter: number | undefined
    if (params.dateRange !== undefined) {
      dateAfter = parseRelativeDate(params.dateRange)
      if (dateAfter === undefined) {
        return yield* new SearchSessionsError({
          message: `Invalid date range: ${params.dateRange}. Use ISO date or relative (7d, 2w, 1m)`,
        })
      }
    }

    const results = yield* ctx.session.search(searchQuery, {
      dateAfter,
      limit: params.limit ?? 20,
    })

    // Deduplicate by session, keep best match per session
    const bySession = new Map<
      string,
      { sessionId: string; sessionName: string | null; snippets: string[]; lastActivity: number }
    >()

    for (const result of results) {
      const existing = bySession.get(result.sessionId)
      if (existing !== undefined) {
        if (existing.snippets.length < 3) {
          existing.snippets.push(result.snippet)
        }
        existing.lastActivity = Math.max(existing.lastActivity, result.createdAt)
      } else {
        bySession.set(result.sessionId, {
          sessionId: result.sessionId,
          sessionName: result.sessionName,
          snippets: [result.snippet],
          lastActivity: result.createdAt,
        })
      }
    }

    const sessions = [...bySession.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((s) => ({
        sessionId: s.sessionId,
        name: s.sessionName ?? "(unnamed)",
        lastActivity: new Date(s.lastActivity).toISOString(),
        excerpts: s.snippets,
      }))

    return {
      query: searchQuery,
      totalMatches: results.length,
      sessions,
    }
  }),
})
