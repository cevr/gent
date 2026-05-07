import { Clock, Effect, Schema } from "effect"
import { dateFromMillis, tool, ToolNeeds } from "@gent/core/extensions/api"

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

// Search Sessions Result

export const SearchSessionsResult = Schema.Struct({
  query: Schema.String,
  totalMatches: Schema.Number,
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      name: Schema.String,
      lastActivity: Schema.String,
      excerpts: Schema.Array(Schema.String),
    }),
  ),
})

// Date parsing

export function parseRelativeDate(s: string, now: number): number | undefined {
  const match = s.match(/^(\d+)([dwm])$/)
  if (match === null) {
    // Try ISO date
    const ts = Date.parse(s)
    if (Number.isNaN(ts)) return undefined
    return ts
  }

  const amount = parseInt(match[1] ?? "0", 10)
  const unit = match[2] ?? ""
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

export const SearchSessionsTool = tool({
  id: "search_sessions",
  needs: [ToolNeeds.read("session")],
  description:
    "Search past session content by keyword, file path, or date range. Returns session summaries with match excerpts.",
  params: SearchSessionsParams,
  output: SearchSessionsResult,
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
      const now = yield* Clock.currentTimeMillis
      dateAfter = parseRelativeDate(params.dateRange, now)
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
        lastActivity: dateFromMillis(s.lastActivity).toISOString(),
        excerpts: s.snippets,
      }))

    return {
      query: searchQuery,
      totalMatches: results.length,
      sessions,
    }
  }),
})
