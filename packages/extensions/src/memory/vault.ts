// @effect-diagnostics nodeBuiltinImport:off — vault needs direct fs/path for sync file I/O
/**
 * MemoryVault — Effect service for ~/.gent/memory/ filesystem I/O.
 *
 * Flat .md files with YAML frontmatter. Per-scope index.md files
 * rebuilt inline on every write/remove (idempotent).
 */

import { Effect, Layer, Schema, Context } from "effect"
import * as Fs from "node:fs"
import * as Path from "node:path"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { type ReadOnly, withReadOnly } from "@gent/core/extensions/api"

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
      created: typeof fm["created"] === "string" ? fm["created"] : new Date().toISOString(),
      updated: typeof fm["updated"] === "string" ? fm["updated"] : new Date().toISOString(),
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
  const basename = Path.basename(repoRoot)
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
 * Read-only slice of MemoryVault — vault path, listing, single-file
 * read, and full-text search. Projections (and `request({ intent: "read" })`
 * capabilities once B11.5 lands) yield `MemoryVaultReadOnly` (the branded
 * Tag below) instead of `MemoryVault` so the type system blocks
 * accidental writes (`write`/`remove`/`ensureDirs`/`rebuildIndex`) in
 * read contexts.
 *
 * The Live/Test layers for `MemoryVault` provide BOTH this Tag and the
 * write-capable `MemoryVault` Tag from the same underlying service value.
 */
export interface MemoryVaultReadOnly {
  readonly vaultPath: string
  readonly list: (
    scope?: MemoryScope,
    project?: string,
  ) => Effect.Effect<ReadonlyArray<MemoryEntry>>
  readonly read: (relativePath: string) => Effect.Effect<string>
  readonly search: (
    query: string,
    scope?: MemoryScope,
    project?: string,
  ) => Effect.Effect<ReadonlyArray<MemoryEntry>>
}

export interface MemoryVault extends MemoryVaultReadOnly {
  readonly write: (
    relativePath: string,
    frontmatter: MemoryFrontmatter,
    body: string,
  ) => Effect.Effect<void>
  readonly remove: (relativePath: string) => Effect.Effect<void>
  readonly ensureDirs: (project?: string) => Effect.Effect<void>
  readonly rebuildIndex: (scope?: MemoryScope, project?: string) => Effect.Effect<void>
}

export const MemoryVault = Context.Service<MemoryVault>("@gent/memory/vault")

/**
 * Read-only branded Tag onto the MemoryVault substrate. Projections
 * and read-intent request capabilities yield this instead of
 * `MemoryVault`. Provided alongside `MemoryVault` by `Live`/`Test`.
 */
export const MemoryVaultReadOnly = Context.Service<ReadOnly<MemoryVaultReadOnly>>(
  "@gent/memory/vault/MemoryVaultReadOnly",
)
export type MemoryVaultReadOnlyTag = typeof MemoryVaultReadOnly

// ── Implementation ──

const listMdFiles = (dir: string): string[] => {
  if (!Fs.existsSync(dir)) return []
  const entries = Fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md") {
      files.push(entry.name)
    }
  }
  return files.sort()
}

const buildScopeIndex = (entries: ReadonlyArray<MemoryEntry>): string => {
  if (entries.length === 0) return ""
  return entries.map((e) => `- **${e.title}** — ${e.summary}`).join("\n") + "\n"
}

export const makeMemoryVault = (vaultPath: string): MemoryVault => {
  const abs = (rel: string) => Path.join(vaultPath, rel)

  const list: MemoryVault["list"] = (scope, project) =>
    Effect.sync(() => {
      const entries: MemoryEntry[] = []

      const scan = (dir: string, pathPrefix: string) => {
        const files = listMdFiles(Path.join(vaultPath, dir))
        for (const file of files) {
          const relPath = `${pathPrefix}/${file}`
          const fullPath = abs(relPath)
          try {
            const content = Fs.readFileSync(fullPath, "utf-8")
            const parsed = parseFrontmatter(content)
            if (parsed === undefined) continue
            entries.push({
              path: relPath,
              title: extractTitle(parsed.body),
              summary: extractSummary(parsed.body),
              frontmatter: parsed.frontmatter,
            })
          } catch {
            // Skip unreadable files
          }
        }
      }

      if (scope === undefined || scope === "global") {
        scan("global", "global")
      }
      if (scope === undefined || scope === "project") {
        if (project !== undefined) {
          scan(`project/${project}`, `project/${project}`)
        } else {
          // Scan all projects
          const projectDir = Path.join(vaultPath, "project")
          if (Fs.existsSync(projectDir)) {
            for (const d of Fs.readdirSync(projectDir, { withFileTypes: true })) {
              if (d.isDirectory()) {
                scan(`project/${d.name}`, `project/${d.name}`)
              }
            }
          }
        }
      }

      return entries
    })

  const read: MemoryVault["read"] = (relativePath) =>
    Effect.sync(() => Fs.readFileSync(abs(relativePath), "utf-8"))

  const write: MemoryVault["write"] = (relativePath, frontmatter, body) =>
    Effect.sync(() => {
      const fullPath = abs(relativePath)
      const dir = Path.dirname(fullPath)
      Fs.mkdirSync(dir, { recursive: true })

      const content = `${serializeFrontmatter(frontmatter)}\n\n${body}`
      const tmpPath = `${fullPath}.tmp`
      Fs.writeFileSync(tmpPath, content, "utf-8")
      Fs.renameSync(tmpPath, fullPath)
    }).pipe(
      // Rebuild scope index inline after write
      Effect.andThen(rebuildIndexForPath(relativePath)),
    )

  const remove: MemoryVault["remove"] = (relativePath) =>
    Effect.sync(() => {
      const fullPath = abs(relativePath)
      if (Fs.existsSync(fullPath)) Fs.unlinkSync(fullPath)
    }).pipe(Effect.andThen(rebuildIndexForPath(relativePath)))

  const search: MemoryVault["search"] = (query, scope, project) =>
    Effect.flatMap(list(scope, project), (entries) =>
      Effect.sync(() => {
        const lowerQuery = query.toLowerCase()
        return entries.filter((e) => {
          // Search title, summary, and tags
          if (e.title.toLowerCase().includes(lowerQuery)) return true
          if (e.summary.toLowerCase().includes(lowerQuery)) return true
          if (e.frontmatter.tags.some((t) => t.toLowerCase().includes(lowerQuery))) return true
          // Search file content
          try {
            const content = Fs.readFileSync(abs(e.path), "utf-8")
            return content.toLowerCase().includes(lowerQuery)
          } catch {
            return false
          }
        })
      }),
    )

  const ensureDirs: MemoryVault["ensureDirs"] = (project) =>
    Effect.sync(() => {
      Fs.mkdirSync(Path.join(vaultPath, "global"), { recursive: true })
      Fs.mkdirSync(Path.join(vaultPath, "project"), { recursive: true })
      if (project !== undefined) {
        Fs.mkdirSync(Path.join(vaultPath, "project", project), { recursive: true })
      }
    })

  const rebuildScopeIndex = (scopeDir: string, entries: ReadonlyArray<MemoryEntry>) => {
    const indexPath = Path.join(vaultPath, scopeDir, "index.md")
    const dir = Path.dirname(indexPath)
    if (!Fs.existsSync(dir)) return

    const newContent = `# ${scopeDir === "global" ? "Global" : projectDisplayName(Path.basename(scopeDir))} Memories\n\n${buildScopeIndex(entries)}`
    const existing = Fs.existsSync(indexPath) ? Fs.readFileSync(indexPath, "utf-8") : ""
    if (existing !== newContent) {
      Fs.writeFileSync(indexPath, newContent, "utf-8")
    }
  }

  const rebuildRootIndex = (allEntries: ReadonlyArray<MemoryEntry>) => {
    const indexPath = Path.join(vaultPath, "index.md")
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

    const existing = Fs.existsSync(indexPath) ? Fs.readFileSync(indexPath, "utf-8") : ""
    if (existing !== content) {
      Fs.writeFileSync(indexPath, content, "utf-8")
    }
  }

  const rebuildIndexForPath = (relativePath: string) =>
    Effect.flatMap(list(), (allEntries) =>
      Effect.sync(() => {
        // Rebuild the scope-level index for the affected path
        if (relativePath.startsWith("global/")) {
          rebuildScopeIndex(
            "global",
            allEntries.filter((e) => e.path.startsWith("global/")),
          )
        } else if (relativePath.startsWith("project/")) {
          const parts = relativePath.split("/")
          const projName = parts[1]
          if (projName !== undefined) {
            rebuildScopeIndex(
              `project/${projName}`,
              allEntries.filter((e) => e.path.startsWith(`project/${projName}/`)),
            )
          }
        }
        // Always rebuild root index
        rebuildRootIndex(allEntries)
      }),
    )

  const rebuildIndex: MemoryVault["rebuildIndex"] = (scope, project) =>
    Effect.flatMap(list(scope, project), (scopedEntries) =>
      Effect.flatMap(list(), (allEntries) =>
        Effect.sync(() => {
          if (scope === "global" || scope === undefined) {
            rebuildScopeIndex(
              "global",
              allEntries.filter((e) => e.path.startsWith("global/")),
            )
          }
          if (scope === "project" || scope === undefined) {
            if (project !== undefined) {
              rebuildScopeIndex(
                `project/${project}`,
                scopedEntries.filter((e) => e.path.startsWith(`project/${project}/`)),
              )
            } else {
              // Rebuild all project indexes
              const projectDir = Path.join(vaultPath, "project")
              if (Fs.existsSync(projectDir)) {
                for (const d of Fs.readdirSync(projectDir, { withFileTypes: true })) {
                  if (d.isDirectory()) {
                    rebuildScopeIndex(
                      `project/${d.name}`,
                      allEntries.filter((e) => e.path.startsWith(`project/${d.name}/`)),
                    )
                  }
                }
              }
            }
          }
          rebuildRootIndex(allEntries)
        }),
      ),
    )

  return { vaultPath, list, read, write, remove, search, ensureDirs, rebuildIndex }
}

// ── Layers ──

const DEFAULT_VAULT_PATH = Path.join(homedir(), ".gent", "memory")

/**
 * Provide BOTH `MemoryVault` (write surface) and `MemoryVaultReadOnly`
 * (read-only branded Tag) from the same underlying service value. The
 * read-only Tag is a structurally narrower projection that downstream
 * projections and read-intent capabilities can yield without picking
 * up the write methods.
 */
const layerFor = (vault: MemoryVault) =>
  Layer.effectContext(
    Effect.succeed(
      Context.empty().pipe(
        Context.add(MemoryVault, vault),
        Context.add(
          MemoryVaultReadOnly,
          withReadOnly({
            vaultPath: vault.vaultPath,
            list: vault.list,
            read: vault.read,
            search: vault.search,
          } satisfies MemoryVaultReadOnly),
        ),
      ),
    ),
  )

export const Live = (path?: string) => layerFor(makeMemoryVault(path ?? DEFAULT_VAULT_PATH))

export const Test = (tmpDir: string) => layerFor(makeMemoryVault(tmpDir))
