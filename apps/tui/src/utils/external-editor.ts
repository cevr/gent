/**
 * External editor support — Ctrl+G opens $VISUAL / $EDITOR / vi
 * with the current textarea content, returning the edited result.
 */

import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { removeFile } from "../platform/fs-runtime-boundary"
import { joinPath } from "../platform/path-runtime"

export function resolveEditor(visual: string | undefined, editor: string | undefined): string {
  return visual || editor || "vi"
}

/** Split editor string into command + args (handles "code --wait", etc.) */
export function parseEditorCommand(editor: string): [string, ...string[]] {
  const parts = editor.trim().split(/\s+/)
  const cmd = parts[0]
  if (cmd === undefined || cmd.length === 0) return ["vi"]
  return [cmd, ...parts.slice(1)]
}

export function makeTmpPath(): string {
  return joinPath(tmpdir(), `gent-edit-${randomUUID()}.md`)
}

export type EditorResult =
  | { _tag: "applied"; content: string }
  | { _tag: "cancelled" }
  | { _tag: "error"; message: string }

export async function openExternalEditor(
  currentContent: string,
  suspend: () => void,
  resume: () => void,
  editor: string,
): Promise<EditorResult> {
  const tmpPath = makeTmpPath()
  const [cmd, ...args] = parseEditorCommand(editor)

  try {
    // Write current content to tmp file
    await Bun.write(tmpPath, currentContent)
  } catch (err) {
    return { _tag: "error", message: `Failed to write tmp file: ${err}` }
  }

  suspend()
  try {
    // Spawn editor with inherited stdio
    const proc = Bun.spawn([cmd, ...args, tmpPath], {
      stdio: ["inherit", "inherit", "inherit"],
    })
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      return { _tag: "cancelled" }
    }

    // Read back edited content
    const file = Bun.file(tmpPath)
    const exists = await file.exists()
    if (!exists) return { _tag: "cancelled" }
    const content = await file.text()
    return { _tag: "applied", content }
  } catch (err) {
    return { _tag: "error", message: `Editor failed: ${err}` }
  } finally {
    resume()
    await removeFile(tmpPath)
  }
}
