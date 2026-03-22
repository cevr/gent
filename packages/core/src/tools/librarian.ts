import { Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"
import { Agents, SubagentRunnerService } from "../domain/agent.js"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { $ } from "bun"
import * as os from "node:os"

// Librarian Tool Error

export class LibrarianError extends Schema.TaggedErrorClass<LibrarianError>()("LibrarianError", {
  message: Schema.String,
  spec: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Librarian Tool Params

export const LibrarianParams = Schema.Struct({
  spec: Schema.String.annotate({
    description: "Repository spec: owner/repo, owner/repo@tag, npm:package",
  }),
  question: Schema.String.annotate({
    description: "Question to answer about the repository",
  }),
})

// Parse spec (same logic as repo-explorer)

interface ParsedSpec {
  type: "github" | "npm" | "pypi" | "crates"
  name: string
  version: string | undefined
}

function parseSpec(spec: string): ParsedSpec {
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4)
    const atIdx = rest.lastIndexOf("@")
    if (atIdx > 0) {
      return { type: "npm", name: rest.slice(0, atIdx), version: rest.slice(atIdx + 1) }
    }
    return { type: "npm", name: rest, version: undefined }
  }
  if (spec.startsWith("pypi:")) {
    const rest = spec.slice(5)
    const atIdx = rest.lastIndexOf("@")
    if (atIdx > 0) {
      return { type: "pypi", name: rest.slice(0, atIdx), version: rest.slice(atIdx + 1) }
    }
    return { type: "pypi", name: rest, version: undefined }
  }
  if (spec.startsWith("crates:")) {
    const rest = spec.slice(7)
    const atIdx = rest.lastIndexOf("@")
    if (atIdx > 0) {
      return { type: "crates", name: rest.slice(0, atIdx), version: rest.slice(atIdx + 1) }
    }
    return { type: "crates", name: rest, version: undefined }
  }
  const atIdx = spec.lastIndexOf("@")
  if (atIdx > 0) {
    return { type: "github", name: spec.slice(0, atIdx), version: spec.slice(atIdx + 1) }
  }
  return { type: "github", name: spec, version: undefined }
}

function getCachePath(cacheDir: string, spec: string): string {
  const parsed = parseSpec(spec)
  switch (parsed.type) {
    case "github":
      return path.join(cacheDir, ...parsed.name.split("/"))
    case "npm":
      return path.join(cacheDir, "npm", parsed.name, parsed.version ?? "latest")
    case "pypi":
      return path.join(cacheDir, "pypi", parsed.name, parsed.version ?? "latest")
    case "crates":
      return path.join(cacheDir, "crates", parsed.name, parsed.version ?? "latest")
  }
}

// Librarian Tool

export const LibrarianTool = defineTool({
  name: "librarian",
  action: "delegate",
  concurrency: "serial",
  idempotent: true,
  description:
    "Ask questions about external repositories. Fetches/caches the repo, then spawns a sub-agent that reads the code locally to answer your question.",
  params: LibrarianParams,
  execute: Effect.fn("LibrarianTool.execute")(function* (params, ctx) {
    const runner = yield* SubagentRunnerService

    const home = os.homedir()
    const cacheDir = path.join(home, ".cache", "repo")
    const cachePath = getCachePath(cacheDir, params.spec)
    const parsed = parseSpec(params.spec)

    // Ensure repo is cached
    const exists = yield* Effect.tryPromise({
      try: () =>
        fs
          .access(cachePath)
          .then(() => true)
          .catch(() => false),
      catch: () =>
        new LibrarianError({
          message: "Failed to check cache",
          spec: params.spec,
        }),
    })

    if (!exists && parsed.type === "github") {
      yield* Effect.tryPromise({
        try: async () => {
          await fs.mkdir(path.dirname(cachePath), { recursive: true })
          const url = `https://github.com/${parsed.name}.git`
          const args = ["git", "clone", "--depth", "100"]
          if (parsed.version !== undefined) {
            args.push("--branch", parsed.version)
          }
          args.push(url, cachePath)
          await $`${args}`.quiet()
        },
        catch: (e) =>
          new LibrarianError({
            message: `Failed to fetch repo: ${e}`,
            spec: params.spec,
            cause: e,
          }),
      })
    } else if (!exists) {
      return yield* new LibrarianError({
        message: `Repository not cached and auto-fetch only supports GitHub. Use repo_explorer fetch first for ${parsed.type} packages.`,
        spec: params.spec,
      })
    }

    // Spawn librarian sub-agent
    const prompt = `Repository: ${params.spec}
Local path: ${cachePath}

Question: ${params.question}

Use read, grep, and glob tools to explore the code at ${cachePath} and answer the question. Cite specific file paths and line numbers.`

    const result = yield* runner.run({
      agent: Agents.librarian,
      prompt,
      parentSessionId: ctx.sessionId,
      parentBranchId: ctx.branchId,
      toolCallId: ctx.toolCallId,
      cwd: cachePath,
    })

    if (result._tag === "error") {
      const ref =
        result.sessionId !== undefined ? `\n\nFull session: session://${result.sessionId}` : ""
      return { error: `${result.error}${ref}` }
    }

    return {
      output: `${result.text}\n\nFull session: session://${result.sessionId}`,
      metadata: { spec: params.spec, cachePath, sessionId: result.sessionId },
    }
  }),
})
