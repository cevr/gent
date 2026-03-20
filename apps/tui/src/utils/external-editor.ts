/**
 * External editor support — Ctrl+G opens $VISUAL / $EDITOR / vi
 * with the current textarea content, returning the edited result.
 */

import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

export function resolveEditor(visual: string | undefined, editor: string | undefined): string {
  return visual || editor || "vi"
}

export function makeTmpPath(): string {
  return join(tmpdir(), `gent-edit-${randomUUID()}.md`)
}

export async function openExternalEditor(
  currentContent: string,
  suspend: () => void,
  resume: () => void,
  editor: string,
): Promise<string> {
  const tmpPath = makeTmpPath()

  // Write current content to tmp file
  await Bun.write(tmpPath, currentContent)

  suspend()
  try {
    // Spawn editor with inherited stdio
    const proc = Bun.spawn([editor, tmpPath], {
      stdio: ["inherit", "inherit", "inherit"],
    })
    await proc.exited

    // Read back edited content
    const file = Bun.file(tmpPath)
    const exists = await file.exists()
    if (!exists) return currentContent
    return await file.text()
  } finally {
    resume()
    // Cleanup tmp file
    try {
      const { unlink } = await import("node:fs/promises")
      await unlink(tmpPath)
    } catch {
      // Ignore cleanup failures
    }
  }
}
