/**
 * Prompt-history adapter — wraps `Bun.file` so the hook can load the cached
 * history JSON without referencing the `Bun` global from product code.
 *
 * Returns the file's text contents when present, or `null` when missing.
 *
 * The `no-bun-outside-adapter` lint rule restricts `Bun.*` usage to files
 * matching the `*-adapter.ts` suffix; this module owns the prompt-history
 * read boundary.
 */

export const readPromptHistoryFile = (path: string): Promise<string | null> => {
  const file = Bun.file(path)
  return file.exists().then((exists) => (exists ? file.text() : null))
}
