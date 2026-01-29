/**
 * File reference parsing and expansion
 * Supports @path/to/file.ts#10-20 syntax
 */

import { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import { resolve, relative } from "path"

export interface FileRef {
  path: string
  startLine?: number
  endLine?: number
}

const FILE_REF_PATTERN = /@([^\s#]+)(?:#(\d+)(?:-(\d+))?)?/g

/**
 * Parse file references from text
 * @example "@src/foo.ts" → { path: "src/foo.ts" }
 * @example "@src/foo.ts#10" → { path: "src/foo.ts", startLine: 10 }
 * @example "@src/foo.ts#10-20" → { path: "src/foo.ts", startLine: 10, endLine: 20 }
 */
export function parseFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = []
  const pattern = new RegExp(FILE_REF_PATTERN.source, "g")
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const path = match[1]
    if (path === undefined || path.length === 0) continue

    const ref: FileRef = { path }
    if (match[2] !== undefined) {
      ref.startLine = parseInt(match[2], 10)
      if (match[3] !== undefined) {
        ref.endLine = parseInt(match[3], 10)
      }
    }
    refs.push(ref)
  }

  return refs
}

/**
 * Read file content, optionally extracting line range
 */
const readFileContent = (absolutePath: string, startLine?: number, endLine?: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = yield* fs.readFileString(absolutePath, "utf-8")

    if (startLine === undefined) {
      return content
    }

    const lines = content.split("\n")
    const start = Math.max(0, startLine - 1) // Convert 1-indexed to 0-indexed
    const end = endLine !== undefined ? Math.min(lines.length, endLine) : start + 1

    return lines.slice(start, end).join("\n")
  })

const expandSingleRef = (ref: FileRef, cwd: string) => {
  const absolutePath = resolve(cwd, ref.path)
  const relativePath = relative(cwd, absolutePath)

  return Effect.gen(function* () {
    const content = yield* readFileContent(absolutePath, ref.startLine, ref.endLine)

    // Build the original match string
    let matchStr = `@${ref.path}`
    if (ref.startLine !== undefined) {
      matchStr += `#${ref.startLine}`
      if (ref.endLine !== undefined) {
        matchStr += `-${ref.endLine}`
      }
    }

    // Build range label
    let rangeLabel = relativePath
    if (ref.startLine !== undefined) {
      rangeLabel += `:${ref.startLine}`
      if (ref.endLine !== undefined) {
        rangeLabel += `-${ref.endLine}`
      }
    }

    // Build code block
    const codeBlock = `\`\`\`${rangeLabel}\n${content}\n\`\`\``
    return { matchStr, codeBlock }
  }).pipe(Effect.catchAll(() => Effect.succeed(null)))
}

/**
 * Expand file references in text by reading file contents
 * @example "@src/foo.ts#10-20" → "```src/foo.ts:10-20\n<content>\n```"
 */
export const expandFileRefs = (text: string, cwd: string) => {
  const refs = parseFileRefs(text)
  if (refs.length === 0) return Effect.succeed(text)

  return Effect.gen(function* () {
    const expanded = yield* Effect.forEach(refs, (ref) => expandSingleRef(ref, cwd), {
      concurrency: "unbounded",
    })

    let result = text
    for (const exp of expanded) {
      if (exp !== null) {
        result = result.replace(exp.matchStr, exp.codeBlock)
      }
    }

    return result
  })
}
