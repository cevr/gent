/**
 * MemoryVault — Effect service for ~/.gent/memory/ filesystem I/O.
 *
 * Flat .md files with YAML frontmatter. Per-scope index.md files
 * rebuilt inline on every write/remove (idempotent).
 */

import type { PlatformError } from "effect"
import {
  Predicate,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Context,
} from "effect"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"

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
): Option.Option<{ frontmatter: MemoryFrontmatter; body: string }> => {
  const match = Option.fromNullishOr(content.match(FRONTMATTER_RE))
  if (Option.isNone(match)) return Option.none()

  const yamlBlock = Option.getOrElse(Option.fromNullishOr(match.value[1]), () => "")
  const body = Option.getOrElse(Option.fromNullishOr(match.value[2]), () => "")

  const fm = new Map<string, unknown>()
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    let value: unknown = line.slice(colonIdx + 1).trim()
    // Parse arrays: [tag1, tag2]
    if (Predicate.isString(value) && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    }
    fm.set(key, value)
  }

  const scopeValue = fm.get("scope")
  let scope: MemoryScope = "global"
  if (Predicate.isString(scopeValue) && isMemoryScope(scopeValue)) scope = scopeValue
  const sourceValue = fm.get("source")
  let source: MemorySource = "agent"
  if (Predicate.isString(sourceValue) && isMemorySource(sourceValue)) source = sourceValue
  const tagsValue = fm.get("tags")
  const createdValue = fm.get("created")
  const updatedValue = fm.get("updated")

  let tags: ReadonlyArray<string> = []
  if (Array.isArray(tagsValue)) {
    tags = tagsValue.filter((t): t is string => Predicate.isString(t))
  }
  let created = fallbackIsoDate
  if (Predicate.isString(createdValue)) created = createdValue
  let updated = fallbackIsoDate
  if (Predicate.isString(updatedValue)) updated = updatedValue

  return Option.some({
    frontmatter: {
      scope,
      tags,
      created,
      updated,
      source,
    },
    body,
  })
}

export const serializeFrontmatter = (fm: MemoryFrontmatter): string => {
  let tags = "[]"
  if (fm.tags.length > 0) tags = `[${fm.tags.join(", ")}]`
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
    if (Predicate.isUndefined(line)) continue
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed.slice(0, 120)
  }
  return ""
}

// ── Project key ──

export const projectKey = (repoRoot: string): Effect.Effect<string, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const lastSlash = repoRoot.lastIndexOf("/")
    let basename = repoRoot
    if (lastSlash !== -1) basename = repoRoot.slice(lastSlash + 1)
    const hash = platform.hash("sha256", repoRoot).slice(0, 6)
    return `${basename}-${hash}`
  })

export const projectDisplayName = (key: string): string => {
  // Strip the -<hash> suffix
  const dashIdx = key.lastIndexOf("-")
  if (dashIdx > 0) return key.slice(0, dashIdx)
  return key
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
export interface MemoryVaultReadOnlyApi {
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

export interface MemoryVaultApi extends MemoryVaultReadOnlyApi {
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

export class MemoryVault extends Context.Service<MemoryVault, MemoryVaultApi>()(
  "@gent/extensions/src/memory/vault/MemoryVault",
) {}

/**
 * Read Tag onto the MemoryVault substrate. Provided alongside `MemoryVault`
 * by `Live`/`Test`.
 */
export class MemoryVaultReadOnly extends Context.Service<
  MemoryVaultReadOnly,
  MemoryVaultReadOnlyApi
>()("@gent/extensions/src/memory/vault/MemoryVaultReadOnly") {}
export type MemoryVaultReadOnlyTag = typeof MemoryVaultReadOnly

// ── Implementation ──

const buildScopeIndex = (entries: ReadonlyArray<MemoryEntry>): string => {
  if (entries.length === 0) return ""
  return entries.map((e) => `- **${e.title}** — ${e.summary}`).join("\n") + "\n"
}

export const makeMemoryVault = (
  vaultPath: string,
): Effect.Effect<MemoryVaultApi, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const abs = (rel: string): string => path.join(vaultPath, rel)

    const listMdFiles = (dir: string): Effect.Effect<ReadonlyArray<string>> =>
      fs.exists(dir).pipe(
        Effect.flatMap((exists) => {
          if (exists) {
            return fs.readDirectory(dir).pipe(
              Effect.map((entries) =>
                entries
                  .filter((name) => name.endsWith(".md") && name !== "index.md")
                  .slice()
                  .sort(),
              ),
            )
          }
          return Effect.succeed<ReadonlyArray<string>>([])
        }),
        Effect.orElseSucceed(() => []),
      )

    const list: MemoryVaultApi["list"] = (scope, project) =>
      Effect.gen(function* () {
        const fallbackIsoDate = (yield* DateTime.nowAsDate).toISOString()
        const entries: MemoryEntry[] = []

        const scan = (dir: string, pathPrefix: string) =>
          Effect.gen(function* () {
            const files = yield* listMdFiles(path.join(vaultPath, dir))
            for (const file of files) {
              const relPath = `${pathPrefix}/${file}`
              const fullPath = abs(relPath)
              const content = yield* fs.readFileString(fullPath).pipe(Effect.option)
              if (Option.isNone(content)) continue
              const parsed = parseFrontmatter(content.value, fallbackIsoDate)
              if (Option.isNone(parsed)) continue
              entries.push({
                path: relPath,
                title: extractTitle(parsed.value.body),
                summary: extractSummary(parsed.value.body),
                frontmatter: parsed.value.frontmatter,
              })
            }
          })

        if (Predicate.isUndefined(scope) || scope === "global") {
          yield* scan("global", "global")
        }
        if (Predicate.isUndefined(scope) || scope === "project") {
          if (Predicate.isNotUndefined(project)) {
            yield* scan(`project/${project}`, `project/${project}`)
          } else {
            const projectDir = path.join(vaultPath, "project")
            const projectExists = yield* fs
              .exists(projectDir)
              .pipe(Effect.orElseSucceed(() => false))
            if (projectExists) {
              const dirEntries = yield* fs
                .readDirectory(projectDir)
                .pipe(Effect.orElseSucceed(() => []))
              for (const name of dirEntries) {
                const stat = yield* fs.stat(path.join(projectDir, name)).pipe(Effect.option)
                if (Option.isSome(stat) && stat.value.type === "Directory") {
                  yield* scan(`project/${name}`, `project/${name}`)
                }
              }
            }
          }
        }

        return entries
      })

    const read: MemoryVaultApi["read"] = (relativePath) => fs.readFileString(abs(relativePath))

    const rebuildScopeIndex = (scopeDir: string, entries: ReadonlyArray<MemoryEntry>) =>
      Effect.gen(function* () {
        const indexPath = path.join(vaultPath, scopeDir, "index.md")
        const dir = path.dirname(indexPath)
        const dirExists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
        if (!dirExists) return

        let title = projectDisplayName(path.basename(scopeDir))
        if (scopeDir === "global") title = "Global"
        const newContent = `# ${title} Memories\n\n${buildScopeIndex(entries)}`
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
          if (Predicate.isUndefined(projName)) continue
          let group = projectGroups.get(projName)
          if (Predicate.isUndefined(group)) {
            group = []
            projectGroups.set(projName, group)
          }
          group.push(e)
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
          if (Predicate.isNotUndefined(projName)) {
            yield* rebuildScopeIndex(
              `project/${projName}`,
              allEntries.filter((e) => e.path.startsWith(`project/${projName}/`)),
            )
          }
        }
        yield* rebuildRootIndex(allEntries)
      })

    const write: MemoryVaultApi["write"] = (relativePath, frontmatter, body) =>
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

    const remove: MemoryVaultApi["remove"] = (relativePath) =>
      Effect.gen(function* () {
        const fullPath = abs(relativePath)
        const exists = yield* fs.exists(fullPath).pipe(Effect.orElseSucceed(() => false))
        if (exists) {
          yield* fs.remove(fullPath)
        }
        yield* rebuildIndexForPath(relativePath)
      })

    const search: MemoryVaultApi["search"] = (query, scope, project) =>
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
          const content = yield* fs.readFileString(abs(e.path)).pipe(Effect.option)
          if (Option.isSome(content) && content.value.toLowerCase().includes(lowerQuery)) {
            results.push(e)
          }
        }
        return results
      })

    const ensureDirs: MemoryVaultApi["ensureDirs"] = (project) =>
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(path.join(vaultPath, "global"), { recursive: true })
          .pipe(Effect.asVoid)
        yield* fs
          .makeDirectory(path.join(vaultPath, "project"), { recursive: true })
          .pipe(Effect.asVoid)
        if (Predicate.isNotUndefined(project)) {
          yield* fs
            .makeDirectory(path.join(vaultPath, "project", project), { recursive: true })
            .pipe(Effect.asVoid)
        }
      })

    const rebuildIndex: MemoryVaultApi["rebuildIndex"] = (scope, project) =>
      Effect.gen(function* () {
        const scopedEntries = yield* list(scope, project)
        const allEntries = yield* list()
        if (scope === "global" || Predicate.isUndefined(scope)) {
          yield* rebuildScopeIndex(
            "global",
            allEntries.filter((e) => e.path.startsWith("global/")),
          )
        }
        if (scope === "project" || Predicate.isUndefined(scope)) {
          if (Predicate.isNotUndefined(project)) {
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
                .pipe(Effect.orElseSucceed(() => []))
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

const defaultVaultPath = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(home, ".gent", "memory")
  })

/**
 * Provide BOTH `MemoryVault` (write surface) and `MemoryVaultReadOnly` from
 * the same underlying service value. The read Tag is a structurally narrower
 * projection; it is not a public capability system.
 */
const layerFor = (
  buildVault: Effect.Effect<MemoryVaultApi, never, FileSystem.FileSystem | Path.Path>,
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
        } satisfies MemoryVaultReadOnlyApi),
      )
    }),
  )

export const Live = (
  home: string,
  pathOverride?: string,
): Layer.Layer<MemoryVault | MemoryVaultReadOnly, never, FileSystem.FileSystem | Path.Path> =>
  layerFor(
    Effect.gen(function* () {
      const vaultPath = pathOverride ?? (yield* defaultVaultPath(home))
      return yield* makeMemoryVault(vaultPath)
    }),
  )

export const Test = (
  tmpDir: string,
): Layer.Layer<MemoryVault | MemoryVaultReadOnly, never, FileSystem.FileSystem | Path.Path> =>
  layerFor(makeMemoryVault(tmpDir))
