/**
 * Memory tools — remember, recall, forget.
 *
 * Tools write directly to the MemoryVault service and return results.
 * Session-scoped memories are ephemeral (handled via intents, not vault).
 */

import { Effect, Schema } from "effect"
import { tool, ToolNeeds } from "@gent/core/extensions/api"
import { MemoryVault, projectKey as projectKeyOf } from "./vault.js"
import { memoryPath, newFrontmatter } from "./state.js"

// ── memory_remember ──

const RememberParams = Schema.Struct({
  title: Schema.String.annotate({
    description: "Short descriptive title for the memory (used as filename slug)",
  }),
  content: Schema.String.annotate({
    description: "Memory content — bullets over prose, one topic",
  }),
  scope: Schema.Literals(["session", "project", "global"]).annotate({
    description:
      "Where to store: session (ephemeral, lost on restart), project (per-cwd repo), global (cross-session)",
  }),
  tags: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Optional tags for categorization and search",
    }),
  ),
  project_key: Schema.optional(
    Schema.String.annotate({
      description:
        "Project key for project-scoped memories (auto-detected if omitted). Format: basename-hash.",
    }),
  ),
})

export const MemoryRememberTool = tool({
  id: "memory_remember",
  needs: [ToolNeeds.write("memory")],
  description:
    "Store a memory for future reference. Use 'session' for this conversation only, 'project' for this codebase, 'global' for cross-session knowledge.",
  promptGuidelines: [
    "Use memory_remember to save corrections, preferences, decisions, and gotchas discovered during the session.",
    "Prefer 'project' scope for codebase-specific knowledge, 'global' for general engineering principles.",
    "Session memories are lost on restart — promote important ones to project/global.",
  ],
  params: RememberParams,
  execute: Effect.fn("MemoryRememberTool.execute")(function* (params, ctx) {
    const scope = params["scope"]
    const title = params["title"]
    const content = params["content"]
    const tags = params["tags"] ?? []
    // Auto-derive project key from session cwd when scope=project and the
    // caller did not supply one. Without this, project memories silently
    // fall back to the global directory (state.memoryPath line 110) and the
    // vault projection's project section never finds them.
    const projectKey =
      params["project_key"] ?? (scope === "project" ? projectKeyOf(ctx.cwd) : undefined)

    if (scope === "session") {
      // Session memories are handled by the extension actor state, not vault.
      // Return a marker so the extension can pick it up via event observation.
      return {
        stored: true,
        scope: "session" as const,
        title,
        note: "Session memory stored (ephemeral — lost on restart). Use scope 'project' or 'global' to persist.",
      }
    }

    const vault = yield* MemoryVault
    const path = memoryPath(scope, title, projectKey)
    const fm = newFrontmatter(scope, tags, "agent")
    const body = `# ${title}\n\n${content}`

    yield* vault.ensureDirs(scope === "project" ? projectKey : undefined)
    yield* vault.write(path, fm, body)

    return { stored: true, scope, path, title }
  }),
})

// ── memory_recall ──

const RecallParams = Schema.Struct({
  query: Schema.optional(
    Schema.String.annotate({
      description:
        "Search query to filter memories. Omit to list all memories (titles + summaries only).",
    }),
  ),
  scope: Schema.optional(
    Schema.Literals(["project", "global"]).annotate({
      description: "Filter by scope. Omit to search all scopes.",
    }),
  ),
  limit: Schema.optional(
    Schema.Number.annotate({ description: "Maximum entries to return (default 20)" }),
  ),
})

export const MemoryRecallTool = tool({
  id: "memory_recall",
  needs: [ToolNeeds.read("memory")],
  description:
    "Search or list stored memories. Without a query, returns the memory index (titles + summaries). With a query, searches memory content.",
  params: RecallParams,
  execute: Effect.fn("MemoryRecallTool.execute")(function* (params, _ctx) {
    const vault = yield* MemoryVault
    const query = params["query"]
    const scope = params["scope"]
    const limit = params["limit"] ?? 20

    const entries =
      query !== undefined ? yield* vault.search(query, scope) : yield* vault.list(scope)

    const limited = entries.slice(0, limit)

    if (query !== undefined && limited.length > 0) {
      // Return full content for search results
      const results = []
      for (const entry of limited) {
        const content = yield* vault.read(entry.path)
        results.push({
          title: entry.title,
          path: entry.path,
          scope: entry.frontmatter.scope,
          tags: entry.frontmatter.tags,
          content,
        })
      }
      return { count: results.length, memories: results }
    }

    // Index mode — titles + summaries only
    return {
      count: limited.length,
      memories: limited.map((e) => ({
        title: e.title,
        path: e.path,
        scope: e.frontmatter.scope,
        tags: e.frontmatter.tags,
        summary: e.summary,
      })),
    }
  }),
})

// ── memory_forget ──

const ForgetParams = Schema.Struct({
  title: Schema.String.annotate({
    description: "Title of the memory to remove",
  }),
  scope: Schema.Literals(["session", "project", "global"]).annotate({
    description: "Scope of the memory to remove",
  }),
  project_key: Schema.optional(
    Schema.String.annotate({ description: "Project key for project-scoped memories" }),
  ),
})

export const MemoryForgetTool = tool({
  id: "memory_forget",
  needs: [ToolNeeds.write("memory")],
  description: "Remove a stored memory by title and scope.",
  params: ForgetParams,
  execute: Effect.fn("MemoryForgetTool.execute")(function* (params, ctx) {
    const scope = params["scope"]
    const title = params["title"]
    const projectKey =
      params["project_key"] ?? (scope === "project" ? projectKeyOf(ctx.cwd) : undefined)

    if (scope === "session") {
      return {
        removed: true,
        scope: "session" as const,
        title,
        note: "Session memory removal handled by extension state.",
      }
    }

    const vault = yield* MemoryVault
    const path = memoryPath(scope, title, projectKey)
    yield* vault.remove(path)

    return { removed: true, scope, path, title }
  }),
})

export const MemoryTools = [MemoryRememberTool, MemoryRecallTool, MemoryForgetTool] as const
