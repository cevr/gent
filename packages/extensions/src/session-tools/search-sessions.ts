import { Clock, Effect, Option, Schema } from "effect"
import { dateFromMillis, ExtensionContext, tool } from "@gent/core/extensions/api"

// Search Sessions Error

export class SearchSessionsError extends Schema.TaggedError<SearchSessionsError>()(
  "SearchSessionsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// Search Sessions Params

export const SearchSessionsParams = Schema.Struct({
  query: Schema.optionalKey(
    Schema.String.annotate({
      description: "Keyword to search for in session content",
    }),
  ),
  file: Schema.optionalKey(
    Schema.String.annotate({
      description: "File path to search for in session history",
    }),
  ),
  dateRange: Schema.optionalKey(
    Schema.String.annotate({
      description: "Date filter: ISO date or relative (7d, 2w, 1m)",
    }),
  ),
  limit: Schema.optionalKey(Schema.Finite),
})

// Search Sessions Result

export const SearchSessionsResult = Schema.Struct({
  query: Schema.String,
  totalMatches: Schema.Finite,
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

export function parseRelativeDate(s: string, now: number): Option.Option<number> {
  const match = Option.fromNullishOr(s.match(/^(\d+)([dwm])$/))
  if (Option.isNone(match)) {
    // Try ISO date
    const ts = Date.parse(s)
    if (Number.isNaN(ts)) return Option.none()
    return Option.some(ts)
  }

  const amount = parseInt(
    Option.getOrElse(Option.fromNullishOr(match.value[1]), () => "0"),
    10,
  )
  const unit = Option.getOrElse(Option.fromNullishOr(match.value[2]), () => "")
  const MS_DAY = 86400000

  switch (unit) {
    case "d":
      return Option.some(now - amount * MS_DAY)
    case "w":
      return Option.some(now - amount * 7 * MS_DAY)
    case "m":
      return Option.some(now - amount * 30 * MS_DAY)
    default:
      return Option.none()
  }
}

// Search Sessions Tool

export const SearchSessionsTool = tool({
  id: "search_sessions",
  description:
    "Search past session content by keyword, file path, or date range. Returns session summaries with match excerpts.",
  params: SearchSessionsParams,
  output: SearchSessionsResult,
  execute: Effect.fn("SearchSessionsTool.execute")(function* (
    params: typeof SearchSessionsParams.Type,
  ) {
    const query = Option.fromNullishOr(params.query)
    const file = Option.fromNullishOr(params.file)
    if (Option.isNone(query) && Option.isNone(file)) {
      return yield* new SearchSessionsError({
        message: "Provide at least one of: query, file",
      })
    }

    // Build search query
    const searchQuery = [query, file].flatMap(Option.toArray).join(" ")

    // Parse date range
    let dateAfter = Option.none<number>()
    const dateRange = Option.fromNullishOr(params.dateRange)
    if (Option.isSome(dateRange)) {
      const now = yield* Clock.currentTimeMillis
      dateAfter = parseRelativeDate(dateRange.value, now)
      if (Option.isNone(dateAfter)) {
        return yield* new SearchSessionsError({
          message: `Invalid date range: ${dateRange.value}. Use ISO date or relative (7d, 2w, 1m)`,
        })
      }
    }

    const ctx = yield* ExtensionContext
    const results = yield* ctx.Session.search(searchQuery, {
      dateAfter: Option.getOrUndefined(dateAfter),
      limit: Option.getOrElse(Option.fromNullishOr(params.limit), () => 20),
    })

    // Deduplicate by session, keep best match per session
    const bySession = new Map<
      string,
      {
        sessionId: string
        sessionName: Option.Option<string>
        snippets: string[]
        lastActivity: number
      }
    >()

    for (const result of results) {
      const existing = Option.fromNullishOr(bySession.get(result.sessionId))
      if (Option.isSome(existing)) {
        if (existing.value.snippets.length < 3) {
          existing.value.snippets.push(result.snippet)
        }
        existing.value.lastActivity = Math.max(existing.value.lastActivity, result.createdAt)
      } else {
        bySession.set(result.sessionId, {
          sessionId: result.sessionId,
          sessionName: Option.fromNullishOr(result.sessionName),
          snippets: [result.snippet],
          lastActivity: result.createdAt,
        })
      }
    }

    const sessions = [...bySession.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((s) => ({
        sessionId: s.sessionId,
        name: Option.getOrElse(s.sessionName, () => "(unnamed)"),
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
