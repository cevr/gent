/**
 * MemoryVault — Effect service for ~/.gent/memory/ filesystem I/O.
 *
 * Flat .md files with YAML frontmatter. Per-scope index.md files
 * rebuilt inline on every write/remove (idempotent).
 */

import type { PlatformError } from "effect"
import { DateTime, Effect, FileSystem, Layer, Option, Path, Schema, Context } from "effect"
import { createHash } from "node:crypto"

// ── Types ──

export const MemoryScope = Schema.Literals(["global", "project"])
export type MemoryScope = typeof MemoryScope.Type

export const MemorySource = Schema.Literals(["agent", "user", "dream"])
export type MemorySource = typeof MemorySource.Type

export interface MemoryFrontmatter {
  readonly scope: MemoryScope
  readonly tags: ReadonlyArray<string>
  readonly created: string
  readonly updated: string
  readonly source: MemorySource
}

export const MemoryFrontmatterSchema = Schema.Struct({
  scope: MemoryScope,
  tags: Schema.Array(Schema.String),
  created: Schema.String,
  updated: Schema.String,
  source: MemorySource,
})

export interface MemoryEntry {
  /** Relative path within vault (e.g. "global/my-topic.md") */
  readonly path: string
  readonly title: string
  readonly summary: string
  readonly frontmatter: MemoryFrontmatter
}

export const MemoryEntrySchema = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  frontmatter: MemoryFrontmatterSchema,
})

// ── Frontmatter parsing ──

const isMemoryScope = Schema.is(MemoryScope)
const isMemorySource = Schema.is(MemorySource)

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

export const parseFrontmatter = (
  content: string,
  fallbackIsoDate: string,
): { frontmatter: MemoryFrontmatter; body: string } | undefined => {
  const match = content.match(FRONTMATTER_RE)
  if (match === null) return undefined

  const yamlBlock = match[1] ?? ""
  const body = match[2] ?? ""

  const fm: Record<string, unknown> = {}
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    let value: unknown = line.slice(colonIdx + 1).trim()
    // Parse arrays: [tag1, tag2]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    }
    fm[key] = value
  }

  const scope =
    typeof fm["scope"] === "string" && isMemoryScope(fm["scope"]) ? fm["scope"] : "global"
  const source =
    typeof fm["source"] === "string" && isMemorySource(fm["source"]) ? fm["source"] : "agent"

  return {
    frontmatter: {
      scope,
      tags: Array.isArray(fm["tags"])
        ? fm["tags"].filter((t): t is string => typeof t === "string")
        : [],
      created: typeof fm["created"] === "string" ? fm["created"] : fallbackIsoDate,
      updated: typeof fm["updated"] === "string" ? fm["updated"] : fallbackIsoDate,
      source,
    },
    body,
  }
}

export const serializeFrontmatter = (fm: MemoryFrontmatter): string => {
  const tags = fm.tags.length > 0 ? `[${fm.tags.join(", ")}]` : "[]"
  return [
    "---",
    `scope: ${fm.scope}`,
    `tags: ${tags}`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    `source: ${fm.source}`,
    "---",
  ].join("\n")
}

const extractTitle = (body: string): string => {
  const firstLine = body.trimStart().split("\n")[0] ?? ""
  return firstLine.replace(/^#+\s*/, "").trim() || "Untitled"
}

const extractSummary = (body: string): string => {
  const lines = body.trimStart().split("\n")
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed.slice(0, 120)
  }
  return ""
}

// ── Project key ──

export const projectKey = (repoRoot: string): string => {
  const lastSlash = repoRoot.lastIndexOf("/")
  const basename = lastSlash === -1 ? repoRoot : repoRoot.slice(lastSlash + 1)
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 6)
  return `${basename}-${hash}`
}

export const projectDisplayName = (key: string): string => {
  // Strip the -<hash> suffix
  const dashIdx = key.lastIndexOf("-")
  return dashIdx > 0 ? key.slice(0, dashIdx) : key
}

// ── Service interface ──

/**
 * Read slice of MemoryVault — vault path, listing, single-file read, and
 * full-text search. The separate Tag keeps callers from depending on write
 * methods without requiring public read-only branding ceremony.
 *
 * The Live/Test layers for `MemoryVault` provide BOTH this Tag and the
 * write-capable `MemoryVault` Tag from the same underlying service value.
 */
export interface MemoryVaultReadOnlyShape {
  readonly vaultPath: string
  readonly list: (
    scope?: MemoryScope,
    project?: string,
  ) => Effect.Effect<ReadonlyArray<MemoryEntry>, PlatformError.PlatformError>
  readonly read: (relativePath: string) => Effect.Effect<string, PlatformError.PlatformError>
  readonly search: (
    query: string,
    scope?: MemoryScope,
    project?: string,
  ) => Effect.Effect<ReadonlyArray<MemoryEntry>, PlatformError.PlatformError>
}

export interface MemoryVaultShape extends MemoryVaultReadOnlyShape {
  readonly write: (
    relativePath: string,
    frontmatter: MemoryFrontmatter,
    body: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>
  readonly remove: (relativePath: string) => Effect.Effect<void, PlatformError.PlatformError>
  readonly ensureDirs: (project?: string) => Effect.Effect<void, PlatformError.PlatformError>
  readonly rebuildIndex: (
    scope?: MemoryScope,
    project?: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>
}

export class MemoryVault extends Context.Service<MemoryVault, MemoryVaultShape>()(
  "@gent/extensions/src/memory/vault/MemoryVault",
) {}

/**
 * Read Tag onto the MemoryVault substrate. Provided alongside `MemoryVault`
 * by `Live`/`Test`.
 */
export class MemoryVaultReadOnly extends Context.Service<
  MemoryVaultReadOnly,
  MemoryVaultReadOnlyShape
>()("@gent/extensions/src/memory/vault/MemoryVaultReadOnly") {}
export type MemoryVaultReadOnlyTag = typeof MemoryVaultReadOnly

// ── Implementation ──

const buildScopeIndex = (entries: ReadonlyArray<MemoryEntry>): string => {
  if (entries.length === 0) return ""
  return entries.map((e) => `- **${e.title}** — ${e.summary}`).join("\n") + "\n"
}

export const makeMemoryVault = (
  vaultPath: string,
): Effect.Effect<MemoryVaultShape, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const abs = (rel: string): string => path.join(vaultPath, rel)

    const listMdFiles = (dir: string): Effect.Effect<ReadonlyArray<string>> =>
      fs.exists(dir).pipe(
        Effect.flatMap((exists) =>
          exists
            ? fs.readDirectory(dir).pipe(
                Effect.map((entries) =>
                  entries
                    .filter((name) => name.endsWith(".md") && name !== "index.md")
                    .slice()
                    .sort(),
                ),
              )
            : Effect.succeed<ReadonlyArray<string>>([]),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
      )

    const list: MemoryVaultShape["list"] = (scope, project) =>
      Effect.gen(function* () {
        const fallbackIsoDate = (yield* DateTime.nowAsDate).toISOString()
        const entries: MemoryEntry[] = []

        const scan = (dir: string, pathPrefix: string) =>
          Effect.gen(function* () {
            const files = yield* listMdFiles(path.join(vaultPath, dir))
            for (const file of files) {
              const relPath = `${pathPrefix}/${file}`
              const fullPath = abs(relPath)
              const content = yield* fs.readFileString(fullPath).pipe(
                Effect.map((c): string | undefined => c),
                Effect.orElseSucceed(() => undefined),
              )
              if (content === undefined) continue
              const parsed = parseFrontmatter(content, fallbackIsoDate)
              if (parsed === undefined) continue
              entries.push({
                path: relPath,
                title: extractTitle(parsed.body),
                summary: extractSummary(parsed.body),
                frontmatter: parsed.frontmatter,
              })
            }
          })

        if (scope === undefined || scope === "global") {
          yield* scan("global", "global")
        }
        if (scope === undefined || scope === "project") {
          if (project !== undefined) {
            yield* scan(`project/${project}`, `project/${project}`)
          } else {
            const projectDir = path.join(vaultPath, "project")
            const projectExists = yield* fs
              .exists(projectDir)
              .pipe(Effect.orElseSucceed(() => false))
            if (projectExists) {
              const dirEntries = yield* fs
                .readDirectory(projectDir)
                .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
              for (const name of dirEntries) {
                const stat = yield* fs.stat(path.join(projectDir, name)).pipe(Effect.option)
                if (Option.isSome(stat) && stat.value.type === "Directory") {
                  yield* scan(`project/${name}`, `project/${name}`)
                }
              }
            }
          }
        }

        return entries as ReadonlyArray<MemoryEntry>
      })

    const read: MemoryVaultShape["read"] = (relativePath) => fs.readFileString(abs(relativePath))

    const rebuildScopeIndex = (scopeDir: string, entries: ReadonlyArray<MemoryEntry>) =>
      Effect.gen(function* () {
        const indexPath = path.join(vaultPath, scopeDir, "index.md")
        const dir = path.dirname(indexPath)
        const dirExists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
        if (!dirExists) return

        const newContent = `# ${
          scopeDir === "global" ? "Global" : projectDisplayName(path.basename(scopeDir))
        } Memories\n\n${buildScopeIndex(entries)}`
        const existing = yield* fs.readFileString(indexPath).pipe(Effect.orElseSucceed(() => ""))
        if (existing !== newContent) {
          yield* fs.writeFileString(indexPath, newContent)
        }
      })

    const rebuildRootIndex = (allEntries: ReadonlyArray<MemoryEntry>) =>
      Effect.gen(function* () {
        const indexPath = path.join(vaultPath, "index.md")
        const globalEntries = allEntries.filter((e) => e.path.startsWith("global/"))
        const projectGroups = new Map<string, MemoryEntry[]>()
        for (const e of allEntries) {
          if (!e.path.startsWith("project/")) continue
          const parts = e.path.split("/")
          const projName = parts[1]
          if (projName === undefined) continue
          const group = projectGroups.get(projName) ?? []
          group.push(e)
          projectGroups.set(projName, group)
        }

        let content = "# Memory Vault\n\n"
        if (globalEntries.length > 0) {
          content += `## Global\n\n${buildScopeIndex(globalEntries)}\n`
        }
        for (const [proj, entries] of projectGroups) {
          content += `## Project: ${projectDisplayName(proj)}\n\n${buildScopeIndex(entries)}\n`
        }

        const existing = yield* fs.readFileString(indexPath).pipe(Effect.orElseSucceed(() => ""))
        if (existing !== content) {
          yield* fs.writeFileString(indexPath, content)
        }
      })

    const rebuildIndexForPath = (relativePath: string) =>
      Effect.gen(function* () {
        const allEntries = yield* list()
        if (relativePath.startsWith("global/")) {
          yield* rebuildScopeIndex(
            "global",
            allEntries.filter((e) => e.path.startsWith("global/")),
          )
        } else if (relativePath.startsWith("project/")) {
          const parts = relativePath.split("/")
          const projName = parts[1]
          if (projName !== undefined) {
            yield* rebuildScopeIndex(
              `project/${projName}`,
              allEntries.filter((e) => e.path.startsWith(`project/${projName}/`)),
            )
          }
        }
        yield* rebuildRootIndex(allEntries)
      })

    const write: MemoryVaultShape["write"] = (relativePath, frontmatter, body) =>
      Effect.gen(function* () {
        const fullPath = abs(relativePath)
        const dir = path.dirname(fullPath)
        yield* fs.makeDirectory(dir, { recursive: true })

        const content = `${serializeFrontmatter(frontmatter)}\n\n${body}`
        const tmpPath = `${fullPath}.tmp`
        yield* fs.writeFileString(tmpPath, content)
        yield* fs.rename(tmpPath, fullPath)
        yield* rebuildIndexForPath(relativePath)
      })

    const remove: MemoryVaultShape["remove"] = (relativePath) =>
      Effect.gen(function* () {
        const fullPath = abs(relativePath)
        const exists = yield* fs.exists(fullPath).pipe(Effect.orElseSucceed(() => false))
        if (exists) {
          yield* fs.remove(fullPath)
        }
        yield* rebuildIndexForPath(relativePath)
      })

    const search: MemoryVaultShape["search"] = (query, scope, project) =>
      Effect.gen(function* () {
        const entries = yield* list(scope, project)
        const lowerQuery = query.toLowerCase()
        const results: MemoryEntry[] = []
        for (const e of entries) {
          if (
            e.title.toLowerCase().includes(lowerQuery) ||
            e.summary.toLowerCase().includes(lowerQuery) ||
            e.frontmatter.tags.some((t) => t.toLowerCase().includes(lowerQuery))
          ) {
            results.push(e)
            continue
          }
          const content = yield* fs.readFileString(abs(e.path)).pipe(
            Effect.map((c): string | undefined => c),
            Effect.orElseSucceed(() => undefined),
          )
          if (content !== undefined && content.toLowerCase().includes(lowerQuery)) {
            results.push(e)
          }
        }
        return results as ReadonlyArray<MemoryEntry>
      })

    const ensureDirs: MemoryVaultShape["ensureDirs"] = (project) =>
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(path.join(vaultPath, "global"), { recursive: true })
          .pipe(Effect.asVoid)
        yield* fs
          .makeDirectory(path.join(vaultPath, "project"), { recursive: true })
          .pipe(Effect.asVoid)
        if (project !== undefined) {
          yield* fs
            .makeDirectory(path.join(vaultPath, "project", project), { recursive: true })
            .pipe(Effect.asVoid)
        }
      })

    const rebuildIndex: MemoryVaultShape["rebuildIndex"] = (scope, project) =>
      Effect.gen(function* () {
        const scopedEntries = yield* list(scope, project)
        const allEntries = yield* list()
        if (scope === "global" || scope === undefined) {
          yield* rebuildScopeIndex(
            "global",
            allEntries.filter((e) => e.path.startsWith("global/")),
          )
        }
        if (scope === "project" || scope === undefined) {
          if (project !== undefined) {
            yield* rebuildScopeIndex(
              `project/${project}`,
              scopedEntries.filter((e) => e.path.startsWith(`project/${project}/`)),
            )
          } else {
            const projectDir = path.join(vaultPath, "project")
            const projectExists = yield* fs
              .exists(projectDir)
              .pipe(Effect.orElseSucceed(() => false))
            if (projectExists) {
              const dirEntries = yield* fs
                .readDirectory(projectDir)
                .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
              for (const name of dirEntries) {
                const stat = yield* fs.stat(path.join(projectDir, name)).pipe(Effect.option)
                if (Option.isSome(stat) && stat.value.type === "Directory") {
                  yield* rebuildScopeIndex(
                    `project/${name}`,
                    allEntries.filter((e) => e.path.startsWith(`project/${name}/`)),
                  )
                }
              }
            }
          }
        }
        yield* rebuildRootIndex(allEntries)
      })

    return { vaultPath, list, read, write, remove, search, ensureDirs, rebuildIndex }
  })

// ── Layers ──

const defaultVaultPath = (path: Path.Path, home: string): string =>
  path.join(home, ".gent", "memory")

/**
 * Provide BOTH `MemoryVault` (write surface) and `MemoryVaultReadOnly` from
 * the same underlying service value. The read Tag is a structurally narrower
 * projection; it is not a public capability system.
 */
const layerFor = (
  buildVault: Effect.Effect<MemoryVaultShape, never, FileSystem.FileSystem | Path.Path>,
): Layer.Layer<MemoryVault | MemoryVaultReadOnly, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const vault = yield* buildVault
      return Context.empty().pipe(
        Context.add(MemoryVault, vault),
        Context.add(MemoryVaultReadOnly, {
          vaultPath: vault.vaultPath,
          list: vault.list,
          read: vault.read,
          search: vault.search,
        } satisfies MemoryVaultReadOnlyShape),
      )
    }),
  )

export const Live = (
  home: string,
  pathOverride?: string,
): Layer.Layer<MemoryVault | MemoryVaultReadOnly, never, FileSystem.FileSystem | Path.Path> =>
  layerFor(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const vaultPath = pathOverride ?? defaultVaultPath(path, home)
      return yield* makeMemoryVault(vaultPath)
    }),
  )

export const Test = (
  tmpDir: string,
): Layer.Layer<MemoryVault | MemoryVaultReadOnly, never, FileSystem.FileSystem | Path.Path> =>
  layerFor(makeMemoryVault(tmpDir))
