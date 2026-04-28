/**
 * Memory extension helpers — slug + path + frontmatter constructors.
 *
 * The session-memory state-holder (W10-1d) was deleted along with the old
 * session-local FSM plumbing. The vault is the durable store and
 * `projectMemoryVaultTurn` derives the prompt surface; tools use the
 * helpers below to compute on-disk paths and write frontmatter.
 */

import { type MemoryScope, type MemorySource } from "./vault.js"

// ── Slug generation ──

export const toSlug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)

/** Build the relative vault path for a memory entry */
export const memoryPath = (scope: MemoryScope, title: string, projectKey?: string): string => {
  const slug = toSlug(title)
  if (scope === "global") return `global/${slug}.md`
  if (projectKey === undefined) return `global/${slug}.md`
  return `project/${projectKey}/${slug}.md`
}

/** Build frontmatter for a new memory */
export const newFrontmatter = (
  scope: MemoryScope,
  tags: ReadonlyArray<string>,
  source: MemorySource,
) => ({
  scope,
  tags,
  created: new Date().toISOString(),
  updated: new Date().toISOString(),
  source,
})
